import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { __test__ } from "./import.service";

afterEach(() => {
  __test__.setFilesystemCapacityHook(null);
  __test__.setStagingFootprintHook(null);
});

describe("live import commit disk capacity", () => {
  test("rejects a commit when free space cannot cover the staged database", () => {
    const stage = new Database(":memory:");
    stage.run("CREATE TABLE rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    __test__.setFilesystemCapacityHook(() => ({ bavail: 0, bsize: 4096 }));

    expect(() => __test__.assertLiveCommitDiskCapacity(stage)).toThrow(
      "insufficient free disk for live import commit",
    );
    stage.close();
  });

  test("uses the validated SQLite page footprint and accepts ample capacity", () => {
    const stage = new Database(":memory:");
    stage.run("CREATE TABLE rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    stage.query("INSERT INTO rows (value) VALUES (?)").run("validated");
    __test__.setFilesystemCapacityHook(() => ({
      bavail: Number.MAX_SAFE_INTEGER,
      bsize: 4096,
    }));

    expect(() => __test__.assertLiveCommitDiskCapacity(stage)).not.toThrow();
    stage.close();
  });

  test("accepts the future DB/WAL reserve even with a large existing database", () => {
    const stage = new Database(":memory:");
    const stagedBytes = 300n * 1024n * 1024n;
    const headroom = 256n * 1024n * 1024n;
    stage.run("CREATE TABLE rows (id INTEGER PRIMARY KEY)");
    __test__.setStagingFootprintHook(() => stagedBytes);
    __test__.setFilesystemCapacityHook(() => ({
      bavail: Number(stagedBytes + headroom) / 4096,
      bsize: 4096,
    }));

    expect(() => __test__.assertLiveCommitDiskCapacity(stage)).toThrow(
      "insufficient free disk for live import commit",
    );

    __test__.setFilesystemCapacityHook(() => ({
      bavail: Number(2n * stagedBytes + headroom) / 4096,
      bsize: 4096,
    }));
    expect(() => __test__.assertLiveCommitDiskCapacity(stage)).not.toThrow();
    stage.close();
  });
});
