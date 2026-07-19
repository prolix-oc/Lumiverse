import { join } from "node:path";
import { mkdirSync, writeFileSync, createWriteStream, rmSync, statSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "../env";

export interface SpindleUploadRecord {
  readonly uploadId: string;
  readonly path: string;
  readonly fileName: string;
  readonly declaredSize: number;
  readonly ownerUserId: string;
  readonly extensionIdentifier: string;
  offset: number;
  expiresAt: number;
}

const UPLOAD_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60_000;
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

const uploads = new Map<string, SpindleUploadRecord>();

export function getMaxUploadBytes(): number {
  return MAX_UPLOAD_BYTES;
}

function dirFor(userId: string, uploadId: string): string {
  return join(env.dataDir, "spindle-uploads", userId, uploadId);
}

export function createUpload(input: {
  ownerUserId: string;
  extensionIdentifier: string;
  fileName: string;
  declaredSize: number;
}): SpindleUploadRecord {
  const uploadId = crypto.randomUUID();
  const dir = dirFor(input.ownerUserId, uploadId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "blob");
  writeFileSync(path, "");
  const rec: SpindleUploadRecord = {
    uploadId,
    path,
    fileName: input.fileName,
    declaredSize: input.declaredSize,
    ownerUserId: input.ownerUserId,
    extensionIdentifier: input.extensionIdentifier,
    offset: 0,
    expiresAt: Date.now() + UPLOAD_TTL_MS,
  };
  uploads.set(uploadId, rec);
  return rec;
}

export function getUpload(uploadId: string): SpindleUploadRecord | undefined {
  const rec = uploads.get(uploadId);
  if (!rec) return undefined;
  if (Date.now() > rec.expiresAt) {
    deleteUpload(uploadId);
    return undefined;
  }
  return rec;
}

export async function appendUpload(
  uploadId: string,
  body: ReadableStream<Uint8Array>,
  expectedOffset: number,
): Promise<number> {
  const rec = uploads.get(uploadId);
  if (!rec) throw new Error("upload not found");
  if (expectedOffset !== rec.offset) throw new Error("offset mismatch");
  rec.expiresAt = Date.now() + UPLOAD_TTL_MS;
  // Enforce the cap mid-stream so a client can't exceed it by lying about length.
  const cap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (rec.offset + chunk.length > MAX_UPLOAD_BYTES) {
        cb(new Error("upload exceeds size cap"));
        return;
      }
      rec.offset += chunk.length;
      cb(null, chunk);
    },
  });
  try {
    // pipeline propagates source/transform/sink errors as a rejection and
    // destroys every stream, so a write fault never becomes an unhandled
    // 'error' event (process crash) or a hung promise.
    const bodyStream = body as unknown as Parameters<typeof Readable.fromWeb>[0];
    await pipeline(
      Readable.fromWeb(bodyStream),
      cap,
      createWriteStream(rec.path, { flags: "a" }),
    );
  } finally {
    // Reconcile against what actually landed on disk: a partial PATCH must
    // leave rec.offset == file size so the client's resume offset is correct.
    try {
      rec.offset = statSync(rec.path).size;
    } catch (err) {
      console.warn(
        `[spindle-uploads] stat after append failed for ${uploadId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return rec.offset;
}

export async function readUploadBytes(uploadId: string): Promise<Uint8Array> {
  const rec = uploads.get(uploadId);
  if (!rec) throw new Error("upload not found");
  return new Uint8Array(await Bun.file(rec.path).arrayBuffer());
}

export function deleteUpload(uploadId: string): void {
  const rec = uploads.get(uploadId);
  if (!rec) return;
  uploads.delete(uploadId);
  try {
    rmSync(dirFor(rec.ownerUserId, uploadId), { recursive: true, force: true });
  } catch (err) {
    console.warn(
      `[spindle-uploads] failed to remove upload dir for ${uploadId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const sweepTimer = setInterval(() => {
  try {
    const now = Date.now();
    for (const [id, rec] of uploads) {
      if (now > rec.expiresAt) deleteUpload(id);
    }
  } catch (err) {
    // A throw here would be an unhandled timer exception (process crash).
    console.error(
      `[spindle-uploads] sweep failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}, SWEEP_INTERVAL_MS);
if (typeof (sweepTimer as { unref?: () => void }).unref === "function") {
  (sweepTimer as { unref: () => void }).unref();
}
