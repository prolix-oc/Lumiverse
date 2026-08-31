/**
 * Authenticated, one-turn Agentic runtime decision contracts.
 *
 * These DTOs deliberately separate the public preflight projection from the
 * internal frozen decision.  A public response may identify a safe label and
 * revision, but it must never carry a credential reference, endpoint, or
 * trust-domain fingerprint.
 */

import type { ResolvedCouncilProfile } from "./council-profile";
import type { LoomPromptInspectionV1, LoomResponsePolicyOmissionV1 } from "./agent-cognition";

export const AGENT_RUNTIME_DECISION_VERSION = 1 as const;
export const AGENT_RUNTIME_DECISION_TOKEN_TTL_MS = 60_000;
export const AGENT_RUNTIME_DECISION_MAX_LIVE_PER_USER = 16;
export const AGENT_RUNTIME_DECISION_MAX_LIVE_PROCESS = 512;

export const AGENTIC_GENERATION_TYPES = [
  "normal",
  "continue",
  "regenerate",
  "swipe",
] as const;

export type AgenticGenerationType = (typeof AGENTIC_GENERATION_TYPES)[number];
export type AgentRuntimeMode = "response" | "agentic";
export type RuntimeRevision = string | number;
export const LOOM_RUNTIME_POLICY_VERSION = 1 as const;
export const LOOM_RUNTIME_POLICY_SOURCES = [
  "authenticated_one_turn",
  "durable_chat_override",
  "reviewed_preset_default",
  "response_fallback",
  "host_cap",
  "host_rejected",
] as const;
export const LOOM_RUNTIME_POLICY_SCOPES = ["turn", "chat", "preset", "fallback", "host"] as const;
export const LOOM_RUNTIME_POLICY_AVAILABILITY = [
  "available",
  "unavailable",
  "stale",
  "invalid",
  "denied",
  "omitted",
] as const;

export type LoomRuntimePolicySourceV1 = (typeof LOOM_RUNTIME_POLICY_SOURCES)[number];
export type LoomRuntimePolicyScopeV1 = (typeof LOOM_RUNTIME_POLICY_SCOPES)[number];
export type LoomRuntimePolicyAvailabilityStateV1 = (typeof LOOM_RUNTIME_POLICY_AVAILABILITY)[number];

export interface LoomRuntimePolicyCapV1 {
  authority: "host";
  allowedModes: readonly AgentRuntimeMode[];
  reasonCode: AgentRuntimeRepairCode | null;
}

export interface LoomRuntimePolicyAvailabilityV1 {
  state: LoomRuntimePolicyAvailabilityStateV1;
  reasonCode: AgentRuntimeRepairCode | null;
}

export interface LoomRuntimePolicyTransientSelectionV1 {
  mode: AgentRuntimeMode;
  turnFence: RuntimeRevision;
  authenticated: true;
}

export interface LoomRuntimePolicyDurableChatOverrideV1 {
  mode: AgentRuntimeMode | null;
  revision: number;
  state: "ready" | "review_required" | "repair_required";
  reviewCode: string | null;
  acknowledged: boolean;
}

export interface LoomRuntimePolicyRepairAcknowledgementV1 {
  state: "not_required" | "required" | "acknowledged";
  presetRevision: RuntimeRevision | null;
  reasonCode: string | null;
  acknowledgedAt: number | null;
}

export interface LoomRuntimePolicyV1 {
  version: typeof LOOM_RUNTIME_POLICY_VERSION;
  authoredValue: AgentRuntimeMode;
  effectiveValue: AgentRuntimeMode;
  source: LoomRuntimePolicySourceV1;
  scope: LoomRuntimePolicyScopeV1;
  cap: LoomRuntimePolicyCapV1;
  availability: LoomRuntimePolicyAvailabilityV1;
  presetRevision: RuntimeRevision | null;
  transientSelection: LoomRuntimePolicyTransientSelectionV1 | null;
  durableChatOverride: LoomRuntimePolicyDurableChatOverrideV1 | null;
  repairAcknowledgement: LoomRuntimePolicyRepairAcknowledgementV1;
  nextTurnOnly: true;
}
export const AGENT_RUNTIME_POLICY_REPAIR_CODES = [
  "loom_policy_invalid",
  "loom_policy_unavailable",
  "loom_policy_stale",
  "loom_policy_authority_widening",
  "loom_policy_repair_required",
] as const;



export const AGENT_RUNTIME_CAPABILITY_REQUIREMENTS = [
  "generation",
  "streaming",
  "tool_calling",
  "native_tool_continuation",
  "tools_disabled_finalization",
] as const;

export type AgentRuntimeCapabilityRequirement =
  (typeof AGENT_RUNTIME_CAPABILITY_REQUIREMENTS)[number];

export const AGENT_RUNTIME_REPAIR_CODES = [
  "agent_config_missing",
  "agent_config_disabled",
  "agent_config_review_required",
  "agent_config_repair_required",
  "agentic_mode_not_allowed",
  "agentic_slot_unresolved",
  "agentic_slot_stale",
  "agentic_capability_missing_generation",
  "agentic_capability_missing_streaming",
  "agentic_capability_missing_tool_calling",
  "agentic_capability_missing_native_tool_continuation",
  "agentic_capability_missing_tools_disabled_finalization",
  "agentic_domain_mismatch",
  "agentic_generation_type_unsupported",
  "agentic_target_unsupported",
  "agentic_input_revisions_incomplete",
  "agentic_readiness_unavailable",
  "agentic_kill_switch",
  "schema_unavailable",
  "reconciliation_required",
  "archive_registry_unavailable",
  "isolate_unavailable",
  "publication_store_unavailable",
  "provider_capability_unavailable",
  "input_revisions_incomplete",
  "kill_switch_off",
  "cognition_invalid",
  "cognition_repair_required",
  "cognition_missing_block_revision",
  "cognition_missing_pack_revision",
  "cognition_deleted_attachment",
  "cognition_predicate_limit_exceeded",
  "cognition_authorization_stale",
  "cognition_import_review_required",
  "cognition_foreign_authority_blocked",
  "agentic_connection_unavailable",
  "agentic_response_escape",
  "decision_capacity_exceeded",
  "decision_refresh_required",
  "loom_policy_invalid",
  "loom_policy_unavailable",
  "loom_policy_stale",
  "loom_policy_authority_widening",
  "loom_policy_repair_required",
] as const;

export type AgentRuntimeRepairCode = (typeof AGENT_RUNTIME_REPAIR_CODES)[number];

/** The target identity must be frozen before preflight can issue a token. */
export interface GenerationTargetV1 {
  generationType: AgenticGenerationType;
  messageId?: string | null;
  swipeId?: number | null;
  branchId?: string | null;
  targetCharacterId?: string | null;
  revision?: RuntimeRevision | null;
}

/**
 * Every member is intentionally named rather than represented by a metadata
 * bag.  `null` is meaningful: it records that an optional entity is absent in
 * the frozen snapshot, while `undefined` means the snapshot was incomplete.
 */
export interface InputRevisionSetV1 {
  target: RuntimeRevision | null;
  chat: RuntimeRevision | null;
  message: RuntimeRevision | null;
  preset: RuntimeRevision | null;
  block: RuntimeRevision | null;
  config: RuntimeRevision | null;
  binding: RuntimeRevision | null;
  connection: RuntimeRevision | null;
  endpoint: RuntimeRevision | null;
  credential: RuntimeRevision | null;
  persona: RuntimeRevision | null;
  character: RuntimeRevision | null;
  group: RuntimeRevision | null;
  world: RuntimeRevision | null;
  lore: RuntimeRevision | null;
  settings: RuntimeRevision | null;
  macro: RuntimeRevision | null;
  regex: RuntimeRevision | null;
  cognition: RuntimeRevision | null;
  readiness: RuntimeRevision | null;
}

/**
 * Closed runtime readiness vector. Production resolution fills every field
 * from installed authorities; the canonical encoder in
 * agent-cognition-integrity.service.ts hashes these exact keys in order so
 * decision tokens invalidate when any component revision or readiness flag
 * changes.
 */
export interface AgenticReadinessVectorV1 {
  schemaEpoch: RuntimeRevision;
  runtimeEpoch: RuntimeRevision;
  reconciliationEpoch: RuntimeRevision;
  archiveRegistryVersion: RuntimeRevision;
  isolateHealthEpoch: RuntimeRevision;
  publicationStoreHealthEpoch: RuntimeRevision;
  providerCapabilityRevision: RuntimeRevision;
  configRevision: RuntimeRevision;
  bindingRevision: RuntimeRevision;
  concreteConnectionRevision: RuntimeRevision;
  targetRevision: RuntimeRevision;
  inputRevisionDigest: string;
  cognitionRevision: RuntimeRevision;
  killSwitchState: "off" | "auto" | "on";
  ready: boolean;
  reasons: readonly string[];
}

export interface EffectiveRuntimeRequestV1 {
  chatId: string;
  logicalConnectionId?: string | null;
  presetId?: string | null;
  forcePresetId?: boolean;
  personaId?: string | null;
  targetCharacterId?: string | null;
  generationType?: AgenticGenerationType | string;
  target?: GenerationTargetV1 | null;
  mode?: AgentRuntimeMode;
  transientSelection?: LoomRuntimePolicyTransientSelectionV1 | null;
  requestEpoch?: RuntimeRevision;
  inputRevisions?: Partial<InputRevisionSetV1> | null;
  readinessVector?: Partial<AgenticReadinessVectorV1> | null;
}

export interface SafeConnectionProjectionV1 {
  /** Local logical ID is safe to return to the authenticated owner. */
  id: string | null;
  label: string | null;
  provider: string | null;
  model: string | null;
  revision: RuntimeRevision | null;
  endpointRevision: RuntimeRevision | null;
  credentialRevision: RuntimeRevision | null;
  candidateRevision: RuntimeRevision | null;
}

export interface SafePresetProjectionV1 {
  id: string | null;
  label: string | null;
  revision: RuntimeRevision | null;
  source: "chat" | "persona" | "character" | "connection" | "default" | "forced" | "none";
}

export interface CapabilityReadinessV1 {
  ready: boolean;
  sameDomain: boolean;
  required: readonly AgentRuntimeCapabilityRequirement[];
  missing: readonly AgentRuntimeCapabilityRequirement[];
  repairCodes: readonly AgentRuntimeRepairCode[];
  responseEscape: "available";
}
export interface ChatAgentModeOverrideV1 {
  mode: AgentRuntimeMode | null;
  revision: number;
  state: "ready" | "review_required" | "repair_required";
  reviewCode?: string | null;
  acknowledged?: boolean;
}

/** Authenticated public response for POST /api/v1/generate/effective-runtime. */
export interface EffectiveRuntimePublicResponseV1 {
  version: typeof AGENT_RUNTIME_DECISION_VERSION;
  chatId: string;
  target: GenerationTargetV1;
  connection: SafeConnectionProjectionV1;
  preset: SafePresetProjectionV1;
  agentsEnabled: boolean;
  allowedModes: readonly AgentRuntimeMode[];
  defaultMode: AgentRuntimeMode;
  requestedMode: AgentRuntimeMode;
  effectiveMode: AgentRuntimeMode;
  runtimePolicy: LoomRuntimePolicyV1;
  /** Authenticated preflight projection of the frozen Loom surface. */
  inspection: LoomPromptInspectionV1;
  /** Response omission is a separate top-level field for effective-runtime consumers. */
  responseOmission: LoomResponsePolicyOmissionV1 | null;
  chatOverride: ChatAgentModeOverrideV1 | null;
  capabilityReadiness: CapabilityReadinessV1;
  repairCodes: readonly AgentRuntimeRepairCode[];
  runtimeDecisionToken: string | null;
  runtimeDecisionExpiresAt: number | null;
}

/** Internal concrete candidate. Never serialize this object as an API DTO. */
export interface FrozenConcreteConnectionV1 {
  logicalId: string | null;
  concreteId: string | null;
  label: string | null;
  provider: string | null;
  model: string | null;
  /** Canonical normalized endpoint captured with the concrete candidate. */
  effectiveEndpoint: string | null;
  endpointRevision: RuntimeRevision | null;
  credentialSecretRef: string | null;
  credentialRevision: RuntimeRevision | null;
  candidateRevision: RuntimeRevision | null;
  revision: RuntimeRevision | null;
  fingerprint: string | null;
  /**
   * Digest of the canonical, normalized capability object admitted with this
   * candidate. It prevents an adapter capability mutation from reusing a
   * token whose endpoint and credential revisions are otherwise unchanged.
   */
  capabilityDigest: string;
  capabilities: Readonly<Record<string, unknown>>;
}

export interface RuntimeDecisionBindingV1 {
  userId: string;
  chatId: string;
  turnFence?: RuntimeRevision;
  targetDigest: string;
  requestEpoch: RuntimeRevision;
  logicalConnectionId: string | null;
  concreteConnectionId: string | null;
  provider: string | null;
  model: string | null;
  fingerprint: string | null;
  capabilityDigest: string | null;
  candidateRevision: RuntimeRevision | null;
  credentialRevision: RuntimeRevision | null;
  endpointRevision: RuntimeRevision | null;
  presetId: string | null;
  configRevision: RuntimeRevision | null;
  bindingRevision: RuntimeRevision | null;
  inputRevisionDigest: string;
  readinessDigest: string;
}
export interface RuntimeDecisionInternalV1 {
  binding: RuntimeDecisionBindingV1;
  rootConnection: FrozenConcreteConnectionV1 | null;
  childConnections: Readonly<Record<string, FrozenConcreteConnectionV1>>;
  /**
   * The exact normalized V2 config admitted with the decision. This is
   * private, in-memory authority; public DTOs and tokens never expose it.
   */
  configSnapshot?: unknown;
  /** Frozen host-resolved Council profile; never part of public DTOs/tokens. */
  councilProfile?: Readonly<ResolvedCouncilProfile>;
  /** Concrete sidecar connection identity resolved with the decision. */
  councilConnection?: FrozenConcreteConnectionV1 | null;
  runtimePolicy?: LoomRuntimePolicyV1;
  readinessVector: AgenticReadinessVectorV1;
  issuedAt: number;
  expiresAt: number;
}


export interface EffectiveRuntimeDecisionV1 extends EffectiveRuntimePublicResponseV1 {
  /** Internal-only frozen fields. Routes must call `toPublicRuntimeDecision`. */
  internal: RuntimeDecisionInternalV1;
}

export type RuntimeDecisionRefreshMismatchV1 =
  | "effective_mode"
  | "root_connection"
  | "user_id"
  | "chat_id"
  | "target_digest"
  | "request_epoch"
  | "turn_fence"
  | "logical_connection_id"
  | "concrete_connection_id"
  | "provider"
  | "model"
  | "fingerprint"
  | "capability_digest"
  | "candidate_revision"
  | "credential_revision"
  | "endpoint_revision"
  | "preset_id"
  | "config_revision"
  | "binding_revision"
  | "input_revision_digest"
  | "readiness_digest"
  | "runtime_policy"
  | "child_connections";

export interface RuntimeDecisionTokenConsumptionV1 {
  accepted: boolean;
  code: "accepted" | "decision_refresh_required";
  decision: EffectiveRuntimeDecisionV1 | null;
  /** Present only when a live re-resolve disagrees with the issued binding. */
  mismatch?: RuntimeDecisionRefreshMismatchV1;
}

export interface ChatAgentModeWriteV1 {
  action?: "set" | "reset";
  mode: AgentRuntimeMode | null;
  expectedRevision: number;
}

export interface ChatAgentModeResetV1 {
  action: "reset";
  expectedRevision: number;
}

export interface ChatAgentModeWriteResponseV1 {
  chatId: string;
  mode: AgentRuntimeMode | null;
  revision: number;
  state: ChatAgentModeOverrideV1["state"];
}

export function isAgenticGenerationType(value: unknown): value is AgenticGenerationType {
  return typeof value === "string" && (AGENTIC_GENERATION_TYPES as readonly string[]).includes(value);
}

export function isAgentRuntimeMode(value: unknown): value is AgentRuntimeMode {
  return value === "response" || value === "agentic";
}

export function isCapabilityRequirement(value: unknown): value is AgentRuntimeCapabilityRequirement {
  return typeof value === "string"
    && (AGENT_RUNTIME_CAPABILITY_REQUIREMENTS as readonly string[]).includes(value);
}
