import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as settingsSvc from "./settings.service";
import * as secretsSvc from "./secrets.service";
import { embeddingCache, computeCacheKey } from "./embedding-cache";
import {
  EMBEDDING_ERROR_CODES,
  EMBEDDING_SETTINGS_KEY,
  EmbeddingError,
  areProfileDimensionsCompatible,
  cachedEmbedTexts,
  embedTexts,
  embeddingProfileSecretKey,
  getEmbeddingConfig,
  isUsableProfileId,
  selectFallbackChain,
  updateEmbeddingConfig,
} from "./embeddings.service";

const USER = "profile-user";
const PRIMARY_ID = "11111111-1111-4111-8111-111111111111";
const FALLBACK_ID = "22222222-2222-4222-8222-222222222222";
const INCOMPAT_ID = "33333333-3333-4333-8333-333333333333";
const UNKNOWN_ID = "44444444-4444-4444-8444-444444444444";

const settings = new Map<string, unknown>();
const secrets = new Map<string, string>();
const spies: Array<{ mockRestore(): void }> = [];

function sk(userId: string, key: string): string {
  return `${userId}::${key}`;
}

function putCfg(value: unknown): void {
  settings.set(sk(USER, EMBEDDING_SETTINGS_KEY), value);
}

function openaiBody(dims = 2): { data: Array<{ embedding: number[] }> } {
  return { data: [{ embedding: Array.from({ length: dims }, (_, i) => i + 0.25) }] };
}

function enabledProfiles(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    provider: "openai-compatible",
    api_url: "https://primary.test/v1/embeddings",
    model: "text-embedding-3-small",
    dimensions: 2,
    send_dimensions: false,
    request_timeout: 30,
    connectionProfiles: [
      {
        id: PRIMARY_ID,
        provider: "openai-compatible",
        model: "text-embedding-3-small",
        api_url: "https://primary.test/v1/embeddings",
        dimensions: 2,
        enabled: true,
      },
      {
        id: FALLBACK_ID,
        provider: "openai-compatible",
        model: "text-embedding-3-small",
        api_url: "https://fallback.test/v1/embeddings",
        dimensions: 2,
        enabled: true,
      },
    ],
    primaryProfileId: PRIMARY_ID,
    fallbackProfileIds: [FALLBACK_ID],
    ...overrides,
  };
}

beforeEach(() => {
  settings.clear();
  secrets.clear();
  embeddingCache.clear();
  spies.push(
    spyOn(settingsSvc, "getSetting").mockImplementation((userId: string, key: string) => {
      const value = settings.get(sk(userId, key));
      return value === undefined ? null : { key, value, updated_at: 0 };
    }),
    spyOn(settingsSvc, "putSetting").mockImplementation((userId: string, key: string, value: unknown) => {
      settings.set(sk(userId, key), value);
      return { key, value, updated_at: 0 };
    }),
    spyOn(secretsSvc, "getSecret").mockImplementation(async (userId: string, key: string) => {
      return secrets.get(sk(userId, key)) ?? null;
    }),
    spyOn(secretsSvc, "getSecretForStatus").mockImplementation(async (userId: string, key: string) => {
      return secrets.get(sk(userId, key)) ?? null;
    }),
    spyOn(secretsSvc, "putSecret").mockImplementation(async (userId: string, key: string, value: string) => {
      secrets.set(sk(userId, key), value);
    }),
    spyOn(secretsSvc, "deleteSecret").mockImplementation((userId: string, key: string) => {
      return secrets.delete(sk(userId, key));
    }),
  );
});

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
  embeddingCache.clear();
});

describe("embedding connection profiles", () => {
  test("migrates old single-provider config into a UUID profile, not a literal default id", async () => {
    putCfg({
      enabled: true,
      provider: "openai",
      api_url: "https://api.openai.com/v1/embeddings",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });

    const cfg = await getEmbeddingConfig(USER);
    expect(cfg.connectionProfiles).toHaveLength(1);
    const profile = cfg.connectionProfiles[0];
    expect(isUsableProfileId(profile.id)).toBe(true);
    expect(profile.id).not.toBe("default");
    expect(profile.provider).toBe("openai");
    expect(profile.model).toBe("text-embedding-3-small");
    expect(profile.dimensions).toBe(1536);
    expect(cfg.primaryProfileId).toBe(profile.id);
    expect(cfg.fallbackProfileIds).toEqual([]);

    const stored = settings.get(sk(USER, EMBEDDING_SETTINGS_KEY)) as { connectionProfiles?: Array<{ id: string }> };
    expect(stored.connectionProfiles?.[0]?.id).toBe(profile.id);
  });

  test("preserves unknown provider ids and Vertex project/region controls", async () => {
    putCfg({
      enabled: true,
      provider: "future-vendor",
      api_url: "https://future.example/v1/embeddings",
      model: "embed-x",
      dimensions: 1024,
    });
    const updated = await updateEmbeddingConfig(USER, {
      enabled: true,
      connectionProfiles: [
        {
          id: UNKNOWN_ID,
          provider: "future-vendor",
          model: "embed-x",
          api_url: "https://future.example/v1/embeddings",
          dimensions: 1024,
          enabled: true,
        },
        {
          id: PRIMARY_ID,
          provider: "google_vertex",
          model: "text-embedding-004",
          api_url: "https://aiplatform.googleapis.com",
          dimensions: 768,
          enabled: true,
          vertex_region: "us-central1",
          vertex_project: "lumiverse-proj",
        },
      ],
      primaryProfileId: UNKNOWN_ID,
      fallbackProfileIds: [PRIMARY_ID],
    });

    expect(updated.connectionProfiles[0].provider).toBe("future-vendor");
    const vertex = updated.connectionProfiles.find((p) => p.id === PRIMARY_ID);
    expect(vertex?.vertex_region).toBe("us-central1");
    expect(vertex?.vertex_project).toBe("lumiverse-proj");
    expect(JSON.stringify(updated)).not.toContain("embedding-profile/");
    expect((updated as { secretRef?: unknown }).secretRef).toBeUndefined();
  });

  test("DTO exposes hasSecret and never leaks secret refs or values", async () => {
    const secret = "sk-super-secret-value";
    secrets.set(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)), secret);
    putCfg(enabledProfiles());

    const cfg = await getEmbeddingConfig(USER);
    const serialized = JSON.stringify(cfg);
    expect(cfg.connectionProfiles[0].hasSecret).toBe(true);
    expect(cfg.has_api_key).toBe(true);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("embedding-profile/");
    expect(serialized).not.toContain(embeddingProfileSecretKey(PRIMARY_ID));
  });

  test("selectFallbackChain skips dimension-incompatible fallbacks", () => {
    const chain = selectFallbackChain({
      connectionProfiles: [
        { id: PRIMARY_ID, provider: "openai", model: "a", api_url: "https://a", dimensions: 1536, enabled: true },
        { id: INCOMPAT_ID, provider: "openai", model: "b", api_url: "https://b", dimensions: 768, enabled: true },
        { id: FALLBACK_ID, provider: "openai", model: "c", api_url: "https://c", dimensions: 1536, enabled: true },
      ],
      primaryProfileId: PRIMARY_ID,
      fallbackProfileIds: [INCOMPAT_ID, FALLBACK_ID],
    });
    expect(chain.map((p) => p.id)).toEqual([PRIMARY_ID, FALLBACK_ID]);
    expect(areProfileDimensionsCompatible({ dimensions: 1536 }, { dimensions: 768 })).toBe(false);
  });

  test("falls back when primary is unavailable and reports embedding_fallback_exhausted", async () => {
    putCfg(enabledProfiles());
    secrets.set(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)), "primary-key");
    secrets.set(sk(USER, embeddingProfileSecretKey(FALLBACK_ID)), "fallback-key");

    const urls: string[] = [];
    spies.push(spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("primary.test")) {
        return new Response("primary down", { status: 503 });
      }
      return new Response("fallback down", { status: 503 });
    }));

    try {
      await embedTexts(USER, ["hello"]);
      throw new Error("expected embedTexts to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(EmbeddingError);
      expect((err as EmbeddingError).code).toBe(EMBEDDING_ERROR_CODES.FALLBACK_EXHAUSTED);
      expect((err as Error).message).not.toContain("embedding-profile/");
    }
    expect(urls.some((url) => url.includes("primary.test"))).toBe(true);
    expect(urls.some((url) => url.includes("fallback.test"))).toBe(true);
  });

  test("reports embedding_provider_unavailable when the only profile cannot run", async () => {
    putCfg(enabledProfiles({
      connectionProfiles: [{
        id: PRIMARY_ID,
        provider: "future-vendor",
        model: "x",
        api_url: "https://primary.test/v1/embeddings",
        dimensions: 2,
        enabled: true,
      }],
      fallbackProfileIds: [],
    }));
    secrets.set(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)), "primary-key");

    try {
      await embedTexts(USER, ["hello"]);
      throw new Error("expected embedTexts to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(EmbeddingError);
      expect((err as EmbeddingError).code).toBe(EMBEDDING_ERROR_CODES.PROVIDER_UNAVAILABLE);
    }
  });

  test("caller aborts primary without starting fallback", async () => {
    putCfg(enabledProfiles());
    secrets.set(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)), "primary-key");
    secrets.set(sk(USER, embeddingProfileSecretKey(FALLBACK_ID)), "fallback-key");

    const controller = new AbortController();
    const urls: string[] = [];
    let releasePrimary: ((err: Error) => void) | undefined;
    spies.push(spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
        init?.signal?.addEventListener("abort", onAbort, { once: true });
        if (url.includes("primary.test")) {
          releasePrimary = onAbort;
        }
      });
    }));

    const pending = embedTexts(USER, ["hello"], { signal: controller.signal });
    await Bun.sleep(10);
    controller.abort();
    try {
      await pending;
      throw new Error("expected abort");
    } catch (err) {
      expect(isEmbeddingAbort(err)).toBe(true);
    }
    releasePrimary?.(new DOMException("Aborted", "AbortError"));
    expect(urls.some((url) => url.includes("primary.test"))).toBe(true);
    expect(urls.some((url) => url.includes("fallback.test"))).toBe(false);
  });

  test("caller abort leaves no partial cache or write and returns stable cancellation", async () => {
    putCfg(enabledProfiles());
    secrets.set(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)), "primary-key");
    secrets.set(sk(USER, embeddingProfileSecretKey(FALLBACK_ID)), "fallback-key");

    const controller = new AbortController();
    spies.push(spyOn(globalThis, "fetch").mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    }));

    const pending = cachedEmbedTexts(USER, ["cache-me"], { signal: controller.signal });
    await Bun.sleep(10);
    controller.abort();
    try {
      await pending;
      throw new Error("expected abort");
    } catch (err) {
      expect(isEmbeddingAbort(err)).toBe(true);
      expect((err as { name?: string }).name).toBe("AbortError");
    }

    const fp = { provider: "openai-compatible", model: "text-embedding-3-small", dimensions: 2, api_url: "https://primary.test/v1/embeddings" };
    expect(embeddingCache.get(computeCacheKey("cache-me", fp))).toBeNull();
  });

  test("resolves the opaque secret only at embedding driver invocation", async () => {
    putCfg(enabledProfiles());
    secrets.set(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)), "primary-key");
    secrets.set(sk(USER, embeddingProfileSecretKey(FALLBACK_ID)), "fallback-key");

    const secretReads: string[] = [];
    const statusReads: string[] = [];
    spies[2]?.mockRestore();
    spies[3]?.mockRestore();
    spies[2] = spyOn(secretsSvc, "getSecret").mockImplementation(async (userId: string, key: string) => {
      secretReads.push(key);
      return secrets.get(sk(userId, key)) ?? null;
    });
    spies[3] = spyOn(secretsSvc, "getSecretForStatus").mockImplementation(async (userId: string, key: string) => {
      statusReads.push(key);
      return secrets.get(sk(userId, key)) ?? null;
    });

    await getEmbeddingConfig(USER);
    expect(secretReads).toEqual([]);
    expect(statusReads.length).toBeGreaterThan(0);

    spies.push(spyOn(globalThis, "fetch").mockImplementation(async () => {
      expect(secretReads).toContain(embeddingProfileSecretKey(PRIMARY_ID));
      return new Response(JSON.stringify(openaiBody()), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    await embedTexts(USER, ["hello"]);
    expect(secretReads).toEqual([embeddingProfileSecretKey(PRIMARY_ID)]);
    expect(secretReads).not.toContain(embeddingProfileSecretKey(FALLBACK_ID));
  });

  test("redacts secret values and refs from provider errors", async () => {
    const secret = "sk-leak-me-now";
    putCfg(enabledProfiles({ fallbackProfileIds: [] }));
    secrets.set(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)), secret);

    spies.push(spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        `denied Bearer ${secret} at embedding-profile/${PRIMARY_ID}/apiKey`,
        { status: 401 },
      );
    }));

    try {
      await embedTexts(USER, ["hello"]);
      throw new Error("expected failure");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(secret);
      expect(message).not.toContain("embedding-profile/");
      expect(message).toContain("[redacted]");
    }
  });

  test("uses fallback when primary fails and dimensions match", async () => {
    putCfg(enabledProfiles());
    secrets.set(sk(USER, embeddingProfileSecretKey(PRIMARY_ID)), "primary-key");
    secrets.set(sk(USER, embeddingProfileSecretKey(FALLBACK_ID)), "fallback-key");

    spies.push(spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("primary.test")) return new Response("nope", { status: 500 });
      return new Response(JSON.stringify(openaiBody()), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    const vectors = await embedTexts(USER, ["hello"]);
    expect(vectors[0]?.length).toBe(2);
  });
});

function isEmbeddingAbort(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "AbortError" || /abort/i.test((err as { message?: string }).message || "");
}
