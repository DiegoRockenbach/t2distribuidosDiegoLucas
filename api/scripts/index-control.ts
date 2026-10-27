import { scriptPool } from "./shared.js";

const indexName = "idx_air_readings_city_pollutant_measured_at";
const action = process.argv[2];
if (!action || !["create", "drop", "status"].includes(action)) {
  throw new Error("Uso: npm run db:index -- create|drop|status");
}

const pool = scriptPool();
try {
  if (action === "create") {
    await pool.query(`CREATE INDEX IF NOT EXISTS ${indexName}
      ON air_quality_readings (city, pollutant, measured_at)`);
    await pool.query("ANALYZE air_quality_readings");
  } else if (action === "drop") {
    await pool.query(`DROP INDEX IF EXISTS ${indexName}`);
    await pool.query("ANALYZE air_quality_readings");
  }

  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1
    ) AS exists`,
    [indexName],
  );
  console.log(JSON.stringify({ index: indexName, present: result.rows[0]?.exists === true }));
} finally {
  await pool.end();
}
