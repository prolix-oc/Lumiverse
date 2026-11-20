import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "lumiverse-owner-seed-"));
process.env.DATA_DIR = directory;
process.env.LUMIVERSE_BUNDLE_ID = "owner-seed-test";
delete process.env.OWNER_PASSWORD;
delete process.env.AUTH_BASE_URL;
const { initIdentity } = await import("../crypto/init");
const { hashPassword } = await import("../crypto/password");
const { writeOwnerCredentials } = await import("../crypto/credentials");
const { initDatabase, closeDatabase } = await import("../db/connection");
const { runMigrations } = await import("../db/migrate");
await initIdentity();
const db = initDatabase(":memory:");
await runMigrations(db);
const password = "synthetic-owner-seeding-password";
const hash = await hashPassword(password);
await writeOwnerCredentials(join(directory, "owner.credentials"), "ExistingOwner", hash);
const { seedOwner } = await import("./seed");
const { auth } = await import("./index");
afterAll(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

test("seeds a working owner once and preserves credentials across subsequent startups", async () => {
  await seedOwner();
  const account = db.query("SELECT id, accountId, userId, password FROM account WHERE providerId = 'credential'").get() as {
    id: string; accountId: string; userId: string; password: string;
  };
  expect(account.password).toBe(hash);
  expect(account.accountId).toBe(account.userId);
  await seedOwner();
  expect(db.query("SELECT id, accountId, userId, password FROM account WHERE providerId = 'credential'").get()).toEqual(account);
  expect(db.query('SELECT COUNT(*) AS count FROM "user"').get()).toEqual({ count: 1 });
  const response = await auth.handler(new Request("http://localhost:7860/api/auth/sign-in/username", {
    method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost:7860" },
    body: JSON.stringify({ username: "existingowner", password }),
  }));
  expect(response.status).toBe(200);
  expect((await response.json()).user).toMatchObject({ id: account.userId, role: "owner" });
});
