import { WorkerHost } from "./worker-host";
import * as managerSvc from "./manager.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

const runningExtensions = new Map<string, WorkerHost>();

export async function startAllExtensions(): Promise<void> {
  const extensions = managerSvc.getEnabledExtensions();
  console.log(`[Spindle] Starting ${extensions.length} extension(s)...`);

  for (const ext of extensions) {
    try {
      await startExtension(ext.id);
    } catch (err: any) {
      console.error(
        `[Spindle] Failed to start extension ${ext.identifier}:`,
        err.message
      );
    }
  }
}

export async function stopAllExtensions(): Promise<void> {
  console.log(`[Spindle] Stopping ${runningExtensions.size} extension(s)...`);

  const stopPromises: Promise<void>[] = [];
  for (const [id, host] of runningExtensions) {
    stopPromises.push(
      host.stop().catch((err) => {
        console.error(
          `[Spindle] Error stopping extension ${host.manifest.identifier}:`,
          err
        );
      })
    );
  }

  await Promise.all(stopPromises);
  runningExtensions.clear();
}

export async function startExtension(id: string): Promise<void> {
  if (runningExtensions.has(id)) {
    console.warn(`[Spindle] Extension ${id} is already running`);
    return;
  }

  const ext = managerSvc.getExtension(id);
  if (!ext) throw new Error(`Extension not found: ${id}`);

  // Sync manifest from disk → DB before starting (picks up spindle.json edits)
  managerSvc.syncManifestToDb(ext.identifier);

  try {
    // Re-fetch after sync in case permissions/metadata changed
    const freshExt = managerSvc.getExtension(id) ?? ext;
    const manifest = managerSvc.getManifest(freshExt.identifier);
    const host = new WorkerHost(freshExt.id, manifest, freshExt);
    await host.start();
    runningExtensions.set(id, host);

    eventBus.emit(EventType.SPINDLE_EXTENSION_LOADED, {
      extensionId: ext.id,
      identifier: ext.identifier,
      name: ext.name,
    });

    console.log(`[Spindle] Started extension: ${ext.identifier}`);
  } catch (err: any) {
    eventBus.emit(EventType.SPINDLE_EXTENSION_ERROR, {
      extensionId: ext.id,
      identifier: ext.identifier,
      error: err.message,
    });
    throw err;
  }
}

export async function stopExtension(id: string): Promise<void> {
  const host = runningExtensions.get(id);
  if (!host) return;

  await host.stop();
  runningExtensions.delete(id);

  eventBus.emit(EventType.SPINDLE_EXTENSION_UNLOADED, {
    extensionId: id,
    identifier: host.manifest.identifier,
    name: host.manifest.name,
  });

  console.log(`[Spindle] Stopped extension: ${host.manifest.identifier}`);
}

export async function restartExtension(id: string): Promise<void> {
  await stopExtension(id);
  await startExtension(id);
}

/**
 * Notify a running extension that a permission was granted or revoked.
 * The worker updates its internal cache and fires onChanged handlers —
 * no restart needed.
 */
export function notifyPermissionChanged(
  id: string,
  permission: string,
  granted: boolean,
  allGranted: string[]
): void {
  const host = runningExtensions.get(id);
  if (!host) return;
  host.notifyPermissionChanged(permission, granted, allGranted);
}

export function getRunningExtensions(): Map<string, WorkerHost> {
  return runningExtensions;
}

export function isRunning(id: string): boolean {
  return runningExtensions.has(id);
}

export function getWorkerHost(id: string): WorkerHost | undefined {
  return runningExtensions.get(id);
}
