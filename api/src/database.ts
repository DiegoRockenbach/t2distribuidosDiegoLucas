import { Pool } from "pg";
import type { AppConfig } from "./config.js";

export type PoolErrorHandler = (error: Error) => void;

export function createPool(
  connectionString: string,
  config: AppConfig,
  role: string,
  onError: PoolErrorHandler = () => undefined,
): Pool {
  const pool = new Pool({
    connectionString,
    min: config.DB_POOL_MIN,
    max: config.DB_POOL_MAX,
    idleTimeoutMillis: config.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT_MS,
    // Sem limite no cliente, uma consulta presa num servidor congelado
    // seguraria a requisicao ate o TCP desistir (minutos).
    query_timeout: config.DB_QUERY_TIMEOUT_MS,
    keepAlive: true,
    application_name: `air-quality-api:${config.INSTANCE_ID}:${role}`,
  });
  // Quando o servidor cai, cada conexao emite 'error'. Conexoes ociosas emitem
  // pelo pool; conexoes em uso emitem pelo proprio cliente, que o pool deixa
  // sem ouvinte. Um 'error' sem ouvinte derruba o processo Node: no primeiro
  // ensaio de failover, as tres replicas da API morreram juntas por isso.
  // A consulta em andamento recebe o erro normalmente pela sua promessa.
  pool.on("error", onError);
  pool.on("connect", (client) => {
    client.on("error", onError);
  });
  return pool;
}
