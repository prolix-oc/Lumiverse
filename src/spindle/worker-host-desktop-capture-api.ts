import { createHash } from "node:crypto";
import { PERMISSION_DENIED_PREFIX } from "lumiverse-spindle-types";
import * as connections from "../services/connections.service";
import type { LlmMessage } from "../llm/types";
import { resolveVertexModelRoute } from "../llm/providers/google-vertex";
import { desktopCaptureBroker, DesktopCaptureBroker, DesktopCaptureError, type DesktopCaptureOwner } from "./desktop-capture-broker";
import type { DesktopCaptureDestination, DesktopCaptureKind, DesktopCaptureWorkerMessage } from "./desktop-capture-contract";

type CapturePermission = "screen_capture" | "screen_recording" | "generation";

export interface WorkerHostDesktopCaptureContext {
  extensionId: string;
  identifier: string;
  name: string;
  declaredPermissions: readonly string[];
  hasPermission: (permission: CapturePermission) => boolean;
  authorize: (permissions: CapturePermission[]) => () => boolean;
  resolveEffectiveUserId: (userId?: string) => string;
  enforceScopedUser: (userId: string) => void;
  postResponse: (message: { type: "response"; requestId: string; result?: unknown; error?: string }) => void;
  resolveDestination?: (userId: string, connectionId: string) => DesktopCaptureDestination;
}

export function resolveCaptureDestination(userId: string, connectionId: string): DesktopCaptureDestination {
  if (typeof connectionId !== "string" || !connectionId) throw new DesktopCaptureError("CAPTURE_CONNECTION_REQUIRED");
  const connection = connections.resolveConnection(userId, connectionId);
  if (!connection || !connection.model) throw new DesktopCaptureError("CAPTURE_CONNECTION_UNAVAILABLE", 404);
  const endpoint = connections.resolveEffectiveApiUrl(connection);
  const endpointOrigin = endpoint ? new URL(endpoint).origin : "provider-default";
  return {
    connectionId: connection.id,
    revision: createHash("sha256").update(JSON.stringify({ connection, endpoint })).digest("hex"),
    provider: connection.provider, model: connection.model, endpointOrigin,
  };
}

export function hasDesktopCaptureParts(messages: unknown): boolean {
  return Array.isArray(messages) && messages.some((message) => message && Array.isArray(message.content)
    && message.content.some((part: { type?: string } | null) => part?.type === "desktop_capture"));
}

export class WorkerHostDesktopCaptureApi {
  private runtimeId = crypto.randomUUID();
  private active = true;

  constructor(private readonly context: WorkerHostDesktopCaptureContext,
    private readonly broker: DesktopCaptureBroker = desktopCaptureBroker) {}

  private requirePermission(permission: CapturePermission): void {
    if (!this.context.declaredPermissions.includes(permission) || !this.context.hasPermission(permission)) {
      throw new Error(`${PERMISSION_DENIED_PREFIX} ${permission} — Desktop capture permission not granted`);
    }
  }

  private resolveOwner(userId?: string): DesktopCaptureOwner {
    const resolved = this.context.resolveEffectiveUserId(userId);
    if (!resolved) throw new Error("userId is required for operator-scoped extensions");
    this.context.enforceScopedUser(resolved);
    return { runtimeId: this.runtimeId, extensionId: this.context.extensionId,
      identifier: this.context.identifier, name: this.context.name, userId: resolved };
  }

  private destination(userId: string, connectionId: string): DesktopCaptureDestination {
    return (this.context.resolveDestination ?? resolveCaptureDestination)(userId, connectionId);
  }

  private requireMediaSupport(destination: DesktopCaptureDestination, kind: DesktopCaptureKind): void {
    const supported = kind === "video" ? ["google", "google_vertex"]
      : ["google", "google_vertex", "openai", "anthropic", "openrouter"];
    if (!supported.includes(destination.provider)
      || (kind === "video" && destination.provider === "google_vertex" && resolveVertexModelRoute(destination.model).protocol !== "gemini")) {
      throw new DesktopCaptureError("CAPTURE_PROVIDER_UNSUPPORTED", 409);
    }
  }

  handle(message: DesktopCaptureWorkerMessage): void {
    const runtimeId = this.runtimeId;
    void Promise.resolve().then(async () => {
      if (!this.active || runtimeId !== this.runtimeId) throw new DesktopCaptureError("CAPTURE_REVOKED");
      if (message.type === "desktop_capture_devices") {
        const allowed = ["screen_capture", "screen_recording"].some((permission) =>
          this.context.declaredPermissions.includes(permission) && this.context.hasPermission(permission as CapturePermission));
        if (!allowed) this.requirePermission("screen_capture");
        return this.broker.listDevices(this.resolveOwner(message.userId).userId);
      }
      if (message.type === "desktop_capture_release") {
        this.broker.release(this.resolveOwner(message.userId), message.assetId);
        return;
      }
      const input = message.input;
      if (!input || !["image", "video"].includes(input.kind)) throw new DesktopCaptureError("INVALID_CAPTURE_REQUEST");
      const permission = input.kind === "image" ? "screen_capture" : "screen_recording";
      this.requirePermission(permission);
      this.requirePermission("generation");
      const owner = this.resolveOwner(input.userId);
      const destination = this.destination(owner.userId, input.connectionId);
      this.requireMediaSupport(destination, input.kind);
      const permissionCheck = this.context.authorize([permission, "generation"]);
      const authorized = () => {
        if (owner.runtimeId !== this.runtimeId || !permissionCheck()) return false;
        try { return this.destination(owner.userId, input.connectionId).revision === destination.revision; }
        catch { return false; }
      };
      return this.broker.request(owner, input, destination, authorized);
    }).then((result) => this.context.postResponse({ type: "response", requestId: message.requestId, result }))
      .catch((error: unknown) => this.context.postResponse({ type: "response", requestId: message.requestId,
        error: error instanceof Error ? error.message : "CAPTURE_FAILED" }));
  }

  prepareGeneration(input: { type: string; messages?: LlmMessage[]; requests?: Array<{ messages?: LlmMessage[] }>;
    connection_id?: string; provider?: string; model?: string; parameters?: Record<string, unknown> }, userId: string): { messages: LlmMessage[]; sensitiveMedia: boolean } {
    const sensitiveMedia = hasDesktopCaptureParts(input.messages);
    if (input.type !== "raw" && (sensitiveMedia || input.requests?.some((request) => hasDesktopCaptureParts(request.messages)))) {
      throw new DesktopCaptureError("CAPTURE_REQUIRES_RAW_GENERATION");
    }
    if (!sensitiveMedia) return { messages: input.messages ?? [], sensitiveMedia: false };
    if (!this.active) throw new DesktopCaptureError("CAPTURE_REVOKED");
    this.requirePermission("generation");
    const owner = this.resolveOwner(userId);
    const destination = this.destination(owner.userId, input.connection_id ?? "");
    if ((input.provider && input.provider !== destination.provider) || input.model !== destination.model) {
      throw new DesktopCaptureError("CAPTURE_DESTINATION_CHANGED", 403);
    }
    const protectedParameters = new Set(["model", "models", "provider", "route", "_openrouter", "api_url", "base_url", "url", "endpoint", "headers", "authorization", "connection_id", "messages", "input"]);
    if (input.parameters !== undefined && (!input.parameters || typeof input.parameters !== "object"
      || Array.isArray(input.parameters) || Object.keys(input.parameters).some((key) => protectedParameters.has(key)))) {
      throw new DesktopCaptureError("CAPTURE_UNSAFE_PARAMETERS", 403);
    }
    const messages = this.broker.resolveMessages(owner, input.messages ?? [], destination, (kind) => {
      this.requirePermission(kind === "image" ? "screen_capture" : "screen_recording");
      this.requireMediaSupport(destination, kind);
      return true;
    });
    return { messages, sensitiveMedia: true };
  }

  revoke(): void {
    this.broker.revokeRuntime(this.runtimeId);
    this.runtimeId = crypto.randomUUID();
  }

  activate(): void {
    this.revoke();
    this.active = true;
  }

  dispose(): void {
    this.active = false;
    this.revoke();
  }
}
