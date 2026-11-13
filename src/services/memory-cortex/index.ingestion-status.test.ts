import { describe, expect, test } from "bun:test";
import {
  CORTEX_INGESTION_ERROR_STATUS_TTL_MS,
  normalizeCortexIngestionStatusForRead,
  type CortexIngestionStatus,
} from "./index";

describe("Cortex ingestion terminal status", () => {
  const failedAt = 10_000;
  const failed: CortexIngestionStatus = {
    chatId: "chat-1",
    status: "error",
    phase: "error",
    chunkId: "chunk-1",
    startedAt: null,
    updatedAt: failedAt,
    pendingJobs: 0,
    error: "sidecar_timeout",
    sidecarState: "timeout",
    lastError: {
      message: "sidecar_timeout",
      sidecarState: "timeout",
      occurredAt: failedAt,
      chunkId: "chunk-1",
    },
  };

  test("keeps a recent failure active", () => {
    expect(normalizeCortexIngestionStatusForRead(
      failed,
      failedAt + CORTEX_INGESTION_ERROR_STATUS_TTL_MS - 1,
    )).toBe(failed);
  });

  test("expires active failure state but retains its diagnostic snapshot", () => {
    const normalized = normalizeCortexIngestionStatusForRead(
      failed,
      failedAt + CORTEX_INGESTION_ERROR_STATUS_TTL_MS,
    );

    expect(normalized).toMatchObject({
      status: "idle",
      phase: "complete",
      chunkId: null,
      startedAt: null,
      pendingJobs: 0,
      sidecarState: null,
      lastError: failed.lastError,
    });
    expect(normalized.error).toBeUndefined();
  });
});
