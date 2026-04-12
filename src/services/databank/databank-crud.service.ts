/**
 * Databank CRUD Service — Banks and documents.
 */

import { getDb } from "../../db/connection";
import { parsePagination, paginatedQuery } from "../pagination";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import * as filesSvc from "../files.service";
import {
  type Databank,
  type DatabankDocument,
  type DatabankChunk,
  type DatabankRow,
  type DatabankDocumentRow,
  type DatabankChunkRow,
  type DatabankScope,
  type CreateDatabankInput,
  type UpdateDatabankInput,
  rowToDatabank,
  rowToDocument,
  rowToChunk,
  nameToSlug,
} from "./types";
import type { PaginationParams, PaginatedResult } from "../../types/pagination";

// ─── Banks ────────────────────────────────────────────────────

export function createDatabank(userId: string, input: CreateDatabankInput): Databank {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const db = getDb();

  db.run(
    `INSERT INTO databanks (id, user_id, name, description, scope, scope_id, enabled, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, '{}', ?, ?)`,
    [id, userId, input.name, input.description ?? "", input.scope, input.scopeId ?? null, now, now],
  );

  const bank = getDatabank(userId, id)!;
  eventBus.emit(EventType.DATABANK_CHANGED, { databankId: bank.id, databank: bank }, userId);
  return bank;
}

export function listDatabanks(
  userId: string,
  pagination: PaginationParams,
  filters?: { scope?: DatabankScope; scopeId?: string },
): PaginatedResult<Databank> {
  const conditions = ["d.user_id = ?"];
  const params: any[] = [userId];

  if (filters?.scope) {
    conditions.push("d.scope = ?");
    params.push(filters.scope);
  }
  if (filters?.scopeId !== undefined) {
    conditions.push("d.scope_id = ?");
    params.push(filters.scopeId);
  }

  const where = conditions.join(" AND ");
  const dataSql = `
    SELECT d.*, (SELECT COUNT(*) FROM databank_documents dd WHERE dd.databank_id = d.id) AS doc_count
    FROM databanks d
    WHERE ${where}
    ORDER BY d.created_at DESC`;
  const countSql = `SELECT COUNT(*) AS count FROM databanks d WHERE ${where}`;

  return paginatedQuery<DatabankRow & { doc_count: number }, Databank>(
    dataSql,
    countSql,
    params,
    pagination,
    (row) => ({ ...rowToDatabank(row), documentCount: row.doc_count }),
  );
}

export function getDatabank(userId: string, id: string): Databank | null {
  const row = getDb()
    .query(
      `SELECT d.*, (SELECT COUNT(*) FROM databank_documents dd WHERE dd.databank_id = d.id) AS doc_count
       FROM databanks d WHERE d.id = ? AND d.user_id = ?`,
    )
    .get(id, userId) as (DatabankRow & { doc_count: number }) | null;
  if (!row) return null;
  return { ...rowToDatabank(row), documentCount: row.doc_count };
}

export function updateDatabank(userId: string, id: string, input: UpdateDatabankInput): Databank | null {
  const now = Math.floor(Date.now() / 1000);
  const sets: string[] = ["updated_at = ?"];
  const params: any[] = [now];

  if (input.name !== undefined) {
    sets.push("name = ?");
    params.push(input.name);
  }
  if (input.description !== undefined) {
    sets.push("description = ?");
    params.push(input.description);
  }
  if (input.enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(input.enabled ? 1 : 0);
  }

  params.push(id, userId);
  getDb().run(`UPDATE databanks SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, params);

  const bank = getDatabank(userId, id);
  if (bank) {
    eventBus.emit(EventType.DATABANK_CHANGED, { databankId: bank.id, databank: bank }, userId);
  }
  return bank;
}

export async function deleteDatabank(userId: string, id: string): Promise<boolean> {
  const db = getDb();

  // Delete all document files from disk
  const docs = db
    .query("SELECT file_path FROM databank_documents WHERE databank_id = ? AND user_id = ?")
    .all(id, userId) as Array<{ file_path: string }>;
  for (const doc of docs) {
    try {
      await filesSvc.deleteFile(userId, doc.file_path, "databank");
    } catch {
      // non-fatal — file may already be gone
    }
  }

  // CASCADE handles documents and chunks in SQLite
  const result = db.run("DELETE FROM databanks WHERE id = ? AND user_id = ?", [id, userId]);
  if (result.changes > 0) {
    eventBus.emit(EventType.DATABANK_DELETED, { databankId: id }, userId);
    return true;
  }
  return false;
}

/**
 * Find or create a chat-scoped databank. Used for auto-attaching uploaded documents.
 * If a chat-scoped bank already exists, returns the first one. Otherwise creates one
 * named after the chat.
 */
export function ensureChatDatabank(userId: string, chatId: string, chatName: string): Databank {
  const db = getDb();
  const existing = db
    .query(
      `SELECT d.*, (SELECT COUNT(*) FROM databank_documents dd WHERE dd.databank_id = d.id) AS doc_count
       FROM databanks d WHERE d.user_id = ? AND d.scope = 'chat' AND d.scope_id = ? AND d.enabled = 1
       ORDER BY d.created_at ASC LIMIT 1`,
    )
    .get(userId, chatId) as (DatabankRow & { doc_count: number }) | null;

  if (existing) {
    return { ...rowToDatabank(existing), documentCount: existing.doc_count };
  }

  // Also check if the chat has cross-referenced databanks via metadata
  // If so, use the first one instead of creating a new bank
  // (skip this — always create a fresh chat-scoped bank for auto-attach)

  return createDatabank(userId, {
    name: chatName || "Chat Documents",
    scope: "chat",
    scopeId: chatId,
  });
}

// ─── Documents ────────────────────────────────────────────────

export function createDocument(
  userId: string,
  databankId: string,
  name: string,
  filePath: string,
  mimeType: string,
  fileSize: number,
  contentHash: string,
): DatabankDocument {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const slug = nameToSlug(name);
  const db = getDb();

  db.run(
    `INSERT INTO databank_documents
     (id, databank_id, user_id, name, slug, file_path, mime_type, file_size, content_hash, total_chunks, status, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', '{}', ?, ?)`,
    [id, databankId, userId, name, slug, filePath, mimeType, fileSize, contentHash, now, now],
  );

  return getDocument(userId, id)!;
}

export function listDocuments(
  userId: string,
  databankId: string,
  pagination: PaginationParams,
): PaginatedResult<DatabankDocument> {
  return paginatedQuery<DatabankDocumentRow, DatabankDocument>(
    `SELECT * FROM databank_documents WHERE databank_id = ? AND user_id = ? ORDER BY created_at DESC`,
    `SELECT COUNT(*) AS count FROM databank_documents WHERE databank_id = ? AND user_id = ?`,
    [databankId, userId],
    pagination,
    rowToDocument,
  );
}

export function renameDocument(userId: string, id: string, newName: string): DatabankDocument | null {
  const now = Math.floor(Date.now() / 1000);
  const slug = nameToSlug(newName);
  getDb().run(
    "UPDATE databank_documents SET name = ?, slug = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    [newName, slug, now, id, userId],
  );
  return getDocument(userId, id);
}

export function getDocument(userId: string, id: string): DatabankDocument | null {
  const row = getDb()
    .query("SELECT * FROM databank_documents WHERE id = ? AND user_id = ?")
    .get(id, userId) as DatabankDocumentRow | null;
  return row ? rowToDocument(row) : null;
}

export function getDocumentBySlug(userId: string, slug: string): DatabankDocument | null {
  const row = getDb()
    .query("SELECT * FROM databank_documents WHERE user_id = ? AND slug = ? AND status = 'ready' LIMIT 1")
    .get(userId, slug) as DatabankDocumentRow | null;
  return row ? rowToDocument(row) : null;
}

export function searchDocumentsBySlug(
  userId: string,
  partialSlug: string,
  databankIds?: string[],
  limit = 10,
): Array<{ slug: string; name: string; databankId: string; databankName: string }> {
  const db = getDb();
  const slugPattern = `%${partialSlug.toLowerCase()}%`;

  let sql: string;
  let params: any[];

  if (databankIds && databankIds.length > 0) {
    const placeholders = databankIds.map(() => "?").join(",");
    sql = `SELECT dd.slug, dd.name, dd.databank_id, d.name AS bank_name
           FROM databank_documents dd
           JOIN databanks d ON d.id = dd.databank_id
           WHERE dd.user_id = ? AND dd.status = 'ready'
             AND dd.databank_id IN (${placeholders})
             AND dd.slug LIKE ?
           ORDER BY dd.name ASC
           LIMIT ?`;
    params = [userId, ...databankIds, slugPattern, limit];
  } else {
    sql = `SELECT dd.slug, dd.name, dd.databank_id, d.name AS bank_name
           FROM databank_documents dd
           JOIN databanks d ON d.id = dd.databank_id
           WHERE dd.user_id = ? AND dd.status = 'ready'
             AND dd.slug LIKE ?
           ORDER BY dd.name ASC
           LIMIT ?`;
    params = [userId, slugPattern, limit];
  }

  const rows = db.query(sql).all(...params) as Array<{
    slug: string;
    name: string;
    databank_id: string;
    bank_name: string;
  }>;

  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    databankId: r.databank_id,
    databankName: r.bank_name,
  }));
}

export async function deleteDocument(userId: string, docId: string): Promise<boolean> {
  const db = getDb();
  const doc = getDocument(userId, docId);
  if (!doc) return false;

  // Delete file from disk
  try {
    await filesSvc.deleteFile(userId, doc.filePath, "databank");
  } catch {
    // non-fatal
  }

  // CASCADE handles chunks
  const result = db.run("DELETE FROM databank_documents WHERE id = ? AND user_id = ?", [docId, userId]);
  if (result.changes > 0) {
    eventBus.emit(EventType.DATABANK_DOCUMENT_STATUS, {
      documentId: docId,
      databankId: doc.databankId,
      status: "deleted",
    }, userId);
    return true;
  }
  return false;
}

export function updateDocumentStatus(
  docId: string,
  status: string,
  extra?: { totalChunks?: number; errorMessage?: string | null },
): void {
  const now = Math.floor(Date.now() / 1000);
  const sets = ["status = ?", "updated_at = ?"];
  const params: any[] = [status, now];

  if (extra?.totalChunks !== undefined) {
    sets.push("total_chunks = ?");
    params.push(extra.totalChunks);
  }
  if (extra?.errorMessage !== undefined) {
    sets.push("error_message = ?");
    params.push(extra.errorMessage);
  }

  params.push(docId);
  getDb().run(`UPDATE databank_documents SET ${sets.join(", ")} WHERE id = ?`, params);
}

// ─── Chunks ───────────────────────────────────────────────────

export function insertChunks(chunks: Array<{
  id: string;
  documentId: string;
  databankId: string;
  userId: string;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  metadata?: Record<string, unknown>;
}>): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.query(
    `INSERT INTO databank_chunks (id, document_id, databank_id, user_id, chunk_index, content, token_count, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    for (const c of chunks) {
      stmt.run(c.id, c.documentId, c.databankId, c.userId, c.chunkIndex, c.content, c.tokenCount, JSON.stringify(c.metadata ?? {}), now);
    }
  });
  tx();
}

export function getChunksForDocument(docId: string): DatabankChunk[] {
  const rows = getDb()
    .query("SELECT * FROM databank_chunks WHERE document_id = ? ORDER BY chunk_index ASC")
    .all(docId) as DatabankChunkRow[];
  return rows.map(rowToChunk);
}

export function getChunksByIds(chunkIds: string[]): DatabankChunk[] {
  if (chunkIds.length === 0) return [];
  const placeholders = chunkIds.map(() => "?").join(",");
  const rows = getDb()
    .query(`SELECT * FROM databank_chunks WHERE id IN (${placeholders}) ORDER BY chunk_index ASC`)
    .all(...chunkIds) as DatabankChunkRow[];
  return rows.map(rowToChunk);
}

export function updateChunkVectorization(chunkIds: string[], vectorModel: string): void {
  if (chunkIds.length === 0) return;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const placeholders = chunkIds.map(() => "?").join(",");
  db.run(
    `UPDATE databank_chunks SET vectorized_at = ?, vector_model = ? WHERE id IN (${placeholders})`,
    [now, vectorModel, ...chunkIds],
  );
}

export function deleteChunksForDocument(docId: string): void {
  getDb().run("DELETE FROM databank_chunks WHERE document_id = ?", [docId]);
}

export function getDocumentContent(userId: string, docId: string): string | null {
  const rows = getDb()
    .query("SELECT content FROM databank_chunks WHERE document_id = ? AND user_id = ? ORDER BY chunk_index ASC")
    .all(docId, userId) as Array<{ content: string }>;
  if (rows.length === 0) return null;
  return rows.map((r) => r.content).join("\n");
}

/**
 * Get all chunk content for a document, concatenated.
 * Used for #mention resolution when the full document fits in budget.
 */
export function getFullDocumentText(userId: string, docId: string): string | null {
  const rows = getDb()
    .query("SELECT content FROM databank_chunks WHERE document_id = ? AND user_id = ? ORDER BY chunk_index ASC")
    .all(docId, userId) as Array<{ content: string }>;
  if (rows.length === 0) return null;
  return rows.map((r) => r.content).join("\n");
}
