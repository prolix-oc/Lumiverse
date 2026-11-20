import type { FileSystem } from "../file-connections/types";
import { getDb } from "../db/connection";
import * as connectionsSvc from "../services/connections.service";
import * as secretsSvc from "../services/secrets.service";
import {
  readConnectionsFromDisk,
  readProxiesFromDisk,
  readSecretsFromDisk,
  type MigrationLogger,
} from "./st-reader";

interface ConnectionCandidate {
  name: string;
  provider: string;
  api_url: string;
  model: string;
  api_key?: string;
  metadata: Record<string, unknown>;
}

interface ConnectionProfileRow {
  id: string;
  name: string;
  provider: string;
  api_url: string;
  model: string;
  preset_id?: string | null;
  is_default?: number | boolean;
  has_api_key?: number | boolean;
  metadata: Record<string, unknown>;
}

const normalized = (value: unknown) => typeof value === "string" ? value.trim() : "";
const normalizedName = (value: unknown) => normalized(value).replace(/\s+/g, " ");

function inferProvider(api: string, apiUrl: string): string {
  const value = api.toLowerCase();
  const url = apiUrl.toLowerCase();
  if (value === "claude") return "anthropic";
  if (value === "google" || value === "makersuite") return "google";
  if (value === "vertexai") return "google_vertex";
  if (value === "openai") return url.includes("api.openai.com") || !url ? "openai" : "custom";
  if (value === "infermaticai") return "infermatic";
  for (const [needle, provider] of [["openrouter.ai", "openrouter"], ["api.deepseek.com", "deepseek"], ["api.groq.com", "groq"], ["api.mistral.ai", "mistral"], ["api.x.ai", "xai"], ["api.fireworks.ai", "fireworks"], ["api.perplexity.ai", "perplexity"], ["electronhub", "electronhub"], ["siliconflow", "siliconflow"], ["nano-gpt.com", "nanogpt"], ["chutes.ai", "chutes"], ["infermatic", "infermatic"], ["pollinations.ai", "pollinations_text"]] as const) {
    if (url.includes(needle)) return provider;
  }
  return value === "openrouter" || value === "groq" || value === "mistral" ? value : "custom";
}

function connectionKey(value: Pick<ConnectionCandidate, "name" | "provider" | "api_url" | "model">): string {
  return [value.name, value.provider, value.api_url.replace(/\/+$/, ""), value.model]
    .map((part) => part.trim().toLowerCase()).join("\0");
}
interface SecretLookup {
  byId: Map<string, string>;
  activeByCategory: Map<string, string>;
}

function secretLookup(secrets: Record<string, Array<{ id?: string; value?: string; active?: boolean }>>): SecretLookup {
  const byId = new Map<string, string>();
  const activeByCategory = new Map<string, string>();
  for (const [category, entries] of Object.entries(secrets)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (normalized(entry.id) && normalized(entry.value)) byId.set(normalized(entry.id), normalized(entry.value));
    }
    const selected = entries.find((entry) => entry?.active && normalized(entry.value)) ?? entries.find((entry) => normalized(entry.value));
    if (selected && normalized(selected.value)) activeByCategory.set(category, normalized(selected.value));
  }
  return { byId, activeByCategory };
}

function resolveProfileSecret(
  profile: Record<string, unknown>,
  provider: string,
  lookup: SecretLookup,
): string | undefined {
  const id = normalized(profile["secret-id"]);
  if (id && lookup.byId.has(id)) return lookup.byId.get(id);
  const api = normalized(profile.api).toLowerCase();
  const categories = [`api_key_${api}`, `api_key_${provider}`];
  if (provider === "anthropic") categories.push("api_key_claude");
  if (provider === "google") categories.push("api_key_makersuite", "api_key_makersuite_custom");
  if (provider === "google_vertex") categories.push("api_key_vertexai", "vertexai_service_account_json");
  if (provider === "custom") categories.push("api_key_custom", "api_key_generic");
  return categories.map((category) => lookup.activeByCategory.get(category)).find(Boolean);
}

function parseConnectionRow(row: Record<string, unknown>): ConnectionProfileRow {
  const rawMetadata = row.metadata;
  let metadata: Record<string, unknown> = {};
  if (typeof rawMetadata === "string") {
    try {
      const parsed: unknown = JSON.parse(rawMetadata);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      metadata = {};
    }
  } else if (rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)) {
    metadata = rawMetadata as Record<string, unknown>;
  }
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    provider: String(row.provider ?? ""),
    api_url: String(row.api_url ?? ""),
    model: String(row.model ?? ""),
    preset_id: typeof row.preset_id === "string" ? row.preset_id : null,
    is_default: Boolean(row.is_default),
    has_api_key: Boolean(row.has_api_key),
    metadata,
  };
}

export async function importSTConnections(
  userId: string,
  dataDir: string,
  options: { repairExisting?: boolean; dryRun?: boolean },
  logger: MigrationLogger,
  fs: FileSystem,
): Promise<{ imported: number; repaired: number; skipped: number; failed: number; dry_run: boolean }> {
  const [profiles, proxies, secrets] = await Promise.all([
    readConnectionsFromDisk(dataDir, fs),
    readProxiesFromDisk(dataDir, fs),
    readSecretsFromDisk(dataDir, fs),
  ]);
  const lookup = secretLookup(secrets);
  const candidates: ConnectionCandidate[] = [];
  let skipped = 0;
  for (const profile of profiles) {
    const record = profile as unknown as Record<string, unknown>;
    if (normalized(record.mode).toLowerCase() === "tc") { skipped++; continue; }
    const name = normalizedName(record.name);
    const api_url = normalized(record["api-url"]);
    if (!name || !api_url) { skipped++; continue; }
    const provider = inferProvider(normalized(record.api), api_url);
    candidates.push({
      name,
      provider,
      api_url,
      model: normalized(record.model),
      api_key: resolveProfileSecret(record, provider, lookup),
      metadata: {
        source: "sillytavern",
        source_kind: "connection_profile",
        st_profile_id: normalized(record.id) || undefined,
        st_api: normalized(record.api) || undefined,
        st_mode: normalized(record.mode) || undefined,
        st_direct_api_url: api_url,
        st_proxy_name: normalizedName(record.proxy) || undefined,
        st_preset: normalized(record.preset) || undefined,
      },
    });
  }
  for (const proxy of proxies) {
    const record = proxy as unknown as Record<string, unknown>;
    const proxyName = normalizedName(record.name);
    const api_url = normalized(record.url);
    if (!proxyName || proxyName.toLowerCase() === "none" || !api_url) { skipped++; continue; }
    candidates.push({
      name: `Proxy: ${proxyName}`,
      provider: inferProvider("custom", api_url),
      api_url,
      model: "",
      api_key: normalized(record.password) || undefined,
      metadata: { source: "sillytavern", source_kind: "reverse_proxy", st_proxy_name: proxyName },
    });
  }
  const existingRows = getDb().query("SELECT * FROM connection_profiles WHERE user_id = ?").all(userId) as Array<Record<string, unknown>>;
  const existing = existingRows.map(parseConnectionRow);
  const existingKeys = new Set(existing.map(connectionKey));
  const seen = new Set<string>();
  const planned = candidates.filter((candidate) => {
    const key = connectionKey(candidate);
    if (existingKeys.has(key) || seen.has(key)) { skipped++; return false; }
    seen.add(key);
    return true;
  });
  if (options.dryRun) return { imported: planned.length, repaired: 0, skipped, failed: 0, dry_run: true };

  const createdIds: string[] = [];
  const repaired: Array<{ profile: ConnectionProfileRow; secret: string | null }> = [];
  let imported = 0;
  let repairedCount = 0;
  try {
    for (let index = 0; index < planned.length; index++) {
      logger.progress("Importing connections", index + 1, planned.length);
      const candidate = planned[index];
      const sourceKind = candidate.metadata.source_kind;
      const repairTarget = options.repairExisting
        ? existing.find((profile) =>
          profile.metadata.source === "sillytavern"
          && profile.metadata.source_kind === sourceKind
          && (
            (sourceKind === "connection_profile" && candidate.metadata.st_profile_id && profile.metadata.st_profile_id === candidate.metadata.st_profile_id)
            || (sourceKind === "reverse_proxy" && profile.metadata.st_proxy_name === candidate.metadata.st_proxy_name)
          ))
        : undefined;
      if (repairTarget) {
        repaired.push({
          profile: repairTarget,
          secret: repairTarget.has_api_key ? await secretsSvc.getSecret(userId, connectionsSvc.connectionSecretKey(repairTarget.id)) : null,
        });
        await connectionsSvc.updateConnection(userId, repairTarget.id, { ...candidate, is_default: false });
        repairedCount++;
      } else {
        const created = await connectionsSvc.createConnection(userId, { ...candidate, is_default: false });
        createdIds.push(created.id);
        imported++;
      }
    }
    return { imported, repaired: repairedCount, skipped, failed: 0, dry_run: false };
  } catch {
    for (const id of createdIds) {
      getDb().query("DELETE FROM connection_profiles WHERE id = ? AND user_id = ?").run(id, userId);
      secretsSvc.deleteSecret(userId, connectionsSvc.connectionSecretKey(id));
    }
    for (const snapshot of repaired.reverse()) {
      const { profile } = snapshot;
      await connectionsSvc.updateConnection(userId, profile.id, {
        name: profile.name,
        provider: profile.provider,
        api_url: profile.api_url,
        model: profile.model,
        preset_id: profile.preset_id ?? undefined,
        is_default: Boolean(profile.is_default),
        metadata: profile.metadata,
        api_key: snapshot.secret ?? "",
      });
    }
    logger.error("Connection migration failed and was rolled back");
    throw new Error("Connection migration failed");
  }
}
