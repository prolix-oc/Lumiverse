export interface HostResponseError {
  code: string;
  message: string;
  presetId?: string;
  expectedCacheRevision?: number;
  actualCacheRevision?: number;
}

export type WorkerResponseError = string | HostResponseError;

/** Reconstruct host error metadata without losing optimistic-concurrency fields. */
export function deserializeWorkerResponseError(value: WorkerResponseError): Error {
  if (typeof value === "string") return new Error(value);
  const error = new Error(value.message);
  Object.assign(error, value);
  return error;
}
