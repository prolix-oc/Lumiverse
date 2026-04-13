export type DreamWeaverVisualJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

export interface DreamWeaverVisualJobProgress {
  stage: string;
  message: string;
  step?: number;
  totalSteps?: number;
  preview?: string;
  nodeId?: string;
}

export interface DreamWeaverVisualJobResult {
  image_id?: string;
  image_url?: string;
  settingsSnapshot: Record<string, unknown>;
}

export interface DreamWeaverVisualJob {
  id: string;
  userId: string;
  sessionId: string;
  assetId: string;
  connectionId: string;
  status: DreamWeaverVisualJobStatus;
  progress: DreamWeaverVisualJobProgress;
  result: DreamWeaverVisualJobResult | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface CreateVisualJobInput {
  userId: string;
  sessionId: string;
  assetId: string;
  connectionId: string;
}

const visualJobs = new Map<string, DreamWeaverVisualJob>();

function now(): number {
  return Date.now();
}

function requireVisualJob(jobId: string, userId: string): DreamWeaverVisualJob {
  const job = visualJobs.get(jobId);
  if (!job || job.userId !== userId) {
    throw new Error("Visual job not found");
  }
  return job;
}

export function createVisualJob(input: CreateVisualJobInput): DreamWeaverVisualJob {
  const timestamp = now();
  const job: DreamWeaverVisualJob = {
    id: crypto.randomUUID(),
    userId: input.userId,
    sessionId: input.sessionId,
    assetId: input.assetId,
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

export function getVisualJob(jobId: string, userId: string): DreamWeaverVisualJob | null {
  const job = visualJobs.get(jobId);
  if (!job || job.userId !== userId) {
    return null;
  }
  return job;
}

export function updateVisualJobProgress(
  jobId: string,
  userId: string,
  progress: DreamWeaverVisualJobProgress,
): DreamWeaverVisualJob {
  const existing = requireVisualJob(jobId, userId);
  const timestamp = now();
  const next: DreamWeaverVisualJob = {
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
  result: DreamWeaverVisualJobResult,
): DreamWeaverVisualJob {
  const existing = requireVisualJob(jobId, userId);
  const timestamp = now();
  const next: DreamWeaverVisualJob = {
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
): DreamWeaverVisualJob {
  const existing = requireVisualJob(jobId, userId);
  const timestamp = now();
  const next: DreamWeaverVisualJob = {
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
