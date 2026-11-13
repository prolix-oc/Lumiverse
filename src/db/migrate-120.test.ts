import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { runMigrations } from "./migrate";

describe("120 Illarin receipts per installation migration", () => {
  test("preserves old receipts and permits the same send ID on a new installation", async () => {
    const db = new Database(":memory:");
    try {
      db.run('CREATE TABLE "user" (id TEXT PRIMARY KEY)');
      db.run("INSERT INTO \"user\" (id) VALUES ('synthetic-user')");
      db.run(await Bun.file(join(import.meta.dir, "migrations", "110_illarin_delivery_receipts.sql")).text());
      db.run(`INSERT INTO illarin_delivery_receipt
        (user_id, instance_id, delivery_id, asset_id, content_generation, acknowledged_at)
        VALUES ('synthetic-user', 'old-app', 'send-1', 'work-1', 4, '2026-09-23')`);
      db.run(`CREATE TABLE _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        applied_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`);
      const applied = db.prepare("INSERT INTO _migrations (name) VALUES (?)");
      for (const name of readdirSync(join(import.meta.dir, "migrations")).filter((name) => name.endsWith(".sql"))) {
        if (name !== "120_illarin_receipts_per_installation.sql") applied.run(name);
      }
      applied.finalize();

      await runMigrations(db);

      db.run(`INSERT INTO illarin_delivery_receipt
        (user_id, instance_id, delivery_id, asset_id, content_generation)
        VALUES ('synthetic-user', 'new-app', 'send-1', 'work-2', 6)`);
      const rows = db.query(`SELECT instance_id, asset_id, content_generation, acknowledged_at
        FROM illarin_delivery_receipt ORDER BY instance_id`).all();
      expect(rows).toEqual([
        { instance_id: "new-app", asset_id: "work-2", content_generation: 6, acknowledged_at: null },
        { instance_id: "old-app", asset_id: "work-1", content_generation: 4, acknowledged_at: "2026-09-23" },
      ]);
    } finally {
      db.close();
    }
  });
});
