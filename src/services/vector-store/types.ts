/**
 * Vector store abstraction — provider-neutral contract.
 *
 * Lumiverse defaults to LanceDB (embedded, on-disk) but can be pointed at an
 * external Qdrant or Milvus cluster for power-user / self-hosted scale. Every
 * provider implements {@link VectorStore}; the ONLY place a provider's client
 * SDK is imported is its own file under `providers/`.
 *
 * Embedding *generation* (the HTTP calls that produce vectors) is orthogonal to
 * storage and stays in `embeddings.service.ts` — vectors are derived; SQLite is
 * the source of truth.
 */

/** Logical collections. Mirrors the two LanceDB tables that exist today. */
export type CollectionName = "embeddings" | "embeddings_world_books";

/** Discriminator stored on every row to scope it to a consumer. */
export type SourceType = "chat_chunk" | "world_book_entry" | "vault_chunk" | "databank";

/**
 * One stored vector + its addressing metadata. Identical field set to the
 * historical LanceDB `EmbeddingRow`, so the existing schema is preserved.
 */
export interface VectorRow {
  /** Composite identity `userId:sourceType:sourceId:chunkIndex` (see `rowId`).
   *  LanceDB/Milvus use this directly; Qdrant hashes it to a UUIDv5 point id
   *  and keeps this string in the payload. */
  id: string;
  user_id: string;
  source_type: string;
  source_id: string;
  owner_id: string;
  chunk_index: number;
  content: string;
  vector: number[];
  /** Opaque JSON string — never parsed by the store layer. */
  metadata_json: string;
  /** Unix epoch seconds. */
  updated_at: number;
}

/**
 * Structured, provider-neutral filter. Replaces the inline LanceDB SQL `where()`
 * strings. The builders in `addressing.ts` are the ONLY producers; each provider
 * renders this union into its own dialect (LanceDB SQL / Qdrant must·must_not /
 * Milvus boolean expr).
 */
export type VectorFilter =
  | { op: "eq"; field: string; value: string | number }
  | { op: "in"; field: string; values: Array<string | number> }
  | { op: "nin"; field: string; values: Array<string | number> }
  | { op: "and"; clauses: VectorFilter[] };

/**
 * Canonical search hit. `similarity` is normalized so HIGHER = BETTER across all
 * providers (cosine similarity, typically [-1, 1]); a lexical-only hit that has
 * no vector distance carries `similarity: null`. The `embeddings.service.ts`
 * adapter converts this back to the historical distance-shaped public contract
 * (`distance = 1 - similarity`), so no downstream consumer changes.
 */
export interface VectorHit {
  id: string;
  source_id: string;
  content: string;
  metadata_json: string;
  /** Normalized cosine similarity (higher = better). `null` for lexical-only hits. */
  similarity: number | null;
  /** Raw lexical (BM25/FTS) score when the hit came from the lexical leg. */
  lexicalScore: number | null;
  /** Present only when {@link SearchOptions.withVector} was requested (for MMR). */
  vector: number[] | null;
}

export interface SearchOptions {
  collection: CollectionName;
  vector: number[];
  filter: VectorFilter;
  limit: number;
  /** Pull the vector column back for downstream MMR diversity selection. */
  withVector: boolean;
  /** LanceDB maps this to `refineFactor(5)`; other providers ignore it. */
  refine?: boolean;
  signal?: AbortSignal;
}

export interface LexicalSearchOptions {
  collection: CollectionName;
  queryText: string;
  filter: VectorFilter;
  limit: number;
  withVector: boolean;
  signal?: AbortSignal;
}

export interface HybridSearchOptions extends SearchOptions {
  queryText: string;
}

/**
 * Per-provider capability flags. Orchestration NEVER switches on `store.id` —
 * the single branching seam is this object. Drives both retrieval behavior
 * (lexical leg) and the operator UI (which controls to show).
 */
export interface ProviderCapabilities {
  /** Has a usable lexical leg: LanceDB FTS, Milvus ≥2.5 BM25, Qdrant sparse. */
  nativeLexical: boolean;
  /** Point ids must be UUID/integer (Qdrant) — composite string hashed to UUIDv5. */
  requiresUuidIds: boolean;
  /** Writes are not durably queryable until an explicit flush (Milvus). */
  requiresExplicitFlush: boolean;
  /** Collection must be loaded into memory before search/delete (Milvus). */
  requiresLoadBeforeQuery: boolean;
  /** Native score space the provider returns before `toSimilarity()`. */
  scoreKind: "cosine_distance" | "cosine_similarity";
  /** Provider manages its own ANN/scalar/FTS index lifecycle (LanceDB). */
  managesOwnIndexes: boolean;
  /** Remote service with no on-disk directory to delete (Qdrant/Milvus). */
  externalService: boolean;
  /** Supports a compaction/optimize pass (LanceDB only). */
  supportsOptimize: boolean;
  /** Vector dimension is locked when the collection is created (all three). */
  dimensionLockedAtCreate: boolean;
}

/** Per-collection health, surfaced to the owner-only operator panel. */
export interface TableHealth {
  exists: boolean;
  rowCount: number;
  vectorIndexReady: boolean;
  scalarIndexReady: boolean;
  ftsIndexReady: boolean;
  unindexedRowEstimate: number;
  lastIndexRebuildAt: number;
  indexes: Array<{ name: string; type?: string }>;
  dimension?: number | null;
}

export type VectorStoreProviderId = "lancedb" | "qdrant" | "milvus";

/**
 * The storage contract. Implementations live under `providers/` and are the
 * sole importers of their client SDK.
 */
export interface VectorStore {
  readonly id: VectorStoreProviderId;
  readonly capabilities: ProviderCapabilities;

  /** Connect + reachability/version probe. Throws a helpful error if the
   *  optional SDK is missing or the server is unreachable. Idempotent. */
  init(): Promise<void>;
  /** Create the collection (dimension-locked) if absent; no-op if present. */
  ensureCollection(collection: CollectionName, dimension: number): Promise<void>;
  /** The locked vector dimension of an existing collection, or null if absent. */
  getStoredDimension(collection: CollectionName): Promise<number | null>;

  /** Idempotent upsert by `id`; rows are durably queryable on return. */
  upsert(collection: CollectionName, rows: VectorRow[]): Promise<void>;
  /** Read full stored rows for provider-neutral copy/move flows. */
  getRowsByFilter(collection: CollectionName, filter: VectorFilter, limit?: number): Promise<VectorRow[]>;
  deleteByFilter(collection: CollectionName, filter: VectorFilter): Promise<void>;
  deleteByIds(collection: CollectionName, ids: string[]): Promise<void>;

  /** KNN search. Returned hits carry similarity already normalized to "higher = better". */
  vectorSearch(opts: SearchOptions): Promise<VectorHit[]>;
  /** Lexical/BM25 search. Returns `[]` when `!capabilities.nativeLexical`. */
  lexicalSearch(opts: LexicalSearchOptions): Promise<VectorHit[]>;
  /** Optional provider-native dense+sparse hybrid fusion. LanceDB intentionally uses app-side fusion. */
  hybridSearch?(opts: HybridSearchOptions): Promise<VectorHit[]>;

  countRows(collection: CollectionName, filter?: VectorFilter): Promise<number>;
  /** Compaction / index rebuild. No-op where unsupported. */
  optimize(collections?: CollectionName[]): Promise<void>;
  health(collection: CollectionName): Promise<TableHealth>;
  /** Drop everything this store owns (on-disk dir for LanceDB; collections otherwise). */
  reset(): Promise<{ deleted: boolean; location: string }>;
  close(): Promise<void>;

  /** LanceDB-only write-serialization seam. `undefined` on external providers,
   *  whose servers serialize internally — callers fall back to running `fn()`. */
  withWriteLock?<T>(fn: () => Promise<T>): Promise<T>;
}
