import { connect as connectTcp } from "node:net";
import type { MilvusConnectionConfig, MilvusHybridSearchConfig, VectorStoreTuningProfile } from "../../vector-store-config.service";
import { adaptiveStorageBatch, isRetryableStorageError } from "../addressing";
import { milvusCapabilities } from "../capabilities";
import type {
  CollectionName,
  HybridSearchOptions,
  LexicalSearchOptions,
  ProviderCapabilities,
  SearchOptions,
  TableHealth,
  VectorFilter,
  VectorHit,
  VectorRow,
  VectorStore,
  VectorStoreProviderId,
} from "../types";

const COLLECTION_PREFIX = "lumiverse_";
const VARCHAR_MAX = 65_535;
const DEFAULT_TCP_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_RPC_TIMEOUT_MS = 60_000;
const DEFAULT_HYBRID_CANDIDATE_MULTIPLIER = 3;
const DEFAULT_HYBRID_CANDIDATE_CAP = 200;
const OUTPUT_FIELDS = ["id", "user_id", "source_type", "source_id", "owner_id", "chunk_index", "content", "metadata_json", "updated_at"];
const SCALAR_INDEX_FIELDS = ["user_id", "source_type", "source_id", "owner_id", "chunk_index"];
const SPARSE_FIELD = "sparse";
const DEFAULT_UPSERT_BATCH_SIZE = 128;
const BULK_UPSERT_BATCH_SIZE = 256;

type MilvusSdk = typeof import("@zilliz/milvus2-sdk-node");
type MilvusClientLike = any;

export class MilvusStore implements VectorStore {
  readonly id: VectorStoreProviderId = "milvus";
  capabilities: ProviderCapabilities = milvusCapabilities(null);

  private readonly config: MilvusConnectionConfig | undefined;
  private readonly password: string | null;
  private readonly tuningProfile: VectorStoreTuningProfile;
  private readonly hybridSearchConfig: MilvusHybridSearchConfig | undefined;
  private sdk: MilvusSdk | null = null;
  private client: MilvusClientLike | null = null;
  private loaded = new Set<string>();
  private hybridFallbackCollections = new Set<string>();

  constructor(
    config: MilvusConnectionConfig | undefined,
    password: string | null,
    tuningProfile?: VectorStoreTuningProfile,
    hybridSearchConfig?: MilvusHybridSearchConfig,
  ) {
    if (!config?.address) {
      throw new Error("Milvus vector store requires milvus.address (or LUMIVERSE_MILVUS_ADDRESS)." );
    }
    this.config = config;
    this.password = password;
    this.tuningProfile = tuningProfile || "balanced";
    this.hybridSearchConfig = hybridSearchConfig;
  }

  async init(): Promise<void> {
    if (this.client) return;
    try {
      this.sdk = await import("@zilliz/milvus2-sdk-node");
    } catch (err) {
      throw new Error(`Milvus vector store support requires @zilliz/milvus2-sdk-node. Install dependencies and restart. (${err instanceof Error ? err.message : String(err)})`);
    }

    const { MilvusClient } = this.sdk;
    const cfg = this.config!;
    if (cfg.transport === "http") {
      throw new Error("Milvus HTTP transport is not supported yet. Use the Milvus gRPC endpoint, typically host:19530, with transport set to gRPC.");
    }
    await assertTcpReachable(cfg.address, cfg.ssl === true, milvusConnectTimeoutMs(cfg));
    this.client = new MilvusClient({
      address: cfg.address,
      ssl: cfg.ssl,
      username: cfg.username,
      password: this.password || undefined,
      database: cfg.database,
      logLevel: "error",
      timeout: milvusRequestTimeoutMs(cfg),
    });
    try {
      await this.client.connectPromise;
    } catch (err) {
      throw new Error(`Milvus gRPC connection failed for ${cfg.address}: ${describeMilvusError(err)}`);
    }

    const version = await this.client.getVersion().then((res: any) => res?.version || res?.data || null).catch(() => null);
    this.capabilities = milvusCapabilities(version);
    const health = await this.client.checkHealth().catch((err: any) => {
      throw new Error(`Milvus health check failed for ${cfg.address}: ${describeMilvusError(err)}`);
    });
    if (health?.isHealthy === false) throw new Error("Milvus health check reported unhealthy.");
  }

  async ensureCollection(collection: CollectionName, dimension: number): Promise<void> {
    const client = await this.getClient();
    const name = this.collectionName(collection);
    const has = await this.hasCollection(name);
    if (has) {
      const existing = await this.getStoredDimension(collection);
      if (existing != null && existing !== dimension) {
        throw new Error(`Milvus collection ${name} has dimension ${existing}, expected ${dimension}. Reindex with a matching embedding model or reset the vector store.`);
      }
      await this.ensureScalarIndexes(name);
      await this.ensureSparseIndexIfPresent(name);
      await this.loadCollection(name);
      return;
    }

    const { DataType, FunctionType, MetricType } = this.sdk!;
    const tuning = milvusTuning(this.tuningProfile);
    const fields: any[] = [
      { name: "id", data_type: DataType.VarChar, is_primary_key: true, autoID: false, max_length: 512 },
      { name: "user_id", data_type: DataType.VarChar, max_length: 128 },
      { name: "source_type", data_type: DataType.VarChar, max_length: 64 },
      { name: "source_id", data_type: DataType.VarChar, max_length: 256 },
      { name: "owner_id", data_type: DataType.VarChar, max_length: 256 },
      { name: "chunk_index", data_type: DataType.Int64 },
      { name: "content", data_type: DataType.VarChar, max_length: VARCHAR_MAX },
      { name: "metadata_json", data_type: DataType.VarChar, max_length: VARCHAR_MAX },
      { name: "updated_at", data_type: DataType.Int64 },
      { name: "vector", data_type: DataType.FloatVector, dim: dimension },
    ];
    const indexParams: any[] = [
      {
        field_name: "vector",
        index_type: tuning.vectorIndexType,
        metric_type: MetricType.COSINE,
        params: tuning.vectorIndexParams,
      },
    ];
    const functions: any[] = [];

    if (this.capabilities.nativeLexical) {
      fields.find((field) => field.name === "content").enable_analyzer = true;
      fields.push({ name: SPARSE_FIELD, data_type: DataType.SparseFloatVector });
      indexParams.push({
        field_name: SPARSE_FIELD,
        index_type: "SPARSE_INVERTED_INDEX",
        metric_type: MetricType.BM25,
      });
      functions.push({
        name: "content_bm25",
        type: FunctionType.BM25,
        input_field_names: ["content"],
        output_field_names: [SPARSE_FIELD],
        params: {},
      });
    }

    const createRequest = {
      collection_name: name,
      fields,
      index_params: indexParams,
      enable_dynamic_field: false,
      ...(functions.length > 0 ? { functions } : {}),
    };

    try {
      await assertOk(client.createCollection(createRequest));
    } catch (err) {
      if (!this.capabilities.nativeLexical) throw err;
      console.warn(`[vector-store] Milvus BM25 collection creation failed for ${name}; falling back to dense-only schema:`, describeMilvusError(err));
      this.capabilities = { ...this.capabilities, nativeLexical: false };
      await assertOk(client.createCollection({
        ...createRequest,
        fields: fields.filter((field) => field.name !== SPARSE_FIELD).map((field) => field.name === "content" ? { ...field, enable_analyzer: undefined } : field),
        index_params: indexParams.filter((index) => index.field_name !== SPARSE_FIELD),
        functions: undefined,
      }));
    }
    await this.ensureScalarIndexes(name);
    await this.loadCollection(name);
  }

  async getStoredDimension(collection: CollectionName): Promise<number | null> {
    const client = await this.getClient();
    const name = this.collectionName(collection);
    if (!(await this.hasCollection(name))) return null;
    const desc = await client.describeCollection({ collection_name: name });
    const field = desc?.schema?.fields?.find((f: any) => f.name === "vector");
    const dim = field?.dim ?? field?.type_params?.find?.((p: any) => p.key === "dim")?.value;
    const parsed = Number(dim);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  async upsert(collection: CollectionName, rows: VectorRow[]): Promise<void> {
    if (rows.length === 0) return;
    const client = await this.getClient();
    const name = this.collectionName(collection);
    await this.ensureCollection(collection, rows[0].vector.length);
    const initialBatchSize = this.tuningProfile === "bulk_reindex" ? BULK_UPSERT_BATCH_SIZE : DEFAULT_UPSERT_BATCH_SIZE;
    await adaptiveStorageBatch(
      rows,
      initialBatchSize,
      async (batch) => {
        await assertOk(client.upsert({ collection_name: name, data: batch.map(rowToMilvusData) }));
      },
      {
        label: `Milvus upsert ${name}`,
        isRetryable: isRetryableStorageError,
      },
    );
    if (this.tuningProfile !== "bulk_reindex") {
      await this.flush(name);
      await this.loadCollection(name, true);
    }
  }

  async getRowsByFilter(collection: CollectionName, filter: VectorFilter, limit = 10_000): Promise<VectorRow[]> {
    const client = await this.getClient();
    const name = this.collectionName(collection);
    if (!(await this.hasCollection(name))) return [];
    await this.loadCollection(name);
    const rows: any[] = [];
    let offset = 0;
    while (rows.length < limit) {
      const res = await client.query({
        collection_name: name,
        filter: translateFilter(filter),
        output_fields: [...OUTPUT_FIELDS, "vector"],
        limit: Math.min(1024, limit - rows.length),
        offset,
      });
      const batch = Array.isArray(res?.data) ? res.data : [];
      rows.push(...batch);
      if (batch.length === 0) break;
      offset += batch.length;
    }
    return rows.map(milvusRowToVectorRow).filter((row): row is VectorRow => row != null);
  }

  async deleteByFilter(collection: CollectionName, filter: VectorFilter): Promise<void> {
    const client = await this.getClient();
    const name = this.collectionName(collection);
    if (!(await this.hasCollection(name))) return;
    await assertOk(client.delete({ collection_name: name, filter: translateFilter(filter) }));
    await this.flush(name);
  }

  async deleteByIds(collection: CollectionName, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const client = await this.getClient();
    const name = this.collectionName(collection);
    if (!(await this.hasCollection(name))) return;
    for (let i = 0; i < ids.length; i += 512) {
      await assertOk(client.delete({ collection_name: name, ids: ids.slice(i, i + 512) }));
    }
    await this.flush(name);
  }

  async vectorSearch(opts: SearchOptions): Promise<VectorHit[]> {
    if (opts.signal?.aborted) return [];
    const client = await this.getClient();
    const name = this.collectionName(opts.collection);
    if (!(await this.hasCollection(name))) return [];
    await this.loadCollection(name);
    const res = await client.search({
      collection_name: name,
      data: opts.vector,
      anns_field: "vector",
      filter: translateFilter(opts.filter),
      limit: opts.limit,
      metric_type: "COSINE",
      params: milvusTuning(this.tuningProfile).searchParams,
      output_fields: opts.withVector ? [...OUTPUT_FIELDS, "vector"] : OUTPUT_FIELDS,
    });
    if (opts.signal?.aborted) return [];
    const results = Array.isArray(res?.results) ? res.results : [];
    return results.map((row: any) => milvusSearchRowToHit(row, opts.withVector)).filter((hit: VectorHit | null): hit is VectorHit => hit != null);
  }

  async lexicalSearch(opts: LexicalSearchOptions): Promise<VectorHit[]> {
    if (opts.signal?.aborted || !this.capabilities.nativeLexical || !opts.queryText.trim()) return [];
    const client = await this.getClient();
    const name = this.collectionName(opts.collection);
    if (!(await this.hasCollection(name)) || !(await this.hasSparseField(name))) return [];
    await this.loadCollection(name);
    try {
      const res = await client.search({
        collection_name: name,
        data: opts.queryText.trim(),
        anns_field: SPARSE_FIELD,
        filter: translateFilter(opts.filter),
        limit: opts.limit,
        metric_type: "BM25",
        params: {},
        output_fields: opts.withVector ? [...OUTPUT_FIELDS, "vector"] : OUTPUT_FIELDS,
      });
      if (opts.signal?.aborted) return [];
      const results = Array.isArray(res?.results) ? res.results : [];
      return results.map((row: any) => milvusSearchRowToHit(row, opts.withVector, true)).filter((hit: VectorHit | null): hit is VectorHit => hit != null);
    } catch (err) {
      console.warn("[vector-store] Milvus BM25 lexical search failed; falling back to dense-only results:", describeMilvusError(err));
      return [];
    }
  }

  async hybridSearch(opts: HybridSearchOptions): Promise<VectorHit[]> {
    if (opts.signal?.aborted || !this.capabilities.nativeLexical || !opts.queryText.trim()) return this.vectorSearch(opts);
    const client = await this.getClient();
    const name = this.collectionName(opts.collection);
    if (this.hybridFallbackCollections.has(name)) {
      return this.appSideHybridSearch(opts);
    }
    if (!(await this.hasCollection(name)) || !(await this.hasSparseField(name))) return this.vectorSearch(opts);
    await this.loadCollection(name);
    const requestedLimit = Math.max(1, opts.limit);
    const candidateLimit = milvusHybridCandidateLimit(requestedLimit, this.hybridSearchConfig);
    try {
      const res = await client.hybridSearch({
        collection_name: name,
        data: [
          {
            data: opts.vector,
            anns_field: "vector",
            expr: translateFilter(opts.filter),
            limit: candidateLimit,
            metric_type: "COSINE",
            params: milvusTuning(this.tuningProfile).searchParams,
          },
          {
            data: opts.queryText.trim(),
            anns_field: SPARSE_FIELD,
            expr: translateFilter(opts.filter),
            limit: candidateLimit,
            metric_type: "BM25",
            params: {},
          },
        ],
        rerank: { strategy: "rrf", params: { k: 60 } },
        limit: requestedLimit,
        output_fields: opts.withVector ? [...OUTPUT_FIELDS, "vector"] : OUTPUT_FIELDS,
      });
      if (opts.signal?.aborted) return [];
      const results = Array.isArray(res?.results) ? res.results : [];
      const hits = results
        .map((row: any) => milvusSearchRowToHit(row, opts.withVector))
        .filter((hit: VectorHit | null): hit is VectorHit => hit != null);
      if (hits.length > 0) return hits;

      const fusedHits = await this.appSideHybridSearch(opts);
      if (fusedHits.length > 0) {
        this.hybridFallbackCollections.add(name);
        console.warn(
          "[vector-store] Milvus hybrid search returned 0 rows for %s despite dense/BM25 hits; switching this collection to app-side fusion for the rest of the process.",
          name,
        );
        return fusedHits;
      }
      return [];
    } catch (err) {
      this.hybridFallbackCollections.add(name);
      console.warn(
        "[vector-store] Milvus hybrid search failed for %s; switching to app-side dense/BM25 fusion: %s",
        name,
        describeMilvusError(err),
      );
      return this.appSideHybridSearch(opts);
    }
  }

  async countRows(collection: CollectionName, filter?: VectorFilter): Promise<number> {
    const client = await this.getClient();
    const name = this.collectionName(collection);
    if (!(await this.hasCollection(name))) return 0;
    const res = await client.count({ collection_name: name, filter: filter ? translateFilter(filter) : undefined });
    return Number(res?.data ?? 0);
  }

  async optimize(_collections?: CollectionName[]): Promise<void> {
    for (const collection of _collections ?? ["embeddings", "embeddings_world_books"] as CollectionName[]) {
      const name = this.collectionName(collection);
      if (await this.hasCollection(name)) {
        await this.flush(name);
        await this.loadCollection(name, true);
      }
    }
  }

  async health(collection: CollectionName): Promise<TableHealth> {
    const client = await this.getClient();
    const name = this.collectionName(collection);
    if (!(await this.hasCollection(name))) return emptyHealth();
    const [rowCount, dimension, indexes] = await Promise.all([
      this.countRows(collection).catch(() => 0),
      this.getStoredDimension(collection).catch(() => null),
      client.listIndexes({ collection_name: name }).then((res: any) => res?.index_descriptions || res?.index_names || []).catch(() => []),
    ]);
    return {
      exists: true,
      rowCount,
      vectorIndexReady: true,
      scalarIndexReady: true,
      ftsIndexReady: await this.hasSparseField(name).catch(() => false),
      unindexedRowEstimate: 0,
      lastIndexRebuildAt: 0,
      indexes: Array.isArray(indexes) ? indexes.map((idx: any) => ({ name: String(idx.index_name || idx.name || idx), type: idx.index_type })) : [],
      dimension,
    };
  }

  async reset(): Promise<{ deleted: boolean; location: string }> {
    const client = await this.getClient();
    let deleted = false;
    for (const collection of ["embeddings", "embeddings_world_books"] as CollectionName[]) {
      const name = this.collectionName(collection);
      if (await this.hasCollection(name)) {
        await assertOk(client.dropCollection({ collection_name: name }));
        this.loaded.delete(name);
        deleted = true;
      }
    }
    return { deleted, location: this.config?.address || "milvus" };
  }

  async close(): Promise<void> {
    if (this.client?.closeConnection) await this.client.closeConnection().catch(() => {});
    this.client = null;
    this.loaded.clear();
    this.hybridFallbackCollections.clear();
  }

  private collectionName(collection: CollectionName): string {
    return `${COLLECTION_PREFIX}${collection}`;
  }

  private async getClient(): Promise<MilvusClientLike> {
    await this.init();
    return this.client;
  }

  private async hasCollection(name: string): Promise<boolean> {
    const client = await this.getClient();
    const res = await client.hasCollection({ collection_name: name });
    return !!res?.value;
  }

  private async loadCollection(name: string, refresh = false): Promise<void> {
    if (!refresh && this.loaded.has(name)) return;
    const client = await this.getClient();
    await assertOk(client.loadCollection({ collection_name: name, refresh }));
    this.loaded.add(name);
  }

  private async flush(name: string): Promise<void> {
    const client = await this.getClient();
    if (typeof client.flushSync === "function") {
      await client.flushSync({ collection_names: [name] }).catch(() => client.flushSync({ collection_name: name }));
    } else {
      await client.flush({ collection_names: [name] }).catch(() => client.flush({ collection_name: name }));
    }
  }

  private async appSideHybridSearch(opts: HybridSearchOptions): Promise<VectorHit[]> {
    const [vectorHits, lexicalHits] = await Promise.all([
      this.vectorSearch(opts),
      this.lexicalSearch({
        collection: opts.collection,
        queryText: opts.queryText,
        filter: opts.filter,
        limit: opts.limit,
        withVector: opts.withVector,
        signal: opts.signal,
      }),
    ]);
    return fuseHits(vectorHits, lexicalHits);
  }

  private async ensureScalarIndexes(name: string): Promise<void> {
    const client = await this.getClient();
    for (const field of SCALAR_INDEX_FIELDS) {
      await assertOk(client.createIndex({
        collection_name: name,
        field_name: field,
        index_name: `idx_${field}`,
        index_type: "INVERTED",
      })).catch(() => {});
    }
  }

  private async hasSparseField(name: string): Promise<boolean> {
    const client = await this.getClient();
    const desc = await client.describeCollection({ collection_name: name, cache: true });
    return !!desc?.schema?.fields?.some((field: any) => field.name === SPARSE_FIELD);
  }

  private async ensureSparseIndexIfPresent(name: string): Promise<void> {
    if (!this.capabilities.nativeLexical || !(await this.hasSparseField(name).catch(() => false))) return;
    const client = await this.getClient();
    await assertOk(client.createIndex({
      collection_name: name,
      field_name: SPARSE_FIELD,
      index_name: `idx_${SPARSE_FIELD}`,
      index_type: "SPARSE_INVERTED_INDEX",
      metric_type: "BM25",
    })).catch(() => {});
  }
}

function translateFilter(filter: VectorFilter): string {
  switch (filter.op) {
    case "eq":
      return `${filter.field} == ${literal(filter.value)}`;
    case "in":
      return filter.values.length === 0 ? "id in []" : `${filter.field} in [${filter.values.map(literal).join(", ")}]`;
    case "nin":
      return filter.values.length === 0 ? "id != \"__never__\"" : `${filter.field} not in [${filter.values.map(literal).join(", ")}]`;
    case "and":
      return filter.clauses.length === 0 ? "id != \"__never__\"" : filter.clauses.map((clause) => `(${translateFilter(clause)})`).join(" and ");
  }
}

function literal(value: string | number): string {
  if (typeof value === "number") return String(value);
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function rowToMilvusData(row: VectorRow): Record<string, unknown> {
  return {
    id: row.id,
    user_id: row.user_id,
    source_type: row.source_type,
    source_id: row.source_id,
    owner_id: row.owner_id,
    chunk_index: row.chunk_index,
    content: clipVarchar(row.content),
    metadata_json: clipVarchar(row.metadata_json),
    updated_at: row.updated_at,
    vector: row.vector,
  };
}

function milvusRowToVectorRow(row: any): VectorRow | null {
  const vector = parseVector(row?.vector);
  if (!row?.id || vector.length === 0) return null;
  return {
    id: String(row.id),
    user_id: String(row.user_id || ""),
    source_type: String(row.source_type || ""),
    source_id: String(row.source_id || ""),
    owner_id: String(row.owner_id || ""),
    chunk_index: Number(row.chunk_index ?? 0),
    content: String(row.content || ""),
    vector,
    metadata_json: typeof row.metadata_json === "string" ? row.metadata_json : JSON.stringify(row.metadata_json ?? {}),
    updated_at: Number(row.updated_at ?? 0),
  };
}

function milvusSearchRowToHit(row: any, withVector: boolean, lexicalOnly = false): VectorHit | null {
  if (!row?.source_id) return null;
  return {
    id: String(row.id || ""),
    source_id: String(row.source_id),
    content: String(row.content || ""),
    metadata_json: typeof row.metadata_json === "string" ? row.metadata_json : JSON.stringify(row.metadata_json ?? {}),
    similarity: lexicalOnly ? null : (typeof row.score === "number" ? row.score : null),
    lexicalScore: lexicalOnly && typeof row.score === "number" ? row.score : null,
    vector: withVector ? parseVector(row.vector) : null,
  };
}

function fuseHits(vectorHits: VectorHit[], lexicalHits: VectorHit[]): VectorHit[] {
  if (vectorHits.length === 0 && lexicalHits.length === 0) return [];
  if (lexicalHits.length === 0) return vectorHits;
  if (vectorHits.length === 0) return lexicalHits;
  const scores = new Map<string, number>();
  const byId = new Map<string, VectorHit>();
  const k = 60;
  for (let i = 0; i < vectorHits.length; i++) {
    const hit = vectorHits[i];
    scores.set(hit.source_id, (scores.get(hit.source_id) ?? 0) + 1 / (k + i + 1));
    byId.set(hit.source_id, hit);
  }
  for (let i = 0; i < lexicalHits.length; i++) {
    const hit = lexicalHits[i];
    scores.set(hit.source_id, (scores.get(hit.source_id) ?? 0) + 1 / (k + i + 1));
    if (!byId.has(hit.source_id)) byId.set(hit.source_id, hit);
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => byId.get(id))
    .filter((hit): hit is VectorHit => !!hit);
}

function parseVector(raw: unknown): number[] {
  if (raw instanceof Float32Array || raw instanceof Float64Array) return Array.from(raw);
  if (Array.isArray(raw)) return raw.map(Number).filter(Number.isFinite);
  return [];
}

function clipVarchar(value: string): string {
  if (value.length <= VARCHAR_MAX) return value;
  return `${value.slice(0, VARCHAR_MAX - 22)}\n[content clipped]`;
}

function milvusTuning(profile: VectorStoreTuningProfile): {
  vectorIndexType: string;
  vectorIndexParams?: Record<string, number | string>;
  searchParams?: Record<string, number | string>;
} {
  switch (profile) {
    case "low_latency":
      return {
        vectorIndexType: "HNSW",
        vectorIndexParams: { M: 32, efConstruction: 200 },
        searchParams: { ef: 128 },
      };
    case "low_memory":
      return {
        vectorIndexType: "IVF_FLAT",
        vectorIndexParams: { nlist: 1024 },
        searchParams: { nprobe: 16 },
      };
    case "bulk_reindex":
      return {
        vectorIndexType: "AUTOINDEX",
        searchParams: {},
      };
    case "balanced":
    default:
      return {
        vectorIndexType: "AUTOINDEX",
        searchParams: {},
      };
  }
}

function milvusHybridCandidateLimit(
  requestedLimit: number,
  hybridSearchConfig: MilvusHybridSearchConfig | undefined,
): number {
  const candidateMultiplier = Math.max(
    1,
    Math.floor(hybridSearchConfig?.candidateMultiplier ?? DEFAULT_HYBRID_CANDIDATE_MULTIPLIER),
  );
  const candidateCap = Math.max(
    1,
    Math.floor(hybridSearchConfig?.candidateCap ?? DEFAULT_HYBRID_CANDIDATE_CAP),
  );
  return Math.max(requestedLimit, Math.min(requestedLimit * candidateMultiplier, candidateCap));
}

function milvusConnectTimeoutMs(config: MilvusConnectionConfig): number {
  const candidate = Number(config.connectTimeoutMs);
  return Number.isFinite(candidate) && candidate > 0 ? candidate : DEFAULT_TCP_CONNECT_TIMEOUT_MS;
}

function milvusRequestTimeoutMs(config: MilvusConnectionConfig): number {
  const candidate = Number(config.requestTimeoutMs);
  return Number.isFinite(candidate) && candidate >= 0 ? candidate : DEFAULT_RPC_TIMEOUT_MS;
}

async function assertTcpReachable(address: string, ssl: boolean, timeoutMs: number): Promise<void> {
  const target = parseMilvusAddress(address, ssl);
  await new Promise<void>((resolve, reject) => {
    const socket = connectTcp({ host: target.host, port: target.port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out opening TCP connection to ${target.host}:${target.port} from the Lumiverse backend after ${timeoutMs}ms.`));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.end();
      resolve();
    });
    socket.once("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Cannot open TCP connection to ${target.host}:${target.port} from the Lumiverse backend: ${describeMilvusError(err)}`));
    });
  });
}

function parseMilvusAddress(address: string, ssl: boolean): { host: string; port: number } {
  const trimmed = address.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `${ssl ? "https" : "http"}://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return {
      host: url.hostname,
      port: Number(url.port || 19530),
    };
  } catch {
    const idx = trimmed.lastIndexOf(":");
    const host = idx > 0 ? trimmed.slice(0, idx) : trimmed;
    const port = idx > 0 ? Number(trimmed.slice(idx + 1)) : 19530;
    return { host, port: Number.isFinite(port) && port > 0 ? port : 19530 };
  }
}

function describeMilvusError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const candidate = err as { message?: unknown; details?: unknown; code?: unknown };
    const parts = [candidate.message, candidate.details, candidate.code]
      .filter((value) => value !== undefined && value !== null)
      .map(String);
    if (parts.length > 0) return parts.join(" | ");
  }
  return String(err || "unknown error");
}

async function assertOk(promise: Promise<any>): Promise<any> {
  const res = await promise.catch((err) => {
    throw new Error(`Milvus request failed: ${describeMilvusError(err)}`);
  });
  const status = res?.status ?? res;
  const code = status?.error_code ?? status?.code;
  const reason = status?.reason ?? status?.message;
  if (typeof code !== "undefined" && code !== 0 && code !== "Success" && code !== "success") {
    throw new Error(`Milvus request failed: ${reason || code}`);
  }
  return res;
}

function emptyHealth(): TableHealth {
  return {
    exists: false,
    rowCount: 0,
    vectorIndexReady: false,
    scalarIndexReady: false,
    ftsIndexReady: false,
    unindexedRowEstimate: 0,
    lastIndexRebuildAt: 0,
    indexes: [],
    dimension: null,
  };
}
