import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { IdempotencyConflictError, type ReadingFilters, type ReadingRepository } from "./domain.js";
import { DatabaseUnavailableError, type DatabaseHealth } from "./resilience.js";
import { idempotencyKeySchema, idParamsSchema, listQuerySchema, readingInputSchema } from "./schemas.js";

interface AppDependencies {
  repository: ReadingRepository;
  checkDatabase: () => Promise<DatabaseHealth>;
  instanceId: string;
  /** true durante o desligamento gracioso: /health/live passa a responder 503. */
  isDraining?: () => boolean;
  corsOrigin: string;
  logger?: boolean | { level: string };
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: dependencies.logger ?? false });

  await app.register(cors, { origin: dependencies.corsOrigin, exposedHeaders: ["x-served-by"] });

  // Toda resposta informa qual replica da API a atendeu.
  app.addHook("onRequest", async (_request, reply) => {
    void reply.header("x-served-by", dependencies.instanceId);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DatabaseUnavailableError) {
      request.log.warn({ err: error.cause, inDoubt: error.inDoubt }, "banco indisponivel");
      return reply.status(503).header("retry-after", "2").send({
        error: "database_unavailable",
        message: "Banco de dados temporariamente indisponivel; tente novamente",
      });
    }
    if (error instanceof IdempotencyConflictError) {
      return reply.status(409).send({ error: "idempotency_conflict", message: error.message });
    }
    request.log.error({ err: error }, "request failed");
    const candidate = typeof error === "object" && error !== null && "statusCode" in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
    const clientError = typeof candidate === "number" && candidate >= 400 && candidate < 500;
    const statusCode = clientError ? candidate : 500;
    return reply.status(statusCode).send({
      error: clientError ? "bad_request" : "internal_error",
      message: clientError ? "Requisicao invalida" : "Erro interno do servidor",
    });
  });

  // Vivacidade da replica, usada pelo balanceador. Nao consulta o banco.
  app.get("/health/live", async (_request, reply) => {
    const draining = dependencies.isDraining?.() ?? false;
    return reply.status(draining ? 503 : 200).send({
      status: draining ? "draining" : "ok",
      instance: dependencies.instanceId,
    });
  });

  // Estado completo: replica da API e as duas rotas para o banco.
  app.get("/health", async (_request, reply) => {
    const database = await dependencies.checkDatabase();
    const primaryUp = database.primary === "reachable";
    const replicasUp = database.replicas === "reachable";
    const status = primaryUp
      ? (database.replicas === "unreachable" ? "degraded" : "ok")
      : (replicasUp ? "read-only" : "unavailable");
    return reply.status(primaryUp || replicasUp ? 200 : 503).send({
      status,
      instance: dependencies.instanceId,
      database,
    });
  });

  app.post("/api/readings", async (request, reply) => {
    const parsed = readingInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "validation_error", details: parsed.error.issues });
    }
    const rawKey = request.headers["idempotency-key"];
    let requestId: string | undefined;
    if (rawKey !== undefined) {
      const key = idempotencyKeySchema.safeParse(rawKey);
      if (!key.success) return reply.status(400).send({ error: "invalid_idempotency_key" });
      requestId = key.data;
    }
    const result = await dependencies.repository.create(
      parsed.data,
      requestId === undefined ? {} : { requestId },
    );
    if (result.replayed) void reply.header("idempotent-replayed", "true");
    return reply.status(201).send(result.reading);
  });

  app.get("/api/readings", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "validation_error", details: parsed.error.issues });
    }
    const query = parsed.data;
    const filters: ReadingFilters = { page: query.page, pageSize: query.page_size };
    if (query.city !== undefined) filters.city = query.city;
    if (query.pollutant !== undefined) filters.pollutant = query.pollutant;
    if (query.measured_from !== undefined) filters.measuredFrom = query.measured_from;
    if (query.measured_to !== undefined) filters.measuredTo = query.measured_to;
    return reply.send(await dependencies.repository.list(filters));
  });

  app.get("/api/readings/:id", async (request, reply) => {
    const parsed = idParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_id" });
    const reading = await dependencies.repository.findById(parsed.data.id);
    return reading ? reply.send(reading) : reply.status(404).send({ error: "not_found" });
  });

  app.put("/api/readings/:id", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = readingInputSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({
        error: "validation_error",
        details: [...(!params.success ? params.error.issues : []), ...(!body.success ? body.error.issues : [])],
      });
    }
    const reading = await dependencies.repository.update(params.data.id, body.data);
    return reading ? reply.send(reading) : reply.status(404).send({ error: "not_found" });
  });

  app.delete("/api/readings/:id", async (request, reply) => {
    const parsed = idParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_id" });
    const deleted = await dependencies.repository.delete(parsed.data.id);
    return deleted ? reply.status(204).send() : reply.status(404).send({ error: "not_found" });
  });

  return app;
}
