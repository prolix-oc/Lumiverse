import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";

mock.module("../auth/index", () => ({ auth: { api: {} } }));

const PRIMARY_ID = "11111111-1111-4111-8111-111111111111";
const FALLBACK_ID = "22222222-2222-4222-8222-222222222222";

const configDto = {
  enabled: true,
  provider: "openai-compatible" as const,
  api_url: "https://primary.test/v1/embeddings",
  model: "text-embedding-3-small",
  dimensions: 1536,
  send_dimensions: false,
  retrieval_top_k: 4,
  hybrid_weight_mode: "balanced" as const,
  preferred_context_size: 6,
  batch_size: 50,
  similarity_threshold: 0,
  rerank_cutoff: 0,
  vectorize_world_books: true,
  vectorize_chat_messages: false,
  vectorize_chat_documents: true,
  chat_memory_mode: "balanced" as const,
  request_timeout: 120,
  has_api_key: true,
  connectionProfiles: [
    {
      id: PRIMARY_ID,
      provider: "openai-compatible",
      model: "text-embedding-3-small",
      api_url: "https://primary.test/v1/embeddings",
      dimensions: 1536,
      enabled: true,
      hasSecret: true,
    },
    {
      id: FALLBACK_ID,
      provider: "openai-compatible",
      model: "text-embedding-3-small",
      api_url: "https://fallback.test/v1/embeddings",
      dimensions: 1536,
      enabled: true,
      hasSecret: false,
    },
  ],
  primaryProfileId: PRIMARY_ID,
  fallbackProfileIds: [FALLBACK_ID],
};

const { embeddingsRoutes } = await import("./embeddings.routes");
const embeddingsSvc = await import("../services/embeddings.service");

const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
});

function app() {
  const instance = new Hono();
  instance.use("*", async (c, next) => {
    c.set("userId", "owner-id");
    return next();
  });
  instance.route("/", embeddingsRoutes);
  return instance;
}

describe("embeddings routes connection profiles", () => {
  test("GET /config returns dedicated profiles with hasSecret and no secret refs", async () => {
    spies.push(spyOn(embeddingsSvc, "getEmbeddingConfig").mockResolvedValue(structuredClone(configDto) as any));
    const response = await app().request("/config");
    expect(response.status).toBe(200);
    const body = await response.json() as typeof configDto;
    expect(body.connectionProfiles).toHaveLength(2);
    expect(body.primaryProfileId).toBe(PRIMARY_ID);
    expect(body.fallbackProfileIds).toEqual([FALLBACK_ID]);
    expect(body.connectionProfiles[0].hasSecret).toBe(true);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("embedding-profile/");
    expect(serialized).not.toContain("apiKey");
  });

  test("PUT /config forwards connectionProfiles and primary/fallback ids", async () => {
    const update = spyOn(embeddingsSvc, "updateEmbeddingConfig").mockImplementation(async (_userId, body) => ({
      ...structuredClone(configDto),
      ...body,
      connectionProfiles: configDto.connectionProfiles,
    }) as any);
    spies.push(update);

    const payload = {
      enabled: true,
      connectionProfiles: configDto.connectionProfiles,
      primaryProfileId: PRIMARY_ID,
      fallbackProfileIds: [FALLBACK_ID],
    };
    const response = await app().request("/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalled();
    const forwarded = update.mock.calls.at(-1)?.[1] as typeof payload;
    expect(forwarded.primaryProfileId).toBe(PRIMARY_ID);
    expect(forwarded.fallbackProfileIds).toEqual([FALLBACK_ID]);
    expect(JSON.stringify(forwarded)).not.toContain("embedding-profile/");
  });

  test("POST /test returns embedding_fallback_exhausted", async () => {
    spies.push(
      spyOn(embeddingsSvc, "getEmbeddingConfig").mockResolvedValue(structuredClone(configDto) as any),
      spyOn(embeddingsSvc, "testEmbeddingConfig").mockRejectedValue(
        Object.assign(new Error("All embedding providers failed"), {
          code: embeddingsSvc.EMBEDDING_ERROR_CODES.FALLBACK_EXHAUSTED,
        }),
      ),
    );
    const response = await app().request("/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ping" }),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "All embedding providers failed",
      code: "embedding_fallback_exhausted",
    });
  });

  test("POST /test returns embedding_provider_unavailable", async () => {
    spies.push(
      spyOn(embeddingsSvc, "getEmbeddingConfig").mockResolvedValue(structuredClone(configDto) as any),
      spyOn(embeddingsSvc, "testEmbeddingConfig").mockRejectedValue(
        Object.assign(new Error("Embedding provider is unavailable"), {
          code: embeddingsSvc.EMBEDDING_ERROR_CODES.PROVIDER_UNAVAILABLE,
        }),
      ),
    );
    const response = await app().request("/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ping" }),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Embedding provider is unavailable",
      code: "embedding_provider_unavailable",
    });
  });
});
