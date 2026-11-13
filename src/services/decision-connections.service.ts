import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as secrets from "./secrets.service";
import { paginatedQuery } from "./pagination";
import { withReadableApiKeyStatus } from "./connection-secret-status";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import type { DecisionConnectionProfile, CreateDecisionConnectionInput, UpdateDecisionConnectionInput } from "../types/decision-connection";
import type { DecisionModelDTO } from "../decision/contract";
import { DecisionValidationError, isRecord } from "../decision/validation";
import { listProviders, getProvider, resolveDecisionApiUrl, fetchDecisionModels, redactDecisionError, validateDecisionParameters } from "../decision/providers";

export { listProviders };
export const decisionConnectionSecretKey = (id: string): string => `decision_connection_${id}_api_key`;
const now = () => Math.floor(Date.now() / 1000);
function rowToProfile(row: any): DecisionConnectionProfile {
  return {
    id: row.id, name: row.name, provider: row.provider, api_url: row.api_url, model: row.model,
    is_default: !!row.is_default, has_api_key: !!row.has_api_key,
    default_parameters: JSON.parse(row.default_parameters || "{}"), metadata: JSON.parse(row.metadata || "{}"),
    created_at: row.created_at, updated_at: row.updated_at,
  };
}
export function listConnections(userId: string, pagination: PaginationParams): PaginatedResult<DecisionConnectionProfile> {
  return paginatedQuery("SELECT * FROM decision_connections WHERE user_id = ? ORDER BY updated_at DESC, id", "SELECT COUNT(*) as count FROM decision_connections WHERE user_id = ?", [userId], pagination, rowToProfile);
}
export function getConnection(userId: string, id: string): DecisionConnectionProfile | null {
  const row = getDb().query("SELECT * FROM decision_connections WHERE id = ? AND user_id = ?").get(id, userId);
  return row ? rowToProfile(row) : null;
}
export function getDefaultConnection(userId: string): DecisionConnectionProfile | null {
  const row = getDb().query("SELECT * FROM decision_connections WHERE user_id = ? AND is_default = 1").get(userId);
  return row ? rowToProfile(row) : null;
}
export function validateConnectionInput(input: unknown, existing?: DecisionConnectionProfile): asserts input is CreateDecisionConnectionInput {
  if (!isRecord(input)) throw new DecisionValidationError("Connection input must be an object");
  for (const field of ["name", "provider", "api_url", "model", "api_key"]) if (input[field] !== undefined && typeof input[field] !== "string") throw new DecisionValidationError(`${field} must be a string`);
  if (!existing && (typeof input.name !== "string" || !input.name.trim() || typeof input.provider !== "string")) throw new DecisionValidationError("name and provider are required");
  if (input.name !== undefined && !String(input.name).trim()) throw new DecisionValidationError("name is required");
  if (input.is_default !== undefined && typeof input.is_default !== "boolean") throw new DecisionValidationError("is_default must be a boolean");
  if (input.metadata !== undefined && !isRecord(input.metadata)) throw new DecisionValidationError("metadata must be an object");
  if (input.default_parameters !== undefined && !isRecord(input.default_parameters)) throw new DecisionValidationError("default_parameters must be an object");
  const provider = String(input.provider ?? existing?.provider);
  getProvider(provider);
  resolveDecisionApiUrl({ provider, api_url: String(input.api_url ?? existing?.api_url ?? "") });
  validateDecisionParameters(provider, input.default_parameters ?? existing?.default_parameters ?? {});
  if (Buffer.byteLength(JSON.stringify(input)) > 64 * 1024) throw new DecisionValidationError("Connection input exceeds 64 KiB");
}
async function publish(userId: string, id: string): Promise<DecisionConnectionProfile> {
  const profile = await withReadableApiKeyStatus(userId, getConnection(userId, id)!, decisionConnectionSecretKey);
  eventBus.emit(EventType.DECISION_CONNECTION_CHANGED, { id, profile }, userId);
  return profile;
}
export async function createConnection(userId: string, input: CreateDecisionConnectionInput): Promise<DecisionConnectionProfile> {
  validateConnectionInput(input);
  const id = crypto.randomUUID();
  const created = now();
  const apiKey = input.api_key?.trim();
  if (apiKey) await secrets.putSecret(userId, decisionConnectionSecretKey(id), apiKey);
  try {
    getDb().transaction(() => {
      if (input.is_default) getDb().query("UPDATE decision_connections SET is_default = 0 WHERE user_id = ? AND is_default = 1").run(userId);
      getDb().query(`INSERT INTO decision_connections (id, user_id, name, provider, api_url, model, is_default, has_api_key, default_parameters, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, userId, input.name.trim(), input.provider, input.api_url?.trim() || "", input.model?.trim() || "", input.is_default ? 1 : 0, apiKey ? 1 : 0, JSON.stringify(input.default_parameters ?? {}), JSON.stringify(input.metadata ?? {}), created, created);
    })();
  } catch (error) {
    if (apiKey) secrets.deleteSecret(userId, decisionConnectionSecretKey(id));
    throw error;
  }
  return publish(userId, id);
}
export async function updateConnection(userId: string, id: string, input: UpdateDecisionConnectionInput): Promise<DecisionConnectionProfile | null> {
  const existing = getConnection(userId, id);
  if (!existing) return null;
  if (isRecord(input) && input.provider !== undefined && input.provider !== existing.provider) {
    input = {
      ...input,
      api_url: input.api_url === undefined ? "" : input.api_url,
      model: input.model === undefined ? "" : input.model,
      default_parameters: input.default_parameters === undefined ? {} : input.default_parameters,
    };
  }
  validateConnectionInput(input, existing);
  let hasApiKey = existing.has_api_key;
  // A provider/endpoint change must not forward the previous provider's credential.
  const endpointChanged = input.provider !== undefined && input.provider !== existing.provider
    || input.api_url !== undefined && resolveDecisionApiUrl({ provider: input.provider ?? existing.provider, api_url: input.api_url }) !== resolveDecisionApiUrl(existing);
  if (input.api_key !== undefined || endpointChanged) {
    const apiKey = input.api_key?.trim();
    if (apiKey) await secrets.putSecret(userId, decisionConnectionSecretKey(id), apiKey);
    else secrets.deleteSecret(userId, decisionConnectionSecretKey(id));
    hasApiKey = !!apiKey;
  }
  const next = { ...existing, ...input, has_api_key: hasApiKey };
  getDb().transaction(() => {
    if (next.is_default) getDb().query("UPDATE decision_connections SET is_default = 0 WHERE user_id = ? AND is_default = 1 AND id != ?").run(userId, id);
    getDb().query(`UPDATE decision_connections SET name = ?, provider = ?, api_url = ?, model = ?, is_default = ?, has_api_key = ?, default_parameters = ?, metadata = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
      .run(next.name.trim(), next.provider, next.api_url.trim(), next.model.trim(), next.is_default ? 1 : 0, next.has_api_key ? 1 : 0, JSON.stringify(next.default_parameters), JSON.stringify(next.metadata), now(), id, userId);
  })();
  return publish(userId, id);
}
export async function duplicateConnection(userId: string, id: string): Promise<DecisionConnectionProfile | null> {
  const existing = getConnection(userId, id);
  if (!existing) return null;
  const key = await secrets.getSecretForStatus(userId, decisionConnectionSecretKey(id));
  return createConnection(userId, { ...existing, name: `${existing.name} (Copy)`, is_default: false, api_key: key || undefined });
}
export async function deleteConnection(userId: string, id: string): Promise<boolean> {
  const deleted = getDb().query("DELETE FROM decision_connections WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
  if (deleted) {
    secrets.deleteSecret(userId, decisionConnectionSecretKey(id));
    eventBus.emit(EventType.DECISION_CONNECTION_CHANGED, { id, deleted: true }, userId);
  }
  return deleted;
}
export async function setConnectionApiKey(userId: string, id: string, apiKey: string): Promise<boolean> {
  return !!await updateConnection(userId, id, { api_key: apiKey });
}
export async function clearConnectionApiKey(userId: string, id: string): Promise<boolean> {
  return !!await updateConnection(userId, id, { api_key: "" });
}
export interface DecisionModelsPreviewInput { connection_id?: string; provider: string; api_url?: string; api_key?: string }
export interface DecisionModelsResult { models: DecisionModelDTO[]; provider: string; error?: string }
export async function listConnectionModelsPreview(userId: string, input: DecisionModelsPreviewInput): Promise<DecisionModelsResult> {
  let apiKey = "";
  try {
    if (!isRecord(input) || typeof input.provider !== "string" || (input.api_key !== undefined && typeof input.api_key !== "string") || (input.api_url !== undefined && typeof input.api_url !== "string") || (input.connection_id !== undefined && typeof input.connection_id !== "string")) throw new DecisionValidationError("Invalid model preview input");
    const existing = input.connection_id ? getConnection(userId, input.connection_id) : null;
    if (input.connection_id && !existing) throw new DecisionValidationError("Decision connection not found");
    const profile = { provider: input.provider, api_url: input.api_url ?? existing?.api_url ?? "" };
    const url = resolveDecisionApiUrl(profile);
    if (input.api_key !== undefined) apiKey = input.api_key.trim();
    else if (existing && existing.provider === input.provider && url === resolveDecisionApiUrl(existing)) apiKey = await secrets.getSecret(userId, decisionConnectionSecretKey(existing.id)) || "";
    if (!apiKey) throw new DecisionValidationError("Enter an API key for this provider and endpoint");
    return { models: await fetchDecisionModels(profile, apiKey), provider: input.provider };
  } catch (error) { return { models: [], provider: input?.provider || "", error: redactDecisionError(error, apiKey) }; }
}
export async function listConnectionModels(userId: string, id: string): Promise<DecisionModelsResult> {
  const profile = getConnection(userId, id);
  if (!profile) return { models: [], provider: "", error: "Decision connection not found" };
  return listConnectionModelsPreview(userId, { connection_id: id, provider: profile.provider, api_url: profile.api_url });
}
export async function testConnection(userId: string, id: string): Promise<{ success: boolean; message: string; provider: string }> {
  const result = await listConnectionModels(userId, id);
  // Some catalogs (NanoGPT) are public, so this only proves catalog access, not the credential.
  return {
    success: !result.error,
    message: result.error || "Model catalog access verified. No decision was run.",
    provider: result.provider,
  };
}
export async function runSampleDecision(userId: string, id: string): Promise<{ success: boolean; message: string; provider: string }> {
  const profile = getConnection(userId, id);
  if (!profile) return { success: false, message: "Decision connection not found", provider: "" };
  try {
    const { evaluateDecision } = await import("./decisions.service");
    const result = await evaluateDecision(userId, { connection_id: id, state: "Lumiverse connection check.", questions: { check: { type: "noul", instructions: "Does the text mention Lumiverse?" } } });
    return { success: true, message: `Sample decision completed with ${result.model}`, provider: profile.provider };
  } catch (error) { return { success: false, message: redactDecisionError(error), provider: profile.provider }; }
}
