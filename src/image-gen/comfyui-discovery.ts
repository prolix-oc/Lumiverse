/**
 * ComfyUI Server Capability Discovery
 *
 * Queries /object_info to discover available resources (models, LoRAs, VAEs, etc.)
 * and installed node packs on a ComfyUI server.
 */

import type { ComfyUICapabilities } from "./types";

// Cache: key = apiUrl, value = { capabilities, timestamp }
const cache = new Map<string, { capabilities: ComfyUICapabilities; timestamp: number }>();
const objectInfoCache = new Map<string, { objectInfo: ComfyUIObjectInfo; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export type ComfyUIObjectInfo = Record<string, {
  input?: {
    required?: Record<string, any>;
    optional?: Record<string, any>;
  };
}>;

export interface ComfyDiscoveryOptions {
  // Optional Cookie header value — used for SwarmUI's /ComfyBackendDirect proxy.
  cookie?: string;
}

/**
 * Resolve a connection profile to the ComfyUI HTTP base URL + optional auth
 * cookie. For native `comfyui` connections this is just the API URL; for
 * `swarmui` it's the /ComfyBackendDirect proxy plus a swarm_token cookie.
 */
export function resolveComfyTarget(
  connection: { provider: string; api_url?: string | null },
  apiKey?: string | null,
): { baseUrl: string; cookie?: string } {
  const raw = connection.api_url
    || (connection.provider === "swarmui" ? "http://localhost:7801" : "http://localhost:8188");
  const trimmed = raw.replace(/\/+$/, "");
  if (connection.provider === "swarmui") {
    return {
      baseUrl: `${trimmed}/ComfyBackendDirect`,
      cookie: apiKey ? `swarm_token=${apiKey}` : undefined,
    };
  }
  return { baseUrl: trimmed };
}

function buildHeaders(cookie?: string): Record<string, string> | undefined {
  return cookie ? { Cookie: cookie } : undefined;
}

async function queryNodeInfo(
  baseUrl: string,
  nodeType: string,
  opts?: ComfyDiscoveryOptions,
): Promise<Record<string, any> | null> {
  try {
    const res = await fetch(`${baseUrl}/object_info/${encodeURIComponent(nodeType)}`, {
      headers: buildHeaders(opts?.cookie),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data[nodeType] ?? null;
  } catch {
    return null;
  }
}

async function queryAllNodeInfo(
  baseUrl: string,
  opts?: ComfyDiscoveryOptions,
): Promise<ComfyUIObjectInfo | null> {
  try {
    const res = await fetch(`${baseUrl}/object_info`, {
      headers: buildHeaders(opts?.cookie),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json() as ComfyUIObjectInfo;
  } catch {
    return null;
  }
}

export async function getComfyUIObjectInfo(
  apiUrl: string,
  forceRefresh = false,
  opts?: ComfyDiscoveryOptions,
): Promise<ComfyUIObjectInfo | null> {
  const cached = objectInfoCache.get(apiUrl);
  if (!forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.objectInfo;
  }

  const objectInfo = await queryAllNodeInfo(apiUrl, opts);
  if (!objectInfo) return null;

  objectInfoCache.set(apiUrl, { objectInfo, timestamp: Date.now() });
  return objectInfo;
}

export async function getAvailableNodeTypes(
  apiUrl: string,
  nodeTypes: string[],
  opts?: ComfyDiscoveryOptions,
): Promise<Set<string>> {
  const allNodeInfo = await queryAllNodeInfo(apiUrl, opts);
  if (allNodeInfo && typeof allNodeInfo === "object") {
    const availableNodeTypes = new Set(Object.keys(allNodeInfo));
    return new Set(
      nodeTypes.filter((nodeType) => availableNodeTypes.has(nodeType)),
    );
  }

  const available = await Promise.all(
    nodeTypes.map(async (nodeType) => ({
      nodeType,
      exists: (await queryNodeInfo(apiUrl, nodeType, opts)) !== null,
    })),
  );

  return new Set(
    available.filter((item) => item.exists).map((item) => item.nodeType),
  );
}

/**
 * Extract the available options for a specific input field from a node's object_info.
 */
function extractOptions(
  nodeInfo: Record<string, any> | null,
  fieldName: string,
): string[] {
  if (!nodeInfo) return [];
  const field = nodeInfo.input?.required?.[fieldName];
  if (!Array.isArray(field)) return [];
  // Old format: first element is an array of strings
  if (Array.isArray(field[0])) {
    return field[0] as string[];
  }
  // New COMBO format: first element is "COMBO", second has { options: [...] }
  if (field[0] === "COMBO" && field[1]?.options && Array.isArray(field[1].options)) {
    return field[1].options as string[];
  }
  return [];
}

/**
 * Discover all capabilities of a ComfyUI server.
 * Queries multiple /object_info endpoints and builds a capability manifest.
 */
export async function discoverCapabilities(
  apiUrl: string,
  forceRefresh = false,
  opts?: ComfyDiscoveryOptions,
): Promise<ComfyUICapabilities> {
  const cached = cache.get(apiUrl);
  if (!forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.capabilities;
  }

  // Query all relevant node types in parallel
  const [
    checkpointInfo,
    unetInfo,
    clipInfo,
    dualClipInfo,
    vaeInfo,
    loraInfo,
    kSamplerInfo,
    upscaleModelInfo,
    ultralyticsInfo,
    ultimateUpscaleInfo,
    faceDetailerInfo,
    controlnetInfo,
  ] = await Promise.all([
    queryNodeInfo(apiUrl, "CheckpointLoaderSimple", opts),
    queryNodeInfo(apiUrl, "UNETLoader", opts),
    queryNodeInfo(apiUrl, "CLIPLoader", opts),
    queryNodeInfo(apiUrl, "DualCLIPLoader", opts),
    queryNodeInfo(apiUrl, "VAELoader", opts),
    queryNodeInfo(apiUrl, "LoraLoader", opts),
    queryNodeInfo(apiUrl, "KSampler", opts),
    queryNodeInfo(apiUrl, "UpscaleModelLoader", opts),
    queryNodeInfo(apiUrl, "UltralyticsDetectorProvider", opts),
    queryNodeInfo(apiUrl, "UltimateSDUpscale", opts),
    queryNodeInfo(apiUrl, "FaceDetailer", opts),
    queryNodeInfo(apiUrl, "ControlNetApplyAdvanced", opts),
  ]);

  const checkpoints = extractOptions(checkpointInfo, "ckpt_name");
  const unets = extractOptions(unetInfo, "unet_name");
  const clips = extractOptions(clipInfo, "clip_name");
  const dualClips = extractOptions(dualClipInfo, "clip_name1");
  const vaes = extractOptions(vaeInfo, "vae_name").filter(v => v.includes(".") || v.includes("/"));
  const loras = extractOptions(loraInfo, "lora_name");
  const upscaleModels = extractOptions(upscaleModelInfo, "model_name");
  const detectorModels = extractOptions(ultralyticsInfo, "model_name");
  const samplers = extractOptions(kSamplerInfo, "sampler_name");
  const schedulers = extractOptions(kSamplerInfo, "scheduler");
  const modelLoaderType: ComfyUICapabilities["modelLoaderType"] =
    checkpoints.length > 0 && unets.length > 0 ? "both"
    : unets.length > 0 ? "unet"
    : "checkpoint";

  // Determine CLIP loader type based on actual available clips
  const clipLoaderType: ComfyUICapabilities["clipLoaderType"] =
    dualClips.length > 0 ? "dual" : clips.length > 0 ? "single" : "none";

  const capabilities: ComfyUICapabilities = {
    checkpoints,
    unets,
    clips,
    dualClips,
    vaes,
    loras,
    upscaleModels,
    detectorModels,
    samplers,
    schedulers,

    installedPacks: {
      impactPack: ultralyticsInfo !== null && faceDetailerInfo !== null,
      upscaling: upscaleModels.length > 0 || ultimateUpscaleInfo !== null,
      controlnet: controlnetInfo !== null,
    },

    modelLoaderType,
    clipLoaderType,
  };

  cache.set(apiUrl, { capabilities, timestamp: Date.now() });
  return capabilities;
}

/** Clear the cache for a specific URL or all URLs. */
export function clearCapabilityCache(apiUrl?: string): void {
  if (apiUrl) {
    cache.delete(apiUrl);
    objectInfoCache.delete(apiUrl);
  } else {
    cache.clear();
    objectInfoCache.clear();
  }
}
