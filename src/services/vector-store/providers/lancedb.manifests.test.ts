import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each case runs in a fresh process so provider singletons and DATA_DIR cannot
// leak into another test. Fixtures are real Lance tables, not mocked handles.
const fixture = `
  import assert from "node:assert/strict";
  import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
  import { join } from "node:path";
  import { connect } from "@lancedb/lancedb";
  const root = join(process.env.DATA_DIR, "lancedb");
  const names = ["embeddings", "embeddings_world_books"];
  const row = (id) => ({
    id, user_id: "user", source_type: "databank", source_id: id,
    owner_id: "owner", chunk_index: 0, content: "manifest recovery " + id,
    vector: [1, 0], metadata_json: "{}", updated_at: 1,
  });
  const versions = (name) => join(root, name + ".lance", "_versions");
  const conn = await connect(root);
  for (const name of names) {
    const table = await conn.createTable(name, [row("one")], { enableV2ManifestPaths: false });
    await table.add([row("two")]);
    table.close();
    renameSync(join(versions(name), "1.manifest"), join(versions(name), "18446744073709551614.manifest"));
    await assert.rejects(conn.openTable(name), /Found multiple manifest naming schemes/);
  }
  conn.close();
  const provider = await import("./src/services/vector-store/providers/lancedb.ts");
  const store = new provider.LanceDbStore();
`;

async function runCase(body: string): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "lance-manifest-integration-"));
  try {
    const child = Bun.spawn({
      cmd: [process.execPath, "--eval", fixture + `
        try { ${body} } finally { await store.close(); }
      `],
      cwd: join(import.meta.dir, "../../../.."),
      env: { ...process.env, DATA_DIR: dataDir, LUMIVERSE_LANCEDB_CROSS_PROCESS_LOCK: "true" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(exitCode, stdout + stderr).toBe(0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe("LanceDB manifest recovery integration", () => {
  test("recovers reads and writes, drains active reads, and coalesces concurrent recovery", async () => {
    await runCase(`
      let finishRead;
      let readStarted;
      const started = new Promise(resolve => { readStarted = resolve; });
      const read = provider.raceWithSignal(() => {
        readStarted();
        return new Promise(resolve => { finishRead = resolve; });
      });
      await started;
      const opens = Promise.all([
        provider.getTableIfExists("embeddings"),
        provider.getTableIfExists("embeddings"),
      ]);
      await Bun.sleep(100);
      assert(existsSync(join(versions("embeddings"), "2.manifest")), "must wait for active reads before renaming");
      finishRead();
      await read;
      const tables = await opens;
      for (const table of tables) {
        assert.equal(await table.countRows(), 2);
        assert.equal(await table.version(), 2);
        assert.equal(await table.usesV2ManifestPaths(), true);
        assert.deepEqual((await table.query().toArray()).map(row => row.id).sort(), ["one", "two"]);
      }
      assert.equal(readdirSync(join(root, "embeddings.lance")).filter(n => n.startsWith(".manifest-v1-backup-")).length, 1);
      await provider.withWriteLock(async () => {
        const table = await provider.getOrCreateTable("embeddings_world_books", [row("unused")], true);
        assert.equal(await table.countRows(), 2);
        await table.add([row("three")]);
        assert.equal(await table.countRows(), 3);
        assert.equal(await table.usesV2ManifestPaths(), true);
      });
      for (const name of names) {
        assert(!existsSync(join(versions(name), "2.manifest")));
        const backup = readdirSync(join(root, name + ".lance")).find(n => n.startsWith(".manifest-v1-backup-"));
        assert(existsSync(join(root, name + ".lance", backup, "2.manifest")));
      }
    `);
  }, 30_000);

  test("startup maintenance child repairs both tables and succeeds again on restart", async () => {
    await runCase(`
      const { runLanceDbMaintenanceInChild } = await import("./src/services/lancedb-maintenance-supervisor.ts");
      await runLanceDbMaintenanceInChild({ mode: "startup" });
      await runLanceDbMaintenanceInChild({ mode: "startup" });
      for (const name of names) {
        const table = await provider.getTableIfExists(name);
        assert.equal(await table.countRows(), 2);
        assert.equal(await table.usesV2ManifestPaths(), true);
        assert.equal(readdirSync(join(root, name + ".lance")).filter(n => n.startsWith(".manifest-v1-backup-")).length, 1);
      }
    `);
  }, 30_000);

  test("a conflicting manifest fails without resetting either table and releases the write lock", async () => {
    await runCase(`
      const target = join(versions("embeddings"), "18446744073709551613.manifest");
      writeFileSync(target, "different version 2");
      const before = readdirSync(versions("embeddings")).sort();
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(provider.getTableIfExists("embeddings"), error => {
          assert.match(error.message, /vector store preserved/);
          assert.match(error.cause.message, /Conflicting LanceDB manifests/);
          return true;
        });
      }
      assert.deepEqual(readdirSync(versions("embeddings")).sort(), before);
      assert.equal(readFileSync(target, "utf8"), "different version 2");
      assert(existsSync(join(versions("embeddings_world_books"), "2.manifest")));
      assert.equal(await (await provider.getTableIfExists("embeddings_world_books")).countRows(), 2);
    `);
  }, 30_000);

  test("waits for a writer in another process before repairing manifests", async () => {
    await runCase(`
      let child;
      await provider.withWriteLock(async () => {
        child = Bun.spawn({
          cmd: [process.execPath, "--eval", \`
            const provider = await import("./src/services/vector-store/providers/lancedb.ts");
            console.log("opening");
            const table = await provider.getTableIfExists("embeddings");
            if (await table.countRows() !== 2) throw new Error("Rows lost during repair");
            await new provider.LanceDbStore().close();
          \`],
          env: process.env, stdout: "pipe", stderr: "pipe", timeout: 10_000,
        });
        const reader = child.stdout.getReader();
        const first = await reader.read();
        assert(new TextDecoder().decode(first.value).includes("opening"));
        reader.releaseLock();
        await Bun.sleep(100);
        assert(existsSync(join(versions("embeddings"), "2.manifest")), "must honor another process's write lock");
      });
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      assert.equal(exitCode, 0, stderr);
      assert(!existsSync(join(versions("embeddings"), "2.manifest")));
    `);
  }, 30_000);

  test("releases the local write lock if acquiring the filesystem lock fails", async () => {
    await runCase(`
      const saved = process.env.DATA_DIR + "-moved";
      renameSync(process.env.DATA_DIR, saved);
      try {
        await assert.rejects(provider.withWriteLock(async () => {}), { code: "ENOENT" });
      } finally {
        renameSync(saved, process.env.DATA_DIR);
      }
      assert.equal(await provider.withWriteLock(async () => "acquired again"), "acquired again");
    `);
  }, 30_000);
});
