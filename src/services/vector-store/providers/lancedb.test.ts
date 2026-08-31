import { describe, expect, test } from "bun:test";
import { closeDatabase, closeDatabaseAsync, getDb, getDbGeneration, getDbGenerationSignal, initDatabase } from "../../../db/connection";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ensureVectorIndex,
  isCrossProcessLockFromPriorProcessInstance,
  admitLanceExternalMaintenanceOwner,
  isDeferredOptimizeScheduled,
  isRetryableLanceWriteConflict,
  pauseLanceDbForExternalMaintenance,
  raceWithSignal,
  runAbortFencedNativeMutation,
  safeTableDelete,
  scheduleOptimize,
  shouldUseCrossProcessWriteLock,
  withWriteLock,
  sweepEmptyIndexDirs,
  WORLD_BOOK_EMBEDDINGS_TABLE,
} from "./lancedb";

describe("lancedb write conflict handling", () => {
  test("enables cross-process write locking by default", () => {
    expect(shouldUseCrossProcessWriteLock({})).toBe(true);
  });

  test("allows explicitly disabling cross-process write locking", () => {
    expect(shouldUseCrossProcessWriteLock({
      LUMIVERSE_LANCEDB_CROSS_PROCESS_LOCK: "false",
    })).toBe(false);
  });

  test("recognizes a stale lock when a restarted container reuses its PID", () => {
    expect(isCrossProcessLockFromPriorProcessInstance(
      { pid: 1, acquiredAt: 1_000 },
      1,
      2_000,
    )).toBe(true);
  });

  test("keeps a lock acquired by the current process instance", () => {
    expect(isCrossProcessLockFromPriorProcessInstance(
      { pid: 1, acquiredAt: 2_000 },
      1,
      1_000,
    )).toBe(false);
  });

  test("detects Lance retryable commit conflicts from Windows warning text", () => {
    const err = new Error(
      "lance error: Retryable commit conflict for version 786: "
      + "This CreateIndex transaction was preempted by concurrent transaction CreateIndex at version 786. Please retry.",
    );
    expect(isRetryableLanceWriteConflict(err)).toBe(true);
  });

  test("ignores non-conflict Lance warnings", () => {
    expect(isRetryableLanceWriteConflict(new Error("vector not divisible by 8"))).toBe(false);
    expect(isRetryableLanceWriteConflict(new Error("table 'embeddings' was not found"))).toBe(false);
  });
});

describe("lancedb generation mutation fencing", () => {
  test("holds database replacement until an invoked native delete drains", async () => {
    initDatabase(":memory:");
    const generation = getDbGeneration();
    const signal = getDbGenerationSignal(generation);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let nativeMutations = 0;
    const table = {
      countRows: async () => 1,
      delete: async () => {
        nativeMutations += 1;
        entered.resolve();
        await release.promise;
      },
    };

    const deletion = safeTableDelete(table as any, "id = 'stale'", "general", signal);
    await entered.promise;
    const reset = closeDatabaseAsync();
    let resetSettled = false;
    void reset.then(() => { resetSettled = true; });
    await Promise.resolve();

    expect(signal.aborted).toBe(true);
    expect(resetSettled).toBe(false);
    expect(getDbGeneration()).toBe(generation);
    expect(() => getDb()).toThrow("was replaced by generation");
    await expect(runAbortFencedNativeMutation(signal, async () => {
      nativeMutations += 1;
    })).rejects.toMatchObject({ code: "database_generation_cancelled" });
    expect(nativeMutations).toBe(1);

    release.resolve();
    await expect(deletion).rejects.toMatchObject({ code: "database_generation_cancelled" });
    await reset;
    expect(getDbGeneration()).toBe(generation + 1);
    await Bun.sleep(0);
    expect(nativeMutations).toBe(1);
  });

  test("invalidates deferred optimize before draining suspended native optimize", async () => {
    initDatabase(":memory:");
    const generation = getDbGeneration();
    const signal = getDbGenerationSignal(generation);
    scheduleOptimize("general", signal);
    expect(isDeferredOptimizeScheduled()).toBe(true);

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let nativeMutations = 0;
    const optimizing = runAbortFencedNativeMutation(signal, async () => {
      nativeMutations += 1;
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const reset = closeDatabaseAsync();
    let resetSettled = false;
    void reset.then(() => { resetSettled = true; });
    await Promise.resolve();

    expect(signal.aborted).toBe(true);
    expect(isDeferredOptimizeScheduled()).toBe(false);
    expect(resetSettled).toBe(false);
    expect(getDbGeneration()).toBe(generation);
    expect(() => scheduleOptimize("general", signal)).toThrow();

    release.resolve();
    await expect(optimizing).rejects.toMatchObject({ code: "database_generation_cancelled" });
    await reset;
    await Bun.sleep(0);
    expect(nativeMutations).toBe(1);
    expect(isDeferredOptimizeScheduled()).toBe(false);
  });

  test("drains cancelled queued writes and leaves the write lock usable after replacement", async () => {
    initDatabase(":memory:");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let firstQueuedWriteRan = false;
    let secondQueuedWriteRan = false;
    const activeWrite = withWriteLock(async () => {
      entered.resolve();
      await release.promise;
    });
    const activeOutcome = activeWrite.then(() => null, (error) => error);
    await entered.promise;
    const firstQueuedWrite = withWriteLock(async () => {
      firstQueuedWriteRan = true;
    });
    const firstQueuedOutcome = firstQueuedWrite.then(() => null, (error) => error);
    const secondQueuedWrite = withWriteLock(async () => {
      secondQueuedWriteRan = true;
    });
    const secondQueuedOutcome = secondQueuedWrite.then(() => null, (error) => error);
    // Let both admitted owners reach the in-process queue before replacement
    // cancels their Lance generation.
    await Promise.resolve();
    const replacement = closeDatabaseAsync();
    let replacementSettled = false;
    void replacement.then(() => { replacementSettled = true; });
    await Promise.resolve();

    expect(replacementSettled).toBe(false);
    release.resolve();
    expect(await activeOutcome).toMatchObject({ code: "lancedb_generation_cancelled" });
    expect(await firstQueuedOutcome).toMatchObject({ code: "lancedb_generation_cancelled" });
    expect(await secondQueuedOutcome).toMatchObject({ code: "lancedb_generation_cancelled" });
    await replacement;
    expect(replacementSettled).toBe(true);
    expect(firstQueuedWriteRan).toBe(false);
    expect(secondQueuedWriteRan).toBe(false);

    let subsequentWriteRan = false;
    await withWriteLock(async () => {
      subsequentWriteRan = true;
    });
    expect(subsequentWriteRan).toBe(true);
  });

  test("replacement retires and drains an admitted external maintenance owner", async () => {
    initDatabase(":memory:");
    const admission = admitLanceExternalMaintenanceOwner();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const external = admission.run(async () => {
      entered.resolve();
      await release.promise;
    });
    const externalOutcome = external.then(() => null, (error) => error);
    await entered.promise;
    const replacement = closeDatabaseAsync();
    let replacementSettled = false;
    void replacement.then(() => { replacementSettled = true; });
    await Promise.resolve();

    expect(admission.signal.aborted).toBe(true);
    expect(replacementSettled).toBe(false);
    release.resolve();
    expect(await externalOutcome).toMatchObject({ code: "lancedb_generation_cancelled" });
    admission.release();
    await replacement;
  });
});
describe("lancedb empty index directory cleanup", () => {
  test("removes only aged, empty UUID directories", () => {
    const root = mkdtempSync(join(tmpdir(), "lumiverse-lancedb-index-sweep-test-"));
    const oldEmpty = join(root, "11111111-1111-4111-8111-111111111111");
    const recentEmpty = join(root, "22222222-2222-4222-8222-222222222222");
    const oldNonEmpty = join(root, "33333333-3333-4333-8333-333333333333");
    const unrelated = join(root, "not-an-index-uuid");
    const now = 20_000;
    const gracePeriodMs = 5_000;

    try {
      for (const dir of [oldEmpty, recentEmpty, oldNonEmpty, unrelated]) {
        mkdirSync(dir);
      }
      writeFileSync(join(oldNonEmpty, "index-file"), "live");
      utimesSync(oldEmpty, new Date(1_000), new Date(1_000));
      utimesSync(oldNonEmpty, new Date(1_000), new Date(1_000));
      utimesSync(unrelated, new Date(1_000), new Date(1_000));
      utimesSync(recentEmpty, new Date(18_000), new Date(18_000));

      expect(sweepEmptyIndexDirs(root, gracePeriodMs, now)).toBe(1);
      expect(existsSync(oldEmpty)).toBe(false);
      expect(existsSync(recentEmpty)).toBe(true);
      expect(existsSync(oldNonEmpty)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("treats a missing index root as already clean", () => {
    const root = join(tmpdir(), `lumiverse-lancedb-missing-index-sweep-${crypto.randomUUID()}`);
    expect(sweepEmptyIndexDirs(root, 0, Date.now())).toBe(0);
  });
});

describe("lancedb index maintenance", () => {
  test("blocks native reads while an external maintenance child owns the gate", async () => {
    const release = await pauseLanceDbForExternalMaintenance();
    let started = false;
    const read = raceWithSignal(async () => {
      started = true;
      return "read complete";
    }, undefined);

    await Bun.sleep(10);
    expect(started).toBe(false);
    release();
    await expect(read).resolves.toBe("read complete");
  });

  test("keeps an existing vector index after runtime state is reset", async () => {
    let countRowsCalls = 0;
    const table: any = {
      listIndices: async () => [{ name: "vector_idx" }],
      countRows: async () => {
        countRowsCalls += 1;
        return 10_000;
      },
    };

    await expect(ensureVectorIndex(WORLD_BOOK_EMBEDDINGS_TABLE, table)).resolves.toBe(table);
    expect(countRowsCalls).toBe(0);
  });

  test("does not rebuild every scalar and FTS index after Lance optimize", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lumiverse-lancedb-maintenance-test-"));
    const repoRoot = join(import.meta.dir, "../../../..");
    const resultMarker = "__LANCEDB_MAINTENANCE_RESULT__";

    try {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "--eval",
          `
            const { readdirSync } = await import("fs");
            const { join } = await import("path");
            const { LanceDbStore } = await import("./src/services/vector-store/providers/lancedb.ts");
            const store = new LanceDbStore();
            try {
              await store.upsert("embeddings", [{
                id: "user:databank:source:0",
                user_id: "user",
                source_type: "databank",
                source_id: "source",
                owner_id: "owner",
                chunk_index: 0,
                content: "maintenance test",
                vector: [1, 0],
                metadata_json: "{}",
                updated_at: 1,
              }]);
              const indexRoot = join(process.env.DATA_DIR, "lancedb", "embeddings.lance", "_indices");
              const before = readdirSync(indexRoot).length;
              await store.optimize(["embeddings"]);
              const after = readdirSync(indexRoot).length;
              console.log("${resultMarker}" + JSON.stringify({ before, after }));
            } finally {
              await store.close();
            }
          `,
        ],
        cwd: repoRoot,
        env: {
          ...process.env,
          DATA_DIR: dataDir,
          LUMIVERSE_LANCEDB_CROSS_PROCESS_LOCK: "false",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      if (result.exitCode !== 0) {
        throw new Error(`LanceDB maintenance test subprocess failed:\n${result.stderr.toString()}`);
      }
      const resultLine = result.stdout
        .toString()
        .split(/\r?\n/)
        .find((line) => line.startsWith(resultMarker));
      expect(resultLine).toBeDefined();
      const { before, after } = JSON.parse(resultLine!.slice(resultMarker.length)) as {
        before: number;
        after: number;
      };
      expect(before).toBe(6);
      // Lance may create one optimized generation per index. The application
      // must not immediately create a second generation for the same indexes.
      expect(after - before).toBeLessThanOrEqual(before);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("lancedb maintenance supervisor", () => {
  test("runs maintenance in a child process", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lumiverse-lancedb-supervisor-test-"));
    const repoRoot = join(import.meta.dir, "../../../..");
    const resultMarker = "__LANCEDB_MAINTENANCE_SUPERVISOR_RESULT__";

    try {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "--eval",
          `
            const { runLanceDbMaintenanceInChild } = await import("./src/services/lancedb-maintenance-supervisor.ts");
            await runLanceDbMaintenanceInChild({ mode: "startup" });
            const { stopIndexHealthMonitor } = await import("./src/services/vector-store/providers/lancedb.ts");
            stopIndexHealthMonitor();
            console.log("${resultMarker}");
          `,
        ],
        cwd: repoRoot,
        env: {
          ...process.env,
          DATA_DIR: dataDir,
          LUMIVERSE_LANCEDB_CROSS_PROCESS_LOCK: "false",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      if (result.exitCode !== 0) {
        throw new Error(`LanceDB maintenance supervisor subprocess failed:\n${result.stderr.toString()}`);
      }
      expect(result.stdout.toString()).toContain(resultMarker);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("lancedb vector search distance", () => {
  test("uses cosine distance for unindexed searches and normalized scores", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lumiverse-lancedb-cosine-test-"));
    const repoRoot = join(import.meta.dir, "../../../..");
    const resultMarker = "__LANCEDB_COSINE_RESULT__";

    try {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "--eval",
          `
            const { LanceDbStore } = await import("./src/services/vector-store/providers/lancedb.ts");

            const row = (sourceId, ownerId, vector) => ({
              id: \`user:databank:\${sourceId}:0\`,
              user_id: "user",
              source_type: "databank",
              source_id: sourceId,
              owner_id: ownerId,
              chunk_index: 0,
              content: sourceId,
              vector,
              metadata_json: "{}",
              updated_at: 1,
            });

            const store = new LanceDbStore();
            try {
              await store.upsert("embeddings", [
                row("scaled", "scores", [2, 0]),
                row("orthogonal", "scores", [0, 1]),
                row("far-scaled", "ranking", [4, 0]),
                row("ranking-orthogonal", "ranking", [0, 1]),
              ]);

              const scores = await store.vectorSearch({
                collection: "embeddings",
                vector: [1, 0],
                filter: { op: "eq", field: "owner_id", value: "scores" },
                limit: 2,
                withVector: false,
              });
              const ranking = await store.vectorSearch({
                collection: "embeddings",
                vector: [1, 0],
                filter: { op: "eq", field: "owner_id", value: "ranking" },
                limit: 1,
                withVector: false,
              });

              console.log("${resultMarker}" + JSON.stringify({
                scores: scores.map(({ source_id, similarity }) => ({ source_id, similarity })),
                topRankedSourceId: ranking[0]?.source_id ?? null,
              }));
            } finally {
              await store.close();
            }
          `,
        ],
        cwd: repoRoot,
        env: {
          ...process.env,
          DATA_DIR: dataDir,
          LUMIVERSE_LANCEDB_CROSS_PROCESS_LOCK: "false",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      if (result.exitCode !== 0) {
        throw new Error(`LanceDB cosine test subprocess failed:\n${result.stderr.toString()}`);
      }

      const resultLine = result.stdout
        .toString()
        .split(/\r?\n/)
        .find((line) => line.startsWith(resultMarker));
      expect(resultLine).toBeDefined();

      const payload = JSON.parse(resultLine!.slice(resultMarker.length)) as {
        scores: Array<{ source_id: string; similarity: number | null }>;
        topRankedSourceId: string | null;
      };
      expect(payload.scores).toHaveLength(2);
      expect(payload.scores[0].source_id).toBe("scaled");
      expect(payload.scores[0].similarity).toBeCloseTo(1);
      expect(payload.scores[1].source_id).toBe("orthogonal");
      expect(payload.scores[1].similarity).toBeCloseTo(0);
      expect(payload.topRankedSourceId).toBe("far-scaled");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("lancedb Termux native-read safety", () => {
  test("serializes native read thunks on Termux", () => {
    const repoRoot = join(import.meta.dir, "../../../..");
    const resultMarker = "__LANCEDB_TERMUX_READ_RESULT__";
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `
          const { raceWithSignal } = await import("./src/services/vector-store/providers/lancedb.ts");
          let active = 0;
          let maxActive = 0;
          const reads = Array.from({ length: 8 }, (_, index) => raceWithSignal(async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await Bun.sleep(5);
            active--;
            return index;
          }, undefined));
          const values = await Promise.all(reads);
          console.log("${resultMarker}" + JSON.stringify({ maxActive, values }));
        `,
      ],
      cwd: repoRoot,
      env: {
        ...process.env,
        LUMIVERSE_IS_TERMUX: "true",
        LUMIVERSE_LANCEDB_CROSS_PROCESS_LOCK: "false",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    if (result.exitCode !== 0) {
      throw new Error(`LanceDB Termux read test subprocess failed:\n${result.stderr.toString()}`);
    }
    const resultLine = result.stdout
      .toString()
      .split(/\r?\n/)
      .find((line) => line.startsWith(resultMarker));
    expect(resultLine).toBeDefined();
    expect(JSON.parse(resultLine!.slice(resultMarker.length))).toEqual({
      maxActive: 1,
      values: [0, 1, 2, 3, 4, 5, 6, 7],
    });
  });
});
