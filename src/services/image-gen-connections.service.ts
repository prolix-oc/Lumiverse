import { AsyncLocalStorage } from "node:async_hooks";
import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { getImageProvider } from "../image-gen/registry";
import * as secretsSvc from "./secrets.service";
import type {
  ImageGenConnectionProfile,
  CreateImageGenConnectionInput,
  UpdateImageGenConnectionInput,
} from "../types/image-gen-connection";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";
import { describeProviderError } from "../utils/provider-errors";
import {
  clearImportedConnectionReview,
  importedConnectionReviewCode,
  isImportedConnectionReviewRequired,
  markImportedConnectionForReview,
  sanitizeConnectionMetadata,
} from "./connection-authority";

interface OwnerMutationLease {
  readonly userId: string;
  active: boolean;
}

const ownerMutationTails = new Map<string, Promise<void>>();
const ownerMutationContext = new AsyncLocalStorage<ReadonlyMap<string, OwnerMutationLease>>();

/**
 * Serialize connection/profile/secret mutations for one authenticated owner.
 * Different owners proceed independently, and nested service calls inherit
 * the lock so update -> secret helpers cannot deadlock.
 */
export async function withImageGenConnectionOwnerLock<T>(
  userId: string,
  callback: () => Promise<T>,
): Promise<T> {
  const inherited = ownerMutationContext.getStore();
  const inheritedLease = inherited?.get(userId);
  if (inheritedLease?.active) return callback();

  const previous = ownerMutationTails.get(userId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.then(() => current, () => current);
  ownerMutationTails.set(userId, tail);
  await previous.catch(() => undefined);

  const lease: OwnerMutationLease = { userId, active: true };
  const held = new Map(inherited ?? []);
  held.set(userId, lease);
  try {
    return await ownerMutationContext.run(held, callback);
  } finally {
    lease.active = false;
    releaseCurrent();
    if (ownerMutationTails.get(userId) === tail) ownerMutationTails.delete(userId);
  }
}

/** Secret key for an image gen connection's API key. */
export function imageGenConnectionSecretKey(id: string): string {
  return `image_gen_connection_${id}_api_key`;
}

export interface ImageGenConnectionModelsPreviewInput {
  connection_id?: string;
  provider: string;
  api_url?: string;
  api_key?: string;
}

export interface NanoGptUsageWindow {
  used: number;
  remaining: number;
  percentUsed: number;
  resetAt: number | null;
  limit: number | null;
}

export interface NanoGptSubscriptionUsage {
  active: boolean;
  allowOverage: boolean;
  // Typed usage windows mirroring NanoGPT's subscription payload. Each may be
  // null when the plan doesn't meter that dimension.
  dailyInputTokens: NanoGptUsageWindow | null;
  weeklyInputTokens: NanoGptUsageWindow | null;
  dailyImages: NanoGptUsageWindow | null;
  period: {
    currentPeriodEnd: string | null;
  };
  state: string | null;
  graceUntil: string | null;
}

/**
 * Parse a single Nano-GPT usage window from the raw API payload, folding in its
 * matching `limits.<key>` value. The window object and its limit live under
 * separate keys in NanoGPT's response, so callers pass both.
 */
function parseNanoGptUsageWindow(w: any, limit: any): NanoGptUsageWindow | null {
  if (!w || typeof w !== "object") return null;
  return {
    used: typeof w.used === "number" ? w.used : 0,
    remaining: typeof w.remaining === "number" ? w.remaining : 0,
    percentUsed: typeof w.percentUsed === "number" ? w.percentUsed : 0,
    resetAt: typeof w.resetAt === "number" ? w.resetAt : null,
    limit: typeof limit === "number" ? limit : null,
  };
}

function resolveNanoGptSubscriptionUsageUrl(profile: { api_url?: string | null }): string {
  const fallback = "https://nano-gpt.com/api/subscription/v1/usage";
  const rawUrl = (profile.api_url || "").trim() || "https://nano-gpt.com/api/v1";

  try {
    const url = new URL(rawUrl);
    url.pathname = "/api/subscription/v1/usage";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return fallback;
  }
}

function rowToProfile(row: any): ImageGenConnectionProfile {
  const metadata = JSON.parse(row.metadata || "{}") as Record<string, unknown>;
  return {
    ...row,
    is_default: !!row.is_default,
    has_api_key: !!row.has_api_key,
    review_required: isImportedConnectionReviewRequired(metadata),
    review_code: importedConnectionReviewCode(metadata),
    default_parameters: JSON.parse(row.default_parameters || "{}"),
    metadata,
  };
}

export function toPublicImageGenConnection(profile: ImageGenConnectionProfile): ImageGenConnectionProfile {
  return { ...profile, metadata: sanitizeConnectionMetadata(profile.metadata) };
}

export function isImageConnectionUsable(
  profile: Pick<ImageGenConnectionProfile, "review_required"> | null | undefined,
): boolean {
  return profile?.review_required !== true;
}

export function getUsableConnection(userId: string, id: string): ImageGenConnectionProfile | null {
  const profile = getConnection(userId, id);
  return isImageConnectionUsable(profile) ? profile : null;
}

export function listConnections(userId: string, pagination: PaginationParams): PaginatedResult<ImageGenConnectionProfile> {
  return paginatedQuery(
    "SELECT * FROM image_gen_connections WHERE user_id = ? ORDER BY updated_at DESC",
    "SELECT COUNT(*) as count FROM image_gen_connections WHERE user_id = ?",
    [userId],
    pagination,
    rowToProfile
  );
}

export function getConnection(userId: string, id: string): ImageGenConnectionProfile | null {
  const row = getDb()
    .query("SELECT * FROM image_gen_connections WHERE id = ? AND user_id = ?")
    .get(id, userId) as any;
  return row ? rowToProfile(row) : null;
}

export function getDefaultConnection(userId: string): ImageGenConnectionProfile | null {
  const row = getDb()
    .query("SELECT * FROM image_gen_connections WHERE is_default = 1 AND user_id = ? LIMIT 1")
    .get(userId) as any;
  const profile = row ? rowToProfile(row) : null;
  return isImageConnectionUsable(profile) ? profile : null;
}

export async function createConnection(
  userId: string,
  input: CreateImageGenConnectionInput
): Promise<ImageGenConnectionProfile> {
  return withImageGenConnectionOwnerLock(userId, async () => {
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const secretKey = imageGenConnectionSecretKey(id);
    const preparedSecret = input.api_key
      ? await secretsSvc.prepareSecretWrite(input.api_key)
      : null;

    const db = getDb();
    db.transaction(() => {
      if (input.is_default) {
        db.query(
          "UPDATE image_gen_connections SET is_default = 0 WHERE is_default = 1 AND user_id = ?",
        ).run(userId);
      }

      db.query(
        "INSERT INTO image_gen_connections "
          + "(id, user_id, name, provider, api_url, model, is_default, has_api_key, default_parameters, metadata, created_at, updated_at) "
          + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        userId,
        input.name,
        input.provider,
        input.api_url || "",
        input.model || "",
        input.is_default ? 1 : 0,
        preparedSecret ? 1 : 0,
        JSON.stringify(input.default_parameters || {}),
        JSON.stringify(clearImportedConnectionReview(input.metadata || {})),
        now,
        now,
      );

      if (preparedSecret) {
        secretsSvc.putPreparedSecret(userId, secretKey, preparedSecret);
      }
    })();

    const profile = getConnection(userId, id)!;
    eventBus.emit(EventType.IMAGE_GEN_CONNECTION_CHANGED, { id, profile: toPublicImageGenConnection(profile) }, userId);
    return profile;
  });
}

export async function updateConnection(
  userId: string,
  id: string,
  input: UpdateImageGenConnectionInput
): Promise<ImageGenConnectionProfile | null> {
  return withImageGenConnectionOwnerLock(userId, async () => {
  const existing = getConnection(userId, id);
  if (!existing) return null;
  const reviewRequested = input.reviewed === true;
  const canSetDefault = !existing.review_required || reviewRequested;

  if (input.is_default && canSetDefault) {
    getDb()
      .query("UPDATE image_gen_connections SET is_default = 0 WHERE is_default = 1 AND user_id = ?")
      .run(userId);
  }

  if (input.api_key !== undefined) {
    if (input.api_key) await setConnectionApiKey(userId, id, input.api_key);
    else await clearConnectionApiKey(userId, id);
  }

  const fields: string[] = [];
  const values: any[] = [];
  if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
  if (input.provider !== undefined) { fields.push("provider = ?"); values.push(input.provider); }
  if (input.api_url !== undefined) { fields.push("api_url = ?"); values.push(input.api_url); }
  if (input.model !== undefined) { fields.push("model = ?"); values.push(input.model); }
  if (input.is_default !== undefined) { fields.push("is_default = ?"); values.push(input.is_default && canSetDefault ? 1 : 0); }
  if (input.default_parameters !== undefined) { fields.push("default_parameters = ?"); values.push(JSON.stringify(input.default_parameters)); }
  if (input.metadata !== undefined) {
    fields.push("metadata = ?");
    values.push(JSON.stringify(reviewRequested
      ? clearImportedConnectionReview(input.metadata)
      : existing.review_required
        ? markImportedConnectionForReview(input.metadata, existing.review_code || "foreign_import")
        : clearImportedConnectionReview(input.metadata)));
  } else if (reviewRequested) {
    fields.push("metadata = ?");
    values.push(JSON.stringify(clearImportedConnectionReview(existing.metadata)));
  }

  if (fields.length === 0 && input.api_key === undefined) return existing;
  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000), id, userId);
  getDb().query(`UPDATE image_gen_connections SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
  const updated = getConnection(userId, id)!;
  eventBus.emit(EventType.IMAGE_GEN_CONNECTION_CHANGED, { id, profile: toPublicImageGenConnection(updated) }, userId);
  return updated;
  });
}

export async function duplicateConnection(userId: string, id: string): Promise<ImageGenConnectionProfile | null> {
  return withImageGenConnectionOwnerLock(userId, async () => {
  const existing = getConnection(userId, id);
  if (!existing) return null;

  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const reviewRequired = existing.review_required;
  let hasApiKey = 0;
  if (!reviewRequired && existing.has_api_key) {
    try {
      const apiKey = await secretsSvc.getSecret(userId, imageGenConnectionSecretKey(id));
      if (apiKey) {
        await secretsSvc.putSecret(userId, imageGenConnectionSecretKey(newId), apiKey);
        hasApiKey = 1;
      }
    } catch {
      // If key read fails, duplicate without the key.
    }
  }
  const metadata = reviewRequired
    ? existing.metadata
    : clearImportedConnectionReview(existing.metadata);

  getDb()
    .query(
      `INSERT INTO image_gen_connections
        (id, user_id, name, provider, api_url, model, is_default, has_api_key, default_parameters, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newId, userId, `${existing.name} (Copy)`, existing.provider,
      existing.api_url, existing.model, 0, hasApiKey,
      JSON.stringify(existing.default_parameters),
      JSON.stringify(metadata), now, now
    );

  const profile = getConnection(userId, newId)!;
  eventBus.emit(EventType.IMAGE_GEN_CONNECTION_CHANGED, { id: newId, profile: toPublicImageGenConnection(profile) }, userId);
  return profile;
  });
}

export async function deleteConnection(userId: string, id: string): Promise<boolean> {
  return withImageGenConnectionOwnerLock(userId, async () => {
  const deleted =
    getDb()
      .query("DELETE FROM image_gen_connections WHERE id = ? AND user_id = ?")
      .run(id, userId).changes > 0;
  if (deleted) {
    secretsSvc.deleteSecret(userId, imageGenConnectionSecretKey(id));
    eventBus.emit(EventType.IMAGE_GEN_CONNECTION_CHANGED, { id, deleted: true }, userId);
  }
  return deleted;
  });
}

export async function setConnectionApiKey(userId: string, id: string, key: string): Promise<void> {
  return withImageGenConnectionOwnerLock(userId, async () => {
  await secretsSvc.putSecret(userId, imageGenConnectionSecretKey(id), key);
  getDb()
    .query("UPDATE image_gen_connections SET has_api_key = 1, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(Math.floor(Date.now() / 1000), id, userId);
  });
}

export async function clearConnectionApiKey(userId: string, id: string): Promise<void> {
  return withImageGenConnectionOwnerLock(userId, async () => {
  secretsSvc.deleteSecret(userId, imageGenConnectionSecretKey(id));
  getDb()
    .query("UPDATE image_gen_connections SET has_api_key = 0, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(Math.floor(Date.now() / 1000), id, userId);
  });
}

export async function testConnection(
  userId: string,
  id: string
): Promise<{ success: boolean; message: string; provider: string }> {
  const profile = getUsableConnection(userId, id);
  if (!profile) return { success: false, message: "Connection requires owner review", provider: "" };

  const provider = getImageProvider(profile.provider);
  if (!provider) {
    return { success: false, message: `Unknown provider: ${profile.provider}`, provider: profile.provider };
  }

  const apiKey = await secretsSvc.getSecret(userId, imageGenConnectionSecretKey(id));
  if (!apiKey && provider.capabilities.apiKeyRequired) {
    return {
      success: false,
      message: `No API key for connection "${profile.name}"`,
      provider: profile.provider,
    };
  }

  try {
    const valid = await provider.validateKey(apiKey || "", profile.api_url || "");
    return {
      success: valid,
      message: valid ? "Connection successful" : "API key validation failed",
      provider: profile.provider,
    };
  } catch (err: any) {
    return { success: false, message: describeProviderError(err, "Connection test failed"), provider: profile.provider };
  }
}
export async function listConnectionModels(
  userId: string,
  id: string
): Promise<{ models: Array<{ id: string; label: string }>; provider: string; error?: string }> {
  const profile = getUsableConnection(userId, id);
  if (!profile) return { models: [], provider: "", error: "Connection requires owner review" };

  const apiKey = await secretsSvc.getSecret(userId, imageGenConnectionSecretKey(id));
  return listConnectionModelsPreview(userId, {
    connection_id: id,
    provider: profile.provider,
    api_url: profile.api_url,
    api_key: apiKey || undefined,
  });
}

export async function listConnectionModelsPreview(
  userId: string,
  input: ImageGenConnectionModelsPreviewInput
): Promise<{ models: Array<{ id: string; label: string }>; provider: string; error?: string }> {
  const existing = input.connection_id ? getConnection(userId, input.connection_id) : null;
  if (existing && !isImageConnectionUsable(existing)) {
    return { models: [], provider: input.provider, error: "Connection requires owner review" };
  }
  const providerId = input.provider;

  let apiKey = input.api_key;
  if (apiKey === undefined && existing && existing.provider === providerId) {
    apiKey = (await secretsSvc.getSecret(userId, imageGenConnectionSecretKey(existing.id))) || undefined;
  }

  const provider = getImageProvider(providerId);
  if (!provider) {
    return { models: [], provider: providerId, error: `Unknown provider: ${providerId}` };
  }

  try {
    const models = await provider.listModels(apiKey || "", input.api_url ?? existing?.api_url ?? "");
    return { models, provider: providerId };
  } catch (err: any) {
    return { models: [], provider: providerId, error: describeProviderError(err, "Failed to fetch models") };
  }
}

export async function listConnectionModelsBySubtype(
  userId: string,
  id: string,
  subtype: string,
): Promise<{ models: Array<{ id: string; label: string }>; provider: string; error?: string }> {
  const profile = getUsableConnection(userId, id);
  if (!profile) return { models: [], provider: "", error: "Connection requires owner review" };

  const provider = getImageProvider(profile.provider);
  if (!provider) {
    return { models: [], provider: profile.provider, error: `Unknown provider: ${profile.provider}` };
  }

  if (!provider.listModelsBySubtype) {
    return { models: [], provider: profile.provider, error: "Provider does not support subtype model listing" };
  }

  const apiKey = await secretsSvc.getSecret(userId, imageGenConnectionSecretKey(id));
  if (!apiKey && provider.capabilities.apiKeyRequired) {
    return { models: [], provider: profile.provider, error: "No API key" };
  }

  try {
    const models = await provider.listModelsBySubtype(apiKey || "", profile.api_url || "", subtype);
    return { models, provider: profile.provider };
  } catch (err: any) {
    return { models: [], provider: profile.provider, error: describeProviderError(err, "Failed to fetch models") };
  }
}

export async function fetchNanoGptSubscriptionUsage(userId: string, id: string): Promise<NanoGptSubscriptionUsage | null> {
  const profile = getUsableConnection(userId, id);
  if (!profile || profile.provider !== "nanogpt") return null;

  const apiKey = await secretsSvc.getSecret(userId, imageGenConnectionSecretKey(id));
  if (!apiKey) return null;

  try {
    const res = await fetch(resolveNanoGptSubscriptionUsageUrl(profile), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (!res.ok) return null;

    const raw = await res.json() as any;
    return {
      active: !!raw?.active,
      allowOverage: !!raw?.allowOverage,
      dailyInputTokens: parseNanoGptUsageWindow(raw?.dailyInputTokens, raw?.limits?.dailyInputTokens),
      weeklyInputTokens: parseNanoGptUsageWindow(raw?.weeklyInputTokens, raw?.limits?.weeklyInputTokens),
      dailyImages: parseNanoGptUsageWindow(raw?.dailyImages, raw?.limits?.dailyImages),
      period: {
        currentPeriodEnd: typeof raw?.period?.currentPeriodEnd === "string" ? raw.period.currentPeriodEnd : null,
      },
      state: typeof raw?.state === "string" ? raw.state : null,
      graceUntil: typeof raw?.graceUntil === "string" ? raw.graceUntil : null,
    };
  } catch {
    return null;
  }
}
