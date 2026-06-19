// Defensive disk-space monitor.
//
// Background: when the disk holding SQLite/LanceDB/transpiler-cache files is
// full, the kernel cannot satisfy block allocations for `mmap`'d pages, and
// the next write fault on any of those mappings raises SIGBUS — which Bun
// surfaces as `panic(main thread): Bus error` and dies. There's no clean way
// to recover at that point; the only mitigation is to keep the disk from
// filling. This service logs disk usage on startup and warns the connected
// frontend(s) once per server lifetime when free space drops below the
// threshold, so the operator has a chance to act before the crash.
import { statfsSync } from "node:fs";
import { env } from "../env";
import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

const DISK_USAGE_WARNING_THRESHOLD = 0.9;
const DISK_CHECK_INTERVAL_MS = 5 * 60 * 1000;

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export interface DiskUsage {
  path: string;
  totalBytes: number;
  freeBytes: number;
  /** 0..1; e.g. 0.93 = 93% full. */
  usagePercent: number;
}

// Tracks whether the last check found the disk over threshold. Used purely
// for console-log gating — we don't want to spam logs every 5 min while the
// disk stays full. The WS toast is re-emitted on every over-threshold check
// so late-connecting admins still get notified; the frontend dedupes per
// browser session.
let warningActive = false;
let intervalTimer: ReturnType<typeof setInterval> | null = null;

function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GiB`;
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(0)} MiB`;
  return `${bytes} B`;
}

export function getDiskUsage(path: string = env.dataDir): DiskUsage | null {
  try {
    const stats = statfsSync(path);
    // bavail = blocks free to non-privileged users (the right measure for
    // "can the server still write"). bsize = block size in bytes.
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const usagePercent = totalBytes > 0 ? 1 - freeBytes / totalBytes : 0;
    return { path, totalBytes, freeBytes, usagePercent };
  } catch (err) {
    console.warn(`[disk-monitor] statfs failed for ${path}:`, err);
    return null;
  }
}

function describe(usage: DiskUsage): string {
  const pct = (usage.usagePercent * 100).toFixed(1);
  return `${pct}% used (${formatBytes(usage.freeBytes)} free of ${formatBytes(usage.totalBytes)})`;
}

function runDiskUsageCheck(reason: "startup" | "interval"): void {
  const usage = getDiskUsage();
  if (!usage) return;

  const over = usage.usagePercent >= DISK_USAGE_WARNING_THRESHOLD;
  const thresholdPct = (DISK_USAGE_WARNING_THRESHOLD * 100).toFixed(0);

  // Console log: on startup always, plus on state transitions (so a sustained
  // over-threshold condition doesn't spam server logs every 5 min).
  const transitioned = over !== warningActive;
  if (reason === "startup" || transitioned) {
    if (over) {
      console.warn(
        `[disk-monitor] WARNING: disk hosting ${usage.path} is over ${thresholdPct}% full — ${describe(usage)}. ` +
        `Writes to mmap'd files (SQLite, LanceDB, transpiler cache) may fault with SIGBUS if it fills further. Consider freeing space.`,
      );
    } else if (reason === "startup") {
      console.info(`[disk-monitor] Disk hosting ${usage.path}: ${describe(usage)}.`);
    } else {
      // transitioned back under threshold during interval
      console.info(`[disk-monitor] Disk hosting ${usage.path} is back under ${thresholdPct}% — ${describe(usage)}.`);
    }
  }
  warningActive = over;

  // Re-emit on every check while over threshold so admins who connect after
  // the first emit still receive the toast. The frontend dedupes per browser
  // session (see SYSTEM_DISK_LOW handler in useWebSocket.ts), so existing
  // sessions don't see repeat toasts every 5 min.
  if (over) {
    const payload = {
      path: usage.path,
      usagePercent: usage.usagePercent,
      freeBytes: usage.freeBytes,
      totalBytes: usage.totalBytes,
      thresholdPercent: DISK_USAGE_WARNING_THRESHOLD,
    };
    // Restrict the toast to owner + admin users — disk pressure is an ops
    // concern, not something every signed-in user needs to act on. The
    // console log above still surfaces it for operators reading server logs.
    for (const userId of getPrivilegedUserIds()) {
      eventBus.emit(EventType.SYSTEM_DISK_LOW, payload, userId);
    }
  }
}

function getPrivilegedUserIds(): string[] {
  try {
    const rows = getDb()
      .query(`SELECT id FROM "user" WHERE role IN ('owner', 'admin')`)
      .all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  } catch (err) {
    console.warn(`[disk-monitor] Failed to list privileged users for toast delivery:`, err);
    return [];
  }
}

export function startDiskMonitor(): void {
  runDiskUsageCheck("startup");
  intervalTimer = setInterval(() => runDiskUsageCheck("interval"), DISK_CHECK_INTERVAL_MS);
  // Don't block process exit on this timer.
  if (typeof intervalTimer.unref === "function") intervalTimer.unref();
}

export function stopDiskMonitor(): void {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}
