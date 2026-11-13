import { describe, expect, test } from "bun:test";
import { createLinuxMemoryPressureMonitor } from "./linux-memory-pressure";

const psi = (some: number, full = 0) =>
  `some avg10=1.25 avg60=0.50 avg300=0.10 total=${some}\nfull avg10=0.25 avg60=0.10 avg300=0.01 total=${full}\n`;

describe("Linux memory pressure diagnostics", () => {
  test("captures recent host stalls and the process cgroup's visible ancestor limits", () => {
    let at = 0;
    const files = new Map<string, string>([
      ["/proc/pressure/memory", psi(1_000, 100)],
      ["/proc/meminfo", "MemTotal: 100000 kB\nMemAvailable: 75000 kB\nSwapTotal: 10000 kB\nSwapFree: 3000 kB\n"],
      ["/proc/self/cgroup", "0::/parent/service\n"],
      ["/proc/self/mountinfo", "33 20 0:30 / /sys/fs/cgroup rw,nosuid - cgroup2 cgroup rw\n"],
      ["/sys/fs/cgroup/parent/service/memory.current", "50000000\n"],
      ["/sys/fs/cgroup/parent/service/memory.high", "80000000\n"],
      ["/sys/fs/cgroup/parent/service/memory.max", "max\n"],
      ["/sys/fs/cgroup/parent/service/memory.events", "low 0\nhigh 2\nmax 0\noom 0\noom_kill 0\n"],
      ["/sys/fs/cgroup/parent/service/memory.pressure", psi(400, 100)],
      ["/sys/fs/cgroup/parent/memory.current", "90000000\n"],
      ["/sys/fs/cgroup/parent/memory.high", "max\n"],
      ["/sys/fs/cgroup/parent/memory.max", "100000000\n"],
      ["/sys/fs/cgroup/parent/memory.events", "high 3\nmax 1\noom 0\noom_kill 0\n"],
    ]);
    const monitor = createLinuxMemoryPressureMonitor({
      read: (file) => files.get(file) ?? null,
      now: () => at,
      date: () => new Date("2026-10-29T15:00:00Z"),
      memoryUsage: () => ({ rss: 200, heapUsed: 100, external: 25 }),
    });
    monitor.sample();
    at = 1_000;
    files.set("/proc/pressure/memory", psi(50_000, 1_000));
    files.set("/sys/fs/cgroup/parent/service/memory.pressure", psi(440, 110));
    monitor.sample();
    at = 2_200;
    files.set("/proc/pressure/memory", psi(175_000, 5_000));
    files.set("/sys/fs/cgroup/parent/service/memory.pressure", psi(500, 120));
    const snapshot = monitor.snapshot();

    expect(snapshot.capturedAt).toBe("2026-10-29T15:00:00.000Z");
    expect(snapshot.process).toEqual({ rssBytes: 200, heapUsedBytes: 100, externalBytes: 25 });
    expect(snapshot.host.availableBytes).toBe(75_000 * 1024);
    expect(snapshot.host.pressure?.some.avg10).toBe(1.25);
    expect(snapshot.host.recentStall).toEqual({ windowMs: 2_200, someUs: 174_000, fullUs: 4_900 });
    expect(snapshot.cgroup?.path).toBe("/parent/service");
    expect(snapshot.cgroup?.pressure?.some.totalUs).toBe(500);
    expect(snapshot.cgroup?.recentStall).toEqual({ windowMs: 2_200, someUs: 100, fullUs: 20 });
    expect(snapshot.cgroup?.hierarchy).toEqual([
      { path: "/sys/fs/cgroup/parent/service", currentBytes: 50_000_000, highBytes: 80_000_000, maxBytes: "max", events: { high: 2, max: 0, oom: 0, oom_kill: 0 } },
      { path: "/sys/fs/cgroup/parent", currentBytes: 90_000_000, highBytes: "max", maxBytes: 100_000_000, events: { high: 3, max: 1, oom: 0, oom_kill: 0 } },
      { path: "/sys/fs/cgroup", currentBytes: null, highBytes: null, maxBytes: null, events: null },
    ]);
  });

  test("resolves cgroup v1 mounts and distinguishes unlimited limits", () => {
    const files = new Map<string, string>([
      ["/proc/self/cgroup", "4:cpu:/other\n5:memory:/docker/abc\n"],
      ["/proc/self/mountinfo", "31 20 0:25 /docker /sys/fs/my\\040cgroup rw - cgroup cgroup rw,memory\n"],
      ["/sys/fs/my cgroup/abc/memory.usage_in_bytes", "12345"],
      ["/sys/fs/my cgroup/abc/memory.limit_in_bytes", "9223372036854771712"],
      ["/sys/fs/my cgroup/abc/memory.failcnt", "4"],
      ["/sys/fs/my cgroup/memory.limit_in_bytes", "104857600"],
    ]);
    const monitor = createLinuxMemoryPressureMonitor({ read: (file) => files.get(file) ?? null });
    const group = monitor.snapshot().cgroup;
    expect(group?.version).toBe(1);
    expect(group?.hierarchy[0]).toEqual({ path: "/sys/fs/my cgroup/abc", currentBytes: 12_345, highBytes: null, maxBytes: "max", events: { max: 4 } });
    expect(group?.hierarchy[1]?.maxBytes).toBe(104_857_600);
  });

  test("uses the memory-enabled hierarchy on a hybrid cgroup host", () => {
    const files = new Map<string, string>([
      ["/proc/self/cgroup", "0::/app\n5:memory:/app\n"],
      ["/proc/self/mountinfo", "31 20 0:25 / /sys/fs/cgroup/unified rw - cgroup2 cgroup rw\n32 20 0:26 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory\n"],
      ["/sys/fs/cgroup/memory/app/memory.usage_in_bytes", "12345"],
      ["/sys/fs/cgroup/memory/app/memory.limit_in_bytes", "104857600"],
    ]);
    const group = createLinuxMemoryPressureMonitor({ read: (file) => files.get(file) ?? null }).snapshot().cgroup;
    expect(group?.version).toBe(1);
    expect(group?.hierarchy[0]?.maxBytes).toBe(104_857_600);
  });

  test("does not mix pressure histories after the process moves to another cgroup", () => {
    let at = 0;
    const files = new Map<string, string>([
      ["/proc/self/cgroup", "0::/first\n"],
      ["/proc/self/mountinfo", "33 20 0:30 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n"],
      ["/sys/fs/cgroup/first/memory.current", "100"],
      ["/sys/fs/cgroup/first/memory.pressure", psi(100)],
      ["/sys/fs/cgroup/second/memory.current", "200"],
      ["/sys/fs/cgroup/second/memory.pressure", psi(500)],
    ]);
    const monitor = createLinuxMemoryPressureMonitor({ read: (file) => files.get(file) ?? null, now: () => at });
    monitor.sample();
    at = 3_000;
    files.set("/proc/self/cgroup", "0::/second\n");
    const snapshot = monitor.snapshot();
    expect(snapshot.cgroup?.path).toBe("/second");
    expect(snapshot.cgroup?.pressure?.some.totalUs).toBe(500);
    expect(snapshot.cgroup?.recentStall).toBeNull();
  });

  test("preserves the sampled window during a burst of pressure events", () => {
    let at = 0;
    const monitor = createLinuxMemoryPressureMonitor({
      read: (file) => file === "/proc/pressure/memory" ? psi(at) : null,
      now: () => at,
    });
    monitor.sample();
    at = 1_000;
    monitor.sample();
    at = 2_100;
    for (let i = 0; i < 10; i++) {
      expect(monitor.snapshot().host.recentStall).toEqual({ windowMs: 2_100, someUs: 2_100, fullUs: 0 });
    }
  });

  test("reports unavailable diagnostics without reusing stale PSI samples", () => {
    let available = true;
    const monitor = createLinuxMemoryPressureMonitor({
      read: (file) => {
        if (!available) throw new Error("unavailable");
        return file === "/proc/pressure/memory" ? psi(100) : null;
      },
      memoryUsage: () => { throw new Error("unavailable"); },
    });
    monitor.sample();
    available = false;
    const snapshot = monitor.snapshot();
    expect(snapshot.host.pressure).toBeNull();
    expect(snapshot.host.recentStall).toBeNull();
    expect(snapshot.process).toBeNull();
    expect(snapshot.cgroup).toBeNull();
  });
});
