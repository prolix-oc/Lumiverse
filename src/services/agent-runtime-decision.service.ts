import { compareUtf8 } from "../utils/utf8-order";
import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../db/connection";
import * as chatsSvc from "./chats.service";
import * as connectionsSvc from "./connections.service";
import * as personasSvc from "./personas.service";
import * as presetProfilesSvc from "./preset-profiles.service";
import * as presetsSvc from "./presets.service";
import * as councilProfilesSvc from "./council/council-profiles.service";
import type { ResolvedCouncilProfile } from "../types/council-profile";
import type {
  AgenticReadinessVectorV1,
  AgentRuntimeCapabilityRequirement,
  AgentRuntimeMode,
  AgentRuntimeRepairCode,
  ChatAgentModeOverrideV1,
  ChatAgentModeWriteResponseV1,
  EffectiveRuntimeDecisionV1,
  EffectiveRuntimePublicResponseV1,
  EffectiveRuntimeRequestV1,
  FrozenConcreteConnectionV1,
  GenerationTargetV1,
  InputRevisionSetV1,
  LoomRuntimePolicyAvailabilityV1,
  LoomRuntimePolicyCapV1,
  LoomRuntimePolicyDurableChatOverrideV1,
  LoomRuntimePolicyRepairAcknowledgementV1,
  LoomRuntimePolicySourceV1,
  LoomRuntimePolicyTransientSelectionV1,
  LoomRuntimePolicyV1,
  RuntimeDecisionBindingV1,
  RuntimeDecisionInternalV1,
  RuntimeDecisionRefreshMismatchV1,
  RuntimeDecisionTokenConsumptionV1,
  RuntimeRevision,
  SafeConnectionProjectionV1,
  SafePresetProjectionV1,
} from "../types/agent-runtime-decision";
import {
  isAgenticGenerationType,
  AGENT_RUNTIME_CAPABILITY_REQUIREMENTS,
  AGENT_RUNTIME_REPAIR_CODES,
  AGENT_RUNTIME_DECISION_TOKEN_TTL_MS,
  AGENT_RUNTIME_DECISION_MAX_LIVE_PER_USER,
  AGENT_RUNTIME_DECISION_MAX_LIVE_PROCESS,
  AGENT_RUNTIME_DECISION_VERSION,
  isAgentRuntimeMode,
} from "../types/agent-runtime-decision";
import type { AgentConfigV2, AgentRuntimePolicyV1 } from "../types/agents";
import type { LoomPromptInspectionV1, LoomResponsePolicyOmissionV1 } from "../types/agent-cognition";
import { parseAgentConfigV2, parseAgentRuntimePolicyV1 } from "../types/agents";
import { LOOM_POLICY_VERSION } from "../types/agent-cognition";
import { isTemporaryChatMetadata } from "../types/chat";
import { inspectLoomPromptPolicies } from "./agent-cognition.service";
import {
  canonicalizeAgenticReadinessVectorV1,
  hashAgenticReadinessVectorV1,
} from "./agent-cognition-integrity.service";
import { getPresetAgentResponseCognitionSourceV1 } from "./agent-config-portability.service";
import { validateAgentConfigForExecution } from "./agent-runtime-limits";
const INPUT_REVISION_KEYS: readonly (keyof InputRevisionSetV1)[] = [
  "target",
  "chat",
  "message",
  "preset",
  "block",
  "config",
  "binding",
  "connection",
  "endpoint",
  "credential",
  "persona",
  "character",
  "group",
  "world",
  "lore",
  "settings",
  "macro",
  "regex",
  "cognition",
  "readiness",
];

const REQUIRED_AGENTIC_CAPABILITIES: readonly AgentRuntimeCapabilityRequirement[] = [
  "generation",
  "streaming",
  "tool_calling",
  "native_tool_continuation",
  "tools_disabled_finalization",
];

const AGENT_RUNTIME_RESPONSE_ESCAPE = "available" as const;
const DEFAULT_REVISION: RuntimeRevision = 0;
const DEFAULT_READINESS_EPOCH: RuntimeRevision = 0;
const SAFE_STRING_MAX = 512;

export type RuntimeDecisionErrorCode =
  | "not_found"
  | "invalid_request"
  | "decision_refresh_required"
  | "decision_capacity_exceeded"
  | "runtime_policy_invalid"
  | "runtime_policy_unavailable"
  | "runtime_policy_authority_widening"
  | "active_turn_immutable"
  | "chat_mode_revision_conflict";

export class RuntimeDecisionError extends Error {
  readonly code: RuntimeDecisionErrorCode;
  readonly status: number;
  readonly repairCode: AgentRuntimeRepairCode | null;
  readonly details: Readonly<Record<string, unknown>> | null;

  constructor(
    code: RuntimeDecisionErrorCode,
    message: string,
    status = 400,
    repairCode: AgentRuntimeRepairCode | null = null,
    details: Readonly<Record<string, unknown>> | null = null,
  ) {
    super(message);
    this.name = "RuntimeDecisionError";
    this.code = code;
    this.status = status;
    this.repairCode = repairCode;
    this.details = details;
  }
}
export interface RuntimeRepairAcknowledgementV1 extends LoomRuntimePolicyRepairAcknowledgementV1 {
  presetId: string;
  revision: number;
  scope: "repair/review";
}

function sameRuntimeRevision(left: RuntimeRevision | null, right: RuntimeRevision | null): boolean {
  return left !== null && right !== null && (left === right || String(left) === String(right));
}

function normalizeRepairReason(value: unknown, fallback: string | null): string | null {
  const reason = safeString(value, null) ?? fallback;
  return reason && reason.length <= SAFE_STRING_MAX ? reason : null;
}

function normalizeDbNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

const RUNTIME_REPAIR_ACK_TABLE = "agent_runtime_repair_acknowledgements";


interface PersistedRuntimeRepairAcknowledgement {
  revision: number;
  acknowledgedAt: number;
}

function readPersistedRuntimeRepairAcknowledgement(
  userId: string,
  presetId: string,
  presetRevision: RuntimeRevision,
  reasonCode: string,
): PersistedRuntimeRepairAcknowledgement | null {
  try {
    const row = getDb().query(
      `SELECT revision, acknowledged_at
       FROM ${RUNTIME_REPAIR_ACK_TABLE}
       WHERE user_id = ? AND preset_id = ? AND preset_revision = ? AND reason_code = ?`,
    ).get(userId, presetId, String(presetRevision), reasonCode) as { revision?: unknown; acknowledged_at?: unknown } | null;
    const revision = normalizeDbNonNegativeInteger(row?.revision);
    const acknowledgedAt = normalizeDbNonNegativeInteger(row?.acknowledged_at);
    if (revision === null || acknowledgedAt === null) return null;
    return { revision, acknowledgedAt };
  } catch {
    return null;
  }
}

function persistRuntimeRepairAcknowledgement(
  userId: string,
  presetId: string,
  presetRevision: RuntimeRevision,
  reasonCode: string,
  acknowledgedAt: number,
): PersistedRuntimeRepairAcknowledgement | null {
  const normalizedAcknowledgedAt = normalizeDbNonNegativeInteger(acknowledgedAt);
  if (normalizedAcknowledgedAt === null) return null;
  try {
    const db = getDb();
    const current = db.query(
      `SELECT revision
       FROM ${RUNTIME_REPAIR_ACK_TABLE}
       WHERE user_id = ? AND preset_id = ? AND preset_revision = ? AND reason_code = ?`,
    ).get(userId, presetId, String(presetRevision), reasonCode) as { revision?: unknown } | null;
    const currentRevision = normalizeDbNonNegativeInteger(current?.revision);
    const revision = currentRevision ?? 1;
    db.query(
      `INSERT INTO ${RUNTIME_REPAIR_ACK_TABLE}
         (user_id, preset_id, preset_revision, reason_code, revision, acknowledged_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, preset_id, preset_revision, reason_code)
       DO UPDATE SET revision = excluded.revision, acknowledged_at = excluded.acknowledged_at`,
    ).run(userId, presetId, String(presetRevision), reasonCode, revision, normalizedAcknowledgedAt);
    return { revision, acknowledgedAt: normalizedAcknowledgedAt };
  } catch {
    return null;
  }
}

export class DecisionTokenCapacityError extends Error {
  constructor() {
    super("Runtime decision capacity is temporarily exhausted.");
    this.name = "DecisionTokenCapacityError";
  }
}

interface StoredDecisionToken {
  tokenHash: string;
  userId: string;
  decision: RuntimeDecisionInternalV1;
  request: EffectiveRuntimeRequestV1;
}

export interface RuntimeDecisionTokenStoreLimits {
  maxPerUser?: number;
  maxProcess?: number;
  ttlMs?: number;
}

/**
 * Process-local opaque token storage. Tokens are one-use: consume removes the
 * entry before any binding check, including checks that fail for another user.
 */
export class RuntimeDecisionTokenStore {
  private readonly byHash = new Map<string, StoredDecisionToken>();
  private readonly byUser = new Map<string, Set<string>>();
  private readonly maxPerUser: number;
  private readonly maxProcess: number;
  readonly ttlMs: number;

  constructor(
    private readonly now: () => number = Date.now,
    limits: RuntimeDecisionTokenStoreLimits = {},
  ) {
    this.maxPerUser = limits.maxPerUser ?? AGENT_RUNTIME_DECISION_MAX_LIVE_PER_USER;
    this.maxProcess = limits.maxProcess ?? AGENT_RUNTIME_DECISION_MAX_LIVE_PROCESS;
    this.ttlMs = limits.ttlMs ?? AGENT_RUNTIME_DECISION_TOKEN_TTL_MS;
  }

  issue(userId: string, decision: RuntimeDecisionInternalV1, request: EffectiveRuntimeRequestV1): { token: string; expiresAt: number } {
    const now = this.now();
    this.purgeExpired(now);
    const userTokens = this.byUser.get(userId);
    if ((userTokens?.size ?? 0) >= this.maxPerUser || this.byHash.size >= this.maxProcess) {
      throw new DecisionTokenCapacityError();
    }

    const token = `lvrd_${randomBytes(32).toString("base64url")}`;
    const tokenHash = hashToken(token);
    const expiresAt = now + this.ttlMs;
    const stored: StoredDecisionToken = {
      tokenHash,
      userId,
      decision: { ...decision, issuedAt: now, expiresAt },
      request: structuredClone(request),
    };
    this.byHash.set(tokenHash, stored);
    const nextUserTokens = userTokens ?? new Set<string>();
    nextUserTokens.add(tokenHash);
    this.byUser.set(userId, nextUserTokens);
    return { token, expiresAt };
  }

  consume(userId: string, token: string): StoredDecisionToken | null {
    const now = this.now();
    this.purgeExpired(now);
    if (!isOpaqueDecisionToken(token)) return null;
    const tokenHash = hashToken(token);
    const stored = this.byHash.get(tokenHash);
    if (!stored) return null;

    // Delete before comparing ownership or any other binding. A replay and a
    // cross-user guess therefore have exactly the same one-use semantics.
    this.byHash.delete(tokenHash);
    const userTokens = this.byUser.get(stored.userId);
    userTokens?.delete(tokenHash);
    if (userTokens && userTokens.size === 0) this.byUser.delete(stored.userId);
    if (stored.userId !== userId || stored.decision.expiresAt <= now) return null;
    return stored;
  }

  purgeExpired(now = this.now()): number {
    let removed = 0;
    for (const [tokenHash, stored] of this.byHash) {
      if (stored.decision.expiresAt > now) continue;
      this.byHash.delete(tokenHash);
      const userTokens = this.byUser.get(stored.userId);
      userTokens?.delete(tokenHash);
      if (userTokens && userTokens.size === 0) this.byUser.delete(stored.userId);
      removed++;
    }
    return removed;
  }

  clear(): void {
    this.byHash.clear();
    this.byUser.clear();
  }

  get liveCount(): number {
    return this.byHash.size;
  }

  getLiveCountForUser(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0;
  }
}

interface AgentConfigSlotView {
  id: string;
  label: string;
  requiredCapabilities: AgentRuntimeCapabilityRequirement[];
}

interface AgentConfigProfileView {
  id: string;
  connectionRef: { kind: "inherit_main" } | { kind: "slot"; slotId: string };
}

interface AgentConfigView {
  version: 2;
  agentsEnabled: boolean;
  allowedModes: AgentRuntimeMode[];
  defaultMode: AgentRuntimeMode;
  maxInvocations: number;
  maxToolCalls: number;
  profiles: AgentConfigProfileView[];
  connectionSlots: AgentConfigSlotView[];
  runtimePolicy: AgentRuntimePolicyV1 | null;
  revision: RuntimeRevision | null;
  bindingRevision: RuntimeRevision | null;
  state: "ready" | "review_required" | "repair_required";
  reviewCode: string | null;
  reviewAcknowledged: boolean;
}

interface AgentRuntimeChatView {
  id: string;
  character_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface AgentRuntimePresetView {
  id: string;
  name?: string;
  cache_revision?: number;
  agent_config?: unknown;
}

export type RuntimeCouncilProfileView = ResolvedCouncilProfile;

export interface RuntimeDecisionDependencies {
  getChat: (userId: string, chatId: string) => AgentRuntimeChatView | null;
  getPreset: (userId: string, presetId: string) => AgentRuntimePresetView | null;
  resolveProfile: (
    userId: string,
    fallbackPresetId: string | null,
    chatId: string,
    characterId: string | null,
    options: { isGroup?: boolean; connectionId?: string | null; personaId?: string | null },
  ) => { preset_id: string | null; binding?: unknown; source?: string; source_id?: string | null };
  resolveCouncilProfile: (
    userId: string,
    chatId: string,
    characterId: string | null,
    options: { isGroup?: boolean },
  ) => RuntimeCouncilProfileView;
  resolvePersona: (userId: string, personaId?: string | null) => { id?: string } | null;
  resolveConcreteConnection: (
    userId: string,
    logicalId?: string | null,
    expectedConcreteId?: string | null,
  ) => Promise<unknown>;
  getPresetAgentConfig?: (userId: string, presetId: string) => unknown;
  getChatAgentModeOverride: (userId: string, chatId: string) => ChatAgentModeOverrideV1 | null;
  setChatAgentModeOverride: (
    userId: string,
    chatId: string,
    mode: AgentRuntimeMode | null,
    expectedRevision?: number,
  ) => ChatAgentModeWriteResponseV1;
  getInputRevisions?: (
    userId: string,
    request: EffectiveRuntimeRequestV1,
    context: {
      chat: AgentRuntimeChatView;
      target: GenerationTargetV1;
      requestedMode: AgentRuntimeMode;
      rootConnection?: FrozenConcreteConnectionV1 | null;
      childConnections?: Readonly<Record<string, FrozenConcreteConnectionV1>>;
      preset?: AgentRuntimePresetView | null;
      config?: unknown;
    },
  ) => Partial<InputRevisionSetV1> | null;
  getReadinessVector?: (
    userId: string,
    request: EffectiveRuntimeRequestV1,
    context: {
      configRevision: RuntimeRevision | null;
      bindingRevision: RuntimeRevision | null;
      inputRevisionDigest: string;
      inputRevisionsComplete: boolean;
      requestedMode: AgentRuntimeMode;
      rootConnection?: FrozenConcreteConnectionV1 | null;
      childConnections?: Readonly<Record<string, FrozenConcreteConnectionV1>>;
      target?: GenerationTargetV1;
      config?: unknown;
    },
  ) => Partial<AgenticReadinessVectorV1> | null;
}

export interface AgentRuntimeDecisionServiceOptions {
  dependencies?: Partial<RuntimeDecisionDependencies>;
  now?: () => number;
  tokenStore?: RuntimeDecisionTokenStore;
}

interface InternalResolutionContext {
  request: EffectiveRuntimeRequestV1;
  chat: AgentRuntimeChatView;
  target: GenerationTargetV1;
  rootConnection: FrozenConcreteConnectionV1 | null;
  childConnections: Record<string, FrozenConcreteConnectionV1>;
  councilProfile: ResolvedCouncilProfile;
  councilConnection: FrozenConcreteConnectionV1 | null;
  config: AgentConfigView | null;
  preset: AgentRuntimePresetView | null;
  presetSource: SafePresetProjectionV1["source"];
  chatOverride: ChatAgentModeOverrideV1 | null;
  inputRevisionDigest: string;
  inputRevisionsComplete: boolean;
  readinessVector: AgenticReadinessVectorV1;
  readinessDigest: string;
  capabilityReadiness: {
    ready: boolean;
    sameDomain: boolean;
    required: AgentRuntimeCapabilityRequirement[];
    missing: AgentRuntimeCapabilityRequirement[];
    repairCodes: AgentRuntimeRepairCode[];
  };
  repairCodes: AgentRuntimeRepairCode[];
  runtimePolicy: LoomRuntimePolicyV1;
  requestedMode: AgentRuntimeMode;
  effectiveMode: AgentRuntimeMode;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

/** Canonical digest used to bind provider capability semantics to a turn. */
export function canonicalRuntimeCapabilityDigest(
  capabilities: Readonly<Record<string, unknown>>,
): string {
  return hashCanonical(capabilities);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeString(value: unknown, fallback: string | null = null): string | null {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > SAFE_STRING_MAX) return fallback;
  return trimmed;
}

function safeRevision(value: unknown): RuntimeRevision | null {
  if (typeof value === "string") {
    if (value.length === 0 || value.length > SAFE_STRING_MAX) return null;
    if (/^[+-]?\d+$/.test(value)) {
      const numeric = Number(value);
      if (!Number.isSafeInteger(numeric) || numeric < 0) return null;
    }
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  return null;
}

function uniqueOrderedModes(value: unknown): AgentRuntimeMode[] {
  const modes: AgentRuntimeMode[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isAgentRuntimeMode(item) || modes.includes(item)) continue;
      modes.push(item);
    }
  }
  if (!modes.includes("response")) modes.unshift("response");
  return modes;
}

function normalizeRequirements(value: unknown): AgentRuntimeCapabilityRequirement[] {
  const requirements: AgentRuntimeCapabilityRequirement[] = [];
  if (!Array.isArray(value)) return requirements;
  for (const item of value) {
    if (typeof item !== "string") continue;
    if (!(AGENT_RUNTIME_CAPABILITY_REQUIREMENTS as readonly string[]).includes(item)) continue;
    const requirement = item as AgentRuntimeCapabilityRequirement;
    if (!requirements.includes(requirement)) requirements.push(requirement);
  }
  return requirements.sort(compareUtf8);
}
const HOST_REASON_MASKS: ReadonlySet<string> = new Set([
  "loom_policy_unavailable",
  "agentic_response_escape",
]);

function isRuntimeRepairCode(value: string): value is AgentRuntimeRepairCode {
  return (AGENT_RUNTIME_REPAIR_CODES as readonly string[]).includes(value);
}

function firstConcreteHostReason(
  readinessReasons: readonly string[],
  repairCodes: readonly string[],
): AgentRuntimeRepairCode {
  for (const reason of readinessReasons) {
    if (isRuntimeRepairCode(reason) && !HOST_REASON_MASKS.has(reason)) return reason;
  }
  for (const code of repairCodes) {
    if (isRuntimeRepairCode(code) && !HOST_REASON_MASKS.has(code)) return code;
  }
  return "agentic_readiness_unavailable";
}

export interface LoomRuntimePolicyResolutionInputV1 {
  transientSelection?: LoomRuntimePolicyTransientSelectionV1 | null;
  durableChatOverride?: LoomRuntimePolicyDurableChatOverrideV1 | null;
  presetDefault?: AgentRuntimeMode | null;
  presetRevision?: RuntimeRevision | null;
  presetState?: "ready" | "review_required" | "repair_required";
  presetRepairCode?: AgentRuntimeRepairCode | null;
  hostAllowedModes?: readonly AgentRuntimeMode[];
  hostAvailability?: LoomRuntimePolicyAvailabilityV1["state"];
  hostReasonCode?: AgentRuntimeRepairCode | null;
  repairAcknowledgement?: LoomRuntimePolicyRepairAcknowledgementV1;
}

function freezePolicy<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      if (child && typeof child === "object" && !Object.isFrozen(child)) freezePolicy(child);
    }
  }
  return value;
}

export function resolveLoomRuntimePolicy(
  input: LoomRuntimePolicyResolutionInputV1,
): LoomRuntimePolicyV1 {
  const transientSelection = input.transientSelection ?? null;
  const durableChatOverride = input.durableChatOverride ?? null;
  const allowedModes = [...new Set(
    (input.hostAllowedModes ?? ["response", "agentic"])
      .filter((mode): mode is AgentRuntimeMode => isAgentRuntimeMode(mode)),
  )];
  const cap: LoomRuntimePolicyCapV1 = {
    authority: "host",
    allowedModes,
    reasonCode: input.hostReasonCode ?? null,
  };
  const hostAvailability = input.hostAvailability ?? "available";
  const presetState = input.presetState ?? "ready";
  const presetDefault = isAgentRuntimeMode(input.presetDefault) ? input.presetDefault : null;
  let authoredValue: AgentRuntimeMode = "response";
  let source: LoomRuntimePolicySourceV1 = "response_fallback";
  let scope: LoomRuntimePolicyV1["scope"] = "fallback";
  let availability: LoomRuntimePolicyAvailabilityV1 = {
    state: "available",
    reasonCode: null,
  };

  if (transientSelection && transientSelection.authenticated === true) {
    authoredValue = transientSelection.mode;
    source = "authenticated_one_turn";
    scope = "turn";
  } else if (
    durableChatOverride
    && durableChatOverride.state === "ready"
    && durableChatOverride.mode !== null
  ) {
    authoredValue = durableChatOverride.mode;
    source = "durable_chat_override";
    scope = "chat";
  } else if (presetState === "ready" && presetDefault !== null) {
    authoredValue = presetDefault;
    source = "reviewed_preset_default";
    scope = "preset";
  } else {
    const reasonCode = input.presetRepairCode
      ?? (presetState === "repair_required" ? "loom_policy_invalid" : "loom_policy_repair_required");
    availability = {
      state: presetState === "repair_required" ? "invalid" : "stale",
      reasonCode,
    };
  }

  let effectiveValue = authoredValue;
  if (hostAvailability !== "available") {
    effectiveValue = "response";
    source = "host_rejected";
    scope = "host";
    availability = {
      state: hostAvailability,
      reasonCode: input.hostReasonCode ?? "agentic_readiness_unavailable",
    };
  } else if (!allowedModes.includes(authoredValue)) {
    effectiveValue = "response";
    source = allowedModes.includes("response") ? "host_cap" : "host_rejected";
    scope = "host";
    availability = {
      state: "denied",
      reasonCode: input.hostReasonCode ?? "agentic_mode_not_allowed",
    };
  }
  const repairAcknowledgement = input.repairAcknowledgement ?? {
    state: availability.state === "available" ? "not_required" : "required",
    presetRevision: input.presetRevision ?? null,
    reasonCode: availability.reasonCode,
    acknowledgedAt: null,
  };
  return freezePolicy({
    version: 1,
    authoredValue,
    effectiveValue,
    source,
    scope,
    cap: { ...cap, allowedModes: Object.freeze(allowedModes) },
    availability,
    presetRevision: input.presetRevision ?? null,
    transientSelection,
    durableChatOverride,
    repairAcknowledgement,
    nextTurnOnly: true,
  });
}


function normalizeTarget(request: EffectiveRuntimeRequestV1): { target: GenerationTargetV1; invalidType: boolean } {
  const rawType = request.target?.generationType ?? request.generationType ?? "normal";
  const validType = isAgenticGenerationType(rawType);
  const generationType = validType ? rawType : "normal";
  const target: GenerationTargetV1 = {
    generationType,
    messageId: safeString(request.target?.messageId, null),
    swipeId: Number.isSafeInteger(request.target?.swipeId) && (request.target?.swipeId ?? -1) >= 0
      ? request.target?.swipeId
      : null,
    branchId: safeString(request.target?.branchId, null),
    targetCharacterId: safeString(request.target?.targetCharacterId ?? request.targetCharacterId, null),
    revision: safeRevision(request.target?.revision),
  };
  return { target, invalidType: !validType };
}
type RuntimeConcreteConnection = FrozenConcreteConnectionV1 & { presetId?: string | null };

function normalizeConcreteConnection(raw: unknown, logicalId: string | null): RuntimeConcreteConnection | null {
  if (!isRecord(raw)) return null;
  const readRevision = (names: readonly string[], path: string): RuntimeRevision | null => {
    const field = readAliasedField(raw, names, path);
    if (!field.present || field.value === undefined || field.value === null) return null;
    const revision = safeRevision(field.value);
    if (revision === null) {
      throw new RuntimeDecisionError("invalid_request", `${path} must be a non-negative safe integer revision`, 400);
    }
    return revision;
  };
  const capabilities = freezePolicy(isRecord(raw.capabilities) ? { ...raw.capabilities } : {});
  const concreteId = safeString(raw.concreteId ?? raw.concrete_id ?? raw.id, null);
  const normalizedLogicalId = safeString(raw.logicalId ?? raw.logical_id, logicalId);
  const effectiveEndpoint = [raw.endpoint, raw.effectiveEndpoint, raw.apiUrl, raw.api_url]
    .map((value) => safeString(value, null))
    .find((value): value is string => value !== null) ?? null;
  return Object.freeze({
    logicalId: normalizedLogicalId,
    concreteId,
    label: safeString(raw.label ?? raw.name, null),
    presetId: safeString(raw.presetId ?? raw.preset_id, null),
    provider: safeString(raw.provider, null),
    model: safeString(raw.model, null),
    effectiveEndpoint,
    endpointRevision: readRevision(["endpointRevision", "endpoint_revision"], "connection.endpointRevision"),
    credentialSecretRef: safeString(raw.credentialSecretRef ?? raw.credential_secret_ref, null),
    credentialRevision: readRevision(["credentialRevision", "credential_revision"], "connection.credentialRevision"),
    candidateRevision: readRevision(["candidateRevision", "candidate_revision"], "connection.candidateRevision"),
    revision: readRevision(["revision", "updatedAt", "updated_at"], "connection.revision"),
    fingerprint: safeString(raw.fingerprint, null),
    capabilityDigest: canonicalRuntimeCapabilityDigest(capabilities),
    capabilities,
  });
}
function sameFrozenConnection(left: FrozenConcreteConnectionV1 | null | undefined, right: FrozenConcreteConnectionV1 | null | undefined): boolean {
  if (!left || !right) return left === right;
  const leftEndpoint = (left as FrozenConcreteConnectionV1 & { effectiveEndpoint?: string | null }).effectiveEndpoint ?? null;
  const rightEndpoint = (right as FrozenConcreteConnectionV1 & { effectiveEndpoint?: string | null }).effectiveEndpoint ?? null;
  return left.logicalId === right.logicalId
    && left.concreteId === right.concreteId
    && left.provider === right.provider
    && left.model === right.model
    && leftEndpoint === rightEndpoint
    && String(left.endpointRevision) === String(right.endpointRevision)
    && String(left.credentialSecretRef) === String(right.credentialSecretRef)
    && String(left.credentialRevision) === String(right.credentialRevision)
    && String(left.candidateRevision) === String(right.candidateRevision)
    && String(left.fingerprint) === String(right.fingerprint)
    && left.capabilityDigest === right.capabilityDigest;
}

function capabilityIsPresent(capabilities: Readonly<Record<string, unknown>>, requirement: AgentRuntimeCapabilityRequirement): boolean {
  if (requirement === "generation") return true;
  if (requirement === "streaming") {
    return capabilities.streaming === true
      || capabilities.supportsStreaming === true
      || capabilities.stream === true;
  }
  if (requirement === "tool_calling") {
    return capabilities.toolCalling === true
      || capabilities.tool_calling === true
      || capabilities.supportsToolCalling === true;
  }
  if (requirement === "native_tool_continuation") {
    // Agentic WORK is admitted only for the canonical provider-native
    // continuation contract. Legacy transcript continuation remains available
    // to Response and Council, but it is never Agentic capability authority.
    return capabilities.nativeToolContinuation === true
      && capabilities.toolContinuationMode === "native"
      && capabilityIsPresent(capabilities, "tool_calling");
  }
  return capabilities.toolsDisabledFinalization === true
    || capabilities.tools_disabled_finalization === true
    || capabilities.supportsToolsDisabledFinalization === true
    || capabilities.supportsToolFinalization === true;
}

function mapCapabilityFailure(requirement: AgentRuntimeCapabilityRequirement): AgentRuntimeRepairCode {
  switch (requirement) {
    case "generation": return "agentic_capability_missing_generation";
    case "streaming": return "agentic_capability_missing_streaming";
    case "tool_calling": return "agentic_capability_missing_tool_calling";
    case "native_tool_continuation": return "agentic_capability_missing_native_tool_continuation";
    case "tools_disabled_finalization": return "agentic_capability_missing_tools_disabled_finalization";
  }
}

function isAgenticOnlyRepairCode(code: string): boolean {
  return code.startsWith("agentic_")
    || code.startsWith("cognition_")
    || code.startsWith("agent_config_")
    || code === "input_revisions_incomplete"
    || code === "kill_switch_off"
    || code === "provider_capability_unavailable"
    || code === "schema_unavailable"
    || code === "reconciliation_required"
    || code === "archive_registry_unavailable"
    || code === "isolate_unavailable"
    || code === "publication_store_unavailable"
    || code === "decision_capacity_exceeded"
    || code === "decision_refresh_required";
}

function responseCapabilityWire(
  requestedMode: AgentRuntimeMode,
  capabilityReadiness: {
    ready: boolean;
    sameDomain: boolean;
    required: AgentRuntimeCapabilityRequirement[];
    missing: AgentRuntimeCapabilityRequirement[];
    repairCodes: AgentRuntimeRepairCode[];
  },
  repairCodes: readonly AgentRuntimeRepairCode[],
): {
  capabilityReadiness: EffectiveRuntimeDecisionV1["capabilityReadiness"];
  repairCodes: AgentRuntimeRepairCode[];
} {
  if (requestedMode !== "response") {
    return {
      capabilityReadiness: {
        ...capabilityReadiness,
        ready: capabilityReadiness.ready,
        responseEscape: AGENT_RUNTIME_RESPONSE_ESCAPE,
      },
      repairCodes: [...repairCodes],
    };
  }
  const ordinaryRepairCodes = [...new Set(repairCodes.filter((code) => !isAgenticOnlyRepairCode(code)))];
  return {
    capabilityReadiness: {
      ready: true,
      sameDomain: true,
      required: [],
      missing: [],
      repairCodes: ordinaryRepairCodes,
      responseEscape: AGENT_RUNTIME_RESPONSE_ESCAPE,
    },
    repairCodes: ordinaryRepairCodes,
  };
}


function normalizeInputRevisions(value: Partial<InputRevisionSetV1> | null | undefined): { complete: boolean; normalized: Record<string, unknown>; digest: string } {
  if (value !== null && value !== undefined && !isRecord(value)) {
    throw new RuntimeDecisionError("invalid_request", "inputRevisions must be an object or null", 400);
  }
  const source = isRecord(value) ? value : {};
  const normalized: Record<string, unknown> = {};
  let complete = true;
  for (const key of INPUT_REVISION_KEYS) {
    if (!Object.hasOwn(source, key)) {
      complete = false;
      normalized[key] = null;
      continue;
    }
    if (source[key] === undefined) {
      throw new RuntimeDecisionError("invalid_request", `inputRevisions.${key} must be a revision`, 400);
    }
    if (source[key] === null) {
      normalized[key] = null;
      continue;
    }
    const revision = safeRevision(source[key]);
    if (revision === null) {
      throw new RuntimeDecisionError("invalid_request", `inputRevisions.${key} must be a non-negative safe integer revision`, 400);
    }
    normalized[key] = revision;
  }
  return { complete, normalized, digest: hashCanonical(normalized) };
}

/** Canonical digest used by decision tokens and the pre-dispatch snapshot gate. */
export function canonicalInputRevisionDigest(
  value: Partial<InputRevisionSetV1> | null | undefined,
): string {
  return normalizeInputRevisions(value).digest;
}

function defaultReadinessVector(inputRevisionDigest: string, configRevision: RuntimeRevision | null, bindingRevision: RuntimeRevision | null): AgenticReadinessVectorV1 {
  return {
    schemaEpoch: DEFAULT_READINESS_EPOCH,
    runtimeEpoch: DEFAULT_READINESS_EPOCH,
    reconciliationEpoch: DEFAULT_READINESS_EPOCH,
    archiveRegistryVersion: DEFAULT_READINESS_EPOCH,
    isolateHealthEpoch: DEFAULT_READINESS_EPOCH,
    publicationStoreHealthEpoch: DEFAULT_READINESS_EPOCH,
    providerCapabilityRevision: DEFAULT_READINESS_EPOCH,
    configRevision: configRevision ?? DEFAULT_REVISION,
    bindingRevision: bindingRevision ?? DEFAULT_REVISION,
    concreteConnectionRevision: DEFAULT_REVISION,
    targetRevision: DEFAULT_REVISION,
    inputRevisionDigest,
    cognitionRevision: DEFAULT_READINESS_EPOCH,
    killSwitchState: "auto",
    ready: true,
    reasons: [],
  };
}

function normalizeReadinessVector(
  raw: Partial<AgenticReadinessVectorV1> | null | undefined,
  inputRevisionDigest: string,
  configRevision: RuntimeRevision | null,
  bindingRevision: RuntimeRevision | null,
): AgenticReadinessVectorV1 {
  const defaults = defaultReadinessVector(inputRevisionDigest, configRevision, bindingRevision);
  if (raw === null || raw === undefined) return defaults;
  if (!isRecord(raw)) {
    throw new RuntimeDecisionError("invalid_request", "readinessVector must be an object or null", 400);
  }
  const result = { ...defaults };
  const revisionKeys = [
    "schemaEpoch",
    "runtimeEpoch",
    "reconciliationEpoch",
    "archiveRegistryVersion",
    "isolateHealthEpoch",
    "publicationStoreHealthEpoch",
    "providerCapabilityRevision",
    "configRevision",
    "bindingRevision",
    "concreteConnectionRevision",
    "targetRevision",
    "cognitionRevision",
  ] as const;
  for (const key of revisionKeys) {
    if (!Object.hasOwn(raw, key)) continue;
    const revision = safeRevision(raw[key]);
    if (revision === null) {
      throw new RuntimeDecisionError("invalid_request", `readinessVector.${key} must be a non-negative safe integer revision`, 400);
    }
    (result as unknown as Record<string, unknown>)[key] = revision;
  }
  if (Object.hasOwn(raw, "inputRevisionDigest")) {
    if (typeof raw.inputRevisionDigest !== "string"
      || raw.inputRevisionDigest.length === 0
      || raw.inputRevisionDigest.length > SAFE_STRING_MAX) {
      throw new RuntimeDecisionError("invalid_request", "readinessVector.inputRevisionDigest must be a bounded string", 400);
    }
  }
  if (Object.hasOwn(raw, "killSwitchState")
    && raw.killSwitchState !== "off"
    && raw.killSwitchState !== "on"
    && raw.killSwitchState !== "auto") {
    throw new RuntimeDecisionError("invalid_request", "readinessVector.killSwitchState is invalid", 400);
  }
  const state = raw.killSwitchState ?? defaults.killSwitchState;
  if (Object.hasOwn(raw, "ready") && typeof raw.ready !== "boolean") {
    throw new RuntimeDecisionError("invalid_request", "readinessVector.ready must be boolean", 400);
  }
  let reasons = defaults.reasons;
  if (Object.hasOwn(raw, "reasons")) {
    if (!Array.isArray(raw.reasons)
      || raw.reasons.length > 64
      || raw.reasons.some((reason) => typeof reason !== "string" || reason.length === 0 || reason.length > 256)) {
      throw new RuntimeDecisionError("invalid_request", "readinessVector.reasons is invalid", 400);
    }
    reasons = raw.reasons.slice();
  }
  result.killSwitchState = state;
  result.reasons = reasons;
  result.inputRevisionDigest = inputRevisionDigest;
  result.ready = raw.ready !== false && state !== "on";
  return result;
}

function normalizeConfig(
  raw: unknown,
  revision: RuntimeRevision,
  bindingRevision: RuntimeRevision | null,
  state: "ready" | "review_required" | "repair_required",
  reviewCode: string | null = null,
  reviewAcknowledged = false,
): AgentConfigView | null {
  const hasRuntimePolicy = isRecord(raw) && Object.hasOwn(raw, "runtimePolicy");
  if (hasRuntimePolicy) {
    try {
      parseAgentRuntimePolicyV1(raw.runtimePolicy);
    } catch {
      throw new RuntimeDecisionError(
        "runtime_policy_invalid",
        "runtimePolicy is invalid.",
        400,
        "loom_policy_invalid",
      );
    }
  }
  let config: AgentConfigV2;
  try {
    config = parseAgentConfigV2(raw);
  } catch {
    return null;
  }
  return {
    version: 2,
    agentsEnabled: config.agentsEnabled,
    allowedModes: [...config.allowedModes],
    defaultMode: config.defaultMode,
    maxInvocations: config.maxInvocations,
    maxToolCalls: config.maxToolCalls,
    profiles: config.profiles.map((profile) => ({
      id: profile.id,
      connectionRef: profile.connectionRef.kind === "slot"
        ? { kind: "slot", slotId: profile.connectionRef.slotId }
        : { kind: "inherit_main" },
    })),
    connectionSlots: config.connectionSlots.map((slot) => ({
      id: slot.id,
      label: slot.label,
      requiredCapabilities: normalizeRequirements(slot.requiredCapabilities),
    })),
    runtimePolicy: config.runtimePolicy ?? null,
    revision,
    reviewCode,
    reviewAcknowledged,
    bindingRevision,
    state,
  };
}

function getSlotBindingId(rawConfig: unknown, slotId: string): string | null {
  if (!isRecord(rawConfig) || !isRecord(rawConfig.slotBindings)) return null;
  return safeString(rawConfig.slotBindings[slotId], null);
}

function getSlotBindingState(rawConfig: unknown, slotId: string): string | null {
  if (!isRecord(rawConfig) || !isRecord(rawConfig.slotBindingStates)) return null;
  return safeString(rawConfig.slotBindingStates[slotId], null);
}

function isNoPresetChat(chat: AgentRuntimeChatView): boolean {
  const metadata = chat.metadata;
  return isRecord(metadata) && (metadata.no_preset === true || metadata.noPreset === true || metadata.temporary === true && metadata.no_preset === true);
}

function hasGroup(chat: AgentRuntimeChatView): boolean {
  return isRecord(chat.metadata) && (chat.metadata.group === true || chat.metadata.group === 1);
}

function hasMultiplayer(chat: AgentRuntimeChatView): boolean {
  return isRecord(chat.metadata) &&
    (chat.metadata.multiplayer === true ||
      typeof chat.metadata.multiplayer_room_id === "string");
}

function mapPresetSource(source: unknown): SafePresetProjectionV1["source"] {
  if (source === "chat" || source === "persona" || source === "character" || source === "connection" || source === "forced") return source;
  if (source === "defaults" || source === "default") return "default";
  return "none";
}


function publicConnection(connection: FrozenConcreteConnectionV1 | null): SafeConnectionProjectionV1 {
  return {
    id: connection?.logicalId ?? connection?.concreteId ?? null,
    label: connection?.label ?? null,
    provider: connection?.provider ?? null,
    model: connection?.model ?? null,
    revision: connection?.revision ?? null,
    endpointRevision: connection?.endpointRevision ?? null,
    credentialRevision: connection?.credentialRevision ?? null,
    candidateRevision: connection?.candidateRevision ?? null,
  };
}

function buildBinding(
  userId: string,
  context: InternalResolutionContext,
): RuntimeDecisionBindingV1 {
  const root = context.rootConnection;
  return {
    userId,
    chatId: context.chat.id,
    turnFence: context.runtimePolicy.transientSelection?.turnFence ?? safeRevision(context.request.requestEpoch) ?? DEFAULT_REVISION,
    targetDigest: hashCanonical(context.target),
    requestEpoch: safeRevision(context.request.requestEpoch) ?? DEFAULT_REVISION,
    logicalConnectionId: root?.logicalId ?? null,
    concreteConnectionId: root?.concreteId ?? null,
    provider: root?.provider ?? null,
    model: root?.model ?? null,
    fingerprint: root?.fingerprint ?? null,
    capabilityDigest: root?.capabilityDigest ?? null,
    candidateRevision: root?.candidateRevision ?? null,
    credentialRevision: root?.credentialRevision ?? null,
    endpointRevision: root?.endpointRevision ?? null,
    presetId: context.preset?.id ?? null,
    configRevision: context.config?.revision ?? null,
    bindingRevision: context.config?.bindingRevision ?? null,
    inputRevisionDigest: context.inputRevisionDigest,
    readinessDigest: context.readinessDigest,
  };
}
function publicLoomInspection(
  userId: string,
  presetId: string | null,
  config: AgentConfigView | null,
  effectiveMode: AgentRuntimeMode,
): {
  readonly inspection: LoomPromptInspectionV1;
  readonly responseOmission: LoomResponsePolicyOmissionV1 | null;
} {
  const surface = effectiveMode === "response" ? "RESPONSE" as const : "WORK" as const;
  const checkpoint = surface === "WORK" ? "WORK" as const : "ASSEMBLE" as const;
  const responseSource = surface === "RESPONSE" && presetId ? getPresetAgentResponseCognitionSourceV1(userId, presetId) : null;
  const inspectionConfig = surface === "RESPONSE" ? responseSource?.config ?? null : config;
  const reviewReason = responseSource?.reviewReason
    ?? (responseSource ? responseSource.sourceKind + "_cognition_source" : "response_surface");
  const omittedPhaseInstructions = Object.freeze((inspectionConfig?.runtimePolicy?.phases ?? []).flatMap((phase) => [
    ...phase.instructionRefs.map((source) => Object.freeze({ phaseId: phase.id, source })),
    ...phase.childInstructionSubsets.flatMap((subset) => subset.instructionRefs.map((source) => Object.freeze({ phaseId: phase.id, profileId: subset.profileId, source }))),
  ]));
  const policy = inspectionConfig?.runtimePolicy?.loomPolicy;
  // Only the snapshot compiler owns enough context to resolve WORK policy
  // content. Admission therefore omits undecided per-entry outcomes entirely;
  // RESPONSE omission remains authoritative because work-only visibility does
  // not depend on content materialization.
  const baseInspection = policy && surface === "RESPONSE"
    ? inspectLoomPromptPolicies(policy, {
      checkpoint,
      surface,
      blocks: [],
    })
    : {
      version: LOOM_POLICY_VERSION,
      surface,
      checkpoint,
      items: [],
      effectiveEntryIds: [],
      ...(surface === "RESPONSE"
        ? {
          responseOmission: {
            version: LOOM_POLICY_VERSION,
            surface: "RESPONSE" as const,
            visibility: "work_only" as const,
            reason: "work_only" as const,
            ...(reviewReason === null ? {} : { reviewReason }),
            omittedEntryIds: [],
            source: [],
            omittedPhaseInstructions,
          },
        }
        : {}),
    };
  const inspection = surface === "RESPONSE" && baseInspection.responseOmission
    ? Object.freeze({
      ...baseInspection,
      responseOmission: Object.freeze({
        ...baseInspection.responseOmission,
        ...(reviewReason === null ? {} : { reviewReason }),
        omittedPhaseInstructions,
      }),
    })
    : baseInspection;
  return {
    inspection,
    responseOmission: inspection.responseOmission ?? null,
  };
}

function safePublicResponse(decision: EffectiveRuntimeDecisionV1): EffectiveRuntimePublicResponseV1 {
  const { internal: _internal, ...publicPart } = decision;
  return publicPart;
}

function isOpaqueDecisionToken(value: unknown): value is string {
  return typeof value === "string" && /^lvrd_[A-Za-z0-9_-]{32,128}$/.test(value);
}

function readOverrideViaPersistenceService(userId: string, chatId: string): ChatAgentModeOverrideV1 | null | undefined {
  try {
    const module = require("./agent-config-portability.service") as {
      getChatAgentModeOverride?: (userId: string, chatId: string) => unknown;
    };
    if (typeof module.getChatAgentModeOverride !== "function") return undefined;
    const result = module.getChatAgentModeOverride(userId, chatId);
    if (!isRecord(result)) return result === null ? null : undefined;
    return {
      mode: isAgentRuntimeMode(result.mode) ? result.mode : null,
      revision: typeof result.revision === "number" && Number.isSafeInteger(result.revision) ? result.revision : 1,
      state: result.state === "review_required" || result.state === "repair_required" ? result.state : "ready",
      reviewCode: safeString(result.reviewCode, null),
      acknowledged: result.acknowledged === true,
    };
  } catch {
    return undefined;
  }
}

function readOverrideFromDb(userId: string, chatId: string): ChatAgentModeOverrideV1 | null {
  const persisted = readOverrideViaPersistenceService(userId, chatId);
  if (persisted !== undefined) return persisted;
  try {
    const row = getDb().query(
      "SELECT mode, revision, state, review_code, review_acknowledged FROM chat_agent_mode_overrides WHERE user_id = ? AND chat_id = ?",
    ).get(userId, chatId) as { mode?: unknown; revision?: unknown; state?: unknown; review_code?: unknown; review_acknowledged?: unknown } | null;
    if (!row) return null;
    return {
      mode: isAgentRuntimeMode(row.mode) ? row.mode : null,
      revision: typeof row.revision === "number" && Number.isSafeInteger(row.revision) ? row.revision : 1,
      state: row.state === "review_required" || row.state === "repair_required" ? row.state : "ready",
      reviewCode: safeString(row.review_code, null),
      acknowledged: row.review_acknowledged === 1,
    };
  } catch {
    return null;
  }
}

function chatModeRevisionConflict(userId: string, chatId: string): RuntimeDecisionError {
  const current = readOverrideFromDb(userId, chatId);
  return new RuntimeDecisionError(
    "chat_mode_revision_conflict",
    "Chat agent mode changed; refresh and try again.",
    409,
    null,
    {
      currentRevision: current?.revision ?? 0,
      currentMode: current?.mode ?? null,
      currentState: current?.state ?? "ready",
      source: "durable_chat_override",
      appliesTo: "next_turn",
    },
  );
}

function writeOverrideToDb(
  userId: string,
  chatId: string,
  mode: AgentRuntimeMode | null,
  expectedRevision?: number,
): ChatAgentModeWriteResponseV1 {
  let persistence: ((userId: string, chatId: string, mode: AgentRuntimeMode | null, expectedRevision?: number) => unknown) | undefined;
  try {
    const module = require("./agent-config-portability.service") as {
      setChatAgentModeOverride?: (userId: string, chatId: string, mode: AgentRuntimeMode | null, expectedRevision?: number) => unknown;
    };
    persistence = module.setChatAgentModeOverride;
  } catch {
    persistence = undefined;
  }
  if (persistence) {
    try {
      const result = persistence(userId, chatId, mode, expectedRevision);
      if (result === null) throw new RuntimeDecisionError("not_found", "Not found", 404);
      if (isRecord(result) && typeof result.revision === "number") {
        return {
          chatId,
          mode: isAgentRuntimeMode(result.mode) ? result.mode : null,
          revision: result.revision,
          state: result.state === "review_required" || result.state === "repair_required" ? result.state : "ready",
        };
      }
      throw new RuntimeDecisionError("invalid_request", "Chat agent mode storage is unavailable.", 503);
    } catch (error) {
      if (error instanceof RuntimeDecisionError) throw error;
      if (error instanceof Error && error.message === "AGENT_CHAT_MODE_REVISION_REQUIRED") {
        throw new RuntimeDecisionError("invalid_request", "Chat agent mode expectedRevision is required (use 0 for the first write).", 428);
      }
      if (error instanceof Error && error.message === "AGENT_CHAT_MODE_REVISION_CONFLICT") {
        throw chatModeRevisionConflict(userId, chatId);
      }
      throw new RuntimeDecisionError("invalid_request", "Chat agent mode storage is unavailable.", 503);
    }
  }
  const chat = chatsSvc.getChat(userId, chatId);
  if (!chat) throw new RuntimeDecisionError("not_found", "Not found", 404);
  if (expectedRevision === undefined || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new RuntimeDecisionError("invalid_request", "Chat agent mode expectedRevision is required (use 0 for the first write).", 428);
  }
  if (expectedRevision >= Number.MAX_SAFE_INTEGER) {
    throw new RuntimeDecisionError("invalid_request", "Chat agent mode revision is exhausted; refresh and try again.", 409);
  }
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  try {
    const result = db.transaction(() => {
      if (expectedRevision === 0) {
        // A first write is a conditional insert, not an upsert. Two callers
        // with the same base revision must not both win revision 1.
        return db.query(`
          INSERT INTO chat_agent_mode_overrides
            (user_id, chat_id, mode, revision, state, review_code, review_acknowledged, updated_at)
          VALUES (?, ?, ?, 1, 'ready', NULL, 1, ?)
          ON CONFLICT(user_id, chat_id) DO NOTHING
        `).run(userId, chatId, mode, now);
      }
      // Existing writes advance only the row whose revision the caller read.
      return db.query(`
        UPDATE chat_agent_mode_overrides
        SET mode = ?, revision = ?, state = 'ready', review_code = NULL,
            review_acknowledged = 1, updated_at = ?
        WHERE user_id = ? AND chat_id = ? AND revision = ?
      `).run(mode, expectedRevision + 1, now, userId, chatId, expectedRevision);
    })();
    if (result.changes !== 1) {
      throw chatModeRevisionConflict(userId, chatId);
    }
  } catch (error) {
    if (error instanceof RuntimeDecisionError) throw error;
    throw new RuntimeDecisionError("invalid_request", "Chat agent mode storage is unavailable.", 503);
  }
  return { chatId, mode, revision: expectedRevision + 1, state: "ready" };
}

async function defaultConcreteResolver(
  userId: string,
  logicalId?: string | null,
  expectedConcreteId?: string | null,
): Promise<unknown> {
  const resolver = (connectionsSvc as unknown as {
    resolveConcreteConnectionV1?: (
      id: string,
      logicalId?: string | null,
      expectedConcreteId?: string | null,
    ) => unknown;
  }).resolveConcreteConnectionV1;
  const legacy = (connectionsSvc as unknown as { resolveConnection?: (id: string, logicalId?: string) => unknown }).resolveConnection;
  const resolved = await (resolver
    ? resolver(userId, logicalId, expectedConcreteId)
    : legacy?.(userId, logicalId ?? undefined) ?? null);
  if (!isRecord(resolved)) return resolved;
  const concreteId = safeString(resolved.concreteId ?? resolved.concrete_id ?? resolved.id, null);
  const profile = concreteId ? connectionsSvc.getUsableConnection(userId, concreteId) : null;
  return profile ? { ...resolved, presetId: profile.preset_id } : resolved;
}

function normalizeConfigProjection(projection: unknown): { config: AgentConfigView | null; raw: unknown } {
  if (!isRecord(projection) || !isRecord(projection.config) || projection.config.version !== 2) {
    return { config: null, raw: null };
  }
  if (!Object.hasOwn(projection, "review") || !Object.hasOwn(projection, "configRevision") || !Object.hasOwn(projection, "bindings")) {
    return { config: null, raw: null };
  }
  const projectedConfig = projection.config;
  const review = projection.review;
  if (!isRecord(review) || !["ready", "review_required", "repair_required"].includes(String(review.state))) {
    return { config: null, raw: null };
  }
  const configRevision = safeRevision(projection.configRevision);
  if (configRevision === null || !Array.isArray(projection.bindings)) return { config: null, raw: null };
  const unresolved = review.unresolvedSlotIds;
  const stale = review.staleSlotIds;
  if ((unresolved !== undefined && !Array.isArray(unresolved)) || (stale !== undefined && !Array.isArray(stale))) {
    return { config: null, raw: null };
  }
  const slotBindings: Record<string, string> = {};
  const slotBindingStates: Record<string, string> = {};
  let maxBindingRevision: RuntimeRevision | null = null;
  for (const binding of projection.bindings) {
    if (!isRecord(binding)) return { config: null, raw: null };
    const slotId = safeString(binding.slotId, null);
    const connectionId = safeString(binding.connectionId, null);
    const state = binding.state;
    const revision = safeRevision(binding.bindingRevision);
    if (!slotId || revision === null || !["ready", "review_required", "repair_required"].includes(String(state))) {
      return { config: null, raw: null };
    }
    if (connectionId) slotBindings[slotId] = connectionId;
    slotBindingStates[slotId] = String(state);
    if (maxBindingRevision === null || Number(revision) > Number(maxBindingRevision)) maxBindingRevision = revision;
  }
  const projectedBindingRevision = safeRevision(projection.bindingRevision);
  if (projectedBindingRevision !== null && (
    maxBindingRevision === null
    || typeof projectedBindingRevision === "number" && typeof maxBindingRevision === "number" && projectedBindingRevision > maxBindingRevision
  )) maxBindingRevision = projectedBindingRevision;
  const reviewState = String(review.state);
  const hasReviewItems = (Array.isArray(unresolved) && unresolved.length > 0) || (Array.isArray(stale) && stale.length > 0);
  const state = reviewState === "ready" && hasReviewItems ? "review_required" : reviewState as "ready" | "review_required" | "repair_required";
  const raw = {
    ...projectedConfig,
    revision: configRevision,
    bindingRevision: maxBindingRevision,
    state,
    slotBindings,
    slotBindingStates,
  };
  return {
    config: normalizeConfig(
      projectedConfig,
      configRevision,
      maxBindingRevision,
      state,
      safeString(review.reasonCode, null),
      review.acknowledged === true,
    ),
    raw,
  };
}

function defaultConfigReader(userId: string, presetId: string): { config: AgentConfigView | null; raw: unknown } {
  return normalizeConfigProjection(defaultPresetAgentConfig(userId, presetId));
}

function defaultPresetAgentConfig(userId: string, presetId: string): unknown {
  try {
    const module = require("./agent-config-portability.service") as {
      getPresetAgentConfig?: (userId: string, presetId: string) => unknown;
    };
    return module.getPresetAgentConfig?.(userId, presetId) ?? null;
  } catch {
    return null;
  }
}

function defaultDependencies(): RuntimeDecisionDependencies {
  return {
    getChat: (userId, chatId) => chatsSvc.getChat(userId, chatId) as AgentRuntimeChatView | null,
    getPreset: (userId, presetId) => presetsSvc.getPreset(userId, presetId) as AgentRuntimePresetView | null,
    getPresetAgentConfig: defaultPresetAgentConfig,
    resolveProfile: (userId, fallbackPresetId, chatId, characterId, options) => presetProfilesSvc.resolveProfile(userId, fallbackPresetId, chatId, characterId, options),
    resolveCouncilProfile: (userId, chatId, characterId, options) => councilProfilesSvc.resolveProfile(userId, chatId, characterId, options),
    resolvePersona: (userId, personaId) => personasSvc.resolvePersonaOrDefault(userId, personaId),
    resolveConcreteConnection: defaultConcreteResolver,
    getChatAgentModeOverride: readOverrideFromDb,
    setChatAgentModeOverride: writeOverrideToDb,
    // Admission remains fail-closed until the generation snapshot/readiness
    // authorities are installed by the runtime orchestrator.
    getInputRevisions: () => null,
    getReadinessVector: () => null,
  };
}

function ensureDependencies(overrides: Partial<RuntimeDecisionDependencies> | undefined): RuntimeDecisionDependencies {
  const dependencies = { ...defaultDependencies(), ...(overrides ?? {}) };
  if (overrides && !Object.hasOwn(overrides, "getInputRevisions")) dependencies.getInputRevisions = undefined;
  if (overrides && !Object.hasOwn(overrides, "getPresetAgentConfig")) dependencies.getPresetAgentConfig = undefined;
  if (overrides && !Object.hasOwn(overrides, "getReadinessVector")) dependencies.getReadinessVector = undefined;
  return dependencies;
}

function consumeRefreshRejection(
  mismatch?: RuntimeDecisionRefreshMismatchV1,
): RuntimeDecisionTokenConsumptionV1 {
  return mismatch
    ? { accepted: false, code: "decision_refresh_required", decision: null, mismatch }
    : { accepted: false, code: "decision_refresh_required", decision: null };
}

function consumeBindingMismatch(
  current: RuntimeDecisionBindingV1,
  expected: RuntimeDecisionBindingV1,
  currentPolicy: unknown,
  storedPolicy: unknown,
  currentRoot: FrozenConcreteConnectionV1 | null | undefined,
  storedRoot: FrozenConcreteConnectionV1 | null | undefined,
): RuntimeDecisionRefreshMismatchV1 | null {
  const fields = [
    ["userId", "user_id"],
    ["chatId", "chat_id"],
    ["targetDigest", "target_digest"],
    ["requestEpoch", "request_epoch"],
    ["turnFence", "turn_fence"],
    ["logicalConnectionId", "logical_connection_id"],
    ["concreteConnectionId", "concrete_connection_id"],
    ["provider", "provider"],
    ["model", "model"],
    ["fingerprint", "fingerprint"],
    ["capabilityDigest", "capability_digest"],
    ["candidateRevision", "candidate_revision"],
    ["credentialRevision", "credential_revision"],
    ["endpointRevision", "endpoint_revision"],
    ["presetId", "preset_id"],
    ["configRevision", "config_revision"],
    ["bindingRevision", "binding_revision"],
    ["inputRevisionDigest", "input_revision_digest"],
    ["readinessDigest", "readiness_digest"],
  ] as const;
  for (const [key, mismatch] of fields) {
    if (current[key] !== expected[key]) return mismatch;
  }
  if (stableStringify(currentPolicy) !== stableStringify(storedPolicy)) return "runtime_policy";
  if (!sameFrozenConnection(currentRoot, storedRoot)) return "root_connection";
  return null;
}

export class AgentRuntimeDecisionService {
  readonly tokenStore: RuntimeDecisionTokenStore;
  private readonly now: () => number;
  private dependencies: RuntimeDecisionDependencies;
  private dependencyUseStarted = false;
  private dependenciesConfigured = false;
  /**
   * A default fail-closed resolver may be queried during bootstrap probes
   * before the concrete coordinator is installed. Such a probe must not make
   * the one-time production installation impossible; custom authorities remain
   * immutable once used.
   */
  private readonly startsWithDefaultDependencies: boolean;

  constructor(options: AgentRuntimeDecisionServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tokenStore = options.tokenStore ?? new RuntimeDecisionTokenStore(this.now);
    this.startsWithDefaultDependencies = options.dependencies === undefined;
    this.dependencies = ensureDependencies(options.dependencies);
  }
  private configForPreset(userId: string, presetId: string): AgentConfigView | null {
    if (!this.dependencies.getPresetAgentConfig) return null;
    return normalizeConfigProjection(this.dependencies.getPresetAgentConfig(userId, presetId)).config;
  }

  private repairAcknowledgementFor(
    userId: string,
    preset: AgentRuntimePresetView | null,
    config: AgentConfigView | null,
  ): LoomRuntimePolicyRepairAcknowledgementV1 | undefined {
    if (!config) return undefined;
    const presetRevision = safeRevision(preset?.cache_revision ?? config.revision);
    if (config.state === "ready") {
      return {
        state: "not_required",
        presetRevision,
        reasonCode: null,
        acknowledgedAt: null,
      };
    }
    const reasonCode = normalizeRepairReason(config.reviewCode, "loom_policy_repair_required");
    if (preset?.id && presetRevision !== null && reasonCode) {
      const persisted = readPersistedRuntimeRepairAcknowledgement(
        userId,
        preset.id,
        presetRevision,
        reasonCode,
      );
      if (persisted) {
        return {
          state: "acknowledged",
          presetRevision,
          reasonCode,
          acknowledgedAt: persisted.acknowledgedAt,
        };
      }
    }
    return {
      state: "required",
      presetRevision,
      reasonCode: config.reviewCode,
      acknowledgedAt: null,
    };
  }

  acknowledgeRuntimeRepair(
    userId: string,
    presetId: string,
    expectedPresetRevision: RuntimeRevision,
    reasonCode: string,
  ): RuntimeRepairAcknowledgementV1 {
    const preset = this.dependencies.getPreset(userId, presetId);
    if (!preset) throw new RuntimeDecisionError("not_found", "Not found", 404);
    const expected = safeRevision(expectedPresetRevision);
    if (expected === null) {
      throw new RuntimeDecisionError("invalid_request", "expectedPresetRevision is required.", 428);
    }
    const config = this.configForPreset(userId, presetId);
    const currentRevision = safeRevision(preset.cache_revision ?? config?.revision);
    if (currentRevision === null || !sameRuntimeRevision(expected, currentRevision)) {
      throw new RuntimeDecisionError(
        "decision_refresh_required",
        "Preset changed; refresh the reviewed runtime revision and try again.",
        409,
        null,
        {
          presetId,
          currentRevision,
          source: "preset_runtime_review",
          appliesTo: "repair/review",
        },
      );
    }
    const normalizedReason = normalizeRepairReason(reasonCode, null);
    if (!normalizedReason || !(AGENT_RUNTIME_REPAIR_CODES as readonly string[]).includes(normalizedReason)) {
      throw new RuntimeDecisionError("invalid_request", "reasonCode is not an allowlisted runtime repair item.", 400);
    }
    if (config?.state === "ready") {
      throw new RuntimeDecisionError("invalid_request", "The reviewed runtime preset has no repair item to acknowledge.", 409);
    }
    const acknowledgedAt = this.now();
    const persisted = persistRuntimeRepairAcknowledgement(
      userId,
      presetId,
      currentRevision,
      normalizedReason,
      acknowledgedAt,
    );
    if (!persisted) {
      throw new RuntimeDecisionError("runtime_policy_unavailable", "Repair acknowledgement storage is unavailable.", 503);
    }
    return {
      presetId,
      presetRevision: currentRevision,
      reasonCode: normalizedReason,
      acknowledgedAt: persisted.acknowledgedAt,
      revision: persisted.revision,
      scope: "repair/review",
      state: "acknowledged",
    };
  }


  async resolve(
    userId: string,
    request: EffectiveRuntimeRequestV1,
    options: {
      issueToken?: boolean;
      frozenRootConnection?: FrozenConcreteConnectionV1 | null;
      frozenChildConnections?: Readonly<Record<string, FrozenConcreteConnectionV1>>;
    } = {},
  ): Promise<EffectiveRuntimeDecisionV1> {
    if (!userId || !request || !request.chatId) {
      throw new RuntimeDecisionError("invalid_request", "chatId is required", 400);
    }
    request = normalizeEffectiveRuntimeRequest(request);
    this.dependencyUseStarted = true;
    const chat = this.dependencies.getChat(userId, request.chatId);
    if (!chat || chat.id !== request.chatId) throw new RuntimeDecisionError("not_found", "Not found", 404);

    const { target, invalidType } = normalizeTarget(request);
    const noPreset = isNoPresetChat(chat);
    const isGroup = hasGroup(chat);
    const targetCharacterId = target.targetCharacterId ?? chat.character_id ?? null;
    const isMultiplayer = hasMultiplayer(chat);
    const councilProfile = this.dependencies.resolveCouncilProfile(
      userId,
      chat.id,
      targetCharacterId,
      { isGroup },
    );
    const councilSettings = councilProfile.council_settings;
    const councilToolsActive = councilSettings.members.some(
      (member) => Array.isArray(member.tools) && member.tools.length > 0,
    );
    const unsupportedAgenticSurface =
      isGroup || isMultiplayer || councilToolsActive;
    const requestedLogicalConnectionId = safeString(request.logicalConnectionId, null);
    const rootConnection = normalizeConcreteConnection(
      await this.dependencies.resolveConcreteConnection(
        userId,
        requestedLogicalConnectionId,
        options.frozenRootConnection?.concreteId ?? null,
      ),
      requestedLogicalConnectionId,
    );
    const councilConnectionProfileId = safeString(
      councilProfile.sidecar_settings.connectionProfileId,
      null,
    );
    const councilConnection = councilConnectionProfileId
      ? normalizeConcreteConnection(
        await this.dependencies.resolveConcreteConnection(userId, councilConnectionProfileId, null),
        councilConnectionProfileId,
      )
      : null;

    const repairCodes: AgentRuntimeRepairCode[] = [];
    if (!rootConnection?.effectiveEndpoint) repairCodes.push("agentic_connection_unavailable");
    if (invalidType) repairCodes.push("agentic_generation_type_unsupported");
    if (target.generationType !== "normal" && !target.messageId && !target.revision) repairCodes.push("agentic_target_unsupported");
    if (target.targetCharacterId && !isGroup && target.targetCharacterId !== chat.character_id) repairCodes.push("agentic_target_unsupported");
    if (target.targetCharacterId && isGroup) {
      const members = isRecord(chat.metadata) && Array.isArray(chat.metadata.character_ids) ? chat.metadata.character_ids : [];
      if (!members.includes(target.targetCharacterId)) repairCodes.push("agentic_target_unsupported");
    }

    let preset: AgentRuntimePresetView | null = null;
    let presetSource: SafePresetProjectionV1["source"] = "none";
    let config: AgentConfigView | null = null;
    let rawConfig: unknown = null;
    let configSnapshot: unknown = null;
    const activePresetId = presetsSvc.reconcileActiveLoomPreset(userId);
    const rootPresetId = rootConnection && "presetId" in rootConnection && typeof rootConnection.presetId === "string"
      ? rootConnection.presetId
      : null;
    const requestedPresetId = noPreset
      ? null
      : safeString(request.presetId, null) ?? rootPresetId ?? activePresetId;

    if (!noPreset && request.forcePresetId && request.presetId) {
      preset = this.dependencies.getPreset(userId, request.presetId);
      presetSource = preset ? "forced" : "none";
      if (!preset) repairCodes.push("agent_config_missing");
    } else if (!noPreset) {
      const resolved = this.dependencies.resolveProfile(
        userId,
        requestedPresetId,
        chat.id,
        targetCharacterId,
        {
          isGroup,
          connectionId: rootConnection?.logicalId,
          personaId: isTemporaryChatMetadata(isRecord(chat.metadata) ? chat.metadata : null)
            ? null
            : request.personaId ?? this.dependencies.resolvePersona(userId, request.personaId)?.id ?? null,
        },
      );
      if (resolved.preset_id) {
        preset = this.dependencies.getPreset(userId, resolved.preset_id);
        presetSource = mapPresetSource(resolved.source);
      }
    }
    if (!preset && !noPreset && requestedPresetId) {
      preset = this.dependencies.getPreset(userId, requestedPresetId);
      if (preset) presetSource = "default";
    }
    if (preset) {
      if (this.dependencies.getPresetAgentConfig) {
        const projected = this.dependencies.getPresetAgentConfig(userId, preset.id);
        const normalized = normalizeConfigProjection(projected);
        config = normalized.config;
        rawConfig = normalized.raw;
        if (isRecord(projected) && isRecord(projected.config)) {
          configSnapshot = structuredClone(projected.config);
        }
      } else {
        // Runtime authority is always the normalized projection. The preset
        // payload is presentation data and may contain import-only legacy
        // metadata; never use it as an executable config fallback.
        const persisted = defaultConfigReader(userId, preset.id);
        config = persisted.config;
        rawConfig = persisted.raw;
      }
    }

    const chatOverride = this.dependencies.getChatAgentModeOverride(userId, chat.id);
    let configAllowedModes = config?.allowedModes ?? ["response"];
    let configDefaultMode = config?.runtimePolicy?.defaultMode ?? config?.defaultMode ?? "response";
    if (noPreset) {
      config = null;
      rawConfig = null;
      configAllowedModes = ["response"];
      configDefaultMode = "response";
    }
    const rawTransientSelection = request.transientSelection ?? null;
    const transientSelectionInvalid = rawTransientSelection !== null
      && rawTransientSelection !== undefined
      && (!isAgentRuntimeMode(rawTransientSelection.mode)
        || rawTransientSelection.authenticated !== true
        || safeRevision(rawTransientSelection.turnFence) === null);
    const transientSelection = !transientSelectionInvalid && rawTransientSelection && isAgentRuntimeMode(rawTransientSelection.mode)
      ? {
        mode: rawTransientSelection.mode,
        turnFence: safeRevision(rawTransientSelection.turnFence) ?? DEFAULT_REVISION,
        authenticated: true as const,
      }
      : null;
    const overrideRecord = chatOverride
      ? chatOverride as ChatAgentModeOverrideV1 & {
        reviewCode?: unknown;
        acknowledged?: unknown;
      }
      : null;
    const durableChatOverride: LoomRuntimePolicyDurableChatOverrideV1 | null = overrideRecord
      ? {
        mode: overrideRecord.mode,
        revision: overrideRecord.revision,
        state: overrideRecord.state,
        reviewCode: safeString(overrideRecord.reviewCode, null),
        acknowledged: overrideRecord.acknowledged === true,
      }
      : null;
    const presetRevision = safeRevision(preset?.cache_revision ?? config?.revision);
    const repairAcknowledgement = this.repairAcknowledgementFor(userId, preset, config);
    const initialRuntimePolicy = resolveLoomRuntimePolicy({
      transientSelection,
      durableChatOverride,
      presetDefault: config?.runtimePolicy?.defaultMode ?? config?.defaultMode ?? null,
      presetRevision,
      presetState: config?.state ?? "repair_required",
      presetRepairCode: config?.state === "repair_required"
        ? "loom_policy_invalid"
        : config?.state === "review_required"
          ? "loom_policy_repair_required"
          : null,
      hostAllowedModes: configAllowedModes,
      repairAcknowledgement,
    });
    const requestedMode = initialRuntimePolicy.authoredValue;
    const normalizedRequestedMode = requestedMode;
    if (transientSelectionInvalid) repairCodes.push("loom_policy_invalid");
    if (initialRuntimePolicy.availability.reasonCode) repairCodes.push(initialRuntimePolicy.availability.reasonCode);
    if (normalizedRequestedMode === "agentic" && unsupportedAgenticSurface) {
      repairCodes.push("agentic_target_unsupported");
    }


    if (config?.state === "review_required") repairCodes.push("agent_config_review_required");
    if (config?.state === "repair_required") repairCodes.push("agent_config_repair_required");
    if (normalizedRequestedMode === "agentic" && !config) repairCodes.push("agent_config_missing");
    if (normalizedRequestedMode === "agentic" && config && !config.agentsEnabled) repairCodes.push("agent_config_disabled");
    if (normalizedRequestedMode === "agentic" && config && !configAllowedModes.includes("agentic")) repairCodes.push("agentic_mode_not_allowed");
    if (normalizedRequestedMode === "agentic" && config && !validateAgentConfigForExecution({ maxInvocations: config.maxInvocations, maxToolCalls: config.maxToolCalls }).executable) repairCodes.push("agentic_readiness_unavailable");
    const missingCapabilities: AgentRuntimeCapabilityRequirement[] = [];
    const requiredCapabilities = [...REQUIRED_AGENTIC_CAPABILITIES];
    const childConnections: Record<string, FrozenConcreteConnectionV1> = {};
    let sameDomain = true;
    if (config && rawConfig) {
      for (const profile of config.profiles) {
        const slotRef = profile.connectionRef;
        if (slotRef.kind !== "slot") continue;
        const slot = config.connectionSlots.find((candidate) => candidate.id === slotRef.slotId);
        const connectionId = getSlotBindingId(rawConfig, slotRef.slotId);
        const bindingState = getSlotBindingState(rawConfig, slotRef.slotId);
        if (bindingState && bindingState !== "ready") {
          repairCodes.push("agentic_slot_stale");
          continue;
        }
        if (!slot || !connectionId) {
          repairCodes.push("agentic_slot_unresolved");
          continue;
        }
        const childConnection = normalizeConcreteConnection(
          await this.dependencies.resolveConcreteConnection(
            userId,
            connectionId,
            options.frozenChildConnections?.[profile.id]?.concreteId ?? null,
          ),
          connectionId,
        );
        if (!childConnection?.effectiveEndpoint) {
          repairCodes.push("agentic_slot_stale");
          continue;
        }
        childConnections[profile.id] = childConnection;
        for (const requirement of REQUIRED_AGENTIC_CAPABILITIES) {
          if (!capabilityIsPresent(childConnection.capabilities, requirement)) {
            if (!missingCapabilities.includes(requirement)) missingCapabilities.push(requirement);
            repairCodes.push(mapCapabilityFailure(requirement));
          }
        }
        for (const requirement of slot.requiredCapabilities) {
          if (!requiredCapabilities.includes(requirement)) requiredCapabilities.push(requirement);
          if (!capabilityIsPresent(childConnection.capabilities, requirement)) {
            if (!missingCapabilities.includes(requirement)) missingCapabilities.push(requirement);
            repairCodes.push(mapCapabilityFailure(requirement));
          }
        }
        if (!rootConnection?.fingerprint || !childConnection.fingerprint || rootConnection.fingerprint !== childConnection.fingerprint) {
          sameDomain = false;
          repairCodes.push("agentic_domain_mismatch");
        }
      }
    }
    const revisionSource = this.dependencies.getInputRevisions
      ? this.dependencies.getInputRevisions(userId, request, {
        chat,
        target,
        requestedMode: normalizedRequestedMode,
        rootConnection,
        childConnections,
        preset,
        config: rawConfig,
      })
      : request.inputRevisions;
    const revisions = normalizeInputRevisions(revisionSource);
    for (const requirement of REQUIRED_AGENTIC_CAPABILITIES) {
      if (!rootConnection || !capabilityIsPresent(rootConnection.capabilities, requirement)) {
        if (!missingCapabilities.includes(requirement)) missingCapabilities.push(requirement);
        repairCodes.push(mapCapabilityFailure(requirement));
      }
    }
    if (!revisions.complete && normalizedRequestedMode === "agentic") repairCodes.push("agentic_input_revisions_incomplete");
    const readinessFromDependency = this.dependencies.getReadinessVector?.(userId, request, {
      configRevision: config?.revision ?? null,
      bindingRevision: config?.bindingRevision ?? null,
      inputRevisionDigest: revisions.digest,
      inputRevisionsComplete: revisions.complete,
      requestedMode: normalizedRequestedMode,
      rootConnection,
      childConnections,
      target,
      config: rawConfig,
    });
    const readinessInput = this.dependencies.getReadinessVector
      ? readinessFromDependency ?? { ready: false, reasons: ["agentic_readiness_authority_unavailable"] }
      : request.readinessVector;
    const readinessVector = canonicalizeAgenticReadinessVectorV1(normalizeReadinessVector(
      readinessInput,
      revisions.digest,
      config?.revision ?? null,
      config?.bindingRevision ?? null,
    ));
    const readinessDigest = hashAgenticReadinessVectorV1(readinessVector);
    if (normalizedRequestedMode === "agentic" && !readinessVector.ready) repairCodes.push("agentic_readiness_unavailable");
    if (normalizedRequestedMode === "agentic" && readinessVector.killSwitchState === "on") repairCodes.push("agentic_kill_switch");

    const uniqueRepairCodes = [...new Set(repairCodes)];
    // Missing overrides stay inert. A review_required import tombstone, including
    // a null-mode one, blocks Agentic until it is reviewed.
    const chatOverrideBlocksAgentic = Boolean(chatOverride && chatOverride.state !== "ready");
    const capabilityReady = missingCapabilities.length === 0
      && sameDomain
      && uniqueRepairCodes.every((code) => !code.startsWith("agentic_") || code === "agentic_response_escape")
      && normalizedRequestedMode === "agentic"
      && config?.state === "ready"
      && !chatOverrideBlocksAgentic
      && !!config?.agentsEnabled
      && configAllowedModes.includes("agentic")
      && revisions.complete
      && readinessVector.ready
      && readinessVector.killSwitchState !== "on";
    if (!capabilityReady && normalizedRequestedMode === "agentic") uniqueRepairCodes.push("agentic_response_escape");

    const capabilityReadiness = {
      ready: capabilityReady,
      sameDomain,
      required: [...new Set(requiredCapabilities)].sort(compareUtf8),
      missing: missingCapabilities.sort(compareUtf8),
      repairCodes: [...new Set(uniqueRepairCodes)],
    };
    const effectiveMode: AgentRuntimeMode = capabilityReady ? "agentic" : "response";
    const agenticHostDenied = normalizedRequestedMode === "agentic" && !capabilityReady;
    const runtimePolicy = resolveLoomRuntimePolicy({
      transientSelection,
      durableChatOverride,
      presetDefault: config?.runtimePolicy?.defaultMode ?? config?.defaultMode ?? null,
      presetRevision,
      presetState: config?.state ?? "repair_required",
      presetRepairCode: config?.state === "repair_required"
        ? "loom_policy_invalid"
        : config?.state === "review_required"
          ? "loom_policy_repair_required"
          : null,
      hostAllowedModes: configAllowedModes,
      hostAvailability: agenticHostDenied ? "unavailable" : "available",
      hostReasonCode: agenticHostDenied ? firstConcreteHostReason(readinessVector.reasons, uniqueRepairCodes) : null,
      repairAcknowledgement: initialRuntimePolicy.repairAcknowledgement,
    });
    if (runtimePolicy.availability.reasonCode && !uniqueRepairCodes.includes(runtimePolicy.availability.reasonCode)) {
      uniqueRepairCodes.push(runtimePolicy.availability.reasonCode);
    }
    capabilityReadiness.repairCodes = [...new Set([...capabilityReadiness.repairCodes, ...uniqueRepairCodes])];
    const context: InternalResolutionContext = {
      request,
      chat,
      target,
      rootConnection,
      childConnections,
      councilProfile: connectionsSvc.cloneAndFreeze(councilProfile),
      councilConnection,
      config,
      preset,
      presetSource,
      chatOverride,
      inputRevisionDigest: revisions.digest,
      inputRevisionsComplete: revisions.complete,
      readinessVector,
      readinessDigest,
      capabilityReadiness,
      repairCodes: [...new Set(uniqueRepairCodes)],
      requestedMode: normalizedRequestedMode,
      effectiveMode,
      runtimePolicy,
    };
    const internal: RuntimeDecisionInternalV1 = {
      binding: buildBinding(userId, context),
      rootConnection,
      childConnections,
      councilProfile: context.councilProfile,
      councilConnection: context.councilConnection,
      configSnapshot,
      readinessVector,
      runtimePolicy: context.runtimePolicy,
      issuedAt: this.now(),
      expiresAt: 0,
    };
    let runtimeDecisionToken: string | null = null;
    let runtimeDecisionExpiresAt: number | null = null;
    if (effectiveMode === "agentic" && options.issueToken !== false) {
      try {
        const issued = this.tokenStore.issue(userId, internal, request);
        runtimeDecisionToken = issued.token;
        runtimeDecisionExpiresAt = issued.expiresAt;
        internal.expiresAt = issued.expiresAt;
        internal.issuedAt = issued.expiresAt - this.tokenStore.ttlMs;
      } catch (error) {
        if (!(error instanceof DecisionTokenCapacityError)) throw error;
        context.effectiveMode = "response";
        context.capabilityReadiness.ready = false;
        context.capabilityReadiness.repairCodes = [...new Set([...context.capabilityReadiness.repairCodes, "decision_capacity_exceeded", "agentic_response_escape"] as AgentRuntimeRepairCode[])];
        context.repairCodes = context.capabilityReadiness.repairCodes.slice();
        context.runtimePolicy = resolveLoomRuntimePolicy({
          transientSelection,
          durableChatOverride,
          presetDefault: config?.runtimePolicy?.defaultMode ?? config?.defaultMode ?? null,
          presetRevision: safeRevision(preset?.cache_revision ?? config?.revision),
          presetState: config?.state ?? "repair_required",
          presetRepairCode: config?.state === "repair_required" ? "loom_policy_invalid" : null,
          hostAllowedModes: ["response"],
          hostReasonCode: "decision_capacity_exceeded",
          repairAcknowledgement: context.runtimePolicy.repairAcknowledgement,
        });
        internal.runtimePolicy = context.runtimePolicy;
      }
    }

    const publicInspection = publicLoomInspection(
      userId,
      preset?.id ?? null,
      config,
      context.effectiveMode,
    );
    const decision: EffectiveRuntimeDecisionV1 = {
      version: AGENT_RUNTIME_DECISION_VERSION,
      chatId: chat.id,
      target,
      connection: publicConnection(rootConnection),
      inspection: publicInspection.inspection,
      responseOmission: publicInspection.responseOmission,
      runtimePolicy: context.runtimePolicy,
      preset: {
        id: preset?.id ?? null,
        label: safeString(preset?.name, null),
        revision: safeRevision(preset?.cache_revision),
        source: presetSource,
      },
      agentsEnabled: config?.agentsEnabled === true,
      allowedModes: configAllowedModes,
      defaultMode: configDefaultMode,
      requestedMode: normalizedRequestedMode,
      effectiveMode: context.effectiveMode,
      chatOverride,
      ...responseCapabilityWire(
        normalizedRequestedMode,
        context.capabilityReadiness,
        context.repairCodes,
      ),
      runtimeDecisionToken,
      runtimeDecisionExpiresAt,
      internal,
    };
    return decision;
  }

  async consume(userId: string, token: string, request: EffectiveRuntimeRequestV1): Promise<RuntimeDecisionTokenConsumptionV1> {
    const stored = this.tokenStore.consume(userId, token);
    if (!stored) return consumeRefreshRejection();
    const storedRuntimePolicy = stored.decision.runtimePolicy;
    if (!storedRuntimePolicy) return consumeRefreshRejection();
    let normalizedRequest: EffectiveRuntimeRequestV1;
    try {
      normalizedRequest = normalizeEffectiveRuntimeRequest(request);
    } catch {
      return consumeRefreshRejection();
    }
    request = normalizedRequest;
    const storedRequest = stored.request;
    const normalizedIncoming = normalizeTarget(request).target;
    const normalizedStored = normalizeTarget(storedRequest).target;
    const incomingBinding = {
      userId,
      chatId: request.chatId,
      turnFence: safeRevision(request.transientSelection?.turnFence) ?? safeRevision(request.requestEpoch) ?? DEFAULT_REVISION,
      targetDigest: hashCanonical(normalizedIncoming),
      requestEpoch: safeRevision(request.requestEpoch) ?? DEFAULT_REVISION,
    };
    if (incomingBinding.userId !== stored.decision.binding.userId
      || incomingBinding.chatId !== stored.decision.binding.chatId
      || incomingBinding.targetDigest !== stored.decision.binding.targetDigest
      || incomingBinding.turnFence !== stored.decision.binding.turnFence
      || incomingBinding.requestEpoch !== stored.decision.binding.requestEpoch
      || hashCanonical(normalizedStored) !== stored.decision.binding.targetDigest) {
      return consumeRefreshRejection();
    }

    const expected = stored.decision.binding;
    const storedRoot = stored.decision.rootConnection;
    const currentRequest: EffectiveRuntimeRequestV1 = {
      ...storedRequest,
      ...request,
      chatId: expected.chatId,
      target: storedRequest.target,
      requestEpoch: expected.requestEpoch,
      logicalConnectionId: expected.logicalConnectionId,
      presetId: expected.presetId,
      forcePresetId: storedRequest.forcePresetId === true,
      // Preserve only the token's authenticated one-turn selector. Every
      // other policy input is re-resolved from current authority below. A
      // resolved Agentic mode is not itself transient turn authority.
      transientSelection: storedRuntimePolicy.transientSelection,
    };
    delete currentRequest.mode;
    const readinessVector = request.readinessVector ?? storedRequest.readinessVector;
    const currentRequestForResolve = readinessVector === undefined
      ? currentRequest
      : { ...currentRequest, readinessVector };
    const current = await this.resolve(
      userId,
      currentRequestForResolve,
      {
        issueToken: false,
        frozenRootConnection: storedRoot,
        frozenChildConnections: stored.decision.childConnections,
      },
    );
    if (current.effectiveMode !== "agentic" || !current.internal.rootConnection) {
      return consumeRefreshRejection("effective_mode");
    }
    const currentBinding = current.internal.binding;
    const bindingMismatch = consumeBindingMismatch(
      currentBinding,
      expected,
      current.internal.runtimePolicy,
      storedRuntimePolicy,
      current.internal.rootConnection,
      storedRoot,
    );
    if (bindingMismatch) return consumeRefreshRejection(bindingMismatch);
    const expectedChildren = stored.decision.childConnections;
    const currentChildren = current.internal.childConnections;
    const expectedChildIds = Object.keys(expectedChildren);
    const currentChildIds = Object.keys(currentChildren);
    if (expectedChildIds.length !== currentChildIds.length
      || expectedChildIds.some((profileId) => !sameFrozenConnection(expectedChildren[profileId], currentChildren[profileId]))) {
      return consumeRefreshRejection("child_connections");
    }
    return { accepted: true, code: "accepted", decision: current };
  }
  /**
   * Atomically claim a one-use token without interpreting a generation target.
   * Unsupported surfaces use this authority before rejecting, so they cannot
   * leave a valid Agentic decision replayable or manufacture a supported target.
   */
  claim(userId: string, token: string): boolean {
    return this.tokenStore.consume(userId, token) !== null;
  }

  getChatAgentModeOverride(userId: string, chatId: string): ChatAgentModeOverrideV1 | null {
    return this.dependencies.getChatAgentModeOverride(userId, chatId);
  }

  setChatAgentModeOverride(
    userId: string,
    chatId: string,
    mode: AgentRuntimeMode | null,
    expectedRevision?: number,
  ): ChatAgentModeWriteResponseV1 & { appliesTo: "next_turn" } {
    if (mode !== null && !isAgentRuntimeMode(mode)) {
      throw new RuntimeDecisionError("invalid_request", "mode must be 'response' or 'agentic'", 400);
    }
    if (expectedRevision === undefined || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new RuntimeDecisionError("invalid_request", "Chat agent mode expectedRevision is required (use 0 for the first write).", 428);
    }
    if (expectedRevision >= Number.MAX_SAFE_INTEGER) {
      throw new RuntimeDecisionError("invalid_request", "Chat agent mode revision is exhausted; refresh and try again.", 409);
    }
    const updated = this.dependencies.setChatAgentModeOverride(userId, chatId, mode, expectedRevision);
    return { ...updated, appliesTo: "next_turn" };
  }

  resetChatAgentModeOverride(userId: string, chatId: string, expectedRevision: number): ChatAgentModeWriteResponseV1 & { appliesTo: "next_turn" } {
    return this.setChatAgentModeOverride(userId, chatId, null, expectedRevision);
  }

  configureDependencies(overrides: Partial<RuntimeDecisionDependencies>): void {
    if (this.dependenciesConfigured || (this.dependencyUseStarted && !this.startsWithDefaultDependencies)) {
      throw new RuntimeDecisionError("invalid_request", "Runtime decision dependencies are already installed.", 409);
    }
    const next = { ...this.dependencies } as RuntimeDecisionDependencies;
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
    }
    this.dependencies = next;
    this.dependenciesConfigured = true;
  }

  resetTokensForTests(): void {
    this.tokenStore.clear();
  }
}
/** Install startup-owned snapshot/readiness/config authorities before serving requests. */
export function configureAgentRuntimeDecisionDependencies(
  dependencies: Partial<RuntimeDecisionDependencies>,
): void {
  AGENT_RUNTIME_DECISION_SERVICE.configureDependencies(dependencies);
}


export const AGENT_RUNTIME_DECISION_SERVICE = new AgentRuntimeDecisionService();

export async function resolveEffectiveRuntime(userId: string, request: EffectiveRuntimeRequestV1): Promise<EffectiveRuntimeDecisionV1> {
  return AGENT_RUNTIME_DECISION_SERVICE.resolve(userId, request);
}
export async function resolveEffectiveRuntimeWithoutToken(
  userId: string,
  request: EffectiveRuntimeRequestV1,
): Promise<EffectiveRuntimeDecisionV1> {
  return AGENT_RUNTIME_DECISION_SERVICE.resolve(userId, request, { issueToken: false });
}

export function resetChatAgentModeOverride(
  userId: string,
  chatId: string,
  expectedRevision: number,
): ChatAgentModeWriteResponseV1 & { appliesTo: "next_turn" } {
  return AGENT_RUNTIME_DECISION_SERVICE.resetChatAgentModeOverride(userId, chatId, expectedRevision);
}

export function acknowledgeRuntimeRepair(
  userId: string,
  presetId: string,
  expectedPresetRevision: RuntimeRevision,
  reasonCode: string,
): RuntimeRepairAcknowledgementV1 {
  return AGENT_RUNTIME_DECISION_SERVICE.acknowledgeRuntimeRepair(
    userId,
    presetId,
    expectedPresetRevision,
    reasonCode,
  );
}

export async function consumeRuntimeDecisionToken(
  userId: string,
  token: string,
  request: EffectiveRuntimeRequestV1,
): Promise<RuntimeDecisionTokenConsumptionV1> {
  return AGENT_RUNTIME_DECISION_SERVICE.consume(userId, token, request);
}

export function claimRuntimeDecisionToken(userId: string, token: string): boolean {
  return AGENT_RUNTIME_DECISION_SERVICE.claim(userId, token);
}

export function toPublicRuntimeDecision(decision: EffectiveRuntimeDecisionV1): EffectiveRuntimePublicResponseV1 {
  return safePublicResponse(decision);
}

function assertClosedObject(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new RuntimeDecisionError("invalid_request", `${path}.${key} is not allowed`, 400);
  }
}

function readAliasedField(
  object: Record<string, unknown>,
  names: readonly string[],
  path: string,
): { present: boolean; value: unknown } {
  const present = names.filter((name) => Object.hasOwn(object, name));
  if (present.length > 1) {
    const first = stableStringify(object[present[0]]);
    if (present.some((name) => stableStringify(object[name]) !== first)) {
      throw new RuntimeDecisionError("invalid_request", `${path} has conflicting aliases`, 400);
    }
  }
  return present.length === 0
    ? { present: false, value: undefined }
    : { present: true, value: object[present[0]] };
}
function parseStrictString(value: unknown, path: string, nullable = true): string | null | undefined {
  if (value === undefined) throw new RuntimeDecisionError("invalid_request", `${path} is required`, 400);
  if (value === null) {
    if (nullable) return null;
    throw new RuntimeDecisionError("invalid_request", `${path} must be a string`, 400);
  }
  if (typeof value !== "string") throw new RuntimeDecisionError("invalid_request", `${path} must be a string`, 400);
  const result = value.trim();
  if (result.length === 0 || result.length > SAFE_STRING_MAX) {
    throw new RuntimeDecisionError("invalid_request", `${path} must be a non-empty bounded string`, 400);
  }
  return result;
}

function parseStrictRevision(value: unknown, path: string, nullable = true): RuntimeRevision | null {
  if (value === undefined) throw new RuntimeDecisionError("invalid_request", `${path} is required`, 400);
  if (value === null) {
    if (nullable) return null;
    throw new RuntimeDecisionError("invalid_request", `${path} must be a revision`, 400);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RuntimeDecisionError("invalid_request", `${path} must be a non-negative safe integer revision`, 400);
    }
    return value;
  }
  if (typeof value === "string") {
    if (value.length === 0 || value.length > SAFE_STRING_MAX) throw new RuntimeDecisionError("invalid_request", `${path} must be a bounded revision`, 400);
    if (/^[+-]?\d+$/.test(value)) {
      const numeric = Number(value);
      if (!Number.isSafeInteger(numeric) || numeric < 0) {
        throw new RuntimeDecisionError("invalid_request", `${path} must be a non-negative safe integer revision`, 400);
      }
    }
    return value;
  }
  throw new RuntimeDecisionError("invalid_request", `${path} must be a revision`, 400);
}
function parseStrictTransientSelection(value: unknown, path: string): LoomRuntimePolicyTransientSelectionV1 | null | undefined {
  if (value === undefined) throw new RuntimeDecisionError("invalid_request", `${path} is required`, 400);
  if (value === null) return null;
  if (!isRecord(value)) throw new RuntimeDecisionError("runtime_policy_invalid", `${path} must be an object`, 400, "loom_policy_invalid");
  assertClosedObject(value, ["mode", "turnFence", "authenticated"], path);
  const mode = parseStrictString(value.mode, `${path}.mode`, false);
  if (!isAgentRuntimeMode(mode) || value.authenticated !== true) {
    throw new RuntimeDecisionError("runtime_policy_invalid", `${path} is invalid`, 400, "loom_policy_invalid");
  }
  return {
    mode,
    turnFence: parseStrictRevision(value.turnFence, `${path}.turnFence`, false) as RuntimeRevision,
    authenticated: true,
  };
}

function parseStrictSwipe(value: unknown, path: string): number | null {
  if (value === undefined) throw new RuntimeDecisionError("invalid_request", `${path} is required`, 400);
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeDecisionError("invalid_request", `${path} must be a non-negative safe integer`, 400);
  }
  return value;
}

function parseStrictPartialInputRevisions(value: unknown, path: string): Partial<InputRevisionSetV1> | null | undefined {
  if (value === undefined) throw new RuntimeDecisionError("invalid_request", `${path} is required`, 400);
  if (value === null) return null;
  if (!isRecord(value)) throw new RuntimeDecisionError("invalid_request", `${path} must be an object`, 400);
  assertClosedObject(value, INPUT_REVISION_KEYS, path);
  const result: Partial<InputRevisionSetV1> = {};
  for (const key of INPUT_REVISION_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    result[key] = parseStrictRevision(value[key], `${path}.${key}`) as RuntimeRevision | null;
  }
  return result;
}

const READINESS_KEYS = [
  "schemaEpoch",
  "runtimeEpoch",
  "reconciliationEpoch",
  "archiveRegistryVersion",
  "isolateHealthEpoch",
  "publicationStoreHealthEpoch",
  "providerCapabilityRevision",
  "configRevision",
  "bindingRevision",
  "concreteConnectionRevision",
  "targetRevision",
  "inputRevisionDigest",
  "cognitionRevision",
  "killSwitchState",
  "ready",
  "reasons",
] as const;

function parseStrictReadinessVector(value: unknown, path: string): Partial<AgenticReadinessVectorV1> | null | undefined {
  if (value === undefined) throw new RuntimeDecisionError("invalid_request", `${path} is required`, 400);
  if (value === null) return null;
  if (!isRecord(value)) throw new RuntimeDecisionError("invalid_request", `${path} must be an object`, 400);
  assertClosedObject(value, READINESS_KEYS, path);
  const result: Partial<AgenticReadinessVectorV1> = {};
  for (const key of READINESS_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const field = value[key];
    if (key === "killSwitchState") {
      if (field !== "off" && field !== "auto" && field !== "on") throw new RuntimeDecisionError("invalid_request", `${path}.${key} is invalid`, 400);
      result[key] = field;
    } else if (key === "ready") {
      if (typeof field !== "boolean") throw new RuntimeDecisionError("invalid_request", `${path}.${key} must be boolean`, 400);
      result[key] = field;
    } else if (key === "reasons") {
      if (!Array.isArray(field) || field.length > 64 || field.some((reason) => typeof reason !== "string" || reason.length === 0 || reason.length > 256)) {
        throw new RuntimeDecisionError("invalid_request", `${path}.${key} is invalid`, 400);
      }
      result[key] = field.slice() as string[];
    } else if (key === "inputRevisionDigest") {
      result[key] = parseStrictString(field, `${path}.${key}`, false) as string;
    } else {
      result[key] = parseStrictRevision(field, `${path}.${key}`, false) as RuntimeRevision;
    }
  }
  return result;
}

export function normalizeEffectiveRuntimeRequest(raw: unknown): EffectiveRuntimeRequestV1 {
  if (!isRecord(raw)) throw new RuntimeDecisionError("invalid_request", "Request body must be an object", 400);
  const topLevelKeys = [
    "chatId", "chat_id", "logicalConnectionId", "connectionId", "connection_id",
    "presetId", "preset_id", "forcePresetId", "force_preset_id", "personaId", "persona_id",
    "targetCharacterId", "target_character_id", "generationType", "generation_type", "target",
    "mode", "transientSelection", "transient_selection", "requestEpoch", "request_epoch",
    "inputRevisions", "input_revision_set", "input_revisions", "readinessVector", "readiness_vector",
    "messageId", "message_id", "swipeId", "swipe_id",
  ] as const;
  assertClosedObject(raw, topLevelKeys, "request");

  const chatIdField = readAliasedField(raw, ["chatId", "chat_id"], "chatId");
  if (!chatIdField.present) throw new RuntimeDecisionError("invalid_request", "chatId is required", 400);
  const chatId = parseStrictString(chatIdField.value, "chatId", false) as string;
  const logicalConnection = readAliasedField(raw, ["logicalConnectionId", "connectionId", "connection_id"], "logicalConnectionId");
  const preset = readAliasedField(raw, ["presetId", "preset_id"], "presetId");
  const forcePreset = readAliasedField(raw, ["forcePresetId", "force_preset_id"], "forcePresetId");
  const persona = readAliasedField(raw, ["personaId", "persona_id"], "personaId");
  const targetCharacter = readAliasedField(raw, ["targetCharacterId", "target_character_id"], "targetCharacterId");
  const generation = readAliasedField(raw, ["generationType", "generation_type"], "generationType");
  const targetField = readAliasedField(raw, ["target"], "target");
  const mode = readAliasedField(raw, ["mode"], "mode");
  const requestEpoch = readAliasedField(raw, ["requestEpoch", "request_epoch"], "requestEpoch");
  const inputRevisions = readAliasedField(raw, ["inputRevisions", "input_revision_set", "input_revisions"], "inputRevisions");
  const readiness = readAliasedField(raw, ["readinessVector", "readiness_vector"], "readinessVector");
  const message = readAliasedField(raw, ["messageId", "message_id"], "messageId");
  const swipe = readAliasedField(raw, ["swipeId", "swipe_id"], "swipeId");
  const transient = readAliasedField(raw, ["transientSelection", "transient_selection"], "transientSelection");

  const parsedMode = mode.present ? parseStrictString(mode.value, "mode", false) : undefined;
  if (parsedMode !== undefined && !isAgentRuntimeMode(parsedMode)) {
    throw new RuntimeDecisionError("invalid_request", "mode must be 'response' or 'agentic'", 400);
  }
  const parsedTransientSelection = transient.present
    ? parseStrictTransientSelection(transient.value, "transientSelection")
    : undefined;
  const parsedRequestEpoch = requestEpoch.present
    ? parseStrictRevision(requestEpoch.value, "requestEpoch", false) as RuntimeRevision
    : undefined;
  if (mode.present && transient.present && (
    parsedTransientSelection == null
    || parsedTransientSelection.mode !== parsedMode
  )) {
    throw new RuntimeDecisionError("invalid_request", "mode conflicts with transientSelection", 400);
  }
  // Canonical normalized requests carry exactly one policy selector. `mode` is
  // accepted at the authenticated wire boundary, then serialized into the
  // explicit one-turn authority shape before any resolution or token storage.
  const canonicalTransientSelection = transient.present
    ? parsedTransientSelection
    : mode.present
      ? {
        mode: parsedMode as AgentRuntimeMode,
        turnFence: parsedRequestEpoch ?? DEFAULT_REVISION,
        authenticated: true as const,
      }
      : undefined;
  const parsedForcePreset = forcePreset.present
    ? (typeof forcePreset.value === "boolean"
      ? forcePreset.value
      : (() => { throw new RuntimeDecisionError("invalid_request", "forcePresetId must be boolean", 400); })())
    : undefined;
  const generationType = generation.present ? parseStrictString(generation.value, "generationType", false) : undefined;

  let target: GenerationTargetV1 | null | undefined;
  if (!targetField.present || targetField.value === null) {
    target = null;
  } else {
    if (!isRecord(targetField.value)) throw new RuntimeDecisionError("invalid_request", "target must be an object or null", 400);
    const targetRaw = targetField.value;
    assertClosedObject(targetRaw, ["generationType", "messageId", "message_id", "swipeId", "swipe_id", "branchId", "branch_id", "targetCharacterId", "target_character_id", "revision"], "target");
    const targetGeneration = readAliasedField(targetRaw, ["generationType"], "target.generationType");
    const targetMessage = readAliasedField(targetRaw, ["messageId", "message_id"], "target.messageId");
    const targetSwipe = readAliasedField(targetRaw, ["swipeId", "swipe_id"], "target.swipeId");
    const targetBranch = readAliasedField(targetRaw, ["branchId", "branch_id"], "target.branchId");
    const targetCharacterField = readAliasedField(targetRaw, ["targetCharacterId", "target_character_id"], "target.targetCharacterId");
    const targetRevision = readAliasedField(targetRaw, ["revision"], "target.revision");
    const targetGenerationValue = targetGeneration.present
      ? parseStrictString(targetGeneration.value, "target.generationType", false)
      : (generationType ?? "normal");
    const parsedTargetSwipe = targetSwipe.present
      ? parseStrictSwipe(targetSwipe.value, "target.swipeId")
      : (swipe.present ? parseStrictSwipe(swipe.value, "swipeId") : null);
    target = {
      generationType: targetGenerationValue as GenerationTargetV1["generationType"],
      messageId: targetMessage.present ? parseStrictString(targetMessage.value, "target.messageId") as string | null : (message.present ? parseStrictString(message.value, "messageId") as string | null : null),
      swipeId: parsedTargetSwipe as number | null,
      branchId: targetBranch.present ? parseStrictString(targetBranch.value, "target.branchId") as string | null : null,
      targetCharacterId: targetCharacterField.present
        ? parseStrictString(targetCharacterField.value, "target.targetCharacterId") as string | null
        : (targetCharacter.present ? parseStrictString(targetCharacter.value, "targetCharacterId") as string | null : null),
      revision: targetRevision.present ? parseStrictRevision(targetRevision.value, "target.revision") as RuntimeRevision | null : null,
    };
  }
  const parsedInputRevisions = inputRevisions.present
    ? parseStrictPartialInputRevisions(inputRevisions.value, "inputRevisions")
    : undefined;
  const parsedReadiness = readiness.present
    ? parseStrictReadinessVector(readiness.value, "readinessVector")
    : undefined;
  return {
    chatId,
    ...(logicalConnection.present
      ? { logicalConnectionId: parseStrictString(logicalConnection.value, "logicalConnectionId") as string | null }
      : {}),
    ...(preset.present
      ? { presetId: parseStrictString(preset.value, "presetId") as string | null }
      : {}),
    ...(forcePreset.present ? { forcePresetId: parsedForcePreset } : {}),
    ...(persona.present
      ? { personaId: parseStrictString(persona.value, "personaId") as string | null }
      : {}),
    ...(targetCharacter.present
      ? { targetCharacterId: parseStrictString(targetCharacter.value, "targetCharacterId") as string | null }
      : {}),
    ...(generation.present ? { generationType: generationType as EffectiveRuntimeRequestV1["generationType"] } : {}),
    target,
    ...((mode.present || transient.present) ? { transientSelection: canonicalTransientSelection } : {}),
    ...(requestEpoch.present ? { requestEpoch: parsedRequestEpoch } : {}),
    ...(inputRevisions.present ? { inputRevisions: parsedInputRevisions } : {}),
    ...(readiness.present ? { readinessVector: parsedReadiness } : {}),
  };
}
export function normalizeAuthenticatedEffectiveRuntimeRequest(raw: unknown): EffectiveRuntimeRequestV1 {
  if (isRecord(raw) && (Object.hasOwn(raw, "transientSelection") || Object.hasOwn(raw, "transient_selection"))) {
    throw new RuntimeDecisionError(
      "invalid_request",
      "transientSelection is authenticated by the generation request and cannot be supplied directly.",
      400,
    );
  }
  return normalizeEffectiveRuntimeRequest(raw);
}

export { publicConnection as toPublicConnectionProjection };
