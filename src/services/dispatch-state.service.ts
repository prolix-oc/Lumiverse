import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import type { ConnectionProfile } from "../types/connection-profile";

const DISPATCH_SCHEMA = "lumiverse.dispatch-state";
const DISPATCH_SCHEMA_VERSION = 2;
const EMPTY_DESCRIPTOR_DIGEST = "";
const SHA256_HEX = /^[a-f0-9]{64}$/;
const OPAQUE_REVISION = /^[A-Za-z0-9_-]{43}$/;

declare const dispatchRevisionBrand: unique symbol;

/** An opaque, host-issued dispatch revision. Callers must treat it as a token. */
export type DispatchRevision = string & { readonly [dispatchRevisionBrand]: true };

export type DispatchSourceKind = "main" | "slot";
export type DispatchKind = "concrete";

export type DispatchStateErrorCode =
  | "DISPATCH_SCHEMA_MISSING"
  | "DISPATCH_USER_NOT_FOUND"
  | "DISPATCH_SOURCE_INVALID"
  | "DISPATCH_CONNECTION_NOT_FOUND"
  | "DISPATCH_CONNECTION_UNRESOLVED"
  | "DISPATCH_CONNECTION_ROULETTE_UNSUPPORTED"
  | "DISPATCH_PRESET_NOT_FOUND"
  | "DISPATCH_DESCRIPTOR_INVALID"
  | "DISPATCH_REVISION_REQUIRED"
  | "DISPATCH_REVISIONLESS"
  | "DISPATCH_REVISION_STALE"
  | "DISPATCH_ASYNC_TRANSACTION";

export class DispatchStateError extends Error {
  readonly code: DispatchStateErrorCode;
  readonly expectedDispatchRevision: string | null;
  readonly actualDispatchRevision: string | null;

  constructor(
    code: DispatchStateErrorCode,
    message: string,
    details: {
      expectedDispatchRevision?: string | null;
      actualDispatchRevision?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "DispatchStateError";
    this.code = code;
    this.expectedDispatchRevision = details.expectedDispatchRevision ?? null;
    this.actualDispatchRevision = details.actualDispatchRevision ?? null;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface DispatchState {
  readonly userId: string;
  readonly baseToken: string;
  /** A state epoch that separates accepted writes, including a return to old values. */
  readonly generation: number;
  readonly revision: number;
  /** Stable digest of the most recently reconciled effective descriptor. */
  readonly descriptorDigest: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Opaque state token; effective source revisions also include source and inputs. */
  readonly dispatchRevision: DispatchRevision | null;
}

export type DispatchStateRow = DispatchState;

export interface DispatchStateMutation {
  readonly descriptorDigest?: string;
  readonly expectedDispatchRevision?: string | DispatchRevision | null;
  readonly expectedRevision?: string | DispatchRevision | null;
  readonly incrementGeneration?: boolean;
  readonly rotateBaseToken?: boolean;
}

export interface EncryptedSecretTuple {
  readonly key: string;
  readonly encryptedValue: string;
  readonly iv: string;
  readonly tag: string;
  readonly updatedAt: number;
}

export interface DispatchConnectionDigestMaterial {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly apiUrl: string;
  readonly endpointOrigin: string;
  readonly presetId: string | null;
  readonly isDefault: boolean;
  readonly hasApiKey: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly dispatchKind: DispatchKind | "roulette";
  /** State base token is included even when all profile columns are unchanged. */
  readonly baseToken?: string;
}

export interface DispatchDescriptorDigestInput {
  readonly userId?: string;
  readonly source?: DispatchSourceKind;
  readonly stateEpoch?: Readonly<{ generation: number; revision: number }> | string | number | null;
  readonly baseToken?: string;
  readonly connection: DispatchConnectionDigestMaterial;
  /** Every owned profile column that can affect effective provider dispatch. */
  readonly profile?: Readonly<Record<string, unknown>> | null;
  /** Every selected preset column and decoded JSON field that can affect dispatch. */
  readonly preset?: Readonly<Record<string, unknown>> | null;
  readonly reasoning?: unknown;
  readonly settings?: unknown;
  /** Ciphertext tuple only; plaintext API keys never enter this authority. */
  readonly encryptedSecret?: EncryptedSecretTuple | null;
}

export interface DispatchDescriptorResolutionInput {
  readonly source: DispatchSourceKind;
  /** Host-owned Main selection or explicit slot id. */
  readonly connectionId?: string;
  readonly expectedConnectionDispatchRevision?: string | DispatchRevision | null;
  readonly expectedDispatchRevision?: string | DispatchRevision | null;
  readonly presetId?: string | null;
  readonly reasoning?: unknown;
  readonly settings?: unknown;
}

export interface ConnectionDispatchDescriptor {
  readonly connectionId: string;
  readonly connectionName: string;
  readonly provider: string;
  readonly model: string;
  readonly endpointOrigin: string;
  readonly dispatchKind: DispatchKind;
  readonly connectionDispatchRevision: DispatchRevision;
}

export interface ResolvedDispatchDescriptor {
  readonly source: DispatchSourceKind;
  readonly connectionId: string;
  readonly connection: Readonly<ConnectionProfile>;
  readonly descriptor: ConnectionDispatchDescriptor;
  readonly dispatchRevision: DispatchRevision;
  readonly descriptorDigest: string;
  readonly state: DispatchState;
}

export interface DispatchStateTransaction {
  read(): DispatchState;
  mutate(input: DispatchStateMutation): DispatchState;
  resolve(input: DispatchDescriptorResolutionInput): ResolvedDispatchDescriptor;
}

export interface EffectiveDispatchContext {
  /** Host-internal Main selection; worker payloads cannot provide this value. */
  readonly connectionId?: string | null;
  readonly presetId?: string | null;
  readonly reasoning?: unknown;
  readonly settings?: unknown;
}

interface DispatchStateDbRow {
  user_id: string;
  base_token: string;
  generation: number;
  revision: number;
  descriptor_digest: string;
  created_at: number;
  updated_at: number;
}

interface ConnectionProfileDbRow {
  id: string;
  name: string;
  provider: string;
  api_url: string;
  model: string;
  preset_id: string | null;
  is_default: number;
  metadata: string;
  has_api_key: number;
  created_at: number;
  updated_at: number;
}

interface PresetDbRow {
  id: string;
  name: string;
  provider: string;
  engine: string;
  parameters: string;
  prompt_order: string;
  prompts: string;
  metadata: string;
  cache_revision: number;
  created_at: number;
  updated_at: number;
}

interface SecretDbRow {
  key: string;
  encrypted_value: string;
  iv: string;
  tag: string;
  updated_at: number;
}

interface EffectiveDescriptorData {
  readonly profile: ConnectionProfileDbRow;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly presetId: string | null;
  readonly preset: PresetDbRow | null;
  readonly endpointOrigin: string;
  readonly secret: EncryptedSecretTuple | null;
  readonly digestInput: DispatchDescriptorDigestInput;
}

function assertUserId(userId: string): void {
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new DispatchStateError("DISPATCH_USER_NOT_FOUND", "A non-empty user id is required");
  }
}

function assertDispatchSchema(db: Database): void {
  const row = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_state'")
    .get() as { name: string } | null;
  if (!row) {
    throw new DispatchStateError(
      "DISPATCH_SCHEMA_MISSING",
      "dispatch_state migration has not been applied",
    );
  }
}

function assertOwnedUser(db: Database, userId: string): void {
  const row = db.query('SELECT id FROM "user" WHERE id = ?').get(userId) as { id: string } | null;
  if (!row) {
    throw new DispatchStateError("DISPATCH_USER_NOT_FOUND", `User ${userId} does not exist`);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  try {
    return typeof Reflect.get(value, "then") === "function";
  } catch {
    return false;
  }
}

function createOpaqueBaseToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Base64Url(value: string): DispatchRevision {
  const digest = createHash("sha256").update(value, "utf8").digest("base64").replace(/=+$/u, "").replace(/\+/gu, "-").replace(/\//gu, "_");
  return digest as DispatchRevision;
}

function assertOpaqueRevision(value: string, label: string): void {
  if (!OPAQUE_REVISION.test(value)) {
    throw new DispatchStateError("DISPATCH_DESCRIPTOR_INVALID", `${label} is not an opaque dispatch revision`);
  }
}

function dispatchRevisionForState(row: DispatchStateDbRow): DispatchRevision | null {
  if (row.revision <= 0) return null;
  const token = sha256Base64Url(canonicalJson({
    schema: DISPATCH_SCHEMA,
    schemaVersion: DISPATCH_SCHEMA_VERSION,
    kind: "state",
    baseToken: row.base_token,
    generation: row.generation,
    revision: row.revision,
    descriptorDigest: row.descriptor_digest,
  }));
  assertOpaqueRevision(token, "dispatch state revision");
  return token;
}

function stateFromRow(row: DispatchStateDbRow): DispatchState {
  if (
    typeof row.user_id !== "string" ||
    typeof row.base_token !== "string" ||
    row.base_token.length < 32 ||
    !Number.isInteger(row.generation) ||
    row.generation < 0 ||
    !Number.isInteger(row.revision) ||
    row.revision < 0 ||
    typeof row.descriptor_digest !== "string" ||
    (row.descriptor_digest !== "" && !SHA256_HEX.test(row.descriptor_digest)) ||
    !Number.isInteger(row.created_at) ||
    !Number.isInteger(row.updated_at)
  ) {
    throw new DispatchStateError("DISPATCH_DESCRIPTOR_INVALID", "dispatch_state contains an invalid row");
  }

  return Object.freeze({
    userId: row.user_id,
    baseToken: row.base_token,
    generation: row.generation,
    revision: row.revision,
    descriptorDigest: row.descriptor_digest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dispatchRevision: dispatchRevisionForState(row),
  });
}

function readStateFromDb(db: Database, userId: string): DispatchState | null {
  const row = db
    .query(
      `SELECT user_id, base_token, generation, revision, descriptor_digest, created_at, updated_at
       FROM dispatch_state
       WHERE user_id = ?`,
    )
    .get(userId) as DispatchStateDbRow | null;
  return row ? stateFromRow(row) : null;
}

function ensureStateInTransaction(db: Database, userId: string): DispatchState {
  assertDispatchSchema(db);
  assertOwnedUser(db, userId);
  const now = Math.floor(Date.now() / 1000);
  db
    .query(
      `INSERT OR IGNORE INTO dispatch_state
       (user_id, base_token, generation, revision, descriptor_digest, created_at, updated_at)
       VALUES (?, ?, 1, 0, ?, ?, ?)`,
    )
    .run(userId, createOpaqueBaseToken(), EMPTY_DESCRIPTOR_DIGEST, now, now);

  const state = readStateFromDb(db, userId);
  if (!state) {
    throw new DispatchStateError("DISPATCH_DESCRIPTOR_INVALID", "Unable to create dispatch_state row");
  }
  return state;
}

function normalizedExpectedRevision(
  input: Pick<DispatchStateMutation, "expectedDispatchRevision" | "expectedRevision">,
): string | null | undefined {
  if (input.expectedDispatchRevision !== undefined) return input.expectedDispatchRevision as string | null;
  if (input.expectedRevision !== undefined) return input.expectedRevision as string | null;
  return undefined;
}

function assertExpectedRevision(
  state: DispatchState,
  expected: string | DispatchRevision | null | undefined,
): void {
  if (expected === undefined || expected === null || typeof expected !== "string" || expected.trim().length === 0) {
    throw new DispatchStateError(
      "DISPATCH_REVISION_REQUIRED",
      "An exact expected dispatch revision is required before dispatch",
      { expectedDispatchRevision: expected ?? null, actualDispatchRevision: state.dispatchRevision },
    );
  }
  if (!state.dispatchRevision) {
    throw new DispatchStateError(
      "DISPATCH_REVISIONLESS",
      "The owned dispatch state has no revision",
      { expectedDispatchRevision: expected, actualDispatchRevision: null },
    );
  }
  if (state.dispatchRevision !== expected) {
    throw new DispatchStateError(
      "DISPATCH_REVISION_STALE",
      "The owned dispatch descriptor revision is stale",
      { expectedDispatchRevision: expected, actualDispatchRevision: state.dispatchRevision },
    );
  }
}

function assertExpectedResolvedRevision(
  expected: string | DispatchRevision | null | undefined,
  actual: DispatchRevision,
): void {
  if (expected === undefined || expected === null || typeof expected !== "string" || expected.trim().length === 0) {
    throw new DispatchStateError(
      "DISPATCH_REVISION_REQUIRED",
      "An exact expected dispatch revision is required before dispatch",
      { expectedDispatchRevision: expected ?? null, actualDispatchRevision: actual },
    );
  }
  if (expected !== actual) {
    throw new DispatchStateError(
      "DISPATCH_REVISION_STALE",
      "The owned dispatch descriptor revision is stale",
      { expectedDispatchRevision: expected, actualDispatchRevision: actual },
    );
  }
}

function assertDigest(digest: string): void {
  if (!SHA256_HEX.test(digest)) {
    throw new DispatchStateError("DISPATCH_DESCRIPTOR_INVALID", "descriptorDigest must be a lowercase SHA-256 digest");
  }
}

function mutateStateInTransaction(
  db: Database,
  userId: string,
  current: DispatchState,
  input: DispatchStateMutation,
): DispatchState {
  if (!input || typeof input !== "object") {
    throw new DispatchStateError("DISPATCH_DESCRIPTOR_INVALID", "A dispatch state mutation is required");
  }
  const expected = normalizedExpectedRevision(input);
  if (expected !== undefined) assertExpectedRevision(current, expected);

  if (input.descriptorDigest !== undefined) assertDigest(input.descriptorDigest);
  const digestChanged = input.descriptorDigest !== undefined && input.descriptorDigest !== current.descriptorDigest;
  const generationChanged = input.incrementGeneration === true || input.rotateBaseToken === true;
  const rotateBaseToken = input.rotateBaseToken === true;
  if (!digestChanged && !generationChanged) return current;

  const nextGeneration = current.generation + (generationChanged ? 1 : 0);
  const nextRevision = current.revision + 1;
  const nextBaseToken = rotateBaseToken ? createOpaqueBaseToken() : current.baseToken;
  const nextDigest = input.descriptorDigest ?? current.descriptorDigest;
  const now = Math.max(Math.floor(Date.now() / 1000), current.updatedAt);

  db
    .query(
      `UPDATE dispatch_state
       SET base_token = ?, generation = ?, revision = ?, descriptor_digest = ?, updated_at = ?
       WHERE user_id = ?`,
    )
    .run(nextBaseToken, nextGeneration, nextRevision, nextDigest, now, userId);

  const updated = readStateFromDb(db, userId);
  if (!updated) {
    throw new DispatchStateError("DISPATCH_DESCRIPTOR_INVALID", "Dispatch state disappeared during mutation");
  }
  return updated;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonValue(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new DispatchStateError("DISPATCH_DESCRIPTOR_INVALID", `${label} contains invalid JSON`);
  }
}

function parseJsonRecord(raw: string, label: string): Readonly<Record<string, unknown>> {
  const parsed = parseJsonValue(raw, label);
  if (!isRecord(parsed)) {
    throw new DispatchStateError("DISPATCH_DESCRIPTOR_INVALID", `${label} must be a JSON object`);
  }
  return parsed;
}

function effectiveEndpointOrigin(
  provider: string,
  rawUrl: string,
  metadata: Readonly<Record<string, unknown>>,
): string {
  const url = rawUrl.trim();
  if (provider === "nanogpt" && metadata.use_subscription_api === true) {
    if (!url) return "https://nano-gpt.com/api/subscription/v1";
    return url.replace("/api/v1", "/api/subscription/v1");
  }
  if (provider === "zai") {
    const fallback = metadata.use_coding_plan_endpoint === true ? "/api/coding/paas/v4" : "/api/paas/v4";
    if (!url) return `https://api.z.ai${fallback}`;
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
      if (pathname === "/v1" || pathname === "/api/paas/v4" || pathname === "/api/coding/paas/v4") {
        parsed.pathname = fallback;
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
      }
    } catch {
      return url;
    }
    return url;
  }
  if (provider === "google_vertex") {
    const region = typeof metadata.vertex_region === "string" ? metadata.vertex_region : "global";
    return !region || region === "global" ? "https://aiplatform.googleapis.com" : `https://${region}-aiplatform.googleapis.com`;
  }
  if (provider === "bedrock" && !url) {
    const region = typeof metadata.region === "string" && metadata.region.trim() ? metadata.region.trim() : "us-east-1";
    return metadata.bedrock_endpoint === "runtime"
      ? `https://bedrock-runtime.${region}.amazonaws.com/v1`
      : `https://bedrock-mantle.${region}.api.aws/v1`;
  }
  return url;
}

function connectionSecretKey(id: string): string {
  return `connection_${id}_api_key`;
}

function readConnectionProfile(
  db: Database,
  userId: string,
  input: DispatchDescriptorResolutionInput,
): ConnectionProfileDbRow {
  if (input.source !== "main" && input.source !== "slot") {
    throw new DispatchStateError("DISPATCH_SOURCE_INVALID", "Unknown dispatch source");
  }

  if (input.source === "main" && (!input.connectionId || input.connectionId.trim().length === 0)) {
    const rows = db
      .query(
        `SELECT id, name, provider, api_url, model, preset_id, is_default, metadata,
                has_api_key, created_at, updated_at
         FROM connection_profiles
         WHERE user_id = ? AND is_default = 1
         ORDER BY updated_at DESC, id ASC`,
      )
      .all(userId) as ConnectionProfileDbRow[];
    if (rows.length === 0) {
      throw new DispatchStateError("DISPATCH_CONNECTION_NOT_FOUND", "No owned Main connection profile is configured");
    }
    if (rows.length > 1) {
      throw new DispatchStateError("DISPATCH_CONNECTION_UNRESOLVED", "Multiple owned Main connection profiles are configured");
    }
    return rows[0];
  }

  if (typeof input.connectionId !== "string" || input.connectionId.trim().length === 0) {
    throw new DispatchStateError(
      "DISPATCH_SOURCE_INVALID",
      input.source === "slot"
        ? "The slot dispatch source requires a concrete connection id"
        : "The Main dispatch source requires an authoritative connection id when explicitly selected",
    );
  }

  const row = db
    .query(
      `SELECT id, name, provider, api_url, model, preset_id, is_default, metadata,
              has_api_key, created_at, updated_at
       FROM connection_profiles
       WHERE user_id = ? AND id = ?`,
    )
    .get(userId, input.connectionId.trim()) as ConnectionProfileDbRow | null;
  if (!row) {
    throw new DispatchStateError(
      "DISPATCH_CONNECTION_NOT_FOUND",
      `Owned connection profile ${input.connectionId} does not exist`,
    );
  }
  return row;
}

function readPreset(db: Database, userId: string, presetId: string | null): PresetDbRow | null {
  if (presetId === null) return null;
  const row = db
    .query(
      `SELECT id, name, provider, engine, parameters, prompt_order, prompts, metadata,
              cache_revision, created_at, updated_at
       FROM presets
       WHERE user_id = ? AND id = ?`,
    )
    .get(userId, presetId) as PresetDbRow | null;
  if (!row) {
    throw new DispatchStateError("DISPATCH_PRESET_NOT_FOUND", `Owned preset ${presetId} does not exist`);
  }
  return row;
}

function readEncryptedSecret(db: Database, userId: string, connectionId: string): EncryptedSecretTuple | null {
  const row = db
    .query(
      `SELECT key, encrypted_value, iv, tag, updated_at
       FROM secrets
       WHERE user_id = ? AND key = ?`,
    )
    .get(userId, connectionSecretKey(connectionId)) as SecretDbRow | null;
  if (!row) return null;
  return {
    key: row.key,
    encryptedValue: row.encrypted_value,
    iv: row.iv,
    tag: row.tag,
    updatedAt: row.updated_at,
  };
}

function effectiveDescriptorData(
  db: Database,
  userId: string,
  state: DispatchState,
  input: DispatchDescriptorResolutionInput,
): EffectiveDescriptorData {
  const profile = readConnectionProfile(db, userId, input);
  if (profile.provider === "model_roulette") {
    throw new DispatchStateError(
      "DISPATCH_CONNECTION_ROULETTE_UNSUPPORTED",
      "Roulette connection profiles cannot authorize a bound dispatch",
    );
  }

  const metadata = parseJsonRecord(profile.metadata, "connection metadata");
  const presetId = input.presetId !== undefined ? input.presetId : profile.preset_id;
  const preset = readPreset(db, userId, presetId);
  const endpointOrigin = effectiveEndpointOrigin(profile.provider, profile.api_url, metadata);
  const secret = readEncryptedSecret(db, userId, profile.id);
  const digestInput: DispatchDescriptorDigestInput = {
    userId,
    source: input.source,
    baseToken: state.baseToken,
    connection: {
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      model: profile.model,
      apiUrl: profile.api_url,
      endpointOrigin,
      presetId,
      isDefault: profile.is_default === 1,
      hasApiKey: profile.has_api_key === 1,
      metadata,
      dispatchKind: "concrete",
      baseToken: state.baseToken,
    },
    profile: {
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      apiUrl: profile.api_url,
      model: profile.model,
      presetId,
      isDefault: profile.is_default === 1,
      hasApiKey: profile.has_api_key === 1,
      metadata,
      createdAt: profile.created_at,
      updatedAt: profile.updated_at,
    },
    preset: preset
      ? {
          id: preset.id,
          name: preset.name,
          provider: preset.provider,
          engine: preset.engine,
          parameters: parseJsonValue(preset.parameters, "preset.parameters"),
          promptOrder: parseJsonValue(preset.prompt_order, "preset.prompt_order"),
          prompts: parseJsonValue(preset.prompts, "preset.prompts"),
          metadata: parseJsonRecord(preset.metadata, "preset.metadata"),
          cacheRevision: preset.cache_revision,
          createdAt: preset.created_at,
          updatedAt: preset.updated_at,
        }
      : null,
    reasoning: input.reasoning === undefined ? null : input.reasoning,
    settings: input.settings === undefined ? null : input.settings,
    encryptedSecret: secret,
  };
  return { profile, metadata, presetId, preset, endpointOrigin, secret, digestInput };
}

function resolvedDispatchRevision(
  state: DispatchState,
  source: DispatchSourceKind,
  data: EffectiveDescriptorData,
  descriptorDigest: string,
): DispatchRevision {
  const revision = sha256Base64Url(canonicalJson({
    schema: DISPATCH_SCHEMA,
    schemaVersion: DISPATCH_SCHEMA_VERSION,
    source,
    stateEpoch: {
      generation: state.generation,
      revision: state.revision,
    },
    baseToken: state.baseToken,
    descriptorDigest,
    effective: descriptorPayload(data.digestInput),
  }));
  assertOpaqueRevision(revision, "dispatch revision");
  return revision;
}

function resolveInsideTransaction(
  db: Database,
  userId: string,
  state: DispatchState,
  input: DispatchDescriptorResolutionInput,
): ResolvedDispatchDescriptor {
  if (!input || (input.source !== "main" && input.source !== "slot")) {
    throw new DispatchStateError("DISPATCH_SOURCE_INVALID", "Unknown dispatch source");
  }
  const effective = effectiveDescriptorData(db, userId, state, input);
  const descriptorDigest = computeDispatchDescriptorDigest(effective.digestInput);
  const dispatchRevision = resolvedDispatchRevision(state, input.source, effective, descriptorDigest);
  const expected = input.expectedConnectionDispatchRevision !== undefined
    ? input.expectedConnectionDispatchRevision
    : input.expectedDispatchRevision;
  if (expected !== undefined) assertExpectedResolvedRevision(expected, dispatchRevision);

  const descriptor: ConnectionDispatchDescriptor = Object.freeze({
    connectionId: effective.profile.id,
    connectionName: effective.profile.name,
    provider: effective.profile.provider,
    model: effective.profile.model,
    endpointOrigin: effective.endpointOrigin,
    dispatchKind: "concrete",
    connectionDispatchRevision: dispatchRevision,
  });
  const connection: Readonly<ConnectionProfile> = Object.freeze({
    id: effective.profile.id,
    name: effective.profile.name,
    provider: effective.profile.provider,
    api_url: effective.endpointOrigin,
    model: effective.profile.model,
    preset_id: effective.presetId,
    is_default: effective.profile.is_default === 1,
    has_api_key: effective.profile.has_api_key === 1,
    metadata: Object.freeze({ ...effective.metadata }),
    created_at: effective.profile.created_at,
    updated_at: effective.profile.updated_at,
  });
  return Object.freeze({
    source: input.source,
    connectionId: effective.profile.id,
    connection,
    descriptor,
    dispatchRevision,
    descriptorDigest,
    state,
  });
}

function descriptorPayload(input: DispatchDescriptorDigestInput): Record<string, unknown> {
  return {
    schema: DISPATCH_SCHEMA,
    schemaVersion: DISPATCH_SCHEMA_VERSION,
    userId: input.userId ?? null,
    source: input.source ?? null,
    stateEpoch: input.stateEpoch ?? null,
    baseToken: input.baseToken ?? input.connection.baseToken ?? null,
    connection: {
      id: input.connection.id,
      name: input.connection.name,
      provider: input.connection.provider,
      model: input.connection.model,
      apiUrl: input.connection.apiUrl,
      endpointOrigin: input.connection.endpointOrigin,
      presetId: input.connection.presetId,
      isDefault: input.connection.isDefault,
      hasApiKey: input.connection.hasApiKey,
      metadata: input.connection.metadata,
      dispatchKind: input.connection.dispatchKind,
      baseToken: input.connection.baseToken ?? null,
    },
    profile: input.profile === undefined ? { presence: "missing" } : input.profile,
    preset: input.preset === undefined ? { presence: "missing" } : input.preset,
    reasoning: input.reasoning === undefined ? { presence: "missing" } : input.reasoning,
    settings: input.settings === undefined ? { presence: "missing" } : input.settings,
    encryptedSecret: input.encryptedSecret === undefined || input.encryptedSecret === null
      ? { presence: "missing" }
      : {
          presence: "present",
          tuple: {
            key: input.encryptedSecret.key,
            encryptedValue: input.encryptedSecret.encryptedValue,
            iv: input.encryptedSecret.iv,
            tag: input.encryptedSecret.tag,
            updatedAt: input.encryptedSecret.updatedAt,
          },
        },
  };
}

function canonicalValue(value: unknown, seen: Set<object>): unknown {
  if (value === null) return null;
  if (value === undefined) return { type: "undefined" };
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { type: "number", value: "NaN" };
    if (value === Infinity) return { type: "number", value: "Infinity" };
    if (value === -Infinity) return { type: "number", value: "-Infinity" };
    if (Object.is(value, -0)) return { type: "number", value: "-0" };
    return value;
  }
  if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
  if (typeof value === "symbol") return { type: "symbol", value: String(value) };
  if (typeof value === "function") return { type: "function", value: value.name || "anonymous" };
  if (typeof value !== "object") return { type: typeof value, value: String(value) };
  if (seen.has(value)) throw new DispatchStateError("DISPATCH_DESCRIPTOR_INVALID", "Dispatch descriptor contains a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalValue(item, seen));
    const object = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) result[key] = canonicalValue(object[key], seen);
    return result;
  } finally {
    seen.delete(value);
  }
}

/** Stable insertion-order-independent JSON used by dispatch hooks and digesting. */
export function stableDispatchJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, new Set<object>()));
}

function canonicalJson(value: unknown): string {
  return stableDispatchJson(value);
}

/**
 * Stable SHA-256 over all effective owned dispatch inputs. The encrypted secret
 * tuple is ciphertext metadata only and explicitly distinguishes missing from
 * present, even when a present tuple contains empty strings.
 */
export function computeDispatchDescriptorDigest(input: DispatchDescriptorDigestInput): string {
  if (!input || !input.connection || input.connection.dispatchKind !== "concrete") {
    throw new DispatchStateError("DISPATCH_DESCRIPTOR_INVALID", "A concrete connection is required for a dispatch digest");
  }
  if (input.source !== undefined && input.source !== "main" && input.source !== "slot") {
    throw new DispatchStateError("DISPATCH_SOURCE_INVALID", "Unknown dispatch source");
  }
  return sha256Hex(canonicalJson(descriptorPayload(input)));
}

/** Read an existing state row without creating one. */
export function readDispatchState(userId: string): DispatchState | null {
  assertUserId(userId);
  const db = getDb();
  assertDispatchSchema(db);
  return readStateFromDb(db, userId);
}

/** Ensure a per-user state row and return it atomically. */
export function ensureDispatchState(userId: string): DispatchState {
  assertUserId(userId);
  return withDispatchStateTransaction(userId, (tx) => tx.read());
}

/** Read/create state through the same synchronous transaction authority used by mutations. */
export function readDispatchStateAtomic(userId: string): DispatchState {
  return withDispatchStateTransaction(userId, (tx) => tx.read());
}

function runDispatchStateOperation<T>(
  db: Database,
  userId: string,
  operation: (transaction: DispatchStateTransaction) => T,
): T {
  const initial = ensureStateInTransaction(db, userId);
  let current = initial;
  let pendingDescriptorDigest: string | undefined;
  const transaction: DispatchStateTransaction = {
    read: () => current,
    mutate: (input) => {
      const hasMutationIntent = input !== null
        && typeof input === "object"
        && (
          input.descriptorDigest !== undefined
          || input.incrementGeneration === true
          || input.rotateBaseToken === true
        );
      const mutation = pendingDescriptorDigest !== undefined
        && hasMutationIntent
        && input.descriptorDigest === undefined
        ? { ...input, descriptorDigest: pendingDescriptorDigest }
        : input;
      current = mutateStateInTransaction(db, userId, current, mutation);
      pendingDescriptorDigest = undefined;
      return current;
    },
    resolve: (input) => {
      const resolved = resolveInsideTransaction(db, userId, current, input);
      current = resolved.state;
      pendingDescriptorDigest = resolved.descriptorDigest;
      return resolved;
    },
  };
  const candidate = operation(transaction);
  if (isPromiseLike(candidate)) {
    throw new DispatchStateError(
      "DISPATCH_ASYNC_TRANSACTION",
      "Dispatch state transaction callbacks must be synchronous",
    );
  }
  return candidate;
}

/** Execute a synchronous operation under one SQLite transaction. */
export function withDispatchStateTransaction<T>(
  userId: string,
  operation: (transaction: DispatchStateTransaction) => T,
): T {
  assertUserId(userId);
  if (typeof operation !== "function") {
    throw new DispatchStateError("DISPATCH_DESCRIPTOR_INVALID", "A dispatch state transaction callback is required");
  }
  const db = getDb();
  let result!: T;
  db.transaction(() => {
    result = runDispatchStateOperation(db, userId, operation);
  })();
  return result;
}

/**
 * Run the same authority inside a transaction already owned by the caller.
 * No BEGIN/COMMIT is issued here; the callback remains strictly synchronous.
 */
export function withDispatchStateTransactionInExistingTransaction<T>(
  userId: string,
  operation: (transaction: DispatchStateTransaction) => T,
): T {
  assertUserId(userId);
  if (typeof operation !== "function") {
    throw new DispatchStateError("DISPATCH_DESCRIPTOR_INVALID", "A dispatch state transaction callback is required");
  }
  return runDispatchStateOperation(getDb(), userId, operation);
}

/** Mutate descriptor digest/revision/generation under the transaction authority. */
export function mutateDispatchStateAtomic(userId: string, input: DispatchStateMutation): DispatchState {
  return withDispatchStateTransaction(userId, (tx) => tx.mutate(input));
}

/** Resolve and reconcile the owned descriptor, returning the resulting state row. */
export function reconcileDispatchState(
  userId: string,
  input: DispatchDescriptorResolutionInput,
): DispatchState {
  return withDispatchStateTransaction(userId, (tx) => {
    const resolved = tx.resolve(input);
    return tx.mutate({ descriptorDigest: resolved.descriptorDigest });
  });
}

export const reconcileDispatchStateAtomic = reconcileDispatchState;

/** Resolve a concrete Main or slot descriptor; an expected revision is optional for inspection. */
export function resolveDispatchDescriptor(
  userId: string,
  input: DispatchDescriptorResolutionInput,
): ResolvedDispatchDescriptor {
  assertUserId(userId);
  if (!input || (input.source !== "main" && input.source !== "slot")) {
    throw new DispatchStateError("DISPATCH_SOURCE_INVALID", "Unknown dispatch source");
  }
  const expected = input.expectedConnectionDispatchRevision !== undefined
    ? input.expectedConnectionDispatchRevision
    : input.expectedDispatchRevision;
  if (expected !== undefined && (expected === null || typeof expected !== "string" || expected.trim().length === 0)) {
    throw new DispatchStateError("DISPATCH_REVISION_REQUIRED", "An exact expected dispatch revision is required");
  }
  return withDispatchStateTransaction(userId, (tx) => tx.resolve(input));
}

/** Resolve a dispatch source for provider work; revisionless/stale inputs fail before authorization. */
export function resolveDispatchForSource(
  userId: string,
  input: DispatchDescriptorResolutionInput,
): ResolvedDispatchDescriptor {
  const expected = input?.expectedConnectionDispatchRevision !== undefined
    ? input.expectedConnectionDispatchRevision
    : input?.expectedDispatchRevision;
  if (expected === undefined || expected === null || typeof expected !== "string" || expected.trim().length === 0) {
    throw new DispatchStateError(
      "DISPATCH_REVISION_REQUIRED",
      "An exact expected dispatch revision is required before dispatch",
    );
  }
  return resolveDispatchDescriptor(userId, input);
}

/** Resolve authoritative Main state using only host-owned context. */
export function resolveMainDispatchSnapshot(
  userId: string,
  context: EffectiveDispatchContext = {},
): ResolvedDispatchDescriptor {
  return resolveDispatchDescriptor(userId, {
    source: "main",
    connectionId: context.connectionId ?? undefined,
    presetId: context.presetId,
    reasoning: context.reasoning,
    settings: context.settings,
  });
}

/** Resolve an owned concrete slot only after an exact expected revision is supplied. */
export function resolveSlotDispatch(
  userId: string,
  connectionId: string,
  expectedConnectionDispatchRevision: string | DispatchRevision,
  context: EffectiveDispatchContext = {},
): ResolvedDispatchDescriptor {
  return resolveDispatchForSource(userId, {
    source: "slot",
    connectionId,
    expectedConnectionDispatchRevision,
    presetId: context.presetId,
    reasoning: context.reasoning,
    settings: context.settings,
  });
}
