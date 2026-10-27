import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/database.js";

describe("createPool", () => {
  it("keeps the process alive when a connection in use is dropped by the server", async () => {
    const config = loadConfig({ DATABASE_URL: "postgresql://user:secret@localhost:5432/air_quality" });
    const errors: Error[] = [];
    const pool = createPool(config.DATABASE_URL, config, "test", (error) => errors.push(error));

    // Simula um cliente recem-conectado que perde a conexao enquanto esta em uso.
    const client = new EventEmitter();
    pool.emit("connect", client);
    expect(() => client.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    expect(() => pool.emit("error", new Error("idle client lost"))).not.toThrow();
    expect(errors.map((error) => error.message)).toEqual(["Connection terminated unexpectedly", "idle client lost"]);
    await pool.end();
  });
});
