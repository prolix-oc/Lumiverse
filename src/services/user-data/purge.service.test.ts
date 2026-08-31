import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDatabase, initDatabase } from "../../db/connection";
import { env } from "../../env";
import { reconcilePurgeCleanupIntents } from "./purge.service";

const baselineSql = await Bun.file(join(import.meta.dir, "../../db/baseline.sql")).text();
const originalDataDir = env.dataDir;
let dataRoot = "";

function userDigest(userId: string): string {
  return createHash("sha256").update(userId).digest("hex");
}

function writeIntent(userId: string): void {
  const intentDir = join(dataRoot, ".purge-intents");
  mkdirSync(intentDir, { recursive: true });
  writeFileSync(join(intentDir, `${userDigest(userId)}.json`), JSON.stringify({ version: 1, userDigest: userDigest(userId) }));
}

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "lumiverse-purge-recovery-"));
  env.dataDir = dataRoot;
  const db = initDatabase(":memory:");
  db.run(baselineSql);
});

afterEach(() => {
  closeDatabase();
  env.dataDir = originalDataDir;
  rmSync(dataRoot, { recursive: true, force: true });
});

describe("durable account artifact purge recovery", () => {
  test("removes an unpublished operational blob after a post-SQL crash", async () => {
    const userId = "purge-user";
    const userRoot = join(dataRoot, "agent-artifacts", userId);
    mkdirSync(userRoot, { recursive: true });
    writeFileSync(join(userRoot, "unpublished.blob"), "private bytes");
    writeIntent(userId);

    reconcilePurgeCleanupIntents();

    expect(await Bun.file(userRoot).exists()).toBe(false);
    expect(await Bun.file(join(dataRoot, ".purge-intents", `${userDigest(userId)}.json`)).exists()).toBe(false);
  });

  test("retries bytes left after an individual unlink failure", async () => {
    const userId = "purge-retry";
    const userRoot = join(dataRoot, "agent-artifacts", userId);
    mkdirSync(userRoot, { recursive: true });
    writeFileSync(join(userRoot, "failed-first-pass.blob"), "private bytes");
    writeIntent(userId);

    reconcilePurgeCleanupIntents();

    expect(await Bun.file(join(userRoot, "failed-first-pass.blob")).exists()).toBe(false);
  });

  test("does not touch a foreign user root without its own intent", async () => {
    const foreignRoot = join(dataRoot, "agent-artifacts", "foreign-user");
    mkdirSync(foreignRoot, { recursive: true });
    const foreignFile = join(foreignRoot, "shared-user.blob");
    writeFileSync(foreignFile, "foreign bytes");
    writeIntent("purge-owner");

    reconcilePurgeCleanupIntents();

    expect(await Bun.file(foreignFile).exists()).toBe(true);
  });

  test("fails closed on a symlinked artifact user root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "lumiverse-purge-outside-"));
    const parent = join(dataRoot, "agent-artifacts");
    mkdirSync(parent, { recursive: true });
    symlinkSync(outside, join(parent, "purge-symlink"), "dir");
    const outsideFile = join(outside, "must-survive");
    writeFileSync(outsideFile, "outside bytes");
    writeIntent("purge-symlink");

    expect(() => reconcilePurgeCleanupIntents()).toThrow(/symlink/i);
    expect(await Bun.file(outsideFile).exists()).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });
  test("fails closed on a dangling artifact user-root symlink", () => {
    const parent = join(dataRoot, "agent-artifacts");
    mkdirSync(parent, { recursive: true });
    symlinkSync(join(dataRoot, "missing-artifact-target"), join(parent, "purge-dangling"), "dir");
    writeIntent("purge-dangling");

    expect(() => reconcilePurgeCleanupIntents()).toThrow(/symlink/i);
  });


  test("fails closed on a corrupt intent", () => {
    const intentDir = join(dataRoot, ".purge-intents");
    mkdirSync(intentDir, { recursive: true });
    writeFileSync(join(intentDir, `${"a".repeat(64)}.json`), "not-json");

    expect(() => reconcilePurgeCleanupIntents()).toThrow(/corrupt/i);
  });
});
