import { getDb } from "../db/connection";
import { releaseDatabaseMemory } from "../db/maintenance";
import { clearCapabilityCache } from "../image-gen/comfyui-discovery";
import { clearOpenRouterMetadataCache } from "../llm/providers/openrouter";
import { clearMacroAstCache } from "../macros/MacroParser";
import { releaseIdleRegexWorkers } from "../utils/regex-sandbox";
import { releaseIdleCortexWarmWorker } from "./cortex-warm-worker-client";
import { clearAllResolveCache } from "./databank/mention-resolver.service";
import { clearAllDatabankCache } from "./databank/retrieval-cache.service";
import { releaseIdleWebPageParserWorkers } from "./databank/web-page-parser-worker-client";
import { resetDisplayRegexCache } from "./display-regex.service";
import { embeddingCache } from "./embedding-cache";
import { clearCortexResultCaches } from "./memory-cortex";
import { releaseIdleHeuristicWorkers } from "./memory-cortex/heuristic-worker-host";
import { clearStmtCache } from "./pagination";
import { releaseIdlePromptAssemblyWorkers } from "./prompt-assembly-worker-client";
import { releaseSharpCacheMemory } from "./sharp-settings.service";
import { clearVectorWorldInfoCache } from "./prompt-assembly.service";
import { releaseTokenizerMemory } from "./tokenizer.service";
import { clearWorldInfoActivationCache } from "./world-info-activation.service";
import { createLinuxMemoryPressureMonitor, type LinuxMemorySnapshot } from "./linux-memory-pressure";

export type MemoryPressureLevel = "warning" | "critical";

const releasers: ReadonlyArray<readonly [string, () => unknown]> = [
  ["tokenizers", releaseTokenizerMemory],
  ["embeddings", () => embeddingCache.clearMemory()],
  ["memory cortex", clearCortexResultCaches],
  ["vector world info", clearVectorWorldInfoCache],
  ["world info activation", clearWorldInfoActivationCache],
  ["display regex", resetDisplayRegexCache],
  ["databank retrieval", clearAllDatabankCache],
  ["databank mentions", clearAllResolveCache],
  ["macro ASTs", clearMacroAstCache],
  ["ComfyUI capabilities", clearCapabilityCache],
  ["OpenRouter metadata", clearOpenRouterMetadataCache],
  ["prepared statements", clearStmtCache],
  ["Sharp cache", releaseSharpCacheMemory],
  ["prompt assembly workers", releaseIdlePromptAssemblyWorkers],
  ["cortex heuristic workers", releaseIdleHeuristicWorkers],
  ["regex workers", releaseIdleRegexWorkers],
  ["cortex warm worker", releaseIdleCortexWarmWorker],
  ["web parser workers", releaseIdleWebPageParserWorkers],
];

const criticalReleasers: ReadonlyArray<readonly [string, () => unknown]> = [
  ["SQLite", () => releaseDatabaseMemory(getDb())],
  ["garbage collector", () => Bun.gc(true)],
];

let installed = false;

/** Release only derived state and idle resources; active work is left untouched. */
export function releaseMemoryPressureResources(level: MemoryPressureLevel): string[] {
  const failures: string[] = [];
  const selected = level === "critical" ? [...releasers, ...criticalReleasers] : releasers;
  for (const [name, release] of selected) {
    try {
      release();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

const LINUX_CLEANUP_COOLDOWN_MS = 60_000;
const MiB = 1024 * 1024;

function linuxPressureWorsened(previous: LinuxMemorySnapshot | null, current: LinuxMemorySnapshot | null): boolean {
  if (!current) return false;
  const available = current.host.availableBytes;
  const total = current.host.totalBytes;
  const oldAvailable = previous?.host.availableBytes;
  if (available !== null && total !== null) {
    const lowWatermark = Math.min(2 * 1024 * MiB, total * 0.05);
    if (available <= lowWatermark && (
      oldAvailable == null || oldAvailable > lowWatermark
      || oldAvailable - available >= Math.max(64 * MiB, oldAvailable * 0.1)
    )) return true;
  }

  for (const level of current.cgroup?.hierarchy ?? []) {
    const oldLevel = previous?.cgroup?.hierarchy.find((candidate) => candidate.path === level.path);
    if (level.events && oldLevel?.events) {
      for (const key of ["high", "max", "oom", "oom_kill", "oom_group_kill"]) {
        if (level.events[key] !== undefined && oldLevel.events[key] !== undefined
          && level.events[key]! > oldLevel.events[key]!) return true;
      }
    }
    // React immediately when any visible cgroup or ancestor approaches a limit,
    // including when a newly discoverable limit was not in the prior snapshot.
    for (const key of ["highBytes", "maxBytes"] as const) {
      const limit = level[key];
      if (typeof limit !== "number" || limit <= 0 || level.currentBytes === null) continue;
      const oldLimit = oldLevel?.[key];
      const oldRatio = typeof oldLimit === "number" && oldLimit > 0 && oldLevel?.currentBytes != null
        ? oldLevel.currentBytes / oldLimit : null;
      const ratio = level.currentBytes / limit;
      if (ratio >= 0.9 && (oldRatio === null || oldRatio < 0.9 || ratio - oldRatio >= 0.025)) return true;
    }
  }
  return false;
}

/** @internal Dependencies are injectable to verify platform-specific behavior. */
export function createMemoryPressureHandler(options: {
  platform: NodeJS.Platform;
  release: (level: MemoryPressureLevel) => string[];
  warn: (message: string) => void;
  now: () => number;
  snapshot?: () => LinuxMemorySnapshot;
}): (level: MemoryPressureLevel) => void {
  let lastCleanup: { at: number; level: MemoryPressureLevel; snapshot: LinuxMemorySnapshot | null } | null = null;
  return (level) => {
    if (options.platform !== "linux") {
      const failures = options.release(level);
      if (failures.length === 0) {
        options.warn(`[runtime] ${level} memory pressure: released reconstructable state and idle resources`);
      } else {
        options.warn(`[runtime] ${level} memory pressure: resource release completed with errors: ${failures.join("; ")}`);
      }
      return;
    }

    let snapshot: LinuxMemorySnapshot | null = null;
    try {
      snapshot = options.snapshot?.() ?? null;
    } catch {
      // Failure to read diagnostic data must not stop memory release.
    }
    const at = options.now();
    const elapsed = lastCleanup ? at - lastCleanup.at : Infinity;
    const escalated = lastCleanup && (
      (lastCleanup.level === "warning" && level === "critical")
      || linuxPressureWorsened(lastCleanup.snapshot, snapshot)
    );
    const release = !lastCleanup || elapsed < 0 || elapsed >= LINUX_CLEANUP_COOLDOWN_MS || escalated;
    const action = release ? "releasing reconstructable state and idle resources" : "cleanup deferred during cooldown";
    options.warn(`[runtime] ${level} memory pressure: ${action}; diagnostics=${JSON.stringify(snapshot)}`);
    if (!release) return;
    lastCleanup = { at, level, snapshot };
    const failures = options.release(level);
    if (failures.length > 0) {
      options.warn(`[runtime] ${level} memory pressure: resource release completed with errors: ${failures.join("; ")}`);
    }
  };
}

export function installMemoryPressureHandler(): void {
  if (installed) return;
  installed = true;
  const monitor = process.platform === "linux" ? createLinuxMemoryPressureMonitor() : null;
  if (monitor) {
    monitor.sample();
    const timer = setInterval(monitor.sample, 1_000);
    timer.unref();
  }
  process.on("memoryPressure", createMemoryPressureHandler({
    platform: process.platform,
    release: releaseMemoryPressureResources,
    warn: (message) => console.warn(message),
    now: () => performance.now(),
    snapshot: monitor?.snapshot,
  }));
}
