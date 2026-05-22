/**
 * Databank Vectorization Service — Orchestrates parse → chunk → embed → LanceDB upsert.
 *
 * Called after document upload. Runs async — caller kicks off and returns immediately.
 */

import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import * as embeddingsSvc from "../embeddings.service";
import * as crud from "./databank-crud.service";
import { parseDocument } from "./document-parser.service";
import { chunkDocument } from "./document-chunker.service";
import { loadDatabankSettings } from "./databank-settings.service";
import type { DatabankDocument } from "./types";

const BATCH_SIZE = 50;

class DocumentProcessingAbortedError extends Error {
  constructor(docId: string) {
    super(`Document ${docId} processing aborted`);
    this.name = "DocumentProcessingAbortedError";
  }
}

interface ActiveDocumentProcessing {
  databankId: string;
  controller: AbortController;
}

const activeDocuments = new Map<string, Set<ActiveDocumentProcessing>>();

export function abortDocumentProcessing(docId: string): void {
  const activeRuns = activeDocuments.get(docId);
  if (!activeRuns) return;

  for (const active of activeRuns) {
    if (!active.controller.signal.aborted) {
      active.controller.abort(new DocumentProcessingAbortedError(docId));
    }
  }
}

export function abortDatabankProcessing(databankId: string): void {
  for (const [docId, activeRuns] of activeDocuments.entries()) {
    for (const active of activeRuns) {
      if (active.databankId === databankId && !active.controller.signal.aborted) {
        active.controller.abort(new DocumentProcessingAbortedError(docId));
      }
    }
  }
}

/**
 * Process a document: parse file, chunk text, embed, upsert to LanceDB.
 * Updates document status via events throughout the lifecycle.
 */
export async function processDocument(userId: string, docId: string): Promise<void> {
  const doc = crud.getDocument(userId, docId);
  if (!doc) {
    console.warn(`[databank] Document ${docId} not found for processing`);
    return;
  }

  const controller = new AbortController();
  const activeRun = { databankId: doc.databankId, controller };
  trackActiveDocument(docId, activeRun);

  try {
    // Mark as processing
    crud.updateDocumentStatus(docId, "processing");
    emitStatus(userId, doc, "processing");

    // 1. Parse the file
    const parsed = await parseDocument(userId, doc.filePath);
    if (isProcessingAborted(docId, controller.signal)) return;

    if (!parsed.text.trim()) {
      crud.updateDocumentStatus(docId, "error", { errorMessage: "Document is empty after parsing" });
      emitStatus(userId, doc, "error", "Document is empty after parsing");
      return;
    }

    // 2. Chunk the text
    const databankSettings = loadDatabankSettings(userId);
    const chunkResults = chunkDocument(parsed.text, {
      targetTokens: databankSettings.chunkTargetTokens,
      maxTokens: databankSettings.chunkMaxTokens,
      overlapTokens: databankSettings.chunkOverlapTokens,
    });
    if (isProcessingAborted(docId, controller.signal)) return;

    if (chunkResults.length === 0) {
      crud.updateDocumentStatus(docId, "error", { errorMessage: "No chunks produced from document" });
      emitStatus(userId, doc, "error", "No chunks produced from document");
      return;
    }

    // 3. Delete old Lance vectors before SQLite chunk IDs are replaced.
    // Reprocessing generates new chunk IDs, so deleting SQLite rows first would
    // orphan the previous Lance rows and make disk usage grow without bound.
    await deleteDocumentVectors(userId, docId);

    // 4. Delete old chunks (for reprocessing)
    crud.deleteChunksForDocument(docId);

    // 5. Insert chunk rows into SQLite
    const chunkRows = chunkResults.map((c) => ({
      id: crypto.randomUUID(),
      documentId: docId,
      databankId: doc.databankId,
      userId,
      chunkIndex: c.index,
      content: c.content,
      tokenCount: c.tokenCount,
      metadata: c.metadata,
    }));
    try {
      crud.insertChunks(chunkRows);
    } catch (err) {
      if (isForeignKeyConstraintError(err)) {
        console.info(`[databank] Document ${docId} deleted during processing; aborting cleanly`);
        return;
      }
      throw err;
    }
    if (isProcessingAborted(docId, controller.signal)) return;

    crud.updateDocumentStatus(docId, "processing", { totalChunks: chunkRows.length });

    // 6. Vectorize chunks
    const cfg = await embeddingsSvc.getEmbeddingConfig(userId);
    if (isProcessingAborted(docId, controller.signal)) return;

    if (!cfg.enabled) {
      // Embeddings not configured — mark as ready without vectors
      crud.updateDocumentStatus(docId, "ready", { totalChunks: chunkRows.length });
      emitStatus(userId, doc, "ready", undefined, chunkRows.length);
      return;
    }

    await vectorizeChunks(userId, doc, chunkRows, cfg, controller.signal);
    if (isProcessingAborted(docId, controller.signal)) return;

    // 7. Mark as ready
    crud.updateDocumentStatus(docId, "ready", { totalChunks: chunkRows.length });
    emitStatus(userId, doc, "ready", undefined, chunkRows.length);

    console.info(`[databank] Processed document "${doc.name}" — ${chunkRows.length} chunks vectorized`);
  } catch (err: any) {
    if (isProcessingAbortError(err)) {
      console.info(`[databank] Document ${docId} deleted during processing; aborting cleanly`);
      return;
    }

    console.error(`[databank] Failed to process document ${docId}:`, err);
    // Don't surface raw err.message to the client — it can include filesystem
    // paths, API URLs, or upstream provider details that would otherwise leak
    // via the WebSocket status emission.
    const safeMessage = redactProcessingError(err);
    crud.updateDocumentStatus(docId, "error", { errorMessage: safeMessage });
    emitStatus(userId, doc, "error", safeMessage);
  } finally {
    untrackActiveDocument(docId, activeRun);
  }
}

function trackActiveDocument(docId: string, activeRun: ActiveDocumentProcessing): void {
  const activeRuns = activeDocuments.get(docId);
  if (activeRuns) {
    activeRuns.add(activeRun);
  } else {
    activeDocuments.set(docId, new Set([activeRun]));
  }
}

function untrackActiveDocument(docId: string, activeRun: ActiveDocumentProcessing): void {
  const activeRuns = activeDocuments.get(docId);
  if (!activeRuns) return;

  activeRuns.delete(activeRun);
  if (activeRuns.size === 0) {
    activeDocuments.delete(docId);
  }
}

function isProcessingAborted(docId: string, signal: AbortSignal): boolean {
  if (signal.aborted) {
    console.info(`[databank] Document ${docId} deleted during processing; aborting cleanly`);
    return true;
  }
  return false;
}

function isProcessingAbortError(err: unknown): boolean {
  return err instanceof DocumentProcessingAbortedError
    || (err instanceof Error && err.name === "AbortError");
}

function isForeignKeyConstraintError(err: unknown): boolean {
  return typeof err === "object"
    && err !== null
    && "code" in err
    && (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_FOREIGNKEY";
}

/**
 * Map the raw processing error into a small set of stable, generic messages.
 * Full stack and details remain in the server logs above.
 */
function redactProcessingError(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)) || "";
  if (/embedding|vectoriz/i.test(msg)) return "Embedding step failed";
  if (/parse|chunk/i.test(msg)) return "Document parsing failed";
  if (/timeout|abort/i.test(msg)) return "Processing timed out";
  if (/permission|EACCES|ENOENT/i.test(msg)) return "Filesystem error";
  if (/quota|rate limit/i.test(msg)) return "Provider quota exceeded";
  return "Document processing failed";
}

async function vectorizeChunks(
  userId: string,
  doc: DatabankDocument,
  chunks: Array<{ id: string; content: string; chunkIndex: number }>,
  cfg: { model: string },
  signal: AbortSignal,
): Promise<void> {
  const failures: Error[] = [];
  await embeddingsSvc.embedWithAdaptiveBatching(
    userId,
    chunks,
    BATCH_SIZE,
    (c) => c.content,
    async (batch, _texts, vectors) => {
      if (signal.aborted || !crud.getDocument(userId, doc.id)) {
        throw signal.reason instanceof Error ? signal.reason : new DocumentProcessingAbortedError(doc.id);
      }

      const lanceRows = batch.map((c, j) => ({
        chatId: doc.databankId,
        chunkId: c.id,
        vector: vectors[j],
        content: c.content,
        metadata: {
          documentId: doc.id,
          databankId: doc.databankId,
          documentName: doc.name,
          chunkIndex: c.chunkIndex,
          sourceType: "databank",
        },
      }));

      await embeddingsSvc.batchUpsertDatabankVectors(userId, lanceRows);
      crud.updateChunkVectorization(batch.map((c) => c.id), cfg.model);
    },
    (_batch, err) => {
      failures.push(err);
    },
    { label: `databank:${doc.id.slice(0, 8)}`, signal },
  );

  if (failures.length > 0) {
    throw failures[0];
  }
}

/**
 * Delete all LanceDB vectors for a document's chunks.
 * Queries chunk IDs from SQLite and deletes by source_id for precision.
 */
export async function deleteDocumentVectors(userId: string, docId: string): Promise<void> {
  const chunks = crud.getChunksForDocument(docId);
  if (chunks.length === 0) return;
  const chunkIds = chunks.map((c) => c.id);
  await embeddingsSvc.deleteDatabankChunksByIds(userId, chunkIds);
}

/**
 * Delete all LanceDB vectors for a databank.
 */
export async function deleteDatabankVectors(userId: string, databankId: string): Promise<void> {
  await embeddingsSvc.deleteDatabankEmbeddings(userId, databankId);
}

function emitStatus(userId: string, doc: DatabankDocument, status: string, error?: string, totalChunks?: number): void {
  eventBus.emit(EventType.DATABANK_DOCUMENT_STATUS, {
    documentId: doc.id,
    databankId: doc.databankId,
    status,
    totalChunks,
    error,
  }, userId);
}
