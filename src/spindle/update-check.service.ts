import * as managerSvc from "./manager.service";
import { probeGitRepositoryForUpdate } from "./update-check-git";

const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1_000;
const UPDATE_CHECK_CONCURRENCY = 3;

export interface ExtensionUpdateInfo {
  extensionId: string;
  identifier: string;
  name: string;
  currentVersion: string;
  branch: string;
  localCommit: string;
  remoteCommit: string;
}

export interface ExtensionUpdateSnapshot {
  updates: ExtensionUpdateInfo[];
  checkedAt: number | null;
  checking: boolean;
}

let cachedUpdates = new Map<string, ExtensionUpdateInfo>();
const cacheGenerationByExtensionId = new Map<string, number>();
const activeExtensionChecks = new Map<
  string,
  Promise<ExtensionUpdateSnapshot>
>();
let lastCheckedAt: number | null = null;
let activeCheck: Promise<ExtensionUpdateSnapshot> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;

async function inspectExtension(
  ext: managerSvc.ExtensionUpdateCandidate,
): Promise<
  | { kind: "replace"; update: ExtensionUpdateInfo }
  | { kind: "remove" }
  | { kind: "retain" }
> {
  try {
    const manifest = await managerSvc.getManifest(ext.identifier);
    if ((manifest as { dev_mode?: boolean }).dev_mode === true) {
      return { kind: "remove" };
    }

    const probe = await probeGitRepositoryForUpdate(
      managerSvc.getRepoPath(ext.identifier),
      ext.branch,
    );

    if (probe.status === "unavailable") return { kind: "retain" };
    if (probe.status !== "update") return { kind: "remove" };

    return {
      kind: "replace",
      update: {
        extensionId: ext.id,
        identifier: ext.identifier,
        name: ext.name,
        currentVersion: ext.version,
        branch: probe.branch,
        localCommit: probe.localCommit,
        remoteCommit: probe.remoteCommit,
      },
    };
  } catch {
    // A malformed/missing manifest or transient filesystem error should not
    // make a previously known update flicker out of the UI.
    return { kind: "retain" };
  }
}

async function checkAllExtensions(): Promise<ExtensionUpdateSnapshot> {
  const extensions = managerSvc.listExtensionUpdateCandidates();
  const enabledIds = new Set(extensions.map((ext) => ext.id));

  for (const extensionId of cachedUpdates.keys()) {
    if (!enabledIds.has(extensionId)) cachedUpdates.delete(extensionId);
  }

  let nextIndex = 0;
  const workerCount = Math.min(
    UPDATE_CHECK_CONCURRENCY,
    Math.max(1, extensions.length),
  );
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const ext = extensions[nextIndex++];
        if (!ext) return;

        const cacheGeneration = cacheGenerationByExtensionId.get(ext.id) ?? 0;
        const result = await inspectExtension(ext);
        if (
          (cacheGenerationByExtensionId.get(ext.id) ?? 0) !== cacheGeneration
        ) {
          continue;
        }
        if (result.kind === "replace") {
          cachedUpdates.set(ext.id, result.update);
        } else if (result.kind === "remove") {
          cachedUpdates.delete(ext.id);
        }
      }
    }),
  );

  lastCheckedAt = Date.now();
  return getExtensionUpdateSnapshot();
}

export function refreshExtensionUpdates(): Promise<ExtensionUpdateSnapshot> {
  if (activeCheck) return activeCheck;

  activeCheck = checkAllExtensions()
    .catch((err) => {
      console.warn(
        "[Spindle] Extension update check failed:",
        err instanceof Error ? err.message : err,
      );
      return getExtensionUpdateSnapshot();
    })
    .finally(() => {
      activeCheck = null;
    });
  return activeCheck;
}

/** Check one newly enabled extension without waiting for the next full sweep. */
export function refreshExtensionUpdate(
  extensionId: string,
): Promise<ExtensionUpdateSnapshot> {
  const existing = activeExtensionChecks.get(extensionId);
  if (existing) return existing;

  const check = (async () => {
    const ext = managerSvc
      .listExtensionUpdateCandidates()
      .find((candidate) => candidate.id === extensionId);
    if (!ext) {
      clearCachedExtensionUpdate(extensionId);
      return getExtensionUpdateSnapshot();
    }

    const cacheGeneration =
      cacheGenerationByExtensionId.get(extensionId) ?? 0;
    const result = await inspectExtension(ext);
    if (
      (cacheGenerationByExtensionId.get(extensionId) ?? 0) === cacheGeneration
    ) {
      if (result.kind === "replace") {
        cachedUpdates.set(extensionId, result.update);
      } else if (result.kind === "remove") {
        cachedUpdates.delete(extensionId);
      }
    }
    lastCheckedAt = Date.now();
    return getExtensionUpdateSnapshot();
  })()
    .catch((err) => {
      console.warn(
        `[Spindle] Extension update check failed for ${extensionId}:`,
        err instanceof Error ? err.message : err,
      );
      return getExtensionUpdateSnapshot();
    })
    .finally(() => {
      activeExtensionChecks.delete(extensionId);
    });

  activeExtensionChecks.set(extensionId, check);
  return check;
}

export function getExtensionUpdateSnapshot(): ExtensionUpdateSnapshot {
  return {
    updates: [...cachedUpdates.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    ),
    checkedAt: lastCheckedAt,
    checking: activeCheck !== null,
  };
}

export function clearCachedExtensionUpdate(extensionId: string): void {
  cachedUpdates.delete(extensionId);
  cacheGenerationByExtensionId.set(
    extensionId,
    (cacheGenerationByExtensionId.get(extensionId) ?? 0) + 1,
  );
}

export function startExtensionUpdateMonitor(): void {
  if (intervalTimer) return;

  intervalTimer = setInterval(() => {
    void refreshExtensionUpdates();
  }, UPDATE_CHECK_INTERVAL_MS);

  if (typeof intervalTimer.unref === "function") intervalTimer.unref();
  void refreshExtensionUpdates();
}

export function stopExtensionUpdateMonitor(): void {
  if (intervalTimer) clearInterval(intervalTimer);
  intervalTimer = null;
}
