import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePreBundleBackup, getPreBundleBackupPath, runMigrations } from "./migrate";

const persistentMigrationRoots: string[] = [];

function createPersistentPreBundleFixture(): {
  db: Database;
  root: string;
  migrationsDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), "lumiverse-pre-bundle-migration-"));
  persistentMigrationRoots.push(root);
  const migrationsDir = join(root, "migrations");
  mkdirSync(migrationsDir);
  const db = new Database(join(root, "lumiverse.db"));
  db.run(`
    CREATE TABLE _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  db.run("INSERT INTO _migrations (name) VALUES ('112_before_bundle.sql')");
  db.run("CREATE TABLE pre_bundle_data (value TEXT NOT NULL)");
  db.run("INSERT INTO pre_bundle_data (value) VALUES ('preserve me')");
  return { db, root, migrationsDir };
}

function installBundleMigration(migrationsDir: string, sql = "CREATE TABLE bundle_marker (id INTEGER PRIMARY KEY)"): void {
  writeFileSync(join(migrationsDir, "113_bundle.sql"), `${sql};`);
}

afterEach(() => {
  for (const root of persistentMigrationRoots) rmSync(root, { recursive: true, force: true });
  persistentMigrationRoots.length = 0;
});
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
      expect(regexColumns.some((column) => column.name === "owner_extension_identifier")).toBe(true);
      expect(
        db.query("SELECT name FROM _migrations WHERE name = ?").get("101_regex_script_extension_ownership.sql"),
      ).toEqual({ name: "101_regex_script_extension_ownership.sql" });
      const linkColumns = db.query("PRAGMA table_info(lumihub_link)").all() as Array<{ name: string }>;
      expect(linkColumns.some((column) => column.name === "user_id")).toBe(true);
      expect(
        db.query("SELECT name FROM _migrations WHERE name = ?").get("095_lumihub_link_user_scope.sql"),
      ).toEqual({ name: "095_lumihub_link_user_scope.sql" });
      expect(
        db.query("SELECT name FROM _migrations WHERE name = ?").get("107_world_book_entry_order_index.sql"),
      ).toEqual({ name: "107_world_book_entry_order_index.sql" });
      const entryIndexes = db.query("PRAGMA index_list('world_book_entries')").all() as Array<{ name: string }>;
      expect(entryIndexes.map((index) => index.name)).toContain("idx_wbe_world_book_order");
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
  test("skips the backup for a brand-new persistent database", () => {
    const root = mkdtempSync(join(tmpdir(), "lumiverse-pre-bundle-empty-"));
    persistentMigrationRoots.push(root);
    const migrationsDir = join(root, "migrations");
    mkdirSync(migrationsDir);
    installBundleMigration(migrationsDir);
    const db = new Database(join(root, "empty.db"));
    try {
      ensurePreBundleBackup(db, migrationsDir);
      expect(existsSync(getPreBundleBackupPath(db)!)).toBe(false);
    } finally {
      db.close();
    }
  });

  test("does not inspect or overwrite an old backup after crossing the bundle", async () => {
    const { db, migrationsDir } = createPersistentPreBundleFixture();
    try {
      db.run("INSERT INTO _migrations (name) VALUES ('113_bundle.sql')");
      writeFileSync(join(migrationsDir, "114_later.sql"), "CREATE TABLE later_marker (id INTEGER PRIMARY KEY);");
      const backupPath = getPreBundleBackupPath(db);
      expect(backupPath).not.toBeNull();
      writeFileSync(backupPath!, "stale backup is retained");

      await runMigrations(db, migrationsDir);
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'later_marker'").get()).toEqual({
        name: "later_marker",
      });
      expect(await Bun.file(backupPath!).text()).toBe("stale backup is retained");
    } finally {
      db.close();
    }
  });
  test("creates one verified pre-bundle backup and reuses it after restart", async () => {
    const { db, root, migrationsDir } = createPersistentPreBundleFixture();
    let currentDb: Database | null = db;
    try {
      installBundleMigration(migrationsDir);
      await runMigrations(db, migrationsDir);

      const backupPath = getPreBundleBackupPath(db);
      expect(backupPath).not.toBeNull();
      expect(existsSync(backupPath!)).toBe(true);
      const backup = new Database(backupPath!, { readonly: true });
      try {
        const integrity = backup.query("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
        expect(integrity.map((row) => Object.values(row)[0])).toEqual(["ok"]);
        expect(backup.query("SELECT name FROM _migrations ORDER BY id").all()).toEqual([
          { name: "112_before_bundle.sql" },
        ]);
        expect(backup.query("SELECT value FROM pre_bundle_data").get()).toEqual({ value: "preserve me" });
        expect(backup.query("SELECT name FROM sqlite_master WHERE name = 'bundle_marker'").get()).toBeNull();
      } finally {
        backup.close();
      }

      const firstBackupMtime = statSync(backupPath!).mtimeMs;
      db.close();
      currentDb = null;
      const restarted = new Database(join(root, "lumiverse.db"));
      currentDb = restarted;
      await runMigrations(restarted, migrationsDir);
      expect(statSync(backupPath!).mtimeMs).toBe(firstBackupMtime);
      expect(restarted.query("SELECT name FROM _migrations WHERE name = '113_bundle.sql'").get()).toEqual({
        name: "113_bundle.sql",
      });
    } finally {
      currentDb?.close();
    }
  });

  test("fails closed before migration when the deterministic backup is invalid", async () => {
    const { db, migrationsDir } = createPersistentPreBundleFixture();
    try {
      installBundleMigration(migrationsDir);
      const backupPath = getPreBundleBackupPath(db);
      expect(backupPath).not.toBeNull();
      writeFileSync(backupPath!, "not a SQLite database");

      await expect(runMigrations(db, migrationsDir)).rejects.toThrow("pre-bundle backup validation failed");
      expect(db.query("SELECT name FROM _migrations ORDER BY id").all()).toEqual([
        { name: "112_before_bundle.sql" },
      ]);
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'bundle_marker'").get()).toBeNull();
    } finally {
      db.close();
    }
  });
});
