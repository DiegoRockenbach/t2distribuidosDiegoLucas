import { scriptPool } from "./shared.js";

// Lista, em CSV, as medicoes criadas pelo JMeter que continuam no banco depois
// de um ensaio, com a chave de idempotencia de cada uma. Cada escritor cria,
// atualiza e apaga o proprio registro; uma chave cuja exclusao foi confirmada
// (HTTP 204) mas que aparece aqui e uma escrita confirmada que se perdeu no
// failover. A chave identifica o ciclo mesmo que o novo primario reemita IDs.
const pool = scriptPool();
try {
  const result = await pool.query<{ id: string; request_id: string | null }>(
    `SELECT id::text AS id, request_id::text AS request_id
     FROM air_quality_readings
     WHERE station_code LIKE 'LOAD-%'
     ORDER BY id`,
  );
  const lines = ["id,request_id", ...result.rows.map((row) => `${row.id},${row.request_id ?? ""}`)];
  process.stdout.write(`${lines.join("\n")}\n`);
} finally {
  await pool.end();
}
