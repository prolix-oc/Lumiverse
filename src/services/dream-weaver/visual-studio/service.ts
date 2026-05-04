import "../../../image-gen/index";
import { getImageProvider } from "../../../image-gen/registry";
import type { ImageGenConnectionProfile } from "../../../types/image-gen-connection";
import type { DreamWeaverVisualAsset } from "../../../types/dream-weaver";
import { eventBus } from "../../../ws/bus";
import { EventType } from "../../../ws/events";
import { getVisualProviderAdapter } from "./provider-registry";
import { resolveVisualAssetPrompts } from "./prompt-resolution";
import {
  completeVisualJob,
  createVisualJob,
  failVisualJob,
  getVisualJob,
  updateVisualJobProgress,
  type DreamWeaverVisualJob,
  type DreamWeaverVisualJobResult,
} from "./jobs";
import type { DW_DRAFT_V1 } from "../../../types/dream-weaver";

export interface StartDreamWeaverVisualJobInput {
  userId: string;
  sessionId: string;
  draft?: DW_DRAFT_V1 | null;
  asset: DreamWeaverVisualAsset;
  connection: ImageGenConnectionProfile;
  apiKey: string;
  /** Optional AbortSignal for generation timeout. */
  signal?: AbortSignal;
  /** Called when the job settles (success or failure). Use to clean up external timers/resources. */
  onSettled?: () => void;
  persistResult: (input: {
    job: DreamWeaverVisualJob;
    result: DreamWeaverVisualJobResult;
  }) => Promise<DreamWeaverVisualJobResult | void>;
}

function emitJobEvent(event: EventType, job: DreamWeaverVisualJob): void {
  eventBus.emit(event, job, job.userId);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toPublicVisualError(error: unknown): string {
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (error.name === "AbortError" || lower.includes("abort") || lower.includes("timed out")) {
      return "Image generation timed out. Try again with a shorter prompt or a longer timeout.";
    }
    if (lower.includes("unsupported")) {
      return "That image provider is not supported for Dream Weaver visuals.";
    }
  }
  return "Image generation failed. Check the image connection and try again.";
}

async function generateWithOptionalStreaming(
  job: DreamWeaverVisualJob,
  input: StartDreamWeaverVisualJobInput,
  settingsSnapshot: Record<string, unknown>,
): Promise<DreamWeaverVisualJobResult> {
  const provider = getImageProvider(input.connection.provider);
  if (!provider) {
    throw new Error(`Unsupported image provider: ${input.connection.provider}`);
  }

  const adapter = getVisualProviderAdapter(input.asset.provider!);
  if (!adapter) {
    throw new Error(`Unsupported Dream Weaver visual provider: ${input.asset.provider}`);
  }

  const resolvedAsset = resolveVisualAssetPrompts(input.asset, input.draft);

  const validationErrors = await adapter.validate(resolvedAsset, input.connection);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join(" "));
  }

  const buildResult = await adapter.build(resolvedAsset, input.connection);
  const finalSettingsSnapshot = {
    connectionId: input.connection.id,
    provider: input.connection.provider,
    model: input.connection.model,
    ...settingsSnapshot,
    ...buildResult.settingsSnapshot,
  };

  updateVisualJobProgress(job.id, job.userId, {
    stage: "generating",
    message: "Generating image",
  });
  emitJobEvent(EventType.DREAM_WEAVER_VISUAL_JOB_PROGRESS, getVisualJob(job.id, job.userId)!);

  if (input.signal) {
    buildResult.request.signal = input.signal;
  }

  if (provider.generateStream) {
    const stream = provider.generateStream(
      input.apiKey,
      input.connection.api_url || provider.capabilities.defaultUrl || "",
      buildResult.request,
    );

    let iteration = await stream.next();
    while (!iteration.done) {
      const progress = updateVisualJobProgress(job.id, job.userId, {
        stage: "generating",
        message: "Generating image",
        step: iteration.value.step,
        totalSteps: iteration.value.totalSteps,
        preview: iteration.value.preview,
        nodeId: iteration.value.nodeId,
      });
      emitJobEvent(EventType.DREAM_WEAVER_VISUAL_JOB_PROGRESS, progress);
      iteration = await stream.next();
    }

    return {
      image_url: iteration.value.imageDataUrl,
      settingsSnapshot: finalSettingsSnapshot,
    };
  }

  const response = await provider.generate(
    input.apiKey,
    input.connection.api_url || provider.capabilities.defaultUrl || "",
    buildResult.request,
  );

  return {
    image_url: response.imageDataUrl,
    settingsSnapshot: finalSettingsSnapshot,
  };
}

async function executeDreamWeaverVisualJob(
  job: DreamWeaverVisualJob,
  input: StartDreamWeaverVisualJobInput,
): Promise<void> {
  console.debug("[DreamWeaver:Visual] Starting job=%s session=%s asset=%s provider=%s", job.id, job.sessionId, job.assetId, input.connection.provider)
  try {
    const preparing = updateVisualJobProgress(job.id, job.userId, {
      stage: "preparing",
      message: "Preparing provider request",
    });
    emitJobEvent(EventType.DREAM_WEAVER_VISUAL_JOB_PROGRESS, preparing);

    const result = await generateWithOptionalStreaming(job, input, {
      assetId: input.asset.id,
      assetLabel: input.asset.label,
    });

    const persisting = updateVisualJobProgress(job.id, job.userId, {
      stage: "persisting",
      message: "Saving generated image",
    });
    emitJobEvent(EventType.DREAM_WEAVER_VISUAL_JOB_PROGRESS, persisting);

    const persistedResult = await input.persistResult({
      job,
      result,
    });

    const finalResult = persistedResult ?? result;
    console.debug(
      "[DreamWeaver:Visual] Job completed. job=%s image_id=%s has_url=%s",
      job.id,
      finalResult.image_id ?? "(none)",
      Boolean(finalResult.image_url),
    );
    const completed = completeVisualJob(job.id, job.userId, finalResult);
    emitJobEvent(EventType.DREAM_WEAVER_VISUAL_JOB_COMPLETED, completed);
  } catch (error) {
    console.error("[DreamWeaver:Visual] Job failed. job=%s error=%s", job.id, toErrorMessage(error));
    const failed = failVisualJob(job.id, job.userId, toPublicVisualError(error));
    emitJobEvent(EventType.DREAM_WEAVER_VISUAL_JOB_FAILED, failed);
  } finally {
    input.onSettled?.();
  }
}

export function startDreamWeaverVisualJob(
  input: StartDreamWeaverVisualJobInput,
): DreamWeaverVisualJob {
  const job = createVisualJob({
    userId: input.userId,
    sessionId: input.sessionId,
    assetId: input.asset.id,
    connectionId: input.connection.id,
  });

  emitJobEvent(EventType.DREAM_WEAVER_VISUAL_JOB_CREATED, job);
  void executeDreamWeaverVisualJob(job, input);
  return job;
}

export function getDreamWeaverVisualJob(
  userId: string,
  jobId: string,
): DreamWeaverVisualJob | null {
  return getVisualJob(jobId, userId);
}
