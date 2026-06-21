import { describe, expect, it } from "bun:test";
import { defaultVectorStoreConfig, normalizeVectorStoreConfig } from "./vector-store-config.service";

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
      milvus: { address: "localhost:19530", ssl: true, username: "milvus", database: "lv" },
    });
    expect(cfg.milvus).toEqual({
      address: "localhost:19530",
      ssl: true,
      database: "lv",
      username: "milvus",
      transport: "grpc",
    });
    expect(normalizeVectorStoreConfig({ provider: "milvus", milvus: { address: "h:1", transport: "http" } }).milvus?.transport).toBe("http");
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
});
