import { beforeEach, afterEach, describe, expect, mock, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";

// Deterministic AES-256 key so putSecret works without a real identity file.
mock.module("../crypto/init", () => ({
  getEncryptionKeyBytes: () => new Uint8Array(32).fill(7),
}));

const { putSecret, SYSTEM_SECRET_PRINCIPAL, SYSTEM_SECRET_PRINCIPAL_EMAIL } = await import(
  "./secrets.service"
);
const { getFirstUserId } = await import("../auth/seed");

async function initBaselineDb(): Promise<void> {
  closeDatabase();
  initDatabase(":memory:");
  const baseline = await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text();
  getDb().run(baseline);
}

function getSystemRow(): { createdAt: number; updatedAt: number } | null {
  return getDb()
    .query('SELECT createdAt, updatedAt FROM "user" WHERE id = ?')
    .get(SYSTEM_SECRET_PRINCIPAL) as { createdAt: number; updatedAt: number } | null;
}

beforeEach(async () => {
  await initBaselineDb();
});

afterEach(() => {
  closeDatabase();
});

describe("system principal provisioning", () => {
  test("putSecret materializes the system principal row with a real timestamp", async () => {
    const before = Math.floor(Date.now() / 1000);
    await putSecret(SYSTEM_SECRET_PRINCIPAL, "extension:inst-a:key1", "sk-live");
    const after = Math.floor(Date.now() / 1000);

    const row = getSystemRow();
    expect(row).not.toBeNull();
    // A zero/epoch timestamp would sort the synthetic row before every real
    // user in ORDER BY createdAt ASC consumers (owner seeding, migrations).
    expect(row!.createdAt).toBeGreaterThanOrEqual(before);
    expect(row!.createdAt).toBeLessThanOrEqual(after);
    expect(row!.updatedAt).toBeGreaterThanOrEqual(before);
    // Even as the only user row, the synthetic principal is not resolvable
    // as the first user.
    expect(getFirstUserId()).toBeNull();
  });

  test("legacy rows created with createdAt = 0 are repaired to a real timestamp", async () => {
    getDb()
      .query(
        `INSERT INTO "user" (id, name, email, emailVerified, role, createdAt, updatedAt)
         VALUES (?, 'System', ?, 1, 'system', 0, 0)`,
      )
      .run(SYSTEM_SECRET_PRINCIPAL, SYSTEM_SECRET_PRINCIPAL_EMAIL);

    await putSecret(SYSTEM_SECRET_PRINCIPAL, "extension:inst-a:key2", "v");

    const row = getSystemRow();
    expect(row!.createdAt).toBeGreaterThan(0);
    expect(row!.updatedAt).toBeGreaterThan(0);
  });

  test("a squatter holding the reserved email fails loudly instead of silent skip + FK error", async () => {
    // Mirrors the seed pattern ${username}@lumiverse.local for username
    // "system": an unrelated account already owns the reserved email.
    getDb()
      .query(
        `INSERT INTO "user" (id, name, email, emailVerified, username, role, createdAt, updatedAt)
         VALUES ('squatter-id', 'system', ?, 1, 'system', 'user', 5, 5)`,
      )
      .run(SYSTEM_SECRET_PRINCIPAL_EMAIL);

    await expect(
      putSecret(SYSTEM_SECRET_PRINCIPAL, "extension:inst-a:key3", "v"),
    ).rejects.toThrow(/held by account "squatter-id"/);

    // No secret row was persisted against a dangling FK target.
    expect(
      getDb().query("SELECT COUNT(*) as count FROM secrets WHERE user_id = ?").get(SYSTEM_SECRET_PRINCIPAL),
    ).toEqual({ count: 0 });
  });
});

describe("first-user resolution excludes the system principal", () => {
  test("getFirstUserId never resolves __system__ even when it sorts earliest", () => {
    // Simulate the pre-fix legacy shape: system row with createdAt = 0,
    // older than every real account.
    getDb()
      .query(
        `INSERT INTO "user" (id, name, email, emailVerified, role, createdAt, updatedAt)
         VALUES (?, 'System', ?, 1, 'system', 0, 0)`,
      )
      .run(SYSTEM_SECRET_PRINCIPAL, SYSTEM_SECRET_PRINCIPAL_EMAIL);
    getDb()
      .query(
        `INSERT INTO "user" (id, name, email, emailVerified, role, createdAt, updatedAt)
         VALUES ('owner-real', 'Owner', 'owner@lumiverse.local', 1, 'owner', 100, 100)`,
      )
      .run();

    // This mirrors what runDockerSTMigration / seedOwner fallback /
    // backfillDefaultPresets rely on: first REAL user, never __system__.
    expect(getFirstUserId()).toBe("owner-real");
  });
});
