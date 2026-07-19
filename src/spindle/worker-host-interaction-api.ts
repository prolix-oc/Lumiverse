import type { SpindleCommandContextDTO, SpindleCommandDTO, SpindleManifest } from "lumiverse-spindle-types";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

const TOAST_RATE_LIMIT = 5;
const TOAST_RATE_WINDOW_MS = 10_000;
const MAX_COMMANDS_PER_EXTENSION = 20;

export type WorkerHostInteractionApiContext = {
  extensionId: string;
  manifest: SpindleManifest;
  installScope: "operator" | "user";
  installedByUserId: string | null;
  isRuntimeActive: () => boolean;
  resolveEffectiveUserId: (userId?: string) => string | null;
  enforceScopedUser: (userId: string | null | undefined) => void;
  post: (message: unknown) => void;
};

/** Owns frontend-facing toast and command registration state. */
export class WorkerHostInteractionApi {
  private toastTimestamps: number[] = [];
  private registeredCommands: SpindleCommandDTO[] = [];

  constructor(private readonly context: WorkerHostInteractionApiContext) {}

  private get extensionId(): string { return this.context.extensionId; }
  private get manifest(): SpindleManifest { return this.context.manifest; }
  private get installScope(): "operator" | "user" { return this.context.installScope; }
  private get installedByUserId(): string | null { return this.context.installedByUserId; }
  private get runtime(): object | null { return this.context.isRuntimeActive() ? {} : null; }
  private resolveEffectiveUserId(userId?: string): string | null { return this.context.resolveEffectiveUserId(userId); }
  private enforceScopedUser(userId: string | null | undefined): void { this.context.enforceScopedUser(userId); }
  private postToWorker(message: unknown): void { this.context.post(message); }

  handleToastShow(
    toastType: string,
    message: string,
    title?: string,
    duration?: number,
    userId?: string,
  ): void {
    const validTypes = ["success", "warning", "error", "info"];
    if (!validTypes.includes(toastType)) {
      console.warn(`[Spindle:${this.manifest.identifier}] Invalid toast type: ${toastType}`);
      return;
    }

    if (typeof message !== "string" || !message.trim()) {
      console.warn(`[Spindle:${this.manifest.identifier}] Toast message must be a non-empty string`);
      return;
    }

    // Sliding-window rate limit
    const now = Date.now();
    this.toastTimestamps = this.toastTimestamps.filter(
      (t) => now - t < TOAST_RATE_WINDOW_MS,
    );
    if (this.toastTimestamps.length >= TOAST_RATE_LIMIT) {
      console.warn(
        `[Spindle:${this.manifest.identifier}] Toast rate limit exceeded (${TOAST_RATE_LIMIT}/${TOAST_RATE_WINDOW_MS}ms)`,
      );
      return;
    }
    this.toastTimestamps.push(now);

    // Sanitize inputs
    const sanitizedMessage = message.slice(0, 500);
    const sanitizedTitle = title ? title.slice(0, 100) : undefined;
    let sanitizedDuration = duration;
    if (sanitizedDuration !== undefined) {
      sanitizedDuration = Math.max(1000, Math.min(30_000, sanitizedDuration));
    }

    let targetUserId: string | undefined;
    if (this.installScope === "user") {
      targetUserId = this.installedByUserId ?? undefined;
    } else if (typeof userId === "string" && userId.trim()) {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (resolvedUserId) {
        this.enforceScopedUser(resolvedUserId);
        targetUserId = resolvedUserId;
      }
    }

    // Broadcast only when an operator-scoped extension omits userId.
    eventBus.emit(
      EventType.SPINDLE_TOAST,
      {
        extensionId: this.extensionId,
        extensionName: this.manifest.name,
        type: toastType,
        message: sanitizedMessage,
        title: sanitizedTitle,
        duration: sanitizedDuration,
      },
      targetUserId,
    );
  }

  // ─── Commands (free tier) ─────────────────────────────────────────────

  handleCommandsRegister(commands: SpindleCommandDTO[]): void {
    if (!Array.isArray(commands)) {
      console.warn(`[Spindle:${this.manifest.identifier}] commands_register: expected array`);
      return;
    }

    if (commands.length > MAX_COMMANDS_PER_EXTENSION) {
      console.warn(
        `[Spindle:${this.manifest.identifier}] Command limit exceeded (${commands.length}/${MAX_COMMANDS_PER_EXTENSION}), truncating`,
      );
      commands = commands.slice(0, MAX_COMMANDS_PER_EXTENSION);
    }

    // Validate and sanitize each command
    const validated: SpindleCommandDTO[] = [];
    const seenIds = new Set<string>();
    const validScopes = ["global", "chat", "chat-idle", "landing", "character"];

    for (const cmd of commands) {
      if (!cmd || typeof cmd.id !== "string" || !cmd.id.trim()) continue;
      if (!cmd.label || typeof cmd.label !== "string") continue;
      if (seenIds.has(cmd.id)) continue;
      seenIds.add(cmd.id);

      validated.push({
        id: cmd.id.slice(0, 100),
        label: (cmd.label || "").slice(0, 80),
        description: (cmd.description || "").slice(0, 200),
        keywords: Array.isArray(cmd.keywords)
          ? cmd.keywords.filter((k): k is string => typeof k === "string").slice(0, 10).map((k) => k.slice(0, 30))
          : undefined,
        scope: validScopes.includes(cmd.scope as string) ? cmd.scope : undefined,
      });
    }

    this.registeredCommands = validated;
    this.broadcastCommandsChanged();
  }

  handleCommandsUnregister(commandIds: string[]): void {
    if (!Array.isArray(commandIds) || commandIds.length === 0) {
      // Remove all commands
      this.registeredCommands = [];
    } else {
      const idsToRemove = new Set(commandIds.filter((id) => typeof id === "string"));
      this.registeredCommands = this.registeredCommands.filter((c) => !idsToRemove.has(c.id));
    }
    this.broadcastCommandsChanged();
  }

  broadcastCommandsChanged(): void {
    eventBus.emit(
      EventType.SPINDLE_COMMANDS_CHANGED,
      {
        extensionId: this.extensionId,
        extensionName: this.manifest.name,
        commands: this.registeredCommands,
      },
      this.installScope === "user" ? this.installedByUserId ?? undefined : undefined,
    );
  }

  /** Called by the WS handler when the frontend invokes a command. */
  invokeCommand(commandId: string, context: SpindleCommandContextDTO, userId: string): void {
    if (!this.runtime) return;
    if (!this.registeredCommands.some((c) => c.id === commandId)) {
      console.warn(
        `[Spindle:${this.manifest.identifier}] Command "${commandId}" not registered`,
      );
      return;
    }
    this.postToWorker({
      type: "command_invoked",
      commandId,
      context,
      userId,
    });
  }

  /** Expose registered commands for lookup from the WS handler. */
  getRegisteredCommands(): SpindleCommandDTO[] {
    return this.registeredCommands;
  }

  // ─── UI Automation (free tier) ────────────────────────────────────────


  clear(): void {
    this.toastTimestamps = [];
    if (this.registeredCommands.length > 0) {
      this.registeredCommands = [];
      this.broadcastCommandsChanged();
    }
  }
}
