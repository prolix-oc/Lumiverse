import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "./migrate";

describe("database migrations", () => {
  test("fresh bootstrap applies the preset cache revision exactly once", async () => {
    const db = new Database(":memory:");
    try {
      await runMigrations(db);
      const columns = db.query("PRAGMA table_info(presets)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "cache_revision")).toBe(true);
      expect(
        db.query("SELECT name FROM _migrations WHERE name = ?").get("093_preset_cache_revision.sql"),
      ).toEqual({ name: "093_preset_cache_revision.sql" });
    } finally {
      db.close();
    }
  });
});
