import { expect, mock, test } from "bun:test";

const instances: FakeStore[] = [];
const closePlans: Array<Promise<void>> = [];

class FakeStore {
  initCalls = 0;
  closeCalls = 0;
  constructor() { instances.push(this); }
  async init(): Promise<void> { this.initCalls += 1; }
  async close(): Promise<void> {
    this.closeCalls += 1;
    await (closePlans.shift() ?? Promise.resolve());
  }
}

mock.module("./vector-store/providers/lancedb", () => ({
  LanceDbStore: FakeStore,
  LANCEDB_CAPABILITIES: {},
}));
mock.module("./vector-store-config.service", () => ({
  getResolvedVectorStoreConfig: () => ({ provider: "lancedb" }),
  getVectorStoreConnectionSecrets: async () => ({ qdrantApiKey: null, milvusPassword: null }),
}));

// Dynamic import is required so Bun installs the isolated constructor mocks first.
const { getActiveVectorStore, resetActiveVectorStore } = await import("./vector-store/index");

test("queued replacement never returns an old handle and close failure remains observable", async () => {
  const first = await getActiveVectorStore() as unknown as FakeStore;
  const closeGate = Promise.withResolvers<void>();
  closePlans.push(closeGate.promise);
  const reset = resetActiveVectorStore();
  const queuedGet = getActiveVectorStore();
  await Promise.resolve();
  expect(instances).toHaveLength(1);
  expect(first.closeCalls).toBe(1);

  closeGate.resolve();
  await reset;
  const second = await queuedGet as unknown as FakeStore;
  expect(second).not.toBe(first);
  expect(instances).toHaveLength(2);

  closePlans.push(Promise.reject(new Error("reconciliation failed")));
  await expect(resetActiveVectorStore()).rejects.toThrow("reconciliation failed");
  const third = await getActiveVectorStore() as unknown as FakeStore;
  expect(third).not.toBe(second);
  expect(second.initCalls).toBe(1);
  expect(instances).toHaveLength(3);
});
