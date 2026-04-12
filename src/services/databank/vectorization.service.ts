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
import type { DatabankDocument } from "./types";

const BATCH_SIZE = 50;

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

  try {
    // Mark as processing
    crud.updateDocumentStatus(docId, "processing");
    emitStatus(userId, doc, "processing");

    // 1. Parse the file
    const parsed = await parseDocument(userId, doc.filePath);
    if (!parsed.text.trim()) {
      crud.updateDocumentStatus(docId, "error", { errorMessage: "Document is empty after parsing" });
      emitStatus(userId, doc, "error", "Document is empty after parsing");
      return;
    }

    // 2. Chunk the text
    const chunkResults = chunkDocument(parsed.text);
    if (chunkResults.length === 0) {
      crud.updateDocumentStatus(docId, "error", { errorMessage: "No chunks produced from document" });
      emitStatus(userId, doc, "error", "No chunks produced from document");
      return;
    }

    // 3. Delete old chunks (for reprocessing)
    crud.deleteChunksForDocument(docId);

    // 4. Insert chunk rows into SQLite
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
    crud.insertChunks(chunkRows);
    crud.updateDocumentStatus(docId, "processing", { totalChunks: chunkRows.length });

    // 5. Vectorize chunks
    const cfg = await embeddingsSvc.getEmbeddingConfig(userId);
    if (!cfg.enabled) {
      // Embeddings not configured — mark as ready without vectors
      crud.updateDocumentStatus(docId, "ready", { totalChunks: chunkRows.length });
      emitStatus(userId, doc, "ready", undefined, chunkRows.length);
      return;
    }

    await vectorizeChunks(userId, doc, chunkRows, cfg);

    // 6. Mark as ready
    crud.updateDocumentStatus(docId, "ready", { totalChunks: chunkRows.length });
    emitStatus(userId, doc, "ready", undefined, chunkRows.length);

    console.info(`[databank] Processed document "${doc.name}" — ${chunkRows.length} chunks vectorized`);
  } catch (err: any) {
    console.error(`[databank] Failed to process document ${docId}:`, err);
    crud.updateDocumentStatus(docId, "error", { errorMessage: err.message || "Unknown error" });
    emitStatus(userId, doc, "error", err.message);
  }
}

async function vectorizeChunks(
  userId: string,
  doc: DatabankDocument,
  chunks: Array<{ id: string; content: string; chunkIndex: number }>,
  cfg: { model: string },
): Promise<void> {
  // Process in batches
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((c) => c.content);

    const vectors = await embeddingsSvc.embedTexts(userId, texts);

    // Upsert to LanceDB via the existing batch pattern
    const lanceRows = batch.map((c, j) => ({
      chatId: doc.databankId, // owner_id = databankId for scope filtering
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

    // Mark chunks as vectorized
    crud.updateChunkVectorization(
      batch.map((c) => c.id),
      cfg.model,
    );
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
