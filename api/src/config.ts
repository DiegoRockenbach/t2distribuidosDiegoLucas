import { z } from "zod";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";

const localEnvFile = resolve(process.cwd(), "../.env");
if (existsSync(localEnvFile)) process.loadEnvFile(localEnvFile);

const postgresUrl = z.string().url().startsWith("postgresql://");

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Identifica a replica da API nos cabecalhos de resposta e nos logs.
  INSTANCE_ID: z.string().trim().min(1).max(64).default(hostname()),
  // Escritas (e leituras, por padrao): primario atual do cluster.
  DATABASE_URL: postgresUrl,
  // Replicas de leitura. Sem ela, tudo vai para DATABASE_URL.
  DATABASE_READ_URL: postgresUrl.optional(),
  READ_ROUTING: z.enum(["primary", "replicas"]).default("primary"),
  DB_POOL_MIN: z.coerce.number().int().min(0).default(2),
  DB_POOL_MAX: z.coerce.number().int().positive().default(15),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Tempo total em que uma requisicao insiste no banco antes de responder 503.
  DB_RETRY_BUDGET_MS: z.coerce.number().int().min(0).default(2_500),
  DB_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(100),
  DB_RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(1_000),
  // No desligamento, tempo respondendo 503 em /health/live antes de fechar,
  // para o balanceador parar de enviar requisicoes a esta replica.
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(3_000),
  CORS_ORIGIN: z.string().default("http://localhost:8080"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
}).superRefine((value, context) => {
  if (value.DB_POOL_MIN > value.DB_POOL_MAX) {
    context.addIssue({ code: "custom", path: ["DB_POOL_MIN"], message: "DB_POOL_MIN nao pode superar DB_POOL_MAX" });
  }
  if (value.READ_ROUTING === "replicas" && value.DATABASE_READ_URL === undefined) {
    context.addIssue({ code: "custom", path: ["DATABASE_READ_URL"], message: "READ_ROUTING=replicas exige DATABASE_READ_URL" });
  }
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configSchema.safeParse(environment);
  if (!result.success) {
    throw new Error(`Configuracao invalida: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
