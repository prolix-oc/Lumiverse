/**
 * Runs disruptive LanceDB maintenance outside the serving Bun process.
 *
 * Compaction and replace:true index builds are native work. Even when their
 * JavaScript API returns a Promise, some runtimes can monopolize the process
 * while the native call executes. The parent closes its Lance read/write gate
 * before spawning this child, then remains free to serve every non-vector
 * request until maintenance has completed.
 */
import { join } from "node:path";
import { bunCmd } from "../utils/bun-cmd";
import { getResolvedVectorStoreConfig } from "./vector-store-config.service";

export type LanceDbMaintenanceMode = "startup" | "optimize";

export interface LanceDbMaintenanceOptions {
  mode: LanceDbMaintenanceMode;
  tableNames?: string[];
}

let activeMaintenance: Promise<void> | null = null;
let startupMaintenanceTimer: ReturnType<typeof setTimeout> | null = null;

/** Run the usual startup checks after readiness or a switch back to LanceDB. */
export function scheduleLanceDbStartupMaintenance(): void {
  if (getResolvedVectorStoreConfig().provider !== "lancedb") return;
  if (["0", "false", "no", "off"].includes(
    (process.env.LUMIVERSE_LANCEDB_STARTUP_MAINTENANCE ?? "").trim().toLowerCase(),
  )) {
    console.info("[startup] Automatic LanceDB startup maintenance is disabled; use an Operator maintenance window to run compaction.");
    return;
  }
  if (startupMaintenanceTimer) return;
  startupMaintenanceTimer = setTimeout(async () => {
    startupMaintenanceTimer = null;
    if (getResolvedVectorStoreConfig().provider !== "lancedb") return;
    console.info("[startup] Starting deferred LanceDB maintenance child...");
    try {
      await runLanceDbMaintenanceInChild({ mode: "startup" });
    } catch (err) {
      console.warn("[embeddings] Deferred startup maintenance failed:", err);
    }
  }, 5_000);
  startupMaintenanceTimer.unref();
}

export function isLanceDbMaintenanceRunning(): boolean {
  return activeMaintenance !== null;
}

export function runLanceDbMaintenanceInChild(options: LanceDbMaintenanceOptions): Promise<void> {
  // Recheck at execution time: the provider can change during the startup delay.
  if (getResolvedVectorStoreConfig().provider !== "lancedb") return Promise.resolve();
  if (activeMaintenance) return activeMaintenance;

  activeMaintenance = run(options).finally(() => {
    activeMaintenance = null;
  });
  return activeMaintenance;
}

function maintenanceCommand(runtimePath: string): string[] {
  // Desktop launches can have a sparse PATH. Use the exact Bun executable that
  // started the server unless Termux supplied a wrapper that must be preserved.
  return process.env.LUMIVERSE_BUN_METHOD ? bunCmd(runtimePath) : [process.execPath, runtimePath];
}

async function run({ mode, tableNames }: LanceDbMaintenanceOptions): Promise<void> {
  // This dynamic import deliberately happens after the HTTP listener is live.
  // It only installs the serving process's local gate; all native maintenance
  // work stays in the child below.
  const {
    pauseLanceDbForExternalMaintenance,
    refreshLanceDbAfterExternalMaintenance,
  } = await import("./vector-store/providers/lancedb");
  const releaseServingGate = await pauseLanceDbForExternalMaintenance();
  const runtimePath = join(import.meta.dir, "lancedb-maintenance-subprocess.ts");

  try {
    console.info(`[embeddings] Launching LanceDB ${mode} maintenance child process...`);
    const child = Bun.spawn({
      cmd: maintenanceCommand(runtimePath),
      cwd: process.cwd(),
      env: {
        ...process.env,
        LUMIVERSE_LANCEDB_MAINTENANCE_CHILD: "1",
        LUMIVERSE_LANCEDB_MAINTENANCE_MODE: mode,
        ...(tableNames?.length ? { LUMIVERSE_LANCEDB_MAINTENANCE_TABLES: tableNames.join(",") } : {}),
      },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      throw new Error(`LanceDB ${mode} maintenance child exited with code ${exitCode}`);
    }
    console.info(`[embeddings] LanceDB ${mode} maintenance child completed.`);
  } finally {
    // The child may have committed a new manifest even if it ultimately
    // reports failure. Never let the serving process retain stale handles.
    refreshLanceDbAfterExternalMaintenance();
    releaseServingGate();
  }
}
