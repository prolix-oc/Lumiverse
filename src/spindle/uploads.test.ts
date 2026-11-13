import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../env";
import {
  UPLOAD_READ_CHUNK_BYTES,
  appendUpload,
  createUpload,
  deleteUpload,
  getMaxUploadBytes,
  readUploadChunk,
} from "./uploads";

const originalDataDir = env.dataDir;
let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lumiverse-upload-chunk-test-"));
  env.dataDir = dataDir;
});

afterEach(() => {
  env.dataDir = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("staged upload chunk reads", () => {
  test("requires chunked reads for the 100 GiB cap", () => {
    expect(getMaxUploadBytes()).toBe(1024 * 1024 * 1024);
    expect(getMaxUploadBytes(true)).toBe(100 * 1024 * 1024 * 1024);
  });

  test("reads a completed upload in bounded chunks", async () => {
    const bytes = new Uint8Array(UPLOAD_READ_CHUNK_BYTES + 3);
    bytes[0] = 1;
    bytes[UPLOAD_READ_CHUNK_BYTES - 1] = 2;
    bytes[UPLOAD_READ_CHUNK_BYTES] = 3;
    bytes[bytes.length - 1] = 4;
    const upload = createUpload({
      ownerUserId: "user-1",
      extensionIdentifier: "extension.test",
      fileName: "large.charx",
      declaredSize: bytes.length,
    });
    await appendUpload(upload.uploadId, new Blob([bytes]).stream(), 0);

    const first = await readUploadChunk(upload.uploadId, 0);
    const second = await readUploadChunk(upload.uploadId, first.byteLength);

    expect(first.byteLength).toBe(UPLOAD_READ_CHUNK_BYTES);
    expect([first[0], first[first.length - 1]]).toEqual([1, 2]);
    expect(Array.from(second)).toEqual([3, 0, 4]);
    deleteUpload(upload.uploadId);
  });

  test("rejects incomplete uploads and invalid offsets", async () => {
    const upload = createUpload({
      ownerUserId: "user-1",
      extensionIdentifier: "extension.test",
      fileName: "partial.charx",
      declaredSize: 2,
    });
    await appendUpload(upload.uploadId, new Blob([new Uint8Array([1])]).stream(), 0);
    await expect(readUploadChunk(upload.uploadId, 0)).rejects.toThrow("upload is incomplete");

    await appendUpload(upload.uploadId, new Blob([new Uint8Array([2])]).stream(), 1);
    await expect(readUploadChunk(upload.uploadId, -1)).rejects.toThrow("invalid upload offset");
    await expect(readUploadChunk(upload.uploadId, 3)).rejects.toThrow("invalid upload offset");
    deleteUpload(upload.uploadId);
  });

  test("does not append beyond the declared upload size", async () => {
    const upload = createUpload({
      ownerUserId: "user-1",
      extensionIdentifier: "extension.test",
      fileName: "bounded.bin",
      declaredSize: 1,
    });
    await expect(
      appendUpload(upload.uploadId, new Blob([new Uint8Array([1, 2])]).stream(), 0),
    ).rejects.toThrow("upload exceeds declared size");
    deleteUpload(upload.uploadId);
  });
});
