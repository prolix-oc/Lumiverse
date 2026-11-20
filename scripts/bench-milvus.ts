#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { connectMilvusMaintenance, MilvusMaintenance, milvusConnectionIdentity } from "../src/services/vector-store/providers/milvus-maintenance";
import { benchmarkMilvus } from "../src/services/vector-store/providers/milvus-benchmark";
import { scanMilvusRows, assertMilvusResponse } from "../src/services/vector-store/providers/milvus";
import type { VectorRow } from "../src/services/vector-store/types";

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: "boolean" }, address: { type: "string" }, collection: { type: "string", default: "embeddings_world_books" },
    rows: { type: "string", default: "2000" }, queries: { type: "string", default: "20" }, text: { type: "boolean" },
    "index-type": { type: "string", default: "AUTOINDEX" }, "index-params": { type: "string", default: "{}" }, "search-params": { type: "string", default: "{}" },
    "flush-policy": { type: "string", default: "manual" },
  } });
  if (values.help) {
    console.log(`bun run bench:milvus --rows 2000 --queries 20 [--collection embeddings_world_books|embeddings]
  [--index-type AUTOINDEX|HNSW|HNSW_SQ|IVF_FLAT|...] [--index-params '{"M":32,"efConstruction":200}']
  [--search-params '{"ef":128}'] [--flush-policy manual|per_write] [--text]
Uses LUMIVERSE_MILVUS_ADDRESS/USERNAME/PASSWORD/DATABASE/SSL.
Copies a bounded corpus into an isolated temporary collection and deletes it afterward.
Verifies cross-client insert/update/delete visibility and tenant isolation without flushing.
Reports filtered dense recall, dense/BM25/hybrid latency, ingestion, and index build time.
Run against equivalent server configurations before/after opting into index versions 10/4.
Record server memory separately and compare only results with the same corpusHash.`);
    return;
  }
  const collection = values.collection;
  if (collection !== "embeddings" && collection !== "embeddings_world_books") throw new Error("Invalid collection.");
  const limit = Number(values.rows), queries = Number(values.queries);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000 || !Number.isSafeInteger(queries) || queries < 1 || queries > 1000) throw new Error("Invalid rows (1..100000) or queries (1..1000).");
  if (values["flush-policy"] !== "manual" && values["flush-policy"] !== "per_write") throw new Error("Invalid flush policy.");
  const indexParams = JSON.parse(values["index-params"]!), searchParams = JSON.parse(values["search-params"]!);
  if (!indexParams || Array.isArray(indexParams) || typeof indexParams !== "object" || !searchParams || Array.isArray(searchParams) || typeof searchParams !== "object") throw new Error("Index/search params must be JSON objects.");
  const config = { address: values.address ?? process.env.LUMIVERSE_MILVUS_ADDRESS ?? "", database: process.env.LUMIVERSE_MILVUS_DATABASE,
    username: process.env.LUMIVERSE_MILVUS_USERNAME, ssl: process.env.LUMIVERSE_MILVUS_SSL === "true" };
  if (!config.address) throw new Error("Set LUMIVERSE_MILVUS_ADDRESS or --address.");
  const writer = await connectMilvusMaintenance(config, process.env.LUMIVERSE_MILVUS_PASSWORD ?? null);
  let reader: Awaited<ReturnType<typeof connectMilvusMaintenance>> | undefined;
  try {
    reader = await connectMilvusMaintenance(config, process.env.LUMIVERSE_MILVUS_PASSWORD ?? null);
    const maintenance = new MilvusMaintenance(writer, milvusConnectionIdentity(config), async () => {});
    const source = await maintenance.activeCollection(collection);
    assertMilvusResponse(await writer.loadCollection({ collection_name: source }));
    const rows: VectorRow[] = [];
    for await (const batch of scanMilvusRows(writer, source, { limit })) rows.push(...batch);
    console.log(JSON.stringify(await benchmarkMilvus(writer, reader, rows, { indexType: values["index-type"], indexParams, searchParams, text: values.text, queries, flushPolicy: values["flush-policy"] }), null, 2));
  } finally {
    await Promise.allSettled([writer.closeConnection(), reader?.closeConnection()]);
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
