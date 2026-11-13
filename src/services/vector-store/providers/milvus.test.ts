import { describe, expect, test } from "bun:test";

import { eq } from "../addressing";
import type { HybridSearchOptions, VectorHit, VectorRow } from "../types";
import { MILVUS_READ_CONSISTENCY, MilvusStore, countMilvusRows, scanMilvusRows } from "./milvus";

function vectorRow(overrides: Partial<VectorRow> = {}): VectorRow {
  return {
    id: "row-1",
    user_id: "user-1",
    source_type: "world_book_entry",
    source_id: "entry-1",
    owner_id: "book-1",
    chunk_index: 0,
    content: "content",
    metadata_json: "{}",
    updated_at: 1,
    vector: [1, 0],
    ...overrides,
  };
}

describe("MilvusStore write lifecycle", () => {
  function setup(flushPolicy: "manual" | "per_write" = "manual", text = false) {
    const store = new MilvusStore({ address: "localhost:19530", flushPolicy }, null);
    store.capabilities = { ...store.capabilities, nativeLexical: true };
    const calls = { describe: 0, index: 0, load: 0, flush: 0, writes: [] as any[], drops: 0 };
    let failIndex = false;
    const client = {
      hasCollection: async () => ({ value: true }),
      describeIndex: async () => ({ index_descriptions: [] }),
      describeCollection: async () => {
        calls.describe++;
        return { schema: { fields: [{ name: "vector", type_params: [{ key: "dim", value: "2" }] }, { name: "content", data_type: text ? "Text" : "VarChar" }, { name: "sparse" }] } };
      },
      createIndex: async () => { calls.index++; return { error_code: failIndex ? "UnexpectedError" : "Success" }; },
      loadCollection: async () => { calls.load++; return {}; },
      flushSync: async () => { calls.flush++; return {}; },
      upsert: async (request: any) => { calls.writes.push(request); return {}; },
      delete: async () => ({}),
      dropCollection: async () => { calls.drops++; return {}; },
    };
    (store as any).client = client;
    return { store, client, calls, setFailIndex: (value: boolean) => { failIndex = value; } };
  }

  test("coalesces concurrent setup and omits repeated schema/index RPCs", async () => {
    const { store, calls } = setup();
    await Promise.all([store.upsert("embeddings", [vectorRow()]), store.upsert("embeddings", [vectorRow()])]);
    const described = calls.describe;
    expect(calls.index).toBe(6);
    expect(calls.load).toBe(1);
    await store.upsert("embeddings", [vectorRow()]);
    expect(calls.describe).toBe(described);
    expect(calls.index).toBe(6);
    expect(calls.writes).toHaveLength(3);
    expect(calls.flush).toBe(0);
  });

  test("retries unsuccessful index setup", async () => {
    const { store, calls, setFailIndex } = setup();
    setFailIndex(true);
    await store.upsert("embeddings", [vectorRow()]);
    setFailIndex(false);
    await store.upsert("embeddings", [vectorRow()]);
    expect(calls.index).toBe(12);
    await store.upsert("embeddings", [vectorRow()]);
    expect(calls.index).toBe(12);
  });

  test("accepts an existing sparse index with a server-assigned name", async () => {
    const { store, client, calls } = setup();
    (client as any).describeIndex = async () => ({ index_descriptions: [{ field_name: "sparse", index_name: "server_auto_sparse", state: "Finished", params: [{ key: "metric_type", value: "BM25" }] }] });
    await store.upsert("embeddings", [vectorRow()]);
    await store.upsert("embeddings", [vectorRow()]);
    expect(calls.index).toBe(5);
  });

  test("rejects dimension changes even when setup is cached", async () => {
    const { store, calls } = setup();
    await store.upsert("embeddings", [vectorRow()]);
    await expect(store.upsert("embeddings", [vectorRow({ vector: [1, 0, 0] })])).rejects.toThrow("dimension 2, expected 3");
    expect(calls.writes).toHaveLength(1);
    await expect(store.upsert("embeddings", [vectorRow(), vectorRow({ vector: [NaN, 0] })])).rejects.toThrow("finite vectors");
  });

  test("preserves full content in migrated Text collections", async () => {
    const { store, calls } = setup("manual", true);
    const content = "界".repeat(30_000);
    await store.upsert("embeddings", [vectorRow({ content })]);
    expect(calls.writes[0].data[0].content).toBe(content);
  });

  test("reset clears setup and Text caches", async () => {
    const { store, calls } = setup();
    await store.upsert("embeddings", [vectorRow()]);
    await store.reset();
    await store.upsert("embeddings", [vectorRow()]);
    expect(calls.index).toBe(12);
    expect(calls.drops).toBe(2);
  });

  test("reset preserves Text routing and permits a new dimension through an empty replacement", async () => {
    const sdk = await import("@zilliz/milvus2-sdk-node");
    const store = new MilvusStore({ address: "localhost:19530", flushPolicy: "manual" }, null);
    store.capabilities = { ...store.capabilities, nativeLexical: true };
    (store as any).sdk = sdk;
    const name = "lumiverse_migration_abc_embeddings";
    (store as any).routes.set("embeddings", name);
    let exists = true;
    let created: any;
    let alias: any;
    let deleted = false;
    let written: any;
    (store as any).client = {
      hasCollection: async ({ collection_name }: any) => ({ value: (collection_name === name && exists) || collection_name === created?.collection_name }),
      describeCollection: async () => ({ schema: { fields: [{ name: "content", data_type: "Text" }, { name: "vector", type_params: [{ key: "dim", value: "2" }] }, { name: "sparse" }] } }),
      dropCollection: async () => { throw new Error("must retain active Text routing"); },
      delete: async () => { deleted = true; return {}; },
      flushSync: async () => ({}),
      query: async () => ({ data: [{ "count(*)": "0" }] }),
      createCollection: async (request: any) => { exists = true; created = request; return {}; },
      createIndex: async () => ({}), loadCollection: async () => ({}),
      createAlias: async (request: any) => { alias = request; return {}; },
      upsert: async (request: any) => { written = request; return {}; },
    };
    await store.reset();
    expect(deleted).toBe(true);
    expect(created).toBeUndefined();
    await store.upsert("embeddings", [vectorRow({ vector: [1, 0, 0] })]);
    expect(created.fields.find((field: any) => field.name === "content").data_type).toBe(sdk.DataType.Text);
    expect(alias).toEqual({ collection_name: created.collection_name, alias: "lumiverse_active_embeddings" });
    expect(written.collection_name).toBe(created.collection_name);
    expect(created.fields.find((field: any) => field.name === "vector").dim).toBe(3);
    expect(created.functions[0].type).toBe(sdk.FunctionType.BM25);
  });

  test("manual policy avoids write/delete flushes but retains maintenance flushes", async () => {
    const { store, calls } = setup();
    await store.upsert("embeddings", [vectorRow()]);
    await store.deleteByIds("embeddings", ["row-1"]);
    await store.deleteByFilter("embeddings", eq("user_id", "user-1"));
    expect(calls.flush).toBe(0);
    expect(store.capabilities.requiresExplicitFlush).toBe(false);
    await store.optimize(["embeddings"]);
    expect(calls.flush).toBe(1);
  });

  test("retains the per-write policy", async () => {
    const { store, calls } = setup("per_write");
    await store.upsert("embeddings", [vectorRow()]);
    await store.deleteByIds("embeddings", ["row-1"]);
    expect(calls.flush).toBe(2);
  });
});

describe("Milvus consistent scans", () => {
  test("passes Strong through the real SDK search and hybrid request builder", async () => {
    const sdk = await import("@zilliz/milvus2-sdk-node");
    const description: any = {
      schema: { fields: [{ name: "id", is_primary_key: true, data_type: "VarChar" }] },
      anns_fields: { vector: { name: "vector", data_type: "FloatVector", dataType: sdk.DataType.FloatVector, index_params: [{ key: "metric_type", value: "COSINE" }] } },
      consistency_level: sdk.ConsistencyLevelEnum.Bounded,
    };
    const common: any = { collection_name: "test", anns_field: "vector", ids: ["row-1"], limit: 1, consistency_level: MILVUS_READ_CONSISTENCY };
    expect(String(sdk.buildSearchRequest(common, description, {} as any).request.consistency_level)).toBe("Strong");
    const hybrid: any = { collection_name: "test", data: [common, common], limit: 1, consistency_level: MILVUS_READ_CONSISTENCY };
    expect(String(sdk.buildSearchRequest(hybrid, description, {} as any).request.consistency_level)).toBe("Strong");
  });

  test("scans beyond the offset window with escaped primary-key cursors", async () => {
    let requested = 0;
    const total = 17_000;
    const client = { query: async (request: any) => {
      expect(request.consistency_level).toBe("Strong");
      expect(request.offset).toBeUndefined();
      if (requested) expect(request.filter).toContain('id > "row-');
      const count = Math.min(request.limit, total - requested);
      const batch = Array.from({ length: count }, (_, i) => vectorRow({ id: `row-${String(requested + i).padStart(6, "0")}` }));
      requested += count;
      return { data: batch };
    } };
    let count = 0;
    for await (const rows of scanMilvusRows(client, "test")) count += rows.length;
    expect(count).toBe(total);
    const requests: any[] = [];
    for await (const _ of scanMilvusRows({ query: async (request: any) => { requests.push(request); return { data: [] }; } }, "test", { afterId: 'quote"\\value' })) {}
    expect(requests[0].filter).toContain('id > "quote\\"\\\\value"');
  });

  test("scan and aggregate failures cannot masquerade as empty collections", async () => {
    await expect(countMilvusRows({ query: async () => ({ status: { error_code: "UnexpectedError", reason: "unavailable" }, data: [] }) }, "test")).rejects.toThrow("unavailable");
    await expect(countMilvusRows({ query: async () => ({ data: [{}] }) }, "test")).rejects.toThrow("invalid result");
    await expect((async () => { for await (const _ of scanMilvusRows({ query: async () => ({ status: { error_code: "UnexpectedError" } }) }, "test")) {} })()).rejects.toThrow();
  });
});

describe("MilvusStore.upsert UTF-8 limits", () => {
  async function writeRow(row: VectorRow): Promise<Record<string, any>> {
    const store = new MilvusStore({ address: "127.0.0.1:19530" }, null, "bulk_reindex");
    const written: Record<string, any>[] = [];
    (store as any).getClient = async () => ({
      upsert: async ({ data }: { data: Record<string, any>[] }) => {
        written.push(...data);
        return { status: { error_code: "Success" } };
      },
    });
    (store as any).ensureCollection = async () => {};
    await store.upsert("embeddings_world_books", [row]);
    return written[0];
  }

  test.each([
    ["ASCII", "x".repeat(70_000)],
    ["CJK", "界".repeat(30_000)],
    ["emoji", "abc" + "💫".repeat(20_000)],
  ])("clips %s content at a complete UTF-8 code point", async (_label, content) => {
    const written = await writeRow(vectorRow({ content }));
    const suffix = "\n[content clipped]";
    expect(Buffer.byteLength(written.content, "utf8")).toBeLessThanOrEqual(65_535);
    expect(written.content.endsWith(suffix)).toBe(true);
    expect(written.content).not.toContain("\ufffd");
    expect(content.startsWith(written.content.slice(0, -suffix.length))).toBe(true);
  });

  test("preserves content and valid JSON metadata at the exact byte limit", async () => {
    const content = "界".repeat(21_845);
    const overhead = Buffer.byteLength(JSON.stringify({ note: "" }), "utf8");
    const metadata_json = JSON.stringify({ note: "x".repeat(65_535 - overhead) });
    const written = await writeRow(vectorRow({ content, metadata_json }));
    expect(written.content).toBe(content);
    expect(written.metadata_json).toBe(metadata_json);
    expect(JSON.parse(written.metadata_json)).toEqual(JSON.parse(metadata_json));
  });

  test("preserves multibyte JSON metadata within the byte limit", async () => {
    const metadata_json = JSON.stringify({ note: "界💫".repeat(9_000) });
    const written = await writeRow(vectorRow({ metadata_json }));
    expect(written.metadata_json).toBe(metadata_json);
  });

  test("rejects oversized metadata before connecting or writing earlier batches", async () => {
    const store = new MilvusStore({ address: "127.0.0.1:19530" }, null, "bulk_reindex");
    let connected = false;
    (store as any).getClient = async () => { connected = true; throw new Error("unexpected connection"); };
    const rows = Array.from({ length: 260 }, (_, index) => vectorRow({ id: `row-${index}` }));
    rows.push(vectorRow({ metadata_json: JSON.stringify({ note: "界".repeat(30_000) }) }));
    await expect(store.upsert("embeddings_world_books", rows)).rejects.toThrow("metadata_json exceeds the 65535-byte VARCHAR limit");
    expect(connected).toBe(false);
  });
});

describe("MilvusStore.health", () => {
  function setup() {
    const store = new MilvusStore({ address: "127.0.0.1:19530" }, null);
    store.capabilities = { ...store.capabilities, nativeLexical: true };
    const state = {
      exists: true,
      fields: [{ name: "vector", type_params: [{ key: "dim", value: "2" }] }, { name: "sparse" }],
      functions: [{ type: "BM25", input_field_names: ["content"], output_field_names: ["sparse"] }],
      indexes: ["vector", "sparse", "user_id", "source_type", "source_id", "owner_id", "chunk_index"].map((field_name) => ({
        field_name,
        index_name: `idx_${field_name}`,
        state: "Finished" as string | number,
        total_rows: "12",
        indexed_rows: "12",
        pending_index_rows: "0",
        index_state_fail_reason: "",
        params: [{ key: "index_type", value: field_name === "sparse" ? "SPARSE_INVERTED_INDEX" : "INVERTED" }],
      })),
      statistics: {} as Record<string, unknown>,
      indexError: false,
      indexStatus: "Success",
      schemaError: false,
      statisticsError: false,
    };
    (store as any).hasCollection = async () => state.exists;
    (store as any).countRows = async () => 12;
    (store as any).getClient = async () => ({
      describeCollection: async ({ cache }: { cache: boolean }) => {
        expect(cache).toBe(false);
        if (state.schemaError) throw new Error("schema unavailable");
        return { schema: { fields: state.fields, functions: state.functions } };
      },
      describeIndex: async () => {
        if (state.indexError) throw new Error("indexes unavailable");
        return { status: { error_code: state.indexStatus }, index_descriptions: state.indexes };
      },
      getCollectionStatistics: async () => {
        if (state.statisticsError) throw new Error("statistics unavailable");
        return { data: state.statistics };
      },
    });
    return { store, state };
  }

  test("uses actual index descriptions, including every required scalar field", async () => {
    const { store, state } = setup();
    state.indexes[0].state = 3;
    const health = await store.health("embeddings_world_books");
    expect(health).toMatchObject({ exists: true, rowCount: 12, dimension: 2, vectorIndexReady: true, scalarIndexReady: true, ftsIndexReady: true, unindexedRowEstimate: 0 });
    expect(health.indexes).toContainEqual({ name: "idx_sparse", type: "SPARSE_INVERTED_INDEX" });
    state.indexes = state.indexes.filter((index) => index.field_name !== "owner_id");
    expect((await store.health("embeddings_world_books")).scalarIndexReady).toBe(false);
  });

  test.each(["InProgress", "Unissued", "Failed", "IndexStateNone", "unknown"])("does not report a %s vector index ready", async (status) => {
    const { store, state } = setup();
    state.indexes[0].state = status;
    expect(await store.health("embeddings_world_books")).toMatchObject({ vectorIndexReady: false, unindexedRowEstimate: 12 });
  });

  test("unfinished row coverage prevents a Finished index from reporting ready", async () => {
    const { store, state } = setup();
    state.indexes[1].indexed_rows = "8";
    state.indexes[1].pending_index_rows = "4";
    expect(await store.health("embeddings_world_books")).toMatchObject({ vectorIndexReady: true, ftsIndexReady: false, unindexedRowEstimate: 12 });
  });

  test("a sparse field without its index or BM25 function is not lexical readiness", async () => {
    const { store, state } = setup();
    const functions = state.functions;
    state.functions = [];
    expect((await store.health("embeddings_world_books")).ftsIndexReady).toBe(false);
    state.functions = functions;
    state.indexes = state.indexes.filter((index) => index.field_name !== "sparse");
    expect((await store.health("embeddings_world_books")).ftsIndexReady).toBe(false);
  });

  test("reported schema backfill must finish before lexical readiness", async () => {
    const { store, state } = setup();
    state.statistics = { schema_version_consistent_segments: "1", schema_version_total_segments: "2" };
    expect((await store.health("embeddings_world_books")).ftsIndexReady).toBe(false);
    state.statistics.schema_version_consistent_segments = "2";
    expect((await store.health("embeddings_world_books")).ftsIndexReady).toBe(true);
    delete state.statistics.schema_version_consistent_segments;
    expect((await store.health("embeddings_world_books")).ftsIndexReady).toBe(false);
  });

  test.each(["indexError", "schemaError", "statisticsError"] as const)("fails closed on %s", async (key) => {
    const { store, state } = setup();
    state[key] = true;
    expect((await store.health("embeddings_world_books")).ftsIndexReady).toBe(false);
    if (key === "indexError") {
      expect(await store.health("embeddings_world_books")).toMatchObject({ vectorIndexReady: false, scalarIndexReady: false, indexes: [] });
    }
  });

  test("does not trust index data accompanying an error status", async () => {
    const { store, state } = setup();
    state.indexStatus = "UnexpectedError";
    expect(await store.health("embeddings_world_books")).toMatchObject({ vectorIndexReady: false, scalarIndexReady: false, ftsIndexReady: false });
  });

  test("returns empty health for a missing collection", async () => {
    const { store, state } = setup();
    state.exists = false;
    expect(await store.health("embeddings_world_books")).toMatchObject({ exists: false, vectorIndexReady: false, scalarIndexReady: false, ftsIndexReady: false });
  });
});

describe("MilvusStore.hybridSearch", () => {
  test("keeps RRF ordering but returns cosine similarity instead of the fused score", async () => {
    const store = new MilvusStore({ address: "127.0.0.1:19530" }, null);
    store.capabilities = { ...store.capabilities, nativeLexical: true };
    let hybridRequest: any = null;
    (store as any).getClient = async () => ({
      hybridSearch: async (request: any) => {
        hybridRequest = request;
        return {
          results: [
            {
              id: "row-identical",
              source_id: "entry-identical",
              content: "identical",
              metadata_json: "{}",
              score: 0.0325,
              vector: [2, 0],
            },
            {
              id: "row-orthogonal",
              source_id: "entry-orthogonal",
              content: "orthogonal",
              metadata_json: "{}",
              score: 0.032,
              vector: [0, 3],
            },
          ],
        };
      },
    });
    (store as any).hasCollection = async () => true;
    (store as any).hasSparseField = async () => true;
    (store as any).loadCollection = async () => {};

    const hits = await store.hybridSearch({
      collection: "embeddings_world_books",
      vector: [1, 0],
      queryText: "sword",
      filter: eq("user_id", "user-1"),
      limit: 2,
      withVector: false,
    });

    expect(hits.map((hit) => hit.source_id)).toEqual([
      "entry-identical",
      "entry-orthogonal",
    ]);
    expect(hits.map((hit) => hit.similarity)).toEqual([1, 0]);
    expect(hits.every((hit) => hit.similarity !== 0.0325 && hit.similarity !== 0.032)).toBe(true);
    expect(hits.every((hit) => hit.vector === null)).toBe(true);
    expect(hybridRequest.output_fields).toContain("vector");
  });

  test("retains calibrated vectors when requested", async () => {
    const store = new MilvusStore({ address: "127.0.0.1:19530" }, null);
    store.capabilities = { ...store.capabilities, nativeLexical: true };
    (store as any).getClient = async () => ({
      hybridSearch: async () => ({
        results: [{
          id: "row-1",
          source_id: "entry-1",
          content: "content",
          metadata_json: "{}",
          score: 0.032,
          vector: [1, 0],
        }],
      }),
    });
    (store as any).hasCollection = async () => true;
    (store as any).hasSparseField = async () => true;
    (store as any).loadCollection = async () => {};

    const hits = await store.hybridSearch({
      collection: "embeddings_world_books",
      vector: [1, 0],
      queryText: "sword",
      filter: eq("user_id", "user-1"),
      limit: 1,
      withVector: true,
    });

    expect(hits[0]?.similarity).toBe(1);
    expect(hits[0]?.vector).toEqual([1, 0]);
  });

  test("bounded dense fallback rescales missing vectors and leaves unresolved hits unknown", async () => {
    const store = new MilvusStore({ address: "127.0.0.1:19530" }, null);
    store.capabilities = { ...store.capabilities, nativeLexical: true };
    (store as any).getClient = async () => ({
      hybridSearch: async () => ({
        results: [
          { id: "row-missing", source_id: "entry-missing", content: "missing", metadata_json: "{}", score: 0.032 },
          { id: "row-invalid", source_id: "entry-invalid", content: "invalid", metadata_json: "{}", score: 0.031, vector: [1] },
        ],
      }),
    });
    (store as any).hasCollection = async () => true;
    (store as any).hasSparseField = async () => true;
    (store as any).loadCollection = async () => {};
    const rescoreOptions: HybridSearchOptions[] = [];
    (store as any).vectorSearch = async (options: HybridSearchOptions) => {
      rescoreOptions.push(options);
      return [{
        id: "row-missing",
        source_id: "entry-missing",
        content: "missing",
        metadata_json: "{}",
        similarity: 0.75,
        lexicalScore: null,
        vector: null,
      } satisfies VectorHit];
    };

    const hits = await store.hybridSearch({
      collection: "embeddings_world_books",
      vector: [1, 0],
      queryText: "sword",
      filter: eq("user_id", "user-1"),
      limit: 2,
      withVector: false,
    });

    expect(hits.map((hit) => hit.source_id)).toEqual(["entry-missing", "entry-invalid"]);
    expect(hits.map((hit) => hit.similarity)).toEqual([0.75, null]);
    expect(rescoreOptions[0]?.limit).toBe(2);
    expect(rescoreOptions[0]?.filter).toEqual({
      op: "and",
      clauses: [
        eq("user_id", "user-1"),
        { op: "in", field: "id", values: ["row-missing", "row-invalid"] },
      ],
    });
  });

  test("falls back to app-side fusion and bypasses native hybrid after a zero-row anomaly", async () => {
    const store = new MilvusStore({ address: "127.0.0.1:19530" }, null);
    store.capabilities = { ...store.capabilities, nativeLexical: true };

    let hybridCalls = 0;
    let vectorCalls = 0;
    let lexicalCalls = 0;

    const denseHit: VectorHit = {
      id: "dense-1",
      source_id: "entry-1",
      content: "dense",
      metadata_json: "{}",
      similarity: 0.92,
      lexicalScore: null,
      vector: null,
    };
    const lexicalHit: VectorHit = {
      id: "lex-1",
      source_id: "entry-1",
      content: "lexical",
      metadata_json: "{}",
      similarity: null,
      lexicalScore: 12,
      vector: null,
    };

    (store as any).getClient = async () => ({
      hybridSearch: async () => {
        hybridCalls += 1;
        return { results: [] };
      },
    });
    (store as any).hasCollection = async () => true;
    (store as any).hasSparseField = async () => true;
    (store as any).loadCollection = async () => {};
    (store as any).vectorSearch = async (_opts: HybridSearchOptions) => {
      vectorCalls += 1;
      return [denseHit];
    };
    (store as any).lexicalSearch = async (_opts: HybridSearchOptions) => {
      lexicalCalls += 1;
      return [lexicalHit];
    };

    const opts: HybridSearchOptions = {
      collection: "embeddings_world_books",
      vector: [0.1, 0.2, 0.3],
      queryText: "where is the sword",
      filter: eq("user_id", "user-1"),
      limit: 8,
      withVector: false,
    };

    const first = await store.hybridSearch(opts);
    expect(first).toHaveLength(1);
    expect(first[0]?.source_id).toBe("entry-1");
    expect(hybridCalls).toBe(1);
    expect(vectorCalls).toBe(1);
    expect(lexicalCalls).toBe(1);

    const second = await store.hybridSearch(opts);
    expect(second).toHaveLength(1);
    expect(hybridCalls).toBe(1);
    expect(vectorCalls).toBe(2);
    expect(lexicalCalls).toBe(2);
  });
});
