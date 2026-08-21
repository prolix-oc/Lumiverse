import { getDb } from "../db/connection";

export type ImageProcessingJobKind = "process" | "rebuild";

export interface ImageProcessingQueueJob {
  id: string;
  userId: string;
  imageId: string;
  kind: ImageProcessingJobKind;
  createdAt: number;
}

export interface ImageProcessingQueueRecovery {
  pending: number;
  process: number;
  rebuild: number;
}

function ensureImageProcessingQueueTable(): void {
  getDb().run(`
    CREATE TABLE IF NOT EXISTS image_processing_queue (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      image_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (image_id, kind)
    )
  `);
  getDb().run(`
    CREATE INDEX IF NOT EXISTS idx_image_processing_queue_user_created
      ON image_processing_queue(user_id, created_at)
  `);
}

function isKind(value: unknown): value is ImageProcessingJobKind {
  return value === "process" || value === "rebuild";
}

function mapJob(row: {
  id: string;
  user_id: string;
  image_id: string;
  kind: string;
  created_at: number;
}): ImageProcessingQueueJob | null {
  if (!isKind(row.kind)) return null;
  return {
    id: row.id,
    userId: row.user_id,
    imageId: row.image_id,
    kind: row.kind,
    createdAt: row.created_at,
  };
}

export function recordImageProcessingJob(
  userId: string,
  imageId: string,
  kind: ImageProcessingJobKind,
): ImageProcessingQueueJob {
  ensureImageProcessingQueueTable();
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  getDb()
    .query(
      `INSERT OR IGNORE INTO image_processing_queue (id, user_id, image_id, kind, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, userId, imageId, kind, createdAt);
  const row = getDb()
    .query(
      `SELECT id, user_id, image_id, kind, created_at
       FROM image_processing_queue
       WHERE image_id = ? AND kind = ?`,
    )
    .get(imageId, kind) as {
      id: string;
      user_id: string;
      image_id: string;
      kind: string;
      created_at: number;
    } | undefined;
  const job = row ? mapJob(row) : null;
  return job ?? { id, userId, imageId, kind, createdAt };
}

export function completeImageProcessingJob(id: string): void {
  ensureImageProcessingQueueTable();
  getDb().query("DELETE FROM image_processing_queue WHERE id = ?").run(id);
}

export function listImageProcessingJobs(): ImageProcessingQueueJob[] {
  ensureImageProcessingQueueTable();
  const rows = getDb()
    .query(
      `SELECT id, user_id, image_id, kind, created_at
       FROM image_processing_queue
       ORDER BY created_at ASC, id ASC`,
    )
    .all() as Array<{
      id: string;
      user_id: string;
      image_id: string;
      kind: string;
      created_at: number;
    }>;
  const jobs: ImageProcessingQueueJob[] = [];
  for (const row of rows) {
    const job = mapJob(row);
    if (job) jobs.push(job);
  }
  return jobs;
}

export function listRecoverableImageProcessingJobs(
  liveIds: ReadonlySet<string>,
): ImageProcessingQueueJob[] {
  return listImageProcessingJobs().filter((job) => !liveIds.has(job.id));
}

export function discardRecoverableImageProcessingJobs(liveIds: ReadonlySet<string>): number {
  const recoverable = listRecoverableImageProcessingJobs(liveIds);
  if (recoverable.length === 0) return 0;
  const placeholders = recoverable.map(() => "?").join(", ");
  getDb()
    .query(`DELETE FROM image_processing_queue WHERE id IN (${placeholders})`)
    .run(...recoverable.map((job) => job.id));
  return recoverable.length;
}

export function summarizeImageProcessingRecovery(
  liveIds: ReadonlySet<string>,
): ImageProcessingQueueRecovery {
  const recoverable = listRecoverableImageProcessingJobs(liveIds);
  let process = 0;
  let rebuild = 0;
  for (const job of recoverable) {
    if (job.kind === "rebuild") rebuild++;
    else process++;
  }
  return {
    pending: recoverable.length,
    process,
    rebuild,
  };
}

export function describeImageProcessingRecovery(
  recovery: ImageProcessingQueueRecovery,
): string {
  if (recovery.pending === 0) return "no leftover thumbnail jobs";
  const parts: string[] = [];
  if (recovery.process > 0) parts.push(`${recovery.process} deferred`);
  if (recovery.rebuild > 0) parts.push(`${recovery.rebuild} rebuild`);
  return `${recovery.pending} leftover thumbnail ${recovery.pending === 1 ? "job" : "jobs"} (${parts.join(", ")})`;
}
