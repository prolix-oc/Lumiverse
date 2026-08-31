import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../src/env";
import {
  ArchiveValidationError,
  MAX_COMPRESSED_BYTES,
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

  test("returns an opaque digest/identity proof for the import worker", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x10, 0x20]);
    const result = await persistUploadedArchive(
      "upload-user",
      streamChunks([bytes]),
      bytes.byteLength,
      "proof-job",
    );

    expect(result.archiveDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.byteCount).toBe(bytes.byteLength);
    expect(result.proof).toMatchObject({
      kind: "persisted-upload",
      archivePath: result.path,
      archiveDigest: result.archiveDigest,
      byteCount: result.byteCount,
    });
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
  test("rejects a declared compressed size cap plus one before reading the body", async () => {
    await expect(
      persistUploadedArchive(
        "upload-user",
        streamChunks([]),
        MAX_COMPRESSED_BYTES + 1,
        "oversized-job",
      ),
    ).rejects.toMatchObject({ code: "size" });
    expect(await Bun.file(join(workDir, "imports", "upload-user", "oversized-job", "archive.lvbak")).exists())
      .toBe(false);
  });

  test("cancels a client-aborted body, removes staging, and allows retry", async () => {
    const controller = new AbortController();
    const pendingBody = new ReadableStream<Uint8Array>({ start() {} });
    const pending = persistUploadedArchive(
      "upload-user",
      pendingBody,
      null,
      "aborted-job",
      {
        signal: controller.signal,
        wallDeadlineAt: Date.now() + 5_000,
        idleDeadlineMs: 1_000,
      },
    );
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "upload_aborted" });
    expect(await Bun.file(join(workDir, "imports", "upload-user", "aborted-job", "archive.lvbak")).exists())
      .toBe(false);

    const retry = await persistUploadedArchive(
      "upload-user",
      streamChunks([new Uint8Array([0x50, 0x4b, 0x03, 0x04])]),
      4,
      "aborted-job",
    );
    expect(await Bun.file(retry.path).bytes()).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
  });

  test("expires an idle slow-trickle body with a stable timeout and cleans staging", async () => {
    const slowBody = new ReadableStream<Uint8Array>({ start() {} });
    await expect(
      persistUploadedArchive(
        "upload-user",
        slowBody,
        null,
        "timeout-job",
        { wallDeadlineAt: Date.now() + 100, idleDeadlineMs: 10 },
      ),
    ).rejects.toMatchObject({ code: "upload_timeout" });
    expect(await Bun.file(join(workDir, "imports", "upload-user", "timeout-job", "archive.lvbak")).exists())
      .toBe(false);
  });
  test("enforces the absolute wall deadline even when the idle window is longer", async () => {
    const slowBody = new ReadableStream<Uint8Array>({ start() {} });
    await expect(
      persistUploadedArchive(
        "upload-user",
        slowBody,
        null,
        "wall-timeout-job",
        { wallDeadlineAt: Date.now() + 20, idleDeadlineMs: 1_000 },
      ),
    ).rejects.toMatchObject({ code: "upload_timeout" });
    expect(await Bun.file(join(workDir, "imports", "upload-user", "wall-timeout-job", "archive.lvbak")).exists())
      .toBe(false);
  });
});
