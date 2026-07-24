import type {
  AssemblyBreakdownEntryDTO,
  BoundAssembleRequestDTO as WorkerBoundAssembleRequestDTO,
  BoundAssemblyFailureDTO as WorkerBoundAssemblyFailureDTO,
  BoundAssemblyOutcomeDTO as WorkerBoundAssemblyOutcomeDTO,
  BoundAssemblySuccessDTO as WorkerBoundAssemblySuccessDTO,
  BoundPrefillAttachmentDTO as WorkerBoundPrefillAttachmentDTO,
  ConnectionDispatchDescriptorDTO as WorkerConnectionDispatchDescriptorDTO,
  GenerationDispatchSourceDTO as WorkerGenerationDispatchSourceDTO,
  GenerationResponseDTO as WorkerGenerationResponseDTO,
  GenerationUsageDTO as WorkerGenerationUsageDTO,
  LlmMessageDTO,
  PromptBlockSnapshotDTO,
  PromptVariableValuesDTO,
  QuietDispatchReceiptDTO as WorkerQuietDispatchReceiptDTO,
  QuietTrackedRequestDTO as WorkerQuietTrackedRequestDTO,
  QuietTrackedResultDTO as WorkerQuietTrackedResultDTO,
  ToolSchemaDTO,
} from "lumiverse-spindle-types";
import type {
  GenerationResponse,
  GenerationUsage,
  LlmMessage,
  ToolDefinition,
} from "../llm/types";

/**
 * This module is host-private. None of the binding, snapshot, lease, or fatal
 * values are sent through the worker DTO surface. Worker DTOs are imported only
 * as data-shape contracts and are validated again at runtime by the host.
 */

const invocationTokenBrand: unique symbol = Symbol("bound-invocation-token");
const hostGenerationBrand: unique symbol = Symbol("bound-host-generation");
const prefillChildBrand: unique symbol = Symbol("prefill-child-use");

export type InvocationToken = string & {
  readonly [invocationTokenBrand]: "InvocationToken";
};
export type HostGenerationId = string & {
  readonly [hostGenerationBrand]: "HostGenerationId";
};

/**
 * Dispatch revisions are intentionally only a string at this seam. The
 * dispatch service is the runtime authority; a TypeScript brand must never be
 * treated as authentication. The service returns an opaque base64url SHA-256
 * revision and all consumers compare its complete value.
 */
export type DispatchRevision = string;
export type PrefillChildUse = string & {
  readonly [prefillChildBrand]: "PrefillChildUse";
};

export type BoundMessageDTO = LlmMessageDTO;
export type BoundPromptBlockDTO = PromptBlockSnapshotDTO;
export type BoundPromptVariableValuesDTO = PromptVariableValuesDTO;
export type BoundToolDefinitionDTO = ToolSchemaDTO;
export type BoundAssembleRequestDTO = WorkerBoundAssembleRequestDTO;
export type BoundAssemblyFailureDTO = WorkerBoundAssemblyFailureDTO;
export type BoundAssemblyOutcomeDTO = WorkerBoundAssemblyOutcomeDTO;
export type BoundAssemblySuccessDTO = WorkerBoundAssemblySuccessDTO;
export type BoundPrefillAttachmentDTO = WorkerBoundPrefillAttachmentDTO;
export type ConnectionDispatchDescriptorDTO = WorkerConnectionDispatchDescriptorDTO;
export type GenerationDispatchSourceDTO = WorkerGenerationDispatchSourceDTO;
export type GenerationResponseDTO = WorkerGenerationResponseDTO;
export type GenerationUsageDTO = WorkerGenerationUsageDTO;
export type QuietDispatchReceiptDTO = WorkerQuietDispatchReceiptDTO;
export type QuietTrackedRequestDTO = WorkerQuietTrackedRequestDTO;
export type QuietTrackedResultDTO = WorkerQuietTrackedResultDTO;

/** A provider response retained by the host adapter before DTO projection. */
export type HostGenerationResponse = GenerationResponse;
export type HostGenerationUsage = GenerationUsage;

/** Host-only immutable dispatch facts captured after authoritative resolution. */
export interface MainDispatchSnapshot {
  readonly kind: "main";
  readonly hostGeneration: HostGenerationId;
  readonly generationId: string;
  readonly userId: string;
  /** Main is bound to the active callback; this field is host-only context. */
  readonly chatId?: string;
  readonly descriptor: Readonly<ConnectionDispatchDescriptorDTO>;
  readonly dispatchRevision: DispatchRevision;
  readonly provider: string;
  readonly model: string;
  readonly endpointOrigin: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly reasoning: Readonly<Record<string, unknown>>;
  readonly authoritativeContext: Readonly<Record<string, unknown>>;
  readonly capturedAt: number;
}

/** Host-private plain facts retained for bound multiplayer macro expansion. */
export interface BoundMultiplayerMacroContext {
  readonly playerCount: number;
  readonly playerNames: readonly string[];
  readonly hostName: string;
  readonly currentTurnName: string;
  readonly turnStrategy: string;
}

/** Host-private participant persona facts retained for bound chat replay. */
export interface BoundMultiplayerPersonaEntry {
  readonly name: string;
  readonly description?: string;
}

/**
 * Exact retrieval inputs/results captured at the parent boundary. The records
 * contain plain cloned values only; they must never contain DB handles, cache
 * clients, functions, or provider credentials.
 */
export interface ParentRetrievalSnapshot {
  readonly kind: "parent-retrieval";
  readonly hostGeneration: HostGenerationId;
  readonly generationId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly capturedAt: number;
  readonly expiresAt: number;
  readonly bytes: number;
  readonly vectorWorldInfo: Readonly<Record<string, unknown>>;
  readonly chatMemory: Readonly<Record<string, unknown>>;
  readonly cortex: Readonly<Record<string, unknown>>;
  readonly databank: Readonly<Record<string, unknown>>;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly results: Readonly<Record<string, unknown>>;
  /** Exact embedding configuration used by the parent, if available. */
  readonly embeddingConfig?: Readonly<Record<string, unknown>>;
  /** Rich parent-only retrieval details not represented by the legacy buckets. */
  readonly capturedInputs?: Readonly<Record<string, unknown>>;
  readonly multiplayerMacroContext: Readonly<BoundMultiplayerMacroContext> | null;
  readonly multiplayerPersona: readonly BoundMultiplayerPersonaEntry[] | null;
}

/** Host-only immutable parent context used by all bound D operations. */
export interface ParentGenerationSnapshot {
  readonly kind: "parent-generation";
  readonly hostGeneration: HostGenerationId;
  readonly generationId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly main: MainDispatchSnapshot;
  readonly retrieval: ParentRetrievalSnapshot;
  readonly parentIdentities: Readonly<Record<string, string | null>>;
  readonly options: Readonly<Record<string, unknown>>;
  readonly parentPrefill: BoundPrefillAttachmentDTO;
  /** Canonical assistant carrier never exposed as a worker DTO. */
  readonly parentPrefillCarrier?: readonly LlmMessage[];
  /** Canonical carrier index is host-only and validated at capture. */
  readonly parentPrefillCarrierIndex?: number;
  readonly interceptorDeadlineAt: number;
  readonly boundWorkDeadlineAt: number;
}

/** A host-owned attestation for one parent carrier. */
export interface ParentPrefillAttestation {
  readonly id: string;
  readonly state: "absent" | "available";
  readonly hostGeneration: HostGenerationId;
  readonly generationId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly snapshotCapturedAt: number;
}

/** Concrete source resolution returned by the host dispatch authority. */
export interface BoundDispatchResolution {
  readonly source: "main" | "slot";
  readonly connectionId: string;
  readonly descriptor: Readonly<ConnectionDispatchDescriptorDTO>;
  readonly dispatchRevision: DispatchRevision;
}

export interface BoundDispatchProviderResult {
  readonly response: GenerationResponse;
  readonly terminalResponse: boolean;
  readonly usage?: GenerationUsage;
}

export type BoundDispatchProvider = (input: {
  readonly resolution: BoundDispatchResolution;
  readonly messages: readonly LlmMessage[];
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly reasoning: Readonly<Record<string, unknown>>;
  readonly tools: readonly ToolDefinition[];
  readonly signal: AbortSignal;
  readonly parentPrefill?: readonly LlmMessage[];
}) => Promise<BoundDispatchProviderResult>;

export type BoundAssemblyRunner = (input: {
  readonly snapshot: ParentGenerationSnapshot;
  readonly blocks: readonly BoundPromptBlockDTO[];
  readonly promptVariableValues?: BoundPromptVariableValuesDTO;
  readonly signal: AbortSignal;
  readonly hookFailureMode: "degrade" | "reject";
  readonly macroFailureMode: "degrade" | "reject";
}) => Promise<{
  readonly messages: readonly BoundMessageDTO[];
  readonly breakdown: readonly AssemblyBreakdownEntryDTO[];
}>;

export interface BoundHostScope {
  readonly workerId: string;
  readonly registrationGeneration: string;
  readonly callbackUserId: string;
  readonly hostGeneration: HostGenerationId;
  readonly requestId: string;
}

export interface BoundInvocationContext extends BoundHostScope {
  readonly invocationToken: InvocationToken;
  readonly parent: ParentGenerationSnapshot;
  /** Host callback signal; worker requests can only derive child signals. */
  readonly signal?: AbortSignal;
}

export interface ReadOnlyEffectLeaseContext extends BoundHostScope {
  readonly invocationToken: InvocationToken;
  readonly operation: string;
}

const fatalInstances = new WeakSet<object>();

export type HostContainmentFatalCode =
  | "BOUND_WORKER_CONTAINMENT_FAILED"
  | "BOUND_HOST_CONTRADICTION"
  | "NONCOMMIT_CONTAINMENT_FAILED";

/**
 * Host-only fatal channel. Construction is exported for test seams, but
 * recognition uses a private WeakSet rather than worker-controlled fields.
 */
export class HostContainmentFatal extends Error {
  readonly code: HostContainmentFatalCode;
  readonly hostGeneration: HostGenerationId;
  readonly workerId: string;
  readonly requestId: string;

  constructor(input: {
    code: HostContainmentFatalCode;
    message: string;
    hostGeneration: HostGenerationId;
    workerId: string;
    requestId: string;
  }) {
    super(input.message);
    this.name = "HostContainmentFatal";
    this.code = input.code;
    this.hostGeneration = input.hostGeneration;
    this.workerId = input.workerId;
    this.requestId = input.requestId;
    Object.setPrototypeOf(this, new.target.prototype);
    fatalInstances.add(this);
  }
}

export function isHostContainmentFatal(error: unknown): error is HostContainmentFatal {
  return (typeof error === "object" && error !== null && fatalInstances.has(error)) ||
    (typeof error === "function" && fatalInstances.has(error));
}

/** Host-private marker for failures before an adapter invocation begins. */
export class BoundProviderPreflightError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "BoundProviderPreflightError";
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const BOUND_MAX_RETRIEVAL_BYTES = 4 * 1024 * 1024;
export const BOUND_MAX_MESSAGES = 512;
export const BOUND_MAX_CARRIER_BYTES = 2 * 1024 * 1024;
export const BOUND_MAX_BLOCKS = 256;
export const BOUND_MAX_BLOCK_BYTES = 1_000_000;
export const BOUND_MAX_ERROR_BYTES = 4_096;
export const BOUND_INTERCEPTOR_RESERVE_MS = 15_000;
export const BOUND_MAX_WORK_MS = 285_000;
export const BOUND_CONTAINMENT_GRACE_MS = 1_000;

export interface BoundDeadlineWindow {
  readonly entryAt: number;
  readonly interceptorDeadlineAt: number;
  readonly boundWorkDeadlineAt: number;
}

export function computeBoundDeadlineWindow(
  entryAt: number,
  interceptorDeadlineAt: number,
): BoundDeadlineWindow {
  if (!Number.isFinite(entryAt) || !Number.isFinite(interceptorDeadlineAt)) {
    throw new RangeError("Bound deadlines must be finite numbers");
  }
  const boundWorkDeadlineAt = Math.min(
    entryAt + BOUND_MAX_WORK_MS,
    interceptorDeadlineAt - BOUND_INTERCEPTOR_RESERVE_MS,
  );
  if (boundWorkDeadlineAt <= entryAt) {
    throw new RangeError("Interceptor deadline leaves no bound work window");
  }
  return Object.freeze({ entryAt, interceptorDeadlineAt, boundWorkDeadlineAt });
}

export type BoundDeadlineValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "DEADLINE_INVALID" | "DEADLINE_EXPIRED" | "DEADLINE_OVERLONG";
      readonly message: string;
    };

export function validateBoundDeadline(
  deadlineAt: number,
  now: number,
  boundWorkDeadlineAt: number,
): BoundDeadlineValidation {
  if (!Number.isFinite(deadlineAt) || !Number.isFinite(now)) {
    return { ok: false, code: "DEADLINE_INVALID", message: "deadlineAt and now must be finite" };
  }
  if (deadlineAt <= now) {
    return { ok: false, code: "DEADLINE_EXPIRED", message: "deadlineAt must be strictly future" };
  }
  if (!Number.isFinite(boundWorkDeadlineAt) || deadlineAt > boundWorkDeadlineAt) {
    return {
      ok: false,
      code: "DEADLINE_OVERLONG",
      message: "deadlineAt exceeds the host bound work deadline",
    };
  }
  return { ok: true };
}

export function brandInvocationToken(value: string): InvocationToken {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("invocation token must be a non-empty string");
  }
  return value as InvocationToken;
}

export function brandHostGenerationId(value: string): HostGenerationId {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("host generation must be a non-empty string");
  }
  return value as HostGenerationId;
}

export function brandDispatchRevision(value: string): DispatchRevision {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("dispatch revision must be a non-empty string");
  }
  return value;
}

export function brandPrefillChildUse(value: string): PrefillChildUse {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("prefill child use must be a non-empty string");
  }
  return value as PrefillChildUse;
}

/** Stable JSON used for cap accounting and host-local canonical comparisons. */
export function stableJson(value: unknown): string {
  const active = new WeakSet<object>();
  const encode = (item: unknown): unknown => {
    if (item === undefined) return undefined;
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (Number.isFinite(item)) return item;
      return String(item);
    }
    if (typeof item === "bigint") return `${item}n`;
    if (typeof item === "function" || typeof item === "symbol") {
      throw new TypeError("Bound state must not contain functions or symbols");
    }
    if (typeof item !== "object") return String(item);
    if (active.has(item)) throw new TypeError("Cannot serialize cyclic bound state");
    active.add(item);
    try {
      if (item instanceof Date) return item.toISOString();
      if (item instanceof RegExp) return item.toString();
      if (Array.isArray(item)) {
        return item.map((entry) => {
          const encoded = encode(entry);
          return encoded === undefined ? null : encoded;
        });
      }
      if (item instanceof Map) {
        return [...item.entries()]
          .map(([key, entry]) => [encode(key), encode(entry)])
          .sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0])));
      }
      if (item instanceof Set) {
        return [...item.values()]
          .map(encode)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      }
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(item as Record<string, unknown>).sort()) {
        const encoded = encode((item as Record<string, unknown>)[key]);
        if (encoded !== undefined) output[key] = encoded;
      }
      return output;
    } finally {
      active.delete(item);
    }
  };
  return JSON.stringify(encode(value));
}

const hardenedCollections = new WeakSet<object>();

function immutableCollectionMutation(): never {
  throw new TypeError("Bound snapshot is immutable");
}

function hardenMap(source: Map<unknown, unknown>, seen: WeakSet<object>, replacements: WeakMap<object, object>): ReadonlyMap<unknown, unknown> {
  const existing = replacements.get(source);
  if (existing) return existing as ReadonlyMap<unknown, unknown>;
  const target = new Map<unknown, unknown>();
  const proxy = new Proxy(target, {
    get(targetMap, property, receiver) {
      if (property === "set" || property === "delete" || property === "clear") return immutableCollectionMutation;
      if (property === "forEach") {
        return (
          callback: (value: unknown, key: unknown, collection: Map<unknown, unknown>) => void,
          thisArg?: unknown,
        ) => {
          targetMap.forEach((value, key) => callback.call(thisArg, value, key, receiver));
        };
      }
      const member = Reflect.get(targetMap, property, targetMap);
      if (typeof member === "function") {
        if (property === "valueOf" || property === "toString") return member.bind(receiver);
        return member.bind(targetMap);
      }
      return member;
    },
    set: immutableCollectionMutation,
    deleteProperty: immutableCollectionMutation,
  });
  replacements.set(source, proxy);
  seen.add(source);
  for (const [key, value] of source.entries()) {
    target.set(freezeRecursively(key, seen, replacements), freezeRecursively(value, seen, replacements));
  }
  seen.delete(source);
  Object.freeze(proxy);
  hardenedCollections.add(proxy);
  return proxy;
}

function hardenSet(source: Set<unknown>, seen: WeakSet<object>, replacements: WeakMap<object, object>): ReadonlySet<unknown> {
  const existing = replacements.get(source);
  if (existing) return existing as ReadonlySet<unknown>;
  const target = new Set<unknown>();
  const proxy = new Proxy(target, {
    get(targetSet, property, receiver) {
      if (property === "add" || property === "delete" || property === "clear") return immutableCollectionMutation;
      if (property === "forEach") {
        return (
          callback: (value: unknown, key: unknown, collection: Set<unknown>) => void,
          thisArg?: unknown,
        ) => {
          targetSet.forEach((value) => callback.call(thisArg, value, value, receiver));
        };
      }
      const member = Reflect.get(targetSet, property, targetSet);
      if (typeof member === "function") {
        if (property === "valueOf" || property === "toString") return member.bind(receiver);
        return member.bind(targetSet);
      }
      return member;
    },
    set: immutableCollectionMutation,
    deleteProperty: immutableCollectionMutation,
  });
  replacements.set(source, proxy);
  seen.add(source);
  for (const value of source.values()) target.add(freezeRecursively(value, seen, replacements));
  seen.delete(source);
  Object.freeze(proxy);
  hardenedCollections.add(proxy);
  return proxy;
}

function freezeRecursively<T>(value: T, seen: WeakSet<object>, replacements: WeakMap<object, object>): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  if (hardenedCollections.has(value as object)) return value;
  if (value instanceof Map) return hardenMap(value, seen, replacements) as T;
  if (value instanceof Set) return hardenSet(value, seen, replacements) as T;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  for (const key of Reflect.ownKeys(value as object)) {
    const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
    if (!descriptor || !("value" in descriptor)) continue;
    const child = freezeRecursively(descriptor.value, seen, replacements);
    if (child === descriptor.value) continue;
    if (!descriptor.writable) throw new TypeError("Bound snapshot contains a read-only collection property");
    Object.defineProperty(value as object, key, { ...descriptor, value: child });
  }
  seen.delete(value as object);
  return Object.freeze(value);
}

function cloneValue(value: unknown, seen: WeakMap<object, object>): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function" && typeof value !== "symbol")) {
    if (typeof value === "function" || typeof value === "symbol") throw new TypeError("Bound state is not cloneable");
    return value;
  }
  if (typeof value === "function" || typeof value === "symbol") throw new TypeError("Bound state is not cloneable");
  const object = value as object;
  const prior = seen.get(object);
  if (prior) return prior;
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>();
    seen.set(object, copy);
    for (const [key, entry] of value.entries()) copy.set(cloneValue(key, seen), cloneValue(entry, seen));
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set<unknown>();
    seen.set(object, copy);
    for (const entry of value.values()) copy.add(cloneValue(entry, seen));
    return copy;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(object, copy);
    for (const entry of value) copy.push(cloneValue(entry, seen));
    return copy;
  }
  const copy: Record<PropertyKey, unknown> = {};
  seen.set(object, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) continue;
    copy[key] = cloneValue(descriptor.value, seen);
  }
  return copy;
}

export function deepFreeze<T>(value: T): Readonly<T> {
  return freezeRecursively(value, new WeakSet<object>(), new WeakMap<object, object>()) as Readonly<T>;
}

export function cloneAndFreeze<T>(value: T, maxBytes = BOUND_MAX_RETRIEVAL_BYTES): Readonly<T> {
  const encoded = new TextEncoder().encode(stableJson(value));
  if (encoded.byteLength > maxBytes) throw new RangeError(`Bound snapshot exceeds ${maxBytes} bytes`);
  const clone = cloneValue(value, new WeakMap<object, object>()) as T;
  return deepFreeze(clone);
}

export function normalizeUsage(usage: GenerationUsage | undefined): GenerationUsageDTO | undefined {
  if (!usage) return undefined;
  const normalized: Record<string, unknown> = {};
  if (typeof usage.prompt_tokens === "number" && Number.isFinite(usage.prompt_tokens)) normalized.prompt_tokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === "number" && Number.isFinite(usage.completion_tokens)) normalized.completion_tokens = usage.completion_tokens;
  if (typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens)) normalized.total_tokens = usage.total_tokens;
  if (usage.provider_raw !== undefined) {
    if (typeof usage.provider_raw !== "object" || usage.provider_raw === null || Array.isArray(usage.provider_raw)) {
      throw new TypeError("provider_raw must be an object");
    }
    normalized.provider_raw = cloneAndFreeze(usage.provider_raw, BOUND_MAX_CARRIER_BYTES) as Record<string, unknown>;
  }
  return deepFreeze(normalized) as GenerationUsageDTO;
}

/** Host-only input used by the capture helpers. */
export interface MainDispatchSnapshotInput {
  readonly hostGeneration: HostGenerationId | string;
  readonly generationId: string;
  readonly userId: string;
  readonly chatId?: string;
  readonly descriptor: ConnectionDispatchDescriptorDTO;
  readonly parameters?: Record<string, unknown>;
  readonly reasoning?: Record<string, unknown>;
  readonly authoritativeContext?: Record<string, unknown>;
  readonly capturedAt?: number;
}

/**
 * Parent retrieval capture accepts the six stable buckets and optional richer
 * details from the native assembly boundary. `capturedInputs` is retained as a
 * plain frozen record so no effectful host object can accidentally be retained.
 */
export interface ParentRetrievalSnapshotInput {
  readonly hostGeneration: HostGenerationId | string;
  readonly generationId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly capturedAt?: number;
  readonly expiresAt: number;
  readonly vectorWorldInfo: Record<string, unknown>;
  readonly chatMemory: Record<string, unknown>;
  readonly cortex: Record<string, unknown>;
  readonly databank: Record<string, unknown>;
  readonly settings: Record<string, unknown>;
  readonly results: Record<string, unknown>;
  readonly embeddingConfig?: Record<string, unknown>;
  readonly capturedInputs?: Record<string, unknown>;
  readonly multiplayerMacroContext?: BoundMultiplayerMacroContext | null;
  readonly multiplayerPersona?: readonly BoundMultiplayerPersonaEntry[] | null;
  readonly [key: string]: unknown;
}

export interface ParentGenerationSnapshotInput {
  readonly hostGeneration: HostGenerationId | string;
  readonly generationId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly main: MainDispatchSnapshot;
  readonly retrieval: ParentRetrievalSnapshot;
  readonly parentIdentities?: Record<string, string | null>;
  readonly options?: Record<string, unknown>;
  readonly parentPrefill: BoundPrefillAttachmentDTO;
  readonly parentPrefillCarrier?: readonly LlmMessage[];
  readonly parentPrefillCarrierIndex?: number;
  readonly interceptorDeadlineAt: number;
  readonly boundWorkDeadlineAt: number;
}

export type WorkerBoundAssembleRequest = BoundAssembleRequestDTO;
export type WorkerQuietTrackedRequest = QuietTrackedRequestDTO;
export type WorkerQuietTrackedResult = QuietTrackedResultDTO;
export type WorkerQuietTrackedResponse = WorkerGenerationResponseDTO;
export type WorkerQuietTrackedReceipt = WorkerQuietDispatchReceiptDTO;
export type WorkerGenerationUsage = WorkerGenerationUsageDTO;
export type WorkerAssemblyFailure = WorkerBoundAssemblyFailureDTO;
export type WorkerAssemblyOutcome = WorkerBoundAssemblyOutcomeDTO;
export type WorkerAssemblySuccess = WorkerBoundAssemblySuccessDTO;
export type WorkerPrefillAttachment = WorkerBoundPrefillAttachmentDTO;
export type WorkerDispatchSource = WorkerGenerationDispatchSourceDTO;
export type WorkerDescriptor = WorkerConnectionDispatchDescriptorDTO;
export type WorkerMessage = LlmMessageDTO;
