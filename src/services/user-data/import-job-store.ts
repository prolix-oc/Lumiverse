import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "../../env";
import type { ImportJob } from "./import.service";

type StoredJob = Pick<ImportJob, "jobId" | "userId" | "status" | "startedAt" | "finishedAt" | "manifest" | "summary" | "fileSummary" | "error" | "progress" | "resuming">;
const safeId = (id: string) => /^[\w-]{1,128}$/.test(id);

function recordPath(userId: string, jobId: string): string | null {
  return safeId(userId) && safeId(jobId) ? join(env.dataDir, "imports", userId, jobId, "job.json") : null;
}

/** Never persist the ticket gate, secret keys, or decryption material. */
export function saveImportJob(job: ImportJob): void {
  const path = recordPath(job.userId, job.jobId);
  if (!path) throw new Error("invalid import job identity");
  const { jobId, userId, status, startedAt, finishedAt, summary, fileSummary, error, progress, resuming } = job;
  const manifest = job.manifest ? { ...job.manifest, missingFiles: [] } : null;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify({ version: 1, jobId, userId, status, startedAt, finishedAt, manifest, summary, fileSummary, error, progress, resuming }), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function loadImportJob(userId: string, jobId: string): (StoredJob & { archivePath: string }) | null {
  const path = recordPath(userId, jobId);
  if (!path) return null;
  try {
    if (statSync(path).size > 1024 * 1024) return null;
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (record.version !== 1 || record.userId !== userId || record.jobId !== jobId ||
      !["queued", "running", "awaiting_ticket", "interrupted", "complete", "failed", "cancelled"].includes(record.status)) return null;
    const archivePath = join(dirname(path), "archive.lvbak");
    if (["queued", "running", "awaiting_ticket"].includes(record.status)) {
      record.status = existsSync(archivePath) ? "interrupted" : "failed";
      record.finishedAt = Math.floor(Date.now() / 1000);
      record.error = record.status === "interrupted"
        ? "The local server stopped during this import. Resume to continue from the saved archive."
        : "The import was interrupted and its archive is unavailable. Select the backup again.";
    }
    return { ...record, archivePath };
  } catch { return null; }
}

/** Inspect only recent records for this account; old completed jobs need no discovery. */
export function recentImportJobIds(userId: string): string[] {
  if (!safeId(userId)) return [];
  const directory = join(env.dataDir, "imports", userId);
  try {
    return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && safeId(entry.name))
      .map(entry => ({ id: entry.name, modified: statSync(join(directory, entry.name)).mtimeMs }))
      .sort((a, b) => b.modified - a.modified).slice(0, 20).map(entry => entry.id);
  } catch { return []; }
}
