import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "./migrate";

const MIGRATION_102 = "102_spindle_provider_scope.sql";
const MIGRATION_102_SQL = `-- Scope existing extension grants so provider identity can be host-derived
-- as system | operator:<id> | user:<authenticatedSubject>.
ALTER TABLE extension_grants ADD COLUMN scope TEXT NOT NULL DEFAULT 'system';

UPDATE extension_grants
SET scope = COALESCE((
  SELECT CASE
    WHEN e.install_scope = 'user'
      AND e.installed_by_user_id IS NOT NULL
      AND trim(e.installed_by_user_id) != ''
      THEN 'user:' || e.installed_by_user_id
    WHEN e.install_scope = 'operator'
      AND e.installed_by_user_id IS NOT NULL
      AND trim(e.installed_by_user_id) != ''
      THEN 'operator:' || e.installed_by_user_id
    ELSE 'system'
  END
  FROM extensions e
  WHERE e.id = extension_grants.extension_id
), 'system');

CREATE INDEX IF NOT EXISTS idx_extension_grants_scope
  ON extension_grants(extension_id, scope);
`;

type GrantRow = {
  id: string;
  permission: string;
  scope: string;
};

let temporaryMigrationDirs: string[] = [];

function makeMigrationDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "lumiverse-migrate-102-test-"));
  temporaryMigrationDirs.push(directory);
  return directory;
}

function installMigration(directory: string): void {
  writeFileSync(join(directory, MIGRATION_102), MIGRATION_102_SQL);
}

function seedGrants(db: Database): void {
  db.run(
    `INSERT INTO "user" (id, name, email) VALUES
      ('alice', 'Alice', 'alice@example.test'),
      ('op-1', 'Operator', 'op@example.test')`,
  );
  db.run(
    `INSERT INTO extensions (id, identifier, name, version, author, github, install_scope, installed_by_user_id)
     VALUES
      ('ext-user', 'ext.user', 'User Ext', '1.0.0', 'test', 'https://example.test/user', 'user', 'alice'),
      ('ext-op', 'ext.op', 'Op Ext', '1.0.0', 'test', 'https://example.test/op', 'operator', 'op-1'),
      ('ext-sys', 'ext.sys', 'Sys Ext', '1.0.0', 'test', 'https://example.test/sys', 'operator', NULL)`,
  );
  db.run(
    `INSERT INTO extension_grants (id, extension_id, permission) VALUES
      ('g-user', 'ext-user', 'tools'),
      ('g-op', 'ext-op', 'tools'),
      ('g-sys', 'ext-sys', 'tools')`,
  );
}

afterEach(() => {
  for (const directory of temporaryMigrationDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryMigrationDirs = [];
});

describe("102 spindle provider scope migration", () => {
  test("applies 102_spindle_provider_scope once, reruns idempotently, and backfills scoped grants", async () => {
    expect(MIGRATION_102).toBe("102_spindle_provider_scope.sql");
    const sql = await Bun.file(join(import.meta.dir, "migrations", MIGRATION_102)).text();
    expect(sql.replaceAll("\r\n", "\n")).toBe(MIGRATION_102_SQL);

    const db = new Database(":memory:");
    const migrationsDir = makeMigrationDir();
    try {
      await runMigrations(db, migrationsDir);

      expect(
        (db.query("PRAGMA table_info('extension_grants')").all() as Array<{ name: string }>).some(
          (column) => column.name === "scope",
        ),
      ).toBe(false);
      expect(
        db.query("SELECT COUNT(*) AS count FROM _migrations WHERE name = ?").get(MIGRATION_102),
      ).toEqual({ count: 0 });

      seedGrants(db);
      installMigration(migrationsDir);
      await runMigrations(db, migrationsDir);

      const columns = db.query("PRAGMA table_info('extension_grants')").all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const scopeColumn = columns.find((column) => column.name === "scope");
      expect(scopeColumn && {
        name: scopeColumn.name,
        type: scopeColumn.type,
        notnull: scopeColumn.notnull,
        dflt_value: scopeColumn.dflt_value,
      }).toEqual({
        name: "scope",
        type: "TEXT",
        notnull: 1,
        dflt_value: "'system'",
      });

      const grants = db
        .query("SELECT id, permission, scope FROM extension_grants ORDER BY id")
        .all() as GrantRow[];
      expect(grants).toEqual([
        { id: "g-op", permission: "tools", scope: "operator:op-1" },
        { id: "g-sys", permission: "tools", scope: "system" },
        { id: "g-user", permission: "tools", scope: "user:alice" },
      ]);

      const indexNames = (
        db.query("PRAGMA index_list('extension_grants')").all() as Array<{ name: string }>
      ).map((index) => index.name);
      expect(indexNames).toContain("idx_extension_grants_scope");

      await runMigrations(db, migrationsDir);
      expect(
        db.query("SELECT COUNT(*) AS count FROM _migrations WHERE name = ?").get(MIGRATION_102),
      ).toEqual({ count: 1 });
      expect(
        db.query("SELECT COUNT(*) AS count FROM extension_grants").get(),
      ).toEqual({ count: 3 });
    } finally {
      db.close();
    }
  });
});
