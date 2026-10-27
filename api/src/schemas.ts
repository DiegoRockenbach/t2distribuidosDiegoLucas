import { z } from "zod";
import { pollutants, qualityStatuses } from "./domain.js";

const trimmedString = (max: number) => z.string().trim().min(1).max(max);

export const readingInputSchema = z.object({
  stationCode: trimmedString(20),
  city: trimmedString(100),
  pollutant: z.enum(pollutants),
  measuredAt: z.iso.datetime({ offset: true }),
  measuredValue: z.number().finite().min(0).max(1_000_000_000),
  unit: trimmedString(16),
  qualityStatus: z.enum(qualityStatuses),
  notes: z.string().trim().max(1000).nullable().default(null),
}).strict();

// Cabecalho Idempotency-Key: UUID gerado pelo cliente para cada criacao.
export const idempotencyKeySchema = z.uuid();

export const idParamsSchema = z.object({
  id: z.coerce.number().int().positive().safe(),
});

export const listQuerySchema = z.object({
  city: trimmedString(100).optional(),
  pollutant: z.enum(pollutants).optional(),
  measured_from: z.iso.datetime({ offset: true }).optional(),
  measured_to: z.iso.datetime({ offset: true }).optional(),
  page: z.coerce.number().int().positive().max(1_000_000).default(1),
  page_size: z.coerce.number().int().positive().max(100).default(25),
}).strict().superRefine((value, context) => {
  if (value.measured_from && value.measured_to && value.measured_from > value.measured_to) {
    context.addIssue({
      code: "custom",
      path: ["measured_from"],
      message: "measured_from deve ser anterior ou igual a measured_to",
    });
  }
});
