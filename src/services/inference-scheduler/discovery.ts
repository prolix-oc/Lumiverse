import * as connectionsSvc from "../connections.service";
import * as embeddingsSvc from "../embeddings.service";
import * as imageGenConnSvc from "../image-gen-connections.service";
import * as memoryCortex from "../memory-cortex";
import { getInferenceSchedulerConfig } from "./config";
import { formatOriginLabel, normalizeEndpointOrigin } from "./origin";
import { resolveInferenceResource } from "./resources";

export type LocalInferenceEndpointSource =
  | "chat"
  | "embeddings"
  | "image-generation"
  | "memory-cortex"
  | "manual";

export interface LocalInferenceEndpoint {
  origin: string;
  label: string;
  sources: LocalInferenceEndpointSource[];
  /** True when the current config would queue requests to this endpoint. */
  scheduled: boolean;
  /** True when the user excluded it from scheduling. */
  excluded: boolean;
}

interface EndpointAccumulator {
  origin: string;
  label: string;
  sources: Set<LocalInferenceEndpointSource>;
}

function addOrigin(
  map: Map<string, EndpointAccumulator>,
  rawUrl: string | null | undefined,
  label: string,
  source: LocalInferenceEndpointSource,
): void {
  const origin = normalizeEndpointOrigin(rawUrl);
  if (!origin) return;
  const existing = map.get(origin);
  if (existing) {
    existing.sources.add(source);
    return;
  }
  map.set(origin, { origin, label, sources: new Set([source]) });
}

/**
 * Best-effort inventory of the endpoints the user's configured inference
 * features talk to. Used by the settings panel to explain what will be
 * scheduled; it never contacts the endpoints.
 */
export async function discoverLocalInferenceEndpoints(userId: string): Promise<LocalInferenceEndpoint[]> {
  const config = getInferenceSchedulerConfig(userId);
  const map = new Map<string, EndpointAccumulator>();

  try {
    const embeddingConfig = await embeddingsSvc.getEmbeddingConfig(userId);
    for (const profile of embeddingConfig.connectionProfiles ?? []) {
      addOrigin(
        map,
        profile.api_url || embeddingConfig.api_url,
        `Embeddings — ${profile.model || embeddingConfig.model}`,
        "embeddings",
      );
    }
    if ((embeddingConfig.connectionProfiles ?? []).length === 0) {
      addOrigin(map, embeddingConfig.api_url, `Embeddings — ${embeddingConfig.model}`, "embeddings");
    }
  } catch {
    // Discovery must never break the settings panel.
  }

  try {
    const connections = connectionsSvc.listConnections(userId, { limit: 1000, offset: 0 }).data;
    for (const connection of connections) {
      addOrigin(
        map,
        connectionsSvc.resolveEffectiveApiUrl(connection),
        `Chat — ${connection.name}`,
        "chat",
      );
    }
  } catch {
    // Isolated: one broken provider must not hide the others.
  }

  try {
    const imageConnections = imageGenConnSvc.listConnections(userId, { limit: 1000, offset: 0 }).data;
    for (const connection of imageConnections) {
      addOrigin(map, connection.api_url, `Image generation — ${connection.name}`, "image-generation");
    }
  } catch {
    // Isolated.
  }

  try {
    const cortexConfig = memoryCortex.getCortexConfig(userId);
    const endpoints = memoryCortex.listCortexSidecarEndpoints(cortexConfig);
    const ids = new Set<string>();
    for (const pair of [endpoints.queryGeneration, endpoints.memorySummarization]) {
      for (const endpoint of [pair.primary, pair.secondary, ...(pair.fallbacks ?? [])]) {
        if (endpoint?.connectionProfileId) ids.add(endpoint.connectionProfileId);
      }
    }
    if (cortexConfig.sidecar?.connectionProfileId) ids.add(cortexConfig.sidecar.connectionProfileId);
    for (const id of ids) {
      const connection = connectionsSvc.getConnection(userId, id);
      if (!connection) continue;
      addOrigin(
        map,
        connectionsSvc.resolveEffectiveApiUrl(connection),
        `Memory Cortex sidecar — ${connection.name}`,
        "memory-cortex",
      );
    }
  } catch {
    // Isolated.
  }

  // Explicit entries must remain visible even when no feature profile points at
  // them, otherwise an extra origin can be added but never removed or excluded.
  for (const origin of [...config.extraOrigins, ...config.excludedOrigins]) {
    if (map.has(origin)) continue;
    map.set(origin, {
      origin,
      label: `Manual — ${formatOriginLabel(origin)}`,
      sources: new Set(["manual"]),
    });
  }

  return [...map.values()]
    .map<LocalInferenceEndpoint>((entry) => {
      const resolved = resolveInferenceResource(config, entry.origin);
      return {
        origin: entry.origin,
        label: entry.label,
        sources: [...entry.sources],
        scheduled: resolved !== null,
        excluded: config.excludedOrigins.includes(entry.origin),
      };
    })
    .sort((left, right) => Number(right.scheduled) - Number(left.scheduled) || left.label.localeCompare(right.label));
}
