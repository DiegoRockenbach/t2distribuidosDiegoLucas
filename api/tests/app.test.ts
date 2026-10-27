import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  IdempotencyConflictError,
  type CreateOptions,
  type CreateResult,
  type Reading,
  type ReadingFilters,
  type ReadingInput,
  type ReadingPage,
  type ReadingRepository,
} from "../src/domain.js";
import { DatabaseUnavailableError, type DatabaseHealth } from "../src/resilience.js";

class MemoryRepository implements ReadingRepository {
  private readings = new Map<number, Reading>();
  private byRequestId = new Map<string, number>();
  private nextId = 1;
  failWith: Error | null = null;

  async create(input: ReadingInput, options: CreateOptions = {}): Promise<CreateResult> {
    if (this.failWith) throw this.failWith;
    if (options.requestId !== undefined && this.byRequestId.has(options.requestId)) {
      const existing = this.readings.get(this.byRequestId.get(options.requestId)!);
      if (!existing) throw new IdempotencyConflictError();
      return { reading: existing, replayed: true };
    }
    const reading: Reading = { ...input, id: this.nextId++, createdAt: new Date().toISOString() };
    this.readings.set(reading.id, reading);
    if (options.requestId !== undefined) this.byRequestId.set(options.requestId, reading.id);
    return { reading, replayed: false };
  }

  async findById(id: number): Promise<Reading | null> {
    if (this.failWith) throw this.failWith;
    return this.readings.get(id) ?? null;
  }

  async list(filters: ReadingFilters): Promise<ReadingPage> {
    if (this.failWith) throw this.failWith;
    const filtered = [...this.readings.values()].filter((item) =>
      (!filters.city || item.city === filters.city)
      && (!filters.pollutant || item.pollutant === filters.pollutant)
      && (!filters.measuredFrom || item.measuredAt >= filters.measuredFrom)
      && (!filters.measuredTo || item.measuredAt <= filters.measuredTo));
    const start = (filters.page - 1) * filters.pageSize;
    return {
      items: filtered.slice(start, start + filters.pageSize),
      page: filters.page,
      pageSize: filters.pageSize,
      total: filtered.length,
    };
  }

  async update(id: number, input: ReadingInput): Promise<Reading | null> {
    const current = this.readings.get(id);
    if (!current) return null;
    const updated = { ...current, ...input };
    this.readings.set(id, updated);
    return updated;
  }

  async delete(id: number): Promise<boolean> {
    return this.readings.delete(id);
  }
}

const validInput: ReadingInput = {
  stationCode: "ST-001",
  city: "Porto Alegre",
  pollutant: "PM2.5",
  measuredAt: "2025-06-01T12:00:00.000Z",
  measuredValue: 18.75,
  unit: "ug/m3",
  qualityStatus: "good",
  notes: null,
};

const healthy: DatabaseHealth = { primary: "reachable", replicas: "reachable" };

async function fixture(options: { health?: DatabaseHealth; draining?: boolean } = {}) {
  const repository = new MemoryRepository();
  const app = await buildApp({
    repository,
    checkDatabase: async () => options.health ?? healthy,
    instanceId: "api-test",
    isDraining: () => options.draining ?? false,
    corsOrigin: "*",
  });
  return { app, repository };
}

describe("air quality API", () => {
  it("reports the instance and both database routes", async () => {
    const { app } = await fixture();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", instance: "api-test", database: healthy });
    expect(response.headers["x-served-by"]).toBe("api-test");
    await app.close();
  });

  it("stays up in read-only mode when only the replicas answer", async () => {
    const { app } = await fixture({ health: { primary: "unreachable", replicas: "reachable" } });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe("read-only");
    await app.close();
  });

  it("answers 503 on /health when no database route works", async () => {
    const { app } = await fixture({ health: { primary: "unreachable", replicas: "unreachable" } });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ status: string }>().status).toBe("unavailable");
    await app.close();
  });

  it("leaves the load balancer while draining", async () => {
    const live = await fixture();
    expect((await live.app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    await live.app.close();

    const draining = await fixture({ draining: true });
    const response = await draining.app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "draining", instance: "api-test" });
    await draining.app.close();
  });

  it("runs the complete CRUD lifecycle", async () => {
    const { app } = await fixture();
    const created = await app.inject({ method: "POST", url: "/api/readings", payload: validInput });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: number }>().id;

    const found = await app.inject({ method: "GET", url: `/api/readings/${id}` });
    expect(found.statusCode).toBe(200);
    expect(found.json<{ city: string }>().city).toBe("Porto Alegre");

    const updated = await app.inject({
      method: "PUT",
      url: `/api/readings/${id}`,
      payload: { ...validInput, measuredValue: 44.25, qualityStatus: "moderate" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ measuredValue: number }>().measuredValue).toBe(44.25);

    const deleted = await app.inject({ method: "DELETE", url: `/api/readings/${id}` });
    expect(deleted.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/readings/${id}` })).statusCode).toBe(404);
    await app.close();
  });

  it("does not duplicate a create repeated with the same Idempotency-Key", async () => {
    const { app } = await fixture();
    const headers = { "idempotency-key": "6f1c1b7e-8a8e-4c3f-9a51-1f5f0c3f3a10" };
    const first = await app.inject({ method: "POST", url: "/api/readings", payload: validInput, headers });
    const second = await app.inject({ method: "POST", url: "/api/readings", payload: validInput, headers });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json<{ id: number }>().id).toBe(first.json<{ id: number }>().id);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(second.headers["idempotent-replayed"]).toBe("true");

    const page = await app.inject({ method: "GET", url: "/api/readings" });
    expect(page.json<{ total: number }>().total).toBe(1);
    await app.close();
  });

  it("rejects a malformed Idempotency-Key", async () => {
    const { app } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/readings",
      payload: validInput,
      headers: { "idempotency-key": "not-a-uuid" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_idempotency_key" });
    await app.close();
  });

  it("answers 409 when the key belongs to a reading that was deleted", async () => {
    const { app } = await fixture();
    const headers = { "idempotency-key": "0b7d2e4a-3c55-4e0e-8d0e-2a7f9b1c4d22" };
    const created = await app.inject({ method: "POST", url: "/api/readings", payload: validInput, headers });
    await app.inject({ method: "DELETE", url: `/api/readings/${created.json<{ id: number }>().id}` });
    const replay = await app.inject({ method: "POST", url: "/api/readings", payload: validInput, headers });
    expect(replay.statusCode).toBe(409);
    await app.close();
  });

  it("turns an unavailable database into 503 with Retry-After", async () => {
    const { app, repository } = await fixture();
    repository.failWith = new DatabaseUnavailableError("fora do ar", { cause: new Error("x"), inDoubt: false });
    const response = await app.inject({ method: "GET", url: "/api/readings" });
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.json<{ error: string }>().error).toBe("database_unavailable");
    await app.close();
  });

  it("filters and paginates readings", async () => {
    const { app } = await fixture();
    await app.inject({ method: "POST", url: "/api/readings", payload: validInput });
    await app.inject({ method: "POST", url: "/api/readings", payload: { ...validInput, city: "Pelotas", pollutant: "O3" } });
    const response = await app.inject({
      method: "GET",
      url: "/api/readings?city=Porto%20Alegre&pollutant=PM2.5&page=1&page_size=1",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ total: number; items: Reading[] }>()).toMatchObject({ total: 1, items: [{ city: "Porto Alegre" }] });
    await app.close();
  });

  it("rejects invalid payloads and query ranges", async () => {
    const { app } = await fixture();
    const invalidBody = await app.inject({ method: "POST", url: "/api/readings", payload: { ...validInput, measuredValue: -1 } });
    expect(invalidBody.statusCode).toBe(400);
    const invalidQuery = await app.inject({ method: "GET", url: "/api/readings?page_size=101" });
    expect(invalidQuery.statusCode).toBe(400);
    const invalidRange = await app.inject({
      method: "GET",
      url: "/api/readings?measured_from=2025-12-31T00:00:00Z&measured_to=2025-01-01T00:00:00Z",
    });
    expect(invalidRange.statusCode).toBe(400);
    await app.close();
  });

  it("returns 404 for missing update and delete targets", async () => {
    const { app } = await fixture();
    expect((await app.inject({ method: "PUT", url: "/api/readings/999", payload: validInput })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/readings/999" })).statusCode).toBe(404);
    await app.close();
  });
});
