import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunCmd } from "../utils/bun-cmd";

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(path)).toBe(true);
}

async function startup(options: { existing?: boolean; locked?: boolean; persistent?: boolean; rejectUpdate?: boolean }) {
  const directory = mkdtempSync(join(tmpdir(), "lumiverse-auth-startup-"));
  const db = new Database(join(directory, "lumiverse.db"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let release: ReturnType<typeof setTimeout> | undefined;
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text());
    if (options.existing) {
      db.run(`INSERT INTO "oauthResource" (id, identifier, name, disabled, accessTokenTtl, allowedScopes)
        VALUES ('desktop', 'urn:lumiverse:desktop-api', 'Stale policy', 1, 1, '["stale"]')`);
    }
    if (options.rejectUpdate) {
      db.exec(`CREATE TRIGGER reject_oauth_update BEFORE UPDATE ON "oauthResource"
        BEGIN SELECT RAISE(ABORT, 'auth seed rejected'); END`);
    }
    const spawned = Bun.spawn({
      cmd: bunCmd("--no-env-file", join(import.meta.dir, "test-fixtures/startup.ts"), directory, options.persistent ? "20" : "5000"),
      env: { ...process.env, DATA_DIR: directory, AUTH_BASE_URL: "", AUTH_SECRET: "auth-startup-regression-test-secret-value" },
      stdout: "ignore", stderr: "pipe",
    });
    child = spawned;
    const stderr = new Response(spawned.stderr).text();
    await waitForFile(join(directory, "ready"));
    if (options.locked) {
      db.exec("BEGIN IMMEDIATE");
      // Release on the parent event loop while the child's synchronous SQLite
      // call waits. Same-thread timers cannot release a blocked SQLite writer.
      if (!options.persistent) release = setTimeout(() => db.exec("ROLLBACK"), 350);
    }
    writeFileSync(join(directory, "start"), "start");
    await waitForFile(join(directory, "result.json"));
    expect(await child.exited, await stderr).toBe(0);
    return { ...JSON.parse(readFileSync(join(directory, "result.json"), "utf8")), directory };
  } finally {
    if (release) clearTimeout(release);
    if (db.inTransaction) db.exec("ROLLBACK");
    if (child) { child.kill(); await child.exited; }
    db.close(true);
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("authentication startup readiness", () => {
  for (const existing of [false, true]) {
    test(`awaiting the auth import completes the ${existing ? "existing resource overwrite" : "first resource insert"} despite a competing writer`, async () => {
      const result = await startup({ existing, locked: true });
      expect(result.ok).toBe(true);
      expect(result.resource).toEqual({
        name: "Lumiverse Desktop API", disabled: 0, accessTokenTtl: 300,
        allowedScopes: '["openid","profile","offline_access","desktop:instance-status:read"]',
      });
      expect(result.pending).toEqual({ count: 6 });
    });
  }

  test("a persistent writer rejects the import with a database path and the original SQLite cause", async () => {
    const result = await startup({ existing: true, locked: true, persistent: true });
    expect(result.ok).toBe(false);
    expect(result.causeCode).toBe("SQLITE_BUSY");
    expect(result.message).toContain(join(result.directory, "lumiverse.db"));
    expect(result.message).toContain("Close other Lumiverse instances or database tools");
  });

  test("other initialization errors reject the import unchanged", async () => {
    const result = await startup({ existing: true, rejectUpdate: true });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SQLITE_CONSTRAINT_TRIGGER");
    expect(result.message).toBe("auth seed rejected");
    expect(result.causeCode).toBeUndefined();
  });
});
