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
 *
 * Crash-avoidance structure (Bun 1.3.x):
 *   The run is split into three phases — stop-all, update-all, start-all —
 *   instead of stop/update/start per extension. Interleaving Worker
 *   teardown with `git pull` / `bun install` / `bun build` subprocess
 *   spawns has been observed to trigger a null-pointer segfault in Bun's
 *   subprocess/worker cleanup path. Batching the Worker lifecycle bursts
 *   on either side of the pure-subprocess phase gives JSC time to
 *   finalize terminated workers before we start spawning, and vice versa.
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

/**
 * Sleep helper used to give Bun breathing room between phases.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort GC hint between phases. Bun exposes `Bun.gc(true)` which
 * runs a synchronous full collection; this helps finalize terminated
 * Workers and drain subprocess pipe handles before we move on. Wrapped
 * in a try/catch so older Bun builds don't blow up the bulk run.
 */
function maybeGc(): void {
  try {
    (globalThis as any).Bun?.gc?.(true);
  } catch {
    // ignore
  }
}

interface BulkPlanEntry {
  ext: ExtensionInfo;
  wasRunning: boolean;
  wasEnabled: boolean;
  /** Set when the update (git pull / bun install / bun build) succeeded. */
  updated: boolean;
  /** Set when the update failed so we can decide whether to attempt restart. */
  updateError: string | null;
  /** Set when Phase 3 restart failed (even if Phase 2 update succeeded). */
  restartError: string | null;
}

async function runBulkUpdate(
  targets: ExtensionInfo[],
  userId: string
): Promise<void> {
  const errors: BulkUpdateError[] = [];
  const plan: BulkPlanEntry[] = targets.map((ext) => ({
    ext,
    wasRunning: lifecycle.isRunning(ext.id),
    wasEnabled: ext.enabled,
    updated: false,
    updateError: null,
    restartError: null,
  }));

  // Initial progress tick so the UI can render "0/N" immediately.
  eventBus.emit(
    EventType.SPINDLE_BULK_UPDATE_PROGRESS,
    {
      total: plan.length,
      completed: 0,
      failed: 0,
      phase: "starting",
    },
    userId
  );

  // ─── Phase 1: stop all running workers ────────────────────────────────
  // Batch worker teardown in a single burst so the subsequent subprocess
  // phase never races with a Worker.terminate() cleanup.
  for (const entry of plan) {
    if (!entry.wasRunning) continue;
    try {
      await lifecycle.stopExtension(entry.ext.id);
    } catch (err: any) {
      console.error(
        `[Spindle] Bulk update: failed to stop ${entry.ext.identifier}:`,
        err
      );
      // Don't abort — we'll still try to update and we'll record the
      // failure if the update itself fails.
    }
  }

  // Let JSC finalize the terminated Worker state before we start spawning
  // git/bun subprocesses. This is the specific interleaving that has
  // triggered segfaults on Bun 1.3.x.
  await sleep(500);
  maybeGc();

  // ─── Phase 2: update every extension (no Worker activity) ─────────────
  let completed = 0;
  let failed = 0;
  for (const entry of plan) {
    const { ext } = entry;

    eventBus.emit(
      EventType.SPINDLE_BULK_UPDATE_PROGRESS,
      {
        total: plan.length,
        completed,
        failed,
        currentExtensionId: ext.id,
        currentName: ext.name,
        phase: "updating",
      },
      userId
    );

    eventBus.emit(EventType.SPINDLE_EXTENSION_STATUS, {
      extensionId: ext.id,
      operation: "updating",
      name: ext.name,
    });

    try {
      await managerSvc.update(ext.identifier);
      entry.updated = true;
      completed++;
      eventBus.emit(EventType.SPINDLE_EXTENSION_STATUS, {
        extensionId: ext.id,
        operation: "updated",
        name: ext.name,
      });
    } catch (err: any) {
      const message = err?.message || "Update failed";
      entry.updateError = message;
      errors.push({ id: ext.id, name: ext.name, error: message });
      failed++;
      eventBus.emit(EventType.SPINDLE_EXTENSION_STATUS, {
        extensionId: ext.id,
        operation: "failed",
        name: ext.name,
      });
      console.error(`[Spindle] Bulk update failed for ${ext.identifier}:`, err);
    }

    // Small breather between subprocess bursts so pipe handles and
    // child-process zombies can be reaped before the next extension's
    // git + bun install + bun build chain fires.
    await sleep(150);
    maybeGc();
  }

  // Let the last extension's build subprocesses fully drain before we
  // start spinning up new Workers.
  await sleep(500);
  maybeGc();

  // ─── Phase 3: start previously-running extensions ─────────────────────
  // Only restart extensions that were enabled before the bulk run started.
  // Disabled extensions stay disabled — we update them, but never
  // auto-enable. If the update failed we still best-effort restart an
  // extension that was previously running so the user isn't left with a
  // silently-stopped extension on a partial failure.
  for (const entry of plan) {
    if (!entry.wasEnabled) continue;
    const shouldRestart = entry.updated || entry.wasRunning;
    if (!shouldRestart) continue;

    try {
      await lifecycle.startExtension(entry.ext.id);
    } catch (restartErr: any) {
      const message = restartErr?.message || "Restart failed";
      entry.restartError = message;
      console.error(
        `[Spindle] Bulk update: failed to restart ${entry.ext.identifier}:`,
        restartErr
      );
      // If we haven't already recorded an error for this extension,
      // surface the restart failure so the UI doesn't claim success.
      if (!entry.updateError) {
        errors.push({ id: entry.ext.id, name: entry.ext.name, error: message });
        eventBus.emit(EventType.SPINDLE_EXTENSION_STATUS, {
          extensionId: entry.ext.id,
          operation: "failed",
          name: entry.ext.name,
        });
      }
    }

    // Pace worker startups so we don't stack N Worker() constructors
    // inside the same tick.
    await sleep(250);
  }

  // "updated" = Phase 2 succeeded AND Phase 3 restart (if attempted) succeeded.
  // Anything else counts as failed so the UI surfaces partial-success cases.
  const successCount = plan.filter((p) => p.updated && !p.restartError).length;
  eventBus.emit(
    EventType.SPINDLE_BULK_UPDATE_COMPLETE,
    {
      total: plan.length,
      updated: successCount,
      failed: plan.length - successCount,
      errors,
    },
    userId
  );
}
