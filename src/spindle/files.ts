import { createWriteStream, mkdirSync, mkdtempSync, readdirSync, rmSync, statfsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "../env";
import {
  SPINDLE_FILE_CHUNK_BYTES as FILE_CHUNK_BYTES,
  SPINDLE_FILE_MAX_BYTES as FILE_MAX_BYTES,
  SPINDLE_FILE_MAX_COUNT as FILE_MAX_COUNT,
  SPINDLE_FILE_TTL_MS as FILE_TTL_MS,
  type SpindleFileRef,
} from "lumiverse-spindle-types";

export interface FileOwner {
  extensionId: string;
  identifier: string;
  userId: string;
  sessionId: string;
}
export interface StagedFile extends FileOwner {
  fileId: string;
  path: string;
  directory: string;
  fileName: string;
  mimeType: string;
  size: number;
  budget: number;
  expectedSize?: number;
  complete: boolean;
  pins: number;
  expiresAt: number;
  retired?: boolean;
}

const files = new Map<string, StagedFile>();
const roots = new Map<string, string>();

function root(): string {
  let directory = roots.get(env.dataDir);
  if (!directory) {
    const base = join(env.dataDir, "spindle-files");
    mkdirSync(base, { recursive: true });
    // Recover disk space left by a crashed host; never remove a live process's
    // directory (including another server using the same data volume).
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const match = /^run-(\d+)-/.exec(entry.name);
      if (!entry.isDirectory() || !match) continue;
      try { process.kill(Number(match[1]), 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          try { rmSync(join(base, entry.name), { recursive: true, force: true }); }
          catch (cleanupError) { console.warn("[spindle-files] orphan cleanup failed", cleanupError); }
        }
      }
    }
    directory = mkdtempSync(join(base, `run-${process.pid}-`));
    roots.set(env.dataDir, directory);
  }
  return directory;
}

export function assertFileSize(size: number, maximum = FILE_MAX_BYTES): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > maximum) {
    throw new Error(`size must be a safe integer between 0 and ${maximum} bytes`);
  }
}

export function safeFileName(name: string): string {
  if (typeof name !== "string" || !name || name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(name) || name === "." || name === "..") {
    throw new Error("Invalid fileName");
  }
  return name;
}

export function assertArchiveName(name: string): void {
  if (typeof name !== "string" || !name || name.length > 4096 || /[\\\x00-\x1f\x7f]/.test(name) || /^(\/|[a-zA-Z]:)/.test(name)) {
    throw new Error("Unsafe archive entry name");
  }
  const parts = name.replace(/\/$/, "").split("/");
  if (parts.some(part => !part || part === "." || part === "..")) throw new Error("Unsafe archive entry name");
}

/** Reserve a bounded disk budget before starting a producer. Reservations include in-flight work. */
export function createStagedFile(owner: FileOwner, fileName: string, budget: number, mimeType = "application/octet-stream"): StagedFile {
  assertFileSize(budget);
  safeFileName(fileName);
  if (typeof mimeType !== "string" || mimeType.length > 255 || /[\r\n\x00]/.test(mimeType)) throw new Error("Invalid mimeType");
  let used = 0;
  let count = 0;
  for (const rec of files.values()) {
    if (rec.extensionId === owner.extensionId && rec.userId === owner.userId) {
      used += rec.budget;
      count++;
    }
  }
  if (count >= FILE_MAX_COUNT) throw new Error(`Too many staged files (max ${FILE_MAX_COUNT})`);
  if (used + budget > FILE_MAX_BYTES) throw new Error("Staged file storage quota exceeded");
  const base = root();
  // Keep a small free-space floor. Other writers can consume space after this
  // check; write errors still propagate and tear down partial files.
  const disk = statfsSync(base);
  let outstanding = 0;
  for (const rec of files.values()) outstanding += Math.max(0, rec.budget - rec.size);
  if (disk.bavail * disk.bsize < outstanding + budget + 64 * 1024 ** 2) throw new Error("Insufficient free disk space for staged file");
  const fileId = crypto.randomUUID();
  const directory = join(base, fileId);
  mkdirSync(directory);
  const rec: StagedFile = {
    ...owner, fileId, directory, path: join(directory, "blob"), fileName, mimeType,
    size: 0, budget, complete: false, pins: 0, expiresAt: Date.now() + FILE_TTL_MS,
  };
  files.set(fileId, rec);
  return rec;
}

export function getStagedFile(fileId: string): StagedFile | undefined {
  const rec = files.get(fileId);
  if (!rec || rec.retired) return undefined;
  if (Date.now() > rec.expiresAt && rec.pins === 0) {
    removeStagedFile(rec);
    return undefined;
  }
  return rec;
}

export function ownedStagedFile(owner: FileOwner, fileId: string): StagedFile {
  const rec = getStagedFile(fileId);
  if (!rec || rec.extensionId !== owner.extensionId || rec.userId !== owner.userId || rec.sessionId !== owner.sessionId) {
    throw new Error("File not found or expired");
  }
  rec.expiresAt = Date.now() + FILE_TTL_MS;
  return rec;
}

export function fileRef(rec: StagedFile): SpindleFileRef {
  return { fileId: rec.fileId, fileName: rec.fileName, size: rec.size, mimeType: rec.mimeType };
}

export function pinStagedFile(rec: StagedFile): () => void {
  rec.pins++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rec.pins--;
    rec.expiresAt = Date.now() + FILE_TTL_MS;
    if (rec.retired && rec.pins === 0) {
      try { removeStagedFile(rec); } catch (error) { console.warn("[spindle-files] cleanup failed", error); }
    }
  };
}

export function removeStagedFile(rec: StagedFile): void {
  if (rec.pins) throw new Error("File is in use");
  rmSync(rec.directory, { recursive: true, force: true });
  files.delete(rec.fileId);
}

export function removeSessionFiles(sessionId: string): void {
  for (const rec of files.values()) {
    if (rec.sessionId === sessionId) {
      rec.retired = true;
      if (!rec.pins) {
        try { removeStagedFile(rec); } catch (error) { console.warn("[spindle-files] cleanup failed", error); }
      }
    }
  }
}

export function finishStagedFile(rec: StagedFile, expectedSize?: number): SpindleFileRef {
  const size = statSync(rec.path).size;
  if (size > rec.budget || (expectedSize !== undefined && size !== expectedSize)) throw new Error("File size does not match declared size");
  rec.size = size;
  rec.budget = size;
  rec.complete = true;
  rec.expiresAt = Date.now() + FILE_TTL_MS;
  return fileRef(rec);
}

/** Node pipeline preserves backpressure all the way from producer to disk. */
export async function persistFile(rec: StagedFile, source: Readable | ReadableStream<Uint8Array>, signal: AbortSignal, authorize = () => {}): Promise<SpindleFileRef> {
  const release = pinStagedFile(rec);
  const cap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        authorize();
        if (rec.size + chunk.byteLength > rec.budget) throw new Error("File exceeds size limit");
        rec.size += chunk.byteLength;
        callback(null, chunk);
      } catch (err) { callback(err as Error); }
    },
  });
  try {
    await pipeline(
      "getReader" in source ? Readable.fromWeb(source as unknown as Parameters<typeof Readable.fromWeb>[0]) : source,
      cap, createWriteStream(rec.path, { flags: "wx" }), { signal },
    );
    return finishStagedFile(rec);
  } catch (error) {
    release();
    if (!rec.pins) removeStagedFile(rec);
    throw error;
  } finally { release(); }
}

export async function writeFileChunk(rec: StagedFile, offset: number, data: Uint8Array): Promise<number> {
  if (rec.complete) throw new Error("File is already complete");
  if (rec.pins) throw new Error("File is in use");
  if (!(data instanceof Uint8Array) || data.byteLength === 0 || data.byteLength > FILE_CHUNK_BYTES) throw new Error(`Chunk must contain 1 to ${FILE_CHUNK_BYTES} bytes`);
  if (!Number.isSafeInteger(offset) || offset !== rec.size) throw new Error("Offset mismatch");
  if (rec.size + data.byteLength > rec.budget) throw new Error("File exceeds declared size");
  const release = pinStagedFile(rec);
  try {
    const handle = await open(rec.path, "r+");
    try {
      let written = 0;
      while (written < data.byteLength) {
        const result = await handle.write(data, written, data.byteLength - written, offset + written);
        if (!result.bytesWritten) throw new Error("Unable to write file chunk");
        written += result.bytesWritten;
      }
      rec.size += written;
      return rec.size;
    } finally { await handle.close(); }
  } catch (error) {
    release();
    removeStagedFile(rec);
    throw error;
  } finally { release(); }
}

export async function readFileChunk(path: string, size: number, offset: number): Promise<{ data: Uint8Array; offset: number; size: number; eof: boolean }> {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) throw new Error("Invalid file offset");
  const end = Math.min(size, offset + FILE_CHUNK_BYTES);
  const data = new Uint8Array(await Bun.file(path).slice(offset, end).arrayBuffer());
  if (data.byteLength !== end - offset) throw new Error("File changed while reading");
  return { data, offset, size, eof: end === size };
}

export function fileDownloadUrl(rec: StagedFile): string {
  return `/api/v1/spindle-files/${encodeURIComponent(rec.identifier)}/${rec.fileId}`;
}

const sweep = setInterval(() => {
  for (const rec of files.values()) {
    if (!rec.pins && (rec.retired || Date.now() > rec.expiresAt)) {
      try { removeStagedFile(rec); } catch (error) { console.warn("[spindle-files] cleanup failed", error); }
    }
  }
}, 60_000);
sweep.unref();
