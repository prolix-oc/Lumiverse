import {
  basename,
  join,
} from "node:path";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { env } from "../env";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import {
  importCharacterFile,
  type CharacterFileImportResult,
} from "./character-import.service";

export const MAX_CHARACTER_IMPORT_JOB_FILES = 500;
export const MAX_CHARACTER_IMPORT_FILE_BYTES = 1000 * 1024 * 1024;
export const MAX_CHARACTER_IMPORT_JOB_BYTES = 5 * 1024 * 1024 * 1024;

export type CharacterImportJobStatus =
  | "accepting"
  | "processing"
  | "complete"
  | "cancelled"
  | "error";

export interface StagedCharacterFile {
  index: number;
  filename: string;
  mimeType: string;
  path: string;
  size: number;
}

interface CharacterImportJob {
  id: string;
  userId: string;
  status: CharacterImportJobStatus;
  expectedFiles: number;
  skipDuplicates: boolean;
  directory: string;
  files: Map<number, StagedCharacterFile>;
  uploading: Set<number>;
  results: CharacterFileImportResult[];
  processed: number;
  totalBytes: number;
  reservedBytes: number;
  cancelRequested: boolean;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CharacterImportJobSnapshot {
  jobId: string;
  status: CharacterImportJobStatus;
  total: number;
  uploaded: number;
  processed: number;
  results: CharacterFileImportResult[];
  summary: {
    total: number;
    imported: number;
    skipped: number;
    failed: number;
  };
  error?: string;
}

export class CharacterImportJobError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CharacterImportJobError";
  }
}

export interface CharacterImportJobManagerOptions {
  rootDir: string;
  processFile: (
    userId: string,
    file: StagedCharacterFile,
    skipDuplicates: boolean,
  ) => Promise<CharacterFileImportResult>;
  onLibraryChanged?: (userId: string, imported: number, jobId: string) => void;
  resultRetentionMs?: number;
}

function safeFilename(value: string): string {
  const name = basename(value.replace(/\0/g, "")).trim();
  if (!name || name === "." || name === "..") return "character-card";
  return name.slice(0, 512);
}

function removePath(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Missing or already-cleaned staging files are harmless.
  }
}

function writeAll(fd: number, chunk: Uint8Array): void {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const written = writeSync(fd, chunk, offset, chunk.byteLength - offset);
    if (written <= 0) throw new Error("Failed to write staged character upload");
    offset += written;
  }
}

export class CharacterImportJobManager {
  private readonly jobs = new Map<string, CharacterImportJob>();

  constructor(private readonly options: CharacterImportJobManagerOptions) {}

  create(userId: string, expectedFiles: number, skipDuplicates: boolean): CharacterImportJobSnapshot {
    if (!Number.isInteger(expectedFiles) || expectedFiles < 1 || expectedFiles > MAX_CHARACTER_IMPORT_JOB_FILES) {
      throw new CharacterImportJobError(
        400,
        "invalid_file_count",
        `total must be between 1 and ${MAX_CHARACTER_IMPORT_JOB_FILES}`,
      );
    }

    const active = [...this.jobs.values()].find(
      (job) => job.userId === userId && (job.status === "accepting" || job.status === "processing"),
    );
    if (active) {
      throw new CharacterImportJobError(409, "job_in_progress", "A character import is already in progress");
    }

    const id = crypto.randomUUID();
    // The staging path contains only a server-generated UUID. User ids remain
    // authorization metadata and never participate in filesystem resolution.
    const directory = join(this.options.rootDir, id);
    mkdirSync(directory, { recursive: true });
    const now = Date.now();
    const job: CharacterImportJob = {
      id,
      userId,
      status: "accepting",
      expectedFiles,
      skipDuplicates,
      directory,
      files: new Map(),
      uploading: new Set(),
      results: [],
      processed: 0,
      totalBytes: 0,
      reservedBytes: 0,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(id, job);
    return this.snapshot(job);
  }

  get(userId: string, jobId: string): CharacterImportJobSnapshot | null {
    const job = this.jobs.get(jobId);
    return job && job.userId === userId ? this.snapshot(job) : null;
  }

  async upload(
    userId: string,
    jobId: string,
    index: number,
    filename: string,
    mimeType: string,
    body: ReadableStream<Uint8Array>,
    declaredSize: number | null,
  ): Promise<CharacterImportJobSnapshot> {
    const job = this.requireJob(userId, jobId);
    if (job.status !== "accepting") {
      throw new CharacterImportJobError(409, "job_not_accepting", "This import job is no longer accepting files");
    }
    if (!Number.isInteger(index) || index < 0 || index >= job.expectedFiles) {
      throw new CharacterImportJobError(400, "invalid_file_index", "File index is outside the import job range");
    }
    if (job.files.has(index) || job.uploading.has(index)) {
      throw new CharacterImportJobError(409, "file_already_uploaded", "This file index has already been uploaded");
    }
    if (declaredSize !== null && (!Number.isFinite(declaredSize) || declaredSize < 0)) {
      throw new CharacterImportJobError(400, "invalid_content_length", "Invalid Content-Length");
    }
    if (declaredSize !== null && declaredSize > MAX_CHARACTER_IMPORT_FILE_BYTES) {
      throw new CharacterImportJobError(413, "file_too_large", "Character card exceeds the per-file size limit");
    }
    if (declaredSize !== null && job.totalBytes + job.reservedBytes + declaredSize > MAX_CHARACTER_IMPORT_JOB_BYTES) {
      throw new CharacterImportJobError(413, "job_too_large", "Character import exceeds the total upload size limit");
    }

    const path = join(job.directory, `${String(index).padStart(4, "0")}.upload`);
    const reader = body.getReader();
    const fd = openSync(path, "wx");
    let fdClosed = false;
    let total = 0;
    let reservation = declaredSize ?? 0;
    job.uploading.add(index);
    job.reservedBytes += reservation;

    const close = () => {
      if (fdClosed) return;
      fdClosed = true;
      closeSync(fd);
    };

    try {
      while (true) {
        if (job.cancelRequested || job.status !== "accepting") {
          throw new CharacterImportJobError(409, "job_cancelled", "Character import was cancelled");
        }
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        const nextTotal = total + value.byteLength;
        if (nextTotal > MAX_CHARACTER_IMPORT_FILE_BYTES) {
          throw new CharacterImportJobError(413, "file_too_large", "Character card exceeds the per-file size limit");
        }
        if (nextTotal > reservation) {
          const additional = nextTotal - reservation;
          if (job.totalBytes + job.reservedBytes + additional > MAX_CHARACTER_IMPORT_JOB_BYTES) {
            throw new CharacterImportJobError(413, "job_too_large", "Character import exceeds the total upload size limit");
          }
          reservation += additional;
          job.reservedBytes += additional;
        }
        writeAll(fd, value);
        total = nextTotal;
      }
      if (total === 0) {
        throw new CharacterImportJobError(400, "empty_file", "Character card file is empty");
      }
      close();
      job.files.set(index, {
        index,
        filename: safeFilename(filename),
        mimeType: mimeType.split(";", 1)[0].trim() || "application/octet-stream",
        path,
        size: total,
      });
      job.totalBytes += total;
      job.updatedAt = Date.now();
      return this.snapshot(job);
    } catch (err) {
      try {
        await reader.cancel(err);
      } catch {
        // Ignore a secondary stream cancellation failure.
      }
      try {
        close();
      } catch {
        // Preserve the useful upload error.
      }
      removePath(path);
      throw err;
    } finally {
      job.uploading.delete(index);
      job.reservedBytes = Math.max(0, job.reservedBytes - reservation);
      if (job.cancelRequested && job.status === "accepting" && job.uploading.size === 0) {
        job.status = "cancelled";
        job.updatedAt = Date.now();
        this.cleanup(job);
        this.scheduleEviction(job);
      }
      try {
        reader.releaseLock();
      } catch {
        // Ignore an already-released reader.
      }
    }
  }

  start(userId: string, jobId: string): CharacterImportJobSnapshot {
    const job = this.requireJob(userId, jobId);
    if (job.status !== "accepting") {
      throw new CharacterImportJobError(409, "job_not_accepting", "This import job cannot be started");
    }
    if (job.uploading.size > 0 || job.files.size !== job.expectedFiles) {
      throw new CharacterImportJobError(
        409,
        "uploads_incomplete",
        `Expected ${job.expectedFiles} files but received ${job.files.size}`,
      );
    }
    job.status = "processing";
    job.updatedAt = Date.now();
    void this.run(job);
    return this.snapshot(job);
  }

  cancel(userId: string, jobId: string): CharacterImportJobSnapshot {
    const job = this.requireJob(userId, jobId);
    if (job.status === "complete" || job.status === "error" || job.status === "cancelled") {
      return this.snapshot(job);
    }
    job.cancelRequested = true;
    job.updatedAt = Date.now();
    if (job.status === "accepting" && job.uploading.size === 0) {
      job.status = "cancelled";
      this.cleanup(job);
      this.scheduleEviction(job);
    }
    return this.snapshot(job);
  }

  private requireJob(userId: string, jobId: string): CharacterImportJob {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId) {
      throw new CharacterImportJobError(404, "job_not_found", "Character import job not found");
    }
    return job;
  }

  private async run(job: CharacterImportJob): Promise<void> {
    try {
      const files = [...job.files.values()].sort((a, b) => a.index - b.index);
      for (const staged of files) {
        if (job.cancelRequested) break;
        let result: CharacterFileImportResult;
        try {
          result = await this.options.processFile(job.userId, staged, job.skipDuplicates);
        } catch (err) {
          result = {
            filename: staged.filename,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        job.results.push(result);
        job.processed++;
        job.updatedAt = Date.now();
        removePath(staged.path);
      }

      job.status = job.cancelRequested ? "cancelled" : "complete";
      const imported = job.results.filter((result) => result.success && !result.skipped).length;
      if (imported > 0) this.options.onLibraryChanged?.(job.userId, imported, job.id);
    } catch (err) {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.updatedAt = Date.now();
      this.cleanup(job);
      this.scheduleEviction(job);
    }
  }

  private cleanup(job: CharacterImportJob): void {
    if (!existsSync(job.directory)) return;
    // `directory` is always a UUID child created by this manager, never a
    // user-supplied path. Removing it also clears unprocessed files on cancel.
    try {
      rmSync(job.directory, { recursive: true, force: true });
    } catch (err) {
      console.warn("[character import] failed to clean staging directory:", err);
    }
  }

  private scheduleEviction(job: CharacterImportJob): void {
    const retentionMs = Math.max(1_000, this.options.resultRetentionMs ?? 5 * 60_000);
    const timer = setTimeout(() => {
      if (this.jobs.get(job.id) === job) this.jobs.delete(job.id);
    }, retentionMs);
    timer.unref?.();
  }

  private snapshot(job: CharacterImportJob): CharacterImportJobSnapshot {
    const imported = job.results.filter((result) => result.success && !result.skipped).length;
    const skipped = job.results.filter((result) => result.skipped).length;
    const failed = job.results.filter((result) => !result.success).length;
    return {
      jobId: job.id,
      status: job.status,
      total: job.expectedFiles,
      uploaded: job.files.size,
      processed: job.processed,
      results: job.results.slice(),
      summary: {
        total: job.expectedFiles,
        imported,
        skipped,
        failed,
      },
      ...(job.error ? { error: job.error } : {}),
    };
  }
}

export const characterImportJobs = new CharacterImportJobManager({
  rootDir: join(env.dataDir, "imports", "character-jobs"),
  processFile: async (userId, staged, skipDuplicates) => {
    const source = Bun.file(staged.path);
    const file = new File([source], staged.filename, { type: staged.mimeType });
    return importCharacterFile(userId, file, {
      skipDuplicates,
      emitEvent: false,
    });
  },
  onLibraryChanged(userId, imported, jobId) {
    eventBus.emit(EventType.CHARACTER_LIBRARY_CHANGED, {
      reason: "bulk_import",
      jobId,
      imported,
    }, userId);
  },
});
