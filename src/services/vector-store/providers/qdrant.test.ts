import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { VectorRow } from "../types";
import { QdrantStore } from "./qdrant";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function row(index: number): VectorRow {
  return {
    id: `row-${index}`,
    user_id: "user",
    source_type: "world_book_entry",
    source_id: `entry-${index}`,
    owner_id: "book",
    chunk_index: 0,
    content: `content-${index}`,
    vector: [1, 0],
    metadata_json: "{}",
    updated_at: 1,
  };
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("QdrantStore.upsert", () => {
  test("waits for completion in balanced and bulk profiles across every batch", async () => {
    const pointUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "GET" && url.includes("/collections/lumiverse_embeddings_world_books")) {
        return jsonResponse({ result: { config: { params: { vectors: { size: 2 } } } } });
      }
      if (init?.method === "PUT" && url.includes("/points?")) {
        pointUrls.push(url);
        return jsonResponse({ result: { status: "completed" }, status: "ok" });
      }
      return jsonResponse({ result: {}, status: "ok" });
    }) as typeof fetch;

    for (const profile of ["balanced", "bulk_reindex"] as const) {
      const store = new QdrantStore({ url: "http://qdrant" }, null, profile);
      await store.upsert("embeddings_world_books", Array.from({ length: 129 }, (_, index) => row(index)));
    }

    expect(pointUrls).toHaveLength(4);
    expect(pointUrls.every((url) => url.endsWith("/points?wait=true"))).toBe(true);
  });

  test("rejects an acknowledged response even when HTTP succeeds", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "GET") {
        return jsonResponse({ result: { config: { params: { vectors: { size: 2 } } } } });
      }
      if (url.includes("/points?")) {
        return jsonResponse({ result: { status: "acknowledged" }, status: "ok" });
      }
      return jsonResponse({ result: {}, status: "ok" });
    }) as typeof fetch;

    const store = new QdrantStore({ url: "http://qdrant" }, null, "bulk_reindex");
    await expect(store.upsert("embeddings_world_books", [row(1)]))
      .rejects.toThrow("status=acknowledged");
  });

  test("propagates a failed completed write request", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "GET") {
        return jsonResponse({ result: { config: { params: { vectors: { size: 2 } } } } });
      }
      if (url.includes("/points?")) return new Response("write failed", { status: 500 });
      return jsonResponse({ result: {}, status: "ok" });
    }) as typeof fetch;

    const store = new QdrantStore({ url: "http://qdrant" }, null, "bulk_reindex");
    await expect(store.upsert("embeddings_world_books", [row(1)]))
      .rejects.toThrow("Qdrant request failed");
  });
});
