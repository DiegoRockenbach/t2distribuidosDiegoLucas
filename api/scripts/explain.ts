import { scriptPool } from "./shared.js";

const pool = scriptPool();
try {
  const result = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     SELECT id, station_code, city, pollutant, measured_at, measured_value,
            unit, quality_status, notes, created_at
     FROM air_quality_readings
     WHERE city = $1 AND pollutant = $2
       AND measured_at >= $3 AND measured_at <= $4
     ORDER BY measured_at DESC, id DESC
     LIMIT 25`,
    ["Porto Alegre", "PM2.5", "2025-01-01T00:00:00Z", "2025-12-31T23:59:59Z"],
  );
  console.log(JSON.stringify(result.rows[0]?.["QUERY PLAN"] ?? null, null, 2));
} finally {
  await pool.end();
}
