// Streaming user-data export.
//
// Produces a single ZIP archive (.lvbak) that contains a manifest, an NDJSON
// per user-owned table, the binary files (images, thumbnails, avatars,
// databank documents, theme assets, notification sounds), and — when the
// user opted in — a per-user slice of the LanceDB vector store.
//
// The whole pipeline is driven by `archiver`'s streaming ZipArchive so the
// archive never has to fit in memory: every NDJSON row and every binary
// chunk is piped into an archiver entry as it's produced, and the archive
// emits compressed bytes back through a Node→Web-Stream bridge for the
// HTTP response.
//
// `forceZip64: true` lifts the legacy ZIP32 4 GB ceiling — without it,
// archives that cross 2³²−1 bytes silently corrupt (32-bit compressedSize /
// uncompressedSize / localHeaderOffset fields wrap to 0). The previous
// fflate-based writer had no ZIP64 support at all, which made any export
// over 4 GB produce a broken file with no recovery path on import.

import { ZipArchive, type ArchiverError, type ZipEntryData } from "archiver";
import { PassThrough, Writable, type Readable } from "stream";
import { join, basename } from "path";
import { existsSync } from "fs";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import { getDb } from "../../db/connection";
import { env } from "../../env";
import { getEmbeddingConfig } from "../embeddings.service";
import {
  TABLE_REGISTRY,
  VIA_CHAT_TABLES,
  VIA_WORLD_BOOK_TABLES,
  VAULT_TABLES,
  VIA_VAULT_TABLES,
  EXCLUDED_TABLES,
  SECRET_SETTING_KEY_PATTERNS,
  LANCEDB_TABLES,
  type TableSpec,
} from "./table-registry";
import {
  createManifest,
  ARCHIVE_SCHEMA_VERSION,
  type ArchiveEmbeddingConfig,
} from "./manifest";
import { getCompletionSound } from "../notification-sounds.service";
import { getSecret as getSecretValue } from "../secrets.service";
import { encryptSecret } from "./secret-ticket.service";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Yield to the event loop every N NDJSON rows so /generate, WS pings, etc. stay snappy. */
const YIELD_INTERVAL_ROWS = 1024;

/** Yield to the event loop every N bytes streamed for a single binary file. */
const YIELD_BINARY_BYTES = 4 * 1024 * 1024;

/** Concurrent binary-file copies into the archive. SSD-friendly. */
const FILE_CONCURRENCY = 8;

/**
 * Compression level for NDJSON entries. NDJSON is mostly plaintext with high
 * redundancy; level 3 hits ~95 % of level-6's ratio at 2-3× the throughput,
 * and we're frequently CPU-bound here.
 */
const NDJSON_COMPRESSION = 3;

/**
 * Flush the NDJSON coalescing buffer into the entry once it reaches roughly
 * this many bytes. archiver accepts arbitrarily chunked writes, but the
 * underlying zlib DEFLATE step is a fixed cost per call; coalescing
 * dramatically reduces overhead on high-row-count tables.
 */
const NDJSON_FLUSH_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ExportSecretsContext {
  /** 32-byte AES-256-GCM key from the matching ticket. */
  smk: Uint8Array;
  /**
   * The list of secret keys the ticket was issued against. Used to verify
   * that the live secrets table at archive-stream time still corresponds to
   * the ticket's binding; new keys created between prepare and stream are
   * skipped (the ticket can't decrypt them on import).
   */
  secretKeys: readonly string[];
}

export interface ExportOptions {
  userId: string;
  includeVectors: boolean;
  signal?: AbortSignal;
  /** Optional Lumiverse server version stamped into the manifest. */
  producerVersion?: string | null;
  /**
   * When present, the export bundles a `secrets/encrypted.ndjson` blob
   * encrypted with the provided SMK plus a `secrets/index.json` sidecar,
   * and flips `manifest.hasEncryptedSecrets` to true. The SMK never lands
   * on disk on the source instance.
   */
  secrets?: ExportSecretsContext;
  /** Optional archiveId override (used by the prepare/archive flow). */
  archiveId?: string;
}

/**
 * Returns a ReadableStream<Uint8Array> that, when consumed, streams the
 * complete user-data ZIP archive. The stream backs the export HTTP response
 * and resolves errors via the standard ReadableStream error path.
 */
export function buildExportStream(opts: ExportOptions): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void runExport(opts, controller).catch((err) => {
        try {
          controller.error(err);
        } catch {
          /* already errored */
        }
      });
    },
    cancel() {
      // Client disconnect. The route binds opts.signal to the request
      // body — Bun tears it down on the same lifecycle, which propagates
      // into the in-flight SQLite iterators and the archiver sink.
    },
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function yieldAndCheck(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function emitProgress(userId: string, payload: Record<string, any>): void {
  try {
    eventBus.emit(EventType.USER_EXPORT_PROGRESS, payload, userId);
  } catch {
    /* progress is best-effort */
  }
}

/** Quote a SQL identifier minimally. */
function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

/** Return the column list of a table, in declaration order. */
function getTableColumns(table: string): string[] {
  return (
    getDb()
      .query(`PRAGMA table_info(${ident(table)})`)
      .all() as { name: string }[]
  ).map((c) => c.name);
}

/**
 * Resolve the SELECT statement and parameters used to stream a user's rows
 * for a given table. Returns null if the table is empty / not present.
 */
function buildSelectForTable(
  table: string,
  userId: string,
  spec: TableSpec | null,
  extraWhere?: string,
): { sql: string; params: any[]; columns: string[] } | null {
  const columns = getTableColumns(table);
  if (columns.length === 0) return null;
  const select = `SELECT ${columns.map(ident).join(", ")} FROM ${ident(table)}`;
  const wheres: string[] = [];
  const params: any[] = [];

  switch (spec?.ownership) {
    case "user":
      wheres.push(`${ident(table)}.user_id = ?`);
      params.push(userId);
      break;
    case "via_chat":
      wheres.push(`${ident(table)}.chat_id IN (SELECT id FROM chats WHERE user_id = ?)`);
      params.push(userId);
      break;
    case "via_pack":
      wheres.push(`${ident(table)}.pack_id IN (SELECT id FROM packs WHERE user_id = ?)`);
      params.push(userId);
      break;
    case "via_vault":
      wheres.push(
        `${ident(table)}.vault_id IN (SELECT id FROM cortex_vaults WHERE user_id = ?)`,
      );
      params.push(userId);
      break;
    case "via_session":
      wheres.push(
        `${ident(table)}.session_id IN (SELECT id FROM dream_weaver_sessions WHERE user_id = ?)`,
      );
      params.push(userId);
      break;
    case "via_document":
      wheres.push(
        `${ident(table)}.document_id IN (SELECT id FROM databank_documents WHERE user_id = ?)`,
      );
      params.push(userId);
      break;
    case "via_installer":
      wheres.push(`${ident(table)}.installed_by_user_id = ?`);
      params.push(userId);
      break;
    default:
      // Synthetic ownership (handled by direct callers below); no clause.
      break;
  }

  if (extraWhere) wheres.push(extraWhere);
  if (spec?.extraWhere) wheres.push(spec.extraWhere);

  let sql = select;
  if (wheres.length > 0) sql += ` WHERE ${wheres.join(" AND ")}`;
  // No ORDER BY / LIMIT: Statement.iterate() streams every matching row.

  return { sql, params, columns };
}

/** Strip / scrub columns per the table spec's `scrubColumns` map. */
function scrubRow(row: Record<string, any>, scrub?: Record<string, any>): Record<string, any> {
  if (!scrub) return row;
  const out: Record<string, any> = { ...row };
  for (const [k, v] of Object.entries(scrub)) {
    if (k in out) out[k] = v;
  }
  return out;
}

/**
 * Returns true if a `settings.key` value is a known secret namespace.
 * Used to belt-and-braces filter the settings export: even though such
 * keys *should* be in the `secrets` table, we defensively drop any that
 * leak into `settings`.
 */
function isSecretSettingKey(key: string): boolean {
  for (const re of SECRET_SETTING_KEY_PATTERNS) {
    if (re.test(key)) return true;
  }
  return false;
}

interface FileRefCollected {
  /** Absolute path on disk. */
  absolutePath: string;
  /** Relative archive path (under files/{bucket}/). */
  archivePath: string;
}

/**
 * Bridge a Node.js Writable (the archiver's sink) to a Web
 * ReadableStreamDefaultController. Each chunk flushed by archiver is
 * forwarded to the controller; an enqueue after the controller has been
 * closed (client disconnect mid-archive) is swallowed.
 */
function makeControllerSink(
  controller: ReadableStreamDefaultController<Uint8Array>,
): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        // chunk is a Buffer; slice so we hand a fresh Uint8Array to the
        // stream (Bun's controller copies the view's bytes).
        const view = chunk instanceof Uint8Array
          ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : new Uint8Array(0);
        controller.enqueue(view);
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
    final(callback) {
      try {
        controller.close();
      } catch {
        /* already closed (e.g. we errored) */
      }
      callback();
    },
  });
}

/**
 * Open a streaming NDJSON entry backed by a PassThrough. The caller pushes
 * row-by-row; `close()` finalises the stream so archiver emits the entry's
 * data descriptor + central-directory record.
 *
 * Rows are coalesced into ~256 KB buffers before being written into the
 * PassThrough; archiver will feed them to zlib's DEFLATE one chunk at a
 * time, and a 256 KB call into zlib is roughly the sweet spot for
 * high-row-count tables.
 */
function openNdjsonEntry(archive: ZipArchive, archivePath: string) {
  // Size the PassThrough buffer to the coalescing target so writing a full
  // flush block doesn't stall waiting for archiver/zlib to drain.
  const stream = new PassThrough({ highWaterMark: NDJSON_FLUSH_BYTES });
  archive.append(stream as unknown as Readable, { name: archivePath });
  const encoder = new TextEncoder();
  let rowCount = 0;
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;

  function flush(final: boolean): void {
    if (pendingBytes === 0) {
      if (final) stream.end();
      return;
    }
    let combined: Uint8Array;
    if (pending.length === 1) {
      combined = pending[0];
    } else {
      combined = new Uint8Array(pendingBytes);
      let offset = 0;
      for (const piece of pending) {
        combined.set(piece, offset);
        offset += piece.byteLength;
      }
    }
    pending.length = 0;
    pendingBytes = 0;
    stream.write(combined);
    if (final) stream.end();
  }

  return {
    write(row: Record<string, any>): void {
      const line = encoder.encode(JSON.stringify(row) + "\n");
      pending.push(line);
      pendingBytes += line.byteLength;
      rowCount++;
      if (pendingBytes >= NDJSON_FLUSH_BYTES) flush(false);
    },
    close(): number {
      flush(true);
      return rowCount;
    },
  };
}

/**
 * Stream a single on-disk file into the archive. Skipped silently if the
 * file doesn't exist. Binary payloads (images, avatars) are stored
 * uncompressed — they're already compressed and zlib would just burn CPU.
 */
async function streamFileIntoArchive(
  archive: ZipArchive,
  absPath: string,
  archivePath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!existsSync(absPath)) return false;
  const file = Bun.file(absPath);
  const entryOpts: ZipEntryData = { name: archivePath, store: true };
  if (file.size === 0) {
    // Add an empty entry so the import path still sees it.
    archive.append(Buffer.alloc(0), entryOpts);
    return true;
  }
  archive.file(absPath, entryOpts);
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  return true;
}

/**
 * Run a worker pool of `concurrency` over the given items, calling `fn`
 * for each. Errors propagate after the pool drains.
 */
async function withConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const errors: any[] = [];
  const workers = Math.min(Math.max(1, concurrency), items.length);
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        await fn(items[i]);
      } catch (err) {
        errors.push(err);
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (errors.length > 0) throw errors[0];
}

// ---------------------------------------------------------------------------
// LanceDB vector dump (optional, only when includeVectors=true)
// ---------------------------------------------------------------------------

const EMBEDDINGS_TABLE = "embeddings";
const WORLD_BOOK_EMBEDDINGS_TABLE = "embeddings_world_books";

/**
 * Dump the user's vector rows from the embeddings tables into NDJSON lines
 * inside the archive. Each row carries the vector as a base64-encoded
 * Float32Array (compact, deterministic, and easy to round-trip on import).
 */
async function exportLancedbVectors(
  userId: string,
  archive: ZipArchive,
  signal: AbortSignal | undefined,
  onProgress: (table: string, count: number) => void,
): Promise<{ counts: Record<string, number> }> {
  const counts: Record<string, number> = {};
  let lance: any;
  try {
    lance = await import("@lancedb/lancedb");
  } catch {
    return { counts };
  }
  const uri = join(env.dataDir, "lancedb");
  let conn: any;
  try {
    conn = await lance.connect(uri);
  } catch {
    return { counts };
  }
  let names: string[] = [];
  try {
    names = await conn.tableNames();
  } catch {
    return { counts };
  }
  for (const tableName of [EMBEDDINGS_TABLE, WORLD_BOOK_EMBEDDINGS_TABLE]) {
    if (!names.includes(tableName)) continue;
    let table: any;
    try {
      table = await conn.openTable(tableName);
    } catch {
      continue;
    }
    const archivePath = `lancedb/${tableName}.ndjson`;
    // Vector rows are large (each Float32Array is base64'd into ~6× its byte
    // length) so this is the single biggest beneficiary of off-thread deflate.
    // archiver doesn't expose a worker-thread DEFLATE knob, but the
    // PassThrough + 64 KB coalescing keeps zlib's call overhead bounded.
    const entry = openNdjsonEntry(archive, archivePath);
    let count = 0;
    try {
      // QueryBase implements AsyncIterable<RecordBatch>, so we can stream
      // record batches instead of buffering the entire result via toArray().
      // Each batch holds ~1k rows; we iterate rows within and continue.
      const query = table
        .query()
        .where(`user_id = '${userId.replace(/'/g, "''")}'`)
        .select([
          "id",
          "user_id",
          "source_type",
          "source_id",
          "owner_id",
          "chunk_index",
          "vector",
          "metadata_json",
          "updated_at",
        ]);

      for await (const batch of query as AsyncIterable<any>) {
        // RecordBatch.toArray() materializes only this batch (~1k rows).
        const rows = typeof batch?.toArray === "function" ? batch.toArray() : [];
        for (const row of rows as any[]) {
          const vec = row.vector;
          let vectorB64: string | null = null;
          if (vec && typeof vec === "object") {
            const arr =
              vec instanceof Float32Array
                ? vec
                : Array.isArray(vec)
                  ? new Float32Array(vec)
                  : null;
            if (arr) {
              vectorB64 = Buffer.from(
                arr.buffer,
                arr.byteOffset,
                arr.byteLength,
              ).toString("base64");
            }
          }
          // Strip the importer user_id; importer reassigns from auth context.
          const { user_id: _drop, vector: _v, ...rest } = row;
          entry.write({ ...rest, vector_b64: vectorB64 });
          count++;
        }
        await yieldAndCheck(signal);
        onProgress(tableName, count);
      }
    } catch (err) {
      console.warn(`[user-data export] LanceDB ${tableName} dump failed:`, err);
    }
    counts[tableName] = entry.close();
    onProgress(tableName, count);
  }
  try {
    conn.close?.();
  } catch {
    /* ignore */
  }
  return { counts };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

async function runExport(
  opts: ExportOptions,
  controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<void> {
  const { userId, includeVectors, signal } = opts;
  const archiveId = opts.archiveId || crypto.randomUUID();
  const counts: Record<string, number> = {};
  const missingFiles: string[] = [];
  const secretsExported: string[] = [];
  let secretsSkipped = 0;

  // Pipe archiver's output into the HTTP response stream. forceZip64 keeps
  // the archive valid past 4 GB (32-bit ZIP32 header fields would wrap to
  // 0 and silently corrupt the central directory otherwise).
  const archive = new ZipArchive({
    zlib: { level: NDJSON_COMPRESSION },
    forceZip64: true,
  });

  let fatalErr: unknown = null;
  archive.on("warning", (err: ArchiverError) => {
    // archiver's "warning" is for recoverable issues (e.g. ENOENT on a
    // globbed file). For an explicit export we never pass globs, so any
    // warning here is unexpected — surface it but don't tear down the
    // archive yet.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[user-data export] archiver warning: ${err.message}`);
    }
  });
  archive.on("error", (err: ArchiverError) => {
    fatalErr = err;
    try {
      controller.error(err);
    } catch {
      /* already errored */
    }
  });

  const sink = makeControllerSink(controller);
  archive.pipe(sink);

  // Snapshot of the embedding config (drives import-side compatibility check).
  let embeddingConfig: ArchiveEmbeddingConfig = { provider: null, model: null, dimension: null };
  try {
    const cfg = await getEmbeddingConfig(userId);
    embeddingConfig = {
      provider: cfg?.provider ?? null,
      model: (cfg as any)?.model ?? null,
      dimension: (cfg as any)?.dimension ?? null,
    };
  } catch {
    /* embedding config optional */
  }

  // ---- 1) Manifest FIRST -------------------------------------------
  // Writing manifest.json as the first ZIP entry lets the importer validate
  // it after reading just a few KB — without it, verifying a multi-GB
  // archive would require streaming the entire file. Row counts and the
  // missing-files report land in a trailing `manifest-stats.json`.
  const manifest = createManifest({
    archiveId,
    includeVectors,
    embeddingConfig,
    producerVersion: opts.producerVersion ?? null,
    counts: {},          // populated in trailer
    missingFiles: [],    // populated in trailer
    hasEncryptedSecrets: !!opts.secrets,
    secretsCount: opts.secrets?.secretKeys.length ?? 0,
  });
  archive.append(JSON.stringify(manifest, null, 2), {
    name: "manifest.json",
  });

  emitProgress(userId, { phase: "start", archiveId, includeVectors });

  // ---- 2) Walk the table registry ------------------------------------

  // Helper that emits one table's NDJSON entry and tracks the file refs
  // referenced by its rows.
  const fileQueue: FileRefCollected[] = [];

  async function exportRegistryTable(spec: TableSpec): Promise<void> {
    if (EXCLUDED_TABLES.has(spec.table)) return;
    const built = buildSelectForTable(spec.table, userId, spec);
    if (!built) return;
    const entry = openNdjsonEntry(archive, `database/${spec.table}.ndjson`);
    let rowsOut = 0;
    let lastEmittedAt = 0;
    const stmt = getDb().prepare(built.sql);
    emitProgress(userId, { phase: "table_start", table: spec.table });

    for (const raw of stmt.iterate(...built.params) as Iterable<Record<string, any>>) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");

      // Drop secret-looking settings rows defensively.
      if (spec.table === "settings" && isSecretSettingKey(String(raw.key ?? ""))) continue;

      const scrubbed = scrubRow(raw, spec.scrubColumns);
      entry.write(scrubbed);
      rowsOut++;

      // Collect file references for later streaming.
      if (spec.fileRefs) {
        for (const ref of spec.fileRefs) {
          const paths = ref.resolve(raw, env.dataDir);
          for (const abs of paths) {
            const inner = ref.archivePath ? ref.archivePath(raw, abs) : basename(abs);
            fileQueue.push({
              absolutePath: abs,
              archivePath: `files/${ref.bucket}/${inner}`,
            });
          }
        }
      }

      if (rowsOut % YIELD_INTERVAL_ROWS === 0) {
        const now = Date.now();
        if (now - lastEmittedAt >= 100) {
          emitProgress(userId, {
            phase: "table",
            table: spec.table,
            processed: rowsOut,
          });
          lastEmittedAt = now;
        }
        await yieldAndCheck(signal);
      }
    }

    counts[spec.table] = entry.close();
    emitProgress(userId, { phase: "table_done", table: spec.table, processed: rowsOut });
  }

  // Helper for child tables that are owned via a parent FK (chat / vault / world_book).
  async function exportChildTable(
    table: string,
    ownership: TableSpec["ownership"],
  ): Promise<void> {
    if (EXCLUDED_TABLES.has(table)) return;
    const synthSpec: TableSpec = { table, ownership } as TableSpec;
    const built = buildSelectForTable(table, userId, synthSpec);
    if (!built) return;
    const entry = openNdjsonEntry(archive, `database/${table}.ndjson`);
    let rowsOut = 0;
    let lastEmittedAt = 0;
    const stmt = getDb().prepare(built.sql);
    emitProgress(userId, { phase: "table_start", table });

    for (const raw of stmt.iterate(...built.params) as Iterable<Record<string, any>>) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      entry.write(raw);
      rowsOut++;
      if (rowsOut % YIELD_INTERVAL_ROWS === 0) {
        const now = Date.now();
        if (now - lastEmittedAt >= 100) {
          emitProgress(userId, {
            phase: "table",
            table,
            processed: rowsOut,
          });
          lastEmittedAt = now;
        }
        await yieldAndCheck(signal);
      }
    }

    counts[table] = entry.close();
    emitProgress(userId, { phase: "table_done", table, processed: rowsOut });
  }

  // World book entries — owned via world_book_id (join to world_books.user_id)
  async function exportWorldBookEntries(): Promise<void> {
    const table = "world_book_entries";
    const columns = getTableColumns(table);
    if (columns.length === 0) return;
    const sql =
      `SELECT ${columns.map(ident).join(", ")} FROM ${ident(table)} ` +
      `WHERE world_book_id IN (SELECT id FROM world_books WHERE user_id = ?)`;
    const entry = openNdjsonEntry(archive, `database/${table}.ndjson`);
    let rowsOut = 0;
    let lastEmittedAt = 0;
    const stmt = getDb().prepare(sql);
    emitProgress(userId, { phase: "table_start", table });

    for (const raw of stmt.iterate(userId) as Iterable<Record<string, any>>) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      entry.write(raw);
      rowsOut++;
      if (rowsOut % YIELD_INTERVAL_ROWS === 0) {
        const now = Date.now();
        if (now - lastEmittedAt >= 100) {
          emitProgress(userId, {
            phase: "table",
            table,
            processed: rowsOut,
          });
          lastEmittedAt = now;
        }
        await yieldAndCheck(signal);
      }
    }

    counts[table] = entry.close();
    emitProgress(userId, { phase: "table_done", table, processed: rowsOut });
  }

  // ---- 2a) Registry-driven tables (with file refs) ------------------
  for (const spec of TABLE_REGISTRY) {
    await exportRegistryTable(spec);
  }

  // ---- 2b) World book entries --------------------------------------
  await exportWorldBookEntries();

  // ---- 2c) Per-chat children ---------------------------------------
  for (const tbl of VIA_CHAT_TABLES) {
    await exportChildTable(tbl, "via_chat");
  }

  // ---- 2d) Cortex vaults + children --------------------------------
  for (const tbl of VAULT_TABLES) {
    await exportChildTable(tbl, "user");
  }
  for (const tbl of VIA_VAULT_TABLES) {
    await exportChildTable(tbl, "via_vault");
  }

  // ---- 3) Notification sound ---------------------------------------
  try {
    const sound = getCompletionSound(userId);
    if (sound) {
      const ok = await streamFileIntoArchive(
        archive,
        sound.filepath,
        `files/notification-sounds/${basename(sound.filepath)}`,
        signal,
      );
      if (!ok) missingFiles.push(sound.filepath);
    }
  } catch {
    /* sound optional */
  }

  // ---- 4) Binary files (images, thumbnails, avatars, databank, theme assets) --
  // Dedupe by archive path so the same image/thumb isn't packed twice.
  const seen = new Set<string>();
  const deduped = fileQueue.filter((f) => {
    if (seen.has(f.archivePath)) return false;
    seen.add(f.archivePath);
    return true;
  });

  emitProgress(userId, { phase: "files", total: deduped.length });
  let filesDone = 0;
  await withConcurrency(deduped, FILE_CONCURRENCY, async (entry) => {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const ok = await streamFileIntoArchive(archive, entry.absolutePath, entry.archivePath, signal);
    if (!ok) missingFiles.push(entry.absolutePath);
    filesDone++;
    if ((filesDone & 31) === 0) {
      emitProgress(userId, { phase: "files", processed: filesDone, total: deduped.length });
      await yieldAndCheck(signal);
    }
  });
  emitProgress(userId, { phase: "files_done", processed: filesDone });

  // ---- 5) Optional LanceDB vector dump -----------------------------
  if (includeVectors) {
    emitProgress(userId, { phase: "lancedb_start" });
    const { counts: vectorCounts } = await exportLancedbVectors(
      userId,
      archive,
      signal,
      (table, count) => emitProgress(userId, { phase: "lancedb", table, processed: count }),
    );
    for (const [k, v] of Object.entries(vectorCounts)) counts[`lancedb:${k}`] = v;
    emitProgress(userId, { phase: "lancedb_done" });
  }

  // ---- 5.5) Optional encrypted secrets blob (opt-in) ---------------
  if (opts.secrets) {
    emitProgress(userId, { phase: "secrets_start" });
    const ctx = opts.secrets;
    const wanted = new Set(ctx.secretKeys);
    const indexEntry = openNdjsonEntry(archive, "secrets/index.json");
    const blobEntry = openNdjsonEntry(archive, "secrets/encrypted.ndjson");

    // Sidecar with public metadata only — names of the keys, no values.
    // Lets the importer surface "will restore N keys" before the user
    // uploads the ticket. Stored as a single JSON object (not NDJSON-shaped),
    // wrapped by openNdjsonEntry which appends a trailing newline.
    indexEntry.write({
      version: 1,
      archiveId,
      keys: [...ctx.secretKeys].sort(),
    });
    indexEntry.close();

    for (const key of ctx.secretKeys) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      if (!wanted.has(key)) continue;
      let plaintext: string | null = null;
      try {
        plaintext = await getSecretValue(userId, key);
      } catch (err) {
        // Decryption of the source secret failed (corrupt identity? wrong
        // user? GCM tag mismatch on a legacy/manually-inserted row?). Log
        // and skip — better to lose one secret than fail the whole export.
        // The DOMException default formatter is unhelpful, so unpack the
        // name + message ourselves.
        const e = err as { name?: string; message?: string };
        console.warn(
          `[user-data export] failed to read secret ${key}: ${e?.name || "Error"}: ${
            e?.message || String(err)
          }`,
        );
      }
      if (plaintext === null) {
        missingFiles.push(`secret:${key}`);
        secretsSkipped++;
        continue;
      }
      const enc = await encryptSecret(ctx.smk, key, plaintext);
      blobEntry.write(enc);
      secretsExported.push(key);
    }
    blobEntry.close();
    emitProgress(userId, {
      phase: "secrets_done",
      exported: secretsExported.length,
      skipped: secretsSkipped,
    });
  }

  // ---- 6) Stats trailer (counts + missing-files report) -------------
  const stats = { counts, missingFiles };
  archive.append(JSON.stringify(stats, null, 2), {
    name: "manifest-stats.json",
  });

  // ---- 7) Finalize the archive ------------------------------------
  try {
    await archive.finalize();
  } catch (err) {
    if (!fatalErr) {
      try {
        controller.error(err);
      } catch {
        /* already errored */
      }
    }
    throw err;
  }
  if (fatalErr) throw fatalErr;

  emitProgress(userId, { phase: "complete", archiveId, schemaVersion: ARCHIVE_SCHEMA_VERSION });
}
