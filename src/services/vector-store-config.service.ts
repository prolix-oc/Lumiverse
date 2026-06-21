/**
 * Vector-store provider configuration (owner-gated, global).
 *
 * Distinct from `embeddingConfig` (the embedding MODEL) — this selects the
 * vector DATABASE backend (lancedb | qdrant | milvus) and its connection. The
 * store is shared server infrastructure, so it is OWNER-ONLY and GLOBAL: there
 * is no per-user fallback (unlike embeddingConfig). Absent config resolves to
 * LanceDB, guaranteeing zero migration for existing installs.
 *
 * Resolution order (see {@link getResolvedVectorStoreConfig}):
 *   env override  >  owner's stored vectorStoreConfig  >  lancedb default
 *
 * Connection credentials (Qdrant api key, Milvus password) live in the
 * encrypted secrets table, never in the settings JSON.
 */
import * as settingsSvc from "./settings.service";
import * as secretsSvc from "./secrets.service";
import { getFirstUserId } from "../auth/seed";
import { getDb } from "../db/connection";
import { env } from "../env";
import type { VectorStoreProviderId } from "./vector-store/types";

export const VECTOR_STORE_CONFIG_KEY = "vectorStoreConfig";

const QDRANT_API_KEY_SECRET = "vector_store_secret_qdrant_api_key";
const MILVUS_PASSWORD_SECRET = "vector_store_secret_milvus_password";

const VALID_PROVIDERS: VectorStoreProviderId[] = ["lancedb", "qdrant", "milvus"];
const VALID_TUNING_PROFILES = ["balanced", "low_latency", "low_memory", "bulk_reindex"] as const;
const REINDEX_MARK_BATCH_SIZE = 1_000;

export type VectorStoreTuningProfile = typeof VALID_TUNING_PROFILES[number];

export interface QdrantConnectionConfig {
  url: string;
  https?: boolean;
  collectionPrefix?: string;
  checkCompatibility?: boolean;
}

export interface MilvusConnectionConfig {
  address: string;
  ssl?: boolean;
  database?: string;
  username?: string;
  transport?: "grpc" | "http";
}

export interface VectorStoreConfig {
  provider: VectorStoreProviderId;
  tuningProfile?: VectorStoreTuningProfile;
  qdrant?: QdrantConnectionConfig;
  milvus?: MilvusConnectionConfig;
}

/** Connection secrets resolved for internal provider construction. */
export interface VectorStoreConnectionSecrets {
  qdrantApiKey: string | null;
  milvusPassword: string | null;
}

/** API-facing view: never includes secrets, only presence booleans + env flag. */
export interface VectorStoreConfigWithStatus extends VectorStoreConfig {
  managedByEnv: boolean;
  qdrantHasApiKey: boolean;
  milvusHasPassword: boolean;
}

export function defaultVectorStoreConfig(): VectorStoreConfig {
  return { provider: "lancedb" };
}

function getStoredVectorStoreConfig(ownerId: string): VectorStoreConfig {
  const raw = settingsSvc.getSetting(ownerId, VECTOR_STORE_CONFIG_KEY)?.value;
  return raw ? normalizeVectorStoreConfig(raw) : defaultVectorStoreConfig();
}

function hasVectorStoreFieldsBeyondTuning(input: UpdateVectorStoreConfigInput): boolean {
  return input.provider !== undefined
    || input.qdrant !== undefined
    || input.milvus !== undefined
    || input.qdrant_api_key !== undefined
    || input.milvus_password !== undefined;
}

function isValidProvider(p: unknown): p is VectorStoreProviderId {
  return typeof p === "string" && (VALID_PROVIDERS as string[]).includes(p);
}

function normalizeTuningProfile(input: unknown): VectorStoreTuningProfile | undefined {
  return typeof input === "string" && (VALID_TUNING_PROFILES as readonly string[]).includes(input)
    ? input as VectorStoreTuningProfile
    : undefined;
}

export function normalizeVectorStoreConfig(input: any): VectorStoreConfig {
  const provider: VectorStoreProviderId = isValidProvider(input?.provider) ? input.provider : "lancedb";
  const out: VectorStoreConfig = { provider };
  const tuningProfile = normalizeTuningProfile(input?.tuningProfile);
  if (tuningProfile) out.tuningProfile = tuningProfile;

  const q = input?.qdrant;
  if (q && typeof q === "object" && typeof q.url === "string" && q.url.trim()) {
    out.qdrant = {
      url: q.url.trim().replace(/\/+$/, ""),
      https: q.https !== undefined ? !!q.https : undefined,
      collectionPrefix: typeof q.collectionPrefix === "string" && q.collectionPrefix.trim()
        ? q.collectionPrefix.trim()
        : undefined,
      checkCompatibility: q.checkCompatibility !== undefined ? !!q.checkCompatibility : undefined,
    };
  }

  const m = input?.milvus;
  if (m && typeof m === "object" && typeof m.address === "string" && m.address.trim()) {
    out.milvus = {
      address: m.address.trim(),
      ssl: m.ssl !== undefined ? !!m.ssl : undefined,
      database: typeof m.database === "string" && m.database.trim() ? m.database.trim() : undefined,
      username: typeof m.username === "string" && m.username.trim() ? m.username.trim() : undefined,
      transport: m.transport === "http" ? "http" : "grpc",
    };
  }

  return out;
}

/** The env-override config, or null when `LUMIVERSE_VECTOR_STORE_PROVIDER` is unset/invalid. */
function envVectorStoreConfig(): VectorStoreConfig | null {
  const provider = env.vectorStore.provider;
  if (!provider || !isValidProvider(provider)) return null;
  const cfg: VectorStoreConfig = { provider };
  if (provider === "qdrant" && env.vectorStore.qdrantUrl) {
    cfg.qdrant = { url: env.vectorStore.qdrantUrl.replace(/\/+$/, "") };
  }
  if (provider === "milvus" && env.vectorStore.milvusAddress) {
    cfg.milvus = {
      address: env.vectorStore.milvusAddress,
      ssl: env.vectorStore.milvusSsl,
      username: env.vectorStore.milvusUsername || undefined,
    };
  }
  return cfg;
}

/** True when the active backend is forced by environment variables. */
export function isVectorStoreEnvManaged(): boolean {
  return envVectorStoreConfig() != null;
}

/**
 * Resolve the active vector-store config: env override > owner setting > default.
 * Synchronous (no secrets). Used by the factory to pick the provider.
 */
export function getResolvedVectorStoreConfig(): VectorStoreConfig {
  const fromEnv = envVectorStoreConfig();
  const ownerId = getFirstUserId();
  if (fromEnv) {
    if (!ownerId) return fromEnv;
    const stored = getStoredVectorStoreConfig(ownerId);
    return stored.tuningProfile ? { ...fromEnv, tuningProfile: stored.tuningProfile } : fromEnv;
  }
  if (!ownerId) return defaultVectorStoreConfig();
  return getStoredVectorStoreConfig(ownerId);
}

/** Connection secrets for the active provider (env override > owner secrets). */
export async function getVectorStoreConnectionSecrets(): Promise<VectorStoreConnectionSecrets> {
  if (isVectorStoreEnvManaged()) {
    return {
      qdrantApiKey: env.vectorStore.qdrantApiKey || null,
      milvusPassword: env.vectorStore.milvusPassword || null,
    };
  }
  const ownerId = getFirstUserId();
  if (!ownerId) return { qdrantApiKey: null, milvusPassword: null };
  const [qdrantApiKey, milvusPassword] = await Promise.all([
    secretsSvc.getSecret(ownerId, QDRANT_API_KEY_SECRET),
    secretsSvc.getSecret(ownerId, MILVUS_PASSWORD_SECRET),
  ]);
  return { qdrantApiKey, milvusPassword };
}

/** API view of the active config + key-presence flags (never the secrets). */
export async function getVectorStoreConfigForApi(): Promise<VectorStoreConfigWithStatus> {
  const cfg = getResolvedVectorStoreConfig();
  const managedByEnv = isVectorStoreEnvManaged();
  let qdrantHasApiKey = false;
  let milvusHasPassword = false;
  if (managedByEnv) {
    qdrantHasApiKey = !!env.vectorStore.qdrantApiKey;
    milvusHasPassword = !!env.vectorStore.milvusPassword;
  } else {
    const ownerId = getFirstUserId();
    if (ownerId) {
      qdrantHasApiKey = !!(await secretsSvc.getSecret(ownerId, QDRANT_API_KEY_SECRET));
      milvusHasPassword = !!(await secretsSvc.getSecret(ownerId, MILVUS_PASSWORD_SECRET));
    }
  }
  return { ...cfg, managedByEnv, qdrantHasApiKey, milvusHasPassword };
}

/** Throw if the caller is not the server owner. */
export function assertVectorStoreOwner(userId: string): void {
  const ownerId = getFirstUserId();
  if (ownerId && ownerId !== userId) {
    throw new Error("Vector store configuration is managed by the server owner.");
  }
}

export interface UpdateVectorStoreConfigInput {
  provider?: VectorStoreProviderId;
  tuningProfile?: VectorStoreTuningProfile;
  qdrant?: Partial<QdrantConnectionConfig>;
  milvus?: Partial<MilvusConnectionConfig>;
  /** Write-only secrets. `null`/"" clears; `undefined` leaves unchanged. */
  qdrant_api_key?: string | null;
  milvus_password?: string | null;
}

/**
 * Persist a new vector-store config (owner-only). Writes secrets to the
 * encrypted store, persists the JSON config, and drops the cached active store
 * so the next operation reconstructs against the new provider. Does NOT
 * re-embed — call {@link markVectorStoreStaleForReindex} (or the /switch route)
 * for that.
 */
export async function updateVectorStoreConfig(
  userId: string,
  input: UpdateVectorStoreConfigInput,
): Promise<VectorStoreConfigWithStatus> {
  assertVectorStoreOwner(userId);
  const ownerId = getFirstUserId() ?? userId;
  if (isVectorStoreEnvManaged()) {
    if (hasVectorStoreFieldsBeyondTuning(input)) {
      throw new Error("Vector store provider and connection are managed by environment variables and cannot be changed at runtime.");
    }
    const tuningProfile = normalizeTuningProfile(input.tuningProfile);
    if (!tuningProfile) throw new Error("Invalid vector store tuning profile.");
    settingsSvc.putSetting(ownerId, VECTOR_STORE_CONFIG_KEY, {
      ...getStoredVectorStoreConfig(ownerId),
      tuningProfile,
    });

    // Break the static import cycle (index.ts imports this service).
    const { resetActiveVectorStore } = await import("./vector-store");
    resetActiveVectorStore();
    return getVectorStoreConfigForApi();
  }

  if (!hasVectorStoreFieldsBeyondTuning(input)) {
    const tuningProfile = normalizeTuningProfile(input.tuningProfile);
    if (!tuningProfile) throw new Error("Invalid vector store tuning profile.");
    settingsSvc.putSetting(ownerId, VECTOR_STORE_CONFIG_KEY, {
      ...getStoredVectorStoreConfig(ownerId),
      tuningProfile,
    });

    // Break the static import cycle (index.ts imports this service).
    const { resetActiveVectorStore } = await import("./vector-store");
    resetActiveVectorStore();
    return getVectorStoreConfigForApi();
  }

  const normalized = normalizeVectorStoreConfig(input);

  if (input.qdrant_api_key !== undefined) {
    if (!input.qdrant_api_key) secretsSvc.deleteSecret(ownerId, QDRANT_API_KEY_SECRET);
    else await secretsSvc.putSecret(ownerId, QDRANT_API_KEY_SECRET, input.qdrant_api_key);
  }
  if (input.milvus_password !== undefined) {
    if (!input.milvus_password) secretsSvc.deleteSecret(ownerId, MILVUS_PASSWORD_SECRET);
    else await secretsSvc.putSecret(ownerId, MILVUS_PASSWORD_SECRET, input.milvus_password);
  }

  settingsSvc.putSetting(ownerId, VECTOR_STORE_CONFIG_KEY, normalized);

  // Break the static import cycle (index.ts imports this service).
  const { resetActiveVectorStore } = await import("./vector-store");
  resetActiveVectorStore();

  return getVectorStoreConfigForApi();
}

/** Resolve the secrets to use when building a candidate store for a test/switch:
 *  prefer secrets supplied in the request body, else the stored/env ones. */
async function resolveCandidateSecrets(input: UpdateVectorStoreConfigInput): Promise<VectorStoreConnectionSecrets> {
  const stored = await getVectorStoreConnectionSecrets();
  return {
    qdrantApiKey: input.qdrant_api_key !== undefined ? (input.qdrant_api_key || null) : stored.qdrantApiKey,
    milvusPassword: input.milvus_password !== undefined ? (input.milvus_password || null) : stored.milvusPassword,
  };
}

export interface VectorStoreTestResult {
  ok: boolean;
  provider: VectorStoreProviderId;
  error?: string;
}

/**
 * Build a candidate store from the supplied config (without persisting) and run
 * its `init()` reachability/version probe. Used by the operator UI before
 * committing a provider switch.
 */
export async function testVectorStoreConnection(input: UpdateVectorStoreConfigInput): Promise<VectorStoreTestResult> {
  const config = normalizeVectorStoreConfig(input);
  try {
    const secrets = await resolveCandidateSecrets(input);
    const { buildVectorStore } = await import("./vector-store");
    const store = await buildVectorStore(config, secrets);
    await store.init();
    await store.close();
    return { ok: true, provider: config.provider };
  } catch (err: any) {
    return { ok: false, provider: config.provider, error: err?.message || "Connection test failed" };
  }
}

export interface VectorStoreSwitchResult extends VectorStoreConfigWithStatus {
  reindexScheduled: boolean;
}

let staleMarkingPromise: Promise<void> | null = null;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function updateRowsInChunks(table: string, idColumn: string, selectWhere: string, updateSql: string): Promise<number> {
  let total = 0;
  while (true) {
    const ids = getDb().query(
      `SELECT ${idColumn} AS id FROM ${table} WHERE ${selectWhere} LIMIT ?`,
    ).all(REINDEX_MARK_BATCH_SIZE) as Array<{ id: string }>;
    if (ids.length === 0) break;

    const placeholders = ids.map(() => "?").join(", ");
    getDb().query(
      `${updateSql} WHERE ${idColumn} IN (${placeholders})`,
    ).run(...ids.map((row) => row.id));
    total += ids.length;
    await yieldToEventLoop();

    if (ids.length < REINDEX_MARK_BATCH_SIZE) break;
  }
  return total;
}

async function deleteRowsInChunks(table: string, idColumn: string): Promise<number> {
  let total = 0;
  while (true) {
    const ids = getDb().query(
      `SELECT ${idColumn} AS id FROM ${table} LIMIT ?`,
    ).all(REINDEX_MARK_BATCH_SIZE) as Array<{ id: string }>;
    if (ids.length === 0) break;

    const placeholders = ids.map(() => "?").join(", ");
    const result = getDb().query(
      `DELETE FROM ${table} WHERE ${idColumn} IN (${placeholders})`,
    ).run(...ids.map((row) => row.id)) as { changes?: number };
    total += result.changes ?? ids.length;
    await yieldToEventLoop();

    if (ids.length < REINDEX_MARK_BATCH_SIZE) break;
  }
  return total;
}

function scheduleVectorStoreStaleMarking(): boolean {
  if (staleMarkingPromise) return true;

  staleMarkingPromise = (async () => {
    try {
      const worldBooks = await updateRowsInChunks(
        "world_book_entries",
        "id",
        `(vectorized = 1 AND vector_index_status != 'pending')
          OR (vectorized != 1 AND vector_index_status != 'not_enabled')
          OR vector_index_status IS NULL
          OR vector_indexed_at IS NOT NULL
          OR vector_index_error IS NOT NULL`,
        `UPDATE world_book_entries
         SET vector_index_status = CASE WHEN vectorized = 1 THEN 'pending' ELSE 'not_enabled' END,
             vector_indexed_at = NULL,
             vector_index_error = NULL`,
      );
      const chatChunks = await updateRowsInChunks(
        "chat_chunks",
        "id",
        `vectorized_at IS NOT NULL OR vector_model IS NOT NULL`,
        `UPDATE chat_chunks SET vectorized_at = NULL, vector_model = NULL`,
      );
      const queryCache = await deleteRowsInChunks("query_vector_cache", "id");
      const chatMemoryCache = await deleteRowsInChunks("chat_memory_cache", "id");
      const { queueStaleChatChunkVectorization } = await import("./vectorization-queue.service");
      const queuedChatChunks = await queueStaleChatChunkVectorization();

      const { embeddingCache } = await import("./embedding-cache");
      embeddingCache.clear();
      console.info(`[vector-store] Marked vectors stale after provider switch: world_books=${worldBooks}, chat_chunks=${chatChunks}, query_cache=${queryCache}, chat_memory_cache=${chatMemoryCache}, queued_chat_chunks=${queuedChatChunks}`);
    } catch (err) {
      console.warn("[vector-store] Failed to mark content stale after provider switch:", err);
    } finally {
      staleMarkingPromise = null;
    }
  })();

  staleMarkingPromise.catch(() => {});
  return true;
}

/**
 * Switch the active vector-store provider (owner-only) with validate-before-commit:
 * construct + init the candidate FIRST (reject without persisting if unreachable
 * or the optional dep is missing), then persist, drop the cached store, and mark
 * all derived content stale so the existing reindexers + vectorization queue
 * lazily re-embed from SQLite into the new backend. Vectors are never migrated.
 */
export async function switchVectorStoreProvider(
  userId: string,
  input: UpdateVectorStoreConfigInput,
): Promise<VectorStoreSwitchResult> {
  assertVectorStoreOwner(userId);
  if (isVectorStoreEnvManaged()) {
    throw new Error("Vector store configuration is managed by environment variables and cannot be changed at runtime.");
  }

  // 1. Validate-before-commit: build + probe the candidate before touching settings.
  const candidateConfig = normalizeVectorStoreConfig(input);
  const candidateSecrets = await resolveCandidateSecrets(input);
  const { buildVectorStore } = await import("./vector-store");
  const candidate = await buildVectorStore(candidateConfig, candidateSecrets);
  await candidate.init();
  await candidate.close();

  // 2. Commit (persists secrets + config, drops the cached active store).
  const status = await updateVectorStoreConfig(userId, input);

  // 3. Mark all derived content stale in the background. This can touch many
  // rows on large installs; doing it synchronously stalls Bun's event loop and
  // can make the frontend websocket heartbeat think the server disconnected.
  const reindexScheduled = scheduleVectorStoreStaleMarking();

  return { ...status, reindexScheduled };
}
