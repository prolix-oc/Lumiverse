import { getLinkConfig, type LinkConfig } from "../services/lumihub-link.service";
import { PORTABLE_JSON_MAX_NODES, PORTABLE_PRESET_FIELDS_MAX_BYTES } from "../services/agent-config-portability.service";
import { COGNITION_MAX_LIST_ITEMS, COGNITION_MAX_STRING_BYTES } from "../types/agent-cognition";
import { safeFetch } from "../utils/safe-fetch";

export type SealedManifest = {
  version?: string | null;
  blocks?: Array<{ key?: string; sha256?: string }>;
};
export type PortableSealedPresetDescriptor = {
  hubPresetId: string;
  hubPresetVersion: string;
  blocks: Array<{ key: string; sha256: string }>;
};

export type PortableSealedPresetErrorCode =
  | "LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE"
  | "LUMIHUB_LINK_UNAVAILABLE"
  | "LUMIHUB_SEALED_RESOLUTION_FAILED"
  | "LUMIHUB_SEALED_DIGEST_MISMATCH";

export class PortableSealedPresetError extends Error {
  constructor(public readonly code: PortableSealedPresetErrorCode) {
    super(code);
    this.name = "PortableSealedPresetError";
  }
}


const cache = new Map<string, Promise<Record<string, string>>>();

export async function resolveSealedPresetBlock(
  userId: string,
  presetMetadata: Record<string, any> | undefined,
  blockKey: string,
): Promise<string> {
  if (!presetMetadata || typeof blockKey !== "string" || !blockKey) return "";
  const hubPresetId = typeof presetMetadata._lumiverse_lumihub_id === "string"
    ? presetMetadata._lumiverse_lumihub_id
    : "";
  const manifest = isPlainObject(presetMetadata._lumiverse_sealed_preset)
    ? presetMetadata._lumiverse_sealed_preset as SealedManifest
    : null;
  if (!hubPresetId || !manifest) return "";

  let normalizedManifest: NormalizedSealedManifest;
  let normalizedHubPresetId: string;
  let normalizedBlockKey: string;
  try {
    normalizedManifest = normalizeSealedManifest(manifest);
    normalizedHubPresetId = boundedSealedString(hubPresetId, { bytes: 0, nodes: 0 });
    normalizedBlockKey = boundedSealedString(blockKey, { bytes: 0, nodes: 0 });
  } catch {
    return "";
  }
  if (normalizedManifest.blocks.length === 0) return "";

  const expected = normalizedManifest.blocks.find((block) => block.key === normalizedBlockKey)?.sha256;
  if (!expected) return "";

  const fallbackVersion = typeof presetMetadata._lumiverse_preset_version === "string"
    ? presetMetadata._lumiverse_preset_version
    : null;
  let version: string | null;
  try {
    version = normalizedManifest.version
      ?? (fallbackVersion === null ? null : boundedSealedString(fallbackVersion, { bytes: 0, nodes: 0 }));
  } catch {
    return "";
  }
  const cacheKey = `${userId}:${normalizedHubPresetId}:${version ?? ""}`;
  let pending = cache.get(cacheKey);
  if (!pending) {
    pending = fetchSealedBlocks(userId, normalizedHubPresetId, version, normalizedManifest);
    cache.set(cacheKey, pending);
  }

  try {
    const blocks = await pending;
    return blocks[normalizedBlockKey] || "";
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

  return fetchVerifiedSealedBlocks(
    { lumihubUrl: config.lumihubUrl, linkToken: config.linkToken },
    hubPresetId,
    version,
    manifest,
  );
}

type SealedFetchConfig = { lumihubUrl: string; linkToken: string };
type SealedRequest = (url: string, headers: HeadersInit) => Promise<Response>;

/**
 * Fetch and cryptographically verify the Hub-side contents. Exported so the
 * wire contract can be smoke-tested without weakening production token storage.
 */
export async function fetchVerifiedSealedBlocks(
  config: SealedFetchConfig,
  hubPresetId: string,
  version: string | null,
  manifest: SealedManifest,
  request: SealedRequest = (url, headers) => safeFetch(url, {
    headers,
    timeoutMs: 15_000,
    maxBytes: 2 * 1024 * 1024,
  }),
): Promise<Record<string, string>> {
  const stringState = { bytes: 0, nodes: 0 };
  const boundedHubPresetId = boundedSealedString(hubPresetId, stringState);
  const boundedVersion = version === null ? null : boundedSealedString(version, stringState);
  const normalizedManifest = normalizeSealedManifest(manifest);

  const base = config.lumihubUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/api/v1/presets/${encodeURIComponent(boundedHubPresetId)}/sealed-blocks`);
  if (boundedVersion) url.searchParams.set("version", boundedVersion);

  const res = await request(url.toString(), { Authorization: `Bearer ${config.linkToken}` });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json() as { blocks?: Record<string, string> };
  const rawBlocks = isPlainObject(json.blocks) ? json.blocks : {};
  const out: Record<string, string> = Object.create(null);

  for (const entry of normalizedManifest.blocks) {
    const content = rawBlocks[entry.key];
    if (typeof content !== "string") {
      throw new Error(`LumiHub response is missing sealed prompt block: ${entry.key}`);
    }
    if (await sha256(content) !== entry.sha256) {
      throw new Error(`LumiHub sealed prompt block failed hash verification: ${entry.key}`);
    }
    out[entry.key] = content;
  }
  return out;
}

export async function resolvePortableSealedPresetBlocks(
  userId: string,
  rawDescriptor: unknown,
): Promise<Record<string, string>> {
  const descriptor = parsePortableSealedPresetDescriptor(rawDescriptor);
  let config: LinkConfig | null;
  try {
    config = await getLinkConfig(userId);
  } catch {
    throw new PortableSealedPresetError("LUMIHUB_LINK_UNAVAILABLE");
  }
  if (!config) throw new PortableSealedPresetError("LUMIHUB_LINK_UNAVAILABLE");

  const manifest: SealedManifest = {
    version: descriptor.hubPresetVersion,
    blocks: descriptor.blocks,
  };
  try {
    return await fetchVerifiedSealedBlocks(
      { lumihubUrl: config.lumihubUrl, linkToken: config.linkToken },
      descriptor.hubPresetId,
      descriptor.hubPresetVersion,
      manifest,
    );
  } catch (error) {
    if (error instanceof PortableSealedPresetError) throw error;
    const message = error instanceof Error ? error.message : "";
    if (message.includes("hash verification")) {
      throw new PortableSealedPresetError("LUMIHUB_SEALED_DIGEST_MISMATCH");
    }
    throw new PortableSealedPresetError("LUMIHUB_SEALED_RESOLUTION_FAILED");
  }
}

type PortableSealedImportPreset = {
  prompt_order?: unknown;
  metadata?: Record<string, unknown>;
};

export type PortableSealedPresetResolver = (
  userId: string,
  descriptor: PortableSealedPresetDescriptor,
) => Promise<Record<string, string>>;

/**
 * Resolve and materialize every sealed placeholder before the synchronous
 * preset importer is allowed to enter its transaction.
 */
export async function materializePortableSealedPresetImport<T extends PortableSealedImportPreset>(
  userId: string,
  preset: T,
  resolveBlocks: PortableSealedPresetResolver = resolvePortableSealedPresetBlocks,
): Promise<T> {
  const rawMetadata = preset.metadata;
  const hasPortableDescriptor = isPlainObject(rawMetadata)
    && Object.hasOwn(rawMetadata, "portableSealedPreset");
  if (!Array.isArray(preset.prompt_order)) {
    if (hasPortableDescriptor) {
      throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    }
    return preset;
  }
  if (Object.getPrototypeOf(preset.prompt_order) !== Array.prototype || preset.prompt_order.length > COGNITION_MAX_LIST_ITEMS) {
    throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
  }
  const sealedBlocks = preset.prompt_order.filter((value) => (
    isPlainObject(value)
    && (
      value.sealed === true
      || value.sealedSource === "lumihub"
      || Object.hasOwn(value, "sealedSource")
      || (Object.hasOwn(value, "sealed") && value.sealed !== false)
      || (typeof value.content === "string"
        && /^\{\{(?:presetBlock|pblock)::[^}]+\}\}$/.test(value.content.trim()))
    )
  ));
  if (sealedBlocks.length === 0) {
    if (!hasPortableDescriptor) return preset;
    throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
  }

  const descriptor = parsePortableSealedPresetDescriptor(rawMetadata?.portableSealedPreset);
  const expectedByKey = new Map(descriptor.blocks.map((entry) => [entry.key, entry.sha256]));
  const blockState: SealedBudget = { bytes: 0, nodes: 0 };
  const blockKeys = sealedBlocks.map((value) => {
    if (!isPlainObject(value)) throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    if (Object.hasOwn(value, "sealed") && value.sealed !== true) {
      throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    }
    if (Object.hasOwn(value, "sealedSource") && value.sealedSource !== "lumihub") {
      throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    }
    const rawSealedKey = value.sealedKey;
    if (rawSealedKey !== undefined && typeof rawSealedKey !== "string") {
      throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    }
    const key = rawSealedKey === undefined
      ? ""
      : boundedSealedString(rawSealedKey, blockState);
    const rawContent = value.content;
    if (typeof rawContent !== "string") {
      throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    }
    const content = boundedSealedString(rawContent, blockState);
    const placeholderKey = content.match(/^\{\{(?:presetBlock|pblock)::([^}]+)\}\}$/)?.[1]?.trim() ?? "";
    const resolvedKey = placeholderKey;
    const expectedDigest = expectedByKey.get(resolvedKey);
    const rawSealedSha256 = value.sealedSha256;
    if (rawSealedSha256 !== undefined && typeof rawSealedSha256 !== "string") {
      throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    }
    const sealedSha256 = rawSealedSha256 === undefined
      ? undefined
      : boundedSealedString(rawSealedSha256, blockState).toLowerCase();
    const rawOriginPresetId = value.sealedOriginPresetId;
    const originPresetId = rawOriginPresetId === undefined
      ? undefined
      : boundedSealedString(rawOriginPresetId, blockState);
    const rawOriginVersion = value.sealedOriginVersion;
    const originVersion = rawOriginVersion === undefined
      ? undefined
      : boundedSealedString(rawOriginVersion, blockState);
    if (!resolvedKey || !expectedDigest
      || (key && key !== placeholderKey)
      || (originPresetId !== undefined && originPresetId !== descriptor.hubPresetId)
      || (originVersion !== undefined && originVersion !== descriptor.hubPresetVersion)
      || (sealedSha256 !== undefined && sealedSha256 !== expectedDigest)) {
      throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    }
    return { value, key: resolvedKey, expectedDigest };
  });
  const actualKeys = new Set<string>();
  for (const entry of blockKeys) {
    if (actualKeys.has(entry.key)) {
      throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    }
    actualKeys.add(entry.key);
  }
  if (actualKeys.size !== descriptor.blocks.length || descriptor.blocks.some((entry) => !actualKeys.has(entry.key))) {
    throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
  }

  const resolved = await resolveBlocks(userId, descriptor);
  if (!isPlainObject(resolved)) {
    throw new PortableSealedPresetError("LUMIHUB_SEALED_RESOLUTION_FAILED");
  }
  for (const entry of descriptor.blocks) {
    if (!Object.hasOwn(resolved, entry.key) || typeof resolved[entry.key] !== "string") {
      throw new PortableSealedPresetError("LUMIHUB_SEALED_RESOLUTION_FAILED");
    }
    if (await sha256(resolved[entry.key]) !== entry.sha256) {
      throw new PortableSealedPresetError("LUMIHUB_SEALED_DIGEST_MISMATCH");
    }
  }

  const blockByValue = new Map(blockKeys.map((entry) => [entry.value, entry]));
  const prompt_order = preset.prompt_order.map((value) => {
    const entry = blockByValue.get(value);
    if (!entry) return value;
    return {
      ...(value as Record<string, unknown>),
      content: resolved[entry.key],
      sealed: true,
      sealedKey: entry.key,
      sealedSource: "lumihub",
      sealedOriginPresetId: descriptor.hubPresetId,
      sealedOriginVersion: descriptor.hubPresetVersion,
      sealedSha256: entry.expectedDigest,
    };
  });
  return { ...preset, prompt_order } as T;
}

type NormalizedSealedManifest = {
  version: string | null;
  blocks: Array<{ key: string; sha256: string }>;
};

type SealedBudget = { bytes: number; nodes: number };

const SEALED_UTF8_ENCODER = new TextEncoder();

function boundedSealedString(
  raw: unknown,
  state: SealedBudget,
  maxBytes = COGNITION_MAX_STRING_BYTES,
): string {
  if (typeof raw !== "string") throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
  const bytes = SEALED_UTF8_ENCODER.encode(raw).byteLength;
  if (bytes > maxBytes) throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
  state.bytes += bytes;
  if (state.bytes > PORTABLE_PRESET_FIELDS_MAX_BYTES) throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
  state.nodes += 1;
  if (state.nodes > PORTABLE_JSON_MAX_NODES) throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
  const value = raw.trim();
  if (!value) throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
  return value;
}

function boundedOwnStringKeys(raw: Record<string, unknown>, max: number): string[] {
  const keys: string[] = [];
  for (const key in raw) {
    if (!Object.hasOwn(raw, key)) continue;
    if (keys.length >= max) throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    keys.push(key);
  }
  return keys;
}

function normalizeSealedManifest(raw: unknown): NormalizedSealedManifest {
  if (!isPlainObject(raw) || Object.keys(raw).some((key) => key !== "version" && key !== "blocks")) {
    throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
  }
  const state: SealedBudget = { bytes: 0, nodes: 1 };
  const version = raw.version === undefined || raw.version === null
    ? null
    : boundedSealedString(raw.version, state);
  const rawBlocks = raw.blocks;
  if (rawBlocks === undefined) return { version, blocks: [] };
  if (!Array.isArray(rawBlocks) || Object.getPrototypeOf(rawBlocks) !== Array.prototype) {
    throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
  }
  if (rawBlocks.length > COGNITION_MAX_LIST_ITEMS) {
    throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
  }
  state.nodes += 1;
  if (state.nodes + rawBlocks.length * 3 > PORTABLE_JSON_MAX_NODES) {
    throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
  }
  const normalized: Array<{ key: string; sha256: string }> = [];
  for (const entry of rawBlocks) {
    if (!isPlainObject(entry)) {
      throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    }
    const keys = boundedOwnStringKeys(entry, 2);
    if (keys.length !== 2 || keys.some((key) => key !== "key" && key !== "sha256")) {
      throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    }
    state.nodes += 1;
    if (state.nodes > PORTABLE_JSON_MAX_NODES) {
      throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    }
    const key = boundedSealedString(entry.key, state);
    const sha256 = boundedSealedString(entry.sha256, state).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    }
    normalized.push({ key, sha256 });
  }
  const seen = new Set<string>();
  for (const entry of normalized) {
    if (seen.has(entry.key)) throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    seen.add(entry.key);
  }
  return { version, blocks: normalized };
}

/**
 * Parse an install-time sealed manifest with the same bounds and digest
 * normalization used by every sealed-block fetch path.
 */
export function parseSealedPresetManifest(raw: unknown): SealedManifest {
  if (!isPlainObject(raw) || !Object.hasOwn(raw, "blocks") || !Array.isArray(raw.blocks)) {
    throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
  }
  return normalizeSealedManifest(raw);
}

export function parsePortableSealedPresetDescriptor(raw: unknown): PortableSealedPresetDescriptor {
  if (!isPlainObject(raw)) {
    throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
  }
  const keys = boundedOwnStringKeys(raw, 3);
  if (keys.length !== 3 || keys.some((key) => !["hubPresetId", "hubPresetVersion", "blocks"].includes(key))) {
    throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
  }
  if (!Array.isArray(raw.blocks) || Object.getPrototypeOf(raw.blocks) !== Array.prototype || raw.blocks.length === 0) {
    throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
  }
  if (raw.blocks.length > COGNITION_MAX_LIST_ITEMS) {
    throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
  }
  const state: SealedBudget = { bytes: 0, nodes: 1 };
  const hubPresetId = boundedSealedString(raw.hubPresetId, state);
  const hubPresetVersion = boundedSealedString(raw.hubPresetVersion, state);
  state.nodes += 1;
  if (state.nodes + raw.blocks.length * 3 > PORTABLE_JSON_MAX_NODES) {
    throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
  }
  const entries: Array<{ key: string; sha256: string }> = [];
  for (const entry of raw.blocks) {
    if (!isPlainObject(entry)) {
      throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    }
    const entryKeys = boundedOwnStringKeys(entry, 2);
    if (entryKeys.length !== 2 || entryKeys.some((key) => key !== "key" && key !== "sha256")) {
      throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    }
    state.nodes += 1;
    if (state.nodes > PORTABLE_JSON_MAX_NODES) {
      throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    }
    const key = boundedSealedString(entry.key, state);
    const sha256 = boundedSealedString(entry.sha256, state).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    }
    entries.push({ key, sha256 });
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.key)) throw new PortableSealedPresetError("LUMIHUB_SEALED_DESCRIPTOR_INCOMPLETE");
    seen.add(entry.key);
  }
  return { hubPresetId, hubPresetVersion, blocks: entries };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
