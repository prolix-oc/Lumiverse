import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../src/env";
import {
  ArchiveValidationError,
  persistUploadedArchive,
} from "../src/services/user-data/import.service";

function streamChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

describe("user-data import upload staging", () => {
  let workDir: string;
  let originalDataDir: string;

  beforeEach(() => {
    originalDataDir = env.dataDir;
    workDir = mkdtempSync(join(tmpdir(), "lvbak-upload-test-"));
    env.dataDir = workDir;
  });

  afterEach(() => {
    env.dataDir = originalDataDir;
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  });

  test("stages a raw archive without losing bytes when ZIP magic spans chunks", async () => {
    const chunks = [
      new Uint8Array([0x50]),
      new Uint8Array([0x4b, 0x03]),
      new Uint8Array([0x04, 0xaa, 0xbb]),
      new Uint8Array([0xcc, 0xdd, 0xee]),
    ];

    const result = await persistUploadedArchive(
      "upload-user",
      streamChunks(chunks),
      9,
    );

    expect(await Bun.file(result.path).bytes()).toEqual(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xaa, 0xbb, 0xcc, 0xdd, 0xee]),
    );
  });

  test("rejects invalid magic and removes the partial archive", async () => {
    let caught: unknown;
    try {
      await persistUploadedArchive(
        "upload-user",
        streamChunks([new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04])]),
        5,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ArchiveValidationError);
    expect((caught as ArchiveValidationError).code).toBe("not_zip");

    const importsDir = join(workDir, "imports", "upload-user");
    const archivePaths = new Bun.Glob("**/archive.lvbak").scanSync({
      cwd: importsDir,
      absolute: true,
      onlyFiles: true,
    });
    expect([...archivePaths]).toHaveLength(0);
  });
});
