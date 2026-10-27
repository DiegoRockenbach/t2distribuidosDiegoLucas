CREATE TABLE IF NOT EXISTS air_quality_readings (
    id BIGSERIAL PRIMARY KEY,
    station_code VARCHAR(20) NOT NULL CHECK (length(btrim(station_code)) > 0),
    city VARCHAR(100) NOT NULL CHECK (length(btrim(city)) > 0),
    pollutant VARCHAR(10) NOT NULL CHECK (pollutant IN ('PM2.5', 'PM10', 'CO', 'NO2', 'SO2', 'O3')),
    measured_at TIMESTAMPTZ NOT NULL,
    measured_value NUMERIC(12, 3) NOT NULL CHECK (measured_value >= 0),
    unit VARCHAR(16) NOT NULL CHECK (length(btrim(unit)) > 0),
    quality_status VARCHAR(20) NOT NULL CHECK (quality_status IN ('good', 'moderate', 'unhealthy', 'critical')),
    notes TEXT NULL CHECK (notes IS NULL OR length(notes) <= 1000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
