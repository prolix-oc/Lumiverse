// Streaming user-data export.
//
// Produces a single ZIP archive (.lvbak) that contains a manifest, an NDJSON
// per user-owned table, the binary files (images, thumbnails, avatars,
// databank documents, theme assets, notification sounds), and — when the
// user opted in — a per-user slice of the LanceDB vector store.
//
// The whole pipeline is driven by `fflate.Zip` so the archive never has to
// fit in memory: every NDJSON row and every binary chunk is pushed into a
// `ZipDeflate`/`ZipPassThrough` stream as it's produced, and `fflate.Zip`
// emits compressed bytes back through `onData` for the HTTP response.

import { Zip, ZipDeflate, AsyncZipDeflate, ZipPassThrough, type ZipInputFile } from "fflate";
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
const YIELD_INTERVAL_ROWS = 256;

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
 * Batch NDJSON row writes into chunks of roughly this size before pushing
 * into the deflate stream. Each fflate push() runs CRC32 + a DEFLATE step;
 * 64 KB per push is the sweet spot for high-row-count tables.
 */
const NDJSON_FLUSH_BYTES = 64 * 1024;

/**
 * Tables that frequently grow into hundreds of MB of plaintext. These get
 * AsyncZipDeflate so DEFLATE runs on a Worker thread, freeing the main
 * thread to keep producing rows and reading from SQLite in parallel.
 * Smaller / sparse tables keep using the sync ZipDeflate to avoid the
 * per-entry worker-spawn overhead.
 */
const BIG_NDJSON_TABLES = new Set<string>([
  "messages",
  "chat_chunks",
  "memory_consolidations",
  "memory_entities",
  "memory_mentions",
  "memory_relations",
  "memory_salience",
  "memory_font_colors",
  "world_book_entries",
  "databank_chunks",
  "dream_weaver_messages",
  "cortex_vault_chunks",
]);

/** Default Bun ReadableStream chunk size for binary copies. */
const FILE_CHUNK_BYTES = 256 * 1024;

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

/**
 * Promise-wrapped helper to push a chunk into a ZipInputFile and wait until
 * fflate has consumed it (via the file's `ondata` callback). Without the
 * wait, large NDJSON streams can outpace the underlying deflate and the
 * Zip controller backs up. The Zip-level onData drains into our own
 * ReadableStream controller, which provides natural backpressure.
 */
function pushChunk(
  file: ZipInputFile & { push: (chunk: Uint8Array, final?: boolean) => void },
  chunk: Uint8Array,
  final: boolean,
): void {
  // fflate's ZipDeflate.push is synchronous; we don't need to await. The
  // ondata callback fires inside push() before it returns.
  file.push(chunk, final);
}

// (legacy rowid-pagination helper removed; we use Statement.iterate() directly)

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

// (rowid stripping no longer needed — Statement.iterate() projects only the
// explicitly selected columns)

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
 * Open a NDJSON entry in the zip and return a helper to append rows.
 *
 * Rows are buffered into ~64 KB chunks before being pushed into the
 * underlying deflate stream — each fflate `push()` triggers CRC32 + a
 * DEFLATE step, so coalescing reduces overhead dramatically on high-row-
 * count tables.
 *
 * If `async: true`, an AsyncZipDeflate is used so DEFLATE runs on a Worker
 * thread, freeing the main thread to keep reading from SQLite.
 */
function openNdjsonEntry(zip: Zip, archivePath: string, opts?: { async?: boolean }) {
  const file = opts?.async
    ? new AsyncZipDeflate(archivePath, { level: NDJSON_COMPRESSION })
    : new ZipDeflate(archivePath, { level: NDJSON_COMPRESSION });
  zip.add(file);
  const encoder = new TextEncoder();
  let rowCount = 0;
  // Coalescing buffer.
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;

  function flush(final: boolean): void {
    if (pendingBytes === 0) {
      if (final) pushChunk(file, new Uint8Array(0), true);
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
    pushChunk(file, combined, final);
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
 * file doesn't exist; the caller records the miss in the manifest.
 */
async function streamFileIntoZip(
  zip: Zip,
  absPath: string,
  archivePath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!existsSync(absPath)) return false;
  const file = Bun.file(absPath);
  if (file.size === 0) {
    // Add an empty entry so the import path still sees it.
    const empty = new ZipPassThrough(archivePath);
    zip.add(empty);
    empty.push(new Uint8Array(0), true);
    return true;
  }
  // Images/avatars are typically PNG/JPEG/WebP — already compressed. Store
  // them with ZipPassThrough (no recompression) to save CPU.
  const entry = new ZipPassThrough(archivePath);
  zip.add(entry);
  const reader = file.stream().getReader();
  let copied = 0;
  let yieldDebt = 0;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      if (done) {
        pushChunk(entry, new Uint8Array(0), true);
        break;
      }
      if (value) {
        pushChunk(entry, value, false);
        copied += value.byteLength;
        yieldDebt += value.byteLength;
        if (yieldDebt >= YIELD_BINARY_BYTES) {
          yieldDebt = 0;
          await yieldAndCheck(signal);
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  return copied > 0 || file.size === 0;
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
  zip: Zip,
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
    const entry = openNdjsonEntry(zip, archivePath, { async: true });
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

  // Pipe fflate.Zip output into the HTTP response stream.
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      try {
        controller.error(err);
      } catch {
        /* already errored */
      }
      return;
    }
    if (chunk && chunk.byteLength > 0) {
      // ZipDeflate emits the empty trailing chunk before `final`; copy chunk
      // so fflate is free to reuse the underlying buffer. Guard the enqueue
      // because fflate keeps pushing chunks asynchronously after the client
      // disconnects, and an unguarded enqueue surfaces as an opaque
      // AbortError in app.onError.
      try {
        controller.enqueue(new Uint8Array(chunk));
      } catch {
        /* client disconnected */
      }
    }
    if (final) {
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    }
  });

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
  const manifestEntry = new ZipDeflate("manifest.json", { level: NDJSON_COMPRESSION });
  zip.add(manifestEntry);
  manifestEntry.push(new TextEncoder().encode(JSON.stringify(manifest, null, 2)), true);

  emitProgress(userId, { phase: "start", archiveId, includeVectors });

  // ---- 2) Walk the table registry ------------------------------------

  // Helper that emits one table's NDJSON entry and tracks the file refs
  // referenced by its rows.
  const fileQueue: FileRefCollected[] = [];

  async function exportRegistryTable(spec: TableSpec): Promise<void> {
    if (EXCLUDED_TABLES.has(spec.table)) return;
    const built = buildSelectForTable(spec.table, userId, spec);
    if (!built) return;
    const useAsync = BIG_NDJSON_TABLES.has(spec.table);
    const entry = openNdjsonEntry(zip, `database/${spec.table}.ndjson`, { async: useAsync });
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
    const useAsync = BIG_NDJSON_TABLES.has(table);
    const entry = openNdjsonEntry(zip, `database/${table}.ndjson`, { async: useAsync });
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
          emitProgress(userId, { phase: "table", table, processed: rowsOut });
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
    const entry = openNdjsonEntry(zip, `database/${table}.ndjson`, {
      async: BIG_NDJSON_TABLES.has(table),
    });
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
          emitProgress(userId, { phase: "table", table, processed: rowsOut });
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
      const ok = await streamFileIntoZip(
        zip,
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
    const ok = await streamFileIntoZip(zip, entry.absolutePath, entry.archivePath, signal);
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
      zip,
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
    const indexEntry = openNdjsonEntry(zip, "secrets/index.json");
    const blobEntry = openNdjsonEntry(zip, "secrets/encrypted.ndjson", { async: true });

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
  const statsEntry = new ZipDeflate("manifest-stats.json", { level: NDJSON_COMPRESSION });
  zip.add(statsEntry);
  statsEntry.push(new TextEncoder().encode(JSON.stringify(stats, null, 2)), true);

  // ---- 7) Finalize the ZIP ----------------------------------------
  zip.end();

  emitProgress(userId, { phase: "complete", archiveId, schemaVersion: ARCHIVE_SCHEMA_VERSION });
}
