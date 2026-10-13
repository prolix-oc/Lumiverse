import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, open, readdir, rm, stat, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { env } from "../env";
import { WorkerHostFilesApi } from "./worker-host-files-api";
import {
  SPINDLE_FILE_CHUNK_BYTES as FILE_CHUNK_BYTES,
  SPINDLE_FILE_MAX_BYTES as FILE_MAX_BYTES,
  SPINDLE_FILE_TTL_MS as FILE_TTL_MS,
  type SpindleFileRef,
} from "lumiverse-spindle-types";
import { getStagedFile } from "./files";
import { appendUpload, createUpload, deleteUpload } from "./uploads";
import { Hono } from "hono";
import { spindleFilesRoutes } from "../routes/spindle-files.routes";

const originalDataDir = env.dataDir;
const originalFetch = globalThis.fetch;
let directory: string;
let apis: WorkerHostFilesApi[];
let permitted = true;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "spindle-files-test-"));
  env.dataDir = directory;
  apis = [];
  permitted = true;
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const api of apis) await api.dispose();
  env.dataDir = originalDataDir;
  await rm(directory, { recursive: true, force: true });
});

function client(extensionId = "extension-a", userId = "alice", operator = false) {
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<any>>>();
  const api = new WorkerHostFilesApi({
    extensionId, identifier: extensionId,
    hasPermission: () => permitted,
    resolveEffectiveUserId: requested => operator ? requested : userId,
    enforceScopedUser: requested => { if (!operator && requested !== userId) throw new Error("User scope mismatch"); },
    postResponse: message => {
      const response = pending.get(message.requestId)!;
      pending.delete(message.requestId);
      if (message.error) response.reject(new Error(message.error));
      else response.resolve(message.result);
    },
  });
  apis.push(api);
  const start = (message: Record<string, unknown>) => {
    const requestId = crypto.randomUUID();
    const response = Promise.withResolvers<any>();
    pending.set(requestId, response);
    api.dispatch({ ...message, type: message.type as string, requestId });
    return { requestId, result: response.promise };
  };
  return { api, start, call: (message: Record<string, unknown>) => start(message).result };
}
async function staged(c: ReturnType<typeof client>, bytes: Uint8Array, fileName = "data.bin"): Promise<SpindleFileRef> {
  const ref = await c.call({ type: "files_create", input: { fileName, size: bytes.length } });
  for (let offset = 0; offset < bytes.length; offset += FILE_CHUNK_BYTES) {
    await c.call({ type: "files_write_chunk", fileId: ref.fileId, offset, data: bytes.slice(offset, offset + FILE_CHUNK_BYTES) });
  }
  return c.call({ type: "files_finish", fileId: ref.fileId });
}

test("writes and reads bounded chunks, rejects invalid writes and incomplete downloads", async () => {
  const c = client();
  const ref = await c.call({ type: "files_create", input: { fileName: "large.bin", size: FILE_CHUNK_BYTES + 3 } });
  await expect(c.call({ type: "files_download_url", fileId: ref.fileId })).rejects.toThrow("incomplete");
  await expect(c.call({ type: "files_finish", fileId: ref.fileId })).rejects.toThrow();
  await expect(c.call({ type: "files_write_chunk", fileId: ref.fileId, offset: 0, data: new Uint8Array(FILE_CHUNK_BYTES + 1) })).rejects.toThrow("Chunk");
  const first = new Uint8Array(FILE_CHUNK_BYTES).fill(0xa5);
  expect(await c.call({ type: "files_write_chunk", fileId: ref.fileId, offset: 0, data: first })).toBe(FILE_CHUNK_BYTES);
  await expect(c.call({ type: "files_write_chunk", fileId: ref.fileId, offset: 0, data: new Uint8Array([0]) })).rejects.toThrow("Offset");
  await expect(c.call({ type: "files_finish", fileId: ref.fileId })).rejects.toThrow("size");
  await c.call({ type: "files_write_chunk", fileId: ref.fileId, offset: first.length, data: new Uint8Array([0, 128, 255]) });
  expect((await c.call({ type: "files_finish", fileId: ref.fileId })).size).toBe(FILE_CHUNK_BYTES + 3);
  const chunk = await c.call({ type: "files_read_chunk", source: { fileId: ref.fileId }, offset: 0 });
  expect(chunk.data).toEqual(first);
  expect(chunk.eof).toBe(false);
  expect(await c.call({ type: "files_read_chunk", source: { fileId: ref.fileId }, offset: chunk.data.length })).toMatchObject({ data: new Uint8Array([0, 128, 255]), eof: true });
  await expect(c.call({ type: "files_read_chunk", source: { fileId: ref.fileId }, offset: -1 })).rejects.toThrow("offset");
  const empty = await staged(c, new Uint8Array());
  expect(await c.call({ type: "files_read_chunk", source: { fileId: empty.fileId }, offset: 0 })).toMatchObject({ size: 0, eof: true });
});

test("isolates files by installation, worker lifetime, and user", async () => {
  const alice = client();
  const ref = await staged(alice, new Uint8Array([1]));
  for (const foreign of [client("extension-b"), client("extension-a", "bob"), client()]) {
    await expect(foreign.call({ type: "files_read_chunk", source: { fileId: ref.fileId }, offset: 0 })).rejects.toThrow("not found");
    expect(await foreign.call({ type: "files_delete", fileId: ref.fileId })).toBe(false);
  }
  const operator = client("operator", "", true);
  await expect(operator.call({ type: "files_create", input: { fileName: "x", size: 1 } })).rejects.toThrow("userId is required");
  const own = await operator.call({ type: "files_create", input: { fileName: "x", size: 0, userId: "alice" } });
  await operator.call({ type: "files_finish", fileId: own.fileId, userId: "alice" });
  await expect(operator.call({ type: "files_download_url", fileId: own.fileId, userId: "bob" })).rejects.toThrow("not found");
});

test("streams arbitrary binary HTTP content and caps unknown response lengths", async () => {
  const c = client();
  let pulled = 0;
  let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    pull(controller) {
      pulled++;
      if (pulled <= 3) controller.enqueue(new Uint8Array([0, 255, 128]));
      else controller.close();
    },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/zip" } })) as unknown as typeof fetch;
  const file = await c.call({ type: "files_fetch", url: "http://93.184.216.34/archive", options: { fileName: "archive.zip", maxBytes: 10 } });
  expect(file).toMatchObject({ size: 9, mimeType: "application/zip" });
  expect((await c.call({ type: "files_read_chunk", source: { fileId: file.fileId }, offset: 0 })).data).toEqual(new Uint8Array([0, 255, 128, 0, 255, 128, 0, 255, 128]));
  pulled = 0;
  await expect(c.call({ type: "files_fetch", url: "http://93.184.216.34/archive", options: { maxBytes: 4 } })).rejects.toThrow("too large");
  expect(cancelled).toBe(true);
  const root = (await readdir(join(directory, "spindle-files")))[0]!;
  expect(await readdir(join(directory, "spindle-files", root))).toEqual([file.fileId]);
  permitted = false;
  await expect(c.call({ type: "files_fetch", url: "http://93.184.216.34/archive", options: {} })).rejects.toThrow("cors_proxy");
});

test("cancels a pending download and removes the partial file", async () => {
  const c = client();
  const started = Promise.withResolvers<void>();
  globalThis.fetch = (async (_url, init) => {
    started.resolve();
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        init!.signal!.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      },
    }));
  }) as typeof fetch;
  const operation = c.start({ type: "files_fetch", url: "http://93.184.216.34/slow", options: { maxBytes: 10 } });
  await started.promise;
  c.api.dispatch({ type: "files_cancel", operationId: operation.requestId });
  await expect(operation.result).rejects.toThrow("AbortError");
  const root = (await readdir(join(directory, "spindle-files")))[0]!;
  expect(await readdir(join(directory, "spindle-files", root))).toEqual([]);
});

test("creates ZIP64 archives from staged files and uploads, then extracts exact bytes", async () => {
  const c = client();
  const bytes = new Uint8Array([0, 128, 255]);
  const first = await staged(c, bytes, "first.bin");
  const upload = createUpload({ ownerUserId: "alice", extensionIdentifier: "extension-a", fileName: "second.bin", declaredSize: 3 });
  await appendUpload(upload.uploadId, new Blob([bytes]).stream(), 0);
  try {
    const zip = await c.call({ type: "archives_create", entries: [
      { name: "folder/first.bin", source: { fileId: first.fileId }, store: true },
      { name: "second.bin", source: { uploadId: upload.uploadId } },
    ], options: { maxBytes: 4096 } });
    const raw = new Uint8Array(await Bun.file(getStagedFile(zip.fileId)!.path).arrayBuffer());
    expect(Buffer.from(raw).indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBeGreaterThan(0);
    const extracted = await c.call({ type: "archives_extract", source: { fileId: zip.fileId }, options: { maxDecompressedBytes: 6 } });
    expect(extracted.map((entry: any) => entry.name)).toEqual(["folder/first.bin", "second.bin"]);
    for (const entry of extracted) {
      expect((await c.call({ type: "files_read_chunk", source: { fileId: entry.file.fileId }, offset: 0 })).data).toEqual(bytes);
    }
    const subset = await c.call({ type: "archives_extract", source: { fileId: zip.fileId }, options: { entries: ["second.bin"], maxDecompressedBytes: 3 } });
    expect(subset.map((entry: any) => entry.name)).toEqual(["second.bin"]);
    await expect(c.call({ type: "archives_extract", source: { fileId: zip.fileId }, options: { entries: ["missing"], maxDecompressedBytes: 3 } })).rejects.toThrow("not found");
  } finally { deleteUpload(upload.uploadId); }
});

test("rejects traversal, duplicate names, corrupt CRCs, and ZIP expansion beyond budget", async () => {
  const c = client();
  const bytes = new Uint8Array([1, 2, 3]);
  const file = await staged(c, bytes);
  for (const name of ["../escape", "/absolute", "C:/drive", "a\\b", "a/../b"]) {
    await expect(c.call({ type: "archives_create", entries: [{ name, source: { fileId: file.fileId } }], options: { maxBytes: 1024 } })).rejects.toThrow("Unsafe");
  }
  await expect(c.call({ type: "archives_create", entries: [1, 2].map(() => ({ name: "same", source: { fileId: file.fileId } })), options: { maxBytes: 1024 } })).rejects.toThrow("duplicate");
  const malicious = await staged(c, zipSync({ "../escape": bytes }));
  await expect(c.call({ type: "archives_extract", source: { fileId: malicious.fileId }, options: { maxDecompressedBytes: 100 } })).rejects.toThrow("Unsafe");
  const bomb = await staged(c, zipSync({ "large.bin": new Uint8Array(1024 * 1024) }));
  await expect(c.call({ type: "archives_extract", source: { fileId: bomb.fileId }, options: { maxDecompressedBytes: 10 } })).rejects.toThrow("size cap");
  const corruptBytes = zipSync({ "file.bin": bytes }, { level: 0 });
  corruptBytes["file.bin".length + 30] ^= 0xff;
  const corrupt = await staged(c, corruptBytes);
  await expect(c.call({ type: "archives_extract", source: { fileId: corrupt.fileId }, options: { maxDecompressedBytes: 10 } })).rejects.toThrow("CRC32");
});

test("browser download streams attachments only to their signed-in owner", async () => {
  const c = client();
  const ref = await staged(c, new Uint8Array([0, 128, 255]), 'export "é".zip');
  const url = await c.call({ type: "files_download_url", fileId: ref.fileId });
  const app = new Hono();
  app.use("*", async (ctx, next) => { ctx.set("userId", ctx.req.header("test-user") ?? ""); await next(); });
  app.route("/api/v1/spindle-files", spindleFilesRoutes);
  expect((await app.request(url, { headers: { "test-user": "bob" } })).status).toBe(404);
  expect((await app.request(url.replace("extension-a", "extension-b"), { headers: { "test-user": "alice" } })).status).toBe(404);
  const head = await app.request(url, { method: "HEAD", headers: { "test-user": "alice" } });
  expect(head.headers.get("content-length")).toBe("3");
  expect(getStagedFile(ref.fileId)!.pins).toBe(0);
  const response = await app.request(url, { headers: { "test-user": "alice" } });
  expect(response.headers.get("content-disposition")).toContain("attachment;");
  expect(response.headers.get("content-length")).toBe("3");
  expect(response.headers.get("cache-control")).toBe("no-store");
  await expect(c.call({ type: "files_delete", fileId: ref.fileId })).rejects.toThrow("in use");
  await c.api.dispose();
  expect((await app.request(url, { headers: { "test-user": "alice" } })).status).toBe(404);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 128, 255]));
  expect(getStagedFile(ref.fileId)).toBeUndefined();
});

test("cancelling a browser download releases the file for deletion", async () => {
  const c = client();
  const ref = await staged(c, new Uint8Array(FILE_CHUNK_BYTES + 1));
  const app = new Hono();
  app.use("*", async (ctx, next) => { ctx.set("userId", "alice"); await next(); });
  app.route("/api/v1/spindle-files", spindleFilesRoutes);
  const url = await c.call({ type: "files_download_url", fileId: ref.fileId });
  const response = await app.request(url);
  await response.body!.cancel();
  expect(await c.call({ type: "files_delete", fileId: ref.fileId })).toBe(true);
});

test("expiry removes idle files and successful reads refresh the lifetime", async () => {
  const c = client();
  const ref = await staged(c, new Uint8Array([1]));
  const rec = getStagedFile(ref.fileId)!;
  rec.expiresAt = Date.now() + 1000;
  await c.call({ type: "files_read_chunk", source: { fileId: ref.fileId }, offset: 0 });
  expect(rec.expiresAt).toBeGreaterThan(Date.now() + FILE_TTL_MS - 1000);
  rec.expiresAt = Date.now() - 1;
  await expect(c.call({ type: "files_download_url", fileId: ref.fileId })).rejects.toThrow("expired");
  await expect(stat(rec.path)).rejects.toThrow();
});

test("supports generated files without a known final length and releases unused capacity", async () => {
  const c = client();
  const ref = await c.call({ type: "files_create", input: { fileName: "generated.ndjson", maxBytes: 10 } });
  await c.call({ type: "files_write_chunk", fileId: ref.fileId, offset: 0, data: new Uint8Array([1, 2, 3]) });
  expect((await c.call({ type: "files_finish", fileId: ref.fileId })).size).toBe(3);
  expect(getStagedFile(ref.fileId)!.budget).toBe(3);
  await expect(c.call({ type: "files_create", input: { fileName: "ambiguous", size: 1, maxBytes: 2 } })).rejects.toThrow("not both");
});

test("enforces aggregate reservations and cleans up archive output that exceeds its cap", async () => {
  const c = client();
  const ref = await staged(c, new Uint8Array([1, 2, 3]));
  const rec = getStagedFile(ref.fileId)!;
  rec.budget = FILE_MAX_BYTES; // Exercise reservation arithmetic without allocating disk space.
  await expect(c.call({ type: "files_create", input: { fileName: "over-quota", size: 1 } })).rejects.toThrow("quota");
  rec.budget = rec.size;
  await expect(c.call({ type: "files_create", input: { fileName: "oversized", size: FILE_MAX_BYTES + 1 } })).rejects.toThrow("safe integer");
  await expect(c.call({ type: "archives_create", entries: [{ name: "file.bin", source: { fileId: ref.fileId } }], options: { maxBytes: 1 } })).rejects.toThrow("limit");
  expect(rec.pins).toBe(0);
  const root = (await readdir(join(directory, "spindle-files")))[0]!;
  expect(await readdir(join(directory, "spindle-files", root))).toEqual([ref.fileId]);
});

test("reads beyond the ZIP32 boundary without materializing a large file", async () => {
  const c = client();
  const ref = await staged(c, new Uint8Array());
  const rec = getStagedFile(ref.fileId)!;
  const offset = 2 ** 32 + 7;
  await truncate(rec.path, offset + 3); // Sparse file, no multi-gigabyte allocation.
  const handle = await open(rec.path, "r+");
  try { await handle.write(new Uint8Array([0, 128, 255]), 0, 3, offset); }
  finally { await handle.close(); }
  rec.size = offset + 3;
  rec.budget = rec.size;
  expect(await c.call({ type: "files_read_chunk", source: { fileId: ref.fileId }, offset })).toMatchObject({ data: new Uint8Array([0, 128, 255]), eof: true, size: offset + 3 });
});

test("caps concurrent producers and cancels them on worker shutdown", async () => {
  const c = client();
  let calls = 0;
  const allStarted = Promise.withResolvers<void>();
  globalThis.fetch = (async (_url, options) => {
    calls++;
    if (calls === 8) allStarted.resolve();
    return new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  }) as typeof fetch;
  const operations = Array.from({ length: 8 }, () => c.start({ type: "files_fetch", url: "http://93.184.216.34/slow", options: { maxBytes: 1 } }));
  const settled = Promise.allSettled(operations.map(operation => operation.result));
  await allStarted.promise;
  await expect(c.call({ type: "files_fetch", url: "http://93.184.216.34/slow", options: { maxBytes: 1 } })).rejects.toThrow("concurrent");
  await c.api.dispose();
  expect((await settled).every(result => result.status === "rejected")).toBe(true);
  const root = (await readdir(join(directory, "spindle-files")))[0]!;
  expect(await readdir(join(directory, "spindle-files", root))).toEqual([]);
});
