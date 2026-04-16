/**
 * Databank — Public API surface.
 *
 * Single entry point for all databank operations: CRUD, document processing,
 * retrieval, scope resolution, and mention handling.
 */

// CRUD
export {
  createDatabank,
  listDatabanks,
  getDatabank,
  updateDatabank,
  deleteDatabank,
  createDocument,
  listDocuments,
  getDocument,
  ensureChatDatabank,
  renameDocument,
  getDocumentBySlug,
  searchDocumentsBySlug,
  deleteDocument,
  updateDocumentStatus,
  insertChunks,
  getChunksForDocument,
  getDocumentContent,
  getFullDocumentText,
} from "./databank-crud.service";

// Document processing
export { parseDocument, isSupportedFormat, getSupportedExtensions } from "./document-parser.service";
export { chunkDocument } from "./document-chunker.service";
export { processDocument, deleteDocumentVectors, deleteDatabankVectors } from "./vectorization.service";

// Retrieval
export {
  searchDatabanks,
  searchDirect,
  getCachedDatabankResult,
  clearCache,
} from "./retrieval.service";

// Scope resolution
export { resolveActiveDatabankIds } from "./scope-resolver.service";

// Mention resolution
export { resolveMentions, formatMentionsAsAppendix } from "./mention-resolver.service";

// Web scraping
export { scrapeUrl, ScrapeError, type ScrapedContent, type ScrapeErrorType } from "./web-scraper.service";

// Types
export type {
  Databank,
  DatabankDocument,
  DatabankChunk,
  DatabankScope,
  DocumentStatus,
  CreateDatabankInput,
  UpdateDatabankInput,
  DatabankSearchResult,
  DatabankRetrievalResult,
  ResolvedMention,
} from "./types";
