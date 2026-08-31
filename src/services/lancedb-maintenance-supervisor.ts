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
import {
  admitLanceExternalMaintenanceOwner,
  pauseLanceDbForExternalMaintenance,
  refreshLanceDbAfterExternalMaintenance,
} from "./vector-store/providers/lancedb";

export type LanceDbMaintenanceMode = "startup" | "optimize";

export interface LanceDbMaintenanceOptions {
  mode: LanceDbMaintenanceMode;
  tableNames?: string[];
}

const MAINTENANCE_TERM_GRACE_MS = 2_000;
type MaintenanceChild = ReturnType<typeof Bun.spawn>;
type ActiveMaintenance = {
  promise: Promise<void>;
  child: MaintenanceChild | null;
  retired: boolean;
  retirePromise: Promise<void> | null;
};
let activeMaintenance: ActiveMaintenance | null = null;
let maintenanceShutdown = false;

export function isLanceDbMaintenanceRunning(): boolean {
  return activeMaintenance !== null;
}

export function runLanceDbMaintenanceInChild(options: LanceDbMaintenanceOptions): Promise<void> {
  if (activeMaintenance) return activeMaintenance.promise;
  if (maintenanceShutdown) {
    return Promise.reject(new DOMException("LanceDB maintenance is shutting down", "AbortError"));
  }

  const job: ActiveMaintenance = {
    promise: Promise.resolve(),
    child: null,
    retired: false,
    retirePromise: null,
  };
  job.promise = run(options, job).finally(() => {
    if (activeMaintenance === job) activeMaintenance = null;
  });
  activeMaintenance = job;
  return job.promise;
}

async function retireMaintenance(job: ActiveMaintenance): Promise<void> {
  if (job.retirePromise) return job.retirePromise;
  job.retired = true;
  job.retirePromise = (async () => {
    const child = job.child;
    if (!child) return;
    child.kill("SIGTERM");
    const exited = child.exited.then(() => true, () => true);
    const graceful = await Promise.race([
      exited,
      new Promise<false>((resolve) => setTimeout(() => resolve(false), MAINTENANCE_TERM_GRACE_MS)),
    ]);
    if (!graceful) child.kill("SIGKILL");
    await child.exited.catch(() => undefined);
  })();
  return job.retirePromise;
}

export async function stopLanceDbMaintenanceSupervisor(): Promise<void> {
  maintenanceShutdown = true;
  const job = activeMaintenance;
  if (!job) return;
  await retireMaintenance(job);
  await job.promise.catch(() => undefined);
}

function maintenanceCommand(runtimePath: string): string[] {
  // Desktop launches can have a sparse PATH. Use the exact Bun executable that
  // started the server unless Termux supplied a wrapper that must be preserved.
  return process.env.LUMIVERSE_BUN_METHOD ? bunCmd(runtimePath) : [process.execPath, runtimePath];
}

async function run(
  { mode, tableNames }: LanceDbMaintenanceOptions,
  job: ActiveMaintenance,
): Promise<void> {
  const admission = admitLanceExternalMaintenanceOwner();
  admission.setRetirement(() => retireMaintenance(job));
  const servingGate = { release: null as (() => void) | null };

  try {
    await admission.run(async () => {
      if (job.retired || admission.signal.aborted) {
        throw admission.signal.reason ?? new DOMException("LanceDB maintenance retired", "AbortError");
      }
      servingGate.release = await pauseLanceDbForExternalMaintenance();
      if (job.retired || admission.signal.aborted) {
        throw admission.signal.reason ?? new DOMException("LanceDB maintenance retired", "AbortError");
      }
      const runtimePath = join(import.meta.dir, "lancedb-maintenance-subprocess.ts");
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
      job.child = child;
      if (job.retired || admission.signal.aborted) await retireMaintenance(job);
      const exitCode = await child.exited;
      job.child = null;
      if (job.retired || admission.signal.aborted) {
        throw admission.signal.reason ?? new DOMException("LanceDB maintenance retired", "AbortError");
      }
      if (exitCode !== 0) {
        throw new Error(`LanceDB ${mode} maintenance child exited with code ${exitCode}`);
      }
      console.info(`[embeddings] LanceDB ${mode} maintenance child completed.`);
      await refreshLanceDbAfterExternalMaintenance();
    });
  } finally {
    servingGate.release?.();
    admission.release();
  }
}
