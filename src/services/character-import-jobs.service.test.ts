import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CharacterImportJobError,
  CharacterImportJobManager,
  MAX_CHARACTER_IMPORT_FILE_BYTES,
  type CharacterImportJobSnapshot,
  type StagedCharacterFile,
} from "./character-import-jobs.service";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lumiverse-character-import-"));
  roots.push(root);
  return root;
}

function body(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index++]));
    },
  });
}

async function waitForTerminal(
  manager: CharacterImportJobManager,
  userId: string,
  jobId: string,
): Promise<CharacterImportJobSnapshot> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = manager.get(userId, jobId)!;
    if (["complete", "cancelled", "error"].includes(snapshot.status)) return snapshot;
    await Bun.sleep(5);
  }
  throw new Error("character import job did not finish");
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("CharacterImportJobManager", () => {
  test("streams files to staging, processes them in index order, and cleans the job directory", async () => {
    const rootDir = tempRoot();
    const processed: Array<{ index: number; filename: string; content: string }> = [];
    const changes: Array<{ userId: string; imported: number; jobId: string }> = [];
    const manager = new CharacterImportJobManager({
      rootDir,
      async processFile(userId, file) {
        expect(userId).toBe("user-1");
        processed.push({
          index: file.index,
          filename: file.filename,
          content: await Bun.file(file.path).text(),
        });
        return { filename: file.filename, success: true };
      },
      onLibraryChanged(userId, imported, jobId) {
        changes.push({ userId, imported, jobId });
      },
    });

    const created = manager.create("user-1", 2, false);
    await manager.upload("user-1", created.jobId, 1, "../second.png", "image/png", body("sec", "ond"), 6);
    await manager.upload("user-1", created.jobId, 0, "first.png", "image/png", body("first"), 5);

    const started = manager.start("user-1", created.jobId);
    expect(started.status).toBe("processing");
    const complete = await waitForTerminal(manager, "user-1", created.jobId);

    expect(complete.status).toBe("complete");
    expect(complete.summary).toEqual({ total: 2, imported: 2, skipped: 0, failed: 0 });
    expect(processed).toEqual([
      { index: 0, filename: "first.png", content: "first" },
      { index: 1, filename: "second.png", content: "second" },
    ]);
    expect(changes).toEqual([{ userId: "user-1", imported: 2, jobId: created.jobId }]);
    expect(existsSync(join(rootDir, created.jobId))).toBe(false);
  });

  test("rejects oversized and duplicate uploads before processing", async () => {
    const manager = new CharacterImportJobManager({
      rootDir: tempRoot(),
      async processFile(_userId: string, file: StagedCharacterFile) {
        return { filename: file.filename, success: true };
      },
    });
    const created = manager.create("user-1", 1, false);

    await expect(manager.upload(
      "user-1",
      created.jobId,
      0,
      "large.png",
      "image/png",
      body("x"),
      MAX_CHARACTER_IMPORT_FILE_BYTES + 1,
    )).rejects.toMatchObject({ status: 413, code: "file_too_large" });

    await manager.upload("user-1", created.jobId, 0, "card.png", "image/png", body("ok"), 2);
    await expect(manager.upload(
      "user-1",
      created.jobId,
      0,
      "again.png",
      "image/png",
      body("again"),
      5,
    )).rejects.toMatchObject({ status: 409, code: "file_already_uploaded" });
  });

  test("cancels between files and preserves completed results", async () => {
    const rootDir = tempRoot();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const visited: number[] = [];
    const manager = new CharacterImportJobManager({
      rootDir,
      async processFile(_userId, file) {
        visited.push(file.index);
        if (file.index === 0) await firstBlocked;
        return { filename: file.filename, success: true };
      },
    });
    const created = manager.create("user-1", 2, false);
    await manager.upload("user-1", created.jobId, 0, "one.png", "image/png", body("one"), 3);
    await manager.upload("user-1", created.jobId, 1, "two.png", "image/png", body("two"), 3);
    manager.start("user-1", created.jobId);

    await Bun.sleep(5);
    expect(manager.cancel("user-1", created.jobId).status).toBe("processing");
    releaseFirst();
    const cancelled = await waitForTerminal(manager, "user-1", created.jobId);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.processed).toBe(1);
    expect(visited).toEqual([0]);
    expect(existsSync(join(rootDir, created.jobId))).toBe(false);
  });

  test("scopes job access to the creating user", async () => {
    const manager = new CharacterImportJobManager({
      rootDir: tempRoot(),
      async processFile(_userId: string, file: StagedCharacterFile) {
        return { filename: file.filename, success: true };
      },
    });
    const created = manager.create("user-1", 1, false);
    expect(manager.get("user-2", created.jobId)).toBeNull();
    expect(() => manager.cancel("user-2", created.jobId)).toThrow(CharacterImportJobError);
  });
});
