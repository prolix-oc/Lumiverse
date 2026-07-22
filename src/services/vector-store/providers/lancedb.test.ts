import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  isCrossProcessLockFromPriorProcessInstance,
  isRetryableLanceWriteConflict,
  shouldUseCrossProcessWriteLock,
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
