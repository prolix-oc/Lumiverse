import type {
  AssemblyBreakdownEntryDTO,
  GenerationResponseDTO,
  PromptVariableValuesDTO,
} from "lumiverse-spindle-types";
import type {
  GenerationResponse,
  GenerationUsage,
  LlmMessage,
  ToolDefinition,
} from "../llm/types";
import {
  BOUND_MAX_BLOCK_BYTES,
  BOUND_MAX_BLOCKS,
  BOUND_MAX_CARRIER_BYTES,
  BOUND_MAX_ERROR_BYTES,
  BOUND_MAX_MESSAGES,
  BOUND_MAX_RETRIEVAL_BYTES,
  BoundProviderPreflightError,
  HostContainmentFatal,
  brandDispatchRevision,
  brandHostGenerationId,
  brandPrefillChildUse,
  cloneAndFreeze,
  deepFreeze,
  isHostContainmentFatal,
  normalizeUsage,
  stableJson,
  validateBoundDeadline,
} from "./bound-generation-types";
import type {
  BoundAssembleRequestDTO,
  BoundAssemblyFailureDTO,
  BoundAssemblyOutcomeDTO,
  BoundAssemblyRunner,
  BoundAssemblySuccessDTO,
  BoundDispatchProvider,
  BoundDispatchProviderResult,
  BoundDispatchResolution,
  BoundInvocationContext,
  BoundMessageDTO,
  BoundPromptBlockDTO,
  BoundPrefillAttachmentDTO,
  BoundToolDefinitionDTO,
  BoundMultiplayerMacroContext,
  BoundMultiplayerPersonaEntry,
  ConnectionDispatchDescriptorDTO,
  DispatchRevision,
  GenerationDispatchSourceDTO,
  HostGenerationId,
  MainDispatchSnapshot,
  MainDispatchSnapshotInput,
  ParentGenerationSnapshot,
  ParentGenerationSnapshotInput,
  ParentPrefillAttestation,
  ParentRetrievalSnapshot,
  ParentRetrievalSnapshotInput,
  PrefillChildUse,
  QuietDispatchReceiptDTO,
  QuietTrackedRequestDTO,
  QuietTrackedResultDTO,
  ReadOnlyEffectLeaseContext,
} from "./bound-generation-types";

const DEFAULT_ERROR_MESSAGE = "Bound generation failed";
const MAX_MULTIPLAYER_FACT_STRING_BYTES = 4 * 1024;
const PREFILL_PURPOSES = ["thread-continuation", "terminal-guidance"] as const;
type PrefillPurpose = (typeof PREFILL_PURPOSES)[number];
// ParentPrefillChildUse is deliberately host-only and is never a worker DTO.
export interface ParentPrefillChildUse {
  readonly token: PrefillChildUse;
  readonly requestId: string;
  readonly purpose: "thread-continuation" | "terminal-guidance";
  readonly parentPrefillAttestation: ParentPrefillAttestation;
  readonly parentPrefillMessages: readonly LlmMessage[];
}

type BoundDispatchResolverInput = {
  readonly source: GenerationDispatchSourceDTO;
  readonly parent: ParentGenerationSnapshot;
};
export type BoundDispatchResolver = (
  input: BoundDispatchResolverInput,
) => Promise<BoundDispatchResolution | null | undefined>;

export interface BoundGenerationCallbacks {
  readonly resolveDispatch: BoundDispatchResolver;
  readonly assemble: BoundAssemblyRunner;
  readonly provider: BoundDispatchProvider;
  readonly now?: () => number;
}

export interface BoundAssemblyExecution {
  readonly context: BoundInvocationContext;
  readonly request: BoundAssembleRequestDTO;
  readonly resolveDispatch: BoundDispatchResolver;
  readonly assemble: BoundAssemblyRunner;
  readonly now?: () => number;
}

export interface BoundPrefillChildOptions {
  readonly parentPrefillAttestation?: ParentPrefillAttestation;
  /** Legacy host-only carrier input is accepted only for attestation checks. */
  readonly parentPrefillMessages?: readonly LlmMessage[];
  /** A host-minted one-use child; callers cannot supply carrier content. */
  readonly childUse?: ParentPrefillChildUse;
}

export interface BoundQuietExecution {
  readonly context: BoundInvocationContext;
  readonly request: QuietTrackedRequestDTO;
  readonly resolveDispatch: BoundDispatchResolver;
  readonly provider: BoundDispatchProvider;
  readonly now?: () => number;
  readonly child?: BoundPrefillChildOptions;
}

export interface BoundGenerationBinding {
  readonly context: BoundInvocationContext;
  readonly assemble: (request: BoundAssembleRequestDTO) => Promise<BoundAssemblyOutcomeDTO>;
  readonly quietTracked: (
    request: QuietTrackedRequestDTO,
    child?: BoundPrefillChildOptions,
  ) => Promise<QuietTrackedResultDTO>;
}

export interface BoundEffectLease {
  readonly context: ReadOnlyEffectLeaseContext;
  readonly assertAllowed: (operation: string) => void;
  readonly deny: (operation: string) => never;
  readonly isActive: () => boolean;
  readonly release: () => void;
}

interface DispatchReceiptSeed {
  readonly source: "main" | "slot";
  readonly connectionId: string | null;
  readonly connectionDispatchRevision: string;
}

interface ResolvedDispatch {
  readonly resolution: BoundDispatchResolution;
  readonly receipt: DispatchReceiptSeed;
}

interface DispatchResolutionFailure {
  readonly kind: "precondition" | "security";
  readonly code: string;
  readonly message: string;
  readonly receipt: DispatchReceiptSeed;
}

interface DispatchValidation {
  readonly source: "main" | "slot";
  readonly expectedRevision: string;
  readonly connectionId: string | null;
}

interface ParentPrefillRecord {
  readonly snapshot: ParentGenerationSnapshot;
  readonly attestation: ParentPrefillAttestation;
  readonly messages: readonly LlmMessage[];
}

interface ParentPrefillChildRecord {
  readonly snapshot: ParentGenerationSnapshot;
  readonly attestation: ParentPrefillAttestation;
  readonly requestId: string;
  readonly purpose: PrefillPurpose;
  readonly messages: readonly LlmMessage[];
}

const parentPrefillRecords = new WeakMap<object, ParentPrefillRecord>();
const parentPrefillChildUses = new WeakMap<object, ParentPrefillChildRecord>();

class BoundEffectDeniedError extends Error {
  readonly code = "ASSEMBLY_REENTRANCY" as const;
  readonly operation: string;

  constructor(operation: string) {
    super(`Effect lease denied operation: ${operation}`);
    this.name = "BoundEffectDeniedError";
    this.operation = operation;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite`);
  }
  return value;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(stableJson(value)).byteLength;
}

function cloneRecord(
  value: Record<string, unknown> | undefined,
  label: string,
  maxBytes = BOUND_MAX_RETRIEVAL_BYTES,
): Readonly<Record<string, unknown>> {
  if (value !== undefined && !isRecord(value)) throw new TypeError(`${label} must be an object`);
  try {
    return cloneAndFreeze(value ?? {}, maxBytes) as Readonly<Record<string, unknown>>;
  } catch (error) {
    if (error instanceof RangeError) throw new RangeError(`${label} is unavailable or oversize`);
    throw new TypeError(`${label} must be JSON-safe and acyclic`);
  }
}

function boundedMultiplayerString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  if (new TextEncoder().encode(value).byteLength > MAX_MULTIPLAYER_FACT_STRING_BYTES) {
    throw new RangeError(`${label} exceeds ${MAX_MULTIPLAYER_FACT_STRING_BYTES} bytes`);
  }
  return value;
}

function cloneMultiplayerMacroContext(
  value: unknown,
): Readonly<BoundMultiplayerMacroContext> | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new TypeError("multiplayerMacroContext must be an object or null");
  if (typeof value.playerCount !== "number" || !Number.isSafeInteger(value.playerCount) || value.playerCount < 0) {
    throw new RangeError("multiplayerMacroContext.playerCount must be a nonnegative safe integer");
  }
  if (!Array.isArray(value.playerNames) || value.playerNames.length > BOUND_MAX_MESSAGES) {
    throw new RangeError(`multiplayerMacroContext.playerNames exceeds ${BOUND_MAX_MESSAGES} entries`);
  }
  return cloneAndFreeze(
    {
      playerCount: value.playerCount,
      playerNames: value.playerNames.map((name, index) => boundedMultiplayerString(name, `multiplayerMacroContext.playerNames[${index}]`)),
      hostName: boundedMultiplayerString(value.hostName, "multiplayerMacroContext.hostName"),
      currentTurnName: boundedMultiplayerString(value.currentTurnName, "multiplayerMacroContext.currentTurnName"),
      turnStrategy: boundedMultiplayerString(value.turnStrategy, "multiplayerMacroContext.turnStrategy"),
    },
    BOUND_MAX_CARRIER_BYTES,
  ) as Readonly<BoundMultiplayerMacroContext>;
}

function cloneMultiplayerPersona(value: unknown): readonly BoundMultiplayerPersonaEntry[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length > BOUND_MAX_MESSAGES) {
    throw new RangeError(`multiplayerPersona exceeds ${BOUND_MAX_MESSAGES} entries`);
  }
  return cloneAndFreeze(
    value.map((entry, index) => {
      if (!isRecord(entry)) throw new TypeError(`multiplayerPersona[${index}] must be an object`);
      const name = boundedMultiplayerString(entry.name, `multiplayerPersona[${index}].name`);
      const description = entry.description === undefined ? undefined : boundedMultiplayerString(entry.description, `multiplayerPersona[${index}].description`);
      return description === undefined ? { name } : { name, description };
    }),
    BOUND_MAX_CARRIER_BYTES,
  ) as readonly BoundMultiplayerPersonaEntry[];
}

function normalizeHostGeneration(value: HostGenerationId | string): HostGenerationId {
  return brandHostGenerationId(requireText(value, "hostGeneration"));
}

function normalizeDispatchRevision(value: unknown): DispatchRevision {
  return brandDispatchRevision(requireText(value, "connectionDispatchRevision"));
}

function cloneDescriptor(value: ConnectionDispatchDescriptorDTO): Readonly<ConnectionDispatchDescriptorDTO> {
  if (!isRecord(value)) throw new TypeError("dispatch descriptor must be an object");
  const connectionId = requireText(value.connectionId, "descriptor.connectionId");
  const connectionName = requireText(value.connectionName, "descriptor.connectionName");
  const provider = requireText(value.provider, "descriptor.provider");
  const model = requireText(value.model, "descriptor.model");
  const endpointOrigin = requireText(value.endpointOrigin, "descriptor.endpointOrigin");
  if (value.dispatchKind !== "concrete") throw new Error("roulette dispatch cannot authorize a bound call");
  const revision = normalizeDispatchRevision(value.connectionDispatchRevision);
  return cloneAndFreeze(
    {
      connectionId,
      connectionName,
      provider,
      model,
      endpointOrigin,
      dispatchKind: "concrete" as const,
      connectionDispatchRevision: revision,
    },
    BOUND_MAX_CARRIER_BYTES,
  ) as Readonly<ConnectionDispatchDescriptorDTO>;
}

function cloneParentPrefill(value: BoundPrefillAttachmentDTO): BoundPrefillAttachmentDTO {
  if (!isRecord(value)) throw new TypeError("parentPrefill must be an object");
  const id = requireText(value.id, "parentPrefill.id");
  if (value.state !== "absent" && value.state !== "available" && value.state !== "invalid") {
    throw new TypeError("parentPrefill.state is invalid");
  }
  return deepFreeze({ id, state: value.state }) as BoundPrefillAttachmentDTO;
}

function validateParentPrefillCarrierIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("parentPrefillCarrierIndex must be a non-negative safe integer");
  }
  return value;
}

function validateMessage(value: unknown, label: string): asserts value is LlmMessage {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  if (value.role !== "system" && value.role !== "user" && value.role !== "assistant") {
    throw new TypeError(`${label}.role is invalid`);
  }
  if (typeof value.content !== "string" && !Array.isArray(value.content)) {
    throw new TypeError(`${label}.content is invalid`);
  }
}

function cloneMessages(value: readonly BoundMessageDTO[] | readonly LlmMessage[], label: string, maxBytes = BOUND_MAX_CARRIER_BYTES): readonly LlmMessage[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (value.length > BOUND_MAX_MESSAGES) throw new RangeError(`${label} exceeds ${BOUND_MAX_MESSAGES} messages`);
  value.forEach((message, index) => validateMessage(message, `${label}[${index}]`));
  return cloneAndFreeze(value, maxBytes) as readonly LlmMessage[];
}

function clonePromptBlocks(value: readonly BoundPromptBlockDTO[]): readonly BoundPromptBlockDTO[] {
  if (!Array.isArray(value)) throw new TypeError("blocks must be an array");
  if (value.length === 0) throw new RangeError("blocks must contain at least one prompt block");
  if (value.length > BOUND_MAX_BLOCKS) throw new RangeError(`blocks exceeds ${BOUND_MAX_BLOCKS}`);
  if (byteLength(value) > BOUND_MAX_BLOCK_BYTES) throw new RangeError(`blocks exceeds ${BOUND_MAX_BLOCK_BYTES} bytes`);
  return cloneAndFreeze(value, BOUND_MAX_BLOCK_BYTES) as readonly BoundPromptBlockDTO[];
}

function clonePromptVariables(value: PromptVariableValuesDTO | undefined): PromptVariableValuesDTO | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new TypeError("promptVariableValues must be an object");
  return cloneAndFreeze(value, BOUND_MAX_CARRIER_BYTES) as PromptVariableValuesDTO;
}

function cloneTools(value: readonly BoundToolDefinitionDTO[] | undefined): readonly ToolDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("tools must be an array");
  if (value.length > BOUND_MAX_MESSAGES) throw new RangeError(`tools exceeds ${BOUND_MAX_MESSAGES}`);
  const tools = value.map((tool, index) => {
    if (!isRecord(tool)) throw new TypeError(`tools[${index}] must be an object`);
    const name = requireText(tool.name, `tools[${index}].name`);
    const description = typeof tool.description === "string" ? tool.description : "";
    if (!isRecord(tool.parameters)) throw new TypeError(`tools[${index}].parameters must be an object`);
    return {
      name,
      description,
      parameters: cloneAndFreeze(tool.parameters, BOUND_MAX_CARRIER_BYTES) as Record<string, unknown>,
      ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
      ...(Array.isArray(tool.inputExamples) ? { inputExamples: cloneAndFreeze(tool.inputExamples, BOUND_MAX_CARRIER_BYTES) as Array<Record<string, unknown>> } : {}),
      ...(isRecord(tool.cache_control) ? { cache_control: cloneAndFreeze(tool.cache_control, BOUND_MAX_CARRIER_BYTES) as Record<string, unknown> } : {}),
    } satisfies ToolDefinition;
  });
  return deepFreeze(tools);
}

function nowOf(clock?: () => number): number {
  const now = clock ? clock() : Date.now();
  return requireFinite(now, "now");
}

/** Capture Main's effective concrete route after authoritative host resolution. */
export function captureMainDispatchSnapshot(input: MainDispatchSnapshotInput): MainDispatchSnapshot {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Main dispatch snapshot input is required");
  }
  const hostGeneration = normalizeHostGeneration(input.hostGeneration);
  const generationId = requireText(input.generationId, "generationId");
  const userId = requireText(input.userId, "userId");
  const chatId = input.chatId === undefined ? undefined : requireText(input.chatId, "chatId");
  const descriptor = cloneDescriptor(input.descriptor);
  const dispatchRevision = normalizeDispatchRevision(descriptor.connectionDispatchRevision);
  const capturedAt = input.capturedAt === undefined ? Date.now() : requireFinite(input.capturedAt, "capturedAt");
  const snapshot = {
    kind: "main" as const,
    hostGeneration,
    generationId,
    userId,
    ...(chatId === undefined ? {} : { chatId }),
    descriptor,
    dispatchRevision,
    provider: descriptor.provider,
    model: descriptor.model,
    endpointOrigin: descriptor.endpointOrigin,
    parameters: cloneRecord(input.parameters, "parameters"),
    reasoning: cloneRecord(input.reasoning, "reasoning"),
    authoritativeContext: cloneRecord(input.authoritativeContext, "authoritativeContext"),
    capturedAt,
  } satisfies MainDispatchSnapshot;
  return deepFreeze(snapshot);
}

/** Capture exact parent retrieval facts; no fresh retrieval or effect handle is retained. */
export function captureParentRetrievalSnapshot(input: ParentRetrievalSnapshotInput): ParentRetrievalSnapshot {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Parent retrieval snapshot input is required");
  }
  const hostGeneration = normalizeHostGeneration(input.hostGeneration);
  const generationId = requireText(input.generationId, "generationId");
  const userId = requireText(input.userId, "userId");
  const chatId = requireText(input.chatId, "chatId");
  const capturedAt = input.capturedAt === undefined ? Date.now() : requireFinite(input.capturedAt, "capturedAt");
  const expiresAt = requireFinite(input.expiresAt, "expiresAt");
  if (expiresAt <= capturedAt) throw new RangeError("retrieval snapshot expiresAt must be after capturedAt");
  const payload = {
    kind: "parent-retrieval" as const,
    hostGeneration,
    generationId,
    userId,
    chatId,
    capturedAt,
    expiresAt,
    vectorWorldInfo: cloneRecord(input.vectorWorldInfo, "vectorWorldInfo"),
    chatMemory: cloneRecord(input.chatMemory, "chatMemory"),
    cortex: cloneRecord(input.cortex, "cortex"),
    databank: cloneRecord(input.databank, "databank"),
    settings: cloneRecord(input.settings, "settings"),
    results: cloneRecord(input.results, "results"),
    ...(input.embeddingConfig === undefined ? {} : { embeddingConfig: cloneRecord(input.embeddingConfig, "embeddingConfig", BOUND_MAX_CARRIER_BYTES) }),
    ...(input.capturedInputs === undefined ? {} : { capturedInputs: cloneRecord(input.capturedInputs, "capturedInputs", BOUND_MAX_RETRIEVAL_BYTES) }),
    multiplayerMacroContext: cloneMultiplayerMacroContext(input.multiplayerMacroContext),
    multiplayerPersona: cloneMultiplayerPersona(input.multiplayerPersona),
  };
  const bytes = byteLength(payload);
  if (bytes > BOUND_MAX_RETRIEVAL_BYTES) throw new RangeError(`retrieval snapshot exceeds ${BOUND_MAX_RETRIEVAL_BYTES} bytes`);
  const cloned = cloneAndFreeze(payload, BOUND_MAX_RETRIEVAL_BYTES);
  return deepFreeze({ ...cloned, bytes }) as ParentRetrievalSnapshot;
}

/** Runtime-authority clone of a previously captured retrieval snapshot. */
export function cloneBoundRetrievalSnapshot(value: ParentRetrievalSnapshot): ParentRetrievalSnapshot {
  if (!isRecord(value) || value.kind !== "parent-retrieval") throw new TypeError("retrieval must be a parent retrieval snapshot");
  const bytes = value.bytes;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > BOUND_MAX_RETRIEVAL_BYTES) {
    throw new TypeError("retrieval.bytes is invalid");
  }
  const { bytes: _ignored, ...payload } = value;
  const measuredBytes = byteLength(payload);
  if (measuredBytes !== bytes) throw new RangeError("retrieval snapshot bytes are invalid or oversize");
  if (typeof payload.hostGeneration !== "string" || typeof payload.generationId !== "string" || typeof payload.userId !== "string" || typeof payload.chatId !== "string") {
    throw new TypeError("retrieval snapshot identity is invalid");
  }
  if (!Number.isFinite(payload.expiresAt) || !Number.isFinite(payload.capturedAt) || payload.expiresAt <= payload.capturedAt) {
    throw new RangeError("retrieval snapshot expiry is invalid");
  }
  return deepFreeze(cloneAndFreeze({ ...payload, bytes }, BOUND_MAX_RETRIEVAL_BYTES)) as ParentRetrievalSnapshot;
}

function assertParentSnapshotShape(value: unknown): asserts value is ParentGenerationSnapshot {
  if (!isRecord(value) || value.kind !== "parent-generation") throw new TypeError("parent must be a parent-generation snapshot");
  requireText(value.hostGeneration, "parent.hostGeneration");
  requireText(value.generationId, "parent.generationId");
  requireText(value.userId, "parent.userId");
  requireText(value.chatId, "parent.chatId");
  if (!isRecord(value.main) || value.main.kind !== "main") throw new TypeError("parent.main snapshot is invalid");
  if (!isRecord(value.retrieval) || value.retrieval.kind !== "parent-retrieval") throw new TypeError("parent.retrieval snapshot is invalid");
}

/** Runtime validation/cloning seam shared by the bound runner and assembly adapter. */
export function cloneBoundParentGenerationSnapshot(value: ParentGenerationSnapshot): ParentGenerationSnapshot {
  assertParentSnapshotShape(value);
  const hostGeneration = normalizeHostGeneration(value.hostGeneration);
  const generationId = requireText(value.generationId, "parent.generationId");
  const userId = requireText(value.userId, "parent.userId");
  const chatId = requireText(value.chatId, "parent.chatId");
  const main = captureMainDispatchSnapshot({
    hostGeneration,
    generationId,
    userId,
    chatId: value.main.chatId ?? chatId,
    descriptor: value.main.descriptor,
    parameters: value.main.parameters,
    reasoning: value.main.reasoning,
    authoritativeContext: value.main.authoritativeContext,
    capturedAt: value.main.capturedAt,
  });
  if (main.dispatchRevision !== value.main.dispatchRevision) throw new Error("parent.main revision is invalid");
  const retrieval = cloneBoundRetrievalSnapshot(value.retrieval);
  if (retrieval.hostGeneration !== hostGeneration || retrieval.generationId !== generationId || retrieval.userId !== userId || retrieval.chatId !== chatId) {
    throw new Error("parent retrieval identity mismatch");
  }
  const parentPrefill = cloneParentPrefill(value.parentPrefill);
  const parentPrefillCarrier = value.parentPrefillCarrier === undefined ? undefined : cloneMessages(value.parentPrefillCarrier, "parentPrefillCarrier", BOUND_MAX_CARRIER_BYTES);
  if (parentPrefillCarrier !== undefined && (parentPrefill.state !== "available" || parentPrefillCarrier.length !== 1 || parentPrefillCarrier[0]?.role !== "assistant")) {
    throw new Error("parent prefill carrier is invalid");
  }
  if (parentPrefillCarrier === undefined && parentPrefill.state === "available") throw new Error("available parent prefill requires its canonical carrier");
  const parentPrefillCarrierIndex = value.parentPrefillCarrierIndex === undefined ? undefined : validateParentPrefillCarrierIndex(value.parentPrefillCarrierIndex);
  if (parentPrefillCarrierIndex !== undefined && parentPrefillCarrier === undefined) throw new Error("parent prefill carrier index requires a carrier");
  const interceptorDeadlineAt = requireFinite(value.interceptorDeadlineAt, "interceptorDeadlineAt");
  const boundWorkDeadlineAt = requireFinite(value.boundWorkDeadlineAt, "boundWorkDeadlineAt");
  if (boundWorkDeadlineAt <= 0 || boundWorkDeadlineAt > interceptorDeadlineAt) throw new RangeError("boundWorkDeadlineAt must be positive and no later than interceptorDeadlineAt");
  const parentIdentities = cloneRecord(value.parentIdentities, "parentIdentities", BOUND_MAX_CARRIER_BYTES) as Readonly<Record<string, string | null>>;
  for (const identity of Object.values(parentIdentities)) {
    if (identity !== null && typeof identity !== "string") throw new TypeError("parentIdentities values must be strings or null");
  }
  const options = cloneRecord(value.options, "options", BOUND_MAX_CARRIER_BYTES);
  return deepFreeze({
    kind: "parent-generation" as const,
    hostGeneration,
    generationId,
    userId,
    chatId,
    main,
    retrieval,
    parentIdentities,
    options,
    parentPrefill,
    ...(parentPrefillCarrier === undefined ? {} : { parentPrefillCarrier }),
    ...(parentPrefillCarrierIndex === undefined ? {} : { parentPrefillCarrierIndex }),
    interceptorDeadlineAt,
    boundWorkDeadlineAt,
  });
}

/** Bind authoritative Main/retrieval snapshots into one immutable parent. */
export function captureParentGenerationSnapshot(input: ParentGenerationSnapshotInput): ParentGenerationSnapshot {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Parent generation snapshot input is required");
  }
  const hostGeneration = normalizeHostGeneration(input.hostGeneration);
  const generationId = requireText(input.generationId, "generationId");
  const userId = requireText(input.userId, "userId");
  const chatId = requireText(input.chatId, "chatId");
  if (input.main.hostGeneration !== hostGeneration) throw new Error("Main snapshot host generation mismatch");
  if (input.main.generationId !== generationId) throw new Error("Main snapshot generation mismatch");
  if (input.main.userId !== userId) throw new Error("Main snapshot user scope mismatch");
  if (input.main.chatId !== undefined && input.main.chatId !== chatId) throw new Error("Main snapshot chat scope mismatch");
  if (input.retrieval.hostGeneration !== hostGeneration) throw new Error("Retrieval snapshot host generation mismatch");
  if (input.retrieval.generationId !== generationId) throw new Error("Retrieval snapshot generation mismatch");
  if (input.retrieval.userId !== userId) throw new Error("Retrieval snapshot user scope mismatch");
  if (input.retrieval.chatId !== chatId) throw new Error("Retrieval snapshot chat scope mismatch");
  return cloneBoundParentGenerationSnapshot({
    kind: "parent-generation",
    hostGeneration,
    generationId,
    userId,
    chatId,
    main: input.main,
    retrieval: input.retrieval,
    parentIdentities: input.parentIdentities ?? {},
    options: input.options ?? {},
    parentPrefill: input.parentPrefill,
    ...(input.parentPrefillCarrier === undefined ? {} : { parentPrefillCarrier: input.parentPrefillCarrier }),
    ...(input.parentPrefillCarrierIndex === undefined ? {} : { parentPrefillCarrierIndex: input.parentPrefillCarrierIndex }),
    interceptorDeadlineAt: input.interceptorDeadlineAt,
    boundWorkDeadlineAt: input.boundWorkDeadlineAt,
  });
}

/** Create a host-held attestation without deleting the parent record. */
export function createParentPrefillAttestation(snapshot: ParentGenerationSnapshot): ParentPrefillAttestation {
  assertParentSnapshotShape(snapshot);
  if (snapshot.parentPrefill.state === "invalid") throw new Error("Cannot attest an invalid parent prefill");
  const attestation = deepFreeze({
    id: snapshot.parentPrefill.id,
    state: snapshot.parentPrefill.state === "available" ? "available" as const : "absent" as const,
    hostGeneration: snapshot.hostGeneration,
    generationId: snapshot.generationId,
    userId: snapshot.userId,
    chatId: snapshot.chatId,
    snapshotCapturedAt: snapshot.retrieval.capturedAt,
  }) satisfies ParentPrefillAttestation;
  parentPrefillRecords.set(attestation as object, {
    snapshot,
    attestation,
    messages: snapshot.parentPrefillCarrier ?? [],
  });
  return attestation;
}

function attestMatches(snapshot: ParentGenerationSnapshot, attachment: BoundPrefillAttachmentDTO, attestation: ParentPrefillAttestation): boolean {
  const record = parentPrefillRecords.get(attestation as object);
  if (!record || record.snapshot !== snapshot || record.attestation !== attestation) return false;
  return snapshot.parentPrefill.state === "available" &&
    attestation.state === "available" &&
    attachment.state === "available" &&
    attestation.id === snapshot.parentPrefill.id &&
    attachment.id === snapshot.parentPrefill.id &&
    attestation.hostGeneration === snapshot.hostGeneration &&
    attestation.generationId === snapshot.generationId &&
    attestation.userId === snapshot.userId &&
    attestation.chatId === snapshot.chatId &&
    attestation.snapshotCapturedAt === snapshot.retrieval.capturedAt;
}

/** Validate a worker attachment against the host-held record; the record remains mintable. */
export function consumeParentPrefillAttestation(snapshot: ParentGenerationSnapshot, attachment: BoundPrefillAttachmentDTO, attestation: ParentPrefillAttestation): boolean {
  return attestMatches(snapshot, attachment, attestation);
}

/** Mint a request/purpose-bound child. Parent attestations are reusable; children are not. */
export function mintParentPrefillChildUse(
  snapshot: ParentGenerationSnapshot,
  attestation: ParentPrefillAttestation,
  requestId: string,
  purpose: PrefillPurpose = "thread-continuation",
): ParentPrefillChildUse {
  assertParentSnapshotShape(snapshot);
  const normalizedRequestId = requireText(requestId, "requestId");
  if (!PREFILL_PURPOSES.includes(purpose)) throw new TypeError("Unsupported parent prefill purpose");
  const record = parentPrefillRecords.get(attestation as object);
  if (!record || record.snapshot !== snapshot || record.attestation !== attestation || snapshot.parentPrefill.state !== "available" || attestation.state !== "available" || record.messages.length !== 1 || record.messages[0]?.role !== "assistant") {
    throw new Error("Parent prefill attestation is unavailable");
  }
  const child = deepFreeze({
    token: brandPrefillChildUse(crypto.randomUUID()),
    requestId: normalizedRequestId,
    purpose,
    parentPrefillAttestation: attestation,
    parentPrefillMessages: record.messages,
  });
  parentPrefillChildUses.set(child as object, {
    snapshot,
    attestation,
    requestId: normalizedRequestId,
    purpose,
    messages: record.messages,
  });
  return child;
}

function inspectParentPrefillChild(child: ParentPrefillChildUse, requestId: string, purpose: PrefillPurpose): ParentPrefillChildRecord {
  if (!child || typeof child !== "object") throw new TypeError("A host-minted parent prefill child is required");
  const record = parentPrefillChildUses.get(child as object);
  if (!record || record.requestId !== requestId || record.purpose !== purpose || record.snapshot.parentPrefill.state !== "available") {
    throw new Error("Parent prefill child is invalid, expired, or already consumed");
  }
  return record;
}

/** Consume a child exactly once immediately before provider work. */
export function attachBoundParentPrefill(child: ParentPrefillChildUse, requestId: string, purpose: PrefillPurpose = "thread-continuation"): readonly LlmMessage[] {
  const record = inspectParentPrefillChild(child, requestId, purpose);
  parentPrefillChildUses.delete(child as object);
  return record.messages;
}

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError" || isRecord(error) && error.name === "AbortError";
}

function errorText(error: unknown, fallback = DEFAULT_ERROR_MESSAGE): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  const encoded = new TextEncoder().encode(raw || fallback);
  return new TextDecoder().decode(encoded.slice(0, BOUND_MAX_ERROR_BYTES));
}

function assemblyFailure(kind: "precondition" | "security" | "internal", code: string, message: string): BoundAssemblyOutcomeDTO {
  return { ok: false, error: { kind, code, message: errorText(message) } as BoundAssemblyFailureDTO };
}

function assemblyAbort(): BoundAssemblyOutcomeDTO {
  return { ok: false, error: { kind: "abort", code: "ASSEMBLY_ABORTED", name: "AbortError", message: "Bound assembly was aborted" } };
}

function validateDispatchSource(source: GenerationDispatchSourceDTO): DispatchValidation | DispatchResolutionFailure {
  if (!isRecord(source) || (source.source !== "main" && source.source !== "slot")) {
    return { kind: "security", code: "DISPATCH_SOURCE_INVALID", message: "Dispatch source is invalid", receipt: { source: "main", connectionId: null, connectionDispatchRevision: "" } };
  }
  if (typeof source.expectedConnectionDispatchRevision !== "string" || source.expectedConnectionDispatchRevision.trim().length === 0) {
    return { kind: "precondition", code: "DISPATCH_REVISION_REQUIRED", message: "Dispatch revision is required", receipt: { source: source.source, connectionId: source.source === "slot" && typeof source.connectionId === "string" ? source.connectionId : null, connectionDispatchRevision: "" } };
  }
  if (source.source === "slot") {
    if (typeof source.connectionId !== "string" || source.connectionId.trim().length === 0) {
      return { kind: "security", code: "DISPATCH_CONNECTION_INVALID", message: "Slot connectionId is required", receipt: { source: "slot", connectionId: null, connectionDispatchRevision: source.expectedConnectionDispatchRevision } };
    }
    return { source: "slot", expectedRevision: source.expectedConnectionDispatchRevision, connectionId: source.connectionId };
  }
  if ("connectionId" in source) {
    return { kind: "security", code: "DISPATCH_MAIN_CONNECTION_FORBIDDEN", message: "Main dispatch cannot carry a connectionId", receipt: { source: "main", connectionId: null, connectionDispatchRevision: source.expectedConnectionDispatchRevision } };
  }
  return { source: "main", expectedRevision: source.expectedConnectionDispatchRevision, connectionId: null };
}

function descriptorIsConcrete(value: unknown): value is ConnectionDispatchDescriptorDTO {
  if (!isRecord(value) || value.dispatchKind !== "concrete") return false;
  try {
    cloneDescriptor(value as unknown as ConnectionDispatchDescriptorDTO);
    return true;
  } catch {
    return false;
  }
}

function seedForSource(parent: ParentGenerationSnapshot, source: DispatchValidation | DispatchResolutionFailure): DispatchReceiptSeed {
  if ("receipt" in source) return source.receipt;
  return {
    source: source.source,
    connectionId: source.source === "main" ? parent.main.descriptor.connectionId : source.connectionId,
    connectionDispatchRevision: source.expectedRevision,
  };
}

async function resolveDispatch(parent: ParentGenerationSnapshot, source: GenerationDispatchSourceDTO, resolver: BoundDispatchResolver): Promise<ResolvedDispatch | DispatchResolutionFailure> {
  const validation = validateDispatchSource(source);
  if ("kind" in validation) return validation;
  const receipt: DispatchReceiptSeed = {
    source: validation.source,
    connectionId: validation.source === "main" ? parent.main.descriptor.connectionId : validation.connectionId,
    connectionDispatchRevision: validation.expectedRevision,
  };
  let result: BoundDispatchResolution | null | undefined;
  try {
    result = await resolver({ source, parent });
  } catch (error) {
    if (isHostContainmentFatal(error)) throw error;
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "DISPATCH_RESOLUTION_FAILED";
    return { kind: "security", code, message: errorText(error), receipt };
  }
  if (!result || !isRecord(result)) return { kind: "precondition", code: "DISPATCH_UNAVAILABLE", message: "Dispatch source is unavailable", receipt };
  if (result.source !== validation.source || result.dispatchRevision !== validation.expectedRevision) {
    return { kind: "security", code: "DISPATCH_REVISION_STALE", message: "Dispatch revision is stale", receipt };
  }
  if (validation.source === "slot" && result.connectionId !== validation.connectionId) {
    return { kind: "security", code: "DISPATCH_CONNECTION_MISMATCH", message: "Dispatch connection does not match the requested slot", receipt };
  }
  if (validation.source === "main" && result.connectionId !== parent.main.descriptor.connectionId) {
    return { kind: "security", code: "DISPATCH_MAIN_MISMATCH", message: "Main dispatch does not match the parent route", receipt };
  }
  if (!descriptorIsConcrete(result.descriptor) || result.descriptor.connectionId !== result.connectionId || result.descriptor.connectionDispatchRevision !== validation.expectedRevision) {
    return { kind: "security", code: "DISPATCH_DESCRIPTOR_INVALID", message: "Dispatch descriptor is not concrete or is stale", receipt };
  }
  const resolvedReceipt = {
    source: result.source,
    connectionId: result.connectionId,
    connectionDispatchRevision: result.dispatchRevision,
  } as const;
  return { resolution: result, receipt: resolvedReceipt };
}

function makeReceipt(seed: DispatchReceiptSeed, providerInvoked: boolean, terminalResponse: boolean, usage?: QuietDispatchReceiptDTO["usage"]): QuietDispatchReceiptDTO {
  return deepFreeze({
    providerInvoked,
    terminalResponse,
    source: seed.source,
    connectionId: seed.connectionId,
    connectionDispatchRevision: seed.connectionDispatchRevision,
    ...(usage === undefined ? {} : { usage }),
  }) as QuietDispatchReceiptDTO;
}

function quietPreflight(kind: "precondition" | "security", code: string, name: string, message: string): QuietTrackedResultDTO {
  return deepFreeze({
    ok: false as const,
    phase: "preflight" as const,
    providerInvoked: false as const,
    receipt: null,
    error: { kind, code, name, message: errorText(message) },
  }) as QuietTrackedResultDTO;
}

function quietResolvedFailure(seed: DispatchReceiptSeed, providerInvoked: boolean, terminalResponse: boolean, kind: "precondition" | "provider" | "abort" | "security" | "internal", code: string, name: string, message: string, usage?: QuietDispatchReceiptDTO["usage"]): QuietTrackedResultDTO {
  return deepFreeze({
    ok: false as const,
    phase: "resolved" as const,
    receipt: makeReceipt(seed, providerInvoked, terminalResponse, usage),
    error: { kind, code, name, message: errorText(message) },
  }) as QuietTrackedResultDTO;
}

function isProviderResult(value: unknown): value is BoundDispatchProviderResult {
  return isRecord(value) && isRecord(value.response) && typeof value.response.content === "string" && typeof value.response.finish_reason === "string" && typeof value.terminalResponse === "boolean";
}

function cloneProviderResponse(response: GenerationResponse): GenerationResponse {
  if (!isRecord(response) || typeof response.content !== "string" || typeof response.finish_reason !== "string") throw new TypeError("Provider response is invalid");
  return cloneAndFreeze(response, BOUND_MAX_CARRIER_BYTES) as GenerationResponse;
}

function sanitizeReceiptUsage(usage: GenerationUsage | undefined): QuietDispatchReceiptDTO["usage"] | undefined {
  const normalized = normalizeUsage(usage);
  if (!normalized) return undefined;
  if (!normalized.provider_raw) return normalized as QuietDispatchReceiptDTO["usage"];
  const scrub = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrub);
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/(api[_-]?key|secret|authorization|password|credential|access[_-]?token|refresh[_-]?token)/i.test(key)) continue;
      out[key] = scrub(entry);
    }
    return out;
  };
  return deepFreeze({ ...normalized, provider_raw: scrub(normalized.provider_raw) }) as QuietDispatchReceiptDTO["usage"];
}

function parentRetrievalUsable(parent: ParentGenerationSnapshot, now: number): BoundAssemblyOutcomeDTO | null {
  const retrieval = parent.retrieval;
  if (!retrieval || retrieval.kind !== "parent-retrieval") return assemblyFailure("precondition", "ASSEMBLY_RETRIEVAL_SNAPSHOT_UNAVAILABLE", "retrieval snapshot is unavailable");
  if (!Number.isFinite(retrieval.bytes) || retrieval.bytes < 0 || retrieval.bytes > BOUND_MAX_RETRIEVAL_BYTES) return assemblyFailure("precondition", "ASSEMBLY_RETRIEVAL_SNAPSHOT_UNAVAILABLE", "retrieval snapshot is oversize");
  if (retrieval.hostGeneration !== parent.hostGeneration || retrieval.generationId !== parent.generationId || retrieval.userId !== parent.userId || retrieval.chatId !== parent.chatId) return assemblyFailure("security", "ASSEMBLY_RETRIEVAL_SCOPE_MISMATCH", "retrieval snapshot scope does not match the parent");
  if (retrieval.expiresAt <= now) return { ok: false, error: { kind: "retrieval_snapshot", code: "ASSEMBLY_RETRIEVAL_SNAPSHOT_UNAVAILABLE", reason: "expired", message: "retrieval snapshot has expired" } };
  return null;
}

function assertContext(context: BoundInvocationContext): void {
  if (!isRecord(context) || !isRecord(context.parent)) throw new HostContainmentFatal({ code: "BOUND_HOST_CONTRADICTION", message: "Bound invocation context is missing its host parent", hostGeneration: brandHostGenerationId("unknown"), workerId: "unknown", requestId: "unknown" });
  assertParentSnapshotShape(context.parent);
  if (context.callbackUserId !== context.parent.userId) throw new HostContainmentFatal({ code: "BOUND_HOST_CONTRADICTION", message: "Bound callback user scope contradicts its parent", hostGeneration: context.parent.hostGeneration, workerId: context.workerId, requestId: context.requestId });
  if (context.hostGeneration !== context.parent.hostGeneration) throw new HostContainmentFatal({ code: "BOUND_HOST_CONTRADICTION", message: "Bound callback generation contradicts its parent", hostGeneration: context.parent.hostGeneration, workerId: context.workerId, requestId: context.requestId });
  requireText(context.workerId, "workerId");
  requireText(context.registrationGeneration, "registrationGeneration");
  requireText(context.requestId, "requestId");
  requireText(context.invocationToken, "invocationToken");
}

interface ComposedSignal {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
}

function composeSignal(parentSignal: AbortSignal | undefined, requestSignal: AbortSignal | undefined, deadlineAt: number, now: number): ComposedSignal {
  const controller = new AbortController();
  const sources = [parentSignal, requestSignal].filter((signal): signal is AbortSignal => signal !== undefined);
  const abortFrom = (source: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort((source as AbortSignal & { reason?: unknown }).reason);
  };
  const listeners: Array<() => void> = [];
  for (const source of sources) {
    const listener = (): void => abortFrom(source);
    if (source.aborted) abortFrom(source);
    else {
      source.addEventListener("abort", listener, { once: true });
      listeners.push(() => source.removeEventListener("abort", listener));
    }
  }
  const remaining = deadlineAt - now;
  const timer = remaining > 0 ? setTimeout(() => controller.abort(new DOMException("Bound deadline exceeded", "AbortError")), remaining) : undefined;
  return {
    signal: controller.signal,
    dispose: () => {
      for (const dispose of listeners) dispose();
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function deadlineFailure(deadline: ReturnType<typeof validateBoundDeadline>): QuietTrackedResultDTO | null {
  return deadline.ok ? null : quietPreflight("precondition", deadline.code, deadline.code === "DEADLINE_EXPIRED" ? "AbortError" : "RangeError", deadline.message);
}

export async function runBoundAssembly(input: BoundAssemblyExecution): Promise<BoundAssemblyOutcomeDTO> {
  assertContext(input.context);
  const now = nowOf(input.now);
  const request = input.request;
  if (!isRecord(request)) return assemblyFailure("security", "ASSEMBLY_REQUEST_INVALID", "assembly request is invalid");
  let blocks: readonly BoundPromptBlockDTO[];
  try {
    blocks = clonePromptBlocks(request.blocks);
    clonePromptVariables(request.promptVariableValues);
  } catch (error) {
    return assemblyFailure("precondition", "ASSEMBLY_INPUT_INVALID", errorText(error));
  }
  const dispatch = validateDispatchSource(request.dispatch);
  if ("kind" in dispatch) return assemblyFailure(dispatch.kind, dispatch.code, dispatch.message);
  const deadline = validateBoundDeadline(request.deadlineAt, now, input.context.parent.boundWorkDeadlineAt);
  if (!deadline.ok) return assemblyFailure("precondition", deadline.code, deadline.message);
  if (isAbortSignalAborted(request.signal) || isAbortSignalAborted(input.context.signal)) return assemblyAbort();
  const resolved = await resolveDispatch(input.context.parent, request.dispatch, input.resolveDispatch);
  if ("kind" in resolved) return assemblyFailure(resolved.kind, resolved.code, resolved.message);
  const unusable = parentRetrievalUsable(input.context.parent, now);
  if (unusable) return unusable;
  const composed = composeSignal(input.context.signal, request.signal, request.deadlineAt, now);
  try {
    if (composed.signal.aborted) return assemblyAbort();
    const assembled = await input.assemble({
      snapshot: input.context.parent,
      blocks,
      promptVariableValues: clonePromptVariables(request.promptVariableValues),
      signal: composed.signal,
      hookFailureMode: request.hookFailureMode ?? "degrade",
      macroFailureMode: request.macroFailureMode ?? "degrade",
    });
    if (composed.signal.aborted) return assemblyAbort();
    const result = {
      messages: [...assembled.messages],
      breakdown: [...assembled.breakdown],
      resolved: {
        source: resolved.resolution.source,
        connectionId: resolved.resolution.connectionId,
        connectionDispatchRevision: resolved.resolution.dispatchRevision,
        dispatchKind: "concrete" as const,
      },
    } satisfies BoundAssemblySuccessDTO;
    return deepFreeze({ ok: true as const, result }) as BoundAssemblyOutcomeDTO;
  } catch (error) {
    if (isHostContainmentFatal(error)) throw error;
    if (composed.signal.aborted || isAbortError(error)) return assemblyAbort();
    if (isRecord(error) && typeof error.code === "string" && typeof error.message === "string") {
      return { ok: false, error: error as BoundAssemblyFailureDTO };
    }
    return assemblyFailure("internal", "ASSEMBLY_FAILED", errorText(error));
  } finally {
    composed.dispose();
  }
}

function validatePrefillChild(parent: ParentGenerationSnapshot, request: QuietTrackedRequestDTO, child: BoundPrefillChildOptions | undefined, requestId: string): { ok: true; child?: ParentPrefillChildUse } | { ok: false; code: string; message: string } {
  const continuation = request.continuation;
  if (continuation === undefined) return { ok: true };
  if (!isRecord(continuation) || continuation.mode !== "append-parent-carrier-last" || !isRecord(continuation.parentPrefill)) return { ok: false, code: "PREFILL_ATTACHMENT_INVALID", message: "continuation attachment is invalid" };
  if (!child?.childUse) return { ok: false, code: "PREFILL_CHILD_REQUIRED", message: "a host-minted prefill child is required" };
  if (!consumeParentPrefillAttestation(parent, continuation.parentPrefill, child.childUse.parentPrefillAttestation)) return { ok: false, code: "PREFILL_ATTESTATION_INVALID", message: "parent prefill attestation is invalid" };
  try {
    inspectParentPrefillChild(child.childUse, requestId, "thread-continuation");
  } catch (error) {
    return { ok: false, code: "PREFILL_CHILD_ALREADY_USED", message: errorText(error) };
  }
  return { ok: true, child: child.childUse };
}

export async function runBoundQuietTracked(input: BoundQuietExecution): Promise<QuietTrackedResultDTO> {
  assertContext(input.context);
  const now = nowOf(input.now);
  const request = input.request;
  if (!isRecord(request)) return quietPreflight("security", "QUIET_REQUEST_INVALID", "TypeError", "quiet request is invalid");
  let messages: readonly LlmMessage[];
  let parameters: Readonly<Record<string, unknown>>;
  let reasoning: Readonly<Record<string, unknown>>;
  let tools: readonly ToolDefinition[];
  try {
    messages = cloneMessages(request.messages, "quiet messages");
    parameters = cloneAndFreeze(request.parameters ?? input.context.parent.main.parameters, BOUND_MAX_CARRIER_BYTES) as Readonly<Record<string, unknown>>;
    reasoning = cloneAndFreeze(request.reasoning ?? input.context.parent.main.reasoning, BOUND_MAX_CARRIER_BYTES) as Readonly<Record<string, unknown>>;
    tools = cloneTools(request.tools);
  } catch (error) {
    return quietPreflight("precondition", "QUIET_INPUT_INVALID", "TypeError", errorText(error));
  }
  const source = validateDispatchSource(request.dispatch);
  if ("kind" in source) return quietPreflight(source.kind, source.code, "DispatchError", source.message);
  const deadline = validateBoundDeadline(request.deadlineAt, now, input.context.parent.boundWorkDeadlineAt);
  const deadlineResult = deadlineFailure(deadline);
  if (deadlineResult) return deadlineResult;
  if (isAbortSignalAborted(request.signal) || isAbortSignalAborted(input.context.signal)) return quietPreflight("precondition", "BOUND_ABORTED", "AbortError", "Bound quiet dispatch was aborted");
  const prefill = validatePrefillChild(input.context.parent, request, input.child, input.context.requestId);
  if (!prefill.ok) return quietPreflight("security", prefill.code, "PrefillError", prefill.message);
  const resolved = await resolveDispatch(input.context.parent, request.dispatch, input.resolveDispatch);
  if ("kind" in resolved) return quietResolvedFailure(seedForSource(input.context.parent, source), false, false, resolved.kind, resolved.code, "DispatchError", resolved.message);
  const composed = composeSignal(input.context.signal, request.signal, request.deadlineAt, now);
  let providerInvoked = false;
  try {
    if (composed.signal.aborted) return quietResolvedFailure(resolved.receipt, false, false, "abort", "BOUND_ABORTED", "AbortError", "Bound quiet dispatch was aborted");
    let outboundMessages = messages;
    if (prefill.child) {
      const carrier = attachBoundParentPrefill(prefill.child, input.context.requestId, "thread-continuation");
      outboundMessages = cloneMessages([...messages, ...carrier], "quiet continuation messages");
    }
    if (composed.signal.aborted) return quietResolvedFailure(resolved.receipt, false, false, "abort", "BOUND_ABORTED", "AbortError", "Bound quiet dispatch was aborted");
    providerInvoked = true;
    const result = await input.provider({
      resolution: resolved.resolution,
      messages: outboundMessages,
      parameters,
      reasoning,
      tools,
      signal: composed.signal,
      ...(prefill.child ? { parentPrefill: input.context.parent.parentPrefillCarrier } : {}),
    });
    if (composed.signal.aborted) return quietResolvedFailure(resolved.receipt, providerInvoked, false, "abort", "BOUND_ABORTED", "AbortError", "Bound quiet dispatch was aborted");
    if (!isProviderResult(result)) return quietResolvedFailure(resolved.receipt, providerInvoked, false, "internal", "PROVIDER_RESULT_INVALID", "ProviderResultError", "Provider result is invalid");
    const response = cloneProviderResponse(result.response);
    const usage = sanitizeReceiptUsage(result.usage ?? response.usage);
    const receipt = makeReceipt(resolved.receipt, true, result.terminalResponse, usage);
    return deepFreeze({
      ok: true as const,
      response: response as unknown as GenerationResponseDTO,
      receipt,
    }) as QuietTrackedResultDTO;
  } catch (error) {
    if (isHostContainmentFatal(error)) throw error;
    if (error instanceof BoundProviderPreflightError) {
      return quietResolvedFailure(resolved.receipt, false, false, "precondition", "PROVIDER_PREFLIGHT_FAILED", "ProviderPreflightError", errorText(error));
    }
    if (composed.signal.aborted || isAbortError(error)) return quietResolvedFailure(resolved.receipt, providerInvoked, false, "abort", "BOUND_ABORTED", "AbortError", errorText(error));
    return quietResolvedFailure(resolved.receipt, providerInvoked, false, "provider", "PROVIDER_FAILED", "ProviderError", errorText(error));
  } finally {
    composed.dispose();
  }
}

export function createBoundGenerationBinding(input: BoundGenerationCallbacks & { readonly context: BoundInvocationContext }): BoundGenerationBinding {
  assertContext(input.context);
  if (typeof input.resolveDispatch !== "function" || typeof input.assemble !== "function" || typeof input.provider !== "function") throw new TypeError("Bound generation callbacks are incomplete");
  const binding: BoundGenerationBinding = {
    context: input.context,
    assemble: (request) => runBoundAssembly({ context: input.context, request, resolveDispatch: input.resolveDispatch, assemble: input.assemble, now: input.now }),
    quietTracked: (request, child) => runBoundQuietTracked({ context: input.context, request, child, resolveDispatch: input.resolveDispatch, provider: input.provider, now: input.now }),
  };
  return Object.freeze(binding);
}

export function createReadOnlyEffectLease(context: ReadOnlyEffectLeaseContext, allowedOperations: readonly string[] = []): BoundEffectLease {
  if (!isRecord(context)) throw new TypeError("read-only effect lease context is required");
  let active = true;
  const allowed = new Set(allowedOperations);
  const lease: BoundEffectLease = {
    context,
    assertAllowed(operation: string): void {
      requireText(operation, "operation");
      if (!active) throw new BoundEffectDeniedError(operation);
      if (operation === "cancel_generation" || operation === "cancel" || operation.startsWith("local:") || operation.startsWith("read:") || allowed.has(operation)) return;
      throw new BoundEffectDeniedError(operation);
    },
    deny(operation: string): never {
      throw new BoundEffectDeniedError(requireText(operation, "operation"));
    },
    isActive(): boolean {
      return active;
    },
    release(): void {
      active = false;
    },
  };
  return Object.freeze(lease);
}

export function denyBoundEffect(lease: BoundEffectLease, operation: string): never {
  return lease.deny(operation);
}

export function createBoundHostContainmentFatal(input: ConstructorParameters<typeof HostContainmentFatal>[0]): HostContainmentFatal {
  return new HostContainmentFatal(input);
}

export function throwBoundHostContainmentFatal(input: ConstructorParameters<typeof HostContainmentFatal>[0]): never {
  throw createBoundHostContainmentFatal(input);
}

export { isHostContainmentFatal };
