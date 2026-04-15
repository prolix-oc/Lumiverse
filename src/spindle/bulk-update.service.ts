/**
 * Bulk extension update orchestrator.
 *
 * Runs extension updates sequentially in a background task so the HTTP
 * route returns immediately and the JS event loop stays free between steps.
 * Emits per-extension SPINDLE_EXTENSION_STATUS events (consumed by the
 * existing per-card UI) and aggregate SPINDLE_BULK_UPDATE_PROGRESS /
 * SPINDLE_BULK_UPDATE_COMPLETE events (consumed by the Update All button).
 *
 * Policy:
 *   - Update every extension the caller can manage (owner/admin = all,
 *     regular user = only their own user-scoped extensions).
 *   - Disabled extensions are still updated (they may be disabled because
 *     of a bug that's now fixed upstream), but they stay disabled — we do
 *     not auto-enable them.
 *   - Extensions that were running before the update are stopped, updated,
 *     then restarted (matches single-extension update behavior).
 *   - Per-extension failures are collected but do not abort the run.
 *   - A process-wide mutex prevents overlapping bulk runs.
 */

import * as managerSvc from "./manager.service";
import * as lifecycle from "./lifecycle";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { ExtensionInfo } from "lumiverse-spindle-types";

let bulkUpdateInProgress = false;

export interface BulkUpdateError {
  id: string;
  name: string;
  error: string;
}

export interface ScheduleResult {
  total: number;
}

/**
 * Kick off a bulk update. Returns as soon as the work is scheduled — the
 * actual updates run in a background task. Throws if another bulk update
 * is already in progress.
 */
export async function updateAllExtensions(opts: {
  userId: string;
  isPrivileged: boolean;
}): Promise<ScheduleResult> {
  if (bulkUpdateInProgress) {
    throw new Error("A bulk extension update is already running");
  }

  const all = await managerSvc.listForUser(
    opts.userId,
    opts.isPrivileged ? "owner" : "user"
  );
  const targets = all.filter((ext) =>
    managerSvc.canManageExtension(
      ext,
      opts.userId,
      opts.isPrivileged ? "owner" : "user"
    )
  );

  bulkUpdateInProgress = true;

  // Fire-and-forget; never let an unhandled rejection escape.
  void runBulkUpdate(targets, opts.userId)
    .catch((err) => {
      console.error("[Spindle] Bulk update loop crashed:", err);
      eventBus.emit(
        EventType.SPINDLE_BULK_UPDATE_COMPLETE,
        {
          total: targets.length,
          updated: 0,
          failed: targets.length,
          errors: targets.map((t) => ({
            id: t.id,
            name: t.name,
            error: err?.message || "Bulk update failed",
          })),
        },
        opts.userId
      );
    })
    .finally(() => {
      bulkUpdateInProgress = false;
    });

  return { total: targets.length };
}

export function isBulkUpdateInProgress(): boolean {
  return bulkUpdateInProgress;
}

async function runBulkUpdate(
  targets: ExtensionInfo[],
  userId: string
): Promise<void> {
  let updated = 0;
  let failed = 0;
  const errors: BulkUpdateError[] = [];

  // Initial progress tick so the UI can render "0/N" immediately.
  eventBus.emit(
    EventType.SPINDLE_BULK_UPDATE_PROGRESS,
    {
      total: targets.length,
      completed: 0,
      failed: 0,
      phase: "starting",
    },
    userId
  );

  for (let i = 0; i < targets.length; i++) {
    const ext = targets[i];

    eventBus.emit(
      EventType.SPINDLE_BULK_UPDATE_PROGRESS,
      {
        total: targets.length,
        completed: updated,
        failed,
        currentExtensionId: ext.id,
        currentName: ext.name,
        phase: "updating",
      },
      userId
    );

    // Emit per-extension status so the per-card spinner shows on the
    // affected card — same event the single-update path emits.
    eventBus.emit(EventType.SPINDLE_EXTENSION_STATUS, {
      extensionId: ext.id,
      operation: "updating",
      name: ext.name,
    });

    const wasRunning = lifecycle.isRunning(ext.id);
    const wasEnabled = ext.enabled;

    try {
      if (wasRunning) {
        await lifecycle.stopExtension(ext.id);
      }

      await managerSvc.update(ext.identifier);

      // Only restart if it was enabled before the update. Disabled
      // extensions stay disabled — we update them, but never auto-enable.
      if (wasEnabled) {
        await lifecycle.startExtension(ext.id);
      }

      eventBus.emit(EventType.SPINDLE_EXTENSION_STATUS, {
        extensionId: ext.id,
        operation: "updated",
        name: ext.name,
      });
      updated++;
    } catch (err: any) {
      const message = err?.message || "Update failed";
      errors.push({ id: ext.id, name: ext.name, error: message });
      failed++;

      eventBus.emit(EventType.SPINDLE_EXTENSION_STATUS, {
        extensionId: ext.id,
        operation: "failed",
        name: ext.name,
      });

      // Best-effort: if we stopped it and the update failed, try to
      // restart so the user isn't left with a silently-stopped extension.
      if (wasRunning && wasEnabled) {
        try {
          await lifecycle.startExtension(ext.id);
        } catch (restartErr: any) {
          console.error(
            `[Spindle] Failed to restart ${ext.identifier} after update error:`,
            restartErr
          );
        }
      }

      console.error(`[Spindle] Bulk update failed for ${ext.identifier}:`, err);
    }
  }

  eventBus.emit(
    EventType.SPINDLE_BULK_UPDATE_COMPLETE,
    {
      total: targets.length,
      updated,
      failed,
      errors,
    },
    userId
  );
}
