import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  DatabaseRouter,
  DatabaseUnavailableError,
  type ConnectionSource,
  type RetryPolicy,
} from "../src/resilience.js";

/** Erro no formato do `pg` para respostas do servidor (tem severity e SQLSTATE). */
function serverError(code: string, message = "erro do servidor"): Error {
  return Object.assign(new Error(message), { severity: "ERROR", code });
}

const connectionLost = () => new Error("Connection terminated unexpectedly");
const refused = () => Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5000"), { code: "ECONNREFUSED" });

type Step = "ok" | Error;

/**
 * Pool falso: cada connect() consome um passo do roteiro. Um passo com erro de
 * conexao falha no connect; os demais erros acontecem durante a consulta.
 */
class ScriptedSource implements ConnectionSource {
  connects = 0;
  destroyed = 0;
  released = 0;

  constructor(readonly name: string, private readonly steps: Array<{ at: "connect" | "query"; result: Step }>) {}

  async connect(): Promise<PoolClient> {
    const step = this.steps[Math.min(this.connects, this.steps.length - 1)]!;
    this.connects += 1;
    if (step.at === "connect" && step.result !== "ok") throw step.result;
    const client = {
      query: async () => {
        if (step.result !== "ok") throw step.result;
        return { rows: [{ served: this.name }], rowCount: 1 };
      },
      release: (destroy?: boolean | Error) => {
        if (destroy) this.destroyed += 1;
        else this.released += 1;
      },
    };
    return client as unknown as PoolClient;
  }
}

const policy: RetryPolicy = { budgetMs: 2_000, baseDelayMs: 100, maxDelayMs: 1_000 };

function router(primary: ConnectionSource, replicas: ConnectionSource | null, readRouting: "primary" | "replicas" = "primary") {
  let clock = 0;
  const sleeps: number[] = [];
  const instance = new DatabaseRouter({
    primary,
    replicas,
    readRouting,
    policy,
    now: () => clock,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); clock += milliseconds; },
  });
  return { instance, sleeps };
}

async function served(client: PoolClient): Promise<string> {
  const result = await client.query<{ served: string }>("SELECT 1");
  return result.rows[0]!.served;
}

describe("classifyFailure", () => {
  it("treats every failure to connect as not applied, except bad credentials", () => {
    expect(classifyFailure(refused(), "acquire")).toBe("not-applied");
    expect(classifyFailure(serverError("57P03", "the database system is starting up"), "acquire")).toBe("not-applied");
    expect(classifyFailure(serverError("28P01"), "acquire")).toBe("permanent");
  });

  it("separates rejected, interrupted and invalid statements", () => {
    expect(classifyFailure(serverError("25006"), "execute")).toBe("not-applied");
    expect(classifyFailure(serverError("57P01"), "execute")).toBe("in-doubt");
    expect(classifyFailure(connectionLost(), "execute")).toBe("in-doubt");
    expect(classifyFailure(serverError("23505"), "execute")).toBe("permanent");
    expect(classifyFailure(new TypeError("bug"), "execute")).toBe("permanent");
  });
});

describe("DatabaseRouter", () => {
  it("serves reads from the replicas when the primary is down", async () => {
    const primary = new ScriptedSource("primary", [{ at: "connect", result: refused() }]);
    const replicas = new ScriptedSource("replicas", [{ at: "query", result: "ok" }]);
    const { instance, sleeps } = router(primary, replicas);

    await expect(instance.read(served)).resolves.toBe("replicas");
    expect(sleeps).toEqual([]);
    expect(instance.stats.readFallbacks).toBe(1);
  });

  it("still tries the replicas when the primary used up the whole budget", async () => {
    let clock = 0;
    const hangingPrimary: ConnectionSource = {
      connect: async () => {
        clock += 3_000;
        throw new Error("timeout exceeded when trying to connect");
      },
    };
    const replicas = new ScriptedSource("replicas", [{ at: "query", result: "ok" }]);
    const instance = new DatabaseRouter({
      primary: hangingPrimary,
      replicas,
      readRouting: "primary",
      policy,
      now: () => clock,
      sleep: async () => undefined,
    });

    await expect(instance.read(served)).resolves.toBe("replicas");
  });

  it("prefers the replicas when configured and falls back to the primary", async () => {
    const primary = new ScriptedSource("primary", [{ at: "query", result: "ok" }]);
    const replicas = new ScriptedSource("replicas", [{ at: "query", result: connectionLost() }]);
    const { instance } = router(primary, replicas, "replicas");

    await expect(instance.read(served)).resolves.toBe("primary");
    expect(replicas.destroyed).toBe(1);
  });

  it("retries a write that was certainly not applied", async () => {
    const primary = new ScriptedSource("primary", [
      { at: "query", result: serverError("25006", "cannot execute INSERT in a read-only transaction") },
      { at: "query", result: "ok" },
    ]);
    const { instance, sleeps } = router(primary, null);

    await expect(instance.write(served, false)).resolves.toBe("primary");
    expect(primary.destroyed).toBe(1);
    expect(sleeps).toHaveLength(1);
  });

  it("does not repeat a non-idempotent write whose outcome is unknown", async () => {
    const primary = new ScriptedSource("primary", [
      { at: "query", result: connectionLost() },
      { at: "query", result: "ok" },
    ]);
    const { instance } = router(primary, null);

    const failure = await instance.write(served, false).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DatabaseUnavailableError);
    expect((failure as DatabaseUnavailableError).inDoubt).toBe(true);
    expect(primary.connects).toBe(1);
  });

  it("repeats an idempotent write after an in-doubt failure", async () => {
    const primary = new ScriptedSource("primary", [
      { at: "query", result: connectionLost() },
      { at: "query", result: "ok" },
    ]);
    const { instance } = router(primary, null);

    await expect(instance.write(served, true)).resolves.toBe("primary");
    expect(primary.connects).toBe(2);
  });

  it("gives up with 503 semantics once the retry budget is spent", async () => {
    const primary = new ScriptedSource("primary", [{ at: "connect", result: refused() }]);
    const { instance, sleeps } = router(primary, null);

    await expect(instance.write(served, true)).rejects.toBeInstanceOf(DatabaseUnavailableError);
    const waited = sleeps.reduce((total, value) => total + value, 0);
    expect(waited).toBeLessThanOrEqual(policy.budgetMs);
    expect(primary.connects).toBeGreaterThan(2);
    expect(instance.stats.unavailable).toBe(1);
  });

  it("does not retry errors caused by the request itself", async () => {
    const primary = new ScriptedSource("primary", [{ at: "query", result: serverError("23505", "duplicate key") }]);
    const { instance } = router(primary, null);

    await expect(instance.write(served, true)).rejects.toMatchObject({ code: "23505" });
    expect(primary.connects).toBe(1);
    expect(primary.released).toBe(1);
  });

  it("reports which database routes are reachable", async () => {
    const primary = new ScriptedSource("primary", [{ at: "connect", result: refused() }]);
    const replicas = new ScriptedSource("replicas", [{ at: "query", result: "ok" }]);
    const { instance } = router(primary, replicas);

    await expect(instance.health()).resolves.toEqual({ primary: "unreachable", replicas: "reachable" });
  });
});
