/**
 * Databank — Type definitions for the document knowledge bank system.
 *
 * SQLite row shapes use snake_case; service-layer DTOs use camelCase.
 */

// ─── Scope & Status ───────────────────────────────────────────

export type DatabankScope = "global" | "character" | "chat";
export type DocumentStatus = "pending" | "processing" | "ready" | "error";

// ─── SQLite Row Shapes ────────────────────────────────────────

export interface DatabankRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  scope: string;
  scope_id: string | null;
  enabled: number;
  metadata: string; // JSON
  created_at: number;
  updated_at: number;
}

export interface DatabankDocumentRow {
  id: string;
  databank_id: string;
  user_id: string;
  name: string;
  slug: string;
  file_path: string;
  mime_type: string;
  file_size: number;
  content_hash: string;
  total_chunks: number;
  status: string;
  error_message: string | null;
  metadata: string; // JSON
  created_at: number;
  updated_at: number;
}

export interface DatabankChunkRow {
  id: string;
  document_id: string;
  databank_id: string;
  user_id: string;
  chunk_index: number;
  content: string;
  token_count: number;
  vectorized_at: number | null;
  vector_model: string | null;
  metadata: string; // JSON
  created_at: number;
}

// ─── Service-Layer DTOs ───────────────────────────────────────

export interface Databank {
  id: string;
  userId: string;
  name: string;
  description: string;
  scope: DatabankScope;
  scopeId: string | null;
  enabled: boolean;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  /** Populated on list/get — count of documents in this bank */
  documentCount?: number;
}

export interface DatabankDocument {
  id: string;
  databankId: string;
  userId: string;
  name: string;
  slug: string;
  filePath: string;
  mimeType: string;
  fileSize: number;
  contentHash: string;
  totalChunks: number;
  status: DocumentStatus;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface DatabankChunk {
  id: string;
  documentId: string;
  databankId: string;
  userId: string;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  vectorizedAt: number | null;
  vectorModel: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
}

// ─── Input Shapes ─────────────────────────────────────────────

export interface CreateDatabankInput {
  name: string;
  description?: string;
  scope: DatabankScope;
  scopeId?: string | null;
}

export interface UpdateDatabankInput {
  name?: string;
  description?: string;
  enabled?: boolean;
}

// ─── Retrieval Types ──────────────────────────────────────────

export interface DatabankSearchResult {
  chunkId: string;
  documentId: string;
  databankId: string;
  documentName: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface DatabankRetrievalResult {
  chunks: DatabankSearchResult[];
  formatted: string;
  count: number;
}

export interface ResolvedMention {
  slug: string;
  documentName: string;
  content: string;
  truncated: boolean;
}

// ─── Row ↔ DTO Conversion ────────────────────────────────────

export function rowToDatabank(row: DatabankRow): Databank {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description,
    scope: row.scope as DatabankScope,
    scopeId: row.scope_id,
    enabled: row.enabled === 1,
    metadata: JSON.parse(row.metadata || "{}"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToDocument(row: DatabankDocumentRow): DatabankDocument {
  return {
    id: row.id,
    databankId: row.databank_id,
    userId: row.user_id,
    name: row.name,
    slug: row.slug,
    filePath: row.file_path,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    contentHash: row.content_hash,
    totalChunks: row.total_chunks,
    status: row.status as DocumentStatus,
    errorMessage: row.error_message,
    metadata: JSON.parse(row.metadata || "{}"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToChunk(row: DatabankChunkRow): DatabankChunk {
  return {
    id: row.id,
    documentId: row.document_id,
    databankId: row.databank_id,
    userId: row.user_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    tokenCount: row.token_count,
    vectorizedAt: row.vectorized_at,
    vectorModel: row.vector_model,
    metadata: JSON.parse(row.metadata || "{}"),
    createdAt: row.created_at,
  };
}

/** Convert a document name to a URL-safe slug for #mention matching */
export function nameToSlug(name: string): string {
  return name
    .replace(/\.[^.]+$/, "")       // strip extension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")   // non-alphanum → hyphen
    .replace(/^-+|-+$/g, "")       // trim leading/trailing hyphens
    .replace(/-{2,}/g, "-");        // collapse double hyphens
}
