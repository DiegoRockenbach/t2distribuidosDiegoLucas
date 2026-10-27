import { loadConfig } from "../src/config.js";
import { createPool } from "../src/database.js";

// Scripts administrativos sempre falam com o primario (DATABASE_URL).
export function scriptPool() {
  const config = loadConfig();
  return createPool(config.DATABASE_URL, config, "script");
}

export function argumentValue(name: string): string | undefined {
  const position = process.argv.indexOf(name);
  return position >= 0 ? process.argv[position + 1] : undefined;
}

export function requiredPositiveInteger(name: string): number {
  const raw = argumentValue(name);
  const value = Number(raw);
  if (!raw || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} deve receber um inteiro positivo`);
  }
  return value;
}
