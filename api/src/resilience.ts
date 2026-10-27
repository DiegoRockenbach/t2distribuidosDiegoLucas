import type { PoolClient } from "pg";

/**
 * Como uma falha do banco afeta a operacao:
 * - not-applied: o comando certamente nao teve efeito (nao conectou, caiu numa
 *   replica somente leitura, servidor iniciando). Repetir e sempre seguro.
 * - in-doubt: a conexao caiu durante o comando; ele pode ter sido confirmado.
 *   Repetir so e seguro se a operacao for idempotente.
 * - permanent: erro da propria requisicao (restricao violada, SQL invalido).
 */
export type FailureKind = "not-applied" | "in-doubt" | "permanent";

/** Banco indisponivel depois de esgotado o tempo de novas tentativas (HTTP 503). */
export class DatabaseUnavailableError extends Error {
  readonly inDoubt: boolean;

  constructor(message: string, options: { cause: unknown; inDoubt: boolean }) {
    super(message, { cause: options.cause });
    this.name = "DatabaseUnavailableError";
    this.inDoubt = options.inDoubt;
  }
}

// Erros que o servidor devolve antes de executar o comando (ou abortando-o).
const notAppliedSqlStates = new Set([
  "57P03", // cannot_connect_now: servidor iniciando, desligando ou em recuperacao
  "25006", // read_only_sql_transaction: a conexao foi parar numa replica
  "53300", // too_many_connections
  "40001", // serialization_failure
  "40P01", // deadlock_detected
]);

// Sessao encerrada pelo servidor no meio do comando. Com replicacao sincrona,
// a transacao pode ter sido confirmada localmente enquanto esperava a replica.
const inDoubtSqlStates = new Set([
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
]);

const networkErrorCodes = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT",
  "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN",
]);

const connectionMessages =
  /connection terminated|connection ended|server closed the connection|query read timeout|not queryable|timeout exceeded when trying to connect/i;

function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("severity" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === "string" && networkErrorCodes.has(code)) return true;
  return connectionMessages.test(error.message);
}

export function classifyFailure(error: unknown, phase: "acquire" | "execute"): FailureKind {
  const state = sqlState(error);
  if (phase === "acquire") {
    // Nada foi enviado ainda. Credencial ou banco inexistente nao se resolvem repetindo.
    if (state !== undefined && (state.startsWith("28") || state === "3D000")) return "permanent";
    return "not-applied";
  }
  if (state === undefined) return isConnectionFailure(error) ? "in-doubt" : "permanent";
  if (notAppliedSqlStates.has(state)) return "not-applied";
  if (inDoubtSqlStates.has(state) || state.startsWith("08")) return "in-doubt";
  return "permanent";
}

/** Minimo que o roteador usa de um pool do `pg`; facilita testes. */
export interface ConnectionSource {
  connect(): Promise<PoolClient>;
}

export interface RetryPolicy {
  /** Tempo maximo, desde a primeira tentativa, para continuar tentando. */
  budgetMs: number;
  /** Espera apos a primeira rodada de falhas; dobra a cada rodada. */
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RouterOptions {
  primary: ConnectionSource;
  replicas: ConnectionSource | null;
  readRouting: "primary" | "replicas";
  policy: RetryPolicy;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export interface DatabaseHealth {
  primary: "reachable" | "unreachable";
  replicas: "reachable" | "unreachable" | "not-configured";
}

export interface RouterStats {
  retries: number;
  readFallbacks: number;
  unavailable: number;
}

class AttemptFailure extends Error {
  constructor(readonly kind: FailureKind, readonly original: unknown) {
    super("falha na tentativa de acesso ao banco");
  }
}

async function execute<T>(source: ConnectionSource, work: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient;
  try {
    client = await source.connect();
  } catch (error) {
    throw new AttemptFailure(classifyFailure(error, "acquire"), error);
  }
  try {
    const result = await work(client);
    client.release();
    return result;
  } catch (error) {
    const kind = classifyFailure(error, "execute");
    // Conexao quebrada ou apontando para o no errado: descarta em vez de devolver ao pool.
    client.release(kind !== "permanent");
    throw new AttemptFailure(kind, error);
  }
}

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds));

/**
 * Decide em qual pool cada operacao roda e repete o que for seguro repetir.
 * Escritas vao sempre ao primario. Leituras usam a rota preferida e, se ela
 * falhar, a outra: com o primario fora do ar, as leituras seguem nas replicas.
 */
export class DatabaseRouter {
  readonly stats: RouterStats = { retries: 0, readFallbacks: 0, unavailable: 0 };
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: RouterOptions) {
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  write<T>(work: (client: PoolClient) => Promise<T>, idempotent: boolean): Promise<T> {
    return this.run([this.options.primary], work, idempotent);
  }

  read<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const { primary, replicas, readRouting } = this.options;
    if (replicas === null) return this.run([primary], work, true);
    return this.run(readRouting === "replicas" ? [replicas, primary] : [primary, replicas], work, true);
  }

  async health(): Promise<DatabaseHealth> {
    const probe = async (source: ConnectionSource) => {
      try {
        await execute(source, (client) => client.query("SELECT 1"));
        return "reachable" as const;
      } catch {
        return "unreachable" as const;
      }
    };
    const [primary, replicas] = await Promise.all([
      probe(this.options.primary),
      this.options.replicas === null ? Promise.resolve("not-configured" as const) : probe(this.options.replicas),
    ]);
    return { primary, replicas };
  }

  private async run<T>(
    sources: ConnectionSource[],
    work: (client: PoolClient) => Promise<T>,
    idempotent: boolean,
  ): Promise<T> {
    const { budgetMs, baseDelayMs, maxDelayMs } = this.options.policy;
    const started = this.now();
    for (let attempt = 0; ; attempt += 1) {
      const source = sources[attempt % sources.length]!;
      try {
        return await execute(source, work);
      } catch (failure) {
        if (!(failure instanceof AttemptFailure)) throw failure;
        if (failure.kind === "permanent") throw failure.original;

        const nextAttempt = attempt + 1;
        const round = Math.floor(nextAttempt / sources.length);
        // Dentro da mesma rodada troca de rota imediatamente, mesmo que o tempo
        // ja tenha se esgotado (a rota alternativa pode estar saudavel). Entre
        // rodadas, recuo exponencial com variacao aleatoria para nao sincronizar
        // os clientes, limitado pelo orcamento de tempo.
        const sameRound = nextAttempt % sources.length !== 0;
        const delay = sameRound
          ? 0
          : Math.min(maxDelayMs, baseDelayMs * 2 ** (round - 1)) * (0.5 + Math.random() / 2);
        const retryable = failure.kind === "not-applied" || idempotent;
        if (!retryable || (!sameRound && this.now() - started + delay > budgetMs)) {
          this.stats.unavailable += 1;
          throw new DatabaseUnavailableError("Banco de dados indisponivel", {
            cause: failure.original,
            inDoubt: failure.kind === "in-doubt",
          });
        }
        this.stats.retries += 1;
        if (sources[nextAttempt % sources.length] !== sources[0]) this.stats.readFallbacks += 1;
        if (delay > 0) await this.sleep(delay);
      }
    }
  }
}
