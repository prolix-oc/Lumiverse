import type {
  WeaverVisualJob,
  WeaverVisualJobProgress,
  WeaverVisualJobResult,
} from "../../../types/weaver";

export interface CreateVisualJobInput {
  userId: string;
  sessionId: string;
  characterId: string;
  kind: string;
  variant: string | null;
  connectionId: string;
}

const visualJobs = new Map<string, WeaverVisualJob>();

function now(): number {
  return Date.now();
}

function requireVisualJob(jobId: string, userId: string): WeaverVisualJob {
  const job = visualJobs.get(jobId);
  if (!job || job.userId !== userId) {
    throw new Error("Visual job not found");
  }
  return job;
}

export function createVisualJob(input: CreateVisualJobInput): WeaverVisualJob {
  const timestamp = now();
  const job: WeaverVisualJob = {
    id: crypto.randomUUID(),
    userId: input.userId,
    sessionId: input.sessionId,
    characterId: input.characterId,
    kind: input.kind,
    variant: input.variant,
    connectionId: input.connectionId,
    status: "queued",
    progress: {
      stage: "queued",
      message: "Queued for generation",
    },
    result: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    completedAt: null,
  };

  visualJobs.set(job.id, job);
  return job;
}

export function getVisualJob(jobId: string, userId: string): WeaverVisualJob | null {
  const job = visualJobs.get(jobId);
  if (!job || job.userId !== userId) {
    return null;
  }
  return job;
}

export function updateVisualJobProgress(
  jobId: string,
  userId: string,
  progress: WeaverVisualJobProgress,
): WeaverVisualJob {
  const existing = requireVisualJob(jobId, userId);
  const timestamp = now();
  const next: WeaverVisualJob = {
    ...existing,
    status: "running",
    progress,
    updatedAt: timestamp,
    startedAt: existing.startedAt ?? timestamp,
  };
  visualJobs.set(jobId, next);
  return next;
}

export function completeVisualJob(
  jobId: string,
  userId: string,
  result: WeaverVisualJobResult,
): WeaverVisualJob {
  const existing = requireVisualJob(jobId, userId);
  const timestamp = now();
  const next: WeaverVisualJob = {
    ...existing,
    status: "completed",
    progress: {
      stage: "completed",
      message: "Generation complete",
    },
    result,
    error: null,
    updatedAt: timestamp,
    startedAt: existing.startedAt ?? timestamp,
    completedAt: timestamp,
  };
  visualJobs.set(jobId, next);
  return next;
}

export function failVisualJob(
  jobId: string,
  userId: string,
  error: string,
): WeaverVisualJob {
  const existing = requireVisualJob(jobId, userId);
  const timestamp = now();
  const next: WeaverVisualJob = {
    ...existing,
    status: "failed",
    progress: {
      stage: "failed",
      message: error,
    },
    result: null,
    error,
    updatedAt: timestamp,
    startedAt: existing.startedAt ?? timestamp,
    completedAt: timestamp,
  };
  visualJobs.set(jobId, next);
  return next;
}

export function clearVisualJobs(): void {
  visualJobs.clear();
}
