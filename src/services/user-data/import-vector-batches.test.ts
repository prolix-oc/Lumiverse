import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import { env } from "../../env";

const config = { provider: "test", model: "test-model", dimension: 3 };
mock.module("../embeddings.service", () => ({ getEmbeddingConfig: async () => config }));
const batches: { id: string; vector: number[] }[][] = [];
const connect = mock(async () => ({
  openTable: async () => ({ add: async (rows: { id: string; vector: Float32Array }[]) => {
    batches.push(rows.map(row => ({ id: row.id, vector: Array.from(row.vector) })));
  } }),
  close() {},
}));
mock.module("@lancedb/lancedb", () => ({ connect }));
const { startImport } = await import("./import.service");
const { buildExportStream } = await import("./export.service");
const { putSetting } = await import("../settings.service");
let directory: string;
let originalDataDir: string;
const originalVectorStoreEnv = { ...env.vectorStore };

beforeEach(async () => {
  closeDatabase();
  batches.length = 0;
  connect.mockClear();
  directory = mkdtempSync(join(tmpdir(), "lvbak-vector-batches-"));
  originalDataDir = env.dataDir;
  env.dataDir = directory;
  env.vectorStore.provider = "";
  initDatabase(":memory:");
  getDb().run(await Bun.file(join(import.meta.dir, "../../db/baseline.sql")).text());
  getDb().query('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)')
    .run("vector-import-user", "Vector import", "vectors@example.com");
});
afterEach(() => {
  closeDatabase();
  env.dataDir = originalDataDir;
  Object.assign(env.vectorStore, originalVectorStoreEnv);
  rmSync(directory, { recursive: true, force: true });
});

test("bounds vector batches by source bytes and restores a larger record on its own", async () => {
  const vector = new Float32Array([1, 2, 3]);
  const rows = [3, 3, 9, 3, 3].map((size, index) => ({
    id: `vector-${index}`,
    text: "x".repeat(size * 1024 * 1024),
    vector_b64: Buffer.from(vector.buffer).toString("base64"),
  }));
  const archivePath = join(directory, "vectors.lvbak");
  writeFileSync(archivePath, zipSync({
    "manifest.json": strToU8(JSON.stringify({
      schemaVersion: 1, producer: "lumiverse", archiveId: crypto.randomUUID(), exportedAt: 0,
      includeVectors: true, embeddingConfig: config, counts: {}, missingFiles: [],
    })),
    "lancedb/chat_vectors.ndjson": strToU8(rows.map(row => JSON.stringify(row)).join("\n") + "\n"),
  }));
  const job = startImport({ userId: "vector-import-user", archivePath, jobId: crypto.randomUUID() });
  const deadline = Date.now() + 5000;
  while (job.status === "running" && Date.now() < deadline) await Bun.sleep(5);
  expect(job.error).toBeNull();
  expect(job.status).toBe("complete");
  expect(batches.map(batch => batch.length)).toEqual([2, 1, 2]);
  expect(batches.flat()).toEqual(rows.map(row => ({ id: row.id, vector: [1, 2, 3] })));
});

for (const provider of ["milvus", "qdrant"] as const) {
  test(`${provider} skips LanceDB archive vectors and marks imported chunks for reindexing`, async () => {
    putSetting("vector-import-user", "vectorStoreConfig", { provider });
    const archivePath = join(directory, "external-provider.lvbak");
    writeFileSync(archivePath, zipSync({
      "manifest.json": strToU8(JSON.stringify({
        schemaVersion: 1, producer: "lumiverse", archiveId: crypto.randomUUID(), exportedAt: 0,
        includeVectors: true, embeddingConfig: config, counts: {}, missingFiles: [],
      })),
      "database/chats.ndjson": strToU8(JSON.stringify({ id: "chat", user_id: "vector-import-user" }) + "\n"),
      "database/chat_chunks.ndjson": strToU8(JSON.stringify({
        id: "chunk", chat_id: "chat", start_message_id: "start", end_message_id: "end", message_ids: "[]",
        content: "Imported chunk", token_count: 2, message_count: 1, created_at: 0, updated_at: 0,
        vectorized_at: 123, vector_model: "test-model",
      }) + "\n"),
      "lancedb/chat_vectors.ndjson": strToU8(JSON.stringify({
        id: "vector", vector_b64: Buffer.from(new Float32Array([1, 2, 3]).buffer).toString("base64"),
      }) + "\n"),
    }));
    const job = startImport({ userId: "vector-import-user", archivePath, jobId: crypto.randomUUID() });
    const deadline = Date.now() + 5000;
    while (job.status === "running" && Date.now() < deadline) await Bun.sleep(5);
    expect(job.error).toBeNull();
    expect(job.status).toBe("complete");
    expect(batches).toEqual([]);
    expect(getDb().query("SELECT vectorized_at, vector_model FROM chat_chunks WHERE id = 'chunk'").get())
      .toEqual({ vectorized_at: null, vector_model: null });

    const exported = await new Response(buildExportStream({ userId: "vector-import-user", includeVectors: true })).arrayBuffer();
    const entries = unzipSync(new Uint8Array(exported));
    expect(Object.keys(entries).filter(name => name.startsWith("lancedb/"))).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
  });
}
