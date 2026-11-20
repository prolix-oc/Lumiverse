import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { runMigrations } from "./migrate";

const MIGRATION_109 = "109_illarin_instance.sql";
const MIGRATION_110 = "110_illarin_delivery_receipts.sql";

describe("110 Illarin delivery receipts migration", () => {
  test("upgrades a database that already applied the live 109 schema", async () => {
    const db = new Database(":memory:");
    try {
      db.run(`CREATE TABLE "user" (id TEXT PRIMARY KEY)`);
      db.run(`INSERT INTO "user" (id) VALUES ('user-1')`);
      db.run(await Bun.file(join(import.meta.dir, "migrations", MIGRATION_109)).text());

      expect(db.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'illarin_delivery_receipt'",
      ).get()).toBeNull();

      db.run(`CREATE TABLE _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        applied_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`);
      const insert = db.prepare("INSERT INTO _migrations (name) VALUES (?)");
      for (const name of readdirSync(join(import.meta.dir, "migrations")).filter((name) => name.endsWith(".sql"))) {
        if (name !== MIGRATION_110) insert.run(name);
      }
      insert.finalize();

      await runMigrations(db);

      const columns = db.query("PRAGMA table_info('illarin_delivery_receipt')").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual([
        "user_id",
        "instance_id",
        "delivery_id",
        "asset_id",
        "content_generation",
        "installed_at",
        "acknowledged_at",
      ]);
      const indexes = db.query("PRAGMA index_list('illarin_delivery_receipt')").all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toContain("idx_illarin_delivery_receipt_pending");
      expect(db.query("SELECT name FROM _migrations WHERE name = ?").get(MIGRATION_110)).toEqual({
        name: MIGRATION_110,
      });
    } finally {
      db.close();
    }
  });
});
