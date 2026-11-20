import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { createMemoryPressureHandler, releaseMemoryPressureResources } from "./memory-pressure.service";
import type { LinuxMemorySnapshot } from "./linux-memory-pressure";

beforeEach(() => closeDatabase());
afterEach(() => closeDatabase());

describe("memory pressure resources", () => {
  test("warning pressure releases resources without requiring a database", () => {
    expect(releaseMemoryPressureResources("warning")).toEqual([]);
  });

  test("critical pressure shrinks SQLite without closing or changing it", () => {
    initDatabase(":memory:");
    const db = getDb();
    db.run("CREATE TABLE pressure_probe (value TEXT NOT NULL)");
    db.query("INSERT INTO pressure_probe (value) VALUES (?)").run("still-open");

    expect(releaseMemoryPressureResources("critical")).toEqual([]);
    expect(db.query("SELECT value FROM pressure_probe").get()).toEqual({ value: "still-open" });
  });

  test("critical-only failures do not affect warning pressure", () => {
    const failures = releaseMemoryPressureResources("critical");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^SQLite:/);
    expect(releaseMemoryPressureResources("warning")).toEqual([]);
  });
});

function linuxSnapshot(): LinuxMemorySnapshot {
  return {
    capturedAt: "2026-10-29T15:00:00.000Z",
    process: { rssBytes: 200_000_000, heapUsedBytes: 100_000_000, externalBytes: 20_000_000 },
    host: { totalBytes: 100 * 1024 ** 3, availableBytes: 80 * 1024 ** 3, swapTotalBytes: 0, swapFreeBytes: 0, pressure: null, recentStall: null },
    cgroup: {
      version: 2,
      path: "/app",
      pressure: null,
      recentStall: null,
      hierarchy: [{ path: "/sys/fs/cgroup/app", currentBytes: 1 * 1024 ** 3, highBytes: "max", maxBytes: 4 * 1024 ** 3, events: { high: 0, max: 0, oom: 0, oom_kill: 0 } }],
    },
  };
}

describe("memory pressure event handling", () => {
  test.each(["darwin", "win32"] as const)("preserves %s cleanup for every event", (platform) => {
    const released: string[] = [];
    const warnings: string[] = [];
    const handle = createMemoryPressureHandler({
      platform,
      release: (level) => { released.push(level); return []; },
      warn: (message) => warnings.push(message),
      now: () => { throw new Error("non-Linux handlers must not use the cooldown"); },
      snapshot: () => { throw new Error("non-Linux handlers must not read Linux diagnostics"); },
    });
    handle("warning");
    handle("critical");
    handle("critical");
    expect(released).toEqual(["warning", "critical", "critical"]);
    expect(warnings).toEqual([
      "[runtime] warning memory pressure: released reconstructable state and idle resources",
      "[runtime] critical memory pressure: released reconstructable state and idle resources",
      "[runtime] critical memory pressure: released reconstructable state and idle resources",
    ]);
  });

  test("logs Linux measurements before cleanup and rate-limits repeated events", () => {
    let at = 0;
    const actions: string[] = [];
    const handle = createMemoryPressureHandler({
      platform: "linux",
      release: (level) => { actions.push(`release:${level}`); return []; },
      warn: (message) => actions.push(message),
      now: () => at,
      snapshot: linuxSnapshot,
    });
    handle("critical");
    expect(actions[0]).toContain('"availableBytes":85899345920');
    expect(actions[0]).toContain('"rssBytes":200000000');
    expect(actions[1]).toBe("release:critical");

    at = 10_000;
    handle("critical");
    expect(actions[2]).toContain("cleanup deferred during cooldown");
    expect(actions.filter((item) => item.startsWith("release:"))).toHaveLength(1);

    at = 60_000;
    handle("critical");
    expect(actions.filter((item) => item.startsWith("release:"))).toHaveLength(2);
  });

  test("responds immediately to cgroup pressure, a low-memory transition, and severity escalation", () => {
    let at = 0;
    let snapshot = linuxSnapshot();
    const released: string[] = [];
    const handle = createMemoryPressureHandler({
      platform: "linux",
      release: (level) => { released.push(level); return []; },
      warn: () => {},
      now: () => at,
      snapshot: () => structuredClone(snapshot),
    });
    handle("warning");
    at += 1_000;
    handle("critical");
    at += 1_000;
    snapshot.cgroup!.hierarchy[0]!.events!.high = 1;
    handle("critical");
    at += 1_000;
    snapshot.host.availableBytes = 1 * 1024 ** 3;
    handle("critical");
    expect(released).toEqual(["warning", "critical", "critical", "critical"]);
  });

  test("responds when an ancestor approaches its memory limit", () => {
    let at = 0;
    const snapshot = linuxSnapshot();
    const released: string[] = [];
    const handle = createMemoryPressureHandler({
      platform: "linux",
      release: (level) => { released.push(level); return []; },
      warn: () => {},
      now: () => at,
      snapshot: () => structuredClone(snapshot),
    });
    handle("critical");
    snapshot.cgroup!.hierarchy[0]!.currentBytes = 3.64 * 1024 ** 3;
    at = 1_000;
    handle("critical");
    snapshot.cgroup!.hierarchy[0]!.currentBytes = 3.84 * 1024 ** 3;
    at = 2_000;
    handle("critical");
    expect(released).toHaveLength(3);
  });

  test("still releases resources if diagnostics fail, and reports release failures", () => {
    const warnings: string[] = [];
    const handle = createMemoryPressureHandler({
      platform: "linux",
      release: () => ["SQLite: unavailable"],
      warn: (message) => warnings.push(message),
      now: () => 0,
      snapshot: () => { throw new Error("unavailable"); },
    });
    handle("critical");
    expect(warnings[0]).toContain("diagnostics=null");
    expect(warnings[1]).toContain("SQLite: unavailable");
  });
});
