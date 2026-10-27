-- Chave de idempotencia das criacoes. Com ela, um POST cuja resposta se perdeu
-- (replica da API caiu, failover do banco) pode ser repetido sem duplicar a
-- medicao: a segunda tentativa encontra a chave e devolve o registro existente.
ALTER TABLE air_quality_readings ADD COLUMN IF NOT EXISTS request_id UUID NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_air_readings_request_id
    ON air_quality_readings (request_id);
