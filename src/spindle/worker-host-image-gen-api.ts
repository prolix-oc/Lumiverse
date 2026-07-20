import { getImageProvider, getImageProviderList } from "../image-gen/registry";
import "../image-gen/index";
import type { ImageProvider } from "../image-gen/provider";
import type { ImageGenRequest, ImageGenResponse } from "../image-gen/types";
import * as imageGenConnSvc from "../services/image-gen-connections.service";
import { PERMISSION_DENIED_PREFIX, type SpindlePermission } from "lumiverse-spindle-types";

type ImageGenStreamEvent =
  | {
      type: "status";
      step?: number;
      totalSteps?: number;
      nodeId?: string;
    }
  | {
      type: "preview";
      imageDataUrl: string;
      step?: number;
      totalSteps?: number;
      nodeId?: string;
    }
  | { type: "done"; result: Record<string, unknown> };

type WorkerHostImageGenApiContext = {
  extensionIdentifier: string;
  hasPermission: (permission: SpindlePermission) => boolean;
  resolveEffectiveUserId: (userId?: string) => string;
  enforceScopedUser: (userId: string) => void;
  post: (message: unknown) => void;
};

type ResolvedImageGeneration = {
  userId: string;
  connection: ReturnType<typeof imageGenConnSvc.getConnection> extends infer T ? NonNullable<T> : never;
  provider: NonNullable<ReturnType<typeof getImageProvider>>;
  apiKey: string;
  request: ImageGenRequest;
};

type WebSocketPreviewImageProvider = ImageProvider & {
  generateStream: NonNullable<ImageProvider["generateStream"]>;
};

/**
 * `generateStream` alone is not enough: an extension-facing stream promises
 * WebSocket previews and status, so providers must explicitly advertise both.
 */
export function supportsWebSocketPreviewStreaming(
  provider: ImageProvider,
): provider is WebSocketPreviewImageProvider {
  return Boolean(
    provider.capabilities.websocketPreviewStreaming?.previews
    && provider.capabilities.websocketPreviewStreaming.status
    && typeof provider.generateStream === "function",
  );
}

/**
 * Image-generation bridge for a Spindle worker.
 *
 * The stream API deliberately accepts only providers that advertise the
 * WebSocket preview/status capability. Other providers retain the regular
 * request/response API and cannot accidentally expose a partial stream.
 */
export class WorkerHostImageGenApi {
  private streamAbortControllers = new Map<string, AbortController>();

  constructor(private readonly context: WorkerHostImageGenApiContext) {}

  private postResponse(requestId: string, result?: unknown, error?: string): void {
    this.context.post({
      type: "response",
      requestId,
      ...(error ? { error } : { result }),
    });
  }

  private postStreamEvent(requestId: string, event: ImageGenStreamEvent): void {
    this.context.post({ type: "image_gen_stream_chunk", requestId, event });
  }

  private postStreamError(requestId: string, error: string): void {
    this.context.post({ type: "image_gen_stream_error", requestId, error });
  }

  private requirePermission(): void {
    if (!this.context.hasPermission("image_gen")) {
      throw new Error(`${PERMISSION_DENIED_PREFIX} image_gen — Image generation permission not granted`);
    }
  }

  private async resolveGeneration(input: any, signal?: AbortSignal): Promise<ResolvedImageGeneration> {
    this.requirePermission();

    const userId = this.context.resolveEffectiveUserId(input?.userId);
    if (!userId) throw new Error("userId is required for operator-scoped extensions");
    this.context.enforceScopedUser(userId);

    const connectionId = typeof input?.connection_id === "string" ? input.connection_id : null;
    const connection = connectionId
      ? imageGenConnSvc.getConnection(userId, connectionId)
      : imageGenConnSvc.getDefaultConnection(userId);
    if (!connection) {
      throw new Error(connectionId ? "Image gen connection not found" : "No default image gen connection configured");
    }

    const provider = getImageProvider(connection.provider);
    if (!provider) throw new Error(`Unknown image gen provider: ${connection.provider}`);

    const { getSecret } = await import("../services/secrets.service");
    const apiKey = await getSecret(userId, imageGenConnSvc.imageGenConnectionSecretKey(connection.id));
    if (!apiKey && provider.capabilities.apiKeyRequired) {
      throw new Error(`No API key for image gen connection "${connection.name}"`);
    }

    return {
      userId,
      connection,
      provider,
      apiKey: apiKey || "",
      request: {
        prompt: typeof input?.prompt === "string" ? input.prompt : "",
        negativePrompt: typeof input?.negativePrompt === "string" ? input.negativePrompt : undefined,
        model: typeof input?.model === "string" && input.model ? input.model : connection.model,
        parameters: { ...connection.default_parameters, ...(input?.parameters || {}) },
        signal,
      },
    };
  }

  private async persistResult(
    result: ImageGenResponse,
    generation: ResolvedImageGeneration,
    input: any,
  ): Promise<Record<string, unknown>> {
    let imageId: string | undefined;
    let imageUrl: string | undefined;

    if (result.imageDataUrl) {
      try {
        const { saveImageFromDataUrl } = await import("../services/images.service");
        const image = await saveImageFromDataUrl(
          generation.userId,
          result.imageDataUrl,
          `image-gen-${generation.connection.provider}-${Date.now()}.png`,
          {
            owner_extension_identifier: this.context.extensionIdentifier,
            owner_character_id: typeof input?.owner_character_id === "string" && input.owner_character_id.trim()
              ? input.owner_character_id.trim()
              : undefined,
            owner_chat_id: typeof input?.owner_chat_id === "string" && input.owner_chat_id.trim()
              ? input.owner_chat_id.trim()
              : undefined,
          },
        );
        imageId = image.id;
        imageUrl = `/api/v1/image-gen/results/${image.id}`;
      } catch {
        // Persisting a generated image is best effort; the data URL is still usable.
      }
    }

    return { ...result, imageId, imageUrl };
  }

  async handleGenerate(requestId: string, input: any): Promise<void> {
    try {
      const generation = await this.resolveGeneration(input);
      const result = await generation.provider.generate(
        generation.apiKey,
        generation.connection.api_url || "",
        generation.request,
      );
      this.postResponse(requestId, await this.persistResult(result, generation, input));
    } catch (err: any) {
      this.postResponse(requestId, undefined, err?.message ?? String(err));
    }
  }

  handleProviders(requestId: string): void {
    try {
      this.requirePermission();
      const providers = getImageProviderList().map((provider) => ({
        id: provider.name,
        name: provider.displayName,
        capabilities: provider.capabilities,
      }));
      this.postResponse(requestId, providers);
    } catch (err: any) {
      this.postResponse(requestId, undefined, err?.message ?? String(err));
    }
  }

  handleConnectionsList(requestId: string, userId?: string): void {
    try {
      this.requirePermission();
      const resolvedUserId = this.context.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.context.enforceScopedUser(resolvedUserId);
      const result = imageGenConnSvc.listConnections(resolvedUserId, { limit: 100, offset: 0 });
      this.postResponse(requestId, result.data);
    } catch (err: any) {
      this.postResponse(requestId, undefined, err?.message ?? String(err));
    }
  }

  handleConnectionsGet(requestId: string, connectionId: string, userId?: string): void {
    try {
      this.requirePermission();
      const resolvedUserId = this.context.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.context.enforceScopedUser(resolvedUserId);
      this.postResponse(requestId, imageGenConnSvc.getConnection(resolvedUserId, connectionId));
    } catch (err: any) {
      this.postResponse(requestId, undefined, err?.message ?? String(err));
    }
  }

  async handleModels(requestId: string, connectionId: string, userId?: string): Promise<void> {
    try {
      this.requirePermission();
      const resolvedUserId = this.context.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.context.enforceScopedUser(resolvedUserId);
      const result = await imageGenConnSvc.listConnectionModels(resolvedUserId, connectionId);
      if (result.error) throw new Error(result.error);
      this.postResponse(requestId, result.models);
    } catch (err: any) {
      this.postResponse(requestId, undefined, err?.message ?? String(err));
    }
  }

  async handleGenerateStream(requestId: string, input: any): Promise<void> {
    const abortController = new AbortController();
    this.streamAbortControllers.set(requestId, abortController);

    try {
      const generation = await this.resolveGeneration(input, abortController.signal);
      const { provider } = generation;
      if (!supportsWebSocketPreviewStreaming(provider)) {
        throw new Error(`${provider.displayName} does not support WebSocket preview/status streaming`);
      }

      const stream = provider.generateStream(
        generation.apiKey,
        generation.connection.api_url || "",
        generation.request,
      );
      while (true) {
        const next = await stream.next();
        if (next.done) {
          const result = await this.persistResult(next.value, generation, input);
          this.postStreamEvent(requestId, { type: "done", result });
          return;
        }

        const update = next.value;
        const hasStatus = typeof update.step === "number"
          || typeof update.totalSteps === "number"
          || typeof update.nodeId === "string";
        if (hasStatus) {
          this.postStreamEvent(requestId, {
            type: "status",
            ...(typeof update.step === "number" ? { step: update.step } : {}),
            ...(typeof update.totalSteps === "number" ? { totalSteps: update.totalSteps } : {}),
            ...(typeof update.nodeId === "string" ? { nodeId: update.nodeId } : {}),
          });
        }
        if (typeof update.preview === "string" && update.preview) {
          this.postStreamEvent(requestId, {
            type: "preview",
            imageDataUrl: update.preview,
            ...(typeof update.step === "number" ? { step: update.step } : {}),
            ...(typeof update.totalSteps === "number" ? { totalSteps: update.totalSteps } : {}),
            ...(typeof update.nodeId === "string" ? { nodeId: update.nodeId } : {}),
          });
        }
      }
    } catch (err: any) {
      const aborted = abortController.signal.aborted || err?.name === "AbortError";
      this.postStreamError(
        requestId,
        aborted ? "AbortError: Image generation aborted" : err?.message ?? String(err),
      );
    } finally {
      this.streamAbortControllers.delete(requestId);
    }
  }

  cancelStream(requestId: string): void {
    this.streamAbortControllers.get(requestId)?.abort();
  }
}
