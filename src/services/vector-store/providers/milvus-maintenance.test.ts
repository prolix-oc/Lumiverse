import { describe, expect, test } from "bun:test";
import { MilvusMaintenance, milvusRowHash, milvusTextSchema, type MilvusCheckpoint } from "./milvus-maintenance";
import type { VectorRow } from "../types";
import { benchmarkMilvus, verifyMilvusVisibility } from "./milvus-benchmark";

function row(index = 0): VectorRow {
  return { id: `row-${String(index).padStart(6, "0")}`, user_id: `user-${index % 2}`, source_type: "databank", source_id: `chunk-${index}`, owner_id: "bank", chunk_index: 0,
    content: `sword text ${index}`, metadata_json: "{}", updated_at: 1, vector: [1, index % 2] };
}

function setup(count = 3, analyzer = false) {
  const name = "lumiverse_embeddings";
  const tables = new Map<string, { description: string; schema: any; data: Map<string, VectorRow> }>();
  const source = milvusTextSchema(name, 2, "original");
  source.fields = source.fields.filter((field) => field.name !== "sparse");
  const content: any = source.fields.find((field) => field.name === "content");
  content.data_type = "VarChar"; content.enable_analyzer = analyzer;
  const makeSchema = (request: any) => ({ description: request.description, schema: {
    description: request.description,
    fields: request.fields.map((field: any) => ({ ...field, type_params: field.name === "vector" ? [{ key: "dim", value: String(field.dim) }] : [] })),
    functions: request.functions ?? [],
  } });
  tables.set(name, { description: "original", schema: makeSchema({ ...source, functions: [] }), data: new Map(Array.from({ length: count }, (_, i) => [row(i).id, row(i)])) });
  const aliases = new Map<string, string>();
  const saved: MilvusCheckpoint[] = [];
  const control = { writes: 0, adds: 0, indexCreates: 0, failAfterCreate: false, failAtWrite: -1, missingCounters: false, complete: true, failIndex: false, pending: false, blockedStorage: false };
  const table = (key: string) => {
    const value = tables.get(aliases.get(key) ?? key);
    if (!value) throw new Error(`missing collection ${key}`);
    return value;
  };
  const unquote = (value: string) => value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  const matches = (value: VectorRow, filter: string) => {
    const greater = /id > "((?:\\.|[^"\\])*)"/.exec(filter);
    if (greater && Buffer.compare(Buffer.from(value.id), Buffer.from(unquote(greater[1]))) <= 0) return false;
    for (const match of filter.matchAll(/(user_id|id) == "((?:\\.|[^"\\])*)"/g)) {
      if (value[match[1] as "id" | "user_id"] !== unquote(match[2])) return false;
    }
    return true;
  };
  const filtered = (request: any) => [...table(request.collection_name).data.values()].filter((value) => matches(value, request.filter ?? request.expr ?? ""));
  const strong = (request: any) => expect(request.consistency_level).toBe("Strong");
  const client: any = {
    getVersion: async () => ({ version: "3.0.3" }),
    hasCollection: async ({ collection_name }: any) => ({ value: tables.has(collection_name) || aliases.has(collection_name) }),
    describeCollection: async ({ collection_name, cache }: any) => { expect(cache).toBe(false); return structuredClone(table(collection_name).schema); },
    loadCollection: async () => ({}),
    createIndex: async () => { control.indexCreates++; return {}; },
    query: async (request: any) => {
      strong(request);
      const data = filtered(request).sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
      return { data: request.output_fields[0] === "count(*)" ? [{ "count(*)": String(data.length) }] : data.slice(0, request.limit) };
    },
    createCollection: async (request: any) => {
      if (control.blockedStorage) throw new Error("StorageV3 required");
      if (tables.has(request.collection_name)) throw new Error("already exists");
      tables.set(request.collection_name, { description: request.description, schema: makeSchema(request), data: new Map() });
      if (control.failAfterCreate) { control.failAfterCreate = false; throw new Error("interrupted index creation"); }
      return {};
    },
    dropCollection: async ({ collection_name }: any) => { tables.delete(collection_name); return {}; },
    upsert: async (request: any) => {
      control.writes++;
      request.data.forEach((value: VectorRow) => table(request.collection_name).data.set(value.id, structuredClone(value)));
      if (control.writes === control.failAtWrite) throw new Error("ambiguous transport failure after write");
      return {};
    },
    flush: async () => ({ coll_segIDs: { collection: { data: ["segment-1"] } } }),
    getFlushState: async () => ({ flushed: true }),
    describeIndex: async ({ collection_name }: any) => ({ index_descriptions: ["vector", "sparse", "user_id", "source_type", "source_id", "owner_id", "chunk_index"].map((field_name) => ({
      field_name, index_name: field_name, state: control.failIndex ? "Failed" : "Finished", index_state_fail_reason: control.failIndex ? "failed build" : "",
      total_rows: String(table(collection_name).data.size), indexed_rows: String(table(collection_name).data.size), pending_index_rows: control.pending ? "1" : "0",
    })) }),
    getCollectionStatistics: async () => ({ data: control.missingCounters ? {} : { schema_version_total_segments: "2", schema_version_consistent_segments: control.complete ? "2" : "1" } }),
    addFunctionField: async (request: any) => {
      control.adds++;
      const entry = table(request.collection_name);
      entry.schema.schema.fields.push(request.field);
      entry.schema.schema.functions.push(request.function);
      return { alter_status: { error_code: "Success" } };
    },
    describeAlias: async ({ alias }: any) => ({ collection: aliases.get(alias) }),
    createAlias: async ({ alias, collection_name }: any) => { aliases.set(alias, collection_name); return {}; },
    alterAlias: async ({ alias, collection_name }: any) => { aliases.set(alias, collection_name); return {}; },
    delete: async (request: any) => { for (const value of filtered(request)) table(request.collection_name).data.delete(value.id); return {}; },
    search: async (request: any) => { strong(request); return { results: filtered(request).filter((value) => request.anns_field !== "sparse" || value.content.includes(request.data)).slice(0, request.limit) }; },
    hybridSearch: async (request: any) => { strong(request); request.data.forEach((leg: any) => expect(leg.expr).toBe(request.filter)); return { results: filtered(request).slice(0, request.limit) }; },
  };
  const save = async (state: MilvusCheckpoint) => { saved.push(structuredClone(state)); };
  const maintenance = new MilvusMaintenance(client, "server-identity", save, new Map(), { timeoutMs: 5, intervalMs: 0 });
  return { client, maintenance, tables, aliases, saved, control, name, save };
}

describe("Milvus Text migration", () => {
  test("plans, copies, verifies, switches routing, and rolls back without dropping either collection", async () => {
    const { maintenance, tables, aliases, name } = setup();
    const state = await maintenance.planText("embeddings");
    expect(tables.size).toBe(1);
    await maintenance.copyText(state);
    expect(state.phase).toBe("ready");
    expect([...tables.get(state.target)!.data.values()]).toEqual([...tables.get(name)!.data.values()]);
    expect(aliases.size).toBe(0);
    await maintenance.cutover(state);
    expect(await maintenance.activeCollection("embeddings")).toBe(state.target);
    await maintenance.cutover(state); // recovery after alias RPC succeeds but checkpoint persistence fails
    await maintenance.rollback(state);
    expect(await maintenance.activeCollection("embeddings")).toBe(name);
    expect(tables.size).toBe(2);
  });

  test("replays a batch safely after an ambiguous write failure", async () => {
    const { maintenance, saved, control, tables } = setup(1100);
    const state = await maintenance.planText("embeddings");
    control.failAtWrite = 2;
    await expect(maintenance.copyText(state)).rejects.toThrow("ambiguous");
    const checkpoint = saved.at(-1)!;
    expect(checkpoint.copied).toBe(512);
    control.failAtWrite = -1;
    await maintenance.copyText(checkpoint);
    expect(checkpoint.phase).toBe("ready");
    expect(tables.get(state.target)!.data.size).toBe(1100);
    expect(checkpoint.copied).toBe(1100);
  });

  test("repairs partial index creation when resuming an existing owned target", async () => {
    const { maintenance, control, tables } = setup();
    const state = await maintenance.planText("embeddings");
    control.failAfterCreate = true;
    await expect(maintenance.copyText(state)).rejects.toThrow("interrupted index");
    expect(tables.has(state.target)).toBe(true);
    expect(state.copied).toBe(0);
    await maintenance.copyText(state);
    expect(control.indexCreates).toBe(7);
    expect(state.phase).toBe("ready");
  });

  test("detects source changes before copying and before cutover", async () => {
    const { maintenance, tables, name } = setup();
    const state = await maintenance.planText("embeddings");
    tables.get(name)!.data.set(row(10).id, row(10));
    await expect(maintenance.copyText(state)).rejects.toThrow("Source changed");
    expect(tables.has(state.target)).toBe(false);
    tables.get(name)!.data.delete(row(10).id);
    await maintenance.copyText(state);
    tables.get(name)!.data.delete(row(0).id);
    await expect(maintenance.cutover(state)).rejects.toThrow("Source changed");
  });

  test("refuses rollback after new writes to the replacement", async () => {
    const { maintenance, tables } = setup();
    const state = await maintenance.planText("embeddings");
    await maintenance.copyText(state);
    await maintenance.cutover(state);
    tables.get(state.target)!.data.set(row(99).id, row(99));
    await expect(maintenance.rollback(state)).rejects.toThrow("new writes");
  });

  test("fails closed on StorageV3, ownership, and index failures", async () => {
    const { maintenance, tables, control } = setup();
    const state = await maintenance.planText("embeddings");
    control.blockedStorage = true;
    await expect(maintenance.copyText(state)).rejects.toThrow("StorageV3");
    expect(tables.size).toBe(1);
    control.blockedStorage = false;
    control.failIndex = true;
    await expect(maintenance.copyText(state)).rejects.toThrow("failed build");
    tables.get(state.target)!.schema.schema.description = "another owner";
    await expect(maintenance.copyText(state)).rejects.toThrow("does not belong");
  });

  test("rejects clipped rows and accepts canonical repairs bound to the exact original row", async () => {
    const { maintenance, client, tables, name, save } = setup(1);
    const clipped = { ...row(), content: "prefix\n[content clipped]" };
    tables.get(name)!.data.set(clipped.id, clipped);
    await expect(maintenance.planText("embeddings")).rejects.toThrow("Clipped content");
    const full = { ...clipped, content: "界".repeat(30_000), vector: [0, 1] };
    const repairs = new Map([[clipped.id, { sourceHash: milvusRowHash(clipped), row: full }]]);
    const repairing = new MilvusMaintenance(client, "server-identity", save, repairs, { timeoutMs: 5, intervalMs: 0 });
    const state = await repairing.planText("embeddings");
    await repairing.copyText(state);
    expect(tables.get(state.target)!.data.get(full.id)!.content).toBe(full.content);
    await expect(maintenance.cutover(state)).rejects.toThrow("canonical repair input");
    repairs.set(clipped.id, { sourceHash: "stale", row: full });
    await expect(repairing.planText("embeddings")).rejects.toThrow("stale");
  });

  test("can migrate an empty collection and rejects another endpoint's checkpoint", async () => {
    const { maintenance } = setup(0);
    const state = await maintenance.planText("embeddings");
    await maintenance.copyText(state);
    expect(state.phase).toBe("ready");
    state.identity = "another-endpoint";
    await expect(maintenance.cutover(state)).rejects.toThrow("does not match");
  });
});

describe("Milvus BM25 backfill", () => {
  test("rejects legacy fallback schemas without an analyzer", async () => {
    await expect(setup().maintenance.planBackfill("embeddings")).rejects.toThrow("analyzer-enabled VARCHAR");
  });

  test("resumes without adding a second function and requires positive completed counters", async () => {
    const { maintenance, control, tables, name } = setup(3, true);
    const state = await maintenance.planBackfill("embeddings");
    control.complete = false;
    await expect(maintenance.backfill(state)).rejects.toThrow("Timed out");
    expect(control.adds).toBe(1);
    control.missingCounters = true;
    await expect(maintenance.backfill(state)).rejects.toThrow("Timed out");
    expect(control.adds).toBe(1);
    control.missingCounters = false; control.complete = true;
    await maintenance.backfill(state);
    expect(state.phase).toBe("ready");
    expect(tables.get(name)!.data.size).toBe(3);
    await expect(maintenance.planBackfill("embeddings")).rejects.toThrow("already exists");
  });

  test("Finished sparse indexes with pending rows do not complete backfill", async () => {
    const { maintenance, control } = setup(3, true);
    const state = await maintenance.planBackfill("embeddings");
    control.pending = true;
    await expect(maintenance.backfill(state)).rejects.toThrow("Timed out");
    expect(state.phase).toBe("waiting");
  });
});

test("cross-client visibility probe covers every retrieval leg, update/delete, and isolation without a flush", async () => {
  const { client, name, tables } = setup(0);
  const reader = { ...client };
  await verifyMilvusVisibility(client, reader, name, 2);
  expect(tables.get(name)!.data.size).toBe(0);
});

test("benchmark reports filtered recall and cleans up only its isolated collection", async () => {
  const { client, tables, name } = setup(5);
  const rows = [...tables.get(name)!.data.values()];
  const result = await benchmarkMilvus(client, { ...client }, rows, { queries: 2 });
  expect(result.immediateCrossClientVisibility).toBe(true);
  expect(result.denseRecallAt10).toBe(1);
  expect(result.latencyMs.dense.queries).toBe(2);
  expect(result.rows).toBe(5);
  expect(tables.size).toBe(1);
  expect(tables.has(name)).toBe(true);
});
