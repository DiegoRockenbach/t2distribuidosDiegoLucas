import { argumentValue, requiredPositiveInteger, scriptPool } from "./shared.js";

const cities = [
  "Porto Alegre", "Caxias do Sul", "Santa Maria", "Pelotas",
  "Canoas", "Novo Hamburgo", "Passo Fundo", "Rio Grande",
] as const;
const pollutants = ["PM2.5", "PM10", "CO", "NO2", "SO2", "O3"] as const;
const statuses = ["good", "moderate", "unhealthy", "critical"] as const;
const units: Record<(typeof pollutants)[number], string> = {
  "PM2.5": "ug/m3", PM10: "ug/m3", CO: "mg/m3", NO2: "ug/m3", SO2: "ug/m3", O3: "ug/m3",
};

class DeterministicRandom {
  constructor(private state: number) {
    this.state >>>= 0;
    if (this.state === 0) this.state = 0x6d2b79f5;
  }

  next(): number {
    this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) >>> 0;
    return this.state / 4_294_967_296;
  }

  integer(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
}

const count = requiredPositiveInteger("--count");
const seed = requiredPositiveInteger("--seed");
const truncate = process.argv.includes("--truncate");
const batchSize = Number(argumentValue("--batch-size") ?? 500);
if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5_000) {
  throw new Error("--batch-size deve estar entre 1 e 5000");
}

const random = new DeterministicRandom(seed);
const pool = scriptPool();
const client = await pool.connect();

try {
  await client.query("BEGIN");
  if (truncate) await client.query("TRUNCATE TABLE air_quality_readings RESTART IDENTITY");

  for (let start = 0; start < count; start += batchSize) {
    const size = Math.min(batchSize, count - start);
    const values: unknown[] = [];
    const rows: string[] = [];

    for (let index = 0; index < size; index += 1) {
      const globalIndex = start + index;
      const city = cities[(globalIndex + random.integer(cities.length)) % cities.length]!;
      const pollutant = pollutants[(globalIndex + random.integer(pollutants.length)) % pollutants.length]!;
      const status = statuses[random.integer(statuses.length)]!;
      const timestamp = new Date(Date.UTC(2025, 0, 1) + random.integer(365 * 24 * 60) * 60_000);
      const stationNumber = (cities.indexOf(city) + 1) * 10 + (globalIndex % 5);
      const value = Math.round((1 + random.next() * 299) * 1000) / 1000;
      const base = values.length;
      values.push(
        `ST-${stationNumber.toString().padStart(3, "0")}`,
        city,
        pollutant,
        timestamp.toISOString(),
        value,
        units[pollutant],
        status,
        globalIndex % 7 === 0 ? `Medicao sintetica deterministica ${globalIndex + 1}` : null,
      );
      rows.push(`(${Array.from({ length: 8 }, (_, column) => `$${base + column + 1}`).join(", ")})`);
    }

    await client.query(
      `INSERT INTO air_quality_readings
        (station_code, city, pollutant, measured_at, measured_value, unit, quality_status, notes)
       VALUES ${rows.join(", ")}`,
      values,
    );
    console.log(`preparados ${start + size} de ${count}`);
  }

  const current = await client.query<{ total: string }>("SELECT count(*)::text AS total FROM air_quality_readings");
  const total = Number(current.rows[0]?.total ?? -1);
  if (truncate && total !== count) throw new Error(`Contagem final ${total}; esperado ${count}`);
  await client.query("COMMIT");
  await client.query("ANALYZE air_quality_readings");
  console.log(JSON.stringify({ inserted: count, finalCount: total, seed, truncated: truncate }));
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
