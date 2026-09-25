import { getDb } from "../db/connection";
import { getDecisionProvider, type DecisionModelList } from "../decisions/registry";
import "../decisions/jev";
import { validateDecisionRequest, type DecisionRequest, type DecisionResult } from "../decisions/types";
import * as secrets from "./secrets.service";

export interface DecisionConnection {
  id: string;
  name: string;
  provider: string;
  gateway: string;
  protocol: string;
  api_url: string;
  model: string;
  account_id: string;
  is_default: boolean;
  has_api_key: boolean;
  created_at: number;
  updated_at: number;
}

export interface DecisionConnectionInput {
  name: string;
  provider?: string;
  gateway: string;
  protocol?: string;
  api_url?: string;
  model?: string;
  account_id?: string;
  is_default?: boolean;
  api_key?: string;
}

export interface DecisionModelPreviewInput {
  connection_id?: string;
  provider?: string;
  gateway?: string;
  protocol?: string;
  api_url?: string;
  account_id?: string;
  api_key?: string;
}

export const decisionConnectionSecretKey = (id: string) => `decision_connection_${id}_api_key`;
export const isDecisionConnectionSecretKey = (key: string) => key.startsWith("decision_connection_") && key.endsWith("_api_key");

function profile(row: any): DecisionConnection {
  const { user_id: _userId, ...rest } = row;
  return { ...rest, is_default: !!row.is_default, has_api_key: !!row.has_api_key };
}

export function listConnections(userId: string): DecisionConnection[] {
  return (getDb().query("SELECT * FROM decision_connections WHERE user_id = ? ORDER BY updated_at DESC").all(userId) as any[]).map(profile);
}

export function getConnection(userId: string, id: string): DecisionConnection | null {
  const row = getDb().query("SELECT * FROM decision_connections WHERE id = ? AND user_id = ?").get(id, userId);
  return row ? profile(row) : null;
}

export function getDefaultConnection(userId: string): DecisionConnection | null {
  const row = getDb().query("SELECT * FROM decision_connections WHERE user_id = ? AND is_default = 1").get(userId);
  return row ? profile(row) : null;
}

function normalize(input: DecisionConnectionInput, existing?: DecisionConnection): Omit<DecisionConnection, "id" | "is_default" | "has_api_key" | "created_at" | "updated_at"> {
  const providerId = input.provider ?? existing?.provider ?? "jev";
  const provider = getDecisionProvider(providerId);
  if (!provider) throw new Error("Unknown decision provider");
  const gateway = input.gateway ?? existing?.gateway;
  const preset = provider.presets.find((entry) => entry.id === gateway);
  if (!gateway || (gateway !== "custom" && !preset)) throw new Error("Unknown decision gateway");
  const protocol = gateway === "custom" ? input.protocol ?? (providerId === existing?.provider && gateway === existing?.gateway ? existing?.protocol : undefined) : preset!.protocol;
  if (!protocol || !provider.protocols.includes(protocol)) throw new Error("Select a supported decision API protocol");
  const name = input.name?.trim() ?? existing?.name;
  const sameGateway = gateway === existing?.gateway && providerId === existing?.provider;
  const api_url = (input.api_url ?? (sameGateway ? existing?.api_url : preset?.url) ?? "").trim();
  const model = (input.model ?? (sameGateway ? existing?.model : preset?.model) ?? "").trim();
  const account_id = (input.account_id ?? (sameGateway ? existing?.account_id : "") ?? "").trim();
  if (!name || name.length > 100 || !api_url || !model) throw new Error("Name, API URL, and model are required");
  if (protocol === "cloudflare" && !account_id && api_url.includes("{account_id}")) throw new Error("Cloudflare account ID is required");
  let url: URL;
  try { url = new URL(api_url.replace("{account_id}", "example")); } catch { throw new Error("Enter a valid HTTPS API URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Enter a valid HTTPS API URL without credentials");
  return { name, provider: providerId, gateway, protocol, api_url, model, account_id };
}

export async function previewModels(userId: string, input: DecisionModelPreviewInput): Promise<DecisionModelList> {
  if (!input || typeof input !== "object" || Array.isArray(input) || "userId" in input || "user_id" in input) throw new Error("Invalid decision model preview");
  const existing = input.connection_id ? getConnection(userId, input.connection_id) : null;
  if (input.connection_id && !existing) throw new Error("Decision connection not found");
  const providerId = input.provider ?? existing?.provider ?? "jev";
  const provider = getDecisionProvider(providerId);
  if (!provider) throw new Error("Unknown decision provider");
  const gateway = input.gateway ?? existing?.gateway;
  const preset = provider.presets.find((entry) => entry.id === gateway);
  if (!gateway || (gateway !== "custom" && !preset)) throw new Error("Unknown decision gateway");
  const protocol = gateway === "custom" ? input.protocol ?? existing?.protocol : preset!.protocol;
  if (!protocol || !provider.protocols.includes(protocol)) throw new Error("Select a supported decision API protocol");
  const sameConnection = !!existing && existing.provider === providerId && existing.gateway === gateway && existing.protocol === protocol;
  const api_url = input.api_url !== undefined ? input.api_url.trim() || preset?.url || "" : sameConnection ? existing.api_url : preset?.url ?? "";
  const account_id = input.account_id ?? (sameConnection ? existing?.account_id : "") ?? "";
  let apiKey = input.api_key?.trim() ?? "";
  if (!apiKey && sameConnection && existing?.has_api_key && api_url === existing.api_url && account_id === existing.account_id) {
    apiKey = await secrets.getSecret(userId, decisionConnectionSecretKey(existing.id)) ?? "";
  }
  return provider.listModels({ protocol, api_url, account_id, apiKey });
}

export async function createConnection(userId: string, input: DecisionConnectionInput): Promise<DecisionConnection> {
  const values = normalize(input);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const isDefault = input.is_default || !getDefaultConnection(userId);
  if (input.api_key) await secrets.putSecret(userId, decisionConnectionSecretKey(id), input.api_key);
  try {
    getDb().transaction(() => {
      if (isDefault) getDb().query("UPDATE decision_connections SET is_default = 0 WHERE user_id = ?").run(userId);
      getDb().query(`INSERT INTO decision_connections
        (id, user_id, name, provider, gateway, protocol, api_url, model, account_id, is_default, has_api_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, userId, values.name, values.provider, values.gateway, values.protocol, values.api_url, values.model,
        values.account_id, isDefault ? 1 : 0, input.api_key ? 1 : 0, now, now,
      );
    })();
  } catch (error) {
    secrets.deleteSecret(userId, decisionConnectionSecretKey(id));
    throw error;
  }
  return getConnection(userId, id)!;
}

export async function updateConnection(userId: string, id: string, input: Partial<DecisionConnectionInput>): Promise<DecisionConnection | null> {
  const existing = getConnection(userId, id);
  if (!existing) return null;
  const values = normalize(input as DecisionConnectionInput, existing);
  if (input.api_key !== undefined) {
    if (input.api_key) await secrets.putSecret(userId, decisionConnectionSecretKey(id), input.api_key);
    else secrets.deleteSecret(userId, decisionConnectionSecretKey(id));
  }
  getDb().transaction(() => {
    if (input.is_default) getDb().query("UPDATE decision_connections SET is_default = 0 WHERE user_id = ?").run(userId);
    getDb().query(`UPDATE decision_connections SET name = ?, provider = ?, gateway = ?, protocol = ?, api_url = ?, model = ?, account_id = ?,
      is_default = ?, has_api_key = ?, updated_at = ? WHERE id = ? AND user_id = ?`).run(
      values.name, values.provider, values.gateway, values.protocol, values.api_url, values.model, values.account_id,
      input.is_default === undefined || (existing.is_default && !input.is_default) ? Number(existing.is_default) : Number(input.is_default),
      input.api_key === undefined ? Number(existing.has_api_key) : Number(!!input.api_key),
      Math.floor(Date.now() / 1000), id, userId,
    );
  })();
  return getConnection(userId, id)!;
}

export async function duplicateConnection(userId: string, id: string): Promise<DecisionConnection | null> {
  const existing = getConnection(userId, id);
  if (!existing) return null;
  let key: string | null = null;
  if (existing.has_api_key) {
    try { key = await secrets.getSecret(userId, decisionConnectionSecretKey(id)); } catch { /* Duplicate without an unreadable key. */ }
  }
  return createConnection(userId, { ...existing, name: `${existing.name} (Copy)`, is_default: false, api_key: key ?? undefined });
}

export function deleteConnection(userId: string, id: string): boolean {
  const existing = getConnection(userId, id);
  if (!existing) return false;
  getDb().transaction(() => {
    getDb().query("DELETE FROM decision_connections WHERE id = ? AND user_id = ?").run(id, userId);
    if (existing.is_default) {
      getDb().query("UPDATE decision_connections SET is_default = 1 WHERE id = (SELECT id FROM decision_connections WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1) AND user_id = ?").run(userId, userId);
    }
  })();
  secrets.deleteSecret(userId, decisionConnectionSecretKey(id));
  return true;
}

export async function evaluate(userId: string, request: DecisionRequest): Promise<DecisionResult> {
  validateDecisionRequest(request);
  const connection = request.connectionId ? getConnection(userId, request.connectionId) : getDefaultConnection(userId);
  if (!connection) throw new Error("Decision connection not found");
  const provider = getDecisionProvider(connection.provider);
  if (!provider) throw new Error("Decision provider is unavailable");
  if (!connection.has_api_key) throw new Error("Decision connection needs an API key");
  const apiKey = await secrets.getSecret(userId, decisionConnectionSecretKey(connection.id));
  if (!apiKey) throw new Error("Decision connection needs an API key");
  return provider.evaluate({ ...connection, apiKey }, request);
}

export async function testConnection(userId: string, id: string): Promise<{ success: boolean; message: string }> {
  if (!getConnection(userId, id)) return { success: false, message: "Connection not found" };
  try {
    await evaluate(userId, { connectionId: id, state: "The service is available.", questions: { available: { type: "noul", instructions: "Is the service available?" } } });
    return { success: true, message: "Connection successful" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Decision connection failed";
    return { success: false, message: message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]") };
  }
}
