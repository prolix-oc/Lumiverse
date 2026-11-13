import { getDb } from "../db/connection";
import { mapWithConcurrency } from "../utils/concurrency";
import { safeFetch } from "../utils/safe-fetch";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { getCharacter, getCharacterAsync } from "./characters.service";
import type { ChubExpressionAsset } from "./chub-api.service";
import { importFromImageData, type ExpressionImageData } from "./expressions.service";

const EXPRESSION_FETCH_TIMEOUT_MS = 15_000;
const MAX_EXPRESSION_IMAGE_BYTES = 50 * 1024 * 1024;

/** Number of response buffers retained before they are written and released. */
export const CHUB_EXPRESSION_BATCH_SIZE = 4;

/** Global remote-response concurrency inside the single pack worker. */
export const CHUB_EXPRESSION_DOWNLOAD_WORKERS = 2;

interface QueuedImport<T> {
  key: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * A keyed, bounded backend work queue.
 *
 * Chub's backfill UI is deliberately sequential, but that cannot protect the
 * server from multiple sessions or users starting imports together. The
 * backend is the resource boundary, so it owns the global concurrency limit.
 */
export class ChubExpressionImportQueue {
  private readonly pending: QueuedImport<unknown>[] = [];
  private readonly inflight = new Map<string, Promise<unknown>>();
  private active = 0;

  constructor(private readonly concurrency = 1) {}

  enqueue<T>(key: string, run: () => Promise<T>): Promise<T> {
    const duplicate = this.inflight.get(key);
    if (duplicate) return duplicate as Promise<T>;

    const promise = new Promise<T>((resolve, reject) => {
      this.pending.push({
        key,
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
    this.inflight.set(key, promise);
    void promise.then(
      () => this.inflight.delete(key),
      () => this.inflight.delete(key),
    );
    this.pump();
    return promise;
  }

  status(): { active: number; queued: number } {
    return { active: this.active, queued: this.pending.length };
  }

  private pump(): void {
    const limit = Math.max(1, Math.floor(this.concurrency));
    while (this.active < limit) {
      const job = this.pending.shift();
      if (!job) return;
      this.active++;
      void Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }
}

async function readResponseBytesCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`Chub expression image exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (err) {
    try { await reader.cancel(err); } catch {}
    throw err;
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function inferRemoteImageType(response: Response, url: string): { mimeType: string; extension: string } {
  const contentType = (response.headers.get("content-type") || "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  if (contentType.startsWith("image/")) {
    return {
      mimeType: contentType,
      extension: EXTENSION_BY_MIME[contentType] || "img",
    };
  }

  // A few CDNs use application/octet-stream. Infer only familiar image
  // suffixes; an HTML/error response must never become an expression image.
  const match = new URL(url).pathname.match(/\.([a-z0-9]+)$/i);
  const extension = match?.[1]?.toLowerCase() === "jpeg" ? "jpg" : match?.[1]?.toLowerCase();
  const mimeType = extension === "png" ? "image/png"
    : extension === "jpg" ? "image/jpeg"
      : extension === "webp" ? "image/webp"
        : extension === "gif" ? "image/gif"
          : extension === "avif" ? "image/avif"
            : null;
  if (!mimeType) throw new Error(`Chub expression URL did not return an image (${contentType || "unknown type"})`);
  return { mimeType, extension: extension! };
}

async function downloadExpression(asset: ChubExpressionAsset, index: number): Promise<ExpressionImageData | null> {
  try {
    const response = await safeFetch(asset.url, {
      timeoutMs: EXPRESSION_FETCH_TIMEOUT_MS,
      maxBytes: MAX_EXPRESSION_IMAGE_BYTES,
    });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      return null;
    }
    const { mimeType, extension } = inferRemoteImageType(response, asset.url);
    const data = await readResponseBytesCapped(response, MAX_EXPRESSION_IMAGE_BYTES);
    if (data.byteLength === 0) return null;
    return {
      label: asset.label,
      data,
      filename: `chub-expression-${index}.${extension}`,
      mimeType,
    };
  } catch {
    return null;
  }
}

export interface ChubExpressionImportResult {
  importedLabels: string[];
  failed: number;
}

type StoreBatch = (
  userId: string,
  characterId: string,
  assets: readonly ExpressionImageData[],
) => Promise<{ importedLabels: string[]; failed: number }>;

/**
 * Fetch and persist a pack in bounded waves. Completed response bodies never
 * accumulate for the whole pack: every batch reaches the image queue before
 * the next batch starts downloading.
 */
export async function importChubExpressionAssetsBatched(
  userId: string,
  characterId: string,
  assets: readonly ChubExpressionAsset[],
  options: {
    batchSize?: number;
    downloadWorkers?: number;
    download?: typeof downloadExpression;
    storeBatch?: StoreBatch;
  } = {},
): Promise<ChubExpressionImportResult> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? CHUB_EXPRESSION_BATCH_SIZE));
  const workers = Math.max(1, Math.floor(options.downloadWorkers ?? CHUB_EXPRESSION_DOWNLOAD_WORKERS));
  const download = options.download ?? downloadExpression;
  const storeBatch = options.storeBatch ?? (async (batchUserId, batchCharacterId, batchAssets) => {
    const result = await importFromImageData(batchUserId, batchCharacterId, batchAssets);
    return { importedLabels: result.importedLabels, failed: result.failed };
  });
  const importedLabels: string[] = [];
  let failed = 0;

  for (let offset = 0; offset < assets.length; offset += batchSize) {
    const sourceBatch = assets.slice(offset, offset + batchSize);
    const downloaded = await mapWithConcurrency(
      sourceBatch,
      Math.min(workers, batchSize),
      (asset, index) => download(asset, offset + index),
    );
    const ready = downloaded.filter((asset): asset is ExpressionImageData => asset !== null);
    failed += sourceBatch.length - ready.length;
    if (ready.length === 0) continue;
    const stored = await storeBatch(userId, characterId, ready);
    importedLabels.push(...stored.importedLabels);
    failed += stored.failed;
  }

  return { importedLabels, failed };
}

const importQueue = new ChubExpressionImportQueue(1);

export function queueChubExpressionImport(
  userId: string,
  characterId: string,
  assets: readonly ChubExpressionAsset[],
): Promise<ChubExpressionImportResult> {
  return importQueue.enqueue(`${userId}:${characterId}`, async () => {
    let changed = false;
    try {
      return await importChubExpressionAssetsBatched(userId, characterId, assets, {
        storeBatch: async (batchUserId, batchCharacterId, batchAssets) => {
          const result = await importFromImageData(batchUserId, batchCharacterId, batchAssets, {
            preserveUpdatedAt: true,
            emitEvent: false,
          });
          changed ||= result.importedLabels.length > 0;
          return result;
        },
      });
    } finally {
      // Keep open expression panels in sync once per pack, including partial
      // imports if a later batch fails. Read fresh so concurrent edits survive.
      if (changed) {
        const character = await getCharacterAsync(userId, characterId);
        if (character) eventBus.emit(EventType.CHARACTER_EDITED, { id: characterId, character }, userId);
      }
    }
  });
}

/** Remember checked sources, including those without packs, without editing the card's recency. */
export function markChubExpressionsChecked(userId: string, characterId: string): void {
  try {
    // Patch only the bookkeeping key; checking Chub must not rewrite local
    // metadata or trigger a full gallery refresh for every candidate.
    getDb().query(`UPDATE characters
      SET extensions = json_set(extensions, '$._lumiverse_chub_expressions_checked', ?)
      WHERE id = ? AND user_id = ? AND deleting = 0`)
      .run(Date.now(), characterId, userId);
  } catch {
    // Losing the stamp only means the card is offered again later.
  }
}

export function getChubExpressionImportQueueStatus(): { active: number; queued: number } {
  return importQueue.status();
}
