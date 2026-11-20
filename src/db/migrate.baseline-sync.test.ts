import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";

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
        // FK enforcement does not affect recorded schema objects, but table
        // rebuilds (e.g. extension_grants) need it disabled to avoid cascades
        // on empty tables anyway; flip globally for the replay.
        dbB.run("PRAGMA foreign_keys = OFF");
        for (const file of files) {
          const sql = await Bun.file(join(dir, file)).text();
          dbB.run(sql);
        }

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

  test("baseline supports Android relay enrollment and preserves direct destination defaults", async () => {
    const db = new Database(":memory:");
    try {
      db.run("PRAGMA foreign_keys = ON");
      db.run(await Bun.file(join(import.meta.dir, "baseline.sql")).text());
      db.run(`INSERT INTO "user" (id, name, email) VALUES ('user-1', 'Owner', 'owner@example.test')`);
      const insert = db.query(`
        INSERT INTO android_push_destinations
          (id, user_id, device_id, transport, server_origin, token_hash, registered_at, enrollment_id)
        VALUES (?, 'user-1', ?, 'fcm', 'https://example.test', ?, 1, ?)
      `);
      insert.run("direct-1", "device-1", "hash-1", null);
      insert.run("direct-2", "device-2", "hash-2", null);
      expect(db.query(`
        SELECT delivery_mode, package_name, enrollment_id
        FROM android_push_destinations WHERE id = 'direct-1'
      `).get()).toEqual({
        delivery_mode: "direct",
        package_name: "chat.lumiverse.prototype",
        enrollment_id: null,
      });

      insert.run("relay-1", "device-3", "hash-3", "enrollment-1");
      db.run("UPDATE android_push_destinations SET delivery_mode = 'relay' WHERE id = 'relay-1'");
      expect(() => insert.run("relay-2", "device-4", "hash-4", "enrollment-1"))
        .toThrow("UNIQUE constraint failed");
      expect(() => db.run("UPDATE android_push_destinations SET delivery_mode = 'invalid' WHERE id = 'relay-1'"))
        .toThrow("CHECK constraint failed");
    } finally {
      db.close();
    }
  });
});
