import { readFileSync } from "node:fs";
import { posix as path } from "node:path";

type ReadText = (file: string) => string | null;
type MemoryLimit = number | "max" | null;

export interface PressureReading {
  some: { avg10: number; avg60: number; totalUs: number };
  full: { avg10: number; avg60: number; totalUs: number } | null;
}

interface PressureSample {
  at: number;
  reading: PressureReading;
}

interface RecentStall {
  windowMs: number;
  someUs: number;
  fullUs: number | null;
}

export interface CgroupMemoryLevel {
  path: string;
  currentBytes: number | null;
  highBytes: MemoryLimit;
  maxBytes: MemoryLimit;
  events: Record<string, number> | null;
}

export interface LinuxMemorySnapshot {
  capturedAt: string;
  process: { rssBytes: number; heapUsedBytes: number; externalBytes: number } | null;
  host: {
    totalBytes: number | null;
    availableBytes: number | null;
    swapTotalBytes: number | null;
    swapFreeBytes: number | null;
    pressure: PressureReading | null;
    recentStall: RecentStall | null;
  };
  cgroup: {
    version: 1 | 2;
    path: string;
    pressure: PressureReading | null;
    recentStall: RecentStall | null;
    hierarchy: CgroupMemoryLevel[];
  } | null;
}

interface CgroupLocation {
  version: 1 | 2;
  groupPath: string;
  directory: string;
  mountPoint: string;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function parseNumber(value: string | null | undefined): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readNumber(read: ReadText, file: string): number | null {
  return parseNumber(read(file));
}

function readLimit(read: ReadText, file: string, version: 1 | 2): MemoryLimit {
  const text = read(file)?.trim();
  if (!text) return null;
  if (text === "max") return "max";
  // cgroup v1 represents an unlimited value with a page-aligned LONG_MAX.
  if (version === 1 && /^\d+$/.test(text) && Number(text) >= 2 ** 60) return "max";
  return parseNumber(text);
}

function parsePressure(text: string | null): PressureReading | null {
  if (!text) return null;
  const parseLine = (name: string) => {
    const line = text.split("\n").find((item) => item.startsWith(`${name} `));
    if (!line) return null;
    const values = Object.fromEntries(line.split(/\s+/).slice(1).map((item) => item.split("=", 2)));
    const avg10 = Number(values.avg10);
    const avg60 = Number(values.avg60);
    const totalUs = parseNumber(values.total);
    if (!Number.isFinite(avg10) || !Number.isFinite(avg60) || totalUs === null) return null;
    return { avg10, avg60, totalUs };
  };
  const some = parseLine("some");
  return some ? { some, full: parseLine("full") } : null;
}

function parseMeminfo(text: string | null): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of text?.split("\n") ?? []) {
    const match = /^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+)\s+kB\s*$/.exec(line);
    if (match) result[match[1]!] = Number(match[2]) * 1024;
  }
  return result;
}

function unescapeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

function findCgroup(read: ReadText): CgroupLocation | null {
  const groups = read("/proc/self/cgroup");
  const mounts = read("/proc/self/mountinfo");
  if (!groups || !mounts) return null;

  const groupEntries = groups.split("\n").flatMap<{ version: 1 | 2; groupPath: string }>((line) => {
    const match = /^\d+:([^:]*):(\/.*)$/.exec(line);
    if (!match) return [];
    const controllers = match[1]!.split(",");
    if (match[1] === "") return [{ version: 2 as const, groupPath: match[2]! }];
    return controllers.includes("memory") ? [{ version: 1 as const, groupPath: match[2]! }] : [];
  });

  const candidates: Array<CgroupLocation & { rootLength: number }> = [];
  for (const line of mounts.split("\n")) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (separator < 6) continue;
    const fsType = fields[separator + 1];
    const superOptions = fields[separator + 3]?.split(",") ?? [];
    const version = fsType === "cgroup2" ? 2 : fsType === "cgroup" && superOptions.includes("memory") ? 1 : null;
    if (!version) continue;
    const root = path.normalize(unescapeMountPath(fields[3]!));
    const mountPoint = path.normalize(unescapeMountPath(fields[4]!));
    for (const group of groupEntries) {
      if (group.version !== version) continue;
      const groupPath = path.normalize(group.groupPath);
      if (root !== "/" && groupPath !== root && !groupPath.startsWith(`${root}/`)) continue;
      const relative = root === "/" ? groupPath.slice(1) : groupPath.slice(root.length).replace(/^\//, "");
      candidates.push({ version, groupPath, directory: path.join(mountPoint, relative), mountPoint, rootLength: root.length });
    }
  }
  // On hybrid systems the v2 hierarchy can exist without the memory
  // controller; prefer the hierarchy that actually exposes memory usage.
  candidates.sort((a, b) => b.version - a.version || b.rootLength - a.rootLength);
  return candidates.find((candidate) => read(path.join(
    candidate.directory, candidate.version === 2 ? "memory.current" : "memory.usage_in_bytes",
  )) !== null) ?? candidates[0] ?? null;
}

function parseEvents(text: string | null): Record<string, number> | null {
  if (!text) return null;
  const events: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const match = /^(high|max|oom|oom_kill|oom_group_kill)\s+(\d+)$/.exec(line);
    if (match) {
      const count = parseNumber(match[2]);
      if (count !== null) events[match[1]!] = count;
    }
  }
  return Object.keys(events).length ? events : null;
}

function readCgroup(
  read: ReadText,
  location: CgroupLocation,
  sample: PressureSample | null,
  recentStall: RecentStall | null,
): LinuxMemorySnapshot["cgroup"] {
  const hierarchy: CgroupMemoryLevel[] = [];
  let directory = location.directory;
  while (true) {
    const v2 = location.version === 2;
    const failCount = v2 ? null : readNumber(read, path.join(directory, "memory.failcnt"));
    hierarchy.push({
      path: directory,
      currentBytes: readNumber(read, path.join(directory, v2 ? "memory.current" : "memory.usage_in_bytes")),
      highBytes: v2 ? readLimit(read, path.join(directory, "memory.high"), 2) : null,
      maxBytes: readLimit(read, path.join(directory, v2 ? "memory.max" : "memory.limit_in_bytes"), location.version),
      events: v2 ? parseEvents(read(path.join(directory, "memory.events"))) : failCount === null ? null : { max: failCount },
    });
    if (directory === location.mountPoint) break;
    const parent = path.dirname(directory);
    if (parent === directory || (
      !parent.startsWith(location.mountPoint === "/" ? "/" : `${location.mountPoint}/`) && parent !== location.mountPoint
    )) break;
    directory = parent;
  }
  return {
    version: location.version,
    path: location.groupPath,
    pressure: sample?.reading ?? null,
    recentStall,
    hierarchy,
  };
}

/** Linux-only diagnostics. The PSI sampler keeps a short, bounded history. */
export function createLinuxMemoryPressureMonitor(options: {
  read?: ReadText;
  now?: () => number;
  date?: () => Date;
  memoryUsage?: () => { rss: number; heapUsed: number; external: number };
} = {}) {
  const readSource = options.read ?? readText;
  const read: ReadText = (file) => {
    try {
      return readSource(file);
    } catch {
      return null;
    }
  };
  const now = options.now ?? (() => performance.now());
  const date = options.date ?? (() => new Date());
  const memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
  const hostSamples: PressureSample[] = [];
  const cgroupSamples: PressureSample[] = [];
  let cgroupLocation = findCgroup(read);

  function sampleFile(file: string, samples: PressureSample[], at: number, record: boolean): PressureSample | null {
    const reading = parsePressure(read(file));
    if (!reading) return null;
    const current = { at, reading };
    if (record) {
      samples.push(current);
      while (samples.length > 6) samples.shift();
    }
    return current;
  }

  function sample(record = true) {
    const at = now();
    return {
      host: sampleFile("/proc/pressure/memory", hostSamples, at, record),
      cgroup: cgroupLocation
        ? sampleFile(path.join(cgroupLocation.directory, "memory.pressure"), cgroupSamples, at, record) : null,
    };
  }

  function recentStall(samples: PressureSample[], latest: PressureSample | null): RecentStall | null {
    // This sampled interval is at least two seconds, but can be longer; it is
    // not the exact sliding window used by Bun's kernel PSI trigger.
    const baseline = latest && [...samples].reverse().find((item) => latest.at - item.at >= 2_000);
    if (latest && baseline && latest.at - baseline.at <= 5_000 && latest.reading.some.totalUs >= baseline.reading.some.totalUs) {
      const fullUs = latest.reading.full && baseline.reading.full
        && latest.reading.full.totalUs >= baseline.reading.full.totalUs
        ? latest.reading.full.totalUs - baseline.reading.full.totalUs : null;
      return { windowMs: Math.round(latest.at - baseline.at), someUs: latest.reading.some.totalUs - baseline.reading.some.totalUs, fullUs };
    }
    return null;
  }

  function snapshot(): LinuxMemorySnapshot {
    const location = findCgroup(read);
    if (location?.directory !== cgroupLocation?.directory || location?.version !== cgroupLocation?.version
      || location?.groupPath !== cgroupLocation?.groupPath) {
      cgroupSamples.length = 0;
    }
    cgroupLocation = location;
    // Event bursts should not evict the periodic samples needed for the window.
    const latest = sample(false);
    const meminfo = parseMeminfo(read("/proc/meminfo"));
    let processMemory: LinuxMemorySnapshot["process"] = null;
    try {
      const memory = memoryUsage();
      processMemory = { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external };
    } catch {
      // Memory diagnostics must never prevent pressure handling.
    }
    return {
      capturedAt: date().toISOString(),
      process: processMemory,
      host: {
        totalBytes: meminfo.MemTotal ?? null,
        availableBytes: meminfo.MemAvailable ?? null,
        swapTotalBytes: meminfo.SwapTotal ?? null,
        swapFreeBytes: meminfo.SwapFree ?? null,
        pressure: latest.host?.reading ?? null,
        recentStall: recentStall(hostSamples, latest.host),
      },
      cgroup: location ? readCgroup(read, location, latest.cgroup, recentStall(cgroupSamples, latest.cgroup)) : null,
    };
  }

  return { sample, snapshot };
}
