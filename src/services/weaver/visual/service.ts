import "../../../image-gen/index";
import { getImageProvider } from "../../../image-gen/registry";
import type { ImageGenConnectionProfile } from "../../../types/image-gen-connection";
import type {
  WeaverVisualAsset,
  WeaverVisualGenerateInput,
  WeaverVisualJob,
  WeaverVisualJobResult,
  WeaverVisualSourceImage,
} from "../../../types/weaver";
import { eventBus } from "../../../ws/bus";
import { EventType } from "../../../ws/events";
import { getVisualKind } from "./kinds";
import { getVisualProviderAdapter } from "./provider-registry";
import { resolveVisualAssetPrompts } from "./prompt-resolution";
import {
  completeVisualJob,
  createVisualJob,
  failVisualJob,
  getVisualJob,
  updateVisualJobProgress,
} from "./jobs";

export interface StartWeaverVisualJobInput {
  userId: string;
  sessionId: string;
  characterId: string;
  input: WeaverVisualGenerateInput;
  connection: ImageGenConnectionProfile;
  apiKey: string;
  sourceImage?: WeaverVisualSourceImage;
  macroValues?: Record<string, string | undefined>;
  signal?: AbortSignal;
  onSettled?: () => void;
  persistResult: (input: {
    job: WeaverVisualJob;
    result: WeaverVisualJobResult;
  }) => Promise<WeaverVisualJobResult | void>;
}

function emitJobEvent(event: EventType, job: WeaverVisualJob): void {
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
      return "That image provider is not supported for Visual Studio.";
    }
  }
  return "Image generation failed. Check the image connection and try again.";
}

export function buildVisualAsset(
  input: WeaverVisualGenerateInput,
  connection: ImageGenConnectionProfile,
  sourceImage?: WeaverVisualSourceImage,
): WeaverVisualAsset {
  const kindMeta = getVisualKind(input.kind);
  return {
    kind: input.kind,
    prompt: input.prompt,
    negative_prompt: input.negative_prompt ?? kindMeta?.base_negative ?? "",
    width: input.width ?? kindMeta?.width ?? 1024,
    height: input.height ?? kindMeta?.height ?? 1024,
    aspect_ratio: input.aspect_ratio ?? kindMeta?.aspect_ratio ?? "1:1",
    seed: input.seed ?? null,
    provider: connection.provider as WeaverVisualAsset["provider"],
    provider_state: input.provider_state ?? {},
    variant: input.variant,
    ...(sourceImage ? { source_image: sourceImage } : {}),
  };
}

async function generateWithOptionalStreaming(
  job: WeaverVisualJob,
  input: StartWeaverVisualJobInput,
  asset: WeaverVisualAsset,
  settingsSnapshot: Record<string, unknown>,
): Promise<WeaverVisualJobResult> {
  const provider = getImageProvider(input.connection.provider);
  if (!provider) {
    throw new Error(`Unsupported image provider: ${input.connection.provider}`);
  }

  const adapter = getVisualProviderAdapter(input.connection.provider as WeaverVisualAsset["provider"] & string);
  if (!adapter) {
    throw new Error(`Unsupported Visual Studio provider: ${input.connection.provider}`);
  }

  const resolvedAsset = resolveVisualAssetPrompts(asset, input.macroValues ?? {});

  const validationErrors = await adapter.validate(resolvedAsset, input.connection, input.apiKey);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join(" "));
  }

  const buildResult = await adapter.build(resolvedAsset, input.connection, input.apiKey);
  const finalSettingsSnapshot = {
    connectionId: input.connection.id,
    provider: input.connection.provider,
    model: input.connection.model,
    ...settingsSnapshot,
    ...buildResult.settingsSnapshot,
  };

  emitJobEvent(
    EventType.WEAVER_VISUAL_JOB_PROGRESS,
    updateVisualJobProgress(job.id, job.userId, {
      stage: "generating",
      message: "Generating image",
    }),
  );

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
      emitJobEvent(EventType.WEAVER_VISUAL_JOB_PROGRESS, progress);
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

async function executeWeaverVisualJob(
  job: WeaverVisualJob,
  input: StartWeaverVisualJobInput,
): Promise<void> {
  console.debug(
    "[Weaver:Visual] Starting job=%s session=%s kind=%s provider=%s",
    job.id,
    job.sessionId,
    job.kind,
    input.connection.provider,
  );
  try {
    const asset = buildVisualAsset(input.input, input.connection, input.sourceImage);

    emitJobEvent(
      EventType.WEAVER_VISUAL_JOB_PROGRESS,
      updateVisualJobProgress(job.id, job.userId, {
        stage: "preparing",
        message: "Preparing provider request",
      }),
    );

    const result = await generateWithOptionalStreaming(job, input, asset, {
      kind: job.kind,
      variant: job.variant ?? undefined,
    });

    emitJobEvent(
      EventType.WEAVER_VISUAL_JOB_PROGRESS,
      updateVisualJobProgress(job.id, job.userId, {
        stage: "persisting",
        message: "Saving generated image",
      }),
    );

    const persistedResult = await input.persistResult({ job, result });
    const finalResult = persistedResult ?? result;
    console.debug(
      "[Weaver:Visual] Job completed. job=%s image_id=%s has_url=%s",
      job.id,
      finalResult.image_id ?? "(none)",
      Boolean(finalResult.image_url),
    );
    emitJobEvent(
      EventType.WEAVER_VISUAL_JOB_COMPLETED,
      completeVisualJob(job.id, job.userId, finalResult),
    );
  } catch (error) {
    console.error("[Weaver:Visual] Job failed. job=%s error=%s", job.id, toErrorMessage(error));
    emitJobEvent(
      EventType.WEAVER_VISUAL_JOB_FAILED,
      failVisualJob(job.id, job.userId, toPublicVisualError(error)),
    );
  } finally {
    input.onSettled?.();
  }
}

export function startWeaverVisualJob(input: StartWeaverVisualJobInput): WeaverVisualJob {
  const job = createVisualJob({
    userId: input.userId,
    sessionId: input.sessionId,
    characterId: input.characterId,
    kind: input.input.kind,
    variant: input.input.variant ?? null,
    connectionId: input.connection.id,
  });

  emitJobEvent(EventType.WEAVER_VISUAL_JOB_CREATED, job);
  void executeWeaverVisualJob(job, input);
  return job;
}

export function getWeaverVisualJob(userId: string, jobId: string): WeaverVisualJob | null {
  return getVisualJob(jobId, userId);
}
