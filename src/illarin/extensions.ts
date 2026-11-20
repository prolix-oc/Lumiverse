import { strFromU8, unzipSync } from "fflate";
import type { ExtensionInfo } from "lumiverse-spindle-types";
import * as managerSvc from "../spindle/manager.service";
import * as lifecycle from "../spindle/lifecycle";
import * as svc from "../services/illarin-instance.service";
import * as presetsSvc from "../services/presets.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { IllarinApiError, syncLibrary } from "./api";
import { clearPermissionError, hasPermissionError, setPermissionError } from "./permission-state";
import { withAccessToken } from "./tokens";
import { readBackendVersion } from "./warmup";
import type { IllarinDelivery, LibrarySyncEntry, TakedownNotice } from "./types";
import { getIllarinPresetWorkId, getIllarinPresetVersionNumber } from "./preset-metadata";

const MAX_ARCHIVE_FILES = 4096;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const NOTICE_DURATION_MS = 30_000;

interface IllarinSource {
  workId: string;
  versionNumber?: number;
  takenDownAt?: string;
  permissionsApproved?: boolean;
}

const refusedDeliveries = new Set<string>();

function isMacJunk(name: string): boolean {
  return name.startsWith("__MACOSX/") || name.split("/").pop() === ".DS_Store";
}

function manifestRoot(names: readonly string[]): string {
  let root = "";
  while (!names.includes(`${root}spindle.json`)) {
    const folder = names[0]?.slice(root.length).split("/")[0];
    if (!folder || !names.every((name) => name.startsWith(`${root}${folder}/`))) {
      throw new Error("The extension archive has no spindle.json at its top or inside the one folder that holds everything");
    }
    root = `${root}${folder}/`;
  }
  return root;
}

export function readExtensionArchive(bytes: Uint8Array): Map<string, Uint8Array> {
  let files = 0;
  let expanded = 0;
  const entries = unzipSync(bytes, {
    filter: (entry) => {
      const name = entry.name.replace(/\\/g, "/");
      if (name.endsWith("/") || isMacJunk(name)) return false;
      if (name.startsWith("/") || name.split("/").some((segment) => segment === ".." || segment === ".")) {
        throw new Error("The extension archive contains an unsafe path");
      }
      files++;
      expanded += entry.originalSize;
      if (files > MAX_ARCHIVE_FILES) throw new Error(`The extension archive holds more than ${MAX_ARCHIVE_FILES} files`);
      if (expanded > MAX_EXPANDED_BYTES) throw new Error("The extension archive expands beyond the safe limit");
      return true;
    },
  });
  const archive = new Map(Object.entries(entries).map(([name, data]) => [name.replace(/\\/g, "/"), data]));
  const root = manifestRoot([...archive.keys()]);
  return new Map(
    [...archive]
      .filter(([name]) => name.startsWith(root))
      .map(([name, data]) => [name.slice(root.length), data]),
  );
}

function manifestIdentifier(files: ReadonlyMap<string, Uint8Array>): string {
  const manifest = JSON.parse(strFromU8(files.get("spindle.json")!)) as { identifier?: unknown };
  if (typeof manifest.identifier !== "string") throw new Error("spindle.json has no identifier");
  return manifest.identifier;
}

function illarinSource(ext: ExtensionInfo): IllarinSource | null {
  const source = ext.metadata?.illarin as (IllarinSource & { assetId?: string; withheldAt?: string }) | undefined;
  if (!source) return null;
  const workId = source.workId ?? source.assetId;
  if (typeof workId !== "string") return null;
  return {
    workId,
    ...(source.versionNumber === undefined ? {} : { versionNumber: source.versionNumber }),
    ...(source.takenDownAt || source.withheldAt ? { takenDownAt: source.takenDownAt ?? source.withheldAt } : {}),
    permissionsApproved: source.permissionsApproved ?? true,
  };
}

function notify(userId: string, ext: ExtensionInfo, type: "warning" | "error", message: string): void {
  eventBus.emit(EventType.SPINDLE_TOAST, {
    extensionId: ext.id,
    extensionName: ext.name,
    type,
    title: "Illarin",
    message,
    duration: NOTICE_DURATION_MS,
  }, userId);
}

function emitStatus(ext: ExtensionInfo, operation: string): void {
  eventBus.emit(EventType.SPINDLE_EXTENSION_STATUS, { extensionId: ext.id, operation, name: ext.name });
}

export async function installExtensionDelivery(
  userId: string,
  delivery: IllarinDelivery,
  archive: Uint8Array,
): Promise<void> {
  const files = readExtensionArchive(archive);
  const source: IllarinSource = { workId: delivery.workId, versionNumber: delivery.versionNumber };
  const installed = await managerSvc.getExtensionByIdentifier(manifestIdentifier(files));
  if (!installed) {
    const extension = await managerSvc.installFromFiles(files, { illarin: { ...source, permissionsApproved: false } });
    emitStatus(extension, "installed");
    notify(userId, extension, "warning", `Installed ${extension.name} disabled. Review and approve its permissions under Extensions before its first run.`);
  } else if (illarinSource(installed)?.workId === delivery.workId) {
    await updateExtension(userId, installed, files, source);
  } else {
    await refuseReplacement(userId, delivery, installed);
  }
  void reportLibraryChangeToAll(delivery.workId, delivery.versionNumber);
}

async function updateExtension(
  userId: string,
  ext: ExtensionInfo,
  files: ReadonlyMap<string, Uint8Array>,
  source: IllarinSource,
): Promise<void> {
  emitStatus(ext, "updating");
  if (lifecycle.isRunning(ext.id)) {
    await lifecycle.stopExtension(ext.id);
    await lifecycle.settleRuntimeBoundary();
  }
  const updated = await managerSvc.replaceFromFiles(ext.identifier, files);
  managerSvc.setMetadataEntry(ext.identifier, "illarin", { ...source, permissionsApproved: illarinSource(ext)?.permissionsApproved ?? false });
  if (ext.enabled) {
    await lifecycle.settleRuntimeBoundary();
    await lifecycle.startExtension(ext.id);
  }
  emitStatus(ext, "updated");

  const added = updated.permissions.filter((permission) => !ext.permissions.includes(permission));
  if (added.length > 0) {
    notify(userId, updated, "warning", `This update asks for new permissions: ${added.join(", ")}. Turn them on under Extensions to allow them.`);
  }
}

async function refuseReplacement(userId: string, delivery: IllarinDelivery, installed: ExtensionInfo): Promise<never> {
  if (!refusedDeliveries.has(delivery.id)) {
    refusedDeliveries.add(delivery.id);
    const illarinUrl = (await svc.getIllarinInstance(userId))?.illarinUrl ?? "";
    const other = illarinSource(installed);
    const origin = other ? `Illarin work ${other.workId} on ${illarinUrl}` : installed.github || "another source";
    notify(
      userId,
      installed,
      "error",
      `Illarin sent ${delivery.name} (work ${delivery.workId} on ${illarinUrl}), but ${installed.identifier} is already installed from ${origin}. Nothing was changed. Remove the installed one if you want the send to install.`,
    );
  }
  throw new Error(`${installed.identifier} is already installed from another source`);
}

export async function recordWithheld(userId: string, notices: readonly TakedownNotice[]): Promise<void> {
  if (notices.length === 0) return;
  const extensions = await managerSvc.list();
  for (const notice of notices) {
    for (const ext of extensions) {
      const source = illarinSource(ext);
      if (source?.workId !== notice.workId) continue;
      managerSvc.setMetadataEntry(ext.identifier, "illarin", { ...source, takenDownAt: notice.takenDownAt });
      notify(userId, ext, "warning", `Illarin has taken down ${notice.name}. It stays installed as it is. Switch it off or remove it under Extensions if you no longer want it.`);
    }
  }
}

export async function buildIllarinLibraryEntries(userId: string): Promise<LibrarySyncEntry[]> {
  const entries = new Map<string, LibrarySyncEntry>();
  const add = (entry: LibrarySyncEntry) => {
    const previous = entries.get(entry.workId);
    if (!previous || (entry.versionNumber !== undefined &&
      (previous.versionNumber === undefined || entry.versionNumber > previous.versionNumber))) {
      entries.set(entry.workId, entry);
    }
  };
  for (const preset of presetsSvc.listPresetsForManifest(userId)) {
    const workId = getIllarinPresetWorkId(preset.metadata);
    if (!workId) continue;
    const versionNumber = getIllarinPresetVersionNumber(preset.metadata);
    add({ workId, ...(versionNumber === undefined ? {} : { versionNumber }) });
  }
  for (const ext of await managerSvc.list()) {
    const source = illarinSource(ext);
    if (source) add({ workId: source.workId, ...(source.versionNumber === undefined ? {} : { versionNumber: source.versionNumber }) });
  }
  return [...entries.values()];
}

async function sendReport(
  userId: string,
  entries: LibrarySyncEntry[] | null,
  removed: string[] = [],
  changedPresetWorkId?: string,
): Promise<void> {
  const instance = await svc.getIllarinInstance(userId);
  if (!instance?.scopes.includes("library:sync")) return;
  const snapshot = entries === null;
  let currentEntries = entries ?? await buildIllarinLibraryEntries(userId);
  if (changedPresetWorkId) {
    // Resolve when the queued report runs: another copy may still be installed,
    // or a later delivery may already have advanced the version.
    currentEntries = (await buildIllarinLibraryEntries(userId)).filter((entry) => entry.workId === changedPresetWorkId);
    removed = currentEntries.length === 0 ? [changedPresetWorkId] : [];
  }
  const appVersion = await readBackendVersion();
  const result = await withAccessToken(userId, (accessToken) =>
    syncLibrary(instance.illarinUrl, accessToken, { snapshot, appVersion, entries: currentEntries, ...(snapshot ? {} : { removed }) }));
  if (result) {
    clearPermissionError(userId, "library:sync");
    await recordWithheld(userId, result.takedowns);
  }
}

function warnReportFailed(err: unknown, userId: string): void {
  if (err instanceof IllarinApiError && err.status === 403) {
    setPermissionError(userId, "library:sync");
    return;
  }
  console.warn("[Illarin] Library report failed:", err instanceof Error ? err.message : err);
}

const reports = new Map<string, Promise<void>>();

function queueReport(userId: string, entries: LibrarySyncEntry[] | null, removed: string[] = [], changedPresetWorkId?: string): Promise<void> {
  if (hasPermissionError(userId, "library:sync")) return Promise.resolve();
  const task = (reports.get(userId) ?? Promise.resolve())
    .then(() => sendReport(userId, entries, removed, changedPresetWorkId))
    .catch((err) => warnReportFailed(err, userId))
    .finally(() => { if (reports.get(userId) === task) reports.delete(userId); });
  reports.set(userId, task);
  return task;
}

export function reportLibrary(userId: string): Promise<void> {
  return queueReport(userId, null);
}

export function reportPresetLibraryChange(userId: string, workId: string): Promise<void> {
  return queueReport(userId, [], [], workId);
}

/** Presets belong to the receiving user; extensions remain installation-wide. */
export function subscribePresetLibraryChanges(userId: string): () => void {
  const disposers = [
    eventBus.on(EventType.LUMIHUB_INSTALL_COMPLETED, (event) => {
      if (event.userId !== userId || event.payload.source !== "illarin" || event.payload.type !== "preset") return;
      const preset = presetsSvc.getPreset(userId, event.payload.characterId);
      const workId = getIllarinPresetWorkId(preset?.metadata);
      if (workId) void reportPresetLibraryChange(userId, workId);
    }),
    eventBus.on(EventType.PRESET_DELETED, (event) => {
      if (event.userId === userId && typeof event.payload.illarinWorkId === "string") {
        void reportPresetLibraryChange(userId, event.payload.illarinWorkId);
      }
    }),
  ];
  return () => { for (const dispose of disposers) dispose(); };
}

function reportLibraryDeltaToAll(entries: LibrarySyncEntry[], removed: string[]): Promise<void> {
  return svc.listIllarinInstances()
    .then(async (instances) => {
      for (const instance of instances) await queueReport(instance.userId, entries, removed);
    })
    .catch((err) => console.warn("[Illarin] Library report dispatch failed:", err instanceof Error ? err.message : err));
}

export function reportLibraryChangeToAll(workId: string, versionNumber: number): Promise<void> {
  return reportLibraryDeltaToAll([{ workId, versionNumber }], []);
}

export function reportLibraryRemovalToAll(workId: string): Promise<void> {
  return reportLibraryDeltaToAll([], [workId]);
}
