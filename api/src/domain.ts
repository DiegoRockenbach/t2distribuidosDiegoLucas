export const pollutants = ["PM2.5", "PM10", "CO", "NO2", "SO2", "O3"] as const;
export const qualityStatuses = ["good", "moderate", "unhealthy", "critical"] as const;

export type Pollutant = (typeof pollutants)[number];
export type QualityStatus = (typeof qualityStatuses)[number];

export interface ReadingInput {
  stationCode: string;
  city: string;
  pollutant: Pollutant;
  measuredAt: string;
  measuredValue: number;
  unit: string;
  qualityStatus: QualityStatus;
  notes: string | null;
}

export interface Reading extends ReadingInput {
  id: number;
  createdAt: string;
}

export interface ReadingFilters {
  city?: string;
  pollutant?: Pollutant;
  measuredFrom?: string;
  measuredTo?: string;
  page: number;
  pageSize: number;
}

export interface ReadingPage {
  items: Reading[];
  page: number;
  pageSize: number;
  total: number;
}

export interface CreateOptions {
  /** Chave de idempotencia enviada pelo cliente (cabecalho Idempotency-Key). */
  requestId?: string;
}

export interface CreateResult {
  reading: Reading;
  /** true quando a chave ja tinha sido usada e a medicao existente foi devolvida. */
  replayed: boolean;
}

/** A chave de idempotencia ja foi usada por uma medicao que nao existe mais. */
export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency-Key ja utilizada por uma medicao removida");
    this.name = "IdempotencyConflictError";
  }
}

export interface ReadingRepository {
  create(input: ReadingInput, options?: CreateOptions): Promise<CreateResult>;
  findById(id: number): Promise<Reading | null>;
  list(filters: ReadingFilters): Promise<ReadingPage>;
  update(id: number, input: ReadingInput): Promise<Reading | null>;
  delete(id: number): Promise<boolean>;
}
