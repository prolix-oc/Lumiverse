import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { runMigrations } from "./migrate";

// Hard invariant: a fresh database bootstrapped from baseline.sql must have
// exactly the same schema as a database built by replaying every migration
// file in order (tables, columns, indices, views, triggers).

type ColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

function extractSchema(db: Database) {
  const objects = db
    .query(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as Array<{ type: string; name: string; sql: string | null }>;

  const schema: Record<string, unknown> = {};
  for (const obj of objects) {
    if (obj.type === "table") {
      const cols = db.query(`PRAGMA table_info('${obj.name}')`).all() as ColumnInfo[];
      const fks = db.query(`PRAGMA foreign_key_list('${obj.name}')`).all();
      schema[`table:${obj.name}`] = JSON.stringify({ cols, fks });
    } else if (obj.type === "index") {
      const cols = (
        db.query(`PRAGMA index_info('${obj.name}')`).all() as Array<{ name: string }>
      ).map((c) => c.name);
      const unique = /CREATE\s+UNIQUE\s+INDEX/i.test(obj.sql ?? "");
      schema[`index:${obj.name}`] = JSON.stringify({ cols, unique });
    } else {
      schema[`${obj.type}:${obj.name}`] = (obj.sql ?? "").replace(/\s+/g, " ").trim();
    }
  }
  return schema;
}

describe("baseline sync", () => {
  test("baseline.sql schema matches full migration replay", async () => {
    // DB A: fresh bootstrap from baseline.sql.
    const dbA = new Database(":memory:");
    try {
      const baselineSql = await Bun.file(join(import.meta.dir, "baseline.sql")).text();
      dbA.run(baselineSql);

      // DB B: replay every migration file in order.
      const dbB = new Database(":memory:");
      try {
        const dir = join(import.meta.dir, "migrations");
        const files = readdirSync(dir)
          .filter((f) => f.endsWith(".sql"))
          .sort();
        expect(files.length).toBeGreaterThan(100);
        // Exercise the same replay semantics as production without triggering
        // fresh-baseline bootstrap: the sentinel makes this an existing DB,
        // while the runner still applies every shipped migration in order,
        // including canonical foreign-key-off and baseline-drift handling.
        dbB.run("CREATE TABLE _migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))");
        dbB.run("INSERT INTO _migrations (name) VALUES ('000_raw_replay_sentinel.sql')");
        await runMigrations(dbB, dir);
        dbB.run("DROP TABLE _migrations");

        const schemaA = extractSchema(dbA);
        const schemaB = extractSchema(dbB);

        const keysA = Object.keys(schemaA).sort();
        const keysB = Object.keys(schemaB).sort();
        expect(keysA).toEqual(keysB);

        for (const key of keysA) {
          expect({ key, definition: schemaA[key] }).toEqual({
            key,
            definition: schemaB[key],
          });
        }
      } finally {
        dbB.close();
      }
    } finally {
      dbA.close();
    }
  });

  test("baseline carries the scoped extension grants contract", async () => {
    const db = new Database(":memory:");
    try {
      const baselineSql = await Bun.file(join(import.meta.dir, "baseline.sql")).text();
      db.run(baselineSql);

      const columns = db.query("PRAGMA table_info(extension_grants)").all() as ColumnInfo[];
      expect(columns.map((c) => c.name)).toEqual([
        "id",
        "extension_id",
        "permission",
        "granted_at",
        "scope",
      ]);
      expect(columns.find((c) => c.name === "scope")?.notnull).toBe(1);
      expect(columns.find((c) => c.name === "scope")?.dflt_value).toBe("'system'");

      const indexes = db.query("PRAGMA index_list(extension_grants)").all() as Array<{
        name: string;
        unique: number;
      }>;
      expect(indexes.map((i) => i.name)).toContain("idx_extension_grants_scope");

      // Same permission + extension across two distinct scopes coexists.
      db.run(
        `INSERT INTO extensions (id, identifier, name, version, author, github)
         VALUES ('ext-1', 'test-ext', 'Test Ext', '1.0.0', 'tester', 'https://github.com/test/ext')`,
      );
      db.run(
        `INSERT INTO extension_grants (id, extension_id, permission, scope)
         VALUES ('g1', 'ext-1', 'providers.embedding.register', 'system')`,
      );
      db.run(
        `INSERT INTO extension_grants (id, extension_id, permission, scope)
         VALUES ('g2', 'ext-1', 'providers.embedding.register', 'user:alice')`,
      );
      expect(db.query("SELECT COUNT(*) AS count FROM extension_grants").get()).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });

  test("baseline carries the bounded WORK segment contract", async () => {
    const db = new Database(":memory:");
    try {
      const baselineSql = await Bun.file(join(import.meta.dir, "baseline.sql")).text();
      db.run(baselineSql);
      const tables = db.query(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name LIKE 'agent_work_segment%'
          ORDER BY name`,
      ).all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual([
        "agent_work_segment_dispatches",
        "agent_work_segment_recovery",
        "agent_work_segment_transitions",
        "agent_work_segments",
      ]);
      for (const table of tables) {
        const columns = db.query(`PRAGMA table_info(${table.name})`).all() as ColumnInfo[];
        expect(columns.map((column) => column.name)).toContain("schema_version");
        expect(columns.map((column) => column.name)).toContain("record_complete");
        expect(columns.map((column) => column.name)).toContain("payload_digest");
      }
      const receiptColumns = db.query("PRAGMA table_info(agent_work_workspace_receipts)").all() as ColumnInfo[];
      for (const required of ["segment_id", "logical_dispatch", "frame_id"]) {
        expect(receiptColumns.find((column) => column.name === required)?.notnull).toBe(1);
      }
      const receiptDispatchIndex = db.query(
        "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'idx_agent_work_workspace_receipts_dispatch'",
      ).get() as { sql: string };
      expect(receiptDispatchIndex.sql).toContain("segment_id, logical_dispatch");
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
