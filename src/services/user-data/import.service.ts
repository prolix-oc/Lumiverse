// Streaming user-data import.
//
// Reads a .lvbak (ZIP) archive entry-by-entry, validates each entry, and
// applies it to the importing user's account. Database rows use
// "INSERT OR IGNORE" — re-imports of the same archive are non-destructive,
// keeping pre-existing data untouched.
//
// The import runs as a background job; the HTTP route returns a jobId and
// progress flows over the WebSocket EventBus.

import { createInflateRaw, inflateRawSync } from "node:zlib";
import {
  decryptSecret,
  lookupConsumedTicket,
  recordConsumedTicket,
  verifyTicket,
  TicketError,
  type DecryptionTicket,
  type EncryptedSecretEntry,
} from "./secret-ticket.service";
import { putSecret } from "../secrets.service";
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeSync,
} from "fs";
import { join, dirname, basename, resolve, sep } from "path";
import { getDb } from "../../db/connection";
import { env } from "../../env";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import { getEmbeddingConfig } from "../embeddings.service";
import { detectAudioFormat } from "../notification-sounds.service";
import {
  parseManifest,
  embeddingConfigsMatch,
  NDJSON_FORMAT_VERSION,
  type ArchiveManifest,
  type ArchiveEmbeddingConfig,
} from "./manifest";
import {
  IMPORT_ORDER,
  EXCLUDED_TABLES,
  SECRET_SETTING_KEY_PATTERNS,
} from "./table-registry";
import { sanitizeEntry, safeJoin, SanitizeError, type SanitizedEntry } from "./sanitize";

// ---------------------------------------------------------------------------
// Tunables / safety caps
// ---------------------------------------------------------------------------

/** Reject archives whose total decompressed size exceeds this cap. */
export const MAX_DECOMPRESSED_BYTES = 20 * 1024 * 1024 * 1024; // 20 GB

/** Keep a small reserve for SQLite journals and normal server operation. */
const IMPORT_DISK_HEADROOM_BYTES = 64 * 1024 * 1024;

/** Reject archives over this compressed size at upload time. */
export const MAX_COMPRESSED_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

/** Reject any NDJSON line longer than this in current-format archives. */
const MAX_NDJSON_LINE_BYTES = 4 * 1024 * 1024;

/**
 * Archives created before the fixed-window importer can contain a single
 * database row larger than the current 4 MiB line limit (typically an old
 * message, card field, or settings blob). Keep a larger, still bounded cap
 * for that historical data so it remains portable without weakening the
 * normal import path for newly-created archives.
 */
const LEGACY_MAX_NDJSON_LINE_BYTES = 64 * 1024 * 1024;

/** Read compressed archive data in fixed-size windows during extraction. */
const ARCHIVE_READ_BYTES = 64 * 1024;

/** Bound each zlib output allocation during archive extraction. */
const INFLATE_OUTPUT_BYTES = 64 * 1024;

/** Text entries are table-shaped metadata; there should never be thousands. */
const MAX_TEXT_ENTRIES = 1_024;

/** Reject archives with more than this many entries. */
const MAX_ENTRIES = 500_000;

/** Apply DB rows in batches of this size, one transaction per batch. */
const ROW_BATCH = 200;

/** Yield to the event loop between batches. */
const YIELD_INTERVAL_MS = 0;

// ---------------------------------------------------------------------------
// Job tracking
// ---------------------------------------------------------------------------

export type ImportJobStatus =
  | "queued"
  | "awaiting_ticket"
  | "running"
  | "complete"
  | "failed"
  | "cancelled";

export interface ImportJob {
  jobId: string;
  userId: string;
  status: ImportJobStatus;
  archivePath: string;
  startedAt: number;
  finishedAt: number | null;
  manifest: ArchiveManifest | null;
  /** {table: {imported, skipped}}. Updated as the job progresses. */
  summary: Record<string, { imported: number; skipped: number }>;
  /** Counts of files restored under each bucket. */
  fileSummary: Record<string, number>;
  /** Most recent error message if status === 'failed'. */
  error: string | null;
  /** Abort controller — exposed for cancel endpoint. */
  abort: AbortController;
  /**
   * If the archive declares hasEncryptedSecrets, the job pauses after
   * extraction and waits on this gate. Resolved with a ticket when the
   * UI uploads one, or with `null` when the user opts to skip.
   */
  ticketGate?: Promise<{ ticket: DecryptionTicket; smk: Uint8Array } | null>;
  ticketResolver?: (
    value: { ticket: DecryptionTicket; smk: Uint8Array } | null,
  ) => void;
  /** Set after extractArchive runs; used by the ticket route to validate. */
  archiveSecretKeys?: string[];
  /** Whether the most recent ticket use was a replay; surfaced to the UI. */
  ticketReused?: boolean;
  /** Count of secrets actually re-encrypted on the target. */
  secretsRestored?: number;
}

const JOBS: Map<string, ImportJob> = new Map();
const USER_RUNNING: Map<string, string> = new Map(); // userId -> jobId
const USER_UPLOAD_RESERVATIONS: Map<string, string> = new Map();
let globalImportSlot: string | null = null;

export function getJob(jobId: string): ImportJob | undefined {
  return JOBS.get(jobId);
}

export function listJobsForUser(userId: string): ImportJob[] {
  return [...JOBS.values()].filter((j) => j.userId === userId);
}

export function isUserImportRunning(userId: string): boolean {
  return USER_RUNNING.has(userId) || USER_UPLOAD_RESERVATIONS.has(userId);
}

/**
 * Reserve the single import lifecycle slot before the request body is read.
 * Without this, async handlers can both pass a status check and stage
 * multi-gigabyte archives concurrently before either one creates a job.
 */
export function reserveImportUpload(userId: string): string | null {
  if (isUserImportRunning(userId) || globalImportSlot !== null) return null;
  const jobId = crypto.randomUUID();
  USER_UPLOAD_RESERVATIONS.set(userId, jobId);
  globalImportSlot = jobId;
  return jobId;
}

export function releaseImportUpload(userId: string, jobId: string): void {
  if (USER_UPLOAD_RESERVATIONS.get(userId) === jobId) {
    USER_UPLOAD_RESERVATIONS.delete(userId);
  }
  if (globalImportSlot === jobId) globalImportSlot = null;
}

/** Transfer a successful upload reservation into its background job. */
function claimImportReservation(userId: string, jobId: string): void {
  if (USER_UPLOAD_RESERVATIONS.get(userId) === jobId) {
    USER_UPLOAD_RESERVATIONS.delete(userId);
  }
}

function releaseGlobalImportSlot(jobId: string): void {
  if (globalImportSlot === jobId) globalImportSlot = null;
}

export function cancelJob(jobId: string): boolean {
  const job = JOBS.get(jobId);
  if (!job) return false;
  if (
    job.status !== "running" &&
    job.status !== "queued" &&
    job.status !== "awaiting_ticket"
  ) return false;
  try {
    job.abort.abort();
  } catch {
    /* ignore */
  }
  return true;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Errors thrown while staging or verifying an uploaded archive. The HTTP
 * route maps these onto specific 4xx codes (415 for the wrong format, 422
 * for a wrong/incompatible manifest, 413 for size).
 */
export class ArchiveValidationError extends Error {
  constructor(public code: "not_zip" | "size" | "no_manifest" | "bad_manifest", message: string) {
    super(message);
    this.name = "ArchiveValidationError";
  }
}

/** ZIP local-file-header magic: "PK\x03\x04" — every valid ZIP starts here. */
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

function startsWithZipMagic(prefix: Uint8Array): boolean {
  if (prefix.byteLength < 4) return false;
  return (
    prefix[0] === ZIP_MAGIC[0] &&
    prefix[1] === ZIP_MAGIC[1] &&
    prefix[2] === ZIP_MAGIC[2] &&
    prefix[3] === ZIP_MAGIC[3]
  );
}

/**
 * Stream an HTTP request body into a temp archive under the user's import
 * directory, returning the archive path. Each request chunk is synchronously
 * committed before the next is read, so slow storage cannot turn Bun's file
 * writer into an unbounded native queue. The first 4 bytes are inspected
 * mid-stream — anything that isn't a ZIP is rejected and the partial file is
 * deleted before any further bytes are committed.
 */
export async function persistUploadedArchive(
  userId: string,
  body: ReadableStream<Uint8Array>,
  declaredSize: number | null,
  jobId: string = crypto.randomUUID(),
): Promise<{ path: string; jobId: string }> {
  if (declaredSize !== null && declaredSize > MAX_COMPRESSED_BYTES) {
    throw new ArchiveValidationError(
      "size",
      `archive exceeds ${MAX_COMPRESSED_BYTES / (1024 * 1024 * 1024)} GB cap`,
    );
  }
  const dir = join(env.dataDir, "imports", userId, jobId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "archive.lvbak");

  // Avoid Bun.FileSink for this failure-sensitive path. A synchronous fd
  // write provides backpressure at the request-reader boundary and has no
  // intermediate runtime-owned queue to grow under slow Android storage.
  const fd = openSync(path, "w");
  const reader = body.getReader();
  const header = new Uint8Array(4);
  let headerBytes = 0;
  let magicChecked = false;
  let total = 0;
  let fdClosed = false;

  const closeFd = (ignoreError = false) => {
    if (fdClosed) return;
    fdClosed = true;
    try {
      closeSync(fd);
    } catch (err) {
      if (!ignoreError) throw err;
    }
  };

  const cleanup = () => {
    // Cleanup runs while another validation/write error is already in flight;
    // don't replace that useful error with a secondary close failure.
    closeFd(true);
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  };

  const writeChunk = (chunk: Uint8Array) => {
    if (chunk.byteLength === 0) return;
    if (total + chunk.byteLength > MAX_COMPRESSED_BYTES) {
      throw new ArchiveValidationError(
        "size",
        `archive exceeds compressed size cap (${total + chunk.byteLength} bytes)`,
      );
    }
    writeAllSync(fd, chunk);
    total += chunk.byteLength;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      // Accumulate only the four magic bytes. The previous implementation
      // copied the *entire* first stream chunk into a new Uint8Array; some Bun
      // builds can deliver a very large first chunk for a known-length body,
      // temporarily doubling an already-large archive in memory.
      if (!magicChecked) {
        const take = Math.min(4 - headerBytes, value.byteLength);
        header.set(value.subarray(0, take), headerBytes);
        headerBytes += take;
        if (headerBytes < 4) continue;

        if (!startsWithZipMagic(header)) {
          throw new ArchiveValidationError(
            "not_zip",
            "Uploaded file is not a ZIP archive (missing PK\\x03\\x04 header).",
          );
        }

        magicChecked = true;
        writeChunk(header);
        writeChunk(value.subarray(take));
        continue;
      }

      writeChunk(value);
    }

    // Body ended before we had 4 bytes — treat as invalid.
    if (!magicChecked) {
      throw new ArchiveValidationError("not_zip", "Upload is empty or shorter than a ZIP header.");
    }

    closeFd();
  } catch (err) {
    // Stop accepting network data immediately on validation/write failure,
    // then remove the partial archive after its fd has actually closed.
    try {
      await reader.cancel(err);
    } catch {
      /* ignore */
    }
    cleanup();
    throw err;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  const stat = statSync(path);
  if (stat.size > MAX_COMPRESSED_BYTES) {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
    throw new ArchiveValidationError(
      "size",
      `archive exceeds compressed size cap (${stat.size} bytes)`,
    );
  }
  return { path, jobId };
}

/**
 * Cap on the manifest entry's decompressed size. New-format manifests are
 * < 4 KB (counts + missing-files were moved to a trailer), but legacy
 * archives embed those inline — a long missingFiles list on a corrupted
 * library can push the manifest into the MB range, so we leave a roomy
 * ceiling and still reject anything obviously absurd.
 */
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

/** Optional trailer and secret index are metadata, never bulk payloads. */
const MAX_MANIFEST_STATS_BYTES = 16 * 1024 * 1024;
const MAX_SECRETS_INDEX_BYTES = 16 * 1024 * 1024;

/** A manifest should never be larger compressed than this. */
const MAX_MANIFEST_COMPRESSED_BYTES = 32 * 1024 * 1024;

// ─── ZIP central-directory primitives ──────────────────────────────────
//
// Every ZIP file ends with an End-of-Central-Directory (EOCD) record, which
// names the offset and size of the central directory — a table of every
// entry's name, compression, and absolute offset in the file. Reading just
// the tail of the archive lets us locate `manifest.json` in O(1) regardless
// of where it sits in the file, which matters for legacy archives (manifest
// last) and 2+ GB exports.
//
// ZIP64 (used when an archive crosses 2³²−1 bytes, has more than 65535
// entries, or has an individual entry > 4 GB) augments the EOCD with a
// "ZIP64 End of Central Directory Locator" (sig 0x07064b50, 20 bytes,
// sitting immediately before the standard EOCD) and a "ZIP64 End of
// Central Directory Record" (sig 0x06064b50, 56 bytes) at the offset
// named by the locator. Those two records carry the true 64-bit
// cdSize, cdOffset, and totalEntries values. ZIP64-aware writers also
// store per-entry 64-bit overrides in the central directory's "extra
// field" (tag 0x0001); we honour those below when the standard 32-bit
// fields are the 0xFFFFFFFF / 0xFFFF sentinels.

const EOCD_SIG = 0x06054b50; // "PK\x05\x06"
const CDH_SIG = 0x02014b50;  // "PK\x01\x02"
const LFH_SIG = 0x04034b50;  // "PK\x03\x04"
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50; // "PK\x06\x07"
const ZIP64_EOCD_RECORD_SIG = 0x06064b50; // "PK\x06\x06"
const ZIP64_EXTRA_TAG = 0x0001;
const EOCD_MIN_BYTES = 22;
const ZIP64_EOCD_LOCATOR_BYTES = 20;
const ZIP64_EOCD_RECORD_BYTES = 56;
const ZIP_COMMENT_MAX = 65535;
/** Bounded read window used while scanning a potentially huge central directory. */
const CENTRAL_DIRECTORY_READ_BYTES = 256 * 1024;

interface CentralDirEntry {
  name: string;
  flags: number;
  compression: number;        // 0 = store, 8 = deflate
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Walk a central-directory-header (or local-file-header) extra field and
 * return the first ZIP64 block (tag 0x0001) as a typed view, or null if no
 * such block is present. Each extra block is: 2-byte tag, 2-byte size,
 * `size` bytes of payload. Blocks are concatenated back-to-back.
 */
function readZip64Extra(
  extra: Uint8Array,
  extraOffset: number,
  extraLen: number,
): DataView | null {
  let pos = extraOffset;
  const end = extraOffset + extraLen;
  while (pos + 4 <= end) {
    const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
    const tag = view.getUint16(pos, true);
    const size = view.getUint16(pos + 2, true);
    if (pos + 4 + size > end) return null;
    if (tag === ZIP64_EXTRA_TAG) {
      return new DataView(extra.buffer, extra.byteOffset + pos + 4, size);
    }
    pos += 4 + size;
  }
  return null;
}

async function readBytes(file: Bun.BunFile, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

function isSafeZipNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Yield central-directory records in fixed-size windows. The carry buffer is
 * at most one maximum-size record, so callers can inspect every entry without
 * retaining the directory or a list of archive metadata in memory.
 */
async function* scanCentralDirectory(
  file: Bun.BunFile,
  cdOffset: number,
  cdSize: number,
  totalEntries: number,
): AsyncGenerator<CentralDirEntry> {
  const decoder = new TextDecoder();
  let fetched = 0;
  let entriesRead = 0;
  let pending = new Uint8Array(0);

  while (fetched < cdSize && entriesRead < totalEntries) {
    const readSize = Math.min(CENTRAL_DIRECTORY_READ_BYTES, cdSize - fetched);
    const chunk = await readBytes(
      file,
      cdOffset + fetched,
      cdOffset + fetched + readSize,
    );
    if (chunk.byteLength !== readSize) {
      throw new ArchiveValidationError("not_zip", "central directory is truncated");
    }
    fetched += chunk.byteLength;

    let data: Uint8Array;
    if (pending.byteLength === 0) {
      data = chunk;
    } else {
      // A CD record is bounded by its three uint16 length fields, so this
      // carry buffer stays below ~192 KB regardless of total archive size.
      data = new Uint8Array(pending.byteLength + chunk.byteLength);
      data.set(pending, 0);
      data.set(chunk, pending.byteLength);
    }

    let pos = 0;
    while (pos + 46 <= data.byteLength && entriesRead < totalEntries) {
      const view = new DataView(data.buffer, data.byteOffset + pos);
      if (view.getUint32(0, true) !== CDH_SIG) {
        throw new ArchiveValidationError(
          "not_zip",
          `central directory header signature invalid at entry ${entriesRead}`,
        );
      }

      const flags = view.getUint16(8, true);
      const compression = view.getUint16(10, true);
      const crc32 = view.getUint32(16, true);
      let compressedSize = view.getUint32(20, true);
      let uncompressedSize = view.getUint32(24, true);
      const nameLen = view.getUint16(28, true);
      const extraLen = view.getUint16(30, true);
      const commentLen = view.getUint16(32, true);
      let localHeaderOffset = view.getUint32(42, true);
      const recordSize = 46 + nameLen + extraLen + commentLen;
      if (pos + recordSize > data.byteLength) break;

      const name = decoder.decode(data.subarray(pos + 46, pos + 46 + nameLen));
      if (
        extraLen > 0 &&
        (uncompressedSize === 0xffffffff ||
          compressedSize === 0xffffffff ||
          localHeaderOffset === 0xffffffff)
      ) {
        const zip64 = readZip64Extra(data, pos + 46 + nameLen, extraLen);
        if (!zip64) {
          throw new ArchiveValidationError(
            "not_zip",
            `ZIP64 extra field missing or truncated for ${name || `entry ${entriesRead}`}`,
          );
        }
        let cursor = 0;
        if (uncompressedSize === 0xffffffff) {
          if (cursor + 8 > zip64.byteLength) {
            throw new ArchiveValidationError("not_zip", "ZIP64 uncompressed size is truncated");
          }
          uncompressedSize = Number(zip64.getBigUint64(cursor, true));
          cursor += 8;
        }
        if (compressedSize === 0xffffffff) {
          if (cursor + 8 > zip64.byteLength) {
            throw new ArchiveValidationError("not_zip", "ZIP64 compressed size is truncated");
          }
          compressedSize = Number(zip64.getBigUint64(cursor, true));
          cursor += 8;
        }
        if (localHeaderOffset === 0xffffffff) {
          if (cursor + 8 > zip64.byteLength) {
            throw new ArchiveValidationError("not_zip", "ZIP64 local-header offset is truncated");
          }
          localHeaderOffset = Number(zip64.getBigUint64(cursor, true));
        }
      }

      if (
        !isSafeZipNumber(compressedSize) ||
        !isSafeZipNumber(uncompressedSize) ||
        !isSafeZipNumber(localHeaderOffset)
      ) {
        throw new ArchiveValidationError("not_zip", "central directory contains unsafe ZIP64 values");
      }

      entriesRead++;
      yield {
        name,
        flags,
        compression,
        crc32,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      };
      pos += recordSize;
    }

    // Copy only the partial record at the page boundary. Do not retain the
    // full page (or the entire central directory) through a subarray view.
    pending = data.slice(pos);
  }

  if (entriesRead < totalEntries) {
    throw new ArchiveValidationError("not_zip", "central directory entry is truncated");
  }
}

/** Find only manifest.json while preserving the bounded central-directory scan. */
async function findManifestInCentralDirectory(
  file: Bun.BunFile,
  cdOffset: number,
  cdSize: number,
  totalEntries: number,
): Promise<CentralDirEntry | null> {
  for await (const entry of scanCentralDirectory(file, cdOffset, cdSize, totalEntries)) {
    if (entry.name === "manifest.json") return entry;
  }
  return null;
}

interface CentralDirectoryInfo {
  size: number;
  cdOffset: number;
  cdSize: number;
  totalEntries: number;
}

/** Locate and validate the central directory without reading it as one blob. */
async function locateCentralDirectory(file: Bun.BunFile): Promise<CentralDirectoryInfo> {
  const size = file.size;
  if (size < EOCD_MIN_BYTES) {
    throw new ArchiveValidationError("not_zip", "archive is too small to contain a ZIP EOCD record");
  }

  const tailWindow = Math.min(size, EOCD_MIN_BYTES + ZIP_COMMENT_MAX);
  const tail = await readBytes(file, size - tailWindow, size);
  let eocdOffsetInTail = -1;
  for (let i = tail.length - EOCD_MIN_BYTES; i >= 0; i--) {
    if (
      tail[i] === 0x50 &&
      tail[i + 1] === 0x4b &&
      tail[i + 2] === 0x05 &&
      tail[i + 3] === 0x06
    ) {
      // A signature may occur inside the ZIP comment. Only accept a record
      // whose declared comment length lands exactly at end-of-file.
      const candidate = new DataView(tail.buffer, tail.byteOffset + i, EOCD_MIN_BYTES);
      if (i + EOCD_MIN_BYTES + candidate.getUint16(20, true) === tail.byteLength) {
        eocdOffsetInTail = i;
        break;
      }
    }
  }
  if (eocdOffsetInTail < 0) {
    throw new ArchiveValidationError("not_zip", "ZIP End-of-Central-Directory record not found");
  }

  const eocdFileOffset = size - tailWindow + eocdOffsetInTail;
  const eocd = new DataView(tail.buffer, tail.byteOffset + eocdOffsetInTail, EOCD_MIN_BYTES);
  let totalEntries = eocd.getUint16(10, true);
  let cdSize = eocd.getUint32(12, true);
  let cdOffset = eocd.getUint32(16, true);
  const eocdNeedsZip64 =
    cdSize === 0xffffffff || cdOffset === 0xffffffff || totalEntries === 0xffff;

  if (eocdNeedsZip64) {
    if (eocdFileOffset < ZIP64_EOCD_LOCATOR_BYTES) {
      throw new ArchiveValidationError("not_zip", "ZIP64 End-of-Central-Directory locator truncated");
    }
    const locatorFileOffset = eocdFileOffset - ZIP64_EOCD_LOCATOR_BYTES;
    let locatorView: DataView;
    if (locatorFileOffset >= size - tailWindow) {
      const localOff = locatorFileOffset - (size - tailWindow);
      locatorView = new DataView(tail.buffer, tail.byteOffset + localOff, ZIP64_EOCD_LOCATOR_BYTES);
    } else {
      const locatorBytes = await readBytes(file, locatorFileOffset, locatorFileOffset + ZIP64_EOCD_LOCATOR_BYTES);
      if (locatorBytes.byteLength !== ZIP64_EOCD_LOCATOR_BYTES) {
        throw new ArchiveValidationError("not_zip", "ZIP64 EOCD locator truncated");
      }
      locatorView = new DataView(locatorBytes.buffer, locatorBytes.byteOffset, ZIP64_EOCD_LOCATOR_BYTES);
    }
    if (locatorView.getUint32(0, true) !== ZIP64_EOCD_LOCATOR_SIG) {
      throw new ArchiveValidationError("not_zip", "ZIP64 EOCD sentinel detected but locator not found");
    }
    const zip64EocdOffset = Number(locatorView.getBigUint64(8, true));
    if (!isSafeZipNumber(zip64EocdOffset)) {
      throw new ArchiveValidationError("not_zip", "ZIP64 EOCD record offset is unsafe");
    }
    const zip64EocdBytes = await readBytes(
      file,
      zip64EocdOffset,
      zip64EocdOffset + ZIP64_EOCD_RECORD_BYTES,
    );
    if (zip64EocdBytes.byteLength !== ZIP64_EOCD_RECORD_BYTES) {
      throw new ArchiveValidationError("not_zip", "ZIP64 EOCD record truncated");
    }
    const zip64Eocd = new DataView(zip64EocdBytes.buffer, zip64EocdBytes.byteOffset, ZIP64_EOCD_RECORD_BYTES);
    if (zip64Eocd.getUint32(0, true) !== ZIP64_EOCD_RECORD_SIG) {
      throw new ArchiveValidationError("not_zip", "ZIP64 EOCD record signature invalid");
    }
    totalEntries = Number(zip64Eocd.getBigUint64(32, true));
    cdSize = Number(zip64Eocd.getBigUint64(40, true));
    cdOffset = Number(zip64Eocd.getBigUint64(48, true));
  }

  if (!isSafeZipNumber(totalEntries) || !isSafeZipNumber(cdSize) || !isSafeZipNumber(cdOffset)) {
    throw new ArchiveValidationError("not_zip", "ZIP central directory contains unsafe 64-bit values");
  }
  if (totalEntries > MAX_ENTRIES) {
    throw new ArchiveValidationError("size", `archive contains too many entries (>${MAX_ENTRIES})`);
  }
  if (cdSize > size || cdOffset > size - cdSize) {
    throw new ArchiveValidationError("not_zip", "central directory extends past end of file");
  }
  return { size, cdOffset, cdSize, totalEntries };
}

/**
 * Fast-path verifier: parses the ZIP central directory, finds manifest.json,
 * reads only its bytes, and parses the manifest. Memory stays bounded to the
 * tail window, one central-directory page, and the manifest bytes regardless
 * of total archive size. Throws ArchiveValidationError if the archive's
 * central directory can't be located or manifest.json is absent.
 *
 * Supports ZIP64 (PPAPP 6.2): when the standard EOCD reports 0xFFFFFFFF /
 * 0xFFFF sentinels, we read the ZIP64 EOCD locator sitting immediately
 * before the EOCD and the ZIP64 EOCD record it points to, and resolve the
 * real 64-bit cdSize / cdOffset / totalEntries. Per-entry 64-bit overrides
 * in the central directory's extra field (tag 0x0001) are honoured when
 * the standard 32-bit fields are the 0xFFFFFFFF sentinel.
 */
export async function verifyArchiveFast(archivePath: string): Promise<ArchiveManifest> {
  const file = Bun.file(archivePath);
  const { size, cdOffset, cdSize, totalEntries } = await locateCentralDirectory(file);

  const manifestEntry = await findManifestInCentralDirectory(
    file,
    cdOffset,
    cdSize,
    totalEntries,
  );
  if (!manifestEntry) {
    throw new ArchiveValidationError("no_manifest", "archive central directory has no manifest.json");
  }
  if (manifestEntry.uncompressedSize > MAX_MANIFEST_BYTES) {
    throw new ArchiveValidationError(
      "bad_manifest",
      `manifest.json declares ${manifestEntry.uncompressedSize} bytes (cap ${MAX_MANIFEST_BYTES})`,
    );
  }
  if (manifestEntry.compressedSize > MAX_MANIFEST_COMPRESSED_BYTES) {
    throw new ArchiveValidationError(
      "bad_manifest",
      `manifest.json declares ${manifestEntry.compressedSize} compressed bytes (cap ${MAX_MANIFEST_COMPRESSED_BYTES})`,
    );
  }
  if (manifestEntry.compression !== 0 && manifestEntry.compression !== 8) {
    throw new ArchiveValidationError(
      "bad_manifest",
      `manifest.json uses unsupported compression method ${manifestEntry.compression}`,
    );
  }

  // Read the local file header to find where the manifest's compressed data
  // actually starts (the LFH may carry extra fields the CDH doesn't mirror).
  const lfhHeader = await readBytes(
    file,
    manifestEntry.localHeaderOffset,
    manifestEntry.localHeaderOffset + 30,
  );
  if (lfhHeader.length < 30) {
    throw new ArchiveValidationError("bad_manifest", "manifest local file header truncated");
  }
  const lfhView = new DataView(lfhHeader.buffer, lfhHeader.byteOffset);
  if (lfhView.getUint32(0, true) !== LFH_SIG) {
    throw new ArchiveValidationError("bad_manifest", "manifest local file header signature invalid");
  }
  const lfhNameLen = lfhView.getUint16(26, true);
  const lfhExtraLen = lfhView.getUint16(28, true);
  const dataStart = manifestEntry.localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
  const dataEnd = dataStart + manifestEntry.compressedSize;
  if (dataEnd > size) {
    throw new ArchiveValidationError("bad_manifest", "manifest data extends past end of file");
  }
  const compressed = await readBytes(file, dataStart, dataEnd);
  let bytes: Uint8Array;
  try {
    bytes =
      manifestEntry.compression === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: MAX_MANIFEST_BYTES });
  } catch (err) {
    throw new ArchiveValidationError(
      "bad_manifest",
      `manifest.json decompression failed: ${(err as Error).message}`,
    );
  }
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new ArchiveValidationError(
      "bad_manifest",
      `manifest.json decompressed to ${bytes.byteLength} bytes (cap ${MAX_MANIFEST_BYTES})`,
    );
  }
  try {
    const text = new TextDecoder().decode(bytes);
    return parseManifest(JSON.parse(text));
  } catch (err) {
    throw new ArchiveValidationError(
      "bad_manifest",
      `manifest.json parse failed: ${(err as Error).message}`,
    );
  }
}

/**
 * Compatibility entry point retained for callers and tests. The previous
 * fallback fed arbitrary archive chunks through fflate, whose output allocation
 * is not bounded by the input window. The ZIP64-aware central-directory
 * verifier above handles Lumiverse archives directly, so malformed or exotic
 * archives now fail closed instead of entering an unbounded fallback path.
 */
export async function verifyArchive(archivePath: string): Promise<ArchiveManifest> {
  return verifyArchiveFast(archivePath);
}

/**
 * Start a background import job. Returns the jobId immediately; progress
 * is reported via the WebSocket EventBus.
 */
export function startImport(opts: {
  userId: string;
  archivePath: string;
  jobId: string;
}): ImportJob {
  const existingJobId = USER_RUNNING.get(opts.userId);
  const reservation = USER_UPLOAD_RESERVATIONS.get(opts.userId);
  if (
    existingJobId ||
    (reservation !== undefined && reservation !== opts.jobId) ||
    (globalImportSlot !== null && globalImportSlot !== opts.jobId)
  ) {
    throw new Error("an import is already running for this user");
  }
  // Build the optional ticket gate up front so the route handlers can resolve
  // it the moment a ticket arrives, even if the job is still mid-extraction.
  let ticketResolver: (v: { ticket: DecryptionTicket; smk: Uint8Array } | null) => void = () => {};
  const ticketGate = new Promise<{ ticket: DecryptionTicket; smk: Uint8Array } | null>(
    (resolve) => {
      ticketResolver = resolve;
    },
  );
  const job: ImportJob = {
    jobId: opts.jobId,
    userId: opts.userId,
    status: "queued",
    archivePath: opts.archivePath,
    startedAt: Math.floor(Date.now() / 1000),
    finishedAt: null,
    manifest: null,
    summary: {},
    fileSummary: {},
    error: null,
    abort: new AbortController(),
    ticketGate,
    ticketResolver,
    ticketReused: false,
    secretsRestored: 0,
  };
  JOBS.set(job.jobId, job);
  USER_RUNNING.set(job.userId, job.jobId);
  globalImportSlot = job.jobId;
  claimImportReservation(job.userId, job.jobId);
  void runImportJob(job).catch((err) => {
    console.error("[user-data import] uncaught:", err);
  });
  return job;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emit(job: ImportJob, type: EventType, payload: Record<string, any>): void {
  try {
    eventBus.emit(type, { jobId: job.jobId, ...payload }, job.userId);
  } catch {
    /* progress is best-effort */
  }
}

async function yieldAndCheck(signal: AbortSignal): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, YIELD_INTERVAL_MS));
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

function getTableColumns(table: string): string[] {
  return (
    getDb()
      .query(`PRAGMA table_info(${ident(table)})`)
      .all() as { name: string }[]
  ).map((c) => c.name);
}

function tableExists(table: string): boolean {
  const row = getDb()
    .query("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
    .get(table) as { name: string } | null;
  return !!row;
}

function isSecretSettingKey(key: string): boolean {
  for (const re of SECRET_SETTING_KEY_PATTERNS) {
    if (re.test(key)) return true;
  }
  return false;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Staged entry metadata
//
// Text entries are few and retained in memory for topological application.
// Potentially numerous binary descriptors are journaled to disk instead.
// ---------------------------------------------------------------------------

interface BufferedTextEntry {
  kind: "text";
  table: string;
  origin: "database" | "lancedb";
  // Stored on disk to keep memory bounded.
  stagingPath: string;
  byteSize: number;
}

interface BufferedBinaryEntry {
  kind: "binary";
  bucket: NonNullable<SanitizedEntry["bucket"]>;
  inner: string;
  stagingPath: string;
  byteSize: number;
}

interface ImportBuffer {
  entries: BufferedTextEntry[];
  binaryJournalPath: string;
  binaryEntryCount: number;
  manifest: ArchiveManifest | null;
  totalDecompressed: number;
  entryCount: number;
  stagingDir: string;
}

/** Write a complete Uint8Array even if the OS performs a short write. */
function writeAllSync(fd: number, chunk: Uint8Array): void {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const written = writeSync(fd, chunk, offset, chunk.byteLength - offset);
    if (written <= 0) throw new Error("archive staging write made no progress");
    offset += written;
  }
}

// ZIP uses the IEEE CRC-32 polynomial. Keep the running state inverted so
// chunks can be fed to it without allocating one concatenated entry buffer.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < table.length; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function updateCrc32(state: number, bytes: Uint8Array): number {
  let next = state;
  for (const byte of bytes) {
    next = (CRC32_TABLE[(next ^ byte) & 0xff] ^ (next >>> 8)) >>> 0;
  }
  return next;
}

function finishCrc32(state: number): number {
  return (state ^ 0xffffffff) >>> 0;
}

const NDJSON_NEWLINE = new Uint8Array([0x0a]);

/**
 * Repair a narrow, known failure mode in pre-ZIP64 exports.
 *
 * The old fflate async writer occasionally duplicated portions of an NDJSON
 * stream while retaining the size and CRC of the intended stream. Every
 * affected Lumiverse table is ID-keyed, so retaining the first raw line for
 * each ID recreates the original byte stream. We only accept the repair when
 * it reproduces both pieces of ZIP metadata exactly; malformed or unrelated
 * archives continue through the normal validation failure.
 */
async function recoverLegacyDuplicatedNdjson(
  stagingPath: string,
  expectedSize: number,
  expectedCrc32: number,
  signal: AbortSignal,
): Promise<number | null> {
  const repairedPath = `${stagingPath}.recovered`;
  const readBuffer = new Uint8Array(ARCHIVE_READ_BYTES);
  const decoder = new TextDecoder();
  const seenIds = new Set<string>();
  const fragments: Uint8Array[] = [];
  let lineBytes = 0;
  let retainedBytes = 0;
  let crcState = 0xffffffff;
  let inputFd: number | null = null;
  let outputFd: number | null = null;
  let repaired = false;

  const appendFragment = (fragment: Uint8Array): boolean => {
    if (fragment.byteLength === 0) return true;
    if (lineBytes + fragment.byteLength > LEGACY_MAX_NDJSON_LINE_BYTES) return false;
    // The read buffer is reused, so retain a bounded copy for this line.
    fragments.push(fragment.slice());
    lineBytes += fragment.byteLength;
    return true;
  };

  const consumeLine = (): boolean => {
    if (lineBytes === 0) return false;
    const line = new Uint8Array(lineBytes);
    let offset = 0;
    for (const fragment of fragments) {
      line.set(fragment, offset);
      offset += fragment.byteLength;
    }
    fragments.length = 0;
    lineBytes = 0;

    let id: unknown;
    try {
      id = JSON.parse(decoder.decode(line))?.id;
    } catch {
      return false;
    }
    if (typeof id !== "string" || id.length === 0) return false;
    if (seenIds.has(id)) return true;
    seenIds.add(id);
    writeAllSync(outputFd!, line);
    writeAllSync(outputFd!, NDJSON_NEWLINE);
    crcState = updateCrc32(crcState, line);
    crcState = updateCrc32(crcState, NDJSON_NEWLINE);
    retainedBytes += line.byteLength + NDJSON_NEWLINE.byteLength;
    return true;
  };

  try {
    try {
      unlinkSync(repairedPath);
    } catch {
      /* no leftover repair file */
    }
    inputFd = openSync(stagingPath, "r");
    outputFd = openSync(repairedPath, "w");
    let position = 0;
    let bytesSinceYield = 0;

    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("import cancelled");
      const read = readSync(inputFd, readBuffer, 0, readBuffer.byteLength, position);
      if (read <= 0) break;
      position += read;
      bytesSinceYield += read;

      let start = 0;
      for (let i = 0; i < read; i++) {
        if (readBuffer[i] !== 0x0a) continue;
        if (!appendFragment(readBuffer.subarray(start, i)) || !consumeLine()) return null;
        start = i + 1;
      }
      if (!appendFragment(readBuffer.subarray(start, read))) return null;

      if (bytesSinceYield >= 4 * 1024 * 1024) {
        bytesSinceYield = 0;
        await yieldAndCheck(signal);
      }
    }

    // Lumiverse's exporter writes a newline after every NDJSON object. A
    // trailing partial line is not eligible for the compatibility repair.
    if (lineBytes !== 0) return null;
    if (retainedBytes !== expectedSize || finishCrc32(crcState) !== expectedCrc32) return null;

    closeSync(outputFd);
    outputFd = null;
    closeSync(inputFd);
    inputFd = null;
    renameSync(repairedPath, stagingPath);
    repaired = true;
    return retainedBytes;
  } finally {
    if (outputFd !== null) closeSync(outputFd);
    if (inputFd !== null) closeSync(inputFd);
    if (!repaired) {
      try {
        unlinkSync(repairedPath);
      } catch {
        /* no repair artifact to remove */
      }
    }
  }
}

function readExactSync(fd: number, position: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const read = readSync(fd, out, offset, length - offset, position + offset);
    if (read <= 0) throw new ArchiveValidationError("not_zip", "archive is truncated");
    offset += read;
  }
  return out;
}

function readCappedTextFile(path: string, maxBytes: number, label: string): string {
  const size = statSync(path).size;
  if (size > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
  const fd = openSync(path, "r");
  try {
    return new TextDecoder().decode(readExactSync(fd, 0, size));
  } finally {
    closeSync(fd);
  }
}

function entryTextLimit(entry: BufferedTextEntry): number | null {
  switch (entry.table) {
    case "__manifest__":
      return MAX_MANIFEST_BYTES;
    case "__manifest_stats__":
      return MAX_MANIFEST_STATS_BYTES;
    case "__secrets_index__":
      return MAX_SECRETS_INDEX_BYTES;
    default:
      return null;
  }
}

function assertExtractionDiskCapacity(
  stagingDir: string,
  stagedBytes: number,
  binaryBytes: number,
): void {
  try {
    const fs = statfsSync(stagingDir);
    // Binary files are staged first and copied into their final locations
    // before staging is removed, so their bytes are briefly present twice.
    const required = BigInt(stagedBytes) + BigInt(binaryBytes) + BigInt(IMPORT_DISK_HEADROOM_BYTES);
    const available = BigInt(fs.bavail) * BigInt(fs.bsize);
    if (available < required) {
      throw new Error(
        `insufficient free disk for import (need ${required} bytes, have ${available} bytes)`,
      );
    }
  } catch (err) {
    // The capacity error is actionable; an unsupported statfs implementation
    // should not prevent an otherwise-valid import from attempting its normal
    // write-time ENOSPC handling.
    if (err instanceof Error && err.message.startsWith("insufficient free disk")) {
      throw err;
    }
    console.warn("[user-data import] unable to preflight free disk space:", err);
  }
}

/** Return the exact compressed-data range for one central-directory entry. */
function getLocalDataOffset(
  archiveFd: number,
  archiveSize: number,
  entry: CentralDirEntry,
): number {
  if ((entry.flags & 0x1) !== 0) {
    throw new ArchiveValidationError("not_zip", `encrypted ZIP entries are not supported (${entry.name})`);
  }
  if (entry.compression !== 0 && entry.compression !== 8) {
    throw new ArchiveValidationError("not_zip", `unsupported ZIP compression method ${entry.compression}`);
  }
  if (entry.localHeaderOffset > archiveSize - 30) {
    throw new ArchiveValidationError("not_zip", `local file header is truncated for ${entry.name}`);
  }
  const header = readExactSync(archiveFd, entry.localHeaderOffset, 30);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint32(0, true) !== LFH_SIG) {
    throw new ArchiveValidationError("not_zip", `local file header signature invalid for ${entry.name}`);
  }
  const localFlags = view.getUint16(6, true);
  const localCompression = view.getUint16(8, true);
  if ((localFlags & 0x1) !== 0 || localCompression !== entry.compression) {
    throw new ArchiveValidationError("not_zip", `local file header disagrees with directory for ${entry.name}`);
  }
  const nameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
  if (!isSafeZipNumber(dataStart) || dataStart > archiveSize - entry.compressedSize) {
    throw new ArchiveValidationError("not_zip", `entry data extends past end of archive (${entry.name})`);
  }
  const localName = new TextDecoder().decode(readExactSync(archiveFd, entry.localHeaderOffset + 30, nameLen));
  if (localName !== entry.name) {
    throw new ArchiveValidationError("not_zip", `local file name disagrees with directory for ${entry.name}`);
  }
  return dataStart;
}

async function copyStoredEntry(
  archiveFd: number,
  dataStart: number,
  compressedSize: number,
  onChunk: (chunk: Uint8Array) => void,
  signal: AbortSignal,
): Promise<void> {
  const buffer = new Uint8Array(ARCHIVE_READ_BYTES);
  let offset = 0;
  let bytesSinceYield = 0;
  while (offset < compressedSize) {
    if (signal.aborted) throw signal.reason ?? new Error("import cancelled");
    const wanted = Math.min(buffer.byteLength, compressedSize - offset);
    const read = readSync(archiveFd, buffer, 0, wanted, dataStart + offset);
    if (read <= 0) throw new ArchiveValidationError("not_zip", "archive entry is truncated");
    onChunk(buffer.subarray(0, read));
    offset += read;
    bytesSinceYield += read;
    if (bytesSinceYield >= 4 * 1024 * 1024) {
      bytesSinceYield = 0;
      await yieldAndCheck(signal);
    }
  }
}

async function inflateEntry(
  archivePath: string,
  dataStart: number,
  compressedSize: number,
  onChunk: (chunk: Uint8Array) => void,
  signal: AbortSignal,
): Promise<void> {
  if (compressedSize === 0) {
    // Empty entries are valid when their central-directory output size is
    // also zero; the caller validates that exact size after this returns.
    return;
  }
  const source = createReadStream(archivePath, {
    start: dataStart,
    end: dataStart + compressedSize - 1,
    highWaterMark: ARCHIVE_READ_BYTES,
  });
  const inflater = createInflateRaw({ chunkSize: INFLATE_OUTPUT_BYTES });
  source.pipe(inflater);
  try {
    for await (const chunk of inflater) {
      if (signal.aborted) throw signal.reason ?? new Error("import cancelled");
      onChunk(chunk as Uint8Array);
    }
  } finally {
    source.destroy();
    inflater.destroy();
  }
}

// ---------------------------------------------------------------------------
// Phase 1: extract archive into staging
// ---------------------------------------------------------------------------

async function extractArchive(job: ImportJob): Promise<ImportBuffer> {
  const stagingDir = join(dirname(job.archivePath), "staging");
  ensureDir(stagingDir);
  const binaryJournalPath = join(stagingDir, "binary-entries.ndjson");

  const buf: ImportBuffer = {
    entries: [],
    binaryJournalPath,
    binaryEntryCount: 0,
    manifest: null,
    totalDecompressed: 0,
    entryCount: 0,
    stagingDir,
  };

  // The legacy recovery path below is intentionally limited to archives
  // emitted before the fixed-window format marker existed. Reading this
  // small manifest here also gives direct callers of startImport the same
  // validation the HTTP upload route performs.
  const verifiedManifest = await verifyArchiveFast(job.archivePath);
  const canRecoverLegacyAsyncNdjson = verifiedManifest.ndjsonFormatVersion === undefined;
  const archive = Bun.file(job.archivePath);
  const { size: archiveSize, cdOffset, cdSize, totalEntries } = await locateCentralDirectory(archive);
  let declaredDecompressedBytes = 0;
  let declaredBinaryBytes = 0;
  for await (const entry of scanCentralDirectory(archive, cdOffset, cdSize, totalEntries)) {
    // Validate every name before allocating any staging files, and reject a
    // declared expansion beyond the global cap before decompression begins.
    const descriptor = sanitizeEntry(entry.name);
    if (entry.uncompressedSize > MAX_DECOMPRESSED_BYTES - declaredDecompressedBytes) {
      throw new Error(`archive exceeds decompressed size cap (${MAX_DECOMPRESSED_BYTES} bytes)`);
    }
    declaredDecompressedBytes += entry.uncompressedSize;
    if (descriptor.kind === "files") declaredBinaryBytes += entry.uncompressedSize;
  }
  assertExtractionDiskCapacity(stagingDir, declaredDecompressedBytes, declaredBinaryBytes);

  const archiveFd = openSync(job.archivePath, "r");
  const journalFd = openSync(binaryJournalPath, "w");
  const encoder = new TextEncoder();

  try {
    for await (const centralEntry of scanCentralDirectory(archive, cdOffset, cdSize, totalEntries)) {
      if (job.abort.signal.aborted) {
        throw job.abort.signal.reason ?? new Error("import cancelled");
      }
      const descriptor = sanitizeEntry(centralEntry.name);
      buf.entryCount++;

      const stagingPath = join(stagingDir, `${buf.entryCount.toString(36)}.bin`);
      let entry: BufferedTextEntry | BufferedBinaryEntry;
      switch (descriptor.kind) {
        case "manifest":
          entry = {
            kind: "text",
            table: descriptor.inner === "manifest-stats.json" ? "__manifest_stats__" : "__manifest__",
            origin: "database",
            stagingPath,
            byteSize: 0,
          };
          break;
        case "database":
        case "lancedb":
          entry = {
            kind: "text",
            table: descriptor.table ?? "manifest",
            origin: descriptor.kind === "lancedb" ? "lancedb" : "database",
            stagingPath,
            byteSize: 0,
          };
          break;
        case "secrets":
          entry = {
            kind: "text",
            table: descriptor.inner === "encrypted.ndjson" ? "__secrets_encrypted__" : "__secrets_index__",
            origin: "database",
            stagingPath,
            byteSize: 0,
          };
          break;
        case "files":
          entry = {
            kind: "binary",
            bucket: descriptor.bucket!,
            inner: descriptor.inner,
            stagingPath,
            byteSize: 0,
          };
          break;
      }

      const textLimit = entry.kind === "text" ? entryTextLimit(entry) : null;
      if (textLimit !== null && centralEntry.uncompressedSize > textLimit) {
        throw new Error(`${centralEntry.name} exceeds ${textLimit} bytes`);
      }
      if (entry.kind === "text" && buf.entries.length >= MAX_TEXT_ENTRIES) {
        throw new Error(`archive contains too many text entries (>${MAX_TEXT_ENTRIES})`);
      }

      const dataStart = getLocalDataOffset(archiveFd, archiveSize, centralEntry);
      const stagingFd = openSync(stagingPath, "w");
      let crcState = 0xffffffff;
      try {
        const onChunk = (chunk: Uint8Array) => {
          if (buf.totalDecompressed + chunk.byteLength > MAX_DECOMPRESSED_BYTES) {
            throw new Error(`archive exceeds decompressed size cap (${MAX_DECOMPRESSED_BYTES} bytes)`);
          }
          if (textLimit !== null && entry.byteSize + chunk.byteLength > textLimit) {
            throw new Error(`${centralEntry.name} exceeds ${textLimit} bytes`);
          }
          writeAllSync(stagingFd, chunk);
          crcState = updateCrc32(crcState, chunk);
          entry.byteSize += chunk.byteLength;
          buf.totalDecompressed += chunk.byteLength;
        };
        if (centralEntry.compression === 0) {
          await copyStoredEntry(
            archiveFd,
            dataStart,
            centralEntry.compressedSize,
            onChunk,
            job.abort.signal,
          );
        } else {
          await inflateEntry(
            job.archivePath,
            dataStart,
            centralEntry.compressedSize,
            onChunk,
            job.abort.signal,
          );
        }
      } finally {
        closeSync(stagingFd);
      }

      const actualByteSize = entry.byteSize;
      const actualCrc32 = finishCrc32(crcState);
      if (
        actualByteSize !== centralEntry.uncompressedSize ||
        actualCrc32 !== centralEntry.crc32
      ) {
        let repairedSize: number | null = null;
        if (
          canRecoverLegacyAsyncNdjson &&
          (descriptor.kind === "database" || descriptor.kind === "lancedb")
        ) {
          repairedSize = await recoverLegacyDuplicatedNdjson(
            stagingPath,
            centralEntry.uncompressedSize,
            centralEntry.crc32,
            job.abort.signal,
          );
        }
        if (repairedSize !== null) {
          // The duplicate bytes were counted against the extraction cap as
          // they were streamed. Replace that accounting with the verified
          // original entry size before continuing.
          buf.totalDecompressed -= actualByteSize - repairedSize;
          entry.byteSize = repairedSize;
          console.warn(
            `[user-data import] recovered duplicated legacy NDJSON entry: ${centralEntry.name}`,
          );
        } else if (actualByteSize !== centralEntry.uncompressedSize) {
          throw new ArchiveValidationError(
            "not_zip",
            `entry size disagrees with central directory (${centralEntry.name}; declared ${centralEntry.uncompressedSize}, extracted ${actualByteSize})`,
          );
        } else {
          throw new ArchiveValidationError(
            "not_zip",
            `entry CRC32 disagrees with central directory (${centralEntry.name})`,
          );
        }
      }
      if (entry.kind === "binary") {
        writeAllSync(journalFd, encoder.encode(`${JSON.stringify(entry)}\n`));
        buf.binaryEntryCount++;
      } else {
        buf.entries.push(entry);
      }

      if ((buf.entryCount & 15) === 0) await yieldAndCheck(job.abort.signal);
    }
  } finally {
    closeSync(journalFd);
    closeSync(archiveFd);
  }

  // Find and parse the manifest. If absent the archive is invalid.
  const manifestEntry = buf.entries.find((e) => e.table === "__manifest__");
  if (!manifestEntry) {
    throw new Error("archive is missing manifest.json");
  }
  const manifestText = readCappedTextFile(manifestEntry.stagingPath, MAX_MANIFEST_BYTES, "manifest.json");
  let raw: unknown;
  try {
    raw = JSON.parse(manifestText);
  } catch (err) {
    throw new Error(`manifest.json is not valid JSON: ${(err as Error).message}`);
  }
  buf.manifest = parseManifest(raw);

  // Merge in the optional stats trailer (counts + missingFiles).
  const statsEntry = buf.entries.find((e) => e.table === "__manifest_stats__");
  if (statsEntry) {
    try {
      const statsText = readCappedTextFile(
        statsEntry.stagingPath,
        MAX_MANIFEST_STATS_BYTES,
        "manifest-stats.json",
      );
      const stats = JSON.parse(statsText) as {
        counts?: Record<string, number>;
        missingFiles?: string[];
      };
      if (stats?.counts) buf.manifest.counts = stats.counts;
      if (Array.isArray(stats?.missingFiles)) buf.manifest.missingFiles = stats.missingFiles;
    } catch {
      /* trailer is optional; ignore parse failure */
    }
  }

  return buf;
}

// ---------------------------------------------------------------------------
// Phase 2: apply database rows in topological order
// ---------------------------------------------------------------------------

interface ApplyContext {
  userId: string;
  signal: AbortSignal;
  job: ImportJob;
  /** Per-record cap selected from the archive manifest after extraction. */
  ndjsonLineBytes: number;
}

/**
 * New archives carry an explicit format marker and are limited to 4 MiB per
 * record. Archives without it predate the fixed-window export format and use
 * the compatibility ceiling. Both paths remain bounded.
 */
function ndjsonLineLimitForManifest(manifest: ArchiveManifest | null): number {
  if ((manifest?.ndjsonFormatVersion ?? 0) >= NDJSON_FORMAT_VERSION) {
    return MAX_NDJSON_LINE_BYTES;
  }
  return LEGACY_MAX_NDJSON_LINE_BYTES;
}

/**
 * Read an NDJSON file line-by-line, yielding parsed objects. Enforces the
 * per-line size cap.
 */
async function* readNdjson(
  path: string,
  maxLineBytes: number = MAX_NDJSON_LINE_BYTES,
): AsyncGenerator<Record<string, any>> {
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(ARCHIVE_READ_BYTES);
  const fragments: Uint8Array[] = [];
  let lineBytes = 0;
  const fd = openSync(path, "r");
  let position = 0;

  const append = (chunk: Uint8Array) => {
    if (chunk.byteLength === 0) return;
    if (lineBytes + chunk.byteLength > maxLineBytes) {
      throw new Error(`NDJSON line exceeds ${maxLineBytes} bytes`);
    }
    // The read buffer is reused, so retain only this bounded copy.
    fragments.push(chunk.slice());
    lineBytes += chunk.byteLength;
  };
  const consumeLine = (): Record<string, any> | null => {
    if (lineBytes === 0) return null;
    const bytes = new Uint8Array(lineBytes);
    let offset = 0;
    for (const fragment of fragments) {
      bytes.set(fragment, offset);
      offset += fragment.byteLength;
    }
    fragments.length = 0;
    lineBytes = 0;
    const line = decoder.decode(bytes);
    return line.trim().length > 0 ? JSON.parse(line) : null;
  };

  try {
    while (true) {
      const read = readSync(fd, buffer, 0, buffer.byteLength, position);
      if (read <= 0) break;
      position += read;
      let start = 0;
      for (let i = 0; i < read; i++) {
        if (buffer[i] !== 0x0a) continue;
        append(buffer.subarray(start, i));
        const row = consumeLine();
        if (row) yield row;
        start = i + 1;
      }
      append(buffer.subarray(start, read));
    }
    const finalRow = consumeLine();
    if (finalRow) yield finalRow;
  } finally {
    closeSync(fd);
  }
}

/**
 * Deep-merge an imported settings.value JSON onto an existing one. Designed
 * for "container" settings like `imageGeneration` where the value is a flat
 * config object with one or more id-keyed arrays nested inside (e.g.
 * `promptPresets`). The merge rules:
 *
 *   - Top-level scalar fields: existing wins (preserves the target user's
 *     explicit choices like activeImageGenConnectionId, fade times, etc.).
 *   - Top-level fields missing on the target: restored from the imported value.
 *   - Top-level arrays whose elements all carry an `id` string: union by id,
 *     existing items preserved verbatim, imported items appended in their
 *     archive order.
 *   - Non-object values (strings, numbers, plain arrays, scalars at top): the
 *     existing value wins.
 *
 * The merge is intentionally non-destructive on the target. A user who set
 * up image-gen on the target before importing keeps their connection ID,
 * thresholds, etc., but gains all of the prompt presets they previously
 * authored on the source instance — so persona/character bindings that
 * reference those preset IDs resolve cleanly instead of 404'ing.
 */
function mergeSettingValue(existingValue: unknown, importedValue: unknown): unknown {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  // An id-shaped array: every element is an object carrying an `id` string.
  // The "shape" gets inferred from the imported side (which definitely has
  // contents) — that way an EMPTY existing array (e.g. promptPresets: []
  // auto-written by getImageGenSettings before the user has authored any
  // presets) still picks up the imported items instead of winning by being
  // a no-op array.
  const isIdArray = (v: unknown): v is Array<Record<string, unknown>> =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => x && typeof x === "object" && typeof (x as any).id === "string");
  const isIdArrayOrEmpty = (v: unknown): v is Array<Record<string, unknown>> =>
    Array.isArray(v) &&
    v.every((x) => x && typeof x === "object" && typeof (x as any).id === "string");

  if (!isPlainObject(existingValue) || !isPlainObject(importedValue)) {
    return existingValue;
  }
  const result: Record<string, unknown> = { ...existingValue };
  for (const [k, importedField] of Object.entries(importedValue)) {
    const existingField = (existingValue as any)[k];
    if (existingField === undefined || existingField === null) {
      result[k] = importedField;
      continue;
    }
    // Merge an id-keyed array if the imported side actually has shape (so
    // we can tell it's meant to be id-merged), and the existing side is
    // either also an id-array or an empty array we can union into.
    if (isIdArray(importedField) && isIdArrayOrEmpty(existingField)) {
      const seen = new Set<string>();
      const merged: Array<Record<string, unknown>> = [];
      for (const item of existingField) {
        const id = String(item.id);
        if (!seen.has(id)) {
          merged.push(item);
          seen.add(id);
        }
      }
      for (const item of importedField) {
        const id = String(item.id);
        if (!seen.has(id)) {
          merged.push(item);
          seen.add(id);
        }
      }
      result[k] = merged;
      continue;
    }
    // Default: existing wins for this field.
  }
  return result;
}

/**
 * Settings have a composite PK (key, user_id) and the `value` column is a
 * TEXT-encoded JSON blob. INSERT OR IGNORE on conflict means a target row
 * that the app auto-populates (e.g. `imageGeneration` on first image-gen
 * access) silently swallows the imported value — losing nested data like
 * the `promptPresets` array. We handle settings explicitly: parse both
 * sides, deep-merge with `mergeSettingValue`, and UPSERT.
 */
async function applySettingsTable(
  ctx: ApplyContext,
  stagingPath: string,
): Promise<{ imported: number; skipped: number; merged: number }> {
  if (!tableExists("settings")) return { imported: 0, skipped: 0, merged: 0 };
  const db = getDb();
  const selectStmt = db.prepare(
    "SELECT value FROM settings WHERE key = ? AND user_id = ?",
  );
  const insertStmt = db.prepare(
    "INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, ?)",
  );
  const updateStmt = db.prepare(
    "UPDATE settings SET value = ?, updated_at = ? WHERE key = ? AND user_id = ?",
  );

  let imported = 0;
  let merged = 0;
  let skipped = 0;
  let lineCount = 0;

  for await (const raw of readNdjson(stagingPath, ctx.ndjsonLineBytes)) {
    if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error("import cancelled");
    const key = typeof raw.key === "string" ? raw.key : null;
    if (!key) continue;
    if (isSecretSettingKey(key)) {
      skipped++;
      continue;
    }

    const importedValueText = typeof raw.value === "string" ? raw.value : JSON.stringify(raw.value);
    const updatedAt = Math.floor(Date.now() / 1000);

    const existing = selectStmt.get(key, ctx.userId) as { value: string } | null;
    if (!existing) {
      insertStmt.run(key, importedValueText, ctx.userId, updatedAt);
      imported++;
    } else {
      // Both rows present — attempt a deep merge.
      let importedValue: unknown;
      let existingValue: unknown;
      try {
        importedValue = JSON.parse(importedValueText);
      } catch {
        importedValue = importedValueText;
      }
      try {
        existingValue = JSON.parse(existing.value);
      } catch {
        existingValue = existing.value;
      }
      const mergedValue = mergeSettingValue(existingValue, importedValue);
      // If merge produced no change, count as skipped; otherwise UPDATE.
      const mergedText = JSON.stringify(mergedValue);
      if (mergedText === existing.value) {
        skipped++;
      } else {
        updateStmt.run(mergedText, updatedAt, key, ctx.userId);
        merged++;
      }
    }

    lineCount++;
    if (lineCount % ROW_BATCH === 0) {
      emit(ctx.job, EventType.USER_IMPORT_PROGRESS, {
        phase: "table",
        table: "settings",
        processed: lineCount,
      });
      await yieldAndCheck(ctx.signal);
    }
  }

  ctx.job.summary["settings"] = { imported: imported + merged, skipped };
  emit(ctx.job, EventType.USER_IMPORT_PROGRESS, {
    phase: "table_done",
    table: "settings",
    imported,
    merged,
    skipped,
  });
  return { imported, skipped, merged };
}

/**
 * Apply one NDJSON table from staging into the live SQLite database using
 * INSERT OR IGNORE. Filters row columns to match the live schema (so an
 * imported row from a newer/older Lumiverse still applies cleanly) and
 * forces user_id to the importing user.
 *
 * The `settings` table is special-cased to `applySettingsTable` above so
 * container-style settings (`imageGeneration`, etc.) deep-merge instead of
 * skipping on key conflict.
 */
async function applyTable(
  ctx: ApplyContext,
  table: string,
  stagingPath: string,
): Promise<{ imported: number; skipped: number }> {
  if (EXCLUDED_TABLES.has(table)) return { imported: 0, skipped: 0 };
  if (!tableExists(table)) {
    // Schema mismatch (e.g. archive from a newer Lumiverse). Skip silently.
    return { imported: 0, skipped: 0 };
  }
  if (table === "settings") {
    const { imported, skipped, merged } = await applySettingsTable(ctx, stagingPath);
    return { imported: imported + merged, skipped };
  }
  const columns = getTableColumns(table);
  const columnSet = new Set(columns);

  const hasUserId = columnSet.has("user_id");
  const hasInstalledByUser = columnSet.has("installed_by_user_id");

  // Settings have a composite PK (key, user_id). Forcing user_id alone is
  // enough — INSERT OR IGNORE handles existing rows.
  let imported = 0;
  let skipped = 0;

  const db = getDb();
  let batch: Record<string, any>[] = [];

  const colList = columns.map(ident).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const insert = db.prepare(`INSERT OR IGNORE INTO ${ident(table)} (${colList}) VALUES (${placeholders})`);

  const commitBatch = () => {
    if (batch.length === 0) return;
    const txn = db.transaction((rows: Record<string, any>[]) => {
      for (const row of rows) {
        const values = columns.map((c) => {
          const v = row[c];
          if (v === undefined) return null;
          if (typeof v === "boolean") return v ? 1 : 0;
          return v;
        });
        const res = insert.run(...values);
        if (res.changes > 0) imported++;
        else skipped++;
      }
    });
    txn(batch);
    batch = [];
  };

  let lineCount = 0;
  for await (const raw of readNdjson(stagingPath, ctx.ndjsonLineBytes)) {
    if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error("import cancelled");

    // Defensive filter for the settings table.
    if (table === "settings" && typeof raw.key === "string" && isSecretSettingKey(raw.key)) {
      skipped++;
      continue;
    }

    // Strip unknown columns silently — archive may have richer columns than
    // the current schema (or vice-versa).
    const filtered: Record<string, any> = {};
    for (const k of Object.keys(raw)) {
      if (columnSet.has(k)) filtered[k] = raw[k];
    }
    if (hasUserId) filtered.user_id = ctx.userId;
    if (hasInstalledByUser) filtered.installed_by_user_id = ctx.userId;

    // Scrub has_api_key on connection tables — secrets aren't in the archive.
    if (columnSet.has("has_api_key")) filtered.has_api_key = 0;

    batch.push(filtered);
    lineCount++;

    if (batch.length >= ROW_BATCH) {
      commitBatch();
      emit(ctx.job, EventType.USER_IMPORT_PROGRESS, {
        phase: "table",
        table,
        processed: lineCount,
      });
      await yieldAndCheck(ctx.signal);
    }
  }
  commitBatch();

  ctx.job.summary[table] = { imported, skipped };
  emit(ctx.job, EventType.USER_IMPORT_PROGRESS, {
    phase: "table_done",
    table,
    imported,
    skipped,
  });
  return { imported, skipped };
}

// ---------------------------------------------------------------------------
// Phase 3: apply binary files
// ---------------------------------------------------------------------------

async function applyBinary(
  ctx: ApplyContext,
  entry: BufferedBinaryEntry,
): Promise<boolean> {
  const dest = (() => {
    switch (entry.bucket) {
      case "images":
      case "thumbnails":
        // Both go under data/images/ (thumbs live alongside originals).
        return safeJoin(join(env.dataDir, "images"), entry.inner);
      case "avatars":
        return safeJoin(join(env.dataDir, "avatars"), entry.inner);
      case "databank":
        // Re-namespace under the importing user's directory.
        return safeJoin(join(env.dataDir, "databank", ctx.userId), entry.inner);
      case "theme-assets":
        return safeJoin(join(env.dataDir, "theme-assets", ctx.userId), entry.inner);
      case "notification-sounds":
        return safeJoin(join(env.dataDir, "notification-sounds", ctx.userId), entry.inner);
    }
  })();
  if (!dest) return false;
  ensureDir(dirname(dest));

  if (entry.bucket === "notification-sounds") {
    // Re-validate audio magic bytes. We don't trust the archive blindly.
    const fd = openSync(entry.stagingPath, "r");
    const head = new Uint8Array(16);
    try {
      const read = readSync(fd, head, 0, head.byteLength, 0);
      if (read < head.byteLength) head.fill(0, Math.max(read, 0));
    } finally {
      closeSync(fd);
    }
    if (!detectAudioFormat(head)) {
      ctx.job.summary[`reject:${entry.bucket}`] = ctx.job.summary[`reject:${entry.bucket}`] || {
        imported: 0,
        skipped: 0,
      };
      ctx.job.summary[`reject:${entry.bucket}`].skipped++;
      return false;
    }
  }

  try {
    // Keep this a filesystem copy instead of Bun.write(Bun.file(...)) so a
    // large staged binary never re-enters Bun's Blob pipeline. EXCL makes the
    // non-destructive merge atomic if another request creates the file first.
    copyFileSync(entry.stagingPath, dest, fsConstants.COPYFILE_EXCL);
  } catch (err: any) {
    if (err?.code === "EEXIST") return false;
    throw err;
  }
  ctx.job.fileSummary[entry.bucket] = (ctx.job.fileSummary[entry.bucket] || 0) + 1;
  return true;
}

// ---------------------------------------------------------------------------
// Phase 4: optional LanceDB vector restore
// ---------------------------------------------------------------------------

async function applyLancedbVectors(
  ctx: ApplyContext,
  buf: ImportBuffer,
  archiveCfg: ArchiveEmbeddingConfig | null,
): Promise<void> {
  if (!buf.manifest?.includeVectors) return;

  let currentCfg: ArchiveEmbeddingConfig = { provider: null, model: null, dimension: null };
  try {
    const cfg = await getEmbeddingConfig(ctx.userId);
    currentCfg = {
      provider: cfg?.provider ?? null,
      model: (cfg as any)?.model ?? null,
      dimension: (cfg as any)?.dimension ?? null,
    };
  } catch {
    /* ignore */
  }

  if (!embeddingConfigsMatch(archiveCfg, currentCfg)) {
    emit(ctx.job, EventType.USER_IMPORT_PROGRESS, {
      phase: "lancedb_skipped",
      reason: "embedding config mismatch",
      archive: archiveCfg,
      current: currentCfg,
    });
    // Mark this user's chunks for re-vectorization so background workers pick
    // them up. Scope every UPDATE to the importer's data so we never touch
    // another user's vectorization state.
    try {
      const db = getDb();
      db.run(
        `UPDATE chat_chunks SET vectorized_at = NULL, vector_model = NULL
         WHERE chat_id IN (SELECT id FROM chats WHERE user_id = ?)`,
        [ctx.userId],
      );
      db.run(
        "UPDATE databank_chunks SET vectorized_at = NULL, vector_model = NULL WHERE user_id = ?",
        [ctx.userId],
      );
      db.run(
        `UPDATE world_book_entries SET vectorized = 0, vector_index_status = 'not_enabled'
         WHERE world_book_id IN (SELECT id FROM world_books WHERE user_id = ?)`,
        [ctx.userId],
      );
      db.run(
        `UPDATE memory_consolidations SET vectorized_at = NULL, vector_model = NULL
         WHERE chat_id IN (SELECT id FROM chats WHERE user_id = ?)`,
        [ctx.userId],
      );
    } catch {
      /* ignore */
    }
    return;
  }

  // Lazy import LanceDB only when we actually have vectors to restore.
  let lance: any;
  try {
    lance = await import("@lancedb/lancedb");
  } catch {
    return;
  }
  const uri = join(env.dataDir, "lancedb");
  let conn: any;
  try {
    conn = await lance.connect(uri);
  } catch {
    return;
  }

  for (const entry of buf.entries) {
    if (entry.kind !== "text" || entry.origin !== "lancedb") continue;
    if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error("import cancelled");

    const tableName = entry.table;
    let table: any;
    try {
      table = await conn.openTable(tableName);
    } catch {
      // Table doesn't exist yet — skip (a future vectorization run will create it).
      continue;
    }

    const batch: any[] = [];
    let restored = 0;
    for await (const row of readNdjson(entry.stagingPath, ctx.ndjsonLineBytes)) {
      let vector: Float32Array | null = null;
      if (typeof row.vector_b64 === "string" && row.vector_b64.length > 0) {
        const bytes = Buffer.from(row.vector_b64, "base64");
        if (bytes.byteLength % 4 === 0) {
          vector = new Float32Array(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength / 4,
          );
        }
      }
      const { vector_b64: _drop, ...rest } = row;
      batch.push({ ...rest, user_id: ctx.userId, vector });
      if (batch.length >= 256) {
        try {
          await table.add(batch);
        } catch (err) {
          console.warn(`[user-data import] LanceDB add failed for ${tableName}:`, err);
          break;
        }
        restored += batch.length;
        batch.length = 0;
        await yieldAndCheck(ctx.signal);
      }
    }
    if (batch.length > 0) {
      try {
        await table.add(batch);
        restored += batch.length;
      } catch (err) {
        console.warn(`[user-data import] LanceDB final add failed for ${tableName}:`, err);
      }
    }
    emit(ctx.job, EventType.USER_IMPORT_PROGRESS, {
      phase: "lancedb_table_done",
      table: tableName,
      restored,
    });
  }

  try {
    conn.close?.();
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Defensive cleanup pass that runs after FK enforcement is re-enabled.
 * Walks every nullable FK on a table we just imported and NULLs out
 * references whose target rows weren't in the archive (or were excluded
 * by INSERT OR IGNORE because the user already had a different row with
 * the same id). Scoped to the importing user so we never touch another
 * user's data.
 */
function scrubOrphanForeignKeys(userId: string): void {
  const db = getDb();
  // Each entry: [child_table, fk_column, parent_table]. All FK columns listed
  // here are declared ON DELETE SET NULL in the schema, so NULL is a safe
  // value at rest.
  const nullableFks: ReadonlyArray<readonly [string, string, string]> = [
    ["connection_profiles", "preset_id", "presets"],
    ["personas", "attached_world_book_id", "world_books"],
    ["personas", "image_id", "images"],
    ["characters", "image_id", "images"],
    ["images", "owner_character_id", "characters"],
    ["images", "owner_chat_id", "chats"],
    ["cortex_vaults", "source_chat_id", "chats"],
    ["dream_weaver_sessions", "persona_id", "personas"],
    ["dream_weaver_sessions", "connection_id", "connection_profiles"],
    ["dream_weaver_sessions", "character_id", "characters"],
    ["weaver_sessions", "persona_id", "personas"],
    ["weaver_sessions", "connection_id", "connection_profiles"],
    ["weaver_sessions", "character_id", "characters"],
    ["messages", "parent_message_id", "messages"],
  ];
  for (const [child, col, parent] of nullableFks) {
    // Only update rows belonging to the importing user. Tables without a
    // direct user_id column (e.g. messages) are scoped through their parent.
    try {
      const childCols = new Set(
        (db.query(`PRAGMA table_info(${ident(child)})`).all() as { name: string }[]).map(
          (c) => c.name,
        ),
      );
      if (!childCols.has(col)) continue;
      if (childCols.has("user_id")) {
        db.run(
          `UPDATE ${ident(child)} SET ${ident(col)} = NULL
           WHERE user_id = ?
             AND ${ident(col)} IS NOT NULL
             AND ${ident(col)} NOT IN (SELECT id FROM ${ident(parent)})`,
          [userId],
        );
      } else if (childCols.has("chat_id")) {
        // messages, memory_*, chat_chunks — owned via chat_id → chats.user_id
        db.run(
          `UPDATE ${ident(child)} SET ${ident(col)} = NULL
           WHERE chat_id IN (SELECT id FROM chats WHERE user_id = ?)
             AND ${ident(col)} IS NOT NULL
             AND ${ident(col)} NOT IN (SELECT id FROM ${ident(parent)})`,
          [userId],
        );
      }
    } catch (err) {
      // A schema mismatch (column removed in a future migration) — log and continue.
      console.warn(`[user-data import] orphan FK scrub on ${child}.${col} failed:`, err);
    }
  }
}

/** Memory-cortex weak links: memory_font_colors.entity_id is ON DELETE SET NULL. */
function scrubMemoryCortexOrphans(userId: string): void {
  const db = getDb();
  try {
    db.run(
      `UPDATE memory_font_colors SET entity_id = NULL
       WHERE chat_id IN (SELECT id FROM chats WHERE user_id = ?)
         AND entity_id IS NOT NULL
         AND entity_id NOT IN (SELECT id FROM memory_entities)`,
      [userId],
    );
  } catch (err) {
    console.warn(`[user-data import] memory cortex orphan scrub failed:`, err);
  }
}

/**
 * Stream the staged `secrets/encrypted.ndjson` from disk, decrypt each entry
 * with the ticket SMK, and re-encrypt the plaintext under the target
 * instance's identity key via `secretsSvc.putSecret`. The plaintext never
 * lands on disk and never leaves this function's locals.
 */
async function applySecrets(
  ctx: ApplyContext,
  stagingPath: string,
  smk: Uint8Array,
): Promise<{ restored: number; skipped: number }> {
  let restored = 0;
  let skipped = 0;
  for await (const raw of readNdjson(stagingPath, ctx.ndjsonLineBytes)) {
    if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error("import cancelled");
    const entry = raw as Partial<EncryptedSecretEntry>;
    if (
      typeof entry.key !== "string" ||
      typeof entry.iv !== "string" ||
      typeof entry.tag !== "string" ||
      typeof entry.ciphertext !== "string"
    ) {
      skipped++;
      continue;
    }
    let plaintext: string;
    try {
      plaintext = await decryptSecret(smk, entry as EncryptedSecretEntry);
    } catch (err) {
      console.warn(`[user-data import] secret decrypt failed for ${entry.key}:`, err);
      skipped++;
      continue;
    }
    try {
      await putSecret(ctx.userId, entry.key, plaintext);
      restored++;
    } catch (err) {
      console.warn(`[user-data import] secret re-encrypt failed for ${entry.key}:`, err);
      skipped++;
    }
    // Zero the plaintext local — best-effort; JS engines may keep copies.
    plaintext = "";
  }
  return { restored, skipped };
}

/**
 * Submit a parsed ticket to a job waiting in `awaiting_ticket`. Validates
 * shape + binding against the staged archive, then records the consumption
 * (idempotent — successive calls bump the `uses` counter). Returns the
 * reuse advisory so the route can surface it to the UI.
 */
export interface TicketSubmissionResult {
  /** True if this archive_id was previously consumed (advisory). */
  wasReused: boolean;
  /** When the previous use happened (Unix seconds); null on first use. */
  previouslyConsumedAt: number | null;
  /** Total number of times this ticket has been consumed (including this call). */
  uses: number;
}

export async function submitTicket(
  jobId: string,
  rawTicket: unknown,
): Promise<TicketSubmissionResult> {
  const job = JOBS.get(jobId);
  if (!job) throw new Error("import job not found");
  if (job.status !== "awaiting_ticket") {
    throw new Error(`import job is not awaiting a ticket (status: ${job.status})`);
  }
  if (!job.manifest?.archiveId) throw new Error("job has no manifest yet");
  const archiveSecretKeys = job.archiveSecretKeys || [];

  let verified;
  try {
    verified = await verifyTicket(rawTicket, job.manifest.archiveId, archiveSecretKeys);
  } catch (err) {
    if (err instanceof TicketError) throw err;
    throw new TicketError("malformed", String((err as Error).message ?? err));
  }

  const prior = lookupConsumedTicket(verified.ticket.archiveId);
  const wasReused = !!prior;
  const previouslyConsumedAt = prior?.consumedAt ?? null;

  const recorded = recordConsumedTicket(verified.ticket.archiveId, job.userId);
  job.ticketReused = wasReused;
  job.ticketResolver?.(verified);
  return { wasReused, previouslyConsumedAt, uses: recorded.uses };
}

/** Resolve the gate with no ticket — proceed without restoring secrets. */
export function skipTicket(jobId: string): boolean {
  const job = JOBS.get(jobId);
  if (!job) return false;
  if (job.status !== "awaiting_ticket") return false;
  job.ticketResolver?.(null);
  return true;
}

async function runImportJob(job: ImportJob): Promise<void> {
  job.status = "running";
  const ctx: ApplyContext = {
    userId: job.userId,
    signal: job.abort.signal,
    job,
    ndjsonLineBytes: MAX_NDJSON_LINE_BYTES,
  };
  emit(job, EventType.USER_IMPORT_PROGRESS, { phase: "start" });

  // FK enforcement is disabled only for the database-application phase. It
  // must stay enabled while a large archive is extracting or waiting for a
  // secrets ticket because this PRAGMA applies to the singleton connection.
  const db = getDb();
  let fkDisabled = false;
  let fkRestored = false;

  try {
    // Phase 1: extract.
    const buf = await extractArchive(job);
    job.manifest = buf.manifest;
    ctx.ndjsonLineBytes = ndjsonLineLimitForManifest(job.manifest);
    emit(job, EventType.USER_IMPORT_PROGRESS, { phase: "extracted", entries: buf.entryCount });

    // Surface the list of secret keys the archive carries (read from
    // secrets/index.json) so the ticket route can verify the binding hash
    // before resolving the gate.
    const secretsIndexEntry = buf.entries.find((e) => e.table === "__secrets_index__");
    if (secretsIndexEntry) {
      try {
        const text = readCappedTextFile(
          secretsIndexEntry.stagingPath,
          MAX_SECRETS_INDEX_BYTES,
          "secrets/index.json",
        );
        const parsed = JSON.parse(text) as { keys?: string[] };
        if (Array.isArray(parsed.keys)) {
          job.archiveSecretKeys = parsed.keys.map(String);
        }
      } catch {
        /* corrupt index — fall back to empty list, binding will mismatch */
        job.archiveSecretKeys = [];
      }
    }

    // Optional ticket gate: pause for the user to upload (or skip) a ticket
    // when the archive carries encrypted secrets. Race against the abort
    // signal so a cancellation aborts the gate too.
    let ticketResult: { ticket: DecryptionTicket; smk: Uint8Array } | null = null;
    if (job.manifest?.hasEncryptedSecrets) {
      job.status = "awaiting_ticket";
      emit(job, EventType.USER_IMPORT_PROGRESS, {
        phase: "awaiting_ticket",
        secretsCount: job.archiveSecretKeys?.length ?? 0,
      });
      const aborted = new Promise<never>((_, reject) => {
        job.abort.signal.addEventListener("abort", () => {
          reject(job.abort.signal.reason ?? new Error("import cancelled"));
        });
      });
      ticketResult = (await Promise.race([
        job.ticketGate!,
        aborted,
      ])) as { ticket: DecryptionTicket; smk: Uint8Array } | null;
      job.status = "running";
      emit(job, EventType.USER_IMPORT_PROGRESS, {
        phase: ticketResult ? "ticket_accepted" : "ticket_skipped",
        ticketReused: job.ticketReused ?? false,
      });
    }

    // Group entries by table / bucket for the apply phase.
    const tableEntries = new Map<string, BufferedTextEntry>();
    for (const entry of buf.entries) {
      if (entry.origin === "database" && entry.table !== "__manifest__") {
        tableEntries.set(entry.table, entry);
      }
    }

    // Bulk-load pattern: temporarily disable FK enforcement so tables can be
    // applied in topological order even when they contain dependency cycles.
    db.run("PRAGMA foreign_keys = OFF");
    fkDisabled = true;

    // Phase 2a: apply images first (binary), then images table rows.
    // Image FILES go before image ROWS so the row's referenced filename is on
    // disk when the row inserts. Actually, the FK from characters/personas is
    // on the row ID — the file's presence isn't enforced by SQLite. So we
    // can apply all DB rows first and then write files, OR interleave. To
    // keep the merge non-destructive, apply DB rows in topological order
    // (Phase 2b), then write binary files (Phase 2c).

    // Phase 2b: apply DB rows in topological order.
    for (const table of IMPORT_ORDER) {
      const entry = tableEntries.get(table);
      if (!entry) continue;
      await applyTable(ctx, table, entry.stagingPath);
    }
    // Any tables not in IMPORT_ORDER (e.g. unknown future tables): apply
    // last in arrival order. Still INSERT OR IGNORE, no harm done.
    for (const [table, entry] of tableEntries) {
      if (IMPORT_ORDER.includes(table)) continue;
      if (EXCLUDED_TABLES.has(table)) continue;
      await applyTable(ctx, table, entry.stagingPath);
    }

    // Phase 2c: binary files.
    emit(job, EventType.USER_IMPORT_PROGRESS, { phase: "files", total: buf.binaryEntryCount });
    let filesDone = 0;
    for await (const raw of readNdjson(buf.binaryJournalPath)) {
      if (job.abort.signal.aborted) throw job.abort.signal.reason ?? new Error("cancelled");
      const entry = raw as Partial<BufferedBinaryEntry>;
      if (
        entry.kind !== "binary" ||
        typeof entry.bucket !== "string" ||
        typeof entry.inner !== "string" ||
        typeof entry.stagingPath !== "string" ||
        typeof entry.byteSize !== "number"
      ) {
        throw new Error("binary entry journal is malformed");
      }
      try {
        await applyBinary(ctx, entry as BufferedBinaryEntry);
      } catch (err) {
        // Per-file failure is logged but doesn't kill the job.
        console.warn(`[user-data import] binary failed (${entry.bucket}/${entry.inner}):`, err);
      }
      filesDone++;
      if ((filesDone & 31) === 0) {
        emit(job, EventType.USER_IMPORT_PROGRESS, {
          phase: "files",
          processed: filesDone,
          total: buf.binaryEntryCount,
        });
        await yieldAndCheck(job.abort.signal);
      }
    }
    emit(job, EventType.USER_IMPORT_PROGRESS, { phase: "files_done", processed: filesDone });

    // Phase 2d: LanceDB vectors if present and compatible.
    await applyLancedbVectors(ctx, buf, buf.manifest?.embeddingConfig ?? null);

    // Phase 2e: encrypted secrets (only if the user supplied a ticket).
    // Runs LAST so the secret keys (which reference connection IDs etc.)
    // are inserted only after the rows they reference exist in the target.
    if (ticketResult) {
      const secretsEncryptedEntry = buf.entries.find((e) => e.table === "__secrets_encrypted__");
      if (secretsEncryptedEntry) {
        emit(job, EventType.USER_IMPORT_PROGRESS, { phase: "secrets_apply_start" });
        const { restored, skipped } = await applySecrets(
          ctx,
          secretsEncryptedEntry.stagingPath,
          ticketResult.smk,
        );
        job.secretsRestored = restored;
        job.summary["secrets"] = { imported: restored, skipped };
        emit(job, EventType.USER_IMPORT_PROGRESS, {
          phase: "secrets_apply_done",
          restored,
          skipped,
        });
      }
    }

    job.status = "complete";
    job.finishedAt = Math.floor(Date.now() / 1000);
    emit(job, EventType.USER_IMPORT_COMPLETE, {
      summary: job.summary,
      fileSummary: job.fileSummary,
    });
  } catch (err: any) {
    if (job.abort.signal.aborted) {
      job.status = "cancelled";
    } else {
      job.status = "failed";
      job.error = String(err?.message || err);
    }
    job.finishedAt = Math.floor(Date.now() / 1000);
    emit(job, EventType.USER_IMPORT_FAILED, { error: job.error, cancelled: job.status === "cancelled" });
  } finally {
    if (fkDisabled) {
      // Scrub orphan FK references introduced by the bulk load before
      // re-arming enforcement. A scrub failure must not strand the server
      // with FKs disabled.
      try {
        scrubOrphanForeignKeys(job.userId);
        scrubMemoryCortexOrphans(job.userId);
      } catch (err) {
        console.warn("[user-data import] orphan scrub raised:", err);
      }
      try {
        db.run("PRAGMA foreign_keys = ON");
        fkRestored = true;
      } catch (err) {
        console.error("[user-data import] failed to re-enable foreign_keys:", err);
      }
    }
    // Report any orphans the scrub didn't catch — informational only.
    if (fkRestored) {
      try {
        const orphans = db.query("PRAGMA foreign_key_check").all() as unknown[];
        if (orphans.length > 0) {
          console.warn(
            `[user-data import] ${orphans.length} orphan FK row(s) remain after import`,
            orphans.slice(0, 10),
          );
        }
      } catch {
        /* informational */
      }
    }

    USER_RUNNING.delete(job.userId);
    releaseGlobalImportSlot(job.jobId);
    // Cleanup: remove staging files, keep the original archive for debug.
    try {
      const staging = join(dirname(job.archivePath), "staging");
      const fs = require("node:fs") as typeof import("fs");
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    // Delete the original archive after a delay-free success; keep on failure for debugging.
    if (job.status === "complete") {
      try {
        unlinkSync(job.archivePath);
      } catch {
        /* ignore */
      }
    }
  }
}
