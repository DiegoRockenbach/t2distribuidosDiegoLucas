import type { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./database.js";
import { PgReadingRepository } from "./pg-reading-repository.js";
import { DatabaseRouter } from "./resilience.js";

const config = loadConfig();
// O logger so existe depois de buildApp; ate la, erros de conexao vao para o stderr.
let logConnectionError = (role: string, error: Error): void => {
  console.error(`conexao com o banco (${role}) perdida: ${error.message}`);
};
const primaryPool = createPool(config.DATABASE_URL, config, "primary", (error) => logConnectionError("primary", error));
const replicaPool = config.DATABASE_READ_URL === undefined
  ? null
  : createPool(config.DATABASE_READ_URL, config, "replicas", (error) => logConnectionError("replicas", error));
const pools: Array<[string, Pool]> = [["primary", primaryPool]];
if (replicaPool !== null) pools.push(["replicas", replicaPool]);

const router = new DatabaseRouter({
  primary: primaryPool,
  replicas: replicaPool,
  readRouting: config.READ_ROUTING,
  policy: {
    budgetMs: config.DB_RETRY_BUDGET_MS,
    baseDelayMs: config.DB_RETRY_BASE_DELAY_MS,
    maxDelayMs: config.DB_RETRY_MAX_DELAY_MS,
  },
});

let draining = false;
const app = await buildApp({
  repository: new PgReadingRepository(router),
  checkDatabase: () => router.health(),
  instanceId: config.INSTANCE_ID,
  isDraining: () => draining,
  corsOrigin: config.CORS_ORIGIN,
  logger: { level: config.LOG_LEVEL },
});

logConnectionError = (role, error) => {
  app.log.warn({ err: error, pool: role }, "conexao com o banco perdida");
};

let closing = false;
async function close(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  // Primeiro sai do balanceamento (o HAProxy ve /health/live = 503), depois
  // espera as requisicoes em andamento terminarem e fecha as conexoes.
  draining = true;
  app.log.warn({ signal, graceMs: config.SHUTDOWN_GRACE_MS, stats: router.stats }, "encerrando servidor");
  await new Promise((resolveWait) => setTimeout(resolveWait, config.SHUTDOWN_GRACE_MS));
  await app.close();
  await Promise.all(pools.map(([, pool]) => pool.end()));
}

process.on("SIGINT", () => { void close("SIGINT"); });
process.on("SIGTERM", () => { void close("SIGTERM"); });

try {
  await app.listen({ host: "0.0.0.0", port: config.PORT });
  app.log.warn({ instance: config.INSTANCE_ID, readRouting: config.READ_ROUTING }, "API pronta");
} catch (error) {
  app.log.error(error);
  await Promise.all(pools.map(([, pool]) => pool.end()));
  process.exitCode = 1;
}
