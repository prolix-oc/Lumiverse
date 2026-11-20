import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const setup = `
  import assert from "node:assert/strict";
  import { existsSync } from "node:fs";
  import { join } from "node:path";
  import { mock } from "bun:test";
  const { initDatabase, closeDatabase } = await import("./src/db/connection.ts");
  const db = initDatabase();
  db.exec(await Bun.file("./src/db/baseline.sql").text());
  db.run('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)',
    ["owner", "Owner", "owner@example.com"]);
  const { putSetting } = await import("./src/services/settings.service.ts");
  const { env } = await import("./src/env.ts");
  const nativeLoaded = () => Object.keys(require.cache).some(path => path.includes("@lancedb"));
  let failExternal = false;
  let externalCloses = 0;
  for (const [provider, name] of [["milvus", "MilvusStore"], ["qdrant", "QdrantStore"]]) {
    mock.module("./src/services/vector-store/providers/" + provider + ".ts", () => ({
      [name]: class {
        id = provider;
        async init() { if (failExternal) throw new Error("external server unavailable"); }
        async close() { externalCloses++; }
      },
    }));
  }
`;

function runIsolated(script: string, extraEnv: Record<string, string> = {}): void {
  const directory = mkdtempSync(join(tmpdir(), "lumiverse-vector-provider-loading-"));
  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "--no-env-file", "--eval", setup + script + "\ncloseDatabase(); process.exit(0);"],
      cwd: join(import.meta.dir, "../../.."),
      env: {
        ...process.env,
        DATA_DIR: directory,
        LUMIVERSE_VECTOR_STORE_PROVIDER: "",
        LUMIVERSE_LANCEDB_NATIVE_PATH: "",
        NAPI_RS_NATIVE_LIBRARY_PATH: "",
        LUMIVERSE_LANCEDB_CROSS_PROCESS_LOCK: "false",
        LUMIVERSE_LANCEDB_STARTUP_MAINTENANCE: "true",
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Provider-loading subprocess failed:\n${result.stdout}\n${result.stderr}`);
    }
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("vector provider native loading", () => {
  for (const provider of ["milvus", "qdrant"] as const) {
    for (const source of ["stored", "environment"] as const) {
      test(`${source} ${provider} skips native loading and maintenance even when unavailable`, () => {
        runIsolated(`
          if (${JSON.stringify(source)} === "stored") {
            putSetting("owner", "vectorStoreConfig", { provider: ${JSON.stringify(provider)} });
          } else {
            // Environment selection wins over the saved/default local provider.
            putSetting("owner", "vectorStoreConfig", { provider: "lancedb" });
          }
          globalThis.fetch = async () => { throw new Error("Unexpected native download"); };
          await import("./src/services/embeddings.service.ts");
          const { getActiveVectorStore } = await import("./src/services/vector-store/index.ts");
          assert.equal((await getActiveVectorStore()).id, ${JSON.stringify(provider)});
          failExternal = true;
          await assert.rejects(getActiveVectorStore(), /external server unavailable/);
          Bun.spawn = () => { throw new Error("Unexpected maintenance child"); };
          const { runLanceDbMaintenanceInChild, isLanceDbMaintenanceRunning, scheduleLanceDbStartupMaintenance } =
            await import("./src/services/lancedb-maintenance-supervisor.ts");
          globalThis.setTimeout = () => { throw new Error("Unexpected maintenance timer"); };
          scheduleLanceDbStartupMaintenance();
          await runLanceDbMaintenanceInChild({ mode: "startup" });
          await runLanceDbMaintenanceInChild({ mode: "optimize" });
          assert.equal(isLanceDbMaintenanceRunning(), false);
          assert.equal(nativeLoaded(), false);
          assert.equal(existsSync(join(env.dataDir, "lancedb")), false);
          assert.equal(existsSync(join(env.dataDir, ".lancedb-maintenance.json")), false);
        `, {
          // A native import would fail on this host, and Termux preflight would
          // attempt a download. Neither is allowed for an external provider.
          NAPI_RS_NATIVE_LIBRARY_PATH: "/missing/lumiverse-lance-native.node",
          LUMIVERSE_IS_TERMUX: "true",
          ...(source === "environment" ? { LUMIVERSE_VECTOR_STORE_PROVIDER: provider } : {}),
        });
      });
    }
  }

  test("deferred maintenance rechecks a switched provider and resumes for LanceDB", () => {
    runIsolated(`
      const pending = [];
      globalThis.setTimeout = callback => { pending.push(callback); return { unref() {} }; };
      let children = 0;
      Bun.spawn = () => { children++; return { exited: Promise.resolve(0) }; };
      const { scheduleLanceDbStartupMaintenance } = await import("./src/services/lancedb-maintenance-supervisor.ts");
      scheduleLanceDbStartupMaintenance();
      scheduleLanceDbStartupMaintenance();
      assert.equal(pending.length, 1);
      putSetting("owner", "vectorStoreConfig", { provider: "milvus" });
      await pending.shift()();
      scheduleLanceDbStartupMaintenance();
      assert.equal(pending.length, 0);
      assert.equal(children, 0);
      assert.equal(nativeLoaded(), false);
      putSetting("owner", "vectorStoreConfig", { provider: "lancedb" });
      process.env.LUMIVERSE_LANCEDB_STARTUP_MAINTENANCE = "false";
      scheduleLanceDbStartupMaintenance();
      assert.equal(pending.length, 0);
      process.env.LUMIVERSE_LANCEDB_STARTUP_MAINTENANCE = "true";
      scheduleLanceDbStartupMaintenance();
      assert.equal(pending.length, 1);
      await pending.shift()();
      assert.equal(children, 1);
      const { stopIndexHealthMonitor } = await import("./src/services/vector-store/providers/lancedb.ts");
      stopIndexHealthMonitor();
    `);
  });

  test("default LanceDB loads normally and a retained worker handle follows provider switches", () => {
    runIsolated(`
      const { getActiveVectorStore, resetActiveVectorStore } = await import("./src/services/vector-store/index.ts");
      assert.equal(nativeLoaded(), false);
      const initial = await getActiveVectorStore();
      assert.equal(initial.id, "lancedb");
      assert.equal(nativeLoaded(), true);
      assert.equal(existsSync(join(env.dataDir, "lancedb")), true);
      putSetting("owner", "vectorStoreConfig", { provider: "milvus" });
      assert.equal((await getActiveVectorStore()).id, "milvus");
      putSetting("owner", "vectorStoreConfig", { provider: "lancedb" });
      const restored = await getActiveVectorStore();
      assert.equal(restored.id, "lancedb");
      assert.equal(externalCloses, 1);
      await restored.upsert("embeddings", [{
        id: "row", user_id: "owner", source_type: "chat_chunk", source_id: "chunk", owner_id: "chat",
        chunk_index: 0, content: "Still writable after switching back", vector: [1, 0, 0], metadata_json: "{}", updated_at: 0,
      }]);
      assert.equal(await restored.countRows("embeddings"), 1);
      assert.equal((await restored.health("embeddings")).exists, true);
      resetActiveVectorStore();
    `);
  });

  test("an invalid provider retains the LanceDB default", () => {
    runIsolated(`
      putSetting("owner", "vectorStoreConfig", { provider: "unknown" });
      const { getActiveVectorStore, resetActiveVectorStore } = await import("./src/services/vector-store/index.ts");
      assert.equal((await getActiveVectorStore()).id, "lancedb");
      assert.equal(nativeLoaded(), true);
      resetActiveVectorStore();
    `);
  });
});
