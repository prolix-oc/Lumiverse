import { formatOriginLabel, isLocalEndpointOrigin } from "./origin";
import type { InferenceSchedulerConfig } from "./types";

export interface ResolvedInferenceResource {
  key: string;
  label: string;
  local: boolean;
}

const UNIFIED_RESOURCE_KEY = "local:unified";

/**
 * Map an endpoint origin to the queue that owns it.
 *
 * Resolution order:
 * 1. `excludedOrigins` — never scheduled.
 * 2. A named `groups` pool that lists the origin.
 * 3. An explicit `extraOrigins` entry (schedules LAN/WAN endpoints).
 * 4. A local endpoint, either into the unified local pool or its own origin.
 * 5. Anything else — not scheduled.
 */
export function resolveInferenceResource(
  config: InferenceSchedulerConfig,
  origin: string,
): ResolvedInferenceResource | null {
  if (!origin) return null;
  if (config.excludedOrigins.includes(origin)) return null;

  for (const group of config.groups) {
    if (group.origins.includes(origin)) {
      return { key: `group:${group.id}`, label: group.name, local: true };
    }
  }

  const explicitlyScheduled = config.extraOrigins.includes(origin);
  const local = explicitlyScheduled || isLocalEndpointOrigin(origin, config.schedulePrivateNetwork);
  if (!local) return null;

  if (config.unifiedLocalPool) {
    return { key: UNIFIED_RESOURCE_KEY, label: "Local inference", local: true };
  }
  return { key: `origin:${origin}`, label: formatOriginLabel(origin), local: true };
}

export function isUnifiedInferenceResourceKey(key: string): boolean {
  return key === UNIFIED_RESOURCE_KEY;
}
