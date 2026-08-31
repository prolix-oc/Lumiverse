import { PERMISSION_DENIED_PREFIX, type HostResponseErrorDTO, type HostToWorker } from "lumiverse-spindle-types";
import * as chatsSvc from "../services/chats.service";
import * as settingsSvc from "../services/settings.service";
import * as presetsSvc from "../services/presets.service";
import {
  AGENT_RUNTIME_RESERVED_PRESET_KEYS,
  scrubPresetMetadata,
} from "../services/agent-config-portability.service";
import { PresetRevisionConflictError, type CreatePresetInput, type Preset, type UpdatePresetInput } from "../types/preset";

/**
 * Agentic runtime configuration is host-owned. These keys are accepted only
 * by authenticated host config/import surfaces, never by Spindle preset state.
 */
const SPINDLE_PRESET_RESERVED_KEYS = new Set<string>(AGENT_RUNTIME_RESERVED_PRESET_KEYS);

export class SpindlePresetReservedKeyError extends Error {
  readonly code = "SPINDLE_PRESET_RESERVED_KEY";
  readonly path: string;

  constructor(path: string) {
    super(`Preset field ${path} is reserved for host Agentic runtime authority`);
    this.name = "SpindlePresetReservedKeyError";
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSpindlePresetMetadataMutationSafe(metadata: unknown): void {
  if (!isRecord(metadata)) return;

  // Reuse the authenticated projection helper so the canonical marker set
  // cannot drift between host and Spindle boundaries.
  const scrubbed = scrubPresetMetadata(metadata);
  for (const key of Object.keys(metadata)) {
    if (!Object.hasOwn(scrubbed, key) || SPINDLE_PRESET_RESERVED_KEYS.has(key)) {
      throw new SpindlePresetReservedKeyError(`metadata.${key}`);
    }
  }
}

/**
 * Reject a complete Spindle preset create/update/import-like payload before
 * the general preset service sees it. This deliberately rejects writes rather
 * than stripping authority fields and silently persisting the remainder.
 */
export function assertSpindlePresetMutationSafe(input: unknown): void {
  if (!isRecord(input)) return;
  for (const key of Object.keys(input)) {
    if (SPINDLE_PRESET_RESERVED_KEYS.has(key)) {
      throw new SpindlePresetReservedKeyError(key);
    }
  }
  assertSpindlePresetMetadataMutationSafe(input.metadata);
}

export type SpindlePresetProjection = Pick<
  Preset,
  "id" | "name" | "provider" | "engine" | "parameters" | "prompt_order" | "prompts" | "metadata" | "cache_revision" | "created_at" | "updated_at"
>;

/**
 * Project the host preset into the documented Spindle DTO. The normalized
 * Agentic config/review projection is intentionally not part of this DTO.
 */
export function projectSpindlePreset(preset: Preset | null): SpindlePresetProjection | null {
  if (!preset) return null;
  const metadata = projectSpindlePresetMetadata(preset.metadata);
  return {
    id: preset.id,
    name: preset.name,
    provider: preset.provider,
    engine: preset.engine,
    parameters: preset.parameters,
    prompt_order: preset.prompt_order,
    prompts: preset.prompts,
    metadata,
    cache_revision: preset.cache_revision ?? 0,
    created_at: preset.created_at,
    updated_at: preset.updated_at,
  };
}

/**
 * Entity-extension writes for presets use the metadata column. Their result
 * must therefore receive the same reserved-marker projection as preset reads.
 */
export function projectSpindlePresetEntityExtension<T extends { entity: string; extensions: Record<string, unknown> }>(result: T): T {
  if (result.entity !== "preset") return result;
  return { ...result, extensions: projectSpindlePresetMetadata(result.extensions) };
}

function projectSpindlePresetMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const projected = scrubPresetMetadata(metadata);
  for (const key of Object.keys(projected)) {
    if (SPINDLE_PRESET_RESERVED_KEYS.has(key)) delete projected[key];
  }
  return projected;
}

type HostResponseMessage = Extract<HostToWorker, { type: "response" }>;
type HostResponseError = NonNullable<HostResponseMessage["error"]>;

function presetWorkerError(err: unknown): HostResponseError {
  if (!(err instanceof PresetRevisionConflictError)) {
    return err instanceof Error ? err.message : String(err);
  }
  const conflict: HostResponseErrorDTO = {
    code: err.code,
    message: err.message,
    presetId: err.presetId,
    expectedCacheRevision: err.expectedCacheRevision,
    actualCacheRevision: err.actualCacheRevision,
  };
  return conflict;
}

export type WorkerHostStateApiContext = {
  getChatOwnerId: (chatId: string) => string | null;
  enforceScopedUser: (userId: string | null | undefined) => void;
  resolveEffectiveUserId: (requestUserId?: string) => string | null;
  hasPermission: (permission: "presets") => boolean;
  postResponse: (message: HostResponseMessage) => void;
};

/** Owns persisted variable and preset API state for a single extension host. */
export class WorkerHostStateApi {
  constructor(private readonly context: WorkerHostStateApiContext) {}

  dispatch(message: { type: string; [key: string]: unknown }): boolean {
    const msg = message as any;
    switch (msg.type) {
      case "vars_get_local": this.handleVarsGetLocal(msg.requestId, msg.chatId, msg.key); return true;
      case "vars_set_local": this.handleVarsSetLocal(msg.requestId, msg.chatId, msg.key, msg.value); return true;
      case "vars_delete_local": this.handleVarsDeleteLocal(msg.requestId, msg.chatId, msg.key); return true;
      case "vars_list_local": this.handleVarsListLocal(msg.requestId, msg.chatId); return true;
      case "vars_has_local": this.handleVarsHasLocal(msg.requestId, msg.chatId, msg.key); return true;
      case "vars_get_global": this.handleVarsGetGlobal(msg.requestId, msg.key, msg.userId); return true;
      case "vars_set_global": this.handleVarsSetGlobal(msg.requestId, msg.key, msg.value, msg.userId); return true;
      case "vars_delete_global": this.handleVarsDeleteGlobal(msg.requestId, msg.key, msg.userId); return true;
      case "vars_list_global": this.handleVarsListGlobal(msg.requestId, msg.userId); return true;
      case "vars_has_global": this.handleVarsHasGlobal(msg.requestId, msg.key, msg.userId); return true;
      case "vars_get_chat": this.handleVarsGetChat(msg.requestId, msg.chatId, msg.key); return true;
      case "vars_set_chat": this.handleVarsSetChat(msg.requestId, msg.chatId, msg.key, msg.value); return true;
      case "vars_delete_chat": this.handleVarsDeleteChat(msg.requestId, msg.chatId, msg.key); return true;
      case "vars_list_chat": this.handleVarsListChat(msg.requestId, msg.chatId); return true;
      case "vars_has_chat": this.handleVarsHasChat(msg.requestId, msg.chatId, msg.key); return true;
      case "presets_list": this.handlePresetsList(msg.requestId, msg.limit, msg.offset, msg.userId); return true;
      case "presets_get": this.handlePresetsGet(msg.requestId, msg.presetId, msg.userId); return true;
      case "presets_create": this.handlePresetsCreate(msg.requestId, msg.input, msg.userId); return true;
      case "presets_update": this.handlePresetsUpdate(msg.requestId, msg.presetId, msg.input, msg.userId); return true;
      case "presets_delete": this.handlePresetsDelete(msg.requestId, msg.presetId, msg.userId); return true;
      case "preset_blocks_list": this.handlePresetBlocksList(msg.requestId, msg.presetId, msg.userId); return true;
      case "preset_blocks_get": this.handlePresetBlocksGet(msg.requestId, msg.presetId, msg.occurrence, msg.userId); return true;
      case "preset_blocks_create": this.handlePresetBlocksCreate(msg.requestId, msg.presetId, msg.input, msg.options, msg.userId); return true;
      case "preset_blocks_update": this.handlePresetBlocksUpdate(msg.requestId, msg.presetId, msg.target, msg.input, msg.userId); return true;
      case "preset_blocks_delete": this.handlePresetBlocksDelete(msg.requestId, msg.presetId, msg.target, msg.userId); return true;
      case "preset_categories_list": this.handlePresetCategoriesList(msg.requestId, msg.presetId, msg.userId); return true;
      default: return false;
    }
  }

  private getChatOwnerId(chatId: string): string | null { return this.context.getChatOwnerId(chatId); }
  private enforceScopedUser(userId: string | null | undefined): void { this.context.enforceScopedUser(userId); }
  private resolveEffectiveUserId(userId?: string): string | null { return this.context.resolveEffectiveUserId(userId); }
  private hasPermission(permission: "presets"): boolean { return this.context.hasPermission(permission); }
  private postToWorker(message: HostResponseMessage): void { this.context.postResponse(message); }

  private getLocalVars(chatId: string): Record<string, string> {
    const userId = this.getChatOwnerId(chatId);
    if (!userId) throw new Error("Chat not found");
    this.enforceScopedUser(userId);
    const chat = chatsSvc.getChat(userId, chatId);
    if (!chat) throw new Error("Chat not found");
    return (chat.metadata?.macro_variables?.local as Record<string, string>) || {};
  }

  private setLocalVars(chatId: string, vars: Record<string, string>): void {
    const userId = this.getChatOwnerId(chatId);
    if (!userId) throw new Error("Chat not found");
    const chat = chatsSvc.getChat(userId, chatId);
    if (!chat) throw new Error("Chat not found");
    const metadata = { ...chat.metadata };
    const macroVars = (metadata.macro_variables as Record<string, unknown>) || {};
    macroVars.local = vars;
    metadata.macro_variables = macroVars;
    chatsSvc.updateChat(userId, chatId, { metadata });
  }

  private getGlobalVars(userId: string): Record<string, string> {
    const setting = settingsSvc.getSetting(userId, "macro_variables_global");
    return (setting?.value as Record<string, string>) || {};
  }

  private setGlobalVars(userId: string, vars: Record<string, string>): void {
    settingsSvc.putSetting(userId, "macro_variables_global", vars);
  }

  private handleVarsGetLocal(requestId: string, chatId: string, key: string): void {
    try {
      const vars = this.getLocalVars(chatId);
      this.postToWorker({ type: "response", requestId, result: vars[key] ?? "" });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsSetLocal(requestId: string, chatId: string, key: string, value: string): void {
    try {
      const vars = this.getLocalVars(chatId);
      vars[key] = value;
      this.setLocalVars(chatId, vars);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsDeleteLocal(requestId: string, chatId: string, key: string): void {
    try {
      const vars = this.getLocalVars(chatId);
      delete vars[key];
      this.setLocalVars(chatId, vars);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsListLocal(requestId: string, chatId: string): void {
    try {
      const vars = this.getLocalVars(chatId);
      this.postToWorker({ type: "response", requestId, result: vars });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsHasLocal(requestId: string, chatId: string, key: string): void {
    try {
      const vars = this.getLocalVars(chatId);
      this.postToWorker({ type: "response", requestId, result: key in vars });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsGetGlobal(requestId: string, key: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) {
        throw new Error("userId is required for operator-scoped extensions");
      }
      this.enforceScopedUser(resolvedUserId);
      const vars = this.getGlobalVars(resolvedUserId);
      this.postToWorker({ type: "response", requestId, result: vars[key] ?? "" });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsSetGlobal(requestId: string, key: string, value: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) {
        throw new Error("userId is required for operator-scoped extensions");
      }
      this.enforceScopedUser(resolvedUserId);
      const vars = this.getGlobalVars(resolvedUserId);
      vars[key] = value;
      this.setGlobalVars(resolvedUserId, vars);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsDeleteGlobal(requestId: string, key: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) {
        throw new Error("userId is required for operator-scoped extensions");
      }
      this.enforceScopedUser(resolvedUserId);
      const vars = this.getGlobalVars(resolvedUserId);
      delete vars[key];
      this.setGlobalVars(resolvedUserId, vars);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsListGlobal(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) {
        throw new Error("userId is required for operator-scoped extensions");
      }
      this.enforceScopedUser(resolvedUserId);
      const vars = this.getGlobalVars(resolvedUserId);
      this.postToWorker({ type: "response", requestId, result: vars });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsHasGlobal(requestId: string, key: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) {
        throw new Error("userId is required for operator-scoped extensions");
      }
      this.enforceScopedUser(resolvedUserId);
      const vars = this.getGlobalVars(resolvedUserId);
      this.postToWorker({ type: "response", requestId, result: key in vars });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Chat-Scoped Persisted Variables (free tier) ────────────────────

  private getChatVars(chatId: string): Record<string, string> {
    const userId = this.getChatOwnerId(chatId);
    if (!userId) throw new Error("Chat not found");
    this.enforceScopedUser(userId);
    const chat = chatsSvc.getChat(userId, chatId);
    if (!chat) throw new Error("Chat not found");
    return (chat.metadata?.chat_variables as Record<string, string>) || {};
  }

  private setChatVars(chatId: string, vars: Record<string, string>): void {
    const userId = this.getChatOwnerId(chatId);
    if (!userId) throw new Error("Chat not found");
    const chat = chatsSvc.getChat(userId, chatId);
    if (!chat) throw new Error("Chat not found");
    const metadata = { ...chat.metadata, chat_variables: vars };
    chatsSvc.updateChat(userId, chatId, { metadata });
  }

  private handleVarsGetChat(requestId: string, chatId: string, key: string): void {
    try {
      const vars = this.getChatVars(chatId);
      this.postToWorker({ type: "response", requestId, result: vars[key] ?? "" });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsSetChat(requestId: string, chatId: string, key: string, value: string): void {
    try {
      const vars = this.getChatVars(chatId);
      vars[key] = value;
      this.setChatVars(chatId, vars);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsDeleteChat(requestId: string, chatId: string, key: string): void {
    try {
      const vars = this.getChatVars(chatId);
      delete vars[key];
      this.setChatVars(chatId, vars);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsListChat(requestId: string, chatId: string): void {
    try {
      const vars = this.getChatVars(chatId);
      this.postToWorker({ type: "response", requestId, result: vars });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsHasChat(requestId: string, chatId: string, key: string): void {
    try {
      const vars = this.getChatVars(chatId);
      this.postToWorker({ type: "response", requestId, result: key in vars });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Presets CRUD (gated: "presets") ────────────────────────────────

  private resolvePresetUserOrThrow(userId?: string): string {
    if (!this.hasPermission("presets")) {
      throw new Error(`${PERMISSION_DENIED_PREFIX} presets — Presets permission not granted`);
    }
    const resolvedUserId = this.resolveEffectiveUserId(userId);
    if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
    this.enforceScopedUser(resolvedUserId);
    return resolvedUserId;
  }

  private handlePresetsList(requestId: string, limit?: number, offset?: number, userId?: string): void {
    try {
      const resolvedUserId = this.resolvePresetUserOrThrow(userId);
      const result = presetsSvc.listPresets(resolvedUserId, {
        limit: Math.min(limit || 50, 200),
        offset: offset || 0,
      });
      this.postToWorker({
        type: "response",
        requestId,
        result: { data: result.data.map((preset) => projectSpindlePreset(preset)!), total: result.total },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handlePresetsGet(requestId: string, presetId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolvePresetUserOrThrow(userId);
      this.postToWorker({
        type: "response",
        requestId,
        result: projectSpindlePreset(presetsSvc.getPreset(resolvedUserId, presetId)),
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handlePresetsCreate(requestId: string, input: CreatePresetInput, userId?: string): void {
    try {
      const resolvedUserId = this.resolvePresetUserOrThrow(userId);
      assertSpindlePresetMutationSafe(input);
      if (!input?.name || typeof input.name !== "string" || !input.name.trim()) {
        throw new Error("Preset name is required");
      }
      if (!input?.provider || typeof input.provider !== "string" || !input.provider.trim()) {
        throw new Error("Preset provider is required");
      }
      const preset = presetsSvc.createPreset(resolvedUserId, input);
      this.postToWorker({ type: "response", requestId, result: projectSpindlePreset(preset) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handlePresetsUpdate(requestId: string, presetId: string, input: UpdatePresetInput, userId?: string): void {
    try {
      const resolvedUserId = this.resolvePresetUserOrThrow(userId);
      const requestedInput = input || {};
      assertSpindlePresetMutationSafe(requestedInput);
      if (requestedInput.expected_cache_revision === undefined) {
        throw new Error("Preset revision is required for preset updates");
      }
      const preset = presetsSvc.updatePreset(resolvedUserId, presetId, requestedInput);
      if (!preset) throw new Error("Preset not found");
      this.postToWorker({ type: "response", requestId, result: projectSpindlePreset(preset) });
    } catch (err: unknown) {
      this.postToWorker({ type: "response", requestId, error: presetWorkerError(err) });
    }
  }

  private handlePresetsDelete(requestId: string, presetId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolvePresetUserOrThrow(userId);
      this.postToWorker({ type: "response", requestId, result: presetsSvc.deletePreset(resolvedUserId, presetId) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handlePresetBlocksList(requestId: string, presetId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolvePresetUserOrThrow(userId);
      const blocks = presetsSvc.listPromptBlocks(resolvedUserId, presetId);
      if (!blocks) throw new Error("Preset not found");
      this.postToWorker({ type: "response", requestId, result: blocks });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handlePresetBlocksGet(
    requestId: string,
    presetId: string,
    occurrence: presetsSvc.PromptBlockOccurrence,
    userId?: string,
  ): void {
    try {
      const resolvedUserId = this.resolvePresetUserOrThrow(userId);
      this.postToWorker({ type: "response", requestId, result: presetsSvc.getPromptBlock(resolvedUserId, presetId, occurrence) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handlePresetBlocksCreate(
    requestId: string,
    presetId: string,
    input: presetsSvc.CreatePromptBlockInput,
    options: presetsSvc.CreatePromptBlockOptions,
    userId?: string,
  ): void {
    try {
      const resolvedUserId = this.resolvePresetUserOrThrow(userId);
      const block = presetsSvc.createPromptBlock(resolvedUserId, presetId, input || {}, options);
      if (!block) throw new Error("Preset not found");
      this.postToWorker({ type: "response", requestId, result: block });
    } catch (err: unknown) {
      this.postToWorker({ type: "response", requestId, error: presetWorkerError(err) });
    }
  }

  private handlePresetBlocksUpdate(
    requestId: string,
    presetId: string,
    target: presetsSvc.PromptBlockMutationTarget,
    input: presetsSvc.UpdatePromptBlockInput,
    userId?: string,
  ): void {
    try {
      const resolvedUserId = this.resolvePresetUserOrThrow(userId);
      const block = presetsSvc.updatePromptBlock(resolvedUserId, presetId, target, input || {});
      if (!block) throw new Error("Prompt block not found");
      this.postToWorker({ type: "response", requestId, result: block });
    } catch (err: unknown) {
      this.postToWorker({ type: "response", requestId, error: presetWorkerError(err) });
    }
  }

  private handlePresetBlocksDelete(
    requestId: string,
    presetId: string,
    target: presetsSvc.PromptBlockMutationTarget,
    userId?: string,
  ): void {
    try {
      const resolvedUserId = this.resolvePresetUserOrThrow(userId);
      this.postToWorker({ type: "response", requestId, result: presetsSvc.deletePromptBlock(resolvedUserId, presetId, target) });
    } catch (err: unknown) {
      this.postToWorker({ type: "response", requestId, error: presetWorkerError(err) });
    }
  }

  private handlePresetCategoriesList(requestId: string, presetId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolvePresetUserOrThrow(userId);
      const groups = presetsSvc.listPromptBlockCategories(resolvedUserId, presetId);
      if (!groups) throw new Error("Preset not found");
      this.postToWorker({ type: "response", requestId, result: groups });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Characters (gated: "characters") ──────────────────────────────
}
