import { createHash, randomUUID } from "node:crypto";
import { DataType, FunctionType, MilvusClient } from "@zilliz/milvus2-sdk-node";
import type { MilvusConnectionConfig } from "../../vector-store-config.service";
import type { CollectionName, VectorRow } from "../types";
import { assertMilvusResponse, countMilvusRows, literal, MILVUS_READ_CONSISTENCY, milvusActiveAlias, resolveMilvusCollection, scanMilvusRows } from "./milvus";

type Client = any;
const SCALARS = ["user_id", "source_type", "source_id", "owner_id", "chunk_index"];
const COLLECTIONS = ["embeddings", "embeddings_world_books"] as const;
const CLIPPED = "\n[content clipped]";
const ok = async (request: Promise<any>): Promise<any> => assertMilvusResponse(await request);

export interface MilvusCheckpoint {
  version: 1;
  id: string;
  identity: string;
  kind: "text" | "bm25";
  collection: CollectionName;
  source: string;
  target: string;
  phase: "planned" | "copying" | "validating" | "waiting" | "ready" | "cutover" | "rolled_back";
  sourceFingerprint: string;
  targetFingerprint: string;
  rowCount: number;
  dimension: number;
  repairDigest: string;
  copied: number;
  afterId?: string;
  progress?: Record<string, unknown>;
  error?: string;
}

/** Explicit canonical rebuild output, bound to the exact old vector row. */
export interface MilvusCanonicalRepair { sourceHash: string; row: VectorRow }

export function parseMilvusCheckpoint(value: unknown): MilvusCheckpoint {
  const state = value as MilvusCheckpoint;
  if (!state || typeof state !== "object" || state.version !== 1 || typeof state.id !== "string" || !/^[a-f0-9-]{32,36}$/.test(state.id)
    || typeof state.identity !== "string" || !["text", "bm25"].includes(state.kind) || !COLLECTIONS.includes(state.collection)
    || !["planned", "copying", "validating", "waiting", "ready", "cutover", "rolled_back"].includes(state.phase)
    || typeof state.source !== "string" || !/^lumiverse_[a-zA-Z0-9_]+$/.test(state.source)
    || typeof state.target !== "string" || !/^lumiverse_[a-zA-Z0-9_]+$/.test(state.target)
    || ![state.sourceFingerprint, state.targetFingerprint, state.repairDigest].every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))
    || !Number.isSafeInteger(state.rowCount) || state.rowCount < 0 || !Number.isSafeInteger(state.dimension) || state.dimension <= 0
    || !Number.isSafeInteger(state.copied) || state.copied < 0 || state.copied > state.rowCount
    || (state.afterId !== undefined && typeof state.afterId !== "string")) throw new Error("Invalid Milvus checkpoint file.");
  return state;
}

export function milvusRowHash(row: VectorRow): string {
  return createHash("sha256").update(serializeRow(row)).digest("hex");
}

function serializeRow(row: VectorRow): string {
  // Normalize protobuf float32 values before comparing copies across clients.
  return JSON.stringify([row.id, row.user_id, row.source_type, row.source_id, row.owner_id,
    row.chunk_index, row.content, row.metadata_json, row.updated_at, row.vector.map(Math.fround)]);
}

function repairedRow(row: VectorRow, repairs: ReadonlyMap<string, MilvusCanonicalRepair>): VectorRow {
  const repair = repairs.get(row.id);
  if (repair) {
    if (repair.sourceHash !== milvusRowHash(row)) throw new Error(`Canonical repair is stale for ${row.id}.`);
    const next = repair.row;
    for (const field of ["id", "user_id", "source_type", "source_id", "owner_id", "chunk_index", "updated_at", "metadata_json"] as const) {
      if (next[field] !== row[field]) throw new Error(`Canonical repair changes ${field} for ${row.id}. Reindex that source instead.`);
    }
    if (typeof next.content !== "string" || !Array.isArray(next.vector) || next.vector.length !== row.vector.length
      || next.vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new Error(`Invalid canonical vector for ${row.id}.`);
    row = next;
  }
  if (row.content.endsWith(CLIPPED)) throw new Error(`Clipped content in ${row.id}. Supply canonical rebuilt content/vectors with --canonical-rows; cutover is blocked.`);
  if (Buffer.byteLength(row.metadata_json) > 65_535) throw new Error(`Oversized metadata in ${row.id}; reindex that source.`);
  return row;
}

export function milvusTextSchema(name: string, dimension: number, description: string, indexType = "AUTOINDEX", indexParams: Record<string, unknown> = {}) {
  return {
    collection_name: name,
    description,
    enable_dynamic_field: false,
    consistency_level: "Strong",
    fields: [
      { name: "id", data_type: DataType.VarChar, is_primary_key: true, autoID: false, max_length: 512 },
      ...[["user_id", 128], ["source_type", 64], ["source_id", 256], ["owner_id", 256]].map(([field, max]) => ({ name: field, data_type: DataType.VarChar, max_length: max })),
      { name: "chunk_index", data_type: DataType.Int64 },
      { name: "content", data_type: DataType.Text, enable_analyzer: true },
      { name: "metadata_json", data_type: DataType.VarChar, max_length: 65_535 },
      { name: "updated_at", data_type: DataType.Int64 },
      { name: "vector", data_type: DataType.FloatVector, dim: dimension },
      { name: "sparse", data_type: DataType.SparseFloatVector },
    ],
    functions: [{ name: "content_bm25", type: FunctionType.BM25, input_field_names: ["content"], output_field_names: ["sparse"], params: {} }],
    index_params: [
      { field_name: "vector", index_name: "idx_vector", index_type: indexType, metric_type: "COSINE", params: indexParams },
      { field_name: "sparse", index_name: "idx_sparse", index_type: "SPARSE_INVERTED_INDEX", metric_type: "BM25" },
      ...SCALARS.map((field_name) => ({ field_name, index_name: `idx_${field_name}`, index_type: "INVERTED" })),
    ],
  };
}

export async function connectMilvusMaintenance(config: MilvusConnectionConfig, password: string | null) {
  const client = new MilvusClient({ ...config, password: password || undefined, timeout: config.requestTimeoutMs ?? 60_000, telemetry: { enabled: false }, logLevel: "error" });
  try { await client.connectPromise; return client; } catch (error) { await client.closeConnection(); throw error; }
}

export function milvusConnectionIdentity(config: MilvusConnectionConfig): string {
  return createHash("sha256").update(JSON.stringify([config.address, config.database ?? "default", config.ssl === true, config.username ?? ""])).digest("hex");
}

export class MilvusMaintenance {
  constructor(
    readonly client: Client,
    readonly identity: string,
    private readonly save: (checkpoint: MilvusCheckpoint) => Promise<void>,
    private readonly repairs: ReadonlyMap<string, MilvusCanonicalRepair> = new Map(),
    private readonly poll: { timeoutMs?: number; intervalMs?: number } = {},
  ) {}

  async activeCollection(collection: CollectionName): Promise<string> {
    return resolveMilvusCollection(this.client, collection);
  }

  async inventory(collection: CollectionName) {
    const name = await this.activeCollection(collection);
    const version = (await ok(this.client.getVersion())).version;
    if (!(await ok(this.client.hasCollection({ collection_name: name }))).value) return { collection, name, version, exists: false };
    const schema = await ok(this.client.describeCollection({ collection_name: name, cache: false }));
    await ok(this.client.loadCollection({ collection_name: name }));
    const [rows, indexes, statistics] = await Promise.all([
      countMilvusRows(this.client, name), ok(this.client.describeIndex({ collection_name: name })), ok(this.client.getCollectionStatistics({ collection_name: name })),
    ]);
    return { collection, name, version, exists: true, rows, schema, indexes, statistics,
      bm25: this.hasBm25(schema) ? "already_defined" : this.canBackfill(schema) ? "eligible_for_backfill" : "replacement_required",
      requiredSettings: { "common.storage.useLoonFFI": true, "dataCoord.compaction.bumpSchemaVersion.enabled": true, "dataCoord.compaction.storageVersion.enabled": true },
      settingsVerified: false,
    };
  }

  private async requireVersion(): Promise<void> {
    const version = String((await ok(this.client.getVersion())).version ?? "");
    if (!/^(?:v)?(?:[3-9]|[1-9]\d+)\./.test(version)) throw new Error(`Milvus 3.0+ required; reported ${version || "unknown"}.`);
  }

  private repairDigest(): string {
    return createHash("sha256").update(JSON.stringify([...this.repairs].sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
  }

  private async fingerprint(name: string, transform = false): Promise<{ hash: string; rows: number; dimension: number }> {
    const hash = createHash("sha256");
    let rows = 0;
    let dimension = 0;
    for await (const batch of scanMilvusRows(this.client, name)) {
      for (const original of batch) {
        const row = transform ? repairedRow(original, this.repairs) : original;
        if (dimension && dimension !== row.vector.length) throw new Error("Collection contains incompatible vector dimensions.");
        dimension = row.vector.length;
        hash.update(serializeRow(row)).update("\n");
        rows++;
      }
    }
    if (rows !== await countMilvusRows(this.client, name)) throw new Error("Collection changed during its scan. Stop all writers before continuing.");
    return { hash: hash.digest("hex"), rows, dimension };
  }

  async planText(collection: CollectionName): Promise<MilvusCheckpoint> {
    await this.requireVersion();
    const source = await this.activeCollection(collection);
    const schema = await ok(this.client.describeCollection({ collection_name: source, cache: false }));
    this.assertOwnedSchema(schema);
    await ok(this.client.loadCollection({ collection_name: source }));
    const content = schema.schema.fields.find((field: any) => field.name === "content");
    if (["Text", "25"].includes(String(content.data_type)) && this.hasBm25(schema)) throw new Error("Active collection already has Text and BM25.");
    const original = await this.fingerprint(source);
    const expected = await this.fingerprint(source, true);
    const dim = this.dimension(schema);
    if (original.rows > 0 && (original.dimension !== dim || expected.dimension !== dim)) throw new Error("Stored vector rows do not match the declared dimension.");
    const id = randomUUID().replaceAll("-", "");
    return { version: 1, id, identity: this.identity, kind: "text", collection, source, target: `lumiverse_migration_${id}_${collection}`,
      phase: "planned", sourceFingerprint: original.hash, targetFingerprint: expected.hash, rowCount: original.rows,
      dimension: dim, repairDigest: this.repairDigest(), copied: 0 };
  }

  private validateState(state: MilvusCheckpoint): void {
    parseMilvusCheckpoint(state);
    if (state.version !== 1 || state.identity !== this.identity || !COLLECTIONS.includes(state.collection)
      || !["text", "bm25"].includes(state.kind) || !state.source.startsWith("lumiverse_")
      || (state.kind === "text" && state.target !== `lumiverse_migration_${state.id}_${state.collection}`)
      || state.repairDigest !== this.repairDigest()) throw new Error("Checkpoint target, version, or canonical repair input does not match this operation.");
  }

  private async unchanged(state: MilvusCheckpoint): Promise<void> {
    const current = await this.fingerprint(state.source);
    if (current.hash !== state.sourceFingerprint || current.rows !== state.rowCount) throw new Error("Source changed since planning. Stop writers and create a new plan; the old collection is retained.");
  }

  async copyText(state: MilvusCheckpoint): Promise<void> {
    this.validateState(state);
    if (state.kind !== "text" || ["cutover", "rolled_back"].includes(state.phase)) throw new Error("Checkpoint is not an active Text copy.");
    await this.requireVersion();
    await ok(this.client.loadCollection({ collection_name: state.source }));
    await this.unchanged(state);
    const description = `Lumiverse migration ${state.id}`;
    await this.save(state); // Intent must survive a crash after CreateCollection.
    if (!(await ok(this.client.hasCollection({ collection_name: state.target }))).value) {
      await ok(this.client.createCollection(milvusTextSchema(state.target, state.dimension, description)));
    }
    const targetSchema = await ok(this.client.describeCollection({ collection_name: state.target, cache: false }));
    if ((targetSchema.schema?.description ?? targetSchema.description) !== description) throw new Error("Target collection does not belong to this checkpoint.");
    if (this.dimension(targetSchema) !== state.dimension || !this.hasBm25(targetSchema)
      || !targetSchema.schema.fields.some((field: any) => field.name === "content" && ["Text", "25"].includes(String(field.data_type)))) throw new Error("Target schema is not the planned Text/BM25 schema.");
    // CreateCollection includes index creation in the SDK, but can fail after
    // only some indexes were created. Retry each bound definition on resume.
    for (const index of milvusTextSchema(state.target, state.dimension, description).index_params) {
      await ok(this.client.createIndex({ collection_name: state.target, ...index }));
    }
    state.phase = "copying";
    await this.save(state);
    for await (const batch of scanMilvusRows(this.client, state.source, { afterId: state.afterId })) {
      const data = batch.map((row) => repairedRow(row, this.repairs));
      await ok(this.client.upsert({ collection_name: state.target, data }));
      state.afterId = batch[batch.length - 1].id;
      state.copied += batch.length;
      await this.save(state);
    }
    state.phase = "validating";
    await this.save(state);
    await this.seal(state.target);
    await this.waitReady(state, false);
    const target = await this.fingerprint(state.target);
    if (target.hash !== state.targetFingerprint || target.rows !== state.rowCount) throw new Error("Target content, vector, or tenant/source metadata verification failed.");
    await this.unchanged(state);
    state.phase = "ready";
    delete state.error;
    await this.save(state);
  }

  async cutover(state: MilvusCheckpoint): Promise<void> {
    this.validateState(state);
    if (state.kind !== "text" || !["ready", "cutover"].includes(state.phase)) throw new Error("Copy must validate before cutover.");
    await ok(this.client.loadCollection({ collection_name: state.source }));
    await ok(this.client.loadCollection({ collection_name: state.target }));
    await this.unchanged(state);
    const target = await this.fingerprint(state.target);
    if (target.hash !== state.targetFingerprint || target.rows !== state.rowCount) throw new Error("Target changed after validation; cutover refused.");
    await this.waitReady(state, false);
    const active = await this.activeCollection(state.collection);
    if (active !== state.source && active !== state.target) throw new Error("Active routing changed outside this migration.");
    await this.pointAlias(state.collection, state.target);
    state.phase = "cutover";
    await this.save(state);
  }

  async rollback(state: MilvusCheckpoint): Promise<void> {
    this.validateState(state);
    if (state.kind !== "text" || !["ready", "cutover", "rolled_back"].includes(state.phase)) throw new Error("Checkpoint has no validated replacement to roll back.");
    const active = await this.activeCollection(state.collection);
    if (active !== state.target && active !== state.source) throw new Error("Active routing changed outside this migration.");
    await ok(this.client.loadCollection({ collection_name: state.target }));
    const target = await this.fingerprint(state.target);
    if (target.hash !== state.targetFingerprint || target.rows !== state.rowCount) throw new Error("Replacement has new writes. Reconcile them before rollback to avoid data loss.");
    await ok(this.client.loadCollection({ collection_name: state.source }));
    await this.unchanged(state);
    await this.pointAlias(state.collection, state.source);
    state.phase = "rolled_back";
    await this.save(state);
  }

  private async pointAlias(collection: CollectionName, target: string): Promise<void> {
    const alias = milvusActiveAlias(collection);
    const exists = (await ok(this.client.hasCollection({ collection_name: alias }))).value;
    await ok(this.client[exists ? "alterAlias" : "createAlias"]({ collection_name: target, alias }));
  }

  async planBackfill(collection: CollectionName): Promise<MilvusCheckpoint> {
    await this.requireVersion();
    const source = await this.activeCollection(collection);
    const schema = await ok(this.client.describeCollection({ collection_name: source, cache: false }));
    this.assertOwnedSchema(schema);
    if (this.hasBm25(schema)) throw new Error("BM25 already exists; inspect index health instead of adding a duplicate function.");
    if (!this.canBackfill(schema)) throw new Error("In-place BM25 requires analyzer-enabled VARCHAR content. Use Text replacement migration.");
    if (schema.schema.fields.some((field: any) => field.name === "sparse")) throw new Error("Sparse field already exists without the expected BM25 function; manual schema repair required.");
    await ok(this.client.loadCollection({ collection_name: source }));
    const fingerprint = await this.fingerprint(source);
    return { version: 1, id: randomUUID(), identity: this.identity, kind: "bm25", collection, source, target: source, phase: "planned",
      sourceFingerprint: fingerprint.hash, targetFingerprint: fingerprint.hash, rowCount: fingerprint.rows,
      dimension: this.dimension(schema), repairDigest: this.repairDigest(), copied: 0 };
  }

  async backfill(state: MilvusCheckpoint): Promise<void> {
    this.validateState(state);
    if (state.kind !== "bm25" || state.source !== state.target) throw new Error("Not a BM25 backfill checkpoint.");
    await this.requireVersion();
    await ok(this.client.loadCollection({ collection_name: state.source }));
    await this.unchanged(state);
    let schema = await ok(this.client.describeCollection({ collection_name: state.source, cache: false }));
    if (!this.hasBm25(schema)) {
      if (!this.canBackfill(schema)) throw new Error("Backfill input is no longer eligible.");
      await this.seal(state.source);
      state.phase = "waiting";
      await this.save(state);
      await ok(this.client.addFunctionField({
        collection_name: state.source,
        field: { name: "sparse", data_type: DataType.SparseFloatVector, is_function_output: true, nullable: false },
        function: { name: "content_bm25", type: FunctionType.BM25, input_field_names: ["content"], output_field_names: ["sparse"], params: {} },
        index_name: "idx_sparse",
        extra_params: { index_type: "SPARSE_INVERTED_INDEX", metric_type: "BM25" },
      }));
      schema = await ok(this.client.describeCollection({ collection_name: state.source, cache: false }));
      if (!this.hasBm25(schema)) throw new Error("BM25 function was not visible after schema alteration.");
    }
    await ok(this.client.loadCollection({ collection_name: state.source, refresh: true }));
    await this.waitReady(state, true);
    await this.unchanged(state);
    state.phase = "ready";
    delete state.error;
    await this.save(state);
  }

  private async waitReady(state: MilvusCheckpoint, backfill: boolean): Promise<void> {
    const deadline = Date.now() + (this.poll.timeoutMs ?? 600_000);
    let confirmations = 0;
    do {
      const [indexResponse, statistics] = await Promise.all([
        ok(this.client.describeIndex({ collection_name: state.target })),
        ok(this.client.getCollectionStatistics({ collection_name: state.target })),
      ]);
      const indexes = indexResponse.index_descriptions ?? [];
      const failure = indexes.find((index: any) => ["Failed", "4"].includes(String(index.state)) || index.index_state_fail_reason);
      if (failure) throw new Error(`Index build failed: ${failure.index_state_fail_reason || failure.index_name}`);
      const ready = ["vector", "sparse", ...SCALARS].every((field) => indexes.some((index: any) => index.field_name === field && maintenanceIndexReady(index)));
      const data = statistics.data ?? {};
      const consistent = counter(data.schema_version_consistent_segments);
      const total = counter(data.schema_version_total_segments);
      const covered = !backfill || (total !== null && consistent === total && (total > 0 || state.rowCount === 0));
      state.progress = { indexesReady: ready, consistentSegments: consistent, totalSegments: total };
      await this.save(state);
      confirmations = ready && covered ? confirmations + 1 : 0;
      if (confirmations >= (backfill ? 2 : 1)) return;
      if (Date.now() >= deadline) break;
      await Bun.sleep(Math.min(this.poll.intervalMs ?? 1000, Math.max(0, deadline - Date.now())));
    } while (Date.now() <= deadline);
    throw new Error("Timed out waiting for indexes/backfill. Checkpoint retained; missing counters do not prove completion.");
  }

  private async seal(name: string): Promise<void> {
    // Use bounded polling rather than the SDK's unbounded flushSync loop.
    const response = await ok(this.client.flush({ collection_names: [name] }));
    const segmentIDs = Object.values(response.coll_segIDs ?? {}).flatMap((value: any) => value.data ?? []);
    const deadline = Date.now() + (this.poll.timeoutMs ?? 600_000);
    do {
      if ((await ok(this.client.getFlushState({ segmentIDs }))).flushed === true) {
        await ok(this.client.loadCollection({ collection_name: name, refresh: true }));
        return;
      }
      if (Date.now() >= deadline) break;
      await Bun.sleep(Math.min(this.poll.intervalMs ?? 1000, Math.max(0, deadline - Date.now())));
    } while (Date.now() <= deadline);
    throw new Error("Timed out sealing collection; resume from the checkpoint.");
  }

  private assertOwnedSchema(description: any): void {
    const expected = new Set(["id", ...SCALARS, "content", "metadata_json", "updated_at", "vector", "sparse"]);
    if (!description.schema?.fields?.length || description.schema.fields.some((field: any) => !expected.has(field.name))) throw new Error("Collection has unexpected fields; automatic migration would discard data.");
    if (description.schema.enable_dynamic_field || description.schema.fields.some((field: any) => field.is_partition_key || field.is_clustering_key)
      || description.schema.struct_array_fields?.length) throw new Error("Collection uses custom schema features; migrate it explicitly.");
    const functions = description.schema.functions ?? description.functions ?? [];
    if (functions.length && (functions.length !== 1 || !this.hasBm25(description))) throw new Error("Collection has custom functions; migrate them explicitly.");
    const content = description.schema.fields.find((field: any) => field.name === "content");
    if (content?.type_params?.some((param: any) => ["analyzer_params", "multi_analyzer_params", "enable_match"].includes(param.key) && !["{}", "false", ""].includes(String(param.value)))) {
      throw new Error("Collection has custom analyzer/matching settings; preserve them in an explicit migration.");
    }
    for (const field of [...expected].filter((field) => field !== "sparse")) {
      if (!description.schema.fields.some((entry: any) => entry.name === field)) throw new Error(`Collection is missing ${field}.`);
    }
    this.dimension(description);
  }

  private dimension(description: any): number {
    const field = description.schema?.fields?.find((field: any) => field.name === "vector");
    const dim = Number(field?.type_params?.find((param: any) => param.key === "dim")?.value);
    if (!Number.isSafeInteger(dim) || dim <= 0) throw new Error("Collection has an invalid vector dimension.");
    return dim;
  }

  private hasBm25(description: any): boolean {
    return (description.schema?.functions ?? description.functions ?? []).some((fn: any) => ["BM25", "1"].includes(String(fn.type))
      && fn.input_field_names?.length === 1 && fn.input_field_names[0] === "content"
      && fn.output_field_names?.length === 1 && fn.output_field_names[0] === "sparse");
  }

  private canBackfill(description: any): boolean {
    return description.schema?.fields?.some((field: any) => field.name === "content" && ["VarChar", "21"].includes(String(field.data_type))
      && (field.enable_analyzer === true || field.type_params?.some((param: any) => param.key === "enable_analyzer" && String(param.value) === "true")));
  }
}

function counter(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function maintenanceIndexReady(index: any): boolean {
  const pending = counter(index.pending_index_rows);
  const total = counter(index.total_rows);
  const indexed = counter(index.indexed_rows);
  return ["Finished", "3"].includes(String(index.state)) && !index.index_state_fail_reason
    && pending === 0 && total !== null && indexed !== null && indexed >= total;
}

export { literal, MILVUS_READ_CONSISTENCY };
