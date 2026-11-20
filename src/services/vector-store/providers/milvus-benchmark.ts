import { createHash, randomUUID } from "node:crypto";
import { DataType } from "@zilliz/milvus2-sdk-node";
import { cosineSimilarity } from "../addressing";
import type { VectorRow } from "../types";
import { assertMilvusResponse, countMilvusRows, literal, MILVUS_READ_CONSISTENCY } from "./milvus";
import { milvusRowHash, milvusTextSchema } from "./milvus-maintenance";

const ok = async (promise: Promise<any>): Promise<any> => assertMilvusResponse(await promise);
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

async function flushBenchmark(client: any, name: string, timeoutMs: number): Promise<void> {
  const response = await ok(client.flush({ collection_names: [name] }));
  const segmentIDs = Object.values(response.coll_segIDs ?? {}).flatMap((value: any) => value.data ?? []);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await ok(client.getFlushState({ segmentIDs }));
    // Match the SDK flushSync polling floor, with a bounded overall wait.
    await Bun.sleep(100);
    if (result.flushed === true) return;
    if (Date.now() >= deadline) throw new Error("Timed out flushing benchmark collection.");
  }
}

/** Separate writer/reader clients are required: a session-only guarantee cannot pass. */
export async function verifyMilvusVisibility(writer: any, reader: any, name: string, dimension: number): Promise<void> {
  const base: VectorRow = {
    id: "visibility-a", user_id: "visibility-tenant-a", source_type: "databank", source_id: "probe-a", owner_id: "probe-bank", chunk_index: 0,
    content: "lumiversevisibilityprobe", vector: Array.from({ length: dimension }, (_, i) => i === 0 ? 1 : 0), metadata_json: "{}", updated_at: 1,
  };
  const other = { ...base, id: "visibility-b", user_id: "visibility-tenant-b", source_id: "probe-b" };
  const filter = `user_id == ${literal(base.user_id)}`;
  const read = async (text: string) => {
    const common = { collection_name: name, consistency_level: MILVUS_READ_CONSISTENCY, filter, limit: 10, output_fields: ["id", "content", "user_id", "vector"] };
    const [rows, dense, lexical, hybrid, count] = await Promise.all([
      ok(reader.query(common)),
      ok(reader.search({ ...common, data: base.vector, anns_field: "vector", metric_type: "COSINE" })),
      ok(reader.search({ ...common, data: text, anns_field: "sparse", metric_type: "BM25" })),
      ok(reader.hybridSearch({ ...common, data: [
        { data: base.vector, anns_field: "vector", expr: filter, limit: 10, metric_type: "COSINE" },
        { data: text, anns_field: "sparse", expr: filter, limit: 10, metric_type: "BM25" },
      ], rerank: { strategy: "rrf", params: { k: 60 } } })),
      countMilvusRows(reader, name, filter),
    ]);
    return { legs: [rows.data, dense.results, lexical.results, hybrid.results] as any[][], count };
  };
  await ok(writer.upsert({ collection_name: name, data: [base, other] }));
  const inserted = await read(base.content);
  assert(inserted.count === 1 && inserted.legs.every((leg) => leg?.length === 1 && leg[0].id === base.id && leg[0].content === base.content), "Immediate cross-client insert visibility or tenant isolation failed.");
  base.content = "lumiverseupdatedprobe";
  base.updated_at = 2;
  if (dimension > 1) base.vector = Array.from({ length: dimension }, (_, i) => i === 1 ? 1 : 0);
  await ok(writer.upsert({ collection_name: name, data: [base] }));
  const updated = await read(base.content);
  assert(updated.count === 1 && updated.legs.every((leg) => leg?.length === 1 && leg[0].content === base.content), "Immediate cross-client update visibility failed.");
  assert(JSON.stringify(updated.legs[0][0].vector) === JSON.stringify(base.vector), "Immediate updated vector visibility failed.");
  await ok(writer.delete({ collection_name: name, filter }));
  const deleted = await read(base.content);
  assert(deleted.count === 0 && deleted.legs.every((leg) => leg?.length === 0), "Immediate cross-client delete visibility failed.");
  assert(await countMilvusRows(reader, name, `user_id == ${literal(other.user_id)}`) === 1, "Delete crossed tenant boundaries.");
  await ok(writer.delete({ collection_name: name, filter: `user_id == ${literal(other.user_id)}` }));
}

function percentile(values: number[], fraction: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
}

export async function benchmarkMilvus(
  writer: any, reader: any, rows: VectorRow[],
  options: { indexType?: string; indexParams?: Record<string, unknown>; searchParams?: Record<string, unknown>; text?: boolean; flushPolicy?: "manual" | "per_write"; queries?: number; timeoutMs?: number } = {},
) {
  assert(rows.length > 0, "Benchmark corpus is empty.");
  const dimension = rows[0].vector.length;
  assert(dimension > 0 && rows.every((row) => row.vector.length === dimension && row.vector.every(Number.isFinite)), "Benchmark vectors have invalid dimensions/values.");
  const name = `lumiverse_benchmark_${randomUUID().replaceAll("-", "")}`;
  const description = `Lumiverse isolated benchmark ${name}`;
  const request = milvusTextSchema(name, dimension, description, options.indexType, options.indexParams);
  if (!options.text) {
    const field: any = request.fields.find((field) => field.name === "content")!;
    field.data_type = DataType.VarChar;
    field.max_length = 65_535;
    assert(rows.every((row) => Buffer.byteLength(row.content) <= 65_535), "Use --text for benchmark content beyond VARCHAR limits.");
  }
  const corpusHash = createHash("sha256").update(rows.map(milvusRowHash).join("\n")).digest("hex");
  try {
    await ok(writer.createCollection(request));
    await ok(writer.loadCollection({ collection_name: name }));
    // No flush between mutation and any observer read in this check.
    await verifyMilvusVisibility(writer, reader, name, dimension);
    const start = performance.now();
    for (let offset = 0; offset < rows.length; offset += 128) {
      await ok(writer.upsert({ collection_name: name, data: rows.slice(offset, offset + 128) }));
      if (options.flushPolicy === "per_write") {
        await flushBenchmark(writer, name, options.timeoutMs ?? 600_000);
        await ok(writer.loadCollection({ collection_name: name, refresh: true }));
      }
    }
    const ingestionMs = performance.now() - start;
    const flushStart = performance.now();
    const flushed = await ok(writer.flush({ collection_names: [name] }));
    const segmentIDs = Object.values(flushed.coll_segIDs ?? {}).flatMap((value: any) => value.data ?? []);
    const deadline = Date.now() + (options.timeoutMs ?? 600_000);
    let indexes: any;
    for (;;) {
      indexes = await ok(writer.describeIndex({ collection_name: name }));
      const descriptions: any[] = indexes.index_descriptions ?? [];
      const failed = descriptions.find((index) => index.index_state_fail_reason || ["Failed", "4"].includes(String(index.state)));
      if (failed) throw new Error(`Benchmark index failed: ${failed.index_state_fail_reason || failed.index_name}`);
      if ((await ok(writer.getFlushState({ segmentIDs }))).flushed === true
        && ["vector", "sparse"].every((field) => descriptions.some((index) => index.field_name === field
        && ["Finished", "3"].includes(String(index.state)) && Number(index.pending_index_rows) === 0
        && Number(index.indexed_rows) >= Number(index.total_rows)))) break;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for benchmark indexes.");
      await Bun.sleep(500);
    }
    await ok(writer.loadCollection({ collection_name: name, refresh: true }));
    const indexBuildMs = performance.now() - flushStart;
    assert(await countMilvusRows(reader, name) === rows.length, "Benchmark row count mismatch.");
    const timings = { dense: [] as number[], lexical: [] as number[], hybrid: [] as number[] };
    const recalls: number[] = [];
    const queries = Math.max(1, Math.min(rows.length, options.queries ?? 20));
    for (let i = 0; i < queries; i++) {
      const row = rows[Math.floor(i * rows.length / queries)];
      const filter = `user_id == ${literal(row.user_id)}`;
      const scope = rows.filter((candidate) => candidate.user_id === row.user_id);
      const limit = Math.min(10, scope.length);
      const common = { collection_name: name, consistency_level: MILVUS_READ_CONSISTENCY, filter, limit, output_fields: ["id", "user_id"] };
      const term = row.content.match(/[\p{L}\p{N}]{3,32}/u)?.[0];
      const denseRequest = { ...common, data: row.vector, anns_field: "vector", metric_type: "COSINE", params: options.searchParams ?? {} };
      let before = performance.now();
      const dense = await ok(reader.search(denseRequest));
      timings.dense.push(performance.now() - before);
      const exact = new Map(scope.map((candidate) => [candidate.id, cosineSimilarity(row.vector, candidate.vector)]));
      const cutoff = [...exact.values()].sort((a, b) => b - a)[limit - 1];
      const hits: any[] = dense.results ?? [];
      assert(hits.every((hit) => hit.user_id === row.user_id), "Benchmark search crossed tenant boundaries.");
      recalls.push(new Set(hits.filter((hit) => (exact.get(hit.id) ?? -Infinity) >= cutoff - 1e-6).map((hit) => hit.id)).size / limit);
      if (term) {
        before = performance.now();
        const lexical = await ok(reader.search({ ...common, data: term, anns_field: "sparse", metric_type: "BM25" }));
        timings.lexical.push(performance.now() - before);
        assert((lexical.results ?? []).every((hit: any) => hit.user_id === row.user_id), "Benchmark lexical search crossed tenant boundaries.");
        before = performance.now();
        const hybrid = await ok(reader.hybridSearch({ ...common, data: [
          { data: row.vector, anns_field: "vector", expr: filter, limit: limit * 3, metric_type: "COSINE", params: options.searchParams ?? {} },
          { data: term, anns_field: "sparse", expr: filter, limit: limit * 3, metric_type: "BM25" },
        ], rerank: { strategy: "rrf", params: { k: 60 } } }));
        timings.hybrid.push(performance.now() - before);
        assert((hybrid.results ?? []).every((hit: any) => hit.user_id === row.user_id), "Benchmark hybrid search crossed tenant boundaries.");
      }
    }
    return {
      serverVersion: (await ok(writer.getVersion())).version, corpusHash, rows: rows.length, dimension,
      indexType: options.indexType ?? "AUTOINDEX", indexParams: options.indexParams ?? {}, searchParams: options.searchParams ?? {},
      contentType: options.text ? "Text" : "VarChar", flushPolicy: options.flushPolicy ?? "manual", ingestionMs, rowsPerSecond: rows.length / (ingestionMs / 1000), indexBuildMs,
      immediateCrossClientVisibility: true, tenantIsolation: true, denseRecallAt10: recalls.reduce((a, b) => a + b, 0) / recalls.length,
      latencyMs: Object.fromEntries(Object.entries(timings).map(([leg, values]) => [leg, { queries: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) }])),
      indexes, memoryMeasurement: "Collect server RSS/index memory externally while this benchmark runs; not inferred from client timings.",
      denseIndexedRows: Number(indexes.index_descriptions?.find((index: any) => index.field_name === "vector")?.indexed_rows ?? 0),
      indexCoverageAdequate: Number(indexes.index_descriptions?.find((index: any) => index.field_name === "vector")?.indexed_rows ?? 0) >= rows.length,
    };
  } finally {
    // Never clean up the source or an unrelated collection, including after a
    // partially successful CreateCollection RPC.
    if ((await ok(writer.hasCollection({ collection_name: name }))).value) {
      const schema = await ok(writer.describeCollection({ collection_name: name, cache: false }));
      if ((schema.schema?.description ?? schema.description) !== description) throw new Error(`Benchmark cleanup refused unexpected owner for ${name}.`);
      await ok(writer.dropCollection({ collection_name: name }));
    }
  }
}
