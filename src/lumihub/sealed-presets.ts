import { getLinkConfig } from "../services/lumihub-link.service";

export type SealedManifest = {
  version?: string | null;
  blocks?: Array<{ key?: string; sha256?: string }>;
};

const cache = new Map<string, Promise<Record<string, string>>>();

export async function resolveSealedPresetBlock(
  userId: string,
  presetMetadata: Record<string, any> | undefined,
  blockKey: string,
): Promise<string> {
  if (!presetMetadata || !blockKey) return "";
  const hubPresetId = typeof presetMetadata._lumiverse_lumihub_id === "string"
    ? presetMetadata._lumiverse_lumihub_id
    : "";
  const manifest = isPlainObject(presetMetadata._lumiverse_sealed_preset)
    ? presetMetadata._lumiverse_sealed_preset as SealedManifest
    : null;
  if (!hubPresetId || !manifest?.blocks?.length) return "";

  const expected = manifest.blocks.find((block) => block.key === blockKey)?.sha256;
  if (!expected) return "";

  const version = typeof manifest.version === "string"
    ? manifest.version
    : typeof presetMetadata._lumiverse_preset_version === "string"
      ? presetMetadata._lumiverse_preset_version
      : null;
  const cacheKey = `${userId}:${hubPresetId}:${version ?? ""}`;
  let pending = cache.get(cacheKey);
  if (!pending) {
    pending = fetchSealedBlocks(userId, hubPresetId, version, manifest);
    cache.set(cacheKey, pending);
  }

  try {
    const blocks = await pending;
    return blocks[blockKey] || "";
  } catch (err) {
    cache.delete(cacheKey);
    console.warn("[LumiHub] Failed to resolve sealed preset block:", err);
    return "";
  }
}

export async function resolveSealedPresetBlocksForInstall(
  userId: string,
  hubPresetId: string,
  version: string | null,
  manifest: SealedManifest,
): Promise<Record<string, string>> {
  if (!hubPresetId || !manifest.blocks?.length) return {};
  return fetchSealedBlocks(userId, hubPresetId, version, manifest);
}

async function fetchSealedBlocks(
  userId: string,
  hubPresetId: string,
  version: string | null,
  manifest: SealedManifest,
): Promise<Record<string, string>> {
  const config = await getLinkConfig(userId);
  if (!config) return {};

  const base = config.lumihubUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/api/v1/presets/${encodeURIComponent(hubPresetId)}/sealed-blocks`);
  if (version) url.searchParams.set("version", version);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.linkToken}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json() as { blocks?: Record<string, string> };
  const rawBlocks = isPlainObject(json.blocks) ? json.blocks : {};
  const out: Record<string, string> = {};

  for (const entry of manifest.blocks || []) {
    if (typeof entry.key !== "string" || typeof entry.sha256 !== "string") continue;
    const content = rawBlocks[entry.key];
    if (typeof content !== "string") continue;
    if (await sha256(content) !== entry.sha256) continue;
    out[entry.key] = content;
  }
  return out;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
