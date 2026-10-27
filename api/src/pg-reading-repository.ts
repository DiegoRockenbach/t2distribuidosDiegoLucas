import type { QueryResultRow } from "pg";
import {
  IdempotencyConflictError,
  type CreateOptions,
  type CreateResult,
  type Reading,
  type ReadingFilters,
  type ReadingInput,
  type ReadingPage,
  type ReadingRepository,
} from "./domain.js";
import type { DatabaseRouter } from "./resilience.js";

interface ReadingRow extends QueryResultRow {
  id: string;
  station_code: string;
  city: string;
  pollutant: Reading["pollutant"];
  measured_at: Date;
  measured_value: string;
  unit: string;
  quality_status: Reading["qualityStatus"];
  notes: string | null;
  created_at: Date;
}

const columns = `id, station_code, city, pollutant, measured_at, measured_value,
  unit, quality_status, notes, created_at`;

function toReading(row: ReadingRow): Reading {
  return {
    id: Number(row.id),
    stationCode: row.station_code,
    city: row.city,
    pollutant: row.pollutant,
    measuredAt: row.measured_at.toISOString(),
    measuredValue: Number(row.measured_value),
    unit: row.unit,
    qualityStatus: row.quality_status,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
  };
}

function inputValues(input: ReadingInput): unknown[] {
  return [
    input.stationCode,
    input.city,
    input.pollutant,
    input.measuredAt,
    input.measuredValue,
    input.unit,
    input.qualityStatus,
    input.notes,
  ];
}

/**
 * Cada metodo declara se pode ser repetido apos uma queda no meio do comando:
 * leituras, UPDATE (atribui valores absolutos) e DELETE sao idempotentes;
 * INSERT so e idempotente quando o cliente envia uma chave de idempotencia.
 */
export class PgReadingRepository implements ReadingRepository {
  constructor(private readonly db: DatabaseRouter) {}

  async create(input: ReadingInput, options: CreateOptions = {}): Promise<CreateResult> {
    const { requestId } = options;
    if (requestId === undefined) {
      const row = await this.db.write(async (client) => {
        const result = await client.query<ReadingRow>(
          `INSERT INTO air_quality_readings
            (station_code, city, pollutant, measured_at, measured_value, unit, quality_status, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${columns}`,
          inputValues(input),
        );
        return result.rows[0];
      }, false);
      if (!row) throw new Error("O banco nao retornou a medicao criada");
      return { reading: toReading(row), replayed: false };
    }

    return this.db.write(async (client) => {
      const inserted = await client.query<ReadingRow>(
        `INSERT INTO air_quality_readings
          (station_code, city, pollutant, measured_at, measured_value, unit, quality_status, notes, request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (request_id) DO NOTHING
         RETURNING ${columns}`,
        [...inputValues(input), requestId],
      );
      if (inserted.rows[0]) return { reading: toReading(inserted.rows[0]), replayed: false };

      // A chave ja existe: esta e uma repeticao de um POST que ja foi aplicado.
      const existing = await client.query<ReadingRow>(
        `SELECT ${columns} FROM air_quality_readings WHERE request_id = $1`,
        [requestId],
      );
      if (!existing.rows[0]) throw new IdempotencyConflictError();
      return { reading: toReading(existing.rows[0]), replayed: true };
    }, true);
  }

  async findById(id: number): Promise<Reading | null> {
    const row = await this.db.read(async (client) => {
      const result = await client.query<ReadingRow>(
        `SELECT ${columns} FROM air_quality_readings WHERE id = $1`,
        [id],
      );
      return result.rows[0];
    });
    return row ? toReading(row) : null;
  }

  async list(filters: ReadingFilters): Promise<ReadingPage> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    const add = (clause: string, value: unknown): void => {
      values.push(value);
      conditions.push(clause.replace("?", `$${values.length}`));
    };

    if (filters.city) add("city = ?", filters.city);
    if (filters.pollutant) add("pollutant = ?", filters.pollutant);
    if (filters.measuredFrom) add("measured_at >= ?", filters.measuredFrom);
    if (filters.measuredTo) add("measured_at <= ?", filters.measuredTo);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const offset = (filters.page - 1) * filters.pageSize;
    const dataValues = [...values, filters.pageSize, offset];
    const limitParam = `$${values.length + 1}`;
    const offsetParam = `$${values.length + 2}`;

    const { total, rows } = await this.db.read(async (client) => {
      const countResult = await client.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM air_quality_readings ${where}`,
        values,
      );
      const dataResult = await client.query<ReadingRow>(
        `SELECT ${columns} FROM air_quality_readings ${where}
         ORDER BY measured_at DESC, id DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
        dataValues,
      );
      return { total: Number(countResult.rows[0]?.total ?? 0), rows: dataResult.rows };
    });

    return { items: rows.map(toReading), page: filters.page, pageSize: filters.pageSize, total };
  }

  async update(id: number, input: ReadingInput): Promise<Reading | null> {
    const row = await this.db.write(async (client) => {
      const result = await client.query<ReadingRow>(
        `UPDATE air_quality_readings SET
          station_code = $1, city = $2, pollutant = $3, measured_at = $4,
          measured_value = $5, unit = $6, quality_status = $7, notes = $8
         WHERE id = $9 RETURNING ${columns}`,
        [...inputValues(input), id],
      );
      return result.rows[0];
    }, true);
    return row ? toReading(row) : null;
  }

  async delete(id: number): Promise<boolean> {
    return this.db.write(async (client) => {
      const result = await client.query("DELETE FROM air_quality_readings WHERE id = $1", [id]);
      return result.rowCount === 1;
    }, true);
  }
}
