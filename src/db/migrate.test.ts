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
      expect(
        db.query("SELECT name FROM _migrations WHERE name = ?").get("094_regex_actions.sql"),
      ).toEqual({ name: "094_regex_actions.sql" });
      const regexColumns = db.query("PRAGMA table_info(regex_scripts)").all() as Array<{ name: string }>;
      expect(regexColumns.some((column) => column.name === "actions")).toBe(true);
      const linkColumns = db.query("PRAGMA table_info(lumihub_link)").all() as Array<{ name: string }>;
      expect(linkColumns.some((column) => column.name === "user_id")).toBe(true);
      expect(
        db.query("SELECT name FROM _migrations WHERE name = ?").get("095_lumihub_link_user_scope.sql"),
      ).toEqual({ name: "095_lumihub_link_user_scope.sql" });
    } finally {
      db.close();
    }
  });

  test("assigns the legacy instance link to the historical owner", async () => {
    const db = new Database(":memory:");
    try {
      db.run(`CREATE TABLE "user" (id TEXT PRIMARY KEY, createdAt INTEGER NOT NULL)`);
      db.run(`INSERT INTO "user" (id, createdAt) VALUES ('owner', 1), ('tenant', 2)`);
      db.run(`CREATE TABLE lumihub_link (
        id TEXT PRIMARY KEY,
        lumihub_url TEXT NOT NULL,
        ws_url TEXT NOT NULL,
        instance_name TEXT NOT NULL,
        link_token_encrypted TEXT NOT NULL,
        link_token_iv TEXT NOT NULL,
        link_token_tag TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        last_connected_at TEXT,
        share_usage_stats INTEGER NOT NULL DEFAULT 0
      )`);
      db.run(`INSERT INTO lumihub_link VALUES (
        'legacy', 'https://hub.test', 'wss://hub.test', 'Legacy', 'token', 'iv', 'tag', 'instance', 'now', NULL, 0
      )`);

      const sql = await Bun.file(`${import.meta.dir}/migrations/095_lumihub_link_user_scope.sql`).text();
      db.run(sql);

      expect(db.query("SELECT user_id FROM lumihub_link WHERE id = 'legacy'").get()).toEqual({ user_id: "owner" });
      db.run(`INSERT INTO lumihub_link (
        id, user_id, lumihub_url, ws_url, instance_name, link_token_encrypted,
        link_token_iv, link_token_tag, instance_id, linked_at
      ) VALUES ('tenant-link', 'tenant', 'https://hub.test', 'wss://hub.test', 'Tenant', 'token', 'iv', 'tag', 'instance-2', 'now')`);
      expect(db.query("SELECT COUNT(*) AS count FROM lumihub_link").get()).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });
});
