import { describe, expect, it } from "bun:test";
import {
  defaultVectorStoreConfig,
  hasSameVectorStoreCredentialTarget,
  normalizeVectorStoreConfig,
} from "./vector-store-config.service";

describe("normalizeVectorStoreConfig", () => {
  it("defaults to lancedb for missing/invalid providers", () => {
    expect(defaultVectorStoreConfig()).toEqual({ provider: "lancedb" });
    expect(normalizeVectorStoreConfig(undefined)).toEqual({ provider: "lancedb" });
    expect(normalizeVectorStoreConfig({})).toEqual({ provider: "lancedb" });
    expect(normalizeVectorStoreConfig({ provider: "weaviate" })).toEqual({ provider: "lancedb" });
  });

  it("accepts the three valid providers", () => {
    expect(normalizeVectorStoreConfig({ provider: "qdrant" }).provider).toBe("qdrant");
    expect(normalizeVectorStoreConfig({ provider: "milvus" }).provider).toBe("milvus");
    expect(normalizeVectorStoreConfig({ provider: "lancedb" }).provider).toBe("lancedb");
  });

  it("normalizes tuning profiles", () => {
    expect(normalizeVectorStoreConfig({ provider: "qdrant", tuningProfile: "low_latency" }).tuningProfile).toBe("low_latency");
    expect(normalizeVectorStoreConfig({ provider: "qdrant", tuningProfile: "turbo" }).tuningProfile).toBeUndefined();
  });

  it("normalizes a qdrant connection and strips trailing slashes", () => {
    const cfg = normalizeVectorStoreConfig({
      provider: "qdrant",
      qdrant: { url: "https://q.example:6333///", https: true, collectionPrefix: "lv_" },
    });
    expect(cfg.qdrant).toEqual({
      url: "https://q.example:6333",
      https: true,
      collectionPrefix: "lv_",
      checkCompatibility: undefined,
    });
  });

  it("drops a qdrant block with no url", () => {
    expect(normalizeVectorStoreConfig({ provider: "qdrant", qdrant: { https: true } }).qdrant).toBeUndefined();
  });

  it("normalizes a milvus connection and defaults transport to grpc", () => {
    const cfg = normalizeVectorStoreConfig({
      provider: "milvus",
      milvus: {
        address: "localhost:19530",
        ssl: true,
        username: "milvus",
        database: "lv",
        connectTimeoutMs: 750,
        requestTimeoutMs: 999_999,
      },
    });
    expect(cfg.milvus).toEqual({
      address: "localhost:19530",
      ssl: true,
      database: "lv",
      username: "milvus",
      transport: "grpc",
      connectTimeoutMs: 1_000,
      requestTimeoutMs: 300_000,
    });
    expect(normalizeVectorStoreConfig({ provider: "milvus", milvus: { address: "h:1", transport: "http" } }).milvus?.transport).toBe("http");
  });

  it("allows disabling the Milvus RPC timeout with 0", () => {
    expect(
      normalizeVectorStoreConfig({
        provider: "milvus",
        milvus: { address: "localhost:19530", requestTimeoutMs: 0 },
      }).milvus?.requestTimeoutMs,
    ).toBe(0);
  });

  it("normalizes milvus hybrid candidate tuning independently of the connection block", () => {
    const cfg = normalizeVectorStoreConfig({
      provider: "milvus",
      milvusHybridSearch: {
        candidateMultiplier: 0.2,
        candidateCap: 50_000,
      },
    });
    expect(cfg.milvusHybridSearch).toEqual({
      candidateMultiplier: 1,
      candidateCap: 2_000,
    });
  });

  it("NEVER carries secrets into the persisted config object", () => {
    const cfg = normalizeVectorStoreConfig({
      provider: "qdrant",
      qdrant: { url: "http://q:6333" },
      qdrant_api_key: "super-secret",
      milvus_password: "also-secret",
    } as any);
    expect(JSON.stringify(cfg)).not.toContain("secret");
    expect((cfg as any).qdrant_api_key).toBeUndefined();
  });

  it("reuses Qdrant credentials only for the same URL", () => {
    const active = normalizeVectorStoreConfig({
      provider: "qdrant",
      qdrant: { url: "https://qdrant.example:6333", collectionPrefix: "old_" },
    });
    const sameTarget = normalizeVectorStoreConfig({
      provider: "qdrant",
      qdrant: { url: "https://qdrant.example:6333/", collectionPrefix: "new_" },
    });
    const attackerTarget = normalizeVectorStoreConfig({
      provider: "qdrant",
      qdrant: { url: "https://attacker.example:6333" },
    });

    expect(hasSameVectorStoreCredentialTarget(sameTarget, active, "qdrant")).toBe(true);
    expect(hasSameVectorStoreCredentialTarget(attackerTarget, active, "qdrant")).toBe(false);
  });

  it("reuses Milvus credentials only for the same authentication scope", () => {
    const active = normalizeVectorStoreConfig({
      provider: "milvus",
      milvus: {
        address: "milvus.example:19530",
        ssl: true,
        database: "lumiverse",
        username: "owner",
      },
    });
    const sameTarget = normalizeVectorStoreConfig({
      provider: "milvus",
      milvus: {
        address: "milvus.example:19530",
        ssl: true,
        database: "lumiverse",
        username: "owner",
        requestTimeoutMs: 5_000,
      },
    });
    const changedUsername = normalizeVectorStoreConfig({
      provider: "milvus",
      milvus: {
        address: "milvus.example:19530",
        ssl: true,
        database: "lumiverse",
        username: "attacker",
      },
    });
    const downgradedTransport = normalizeVectorStoreConfig({
      provider: "milvus",
      milvus: {
        address: "milvus.example:19530",
        ssl: false,
        database: "lumiverse",
        username: "owner",
      },
    });

    expect(hasSameVectorStoreCredentialTarget(sameTarget, active, "milvus")).toBe(true);
    expect(hasSameVectorStoreCredentialTarget(changedUsername, active, "milvus")).toBe(false);
    expect(hasSameVectorStoreCredentialTarget(downgradedTransport, active, "milvus")).toBe(false);
  });
});
