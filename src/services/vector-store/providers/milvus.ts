import { connect as connectTcp } from "node:net";
import { randomUUID } from "node:crypto";
import type { DescribeCollectionResponse, IndexDescription } from "@zilliz/milvus2-sdk-node";
import type { MilvusConnectionConfig, MilvusHybridSearchConfig, VectorStoreTuningProfile } from "../../vector-store-config.service";
import {
  adaptiveStorageBatch,
  andFilter,
  cosineSimilarity,
  inSet,
  isRetryableStorageError,
} from "../addressing";
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
const CONTENT_CLIPPED_SUFFIX = "\n[content clipped]";
const DEFAULT_TCP_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_RPC_TIMEOUT_MS = 60_000;
const DEFAULT_HYBRID_CANDIDATE_MULTIPLIER = 3;
const DEFAULT_HYBRID_CANDIDATE_CAP = 200;
const OUTPUT_FIELDS = ["id", "user_id", "source_type", "source_id", "owner_id", "chunk_index", "content", "metadata_json", "updated_at"];
const SCALAR_INDEX_FIELDS = ["user_id", "source_type", "source_id", "owner_id", "chunk_index"];
const SPARSE_FIELD = "sparse";
const DEFAULT_UPSERT_BATCH_SIZE = 128;
const BULK_UPSERT_BATCH_SIZE = 256;
// Numeric Strong is 0, which SDK 3.0.6's search builder treats as unset.
export const MILVUS_READ_CONSISTENCY = "Strong";

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
  private initializing: Promise<void> | null = null;
  private loaded = new Set<string>();
  private hybridFallbackCollections = new Set<string>();
  private prepared = new Map<string, number>();
  private preparing = new Map<string, Promise<void>>();
  private textCollections = new Set<string>();
  private routes = new Map<CollectionName, string>();

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
    this.capabilities = { ...this.capabilities, requiresExplicitFlush: config.flushPolicy !== "manual" };
  }

  async init(): Promise<void> {
    if (this.initializing) return this.initializing;
    if (this.client) return;
    const pending = this.connect();
    this.initializing = pending;
    try {
      await pending;
    } catch (err) {
      await this.close();
      throw err;
    } finally {
      this.initializing = null;
    }
  }

  private async connect(): Promise<void> {
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
      // SDK 3.0.5+ starts telemetry heartbeats by default. Keep this opt-in.
      telemetry: { enabled: false },
    });
    try {
      await this.client.connectPromise;
    } catch (err) {
      throw new Error(`Milvus gRPC connection failed for ${cfg.address}: ${describeMilvusError(err)}`);
    }

    const version = await this.client.getVersion().then((res: any) => res?.version || res?.data || null).catch(() => null);
    this.capabilities = { ...milvusCapabilities(version), requiresExplicitFlush: cfg.flushPolicy !== "manual" };
    const health = await this.client.checkHealth().catch((err: any) => {
      throw new Error(`Milvus health check failed for ${cfg.address}: ${describeMilvusError(err)}`);
    });
    if (health?.isHealthy === false) throw new Error("Milvus health check reported unhealthy.");
    // Maintenance switches these aliases while writers are stopped. Resolve
    // physical names once per connection; restart after cutover/rollback.
    for (const collection of ["embeddings", "embeddings_world_books"] as const) {
      this.routes.set(collection, await resolveMilvusCollection(this.client, collection));
    }
  }

  async ensureCollection(collection: CollectionName, dimension: number): Promise<void> {
    await this.getClient();
    const name = this.collectionName(collection);
    const preparedDimension = this.prepared.get(name);
    if (preparedDimension !== undefined) {
      if (preparedDimension === dimension) return;
      if (!this.textCollections.has(name)) this.assertDimension(name, preparedDimension, dimension);
      this.prepared.delete(name);
    }
    const pending = this.preparing.get(name);
    if (pending) {
      await pending;
      return this.ensureCollection(collection, dimension);
    }
    const setup = this.prepareCollection(collection, dimension);
    this.preparing.set(name, setup);
    try {
      await setup;
    } finally {
      if (this.preparing.get(name) === setup) this.preparing.delete(name);
    }
  }

  private assertDimension(name: string, existing: number, expected: number): void {
    if (existing !== expected) {
      throw new Error(`Milvus collection ${name} has dimension ${existing}, expected ${expected}. Reindex with a matching embedding model or reset the vector store.`);
    }
  }

  private async prepareCollection(collection: CollectionName, dimension: number): Promise<void> {
    const client = await this.getClient();
    const name = this.collectionName(collection);
    const has = await this.hasCollection(name);
    if (has) {
      const description = await assertOk(client.describeCollection({ collection_name: name, cache: false }));
      const existing = storedDimension(description);
      if (existing == null) throw new Error(`Milvus collection ${name} has no valid vector dimension.`);
      const content = description.schema?.fields?.find((field: any) => field.name === "content");
      if (content && ["Text", "25"].includes(String(content.data_type))) this.textCollections.add(name);
      else this.textCollections.delete(name);
      if (existing !== dimension && this.textCollections.has(name) && await countMilvusRows(client, name) === 0) {
        await this.replaceEmptyTextCollection(collection, dimension);
        return;
      }
      this.assertDimension(name, existing, dimension);
      const scalarsReady = await this.ensureScalarIndexes(name);
      const sparseReady = await this.ensureSparseIndexIfPresent(name);
      await this.loadCollection(name);
      if (scalarsReady && sparseReady) this.prepared.set(name, dimension);
      return;
    }

    const { DataType, FunctionType, MetricType } = this.sdk!;
    const textContent = this.textCollections.has(name);
    const tuning = milvusTuning(this.tuningProfile);
    const fields: any[] = [
      { name: "id", data_type: DataType.VarChar, is_primary_key: true, autoID: false, max_length: 512 },
      { name: "user_id", data_type: DataType.VarChar, max_length: 128 },
      { name: "source_type", data_type: DataType.VarChar, max_length: 64 },
      { name: "source_id", data_type: DataType.VarChar, max_length: 256 },
      { name: "owner_id", data_type: DataType.VarChar, max_length: 256 },
      { name: "chunk_index", data_type: DataType.Int64 },
      { name: "content", data_type: textContent ? DataType.Text : DataType.VarChar, ...(textContent ? {} : { max_length: VARCHAR_MAX }) },
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
        index_name: `idx_${SPARSE_FIELD}`,
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
      if (!this.capabilities.nativeLexical || textContent) throw err;
      console.warn(`[vector-store] Milvus BM25 collection creation failed for ${name}; falling back to dense-only schema:`, describeMilvusError(err));
      this.capabilities = { ...this.capabilities, nativeLexical: false };
      await assertOk(client.createCollection({
        ...createRequest,
        fields: fields.filter((field) => field.name !== SPARSE_FIELD).map((field) => field.name === "content" ? { ...field, enable_analyzer: undefined } : field),
        index_params: indexParams.filter((index) => index.field_name !== SPARSE_FIELD),
        functions: undefined,
      }));
    }
    const scalarsReady = await this.ensureScalarIndexes(name);
    await this.loadCollection(name);
    if (scalarsReady) this.prepared.set(name, dimension);
  }

  private async replaceEmptyTextCollection(collection: CollectionName, dimension: number): Promise<void> {
    // Reset keeps the empty Text schema/alias durable. A different embedding
    // dimension then gets a new collection before atomically changing routing.
    const client = await this.getClient();
    const name = `lumiverse_reset_${randomUUID().replaceAll("-", "")}_${collection}`;
    this.routes.set(collection, name);
    this.textCollections.add(name);
    try {
      await this.prepareCollection(collection, dimension);
      const alias = milvusActiveAlias(collection);
      const exists = await this.hasCollection(alias);
      await assertOk(client[exists ? "alterAlias" : "createAlias"]({ collection_name: name, alias }));
    } catch (error) {
      // The alias RPC may have succeeded before a transport failure. Reconnect
      // on the next operation instead of guessing which target is now active.
      await this.close();
      throw error;
    }
  }

  async getStoredDimension(collection: CollectionName): Promise<number | null> {
    const client = await this.getClient();
    const name = this.collectionName(collection);
    if (!(await this.hasCollection(name))) return null;
    const desc = await assertOk(client.describeCollection({ collection_name: name, cache: false }));
    return storedDimension(desc);
  }

  async upsert(collection: CollectionName, rows: VectorRow[]): Promise<void> {
    if (rows.length === 0) return;
    // Validate the entire operation before writing any batch. JSON must never
    // be truncated into an invalid document to fit the legacy VARCHAR schema.
    for (const row of rows) assertMetadataFits(row.metadata_json);
    const dimension = rows[0].vector.length;
    if (dimension === 0 || rows.some((row) => row.vector.length !== dimension || row.vector.some((value) => !Number.isFinite(value)))) {
      throw new Error("Milvus upsert requires finite vectors with one nonzero dimension for the entire batch.");
    }
    const client = await this.getClient();
    await this.ensureCollection(collection, rows[0].vector.length);
    const name = this.collectionName(collection);
    const initialBatchSize = this.tuningProfile === "bulk_reindex" ? BULK_UPSERT_BATCH_SIZE : DEFAULT_UPSERT_BATCH_SIZE;
    await adaptiveStorageBatch(
      rows,
      initialBatchSize,
      async (batch) => {
        await assertOk(client.upsert({ collection_name: name, data: batch.map((row) => rowToMilvusData(row, this.textCollections.has(name))) }));
      },
      {
        label: `Milvus upsert ${name}`,
        isRetryable: isRetryableStorageError,
      },
    );
    if (this.tuningProfile !== "bulk_reindex" && this.config?.flushPolicy !== "manual") {
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
    for await (const batch of scanMilvusRows(client, name, { filter: translateFilter(filter), limit })) {
      rows.push(...batch);
    }
    return rows.map(milvusRowToVectorRow).filter((row): row is VectorRow => row != null);
  }

  async deleteByFilter(collection: CollectionName, filter: VectorFilter): Promise<void> {
    const client = await this.getClient();
    const name = this.collectionName(collection);
    if (!(await this.hasCollection(name))) return;
    await assertOk(client.delete({ collection_name: name, filter: translateFilter(filter) }));
    if (this.config?.flushPolicy !== "manual") await this.flush(name);
  }

  async deleteByIds(collection: CollectionName, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const client = await this.getClient();
    const name = this.collectionName(collection);
    if (!(await this.hasCollection(name))) return;
    for (let i = 0; i < ids.length; i += 512) {
      await assertOk(client.delete({ collection_name: name, ids: ids.slice(i, i + 512) }));
    }
    if (this.config?.flushPolicy !== "manual") await this.flush(name);
  }

  async vectorSearch(opts: SearchOptions): Promise<VectorHit[]> {
    if (opts.signal?.aborted) return [];
    const client = await this.getClient();
    const name = this.collectionName(opts.collection);
    if (!(await this.hasCollection(name))) return [];
    await this.loadCollection(name);
    const res = await client.search({
      collection_name: name,
      consistency_level: MILVUS_READ_CONSISTENCY,
      data: opts.vector,
      anns_field: "vector",
      filter: translateFilter(opts.filter),
      limit: opts.limit,
      metric_type: "COSINE",
      params: milvusTuning(this.tuningProfile).searchParams,
      output_fields: opts.withVector ? [...OUTPUT_FIELDS, "vector"] : OUTPUT_FIELDS,
    }).then(assertMilvusResponse);
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
        consistency_level: MILVUS_READ_CONSISTENCY,
        data: opts.queryText.trim(),
        anns_field: SPARSE_FIELD,
        filter: translateFilter(opts.filter),
        limit: opts.limit,
        metric_type: "BM25",
        params: {},
        output_fields: opts.withVector ? [...OUTPUT_FIELDS, "vector"] : OUTPUT_FIELDS,
      }).then(assertMilvusResponse);
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
        consistency_level: MILVUS_READ_CONSISTENCY,
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
        // Milvus returns the fused RRF score as `score`. Pull dense vectors
        // back so the provider contract can still expose real cosine
        // similarity instead of mislabeling that rank-derived score.
        output_fields: [...OUTPUT_FIELDS, "vector"],
      }).then(assertMilvusResponse);
      if (opts.signal?.aborted) return [];
      const results = Array.isArray(res?.results) ? res.results : [];
      let hits: VectorHit[] = results
        .map((row: any) => milvusSearchRowToHit(row, true))
        .filter((hit: VectorHit | null): hit is VectorHit => hit != null)
        .map((hit: VectorHit): VectorHit => {
          const vector = hit.vector;
          const hasValidVector = !!vector && vector.length === opts.vector.length;
          return {
            ...hit,
            similarity: hasValidVector ? cosineSimilarity(opts.vector, vector) : null,
            lexicalScore: null,
            vector: opts.withVector ? vector : null,
          };
        });

      const unresolvedIds = hits
        .filter((hit: VectorHit) => hit.similarity == null && hit.id)
        .map((hit: VectorHit) => hit.id);
      if (unresolvedIds.length > 0 && !opts.signal?.aborted) {
        try {
          const rescored = await this.vectorSearch({
            ...opts,
            filter: andFilter([opts.filter, inSet("id", unresolvedIds)]),
            limit: unresolvedIds.length,
          });
          const rescoredById = new Map(rescored.map((hit: VectorHit) => [hit.id, hit]));
          hits = hits.map((hit: VectorHit): VectorHit => {
            const denseHit = rescoredById.get(hit.id);
            if (!denseHit) return hit;
            return {
              ...hit,
              similarity: denseHit.similarity,
              vector: opts.withVector ? denseHit.vector : null,
            };
          });
        } catch (err) {
          if (opts.signal?.aborted) return [];
          console.warn(
            "[vector-store] Milvus could not dense-rescore %d native hybrid hit(s); leaving their cosine similarity unknown: %s",
            unresolvedIds.length,
            describeMilvusError(err),
          );
        }
      }
      if (opts.signal?.aborted) return [];
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
    await this.loadCollection(name);
    return countMilvusRows(client, name, filter ? translateFilter(filter) : "");
  }

  async optimize(_collections?: CollectionName[]): Promise<void> {
    await this.getClient();
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
    const [rowCount, description, indexResponse, statistics] = await Promise.all([
      this.countRows(collection).catch(() => 0),
      assertOk(client.describeCollection({ collection_name: name, cache: false })).catch(() => null),
      assertOk(client.describeIndex({ collection_name: name })).catch(() => null),
      assertOk(client.getCollectionStatistics({ collection_name: name })).catch(() => null),
    ]);
    const indexes: IndexDescription[] = Array.isArray(indexResponse?.index_descriptions) ? indexResponse.index_descriptions : [];
    const readyForField = (field: string) => indexes.some((index) => index.field_name === field && indexReady(index));
    const hasSparse = description?.schema?.fields?.some((field: { name: string }) => field.name === SPARSE_FIELD) === true;
    const functions = description?.schema?.functions ?? description?.functions ?? [];
    const hasBm25 = functions.some((fn: { type: unknown; input_field_names?: string[]; output_field_names?: string[] }) =>
      (fn.type === "BM25" || fn.type === 1)
      && fn.input_field_names?.includes("content")
      && fn.output_field_names?.includes(SPARSE_FIELD));
    const vectorIndexReady = readyForField("vector");
    const ftsIndexReady = this.capabilities.nativeLexical && hasSparse && hasBm25
      && readyForField(SPARSE_FIELD) && reportedBackfillComplete(statistics?.data);
    const searchIndexes = indexes.filter((index) => index.field_name === "vector" || index.field_name === SPARSE_FIELD);
    return {
      exists: true,
      rowCount,
      vectorIndexReady,
      scalarIndexReady: SCALAR_INDEX_FIELDS.every(readyForField),
      ftsIndexReady,
      unindexedRowEstimate: Math.max(
        !vectorIndexReady || (hasSparse && !ftsIndexReady) ? rowCount : 0,
        ...searchIndexes.map(indexPendingRows),
      ),
      lastIndexRebuildAt: 0,
      indexes: indexes.map((index) => {
        const type = index.params?.find((param) => param.key === "index_type")?.value;
        return { name: index.index_name, type: type == null ? undefined : String(type) };
      }),
      dimension: storedDimension(description),
    };
  }

  async reset(): Promise<{ deleted: boolean; location: string }> {
    const client = await this.getClient();
    let deleted = false;
    for (const collection of ["embeddings", "embeddings_world_books"] as CollectionName[]) {
      const name = this.collectionName(collection);
      if (await this.hasCollection(name)) {
        const description = await assertOk(client.describeCollection({ collection_name: name, cache: false }));
        const text = description.schema?.fields?.some((field: any) => field.name === "content" && ["Text", "25"].includes(String(field.data_type)));
        if (text) {
          // Keep the active route and schema intact throughout reset, including
          // failures/restarts. Dropping it could reveal the retained old store.
          await assertOk(client.delete({ collection_name: name, filter: 'id >= ""' }));
          await this.flush(name);
        } else {
          await assertOk(client.dropCollection({ collection_name: name }));
        }
        this.loaded.delete(name);
        this.prepared.delete(name);
        if (text) this.textCollections.add(name);
        else this.textCollections.delete(name);
        this.hybridFallbackCollections.delete(name);
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
    this.prepared.clear();
    this.preparing.clear();
    this.textCollections.clear();
    this.routes.clear();
  }

  private collectionName(collection: CollectionName): string {
    return this.routes.get(collection) ?? `${COLLECTION_PREFIX}${collection}`;
  }

  private async getClient(): Promise<MilvusClientLike> {
    await this.init();
    return this.client;
  }

  private async hasCollection(name: string): Promise<boolean> {
    const client = await this.getClient();
    const res = await assertOk(client.hasCollection({ collection_name: name }));
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
      await assertOk(client.flushSync({ collection_names: [name] }));
    } else {
      await assertOk(client.flush({ collection_names: [name] }));
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

  private async ensureScalarIndexes(name: string): Promise<boolean> {
    const client = await this.getClient();
    let success = true;
    for (const field of SCALAR_INDEX_FIELDS) {
      await assertOk(client.createIndex({
        collection_name: name,
        field_name: field,
        index_name: `idx_${field}`,
        index_type: "INVERTED",
      })).catch(() => { success = false; });
    }
    return success;
  }

  private async hasSparseField(name: string): Promise<boolean> {
    const client = await this.getClient();
    const desc = await assertOk(client.describeCollection({ collection_name: name, cache: true }));
    return !!desc?.schema?.fields?.some((field: any) => field.name === SPARSE_FIELD);
  }

  private async ensureSparseIndexIfPresent(name: string): Promise<boolean> {
    if (!this.capabilities.nativeLexical) return true;
    // A failed schema probe must remain retryable rather than being cached as
    // a collection without a sparse index.
    try { if (!(await this.hasSparseField(name))) return true; } catch { return false; }
    const client = await this.getClient();
    try {
      const existing = await assertOk(client.describeIndex({ collection_name: name }));
      const sparseIndex = existing.index_descriptions?.find((index: any) => index.field_name === SPARSE_FIELD);
      if (sparseIndex) {
        // Earlier schemas used a server-assigned index name. Do not repeatedly
        // try to create a second index on that field under idx_sparse.
        const metric = sparseIndex.params?.find((param: any) => param.key === "metric_type")?.value;
        return metric === "BM25" && !sparseIndex.index_state_fail_reason && !["Failed", "4"].includes(String(sparseIndex.state));
      }
    } catch { return false; }
    return assertOk(client.createIndex({
      collection_name: name,
      field_name: SPARSE_FIELD,
      index_name: `idx_${SPARSE_FIELD}`,
      index_type: "SPARSE_INVERTED_INDEX",
      metric_type: "BM25",
    })).then(() => true, () => false);
  }
}

export function milvusActiveAlias(collection: CollectionName): string {
  return `lumiverse_active_${collection}`;
}

export async function resolveMilvusCollection(client: MilvusClientLike, collection: CollectionName): Promise<string> {
  const alias = milvusActiveAlias(collection);
  const has = await assertOk(client.hasCollection({ collection_name: alias }));
  if (!has.value) return `${COLLECTION_PREFIX}${collection}`;
  const route = await assertOk(client.describeAlias({ collection_name: alias, alias }));
  if (typeof route.collection !== "string" || !/^lumiverse_[a-zA-Z0-9_]+$/.test(route.collection)) {
    throw new Error(`Milvus routing alias ${alias} has an invalid target.`);
  }
  return route.collection;
}

/** Keyset scan: no growing offset or 16,384-row result-window limit. */
export async function* scanMilvusRows(
  client: MilvusClientLike,
  name: string,
  options: { filter?: string; limit?: number; afterId?: string; batchSize?: number } = {},
): AsyncGenerator<VectorRow[]> {
  let afterId = options.afterId;
  let remaining = options.limit ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error("Invalid Milvus scan limit.");
  const batchSize = Math.max(1, Math.min(1024, options.batchSize ?? 512));
  while (remaining > 0) {
    const clauses = [options.filter, afterId === undefined ? undefined : `id > ${literal(afterId)}`].filter(Boolean);
    const res = await assertOk(client.query({
      collection_name: name,
      consistency_level: MILVUS_READ_CONSISTENCY,
      filter: clauses.map((clause) => `(${clause})`).join(" and "),
      output_fields: [...OUTPUT_FIELDS, "vector"],
      limit: Math.min(batchSize, remaining),
      params: { iterator: true },
    }));
    const raw = res?.data;
    if (!Array.isArray(raw)) throw new Error("Milvus scan returned no row data.");
    if (raw.length === 0) return;
    const batch: VectorRow[] = [];
    for (const item of raw) {
      const row = milvusRowToVectorRow(item);
      if (!row || row.vector.some((value) => !Number.isFinite(value))) throw new Error("Milvus scan returned an invalid vector row.");
      if (afterId !== undefined && Buffer.compare(Buffer.from(row.id), Buffer.from(afterId)) <= 0) {
        throw new Error("Milvus scan did not advance in primary-key order.");
      }
      afterId = row.id;
      batch.push(row);
    }
    if (batch.length > remaining) throw new Error("Milvus scan exceeded its requested limit.");
    remaining -= batch.length;
    yield batch;
  }
}

export async function countMilvusRows(client: MilvusClientLike, name: string, filter = ""): Promise<number> {
  // SDK count() drops consistency options. A direct aggregate query preserves them.
  const res = await assertOk(client.query({
    collection_name: name,
    consistency_level: MILVUS_READ_CONSISTENCY,
    filter,
    output_fields: ["count(*)"],
  }));
  const count = nonNegativeCount(res?.data?.[0]?.["count(*)"]);
  if (count == null) throw new Error("Milvus count returned an invalid result.");
  return count;
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

export function literal(value: string | number): string {
  if (typeof value === "number") return String(value);
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function rowToMilvusData(row: VectorRow, text = false): Record<string, unknown> {
  return {
    id: row.id,
    user_id: row.user_id,
    source_type: row.source_type,
    source_id: row.source_id,
    owner_id: row.owner_id,
    chunk_index: row.chunk_index,
    content: text ? row.content : clipVarchar(row.content),
    metadata_json: row.metadata_json,
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
  if (Buffer.byteLength(value, "utf8") <= VARCHAR_MAX) return value;
  const bytes = Buffer.from(value, "utf8");
  let end = VARCHAR_MAX - Buffer.byteLength(CONTENT_CLIPPED_SUFFIX, "utf8");
  // If the cut lands inside a code point, omit that whole code point.
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + CONTENT_CLIPPED_SUFFIX;
}

function assertMetadataFits(value: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > VARCHAR_MAX) {
    throw new Error(`Milvus metadata_json exceeds the ${VARCHAR_MAX}-byte VARCHAR limit (${bytes} UTF-8 bytes). Reduce the metadata before retrying; JSON cannot be safely clipped.`);
  }
}

function storedDimension(description: DescribeCollectionResponse | null): number | null {
  const field = description?.schema?.fields?.find((field) => field.name === "vector");
  const parsed = Number(field?.dim ?? field?.type_params?.find((param) => param.key === "dim")?.value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeCount(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function indexPendingRows(index: IndexDescription): number {
  const total = nonNegativeCount(index.total_rows);
  const indexed = nonNegativeCount(index.indexed_rows);
  return Math.max(
    nonNegativeCount(index.pending_index_rows) ?? 0,
    total != null && indexed != null ? total - indexed : 0,
  );
}

function indexReady(index: IndexDescription): boolean {
  // gRPC normally returns enum names; accept numeric enum representations too.
  return ["Finished", "3"].includes(String(index.state))
    && !index.index_state_fail_reason
    && indexPendingRows(index) === 0;
}

function reportedBackfillComplete(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false;
  const consistent = data.schema_version_consistent_segments;
  const total = data.schema_version_total_segments;
  // Older servers/original schemas may not report backfill counters. A future
  // migration must positively verify completion before enabling its new field;
  // general index health alone is not a migration completion signal.
  if (consistent === undefined && total === undefined) return true;
  const parsedConsistent = nonNegativeCount(consistent);
  const parsedTotal = nonNegativeCount(total);
  return parsedTotal != null && parsedConsistent != null && parsedConsistent === parsedTotal;
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
  return assertMilvusResponse(res);
}

export function assertMilvusResponse<T>(res: T): T {
  const result = res as any;
  const status = result?.status ?? result?.alter_status ?? result;
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
