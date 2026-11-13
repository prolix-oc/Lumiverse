import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "./migrate";

const migration = "134_better_auth_provider_account_identity.sql";
const directories: string[] = [];

async function legacyDatabase() {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(await Bun.file(join(import.meta.dir, "migrations/015_auth_tables.sql")).text());
  db.run(await Bun.file(join(import.meta.dir, "migrations/113_better_auth_1_7_accounts.sql")).text());
  db.run(`
    CREATE TABLE _migrations (name TEXT NOT NULL UNIQUE);
    INSERT INTO _migrations (name) VALUES ('113_better_auth_1_7_accounts.sql');
    INSERT INTO "user" (id, name, email) VALUES ('owner', 'Owner', 'owner@example.test');
    INSERT INTO account (id, accountId, providerId, issuer, userId, password, accessToken, refreshToken, createdAt, updatedAt)
    VALUES ('password', 'owner', 'credential', 'local:credential', 'owner', 'existing-hash', NULL, NULL, 10, 11),
      ('sso', 'subject', 'authentik', 'local:oauth:authentik', 'owner', NULL, 'access', 'refresh', 12, 13);
    INSERT INTO session (id, token, userId, expiresAt) VALUES ('session', 'session-token', 'owner', 4102444800);
    CREATE TABLE account_references (account_id TEXT REFERENCES account(id) ON DELETE CASCADE);
    INSERT INTO account_references (account_id) VALUES ('sso');
  `);
  const directory = mkdtempSync(join(tmpdir(), "lumiverse-auth-134-"));
  directories.push(directory);
  copyFileSync(join(import.meta.dir, "migrations", migration), join(directory, migration));
  return { db, directory };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("provider/account identity migration", () => {
  test("preserves passwords, SSO credentials, sessions, and account references across repeated startups", async () => {
    const { db, directory } = await legacyDatabase();
    try {
      const select = "SELECT id, accountId, providerId, userId, password, accessToken, refreshToken, createdAt, updatedAt FROM account ORDER BY id";
      const accounts = db.query(select).all();
      const sessions = db.query("SELECT * FROM session").all();
      await runMigrations(db, directory);
      await runMigrations(db, directory);
      expect(db.query(select).all()).toEqual(accounts);
      expect(db.query("SELECT * FROM session").all()).toEqual(sessions);
      expect(db.query("SELECT * FROM account_references").all()).toEqual([{ account_id: "sso" }]);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(db.query("PRAGMA table_info(account)").all().some((row: any) => row.name === "issuer")).toBe(false);
      expect(db.query("SELECT COUNT(*) AS count FROM _migrations WHERE name = ?").get(migration)).toEqual({ count: 1 });
      // New links need no issuer; identical subjects at different providers stay distinct.
      db.run(`INSERT INTO account (id, accountId, providerId, userId) VALUES ('new-link', 'subject', 'other-provider', 'owner')`);
      expect(() => db.run(`INSERT INTO account (id, accountId, providerId, userId) VALUES ('duplicate', 'subject', 'authentik', 'owner')`))
        .toThrow("UNIQUE constraint failed");
    } finally {
      db.close();
    }
  });

  test("refuses ambiguous links before modifying the old schema or data", async () => {
    const { db, directory } = await legacyDatabase();
    try {
      db.run(`INSERT INTO "user" (id, name, email) VALUES ('other', 'Other', 'other@example.test')`);
      db.run(`INSERT INTO account (id, accountId, providerId, issuer, userId)
        VALUES ('ambiguous', 'subject', 'authentik', 'different-issuer', 'other')`);
      const before = db.query("SELECT * FROM account ORDER BY id").all();
      await expect(runMigrations(db, directory)).rejects.toThrow("duplicate provider/account links");
      expect(db.query("SELECT * FROM account ORDER BY id").all()).toEqual(before);
      expect(db.query("PRAGMA table_info(account)").all()).toContainEqual(expect.objectContaining({ name: "issuer", notnull: 1 }));
      expect(db.query("SELECT name FROM _migrations WHERE name = ?").get(migration)).toBeNull();
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    } finally {
      db.close();
    }
  });

  test("accepts an admin session column already added by the auth schema tool", async () => {
    const { db, directory } = await legacyDatabase();
    try {
      const adminMigration = "135_auth_session_impersonation.sql";
      copyFileSync(join(import.meta.dir, "migrations", adminMigration), join(directory, adminMigration));
      db.run("ALTER TABLE session ADD COLUMN impersonatedBy TEXT");
      await runMigrations(db, directory);
      expect(db.query("SELECT name FROM _migrations WHERE name = ?").get(adminMigration)).toEqual({ name: adminMigration });
      expect(db.query("SELECT token FROM session").get()).toEqual({ token: "session-token" });
    } finally {
      db.close();
    }
  });
});
