import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { env } from "../env";
import { saveStMigrationCheckpoint } from "./st-checkpoint";
import {
  canUseIsolatedStMigration,
  executeMigration,
  getLastMigration,
  resetIsolatedStMigrationState,
  startStMigration,
  type IsolatedLaunchDeps,
  type IsolatedMigrationChild,
  type IsolatedSpawnOptions,
} from "./st-migration.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { MigrationScope } from "./st-types";

const USER_ID = "st-migration-host-user";
const originalDataDir = env.dataDir;
let workDir = "";

function allOffScope(overrides: Partial<MigrationScope> = {}): MigrationScope {
  return {
    characters: false,
    worldBooks: false,
    personas: false,
    chats: false,
    groupChats: false,
    connections: false,
    ...overrides,
  };
}

function spawnDeps(spawn: IsolatedLaunchDeps["spawn"]): IsolatedLaunchDeps {
  return { spawn, env: { LUMIVERSE_ST_MIGRATION_SUBPROCESS: "true" } };
}

beforeEach(async () => {
  resetIsolatedStMigrationState();
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
  workDir = mkdtempSync(join(tmpdir(), "lumiverse-st-host-"));
  env.dataDir = join(workDir, "lumiverse-data");
  mkdirSync(join(workDir, "st-data", "characters"), { recursive: true });
  writeFileSync(join(workDir, "st-data", "characters", "placeholder.txt"), "not-a-card");
});

afterEach(() => {
  resetIsolatedStMigrationState();
  closeDatabase();
  env.dataDir = originalDataDir;
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("canUseIsolatedStMigration", () => {
  test("defaults to enabled", () => {
    expect(canUseIsolatedStMigration({})).toBe(true);
  });

  test("turns off when explicitly false", () => {
    expect(canUseIsolatedStMigration({ LUMIVERSE_ST_MIGRATION_SUBPROCESS: "false" })).toBe(false);
  });
});

describe("startStMigration isolation", () => {
  test("falls back in-process when isolated spawn fails to become ready", async () => {
    const dataDir = join(workDir, "st-data");
    const spawn = (options: IsolatedSpawnOptions): IsolatedMigrationChild => {
      const child: IsolatedMigrationChild = {
        send() {},
        kill() {},
      };
      queueMicrotask(() => options.onExit(child, 1, null, new Error("spawn failed")));
      return child;
    };

    await startStMigration(
      "mig-fallback",
      USER_ID,
      USER_ID,
      dataDir,
      allOffScope(),
      { type: "local" },
      undefined,
      spawnDeps(spawn),
    );
    const last = getLastMigration();
    expect(last?.phase).toBe("completed");
    expect(last?.error).toBeNull();
  });

  test("relays isolated IPC progress and completion without in-process scan", async () => {
    const dataDir = join(workDir, "missing-on-purpose");
    const spawn = (options: IsolatedSpawnOptions): IsolatedMigrationChild => {
      const child: IsolatedMigrationChild = {
        send() {
          queueMicrotask(() => {
            options.ipc({ type: "progress", phase: "characters", label: "characters", current: 0, total: 0 });
            options.ipc({
              type: "done",
              results: { characters: { imported: 3, skipped: 1, failed: 0 } },
              importedCharacterCount: 3,
              characterImportAttempted: true,
              durationMs: 42,
            });
          });
        },
        kill() {},
      };
      queueMicrotask(() => options.ipc({ type: "ready" }));
      return child;
    };

    await startStMigration(
      "mig-ipc",
      USER_ID,
      USER_ID,
      dataDir,
      allOffScope({ characters: true }),
      { type: "local" },
      undefined,
      spawnDeps(spawn),
    );
    const last = getLastMigration();
    expect(last?.migrationId).toBe("mig-ipc");
    expect(last?.phase).toBe("completed");
    expect(last?.results).toEqual({ characters: { imported: 3, skipped: 1, failed: 0 } });
  });

  test("relays isolated thumbnailQueue IPC onto the host event bus", async () => {
    const received = new Promise<Record<string, number>>((resolve) => {
      const off = eventBus.on(EventType.IMAGE_THUMBNAIL_QUEUE, (message) => {
        const payload = message.payload;
        if (!payload || typeof payload !== "object") return;
        const record = payload as Record<string, number>;
        if (record.processed === 12 && record.remaining === 4 && record.total === 16) {
          off();
          resolve(record);
        }
      });
    });
    const spawn = (options: IsolatedSpawnOptions): IsolatedMigrationChild => {
      const child: IsolatedMigrationChild = {
        send() {
          queueMicrotask(() => {
            options.ipc({
              type: "thumbnailQueue",
              processed: 12,
              remaining: 4,
              total: 16,
              active: 2,
              queued: 2,
            });
            options.ipc({
              type: "done",
              results: {},
              importedCharacterCount: 0,
              characterImportAttempted: false,
              durationMs: 5,
            });
          });
        },
        kill() {},
      };
      queueMicrotask(() => options.ipc({ type: "ready" }));
      return child;
    };

    await startStMigration(
      "mig-thumbs",
      USER_ID,
      USER_ID,
      join(workDir, "st-data"),
      allOffScope(),
      { type: "local" },
      undefined,
      spawnDeps(spawn),
    );
    await expect(received).resolves.toMatchObject({ processed: 12, remaining: 4, total: 16 });
  });
});

describe("runStMigrationPipeline checkpoints", () => {
  test("resumes a completed character phase without reimporting cards", async () => {
    const dataDir = join(workDir, "st-data");
    mkdirSync(join(dataDir, "characters"), { recursive: true });
    writeFileSync(join(dataDir, "characters", "alice.png"), "not-a-real-png");
    saveStMigrationCheckpoint(USER_ID, {
      version: 1,
      migrationId: "resume-1",
      dataDir,
      scope: allOffScope({ characters: true }),
      completedPhases: ["characters"],
      results: { characters: { imported: 2, skipped: 0, failed: 0 } },
      updatedAt: Date.now(),
    });

    await executeMigration("resume-1", USER_ID, USER_ID, dataDir, allOffScope({ characters: true }));
    const last = getLastMigration();
    expect(last?.results?.characters).toEqual({ imported: 2, skipped: 0, failed: 0 });
    expect(getDb().query("SELECT COUNT(*) AS count FROM characters").get()).toEqual({ count: 0 });
  });
});
