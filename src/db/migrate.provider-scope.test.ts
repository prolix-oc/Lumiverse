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

function markMigrationsApplied(db: Database, names: readonly string[]): void {
  const insert = db.prepare("INSERT OR IGNORE INTO _migrations (name) VALUES (?)");
  for (const name of names) {
    insert.run(name);
  }
  insert.finalize();
}

// Rebuilds the pre-102 legacy schema (extension_grants WITHOUT a scope column
// and with the old UNIQUE(extension_id, permission)) plus _migrations records
// marking everything up to 101 as applied, so runMigrations replays 102 on top.
function makeLegacyScopedDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE _migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  db.run(`CREATE TABLE extensions (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    author TEXT NOT NULL,
    github TEXT NOT NULL,
    install_scope TEXT NOT NULL DEFAULT 'operator',
    installed_by_user_id TEXT
  )`);
  db.run(`CREATE TABLE extension_grants (
    id TEXT PRIMARY KEY,
    extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
    permission TEXT NOT NULL,
    granted_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(extension_id, permission)
  )`);
  return db;
}

afterEach(() => {
  for (const directory of temporaryMigrationDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryMigrationDirs = [];
});

describe("102 spindle provider scope migration", () => {
  test("applies 102_spindle_provider_scope once on legacy databases and backfills scoped grants", async () => {
    expect(MIGRATION_102).toBe("102_spindle_provider_scope.sql");
    const sql = await Bun.file(join(import.meta.dir, "migrations", MIGRATION_102)).text();
    expect(sql.replaceAll("\r\n", "\n")).toBe(MIGRATION_102_SQL);

    // Legacy databases (pre-baseline-squash) still carry extension_grants
    // without a scope column; the runner must replay 102 exactly once there.
    const db = makeLegacyScopedDb();
    const migrationsDir = makeMigrationDir();
    try {
      // Mark pre-102 history as applied so the runner skips baseline bootstrap.
      markMigrationsApplied(db, ["001_settings.sql", "014_extensions.sql", "101_regex_script_extension_ownership.sql"]);
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

  test("post-104 schema keeps one row per (extension, permission, scope) across tenants", async () => {
    const db = new Database(":memory:");
    try {
      // Empty dir -> fresh baseline bootstrap only, i.e. the final schema
      // including 104_extension_grants_scoped_unique.
      await runMigrations(db, makeMigrationDir());

      db.run(
        `INSERT INTO "user" (id, name, email) VALUES
          ('alice', 'Alice', 'alice@example.test'),
          ('op-1', 'Operator', 'op@example.test')`,
      );
      db.run(
        `INSERT INTO extensions (id, identifier, name, version, author, github, install_scope, installed_by_user_id)
         VALUES ('ext-multi', 'ext.multi', 'Multi Ext', '1.0.0', 'test', 'https://example.test/multi', 'operator', NULL)`,
      );

      // Same permission + extension granted into two distinct scopes must
      // produce TWO distinct rows after 104 replaces UNIQUE(extension_id,
      // permission) with UNIQUE(extension_id, permission, scope).
      db.run(
        `INSERT INTO extension_grants (id, extension_id, permission, scope)
         VALUES ('g-alice', 'ext-multi', 'providers.embedding.register', 'user:alice')`,
      );
      db.run(
        `INSERT INTO extension_grants (id, extension_id, permission, scope)
         VALUES ('g-op', 'ext-multi', 'providers.embedding.register', 'operator:op-1')`,
      );
      expect(
        db
          .query("SELECT id, permission, scope FROM extension_grants ORDER BY id")
          .all() as GrantRow[],
      ).toEqual([
        { id: "g-alice", permission: "providers.embedding.register", scope: "user:alice" },
        { id: "g-op", permission: "providers.embedding.register", scope: "operator:op-1" },
      ]);

      // The scoped unique still rejects an exact-scope duplicate.
      let threw = false;
      try {
        db.run(
          `INSERT INTO extension_grants (id, extension_id, permission, scope)
           VALUES ('g-dup', 'ext-multi', 'providers.embedding.register', 'user:alice')`,
        );
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    } finally {
      db.close();
    }
  });
});
