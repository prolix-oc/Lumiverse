import type {
  DeferredGuidanceDTO,
  FinalResponseDTO,
  LlmMessageDTO,
  InterceptorContextDTO,
  InterceptorGenerationType,
  InterceptorMatchDTO,
  InterceptorMatchScalar,
} from "lumiverse-spindle-types";
import {
  retainInterceptorFinalResponse,
  type InterceptorFinalResponseState,
  type ValidInterceptorFinalResponse,
} from "./interceptor-final-response";
import type {
  MainDispatchSnapshot,
  ParentGenerationSnapshot,
  ParentPrefillAttestation,
} from "./bound-generation-types";
import {
  createParentPrefillAttestation,
  mintParentPrefillChildUse,
  type ParentPrefillChildUse,
} from "./bound-generation";
import { BOUND_MAX_CARRIER_BYTES } from "./bound-generation-types";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { WorkerHost } from "./worker-host";
import * as managerSvc from "./manager.service";

const runningExtensions = new Map<string, WorkerHost>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maybeGc(): void {
  try {
    (globalThis as any).Bun?.gc?.(true);
  } catch {
    // ignore
  }
}

/**
 * Bun 1.3.x has shown native cleanup crashes when extension runtime teardown
 * is immediately interleaved with git/bun subprocess work, especially on
 * Windows. Keep update paths separated into runtime and subprocess phases.
 */
export async function settleRuntimeBoundary(ms = 500): Promise<void> {
  await sleep(ms);
  maybeGc();
}

export async function startAllExtensions(): Promise<void> {
  const extensions = await managerSvc.getEnabledExtensions();
  console.log(`[Spindle] Starting ${extensions.length} extension(s)...`);

  for (const ext of extensions) {
    try {
      await startExtension(ext.id);
    } catch (err: any) {
      console.error(
        `[Spindle] Failed to start extension ${ext.identifier}:`,
        err.message
      );
    }
  }
}

export async function stopAllExtensions(): Promise<void> {
  console.log(`[Spindle] Stopping ${runningExtensions.size} extension(s)...`);

  const stopPromises: Promise<void>[] = [];
  for (const [id, host] of runningExtensions) {
    stopPromises.push(
      host.stop().catch((err) => {
        console.error(
          `[Spindle] Error stopping extension ${host.manifest.identifier}:`,
          err
        );
      })
    );
  }

  await Promise.all(stopPromises);
  runningExtensions.clear();
}

export async function startExtension(id: string): Promise<void> {
  if (runningExtensions.has(id)) {
    console.warn(`[Spindle] Extension ${id} is already running`);
    return;
  }

  const ext = await managerSvc.getExtension(id);
  if (!ext) throw new Error(`Extension not found: ${id}`);

  // Sync manifest from disk → DB before starting (picks up spindle.json edits)
  await managerSvc.syncManifestToDb(ext.identifier);

  try {
    // Re-fetch after sync in case permissions/metadata changed
    const freshExt = (await managerSvc.getExtension(id)) ?? ext;
    const manifest = await managerSvc.getManifest(freshExt.identifier);
    const host = new WorkerHost(freshExt.id, manifest, freshExt);
    await host.start();
    runningExtensions.set(id, host);

    eventBus.emit(EventType.SPINDLE_EXTENSION_LOADED, {
      extensionId: ext.id,
      identifier: ext.identifier,
      name: ext.name,
    });

    console.log(`[Spindle] Started extension: ${ext.identifier}`);
  } catch (err: any) {
    eventBus.emit(EventType.SPINDLE_EXTENSION_ERROR, {
      extensionId: ext.id,
      identifier: ext.identifier,
      error: err.message,
    });
    throw err;
  }
}

export async function stopExtension(id: string): Promise<void> {
  const host = runningExtensions.get(id);
  if (!host) return;

  await host.stop();
  runningExtensions.delete(id);

  eventBus.emit(EventType.SPINDLE_EXTENSION_UNLOADED, {
    extensionId: id,
    identifier: host.manifest.identifier,
    name: host.manifest.name,
  });

  console.log(`[Spindle] Stopped extension: ${host.manifest.identifier}`);
}

export async function restartExtension(id: string): Promise<void> {
  await stopExtension(id);
  await startExtension(id);
}

/**
 * Notify a running extension that a permission was granted or revoked.
 * The worker updates its internal cache and fires onChanged handlers —
 * no restart needed.
 */
export function notifyPermissionChanged(
  id: string,
  permission: string,
  granted: boolean,
  allGranted: string[]
): void {
  const host = runningExtensions.get(id);
  if (host) {
    host.notifyPermissionChanged(permission, granted, allGranted);
  }

  // Broadcast on the EventBus so frontend modules can react in real-time.
  // The extensionId lets each frontend scope the event to itself.
  eventBus.emit(EventType.SPINDLE_PERMISSION_CHANGED, {
    extensionId: id,
    permission,
    granted,
    allGranted,
  });
}

export function getRunningExtensions(): Map<string, WorkerHost> {
  return runningExtensions;
}

export function isRunning(id: string): boolean {
  return runningExtensions.has(id);
}

export function getWorkerHost(id: string): WorkerHost | undefined {
  return runningExtensions.get(id);
}

// ─── Interceptor lifecycle seams ─────────────────────────────────

export interface InterceptorPrivateState {
  readonly parentGenerationSnapshot?: ParentGenerationSnapshot;
  readonly mainDispatchSnapshot?: MainDispatchSnapshot;
  readonly parentPrefillAttestation?: ParentPrefillAttestation;
  readonly signal?: AbortSignal;
  readonly mainApiKey: string;
}
/**
 * Optional fifth argument accepted by InterceptorPipeline.run. It is an
 * internal host seam: callers must never put these values on the public
 * InterceptorContextDTO.
 */
export interface InterceptorPipelineAuthority {
  readonly parentGenerationSnapshot?: ParentGenerationSnapshot;
  readonly mainDispatchSnapshot?: MainDispatchSnapshot;
  readonly parentPrefillAttestation?: ParentPrefillAttestation;
  readonly mainApiKey?: string;
  readonly signal?: AbortSignal;
  readonly presetMetadataByExtension?: Readonly<Record<string, unknown>>;
}

const interceptorPrivateStates = new WeakMap<object, Readonly<InterceptorPrivateState>>();

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/** Attach host-only callback state without adding privileged fields to a DTO. */
export function attachInterceptorPrivateState(
  seed: unknown,
  state: InterceptorPrivateState,
): object {
  if (!isObject(seed)) throw new TypeError("Interceptor private state seed must be an object");
  if (typeof state.mainApiKey !== "string") {
    throw new TypeError("Interceptor private state mainApiKey must be a string");
  }
  const normalized = Object.freeze({
    ...(state.parentGenerationSnapshot ? { parentGenerationSnapshot: state.parentGenerationSnapshot } : {}),
    ...(state.mainDispatchSnapshot ? { mainDispatchSnapshot: state.mainDispatchSnapshot } : {}),
    ...(state.parentPrefillAttestation ? { parentPrefillAttestation: state.parentPrefillAttestation } : {}),
    ...(state.signal ? { signal: state.signal } : {}),
    mainApiKey: state.mainApiKey,
  }) as Readonly<InterceptorPrivateState>;
  const existing = interceptorPrivateStates.get(seed);
  if (existing) {
    if (
      existing.mainApiKey !== normalized.mainApiKey ||
      existing.parentGenerationSnapshot !== normalized.parentGenerationSnapshot ||
      existing.mainDispatchSnapshot !== normalized.mainDispatchSnapshot ||
      existing.parentPrefillAttestation !== normalized.parentPrefillAttestation ||
      existing.signal !== normalized.signal
    ) {
      throw new TypeError("Interceptor private state is already attached with a different value");
    }
    return seed;
  }
  interceptorPrivateStates.set(seed, normalized);
  return seed;
}

export function readInterceptorPrivateState(
  seed: unknown,
): Readonly<InterceptorPrivateState> | undefined {
  return isObject(seed) ? interceptorPrivateStates.get(seed) : undefined;
}

const VALID_GENERATION_TYPES = new Set<InterceptorGenerationType>([
  "normal",
  "continue",
  "regenerate",
  "swipe",
  "impersonate",
  "quiet",
]);
const MAX_MATCH_ARRAY_LENGTH = 64;
const MAX_MATCH_DEPTH = 8;
const MAX_MATCH_SEGMENT_BYTES = 256;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownKeys(value: Record<string, unknown>, label: string): string[] {
  const keys = Object.keys(value);
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key)) throw new TypeError(`${label}.${key} is not supported`);
  }
  return keys;
}

function scalar(value: unknown, label: string): asserts value is InterceptorMatchScalar {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  throw new TypeError(`${label} must be a JSON scalar`);
}

function scalarArray(value: unknown, label: string): InterceptorMatchScalar[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MATCH_ARRAY_LENGTH) {
    throw new TypeError(`${label} must be a non-empty bounded array`);
  }
  const result: InterceptorMatchScalar[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    scalar(value[index], `${label}[${index}]`);
    const key = JSON.stringify(value[index]);
    if (seen.has(key)) throw new TypeError(`${label} must not contain duplicates`);
    seen.add(key);
    result.push(value[index]);
  }
  return result;
}

function readPath(root: unknown, path: readonly string[]): { exists: boolean; value: unknown } {
  let current = root;
  for (const segment of path) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { exists: false, value: undefined };
    }
    current = current[segment];
  }
  return { exists: true, value: current };
}

export function validateInterceptorMatch(value: unknown): InterceptorMatchDTO | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new TypeError("interceptor match must be a plain object");
  for (const key of ownKeys(value, "interceptor match")) {
    if (key !== "generationTypes" && key !== "isDryRun" && key !== "presetField") {
      throw new TypeError(`interceptor match.${key} is not supported`);
    }
  }
  const generationTypesValue = value.generationTypes;
  let generationTypes: InterceptorGenerationType[] | undefined;
  if (generationTypesValue !== undefined) {
    if (!Array.isArray(generationTypesValue) || generationTypesValue.length === 0 || generationTypesValue.length > MAX_MATCH_ARRAY_LENGTH) {
      throw new TypeError("interceptor match.generationTypes must be a non-empty bounded array");
    }
    generationTypes = [];
    const seen = new Set<InterceptorGenerationType>();
    for (const [index, item] of generationTypesValue.entries()) {
      if (typeof item !== "string" || !VALID_GENERATION_TYPES.has(item as InterceptorGenerationType)) {
        throw new TypeError(`interceptor match.generationTypes[${index}] is invalid`);
      }
      if (seen.has(item as InterceptorGenerationType)) {
        throw new TypeError("interceptor match.generationTypes must not contain duplicates");
      }
      seen.add(item as InterceptorGenerationType);
      generationTypes.push(item as InterceptorGenerationType);
    }
  }
  let isDryRun: boolean | undefined;
  if (value.isDryRun !== undefined) {
    if (typeof value.isDryRun !== "boolean") throw new TypeError("interceptor match.isDryRun must be boolean");
    isDryRun = value.isDryRun;
  }
  let presetField: InterceptorMatchDTO["presetField"];
  if (value.presetField !== undefined) {
    if (!isRecord(value.presetField)) throw new TypeError("interceptor match.presetField must be a plain object");
    const field = value.presetField;
    for (const key of ownKeys(field, "interceptor match.presetField")) {
      if (key !== "path" && key !== "exists" && key !== "oneOf" && key !== "notIn") {
        throw new TypeError(`interceptor match.presetField.${key} is not supported`);
      }
    }
    if (!Array.isArray(field.path) || field.path.length === 0 || field.path.length > MAX_MATCH_DEPTH) {
      throw new RangeError("interceptor match.presetField.path depth must be 1-8");
    }
    const path: string[] = [];
    for (const [index, segment] of field.path.entries()) {
      if (typeof segment !== "string" || segment.length === 0 || new TextEncoder().encode(segment).byteLength > MAX_MATCH_SEGMENT_BYTES || DANGEROUS_KEYS.has(segment)) {
        throw new TypeError(`interceptor match.presetField.path[${index}] is invalid`);
      }
      path.push(segment);
    }
    if (field.exists !== undefined && typeof field.exists !== "boolean") throw new TypeError("interceptor match.presetField.exists must be boolean");
    const oneOf = scalarArray(field.oneOf, "interceptor match.presetField.oneOf");
    const notIn = scalarArray(field.notIn, "interceptor match.presetField.notIn");
    if (field.exists === undefined && oneOf === undefined && notIn === undefined) {
      throw new TypeError("interceptor match.presetField requires exists, oneOf, or notIn");
    }
    presetField = {
      path,
      ...(field.exists === undefined ? {} : { exists: field.exists }),
      ...(oneOf === undefined ? {} : { oneOf }),
      ...(notIn === undefined ? {} : { notIn }),
    };
  }
  if (generationTypes === undefined && isDryRun === undefined && presetField === undefined) {
    throw new TypeError("interceptor match cannot be empty");
  }
  return Object.freeze({
    ...(generationTypes === undefined ? {} : { generationTypes: Object.freeze(generationTypes) }),
    ...(isDryRun === undefined ? {} : { isDryRun }),
    ...(presetField === undefined ? {} : { presetField: Object.freeze(presetField) }),
  }) as InterceptorMatchDTO;
}

export interface CompiledInterceptorMatcher {
  readonly dto: InterceptorMatchDTO;
  readonly matches: (context: unknown) => boolean;
}

export function compileInterceptorMatcher(value: unknown): CompiledInterceptorMatcher | undefined {
  const dto = validateInterceptorMatch(value);
  if (!dto) return undefined;
  return Object.freeze({
    dto,
    matches(context: unknown): boolean {
      if (!isRecord(context)) return false;
      if (dto.generationTypes && !dto.generationTypes.includes(context.generationType as InterceptorGenerationType)) return false;
      const dryRun = context.isDryRun ?? context.dryRun;
      if (dto.isDryRun !== undefined && dryRun !== dto.isDryRun) return false;
      const field = dto.presetField;
      if (!field) return true;
      const found = readPath(context.presetMetadata, field.path);
      if (field.exists !== undefined && found.exists !== field.exists) return false;
      if (!found.exists) return field.oneOf === undefined;
      if (field.oneOf && !field.oneOf.some((candidate) => Object.is(candidate, found.value))) return false;
      if (field.notIn && field.notIn.some((candidate) => Object.is(candidate, found.value))) return false;
      return true;
    },
  });
}

export type InterceptorContextPreparationInput = {
  readonly context?: unknown;
  readonly userId?: string | null;
  readonly chatId?: string;
  readonly generationId?: string;
  readonly generationType?: string;
  readonly isDryRun?: boolean;
  readonly presetId?: string | null;
  readonly presetMetadata?: unknown;
  readonly personaId?: string | null;
  readonly characterId?: string | null;
  readonly personaAddonStates?: Readonly<Record<string, boolean>>;
  readonly mainDispatchSnapshot?: MainDispatchSnapshot | null;
  readonly parentGenerationSnapshot?: ParentGenerationSnapshot | null;
  readonly prefillCarrier?: InterceptorContextDTO["prefillCarrier"];
  readonly interceptorDeadlineAt?: number;
  readonly boundWorkDeadlineAt?: number;
  readonly signal?: AbortSignal;
};

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function cloneData<T>(value: T, fallback: T): T {
  if (value === undefined) return fallback;
  try {
    return structuredClone(value);
  } catch {
    return fallback;
  }
}

export function prepareInterceptorContext(input: InterceptorContextPreparationInput): InterceptorContextDTO {
  const source = isRecord(input.context) ? input.context : {};
  const parent = input.parentGenerationSnapshot ?? null;
  const main = input.mainDispatchSnapshot ?? parent?.main ?? null;
  const userId = text(input.userId ?? source.userId, "userId");
  const chatId = text(input.chatId ?? source.chatId, "chatId");
  const generationId = text(input.generationId ?? parent?.generationId ?? source.generationId ?? crypto.randomUUID(), "generationId");
  const generationType = input.generationType ?? (typeof source.generationType === "string" ? source.generationType : parent?.options.generationType);
  if (typeof generationType !== "string" || !VALID_GENERATION_TYPES.has(generationType as InterceptorGenerationType)) {
    throw new TypeError("generationType is invalid");
  }
  const isDryRun = input.isDryRun ?? (typeof source.isDryRun === "boolean" ? source.isDryRun : source.dryRun === true);
  const metadata = cloneData(input.presetMetadata ?? source.presetMetadata, null);
  const addonStates = cloneData(input.personaAddonStates ?? source.personaAddonStates, {}) as Record<string, boolean>;
  const interceptorDeadlineAt = Number.isFinite(input.interceptorDeadlineAt) ? Number(input.interceptorDeadlineAt) : Date.now() + 30_000;
  const boundWorkDeadlineAt = Number.isFinite(input.boundWorkDeadlineAt) ? Number(input.boundWorkDeadlineAt) : interceptorDeadlineAt;
  if (boundWorkDeadlineAt > interceptorDeadlineAt) throw new RangeError("boundWorkDeadlineAt must not exceed interceptorDeadlineAt");
  const context = {
    userId,
    chatId,
    generationId,
    generationType: generationType as InterceptorGenerationType,
    isDryRun: isDryRun === true,
    presetId: input.presetId ?? (typeof source.presetId === "string" ? source.presetId : null),
    presetMetadata: metadata,
    personaId: input.personaId ?? (typeof source.personaId === "string" ? source.personaId : null),
    characterId: input.characterId ?? (typeof source.characterId === "string" ? source.characterId : null),
    personaAddonStates: addonStates,
    mainDispatch: {
      source: "main" as const,
      descriptor: main?.descriptor ? cloneData(main.descriptor, null) : null,
      connectionDispatchRevision: main ? String(main.dispatchRevision) : null,
      dispatchKind: main?.descriptor?.dispatchKind ?? null,
    },
    prefillCarrier: input.prefillCarrier ?? parent?.parentPrefill ?? { id: "", state: "absent" as const },
    interceptorDeadlineAt,
    boundWorkDeadlineAt,
    signal: input.signal ?? new AbortController().signal,
  } as InterceptorContextDTO;
  return Object.freeze(context);
}
export type TerminalFinalizeRequest = {
  readonly messages: readonly LlmMessageDTO[];
};

export type TerminalFinalizeInput<TRequest extends TerminalFinalizeRequest = TerminalFinalizeRequest> = {
  /** Host-minted attempt identity; reusing it is rejected. */
  readonly attemptId: string;
  readonly purpose: "thread-continuation" | "terminal-guidance";
  readonly request: TRequest;
  readonly currentParentGenerationSnapshot?: ParentGenerationSnapshot;
  readonly currentDispatchRevision?: string;
  readonly signal?: AbortSignal;
  readonly permissionGuard?: () => boolean;
  /** Opaque host-private normalized response state, never a worker DTO. */
  readonly finalResponseState?: InterceptorFinalResponseState;
  readonly rebudget?: (input: {
    readonly request: TRequest;
    readonly messages: readonly LlmMessageDTO[];
    readonly guidance: readonly DeferredGuidanceDTO[];
  }) => Promise<{
    readonly request?: TRequest;
    readonly messages?: readonly LlmMessageDTO[];
    readonly breakdown?: readonly unknown[];
  }> | {
    readonly request?: TRequest;
    readonly messages?: readonly LlmMessageDTO[];
    readonly breakdown?: readonly unknown[];
  };
};

export type TerminalFinalizeResult<TRequest extends TerminalFinalizeRequest = TerminalFinalizeRequest> = {
  readonly attemptId: string;
  readonly request: TRequest;
  readonly messages: readonly LlmMessageDTO[];
  readonly guidance: readonly DeferredGuidanceDTO[];
  readonly breakdown: readonly unknown[];
  readonly prefillChild?: ParentPrefillChildUse;
  /** Host-private normalized winner/fallback state for generation finalization. */
  readonly finalResponse?: InterceptorFinalResponseState;
};


export interface InterceptorTerminalLease {
  readonly registrationId: string;
  readonly generationId: string;
  readonly callbackUserId: string;
  readonly extensionId: string;
  readonly extensionName: string;
  readonly parentGenerationSnapshot?: ParentGenerationSnapshot;
  readonly guidance: () => readonly DeferredGuidanceDTO[];
  readonly isActive: () => boolean;
  /** Re-run every host-owned permission, liveness, signal, deadline, and revision guard. */
  readonly assertLive: () => void;
  readonly finalize: <TRequest extends TerminalFinalizeRequest>(
    input: TerminalFinalizeInput<TRequest>,
  ) => Promise<TerminalFinalizeResult<TRequest>>;
  /** Idempotent host-only release/revocation. */
  readonly release: () => void;
  readonly dispose: () => void;
  readonly revoke: (reason?: unknown) => void;
}

export type InterceptorTerminalLeaseInput = {
  readonly registrationId: string;
  readonly generationId: string;
  readonly callbackUserId: string;
  readonly parentGenerationSnapshot?: ParentGenerationSnapshot;
  readonly parentPrefillAttestation?: ParentPrefillAttestation;
  readonly guidance?: readonly DeferredGuidanceDTO[];
  readonly extensionId?: string;
  readonly extensionName?: string;
  readonly finalResponse?: FinalResponseDTO;
  /** Opaque host-private normalized response state captured at receipt. */
  readonly finalResponseState?: InterceptorFinalResponseState;
  readonly permissionGuard?: () => boolean;
  readonly isRegistrationLive?: () => boolean;
  readonly isGenerationLive?: () => boolean;
  readonly currentDispatchRevision?: () => string | undefined;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
  readonly onDispose?: () => void;
};

const TERMINAL_MAX_GUIDANCE_COUNT = 128;
const TERMINAL_MAX_GUIDANCE_CONTENT_BYTES = 1024 * 1024;
const TERMINAL_MAX_GUIDANCE_TOTAL_BYTES = BOUND_MAX_CARRIER_BYTES;
const TERMINAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cloneTerminalGuidance(value: unknown): readonly DeferredGuidanceDTO[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > TERMINAL_MAX_GUIDANCE_COUNT) {
    throw new TypeError("deferredGuidance must be a bounded array");
  }
  const encoder = new TextEncoder();
  let totalBytes = 0;
  const seenIds = new Set<string>();
  const guidance = value.map((entry, index) => {
    if (!isRecord(entry)) throw new TypeError(`deferredGuidance[${index}] must be an object`);
    const keys = Object.keys(entry);
    if (keys.some((key) => key !== "id" && key !== "content" && key !== "role")) {
      throw new TypeError(`deferredGuidance[${index}] contains unsupported fields`);
    }
    if (typeof entry.id !== "string" || !TERMINAL_UUID.test(entry.id) || seenIds.has(entry.id)) {
      throw new TypeError(`deferredGuidance[${index}].id is invalid`);
    }
    if (typeof entry.content !== "string" || entry.content.length === 0) {
      throw new TypeError(`deferredGuidance[${index}].content is invalid`);
    }
    if (entry.role !== "system") throw new TypeError(`deferredGuidance[${index}].role is invalid`);
    const bytes = encoder.encode(entry.content).byteLength;
    if (bytes > TERMINAL_MAX_GUIDANCE_CONTENT_BYTES) {
      throw new RangeError(`deferredGuidance[${index}].content is too large`);
    }
    totalBytes += bytes;
    if (totalBytes > TERMINAL_MAX_GUIDANCE_TOTAL_BYTES) {
      throw new RangeError("deferredGuidance exceeds the host size limit");
    }
    seenIds.add(entry.id);
    return Object.freeze({
      id: entry.id,
      content: entry.content,
      role: "system" as const,
    });
  });
  return Object.freeze(guidance);
}

export function createInterceptorTerminalLease(
  input: InterceptorTerminalLeaseInput,
): InterceptorTerminalLease {
  if (!isRecord(input)) throw new TypeError("terminal lease input is required");
  if (typeof input.registrationId !== "string" || input.registrationId.length === 0) {
    throw new TypeError("terminal lease registrationId is required");
  }
  if (typeof input.generationId !== "string" || input.generationId.length === 0) {
    throw new TypeError("terminal lease generationId is required");
  }
  if (typeof input.callbackUserId !== "string" || input.callbackUserId.length === 0) {
    throw new TypeError("terminal lease callbackUserId is required");
  }
  const settledAttempts = new Set<string>();
  const guidance = cloneTerminalGuidance(input.guidance);
  const attestation = input.parentGenerationSnapshot
    ? input.parentPrefillAttestation ?? createParentPrefillAttestation(input.parentGenerationSnapshot)
    : undefined;
  let active = true;
  const ensureActive = (operation: string): void => {
    if (!active) throw new Error(`Terminal interceptor lease is inactive: ${operation}`);
    if (input.permissionGuard && !input.permissionGuard()) {
      throw new Error(`Terminal interceptor lease permission denied: ${operation}`);
    }
    if (input.isRegistrationLive && !input.isRegistrationLive()) {
      throw new Error(`Terminal interceptor registration is no longer live: ${operation}`);
    }
    if (input.isGenerationLive && !input.isGenerationLive()) {
      throw new Error(`Terminal interceptor generation is no longer live: ${operation}`);
    }
    if (input.signal?.aborted) {
      throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) {
      throw new Error(`Terminal interceptor deadline elapsed: ${operation}`);
    }
  };
  const release = (): void => {
    if (!active) return;
    active = false;
    input.onDispose?.();
  };
  const lease: InterceptorTerminalLease = {
    registrationId: input.registrationId,
    extensionId: input.extensionId ?? input.registrationId,
    extensionName: input.extensionName ?? input.registrationId,
    generationId: input.generationId,
    callbackUserId: input.callbackUserId,
    ...(input.parentGenerationSnapshot ? { parentGenerationSnapshot: input.parentGenerationSnapshot } : {}),
    ...(attestation ? { parentPrefillAttestation: attestation } : {}),
    guidance: () => cloneTerminalGuidance(guidance),
    isActive: () => active,
    assertLive: () => ensureActive("assertLive"),
    finalize: async <TRequest extends TerminalFinalizeRequest>(
      finalization: TerminalFinalizeInput<TRequest>,
    ): Promise<TerminalFinalizeResult<TRequest>> => {
      ensureActive("finalize");
      if (typeof finalization.attemptId !== "string" || finalization.attemptId.length === 0) {
        throw new TypeError("Terminal finalize attemptId is required");
      }
      if (settledAttempts.has(finalization.attemptId)) {
        throw new Error("Terminal finalize attemptId was already used");
      }
      if (
        finalization.currentParentGenerationSnapshot !== undefined &&
        finalization.currentParentGenerationSnapshot !== input.parentGenerationSnapshot
      ) {
        throw new Error("Terminal finalize parent snapshot is stale");
      }
      if (
        input.currentDispatchRevision &&
        finalization.currentDispatchRevision !== input.currentDispatchRevision()
      ) {
        throw new Error("Terminal finalize dispatch revision is stale");
      }
      if (!Array.isArray(finalization.request?.messages)) {
        throw new TypeError("Terminal finalization request is invalid");
      }
      if (finalization.signal?.aborted) {
        throw finalization.signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      if (finalization.permissionGuard && !finalization.permissionGuard()) {
        throw new Error("Terminal finalization permission denied");
      }
      settledAttempts.add(finalization.attemptId);
      const boundedGuidance = cloneTerminalGuidance(guidance);
      let request = finalization.request;
      let messages: readonly LlmMessageDTO[] = finalization.request.messages;
      let breakdown: readonly unknown[] = Object.freeze([]);
      if (finalization.rebudget) {
        const rebudgeted = await finalization.rebudget({
          request,
          messages,
          guidance: boundedGuidance,
        });
        if (rebudgeted.request) request = rebudgeted.request;
        if (rebudgeted.messages) messages = rebudgeted.messages;
        if (rebudgeted.breakdown) breakdown = Object.freeze([...rebudgeted.breakdown]);
      }
      ensureActive("finalize");
      if (finalization.permissionGuard && !finalization.permissionGuard()) {
        throw new Error("Terminal finalization permission denied");
      }
      const finalResponseState = finalization.finalResponseState ?? input.finalResponseState;
      const prefillChild =
        input.parentGenerationSnapshot &&
        input.parentGenerationSnapshot.parentPrefill.state === "available" &&
        attestation
          ? mintParentPrefillChildUse(
              input.parentGenerationSnapshot,
              attestation,
              finalization.attemptId,
              finalization.purpose,
            )
          : undefined;
      return Object.freeze({
        attemptId: finalization.attemptId,
        request,
        messages,
        guidance: boundedGuidance,
        breakdown,
        ...(prefillChild ? { prefillChild } : {}),
        ...(finalResponseState === undefined ? {} : { finalResponse: finalResponseState }),
      });
    },
    release,
    dispose: release,
    revoke: () => release(),
  };
  return Object.freeze(lease);
}
export type TerminalLeaseAggregateInput<TRequest extends TerminalFinalizeRequest = TerminalFinalizeRequest> = {
  readonly leases: readonly InterceptorTerminalLease[];
  readonly attemptId: string;
  readonly purpose: "thread-continuation" | "terminal-guidance";
  readonly request: TRequest;
  readonly carrierIndex: number;
  readonly currentParentGenerationSnapshot?: ParentGenerationSnapshot;
  readonly currentDispatchRevision?: string;
  readonly liveDispatchRevision?: () => string | undefined;
  readonly liveDispatchSource?: () => string | undefined;
  readonly expectedDispatchSource?: string;
  readonly isRegistrationLive?: () => boolean;
  readonly isGenerationLive?: () => boolean;
  readonly deadlineAt?: number;
  readonly signal?: AbortSignal;
  readonly permissionGuard?: () => boolean;
  /** Opaque host-private state already selected by the pipeline. */
  readonly finalResponseState?: InterceptorFinalResponseState;
  readonly rebudget?: (input: {
    readonly request: TRequest;
    readonly messages: readonly LlmMessageDTO[];
    readonly guidance: readonly DeferredGuidanceDTO[];
  }) => Promise<{
    readonly request?: TRequest;
    readonly messages?: readonly LlmMessageDTO[];
    readonly breakdown?: readonly unknown[];
  }> | {
    readonly request?: TRequest;
    readonly messages?: readonly LlmMessageDTO[];
    readonly breakdown?: readonly unknown[];
  };
};

export async function finalizeInterceptorTerminalLeases<TRequest extends TerminalFinalizeRequest>(
  input: TerminalLeaseAggregateInput<TRequest>,
): Promise<TerminalFinalizeResult<TRequest>> {
  if (!Array.isArray(input.leases) || input.leases.length === 0) {
    throw new Error("No terminal callback leases are available");
  }
  if (!Number.isSafeInteger(input.carrierIndex) || input.carrierIndex < 0 || input.carrierIndex >= input.request.messages.length) {
    throw new TypeError("Terminal carrier index is invalid");
  }
  if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
  const registrations = new Set<string>();
  for (const lease of input.leases) {
    if (!lease.isActive() || registrations.has(lease.registrationId)) {
      throw new Error("Terminal callback lease set is stale or contradictory");
    }
    registrations.add(lease.registrationId);
    if (input.currentParentGenerationSnapshot && lease.parentGenerationSnapshot !== input.currentParentGenerationSnapshot) {
      throw new Error("Terminal callback parent snapshot is stale");
    }
  }
  const assertAggregateLive = (): void => {
    if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
    if (input.permissionGuard && !input.permissionGuard()) throw new Error("Terminal callback permission denied");
    if (input.isRegistrationLive && !input.isRegistrationLive()) throw new Error("Terminal callback registration is stale");
    if (input.isGenerationLive && !input.isGenerationLive()) throw new Error("Terminal callback generation is stale");
    if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) throw new Error("Terminal callback deadline elapsed");
    if (input.liveDispatchRevision && input.currentDispatchRevision !== input.liveDispatchRevision()) {
      throw new Error("Terminal callback dispatch revision is stale");
    }
    if (input.liveDispatchSource && input.expectedDispatchSource !== input.liveDispatchSource()) {
      throw new Error("Terminal callback dispatch source is stale");
    }
    for (const lease of input.leases) {
      lease.assertLive();
      if (input.currentParentGenerationSnapshot && lease.parentGenerationSnapshot !== input.currentParentGenerationSnapshot) {
        throw new Error("Terminal callback parent snapshot changed");
      }
    }
  };
  assertAggregateLive();
  const settled: TerminalFinalizeResult<TRequest>[] = [];
  let selectedFinalResponse: InterceptorFinalResponseState | undefined = input.finalResponseState;
  let selectedValidFinalResponse: ValidInterceptorFinalResponse | undefined =
    selectedFinalResponse?.status === "valid" ? selectedFinalResponse : undefined;
  try {
    for (let index = 0; index < input.leases.length; index += 1) {
      const result = await input.leases[index].finalize({
        attemptId: `${input.attemptId}:${index}`,
        purpose: input.purpose,
        request: input.request,
        currentParentGenerationSnapshot: input.currentParentGenerationSnapshot,
        currentDispatchRevision: input.currentDispatchRevision,
        signal: input.signal,
        permissionGuard: input.permissionGuard,
      });
      assertAggregateLive();
      if (result.finalResponse) {
        if (result.finalResponse.status === "valid") {
          selectedFinalResponse = retainInterceptorFinalResponse(
            selectedValidFinalResponse,
            result.finalResponse,
          );
          selectedValidFinalResponse =
            selectedFinalResponse?.status === "valid" ? selectedFinalResponse : undefined;
        } else if (!selectedFinalResponse) {
          selectedFinalResponse = result.finalResponse;
        }
      }
      settled.push(result);
    }
    const guidance = cloneTerminalGuidance(settled.flatMap((result) => result.guidance));
    const guidanceMessages = guidance.map((entry) => ({
      role: "system" as const,
      content: entry.content,
    }));
    const messages = [
      ...input.request.messages.slice(0, input.carrierIndex),
      ...guidanceMessages,
      input.request.messages[input.carrierIndex],
      ...input.request.messages.slice(input.carrierIndex + 1),
    ];
    let request: TRequest = input.request;
    let outputMessages: readonly LlmMessageDTO[] = messages;
    const carrier = input.request.messages[input.carrierIndex];
    if (messages.filter((message) => message === carrier).length !== 1) {
      throw new Error("Terminal carrier containment failed");
    }
    const hostBreakdown: readonly unknown[] = guidance.map((entry, index) => {
      const owner = input.leases.find((lease) => lease.guidance().some((item) => item.id === entry.id));
      return Object.freeze({
        messageIndex: input.carrierIndex + index,
        name: owner?.extensionName ?? owner?.registrationId ?? "interceptor",
        role: "system" as const,
        content: entry.content,
        extensionId: owner?.extensionId ?? owner?.registrationId ?? "interceptor",
        extensionName: owner?.extensionName ?? owner?.registrationId ?? "interceptor",
      });
    });
    let breakdown: readonly unknown[] = hostBreakdown;
    if (input.rebudget) {
      const rebudgeted = await input.rebudget({
        request,
        messages: [...outputMessages],
        guidance,
      });
      if (rebudgeted.request) request = rebudgeted.request;
      if (rebudgeted.messages) outputMessages = rebudgeted.messages;
      if (rebudgeted.breakdown) {
        breakdown = Object.freeze([...hostBreakdown, ...rebudgeted.breakdown]);
      }
    }
    assertAggregateLive();
    const carrierIndexes: number[] = [];
    for (let index = 0; index < outputMessages.length; index += 1) {
      if (outputMessages[index] === carrier) carrierIndexes.push(index);
    }
    if (carrierIndexes.length !== 1) {
      throw new Error("Terminal carrier containment failed after rebudget");
    }
    const outputCarrierIndex = carrierIndexes[0]!;
    const outputGuidanceStartIndex = outputCarrierIndex - guidanceMessages.length;
    if (outputGuidanceStartIndex < 0) {
      throw new Error("Terminal guidance was clipped from the protected carrier");
    }
    for (let index = 0; index < guidanceMessages.length; index += 1) {
      const guidanceMessage = guidanceMessages[index];
      if (
        outputMessages.filter((message) => message === guidanceMessage).length !== 1 ||
        outputMessages[outputGuidanceStartIndex + index] !== guidanceMessage
      ) {
        throw new Error("Terminal guidance order or multiplicity changed after rebudget");
      }
    }
    const rematerializedHostBreakdown: unknown[] = [];
    for (let index = 0; index < hostBreakdown.length; index += 1) {
      const entry = hostBreakdown[index];
      if (!isRecord(entry) ||
        entry.role !== "system" ||
        typeof entry.content !== "string" ||
        typeof entry.extensionId !== "string" ||
        typeof entry.extensionName !== "string" ||
        entry.content !== guidance[index]?.content) {
        throw new Error("Terminal host attribution was lost after rebudget");
      }
      rematerializedHostBreakdown.push(Object.freeze({
        ...entry,
        messageIndex: outputGuidanceStartIndex + index,
      }));
    }
    breakdown = Object.freeze([
      ...rematerializedHostBreakdown,
      ...breakdown.slice(hostBreakdown.length),
    ]);
    return Object.freeze({
      attemptId: input.attemptId,
      request,
      messages: outputMessages,
      guidance,
      breakdown,
      ...(settled.find((result) => result.prefillChild)?.prefillChild
        ? { prefillChild: settled.find((result) => result.prefillChild)?.prefillChild }
        : {}),
      ...(selectedFinalResponse === undefined ? {} : { finalResponse: selectedFinalResponse }),
    });
  } catch (error) {
    for (const lease of input.leases) lease.release();
    throw error;
  }
}
