import { expect, mock, test } from "bun:test";

const stored = new Map<string, unknown>();
const puts: unknown[] = [];
const resetPlans: Array<Promise<void>> = [];
let resetCalls = 0;

mock.module("./settings.service", () => ({
  getSetting: (_userId: string, key: string) => stored.has(key) ? { value: stored.get(key) } : undefined,
  putSetting: (_userId: string, key: string, value: unknown) => {
    puts.push(value);
    stored.set(key, value);
  },
}));
mock.module("./secrets.service", () => ({
  getSecret: async () => null,
  getSecretForStatus: async () => null,
  putSecret: async () => undefined,
  deleteSecret: () => undefined,
}));
mock.module("../auth/seed", () => ({ getFirstUserId: () => "owner" }));
mock.module("../db/connection", () => ({ getDb: () => { throw new Error("unexpected reconciliation"); } }));
mock.module("../env", () => ({
  env: { vectorStore: { provider: "", qdrantApiKey: "", milvusPassword: "" } },
}));
mock.module("./vector-store", () => ({
  resetActiveVectorStore: async () => {
    resetCalls += 1;
    await (resetPlans.shift() ?? Promise.resolve());
  },
}));

// Dynamic import is required so Bun installs the transition dependency mocks first.
const { updateVectorStoreConfig } = await import("./vector-store-config.service");

test("config transitions serialize close-before-publish and propagate reconciliation failure", async () => {
  const gate = Promise.withResolvers<void>();
  resetPlans.push(gate.promise, Promise.resolve());
  const first = updateVectorStoreConfig("owner", { tuningProfile: "low_latency" });
  const second = updateVectorStoreConfig("owner", { tuningProfile: "low_memory" });
  for (let i = 0; i < 10 && resetCalls === 0; i += 1) await Bun.sleep(0);
  expect(resetCalls).toBe(1);
  expect(puts).toHaveLength(0);

  gate.resolve();
  await first;
  await second;
  expect(resetCalls).toBe(2);
  expect(puts).toEqual([
    { provider: "lancedb", tuningProfile: "low_latency" },
    { provider: "lancedb", tuningProfile: "low_memory" },
  ]);

  resetPlans.push(Promise.reject(new Error("SQLite reconciliation failed")));
  await expect(updateVectorStoreConfig("owner", { tuningProfile: "balanced" }))
    .rejects.toThrow("SQLite reconciliation failed");
  expect(puts).toHaveLength(2);
  expect(stored.get("vectorStoreConfig")).toEqual({ provider: "lancedb", tuningProfile: "low_memory" });
});
