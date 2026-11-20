import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "./migrate";

const MIGRATION_113 = "113_better_auth_1_7_accounts.sql";
let temporaryMigrationDirs: string[] = [];

function makeMigrationDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "lumiverse-auth-1-7-test-"));
  temporaryMigrationDirs.push(directory);
  copyFileSync(
    join(import.meta.dir, "migrations", MIGRATION_113),
    join(directory, MIGRATION_113),
  );
  return directory;
}

function makeLegacyDatabase(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`
    CREATE TABLE _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    INSERT INTO _migrations (name) VALUES ('112_weaver_session_taste.sql');

    CREATE TABLE "user" (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE
    );

    CREATE TABLE "account" (
      id TEXT PRIMARY KEY NOT NULL,
      accountId TEXT NOT NULL,
      providerId TEXT NOT NULL,
      userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      accessToken TEXT,
      refreshToken TEXT,
      idToken TEXT,
      accessTokenExpiresAt INTEGER,
      refreshTokenExpiresAt INTEGER,
      scope TEXT,
      password TEXT,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
      updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX idx_account_provider_account ON account(providerId, accountId);
    CREATE INDEX idx_account_userId ON account(userId);
    CREATE INDEX idx_account_user_provider ON account(userId, providerId);
  `);
  return db;
}

afterEach(() => {
  for (const directory of temporaryMigrationDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryMigrationDirs = [];
});

describe("113 Better Auth 1.7 account identity migration", () => {
  test("backfills stable credential and provider-scoped OAuth issuers", async () => {
    const db = makeLegacyDatabase();
    try {
      db.run(`
        INSERT INTO "user" (id, name, email) VALUES
          ('owner-id', 'Owner', 'owner@lumiverse.local'),
          ('member-id', 'Member', 'member@lumiverse.local');
        INSERT INTO "account" (
          id, accountId, providerId, userId, password, accessToken, createdAt, updatedAt
        ) VALUES
          ('credential-row', 'legacy-credential-key', 'credential', 'owner-id', 'hash', NULL, 10, 11),
          ('sso-row', 'provider-subject', 'authentik', 'member-id', NULL, 'token', 12, 13);
      `);

      await runMigrations(db, makeMigrationDir());

      expect(db.query(
        "SELECT id, accountId, providerId, issuer, userId, password, accessToken, createdAt, updatedAt FROM account ORDER BY id",
      ).all()).toEqual([
        {
          id: "credential-row",
          accountId: "owner-id",
          providerId: "credential",
          issuer: "local:credential",
          userId: "owner-id",
          password: "hash",
          accessToken: null,
          createdAt: 10,
          updatedAt: 11,
        },
        {
          id: "sso-row",
          accountId: "provider-subject",
          providerId: "authentik",
          issuer: "local:oauth:authentik",
          userId: "member-id",
          password: null,
          accessToken: "token",
          createdAt: 12,
          updatedAt: 13,
        },
      ]);

      const issuer = db.query("PRAGMA table_info('account')").all()
        .find((column: any) => column.name === "issuer") as { notnull: number } | undefined;
      expect(issuer?.notnull).toBe(1);
      expect(db.query("PRAGMA index_list('account')").all()).toContainEqual(
        expect.objectContaining({ name: "account_issuer_accountId_uidx", unique: 1 }),
      );
      expect(db.query("SELECT name FROM _migrations WHERE name = ?").get(MIGRATION_113)).toEqual({
        name: MIGRATION_113,
      });
    } finally {
      db.close();
    }
  });

  test("rejects projected identity collisions without replacing the legacy table", async () => {
    const db = makeLegacyDatabase();
    try {
      db.run(`
        INSERT INTO "user" (id, name, email) VALUES
          ('user-a', 'A', 'a@example.test'),
          ('user-b', 'B', 'b@example.test');
        INSERT INTO "account" (id, accountId, providerId, userId) VALUES
          ('row-a', 'shared-subject', 'authentik', 'user-a'),
          ('row-b', 'shared-subject', 'authentik', 'user-b');
      `);

      await expect(runMigrations(db, makeMigrationDir())).rejects.toThrow(
        /Better Auth 1\.7 account identity collision/,
      );

      expect(
        (db.query("PRAGMA table_info('account')").all() as Array<{ name: string }>).some(
          (column) => column.name === "issuer",
        ),
      ).toBe(false);
      expect(db.query("SELECT COUNT(*) AS count FROM account").get()).toEqual({ count: 2 });
      expect(db.query("SELECT name FROM _migrations WHERE name = ?").get(MIGRATION_113)).toBeNull();
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    } finally {
      db.close();
    }
  });
});
