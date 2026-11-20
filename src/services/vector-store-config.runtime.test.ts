import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const settings = new Map<string, unknown>();
const resetActiveVectorStore = mock(() => {});
const scheduleLanceDbStartupMaintenance = mock(() => {});
const deleteSecret = mock(() => {});
const putSecret = mock(async () => {});

mock.module("./settings.service", () => ({
  getSetting: (_userId: string, key: string) => {
    const value = settings.get(key);
    return value === undefined ? null : { key, value };
  },
  putSettingAsync: async (_userId: string, key: string, value: unknown) => {
    settings.set(key, value);
  },
}));
mock.module("./secrets.service", () => ({
  getSecretForStatus: async () => "saved-secret",
  getSecret: async () => "saved-secret",
  deleteSecret,
  putSecret,
}));
mock.module("../auth/seed", () => ({ getFirstUserId: () => "owner" }));
mock.module("./vector-store", () => ({ resetActiveVectorStore }));
mock.module("./lancedb-maintenance-supervisor", () => ({ scheduleLanceDbStartupMaintenance }));

const { env } = await import("../env");
const { getResolvedVectorStoreConfig, updateVectorStoreConfig, VECTOR_STORE_CONFIG_KEY } = await import("./vector-store-config.service");
const originalEnv = { ...env.vectorStore };

beforeEach(() => {
  settings.clear();
  resetActiveVectorStore.mockClear();
  scheduleLanceDbStartupMaintenance.mockClear();
  deleteSecret.mockClear();
  putSecret.mockClear();
  Object.assign(env.vectorStore, originalEnv, { provider: "" });
});
afterEach(() => Object.assign(env.vectorStore, originalEnv));

test("switching back to LanceDB schedules its usual deferred checks", async () => {
  settings.set(VECTOR_STORE_CONFIG_KEY, { provider: "milvus" });
  await updateVectorStoreConfig("owner", { provider: "lancedb" });
  expect(scheduleLanceDbStartupMaintenance).toHaveBeenCalledTimes(1);
  await updateVectorStoreConfig("owner", { provider: "lancedb" });
  await updateVectorStoreConfig("owner", { provider: "qdrant", qdrant: { url: "https://qdrant.example" } });
  expect(scheduleLanceDbStartupMaintenance).toHaveBeenCalledTimes(1);
});

describe("Milvus runtime flush policy", () => {
  test("updates both policies without replacing the connection or credentials", async () => {
    settings.set(VECTOR_STORE_CONFIG_KEY, {
      provider: "milvus",
      milvus: { address: "milvus.example:19530", database: "db", username: "owner", flushPolicy: "per_write" },
    });

    for (const policy of ["manual", "per_write"] as const) {
      const result = await updateVectorStoreConfig("owner", { milvusFlushPolicy: policy });
      expect(result.milvus).toMatchObject({
        address: "milvus.example:19530", database: "db", username: "owner", flushPolicy: policy,
      });
      expect(result.milvusHasPassword).toBe(true);
      expect(getResolvedVectorStoreConfig().milvus?.flushPolicy).toBe(policy);
    }

    expect(resetActiveVectorStore).toHaveBeenCalledTimes(2);
    expect(deleteSecret).not.toHaveBeenCalled();
    expect(putSecret).not.toHaveBeenCalled();
  });

  test("applies saved runtime policy over env defaults without storing the environment connection", async () => {
    settings.set(VECTOR_STORE_CONFIG_KEY, {
      provider: "qdrant", qdrant: { url: "https://saved.example" },
    });
    Object.assign(env.vectorStore, {
      provider: "milvus", milvusAddress: "env.example:19530", milvusDatabase: "env-db",
      milvusUsername: "env-user", milvusPassword: "env-secret", milvusFlushPolicy: "manual",
    });
    expect(getResolvedVectorStoreConfig().milvus?.flushPolicy).toBe("manual");

    const result = await updateVectorStoreConfig("owner", { milvusFlushPolicy: "per_write" });
    expect(result).toMatchObject({
      provider: "milvus", managedByEnv: true, milvusHasPassword: true,
      milvus: { address: "env.example:19530", database: "env-db", username: "env-user", flushPolicy: "per_write" },
    });
    expect(settings.get(VECTOR_STORE_CONFIG_KEY)).toMatchObject({
      provider: "qdrant", qdrant: { url: "https://saved.example" }, milvusFlushPolicy: "per_write",
    });
    expect(JSON.stringify(settings.get(VECTOR_STORE_CONFIG_KEY))).not.toContain("env.example");
    expect(JSON.stringify(settings.get(VECTOR_STORE_CONFIG_KEY))).not.toContain("env-secret");
    expect((await updateVectorStoreConfig("owner", { tuningProfile: "low_memory" })).milvus?.flushPolicy).toBe("per_write");
    expect(resetActiveVectorStore).toHaveBeenCalledTimes(2);

    await expect(updateVectorStoreConfig("owner", { milvus: { address: "other:19530" } }))
      .rejects.toThrow("managed by environment variables");
  });

  test("rejects invalid policy and unauthorized updates without resetting the store", async () => {
    await expect(updateVectorStoreConfig("owner", { milvusFlushPolicy: "sometimes" as any }))
      .rejects.toThrow("Invalid Milvus flush policy");
    await expect(updateVectorStoreConfig("other-user", { milvusFlushPolicy: "manual" }))
      .rejects.toThrow("server owner");
    expect(settings.size).toBe(0);
    expect(resetActiveVectorStore).not.toHaveBeenCalled();
  });
});
