import { createHash } from "node:crypto";
import type { QdrantConnectionConfig, VectorStoreTuningProfile } from "../../vector-store-config.service";
import { QDRANT_CAPABILITIES } from "../capabilities";
import type {
  CollectionName,
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

const DEFAULT_PREFIX = "lumiverse_";
const UUID_NAMESPACE = "6f216f13-4f8f-4b45-9d2b-8e826a57e8e2";
const PAYLOAD_FIELDS = ["id", "user_id", "source_type", "source_id", "owner_id", "chunk_index", "content", "metadata_json", "updated_at"];
const PAYLOAD_INDEXES: Array<{ field: string; schema: "keyword" | "integer" }> = [
  { field: "id", schema: "keyword" },
  { field: "user_id", schema: "keyword" },
  { field: "source_type", schema: "keyword" },
  { field: "source_id", schema: "keyword" },
  { field: "owner_id", schema: "keyword" },
  { field: "chunk_index", schema: "integer" },
];

type QdrantPayload = Record<string, unknown>;

export class QdrantStore implements VectorStore {
  readonly id: VectorStoreProviderId = "qdrant";
  readonly capabilities: ProviderCapabilities = QDRANT_CAPABILITIES;

  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly prefix: string;
  private readonly tuningProfile: VectorStoreTuningProfile;
  private initialized = false;

  constructor(config: QdrantConnectionConfig | undefined, apiKey: string | null, tuningProfile?: VectorStoreTuningProfile) {
    if (!config?.url) {
      throw new Error("Qdrant vector store requires qdrant.url (or LUMIVERSE_QDRANT_URL)." );
    }
    this.baseUrl = config.url.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.prefix = sanitizeCollectionPrefix(config.collectionPrefix || DEFAULT_PREFIX);
    this.tuningProfile = tuningProfile || "balanced";
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.request("/collections", { method: "GET" });
    this.initialized = true;
  }

  async ensureCollection(collection: CollectionName, dimension: number): Promise<void> {
    const existing = await this.getStoredDimension(collection);
    if (existing != null) {
      if (existing !== dimension) {
        throw new Error(`Qdrant collection ${this.collectionName(collection)} has dimension ${existing}, expected ${dimension}. Reindex with a matching embedding model or reset the vector store.`);
      }
      await this.ensurePayloadIndexes(collection);
      await this.applyCollectionTuning(collection).catch(() => {});
      return;
    }

    const tuning = qdrantTuning(this.tuningProfile);
    await this.request(`/collections/${encodeURIComponent(this.collectionName(collection))}`, {
      method: "PUT",
      body: {
        vectors: { size: dimension, distance: "Cosine" },
        on_disk_payload: true,
        hnsw_config: tuning.hnswConfig,
        optimizers_config: tuning.optimizersConfig,
        quantization_config: tuning.quantizationConfig,
      },
    });

    await this.ensurePayloadIndexes(collection);
  }

  async getStoredDimension(collection: CollectionName): Promise<number | null> {
    const res = await this.request(`/collections/${encodeURIComponent(this.collectionName(collection))}`, { method: "GET", allow404: true });
    if (!res) return null;
    const vectors = res?.result?.config?.params?.vectors;
    if (typeof vectors?.size === "number") return vectors.size;
    if (vectors && typeof vectors === "object") {
      for (const value of Object.values(vectors as Record<string, any>)) {
        if (typeof value?.size === "number") return value.size;
      }
    }
    return null;
  }

  async upsert(collection: CollectionName, rows: VectorRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.ensureCollection(collection, rows[0].vector.length);
    for (let i = 0; i < rows.length; i += 128) {
      const batch = rows.slice(i, i + 128);
      await this.request(`/collections/${encodeURIComponent(this.collectionName(collection))}/points?wait=${this.tuningProfile === "bulk_reindex" ? "false" : "true"}`, {
        method: "PUT",
        body: {
          points: batch.map((row) => ({
            id: qdrantPointId(row.id),
            vector: row.vector,
            payload: rowToPayload(row),
          })),
        },
      });
    }
  }

  async getRowsByFilter(collection: CollectionName, filter: VectorFilter, limit = 10_000): Promise<VectorRow[]> {
    const out: VectorRow[] = [];
    let offset: unknown = undefined;
    while (out.length < limit) {
      const res = await this.request(`/collections/${encodeURIComponent(this.collectionName(collection))}/points/scroll`, {
        method: "POST",
        allow404: true,
        body: {
          filter: translateFilter(filter),
          limit: Math.min(256, limit - out.length),
          offset,
          with_payload: true,
          with_vector: true,
        },
      });
      if (!res) return out;
      const points = Array.isArray(res?.result?.points) ? res.result.points : [];
      for (const point of points) {
        const row = pointToVectorRow(point);
        if (row) out.push(row);
      }
      offset = res?.result?.next_page_offset;
      if (!offset || points.length === 0) break;
    }
    return out;
  }

  async deleteByFilter(collection: CollectionName, filter: VectorFilter): Promise<void> {
    await this.request(`/collections/${encodeURIComponent(this.collectionName(collection))}/points/delete?wait=true`, {
      method: "POST",
      allow404: true,
      body: { filter: translateFilter(filter) },
    });
  }

  async deleteByIds(collection: CollectionName, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.request(`/collections/${encodeURIComponent(this.collectionName(collection))}/points/delete?wait=true`, {
      method: "POST",
      allow404: true,
      body: { points: ids.map(qdrantPointId) },
    });
  }

  async vectorSearch(opts: SearchOptions): Promise<VectorHit[]> {
    if (opts.signal?.aborted) return [];
    const res = await this.request(`/collections/${encodeURIComponent(this.collectionName(opts.collection))}/points/search`, {
      method: "POST",
      allow404: true,
      signal: opts.signal,
      body: {
        vector: opts.vector,
        filter: translateFilter(opts.filter),
        limit: opts.limit,
        params: qdrantTuning(this.tuningProfile).searchParams,
        with_payload: true,
        with_vector: opts.withVector,
      },
    });
    if (!res || opts.signal?.aborted) return [];
    const hits = Array.isArray(res?.result) ? res.result : [];
    return hits.map((hit: any) => pointToHit(hit, opts.withVector)).filter((hit: VectorHit | null): hit is VectorHit => hit != null);
  }

  async lexicalSearch(_opts: LexicalSearchOptions): Promise<VectorHit[]> {
    return [];
  }

  async countRows(collection: CollectionName, filter?: VectorFilter): Promise<number> {
    const res = await this.request(`/collections/${encodeURIComponent(this.collectionName(collection))}/points/count`, {
      method: "POST",
      allow404: true,
      body: { exact: true, filter: filter ? translateFilter(filter) : undefined },
    });
    return Number(res?.result?.count ?? 0);
  }

  async optimize(_collections?: CollectionName[]): Promise<void> {
    // Qdrant handles segment optimization server-side.
  }

  async health(collection: CollectionName): Promise<TableHealth> {
    const name = this.collectionName(collection);
    const res = await this.request(`/collections/${encodeURIComponent(name)}`, { method: "GET", allow404: true });
    if (!res) return emptyHealth();
    const rowCount = await this.countRows(collection).catch(() => 0);
    return {
      exists: true,
      rowCount,
      vectorIndexReady: res?.result?.status === "green" || res?.result?.optimizer_status === "ok",
      scalarIndexReady: true,
      ftsIndexReady: false,
      unindexedRowEstimate: 0,
      lastIndexRebuildAt: 0,
      indexes: [],
      dimension: await this.getStoredDimension(collection),
    };
  }

  async reset(): Promise<{ deleted: boolean; location: string }> {
    let deleted = false;
    for (const collection of ["embeddings", "embeddings_world_books"] as CollectionName[]) {
      const name = this.collectionName(collection);
      const res = await this.request(`/collections/${encodeURIComponent(name)}`, { method: "DELETE", allow404: true });
      if (res) deleted = true;
    }
    return { deleted, location: this.baseUrl };
  }

  async close(): Promise<void> {
    this.initialized = false;
  }

  private collectionName(collection: CollectionName): string {
    return `${this.prefix}${collection}`;
  }

  private async ensurePayloadIndexes(collection: CollectionName): Promise<void> {
    const name = this.collectionName(collection);
    for (const { field, schema } of PAYLOAD_INDEXES) {
      await this.request(`/collections/${encodeURIComponent(name)}/index`, {
        method: "PUT",
        body: { field_name: field, field_schema: schema },
      }).catch(() => {});
    }
  }

  private async applyCollectionTuning(collection: CollectionName): Promise<void> {
    const tuning = qdrantTuning(this.tuningProfile);
    await this.request(`/collections/${encodeURIComponent(this.collectionName(collection))}`, {
      method: "PATCH",
      body: {
        optimizers_config: tuning.optimizersConfig,
        hnsw_config: tuning.hnswConfig,
        quantization_config: tuning.quantizationConfig,
      },
    });
  }

  private async request(path: string, opts: { method: string; body?: unknown; allow404?: boolean; signal?: AbortSignal }): Promise<any | null> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["api-key"] = this.apiKey;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: opts.method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
    if (res.status === 404 && opts.allow404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Qdrant request failed (${res.status} ${res.statusText}) ${path}: ${text.slice(0, 500)}`);
    }
    if (res.status === 204) return {};
    return res.json().catch(() => ({}));
  }
}

function translateFilter(filter: VectorFilter): any {
  switch (filter.op) {
    case "eq":
      return { must: [{ key: filter.field, match: { value: filter.value } }] };
    case "in":
      return filter.values.length === 0
        ? { must: [{ is_empty: { key: "id" } }] }
        : { must: [{ key: filter.field, match: { any: filter.values } }] };
    case "nin":
      return filter.values.length === 0
        ? {}
        : { must_not: [{ key: filter.field, match: { any: filter.values } }] };
    case "and": {
      const must: any[] = [];
      const mustNot: any[] = [];
      for (const clause of filter.clauses) {
        const translated = translateFilter(clause);
        if (Array.isArray(translated.must)) must.push(...translated.must);
        if (Array.isArray(translated.must_not)) mustNot.push(...translated.must_not);
      }
      return { ...(must.length ? { must } : {}), ...(mustNot.length ? { must_not: mustNot } : {}) };
    }
  }
}

function qdrantPointId(id: string): string {
  const namespace = Buffer.from(UUID_NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(namespace).update(id).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function rowToPayload(row: VectorRow): QdrantPayload {
  return {
    id: row.id,
    user_id: row.user_id,
    source_type: row.source_type,
    source_id: row.source_id,
    owner_id: row.owner_id,
    chunk_index: row.chunk_index,
    content: row.content,
    metadata_json: row.metadata_json,
    updated_at: row.updated_at,
  };
}

function pointToVectorRow(point: any): VectorRow | null {
  const payload = point?.payload || {};
  const vector = Array.isArray(point?.vector) ? point.vector.map(Number).filter(Number.isFinite) : [];
  if (!payload.id || vector.length === 0) return null;
  return {
    id: String(payload.id),
    user_id: String(payload.user_id || ""),
    source_type: String(payload.source_type || ""),
    source_id: String(payload.source_id || ""),
    owner_id: String(payload.owner_id || ""),
    chunk_index: Number(payload.chunk_index ?? 0),
    content: String(payload.content || ""),
    vector,
    metadata_json: typeof payload.metadata_json === "string" ? payload.metadata_json : JSON.stringify(payload.metadata_json ?? {}),
    updated_at: Number(payload.updated_at ?? 0),
  };
}

function pointToHit(point: any, withVector: boolean): VectorHit | null {
  const payload = point?.payload || {};
  if (!payload.source_id) return null;
  return {
    id: String(payload.id || ""),
    source_id: String(payload.source_id),
    content: String(payload.content || ""),
    metadata_json: typeof payload.metadata_json === "string" ? payload.metadata_json : JSON.stringify(payload.metadata_json ?? {}),
    similarity: typeof point.score === "number" ? point.score : null,
    lexicalScore: null,
    vector: withVector && Array.isArray(point.vector) ? point.vector.map(Number).filter(Number.isFinite) : null,
  };
}

function sanitizeCollectionPrefix(prefix: string): string {
  const sanitized = prefix.replace(/[^A-Za-z0-9_-]/g, "_");
  return sanitized || DEFAULT_PREFIX;
}

function qdrantTuning(profile: VectorStoreTuningProfile): {
  hnswConfig: Record<string, unknown>;
  optimizersConfig: Record<string, unknown>;
  quantizationConfig?: Record<string, unknown>;
  searchParams?: Record<string, unknown>;
} {
  switch (profile) {
    case "low_latency":
      return {
        hnswConfig: { m: 32, ef_construct: 200, full_scan_threshold: 10_000, on_disk: false },
        optimizersConfig: { default_segment_number: 4, indexing_threshold: 10_000 },
        searchParams: { hnsw_ef: 128 },
      };
    case "low_memory":
      return {
        hnswConfig: { m: 16, ef_construct: 100, full_scan_threshold: 20_000, on_disk: true },
        optimizersConfig: { default_segment_number: 2, memmap_threshold: 20_000, indexing_threshold: 20_000 },
        quantizationConfig: { scalar: { type: "int8", quantile: 0.99, always_ram: false } },
        searchParams: { hnsw_ef: 64 },
      };
    case "bulk_reindex":
      return {
        hnswConfig: { m: 16, ef_construct: 100, full_scan_threshold: 20_000, on_disk: false },
        optimizersConfig: { default_segment_number: 2, indexing_threshold: 50_000 },
        searchParams: { hnsw_ef: 64 },
      };
    case "balanced":
    default:
      return {
        hnswConfig: { m: 16, ef_construct: 100, full_scan_threshold: 10_000, on_disk: false },
        optimizersConfig: { default_segment_number: 2, indexing_threshold: 20_000 },
        searchParams: { hnsw_ef: 64 },
      };
  }
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
