import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as settingsSvc from "../services/settings.service";
import * as secretsSvc from "../services/secrets.service";
import * as googleVertex from "../llm/providers/google-vertex";
import { embeddingCache } from "../services/embedding-cache";
import {
  EMBEDDING_SETTINGS_KEY,
  cachedEmbedTexts,
  embedTextsWithConnection,
  embeddingProfileSecretKey,
} from "../services/embeddings.service";
import { WorkerHostEmbeddingsApi } from "./worker-host-embeddings-api";

const USER = "embed-user";
const PRIMARY_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";
const settings = new Map<string, unknown>();
const secrets = new Map<string, string>();
const spies: Array<{ mockRestore(): void }> = [];
const sent: Array<{ url: string; body: any; auth: string | null }> = [];
let respond: (body: any, url: string) => Response;

function config(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    provider: "openai-compatible",
    api_url: "https://primary.test/v1/embeddings",
    model: "primary-model",
    dimensions: 3,
    batch_size: 2,
    connectionProfiles: [
      { id: PRIMARY_ID, name: "Primary", provider: "openai-compatible", model: "primary-model", api_url: "https://primary.test/v1/embeddings", dimensions: 3, enabled: true },
      { id: SECOND_ID, name: "Local", provider: "openai-compatible", model: "local-model", api_url: "http://127.0.0.1:9/v1/embeddings", dimensions: null, enabled: true },
    ],
    primaryProfileId: PRIMARY_ID,
    fallbackProfileIds: [SECOND_ID],
    ...overrides,
  };
}

function vectorsFor(body: any, size = 3) {
  return { data: body.input.map((text: string) => ({ embedding: Array.from({ length: size }, (_, i) => text.length + i) })) };
}

beforeEach(() => {
  settings.clear();
  secrets.clear();
  sent.length = 0;
  embeddingCache.clear();
  settings.set(`${USER}::${EMBEDDING_SETTINGS_KEY}`, config());
  secrets.set(`${USER}::${embeddingProfileSecretKey(PRIMARY_ID)}`, "primary-secret");
  secrets.set(`${USER}::${embeddingProfileSecretKey(SECOND_ID)}`, "local-secret");
  respond = (body) => Response.json(vectorsFor(body));
  spies.push(
    spyOn(settingsSvc, "getSetting").mockImplementation((userId: string, key: string) => {
      const value = settings.get(`${userId}::${key}`);
      return value === undefined ? null : { key, value, updated_at: 0 };
    }),
    spyOn(settingsSvc, "putSetting").mockImplementation((userId: string, key: string, value: unknown) => {
      settings.set(`${userId}::${key}`, value);
      return { key, value, updated_at: 0 };
    }),
    spyOn(secretsSvc, "getSecret").mockImplementation(async (userId: string, key: string) => secrets.get(`${userId}::${key}`) ?? null),
    spyOn(secretsSvc, "getSecretForStatus").mockImplementation(async (userId: string, key: string) => secrets.get(`${userId}::${key}`) ?? null),
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const url = String(input);
      sent.push({ url, body, auth: new Headers(init?.headers).get("authorization") });
      return respond(body, url);
    }, { preconnect() {} }) as typeof fetch),
  );
});

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
  embeddingCache.clear();
});

function hostApi(granted = true) {
  const responses: Array<{ requestId: string; result?: any; error?: string }> = [];
  const api = new WorkerHostEmbeddingsApi({
    hasPermission: () => granted,
    resolveEffectiveUserId: (userId) => userId || USER,
    enforceScopedUser: (userId) => { if (userId !== USER) throw new Error("Account scope denied"); },
    postResponse: (response) => { responses.push(response); },
  });
  return { api, responses };
}

describe("embedTextsWithConnection", () => {
  test("uses only the primary connection by default and reports it", async () => {
    const result = await embedTextsWithConnection(USER, ["Open settings", "Switch persona", "Close"]);
    expect(result).toEqual({
      embeddings: [[13, 14, 15], [14, 15, 16], [5, 6, 7]],
      connection_id: PRIMARY_ID,
      model: "primary-model",
      dimensions: 3,
    });
    // batch_size 2 -> two provider requests, both to the primary connection
    expect(sent.map((request) => [request.url, request.body.input.length])).toEqual([
      ["https://primary.test/v1/embeddings", 2],
      ["https://primary.test/v1/embeddings", 1],
    ]);
    expect(sent[0]!.auth).toBe("Bearer primary-secret");
  });

  test("never falls back to another connection", async () => {
    respond = (body, url) => url.includes("primary") ? new Response("down", { status: 503 }) : Response.json(vectorsFor(body));
    await expect(embedTextsWithConnection(USER, ["Open settings"])).rejects.toThrow("Embedding request failed (503)");
    expect(sent).toHaveLength(1);
  });

  test.each([{ texts: ["label"] }, { texts: ["label", "other label"] }])("does not mislabel cached host fallback vectors for %j", async ({ texts }) => {
    respond = (body, url) => url.includes("primary") ? new Response("down", { status: 503 }) : Response.json(vectorsFor(body));
    await cachedEmbedTexts(USER, [...texts]);
    expect(sent).toHaveLength(2);
    await expect(embedTextsWithConnection(USER, [...texts])).rejects.toThrow("Embedding request failed (503)");
    expect(sent).toHaveLength(3);
  });

  test("uses the requested connection", async () => {
    respond = (body) => Response.json(vectorsFor(body, 5));
    const result = await embedTextsWithConnection(USER, ["hello"], { connectionId: SECOND_ID });
    expect(result.connection_id).toBe(SECOND_ID);
    expect(result.model).toBe("local-model");
    expect(result.dimensions).toBe(5);
    expect(sent[0]!.url).toBe("http://127.0.0.1:9/v1/embeddings");
    expect(sent[0]!.body.model).toBe("local-model");
  });

  test("preserves the selected connection's native dimensions", async () => {
    settings.set(`${USER}::${EMBEDDING_SETTINGS_KEY}`, config({ send_dimensions: true }));
    respond = (body) => Response.json(vectorsFor(body, body.dimensions ?? 5));
    const result = await embedTextsWithConnection(USER, ["hello"], { connectionId: SECOND_ID });
    expect(sent[0]!.body).not.toHaveProperty("dimensions");
    expect(result.dimensions).toBe(5);
  });

  test("uses the selected Vertex connection's project and region defaults", async () => {
    settings.set(`${USER}::${EMBEDDING_SETTINGS_KEY}`, config({
      connectionProfiles: config().connectionProfiles.map((profile) => ({
        ...profile,
        provider: "google_vertex",
        model: "gemini-embedding-001",
        ...(profile.id === PRIMARY_ID ? { vertex_project: "primary-project", vertex_region: "us-central1" } : {}),
      })),
    }));
    secrets.set(`${USER}::${embeddingProfileSecretKey(SECOND_ID)}`, JSON.stringify({
      project_id: "secondary-project", client_email: "secondary@example.test", private_key: "test-key",
    }));
    spies.push(spyOn(googleVertex, "getAccessToken").mockResolvedValue("vertex-token"));
    respond = () => Response.json({ predictions: [{ embeddings: { values: [1, 2, 3] } }] });
    await embedTextsWithConnection(USER, ["hello"], { connectionId: SECOND_ID });
    expect(sent[0]!.url).toContain("/projects/secondary-project/locations/global/");
  });

  test.each([
    { vectors: ["not a vector"] },
    { vectors: [[1, "bad", 3]] },
    { vectors: [[1, null, 3]] },
    { vectors: [[]] },
    { vectors: [[1, 2], [1, 2, 3]] },
  ])("rejects invalid provider vectors without caching them: %j", async ({ vectors }) => {
    const texts = vectors.map((_, index) => `label ${index}`);
    respond = () => Response.json({ data: vectors.map((embedding) => ({ embedding })) });
    await expect(embedTextsWithConnection(USER, texts)).rejects.toThrow("Embedding provider returned invalid vectors");
    expect(embeddingCache.size).toBe(0);
    respond = (body) => Response.json(vectorsFor(body));
    expect((await embedTextsWithConnection(USER, texts)).embeddings).toHaveLength(texts.length);
    expect(sent).toHaveLength(2);
  });

  test("does not cache earlier batches when later vectors have different dimensions", async () => {
    respond = (body) => Response.json(vectorsFor(body, body.input.includes("last") ? 5 : 3));
    await expect(embedTextsWithConnection(USER, ["first", "second", "last"])).rejects.toThrow("Embedding provider returned invalid vectors");
    expect(sent).toHaveLength(2);
    expect(embeddingCache.size).toBe(0);
  });

  test("scopes cached vectors to their connection and keeps queries apart", async () => {
    await cachedEmbedTexts(USER, ["shared label", "other label"]);
    expect(sent).toHaveLength(1);
    const passage = await embedTextsWithConnection(USER, ["shared label", "other label"]);
    expect(sent).toHaveLength(2);
    expect(passage.embeddings).toEqual([[12, 13, 14], [11, 12, 13]]);
    await embedTextsWithConnection(USER, ["shared label", "other label"]);
    expect(sent).toHaveLength(2);
    await embedTextsWithConnection(USER, ["shared label"], { inputType: "query" });
    expect(sent).toHaveLength(3);
    await embedTextsWithConnection(USER, ["shared label"], { inputType: "query" });
    expect(sent).toHaveLength(3);
  });

  test("rejects bad input before any provider call", async () => {
    const cases: Array<[string[], Parameters<typeof embedTextsWithConnection>[2], string]> = [
      [[], {}, "texts must be a non-empty array"],
      [Array.from({ length: 257 }, (_, i) => `t${i}`), {}, "At most 256 texts"],
      [["ok", "  "], {}, "Each text must be a non-empty string"],
      [["x".repeat(8193)], {}, "at most 8192 characters"],
      [["ok"], { inputType: "document" as any }, 'input_type must be "query" or "passage"'],
      [["ok"], { connectionId: "missing" }, "Embedding connection not found"],
    ];
    for (const [texts, options, message] of cases) {
      await expect(embedTextsWithConnection(USER, texts, options)).rejects.toThrow(message);
    }
    settings.set(`${USER}::${EMBEDDING_SETTINGS_KEY}`, config({ enabled: false }));
    await expect(embedTextsWithConnection(USER, ["ok"])).rejects.toThrow("Embeddings are disabled for this user");
    settings.set(`${USER}::${EMBEDDING_SETTINGS_KEY}`, config({
      connectionProfiles: config().connectionProfiles.map((profile) => profile.id === SECOND_ID ? { ...profile, enabled: false } : profile),
    }));
    await expect(embedTextsWithConnection(USER, ["ok"], { connectionId: SECOND_ID })).rejects.toThrow("Embedding connection is disabled");
    expect(sent).toHaveLength(0);
  });

  test("redacts the API key from provider errors", async () => {
    respond = () => new Response("invalid key primary-secret", { status: 401 });
    const message = await embedTextsWithConnection(USER, ["ok"]).then(() => "", (err: Error) => err.message);
    expect(message).toContain("401");
    expect(message).not.toContain("primary-secret");
  });
});

describe("WorkerHostEmbeddingsApi", () => {
  test("lists connections without URLs or secrets", async () => {
    const { api, responses } = hostApi();
    await api.handle({ type: "embeddings_connections_list", requestId: "list" });
    expect(responses).toEqual([{ type: "response", requestId: "list", result: [
      { id: PRIMARY_ID, name: "Primary", provider: "openai-compatible", model: "primary-model", dimensions: 3, enabled: true, is_primary: true, has_api_key: true },
      { id: SECOND_ID, name: "Local", provider: "openai-compatible", model: "local-model", dimensions: null, enabled: true, is_primary: false, has_api_key: true },
    ] }] as any);
  });

  test("embeds, and checks the permission and account scope", async () => {
    const { api, responses } = hostApi();
    await api.handle({ type: "embeddings_embed", requestId: "ok", input: { texts: ["hi"], input_type: "query" } });
    await api.handle({ type: "embeddings_embed", requestId: "scope", input: { texts: ["hi"], userId: "mallory" } });
    const denied = hostApi(false);
    await denied.api.handle({ type: "embeddings_embed", requestId: "denied", input: { texts: ["hi"] } });
    expect(responses[0]).toEqual({ type: "response", requestId: "ok", result: { embeddings: [[2, 3, 4]], connection_id: PRIMARY_ID, model: "primary-model", dimensions: 3 } } as any);
    expect(responses[1]!.error).toBe("Account scope denied");
    expect(denied.responses[0]!.error).toStartWith("PERMISSION_DENIED: embeddings");
    expect(sent).toHaveLength(1);
  });

  test("cancels an in-flight request", async () => {
    respond = () => { throw new Error("unreachable"); };
    spies.push(spyOn(globalThis, "fetch").mockImplementation(Object.assign((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }), { preconnect() {} }) as typeof fetch));
    const { api, responses } = hostApi();
    const pending = api.handle({ type: "embeddings_embed", requestId: "slow", input: { texts: ["hi"] } });
    await Bun.sleep(10);
    await api.handle({ type: "embeddings_cancel", requestId: "slow" });
    await pending;
    expect(responses).toEqual([{ type: "response", requestId: "slow", error: "AbortError: Embeddings request cancelled" }] as any);
  });

  test("cancels a cached request before its response is posted", async () => {
    await embedTextsWithConnection(USER, ["hi"]);
    const { api, responses } = hostApi();
    const pending = api.handle({ type: "embeddings_embed", requestId: "cached", input: { texts: ["hi"] } });
    await api.handle({ type: "embeddings_cancel", requestId: "cached" });
    await pending;
    expect(responses).toEqual([{ type: "response", requestId: "cached", error: "AbortError: Embeddings request cancelled" }] as any);
    expect(sent).toHaveLength(1);
  });
});
