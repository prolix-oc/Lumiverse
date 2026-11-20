import { expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { connect } from "@lancedb/lancedb";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import { env } from "../../env";

const config = { provider: "test", model: "test-model", dimension: 3 };
mock.module("../embeddings.service", () => ({ getEmbeddingConfig: async () => config }));
const { startImport } = await import("./import.service");

test("replaying a vector import preserves committed rows and isolates the account's IDs", async () => {
  const originalDataDir = env.dataDir;
  const directory = mkdtempSync(join(tmpdir(), "lvbak-vector-recovery-"));
  env.dataDir = directory;
  closeDatabase();
  initDatabase(":memory:");
  const connection = await connect(join(directory, "lancedb"));
  try {
    getDb().run(await Bun.file(join(import.meta.dir, "../../db/baseline.sql")).text());
    getDb().query('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)')
      .run("vector-owner", "Recovery", "vector-recovery@example.com");
    await connection.createTable("chat_vectors", [
      { id: "existing", user_id: "vector-owner", vector: [9, 9, 9] },
      { id: "new", user_id: "other-owner", vector: [8, 8, 8] },
    ]);
    const vector_b64 = Buffer.from(new Float32Array([1, 2, 3]).buffer).toString("base64");
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
    const archive = zipSync({
      "manifest.json": encode({ schemaVersion: 1, producer: "lumiverse", archiveId: crypto.randomUUID(), exportedAt: 0,
        includeVectors: true, embeddingConfig: config, counts: {}, missingFiles: [] }),
      "lancedb/chat_vectors.ndjson": Buffer.from(["existing", "new"].map(id => JSON.stringify({ id, vector_b64 })).join("\n") + "\n"),
    });
    for (let replay = 0; replay < 2; replay++) {
      const archivePath = join(directory, `replay-${replay}.lvbak`);
      writeFileSync(archivePath, archive);
      const job = startImport({ userId: "vector-owner", jobId: crypto.randomUUID(), archivePath, resuming: true });
      const deadline = Date.now() + 10_000;
      while (job.status === "running" && Date.now() < deadline) await Bun.sleep(5);
      expect(job.error).toBeNull();
      expect(job.status).toBe("complete");
      const table = await connection.openTable("chat_vectors");
      const rows = await table.query().toArray();
      expect(rows.length).toBe(3);
      expect(rows.map(row => ({ id: row.id, user: row.user_id, vector: Array.from(row.vector) }))
        .sort((a, b) => `${a.user}/${a.id}`.localeCompare(`${b.user}/${b.id}`))).toEqual([
          { id: "new", user: "other-owner", vector: [8, 8, 8] },
          { id: "existing", user: "vector-owner", vector: [9, 9, 9] },
          { id: "new", user: "vector-owner", vector: [1, 2, 3] },
        ]);
    }
  } finally {
    connection.close();
    closeDatabase();
    env.dataDir = originalDataDir;
    rmSync(directory, { recursive: true, force: true });
  }
});
