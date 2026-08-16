import type { ToolDefinition } from "../../llm/types";
import {
  listCortexSidecarEndpoints,
  type MemoryCortexConfig,
} from "./config";
import { getToolChoiceParams } from "./salience-sidecar";
import { waitForCortexSidecarRpmSlot } from "./sidecar-rpm-gate";
import {
  providerRegistry,
  type HostScopeContext,
  type ProviderDescriptor,
  type RegisteredProvider,
} from "../../spindle/provider-registry";
import { emitProviderRegistryChanged } from "../../ws/bus";

export type CortexSidecarProviderStatus = "ok" | "unavailable" | "timeout";

export interface CortexSidecarProviderInfo {
  id: string;
  name: string;
  kind: "sidecar";
  source: "config" | "registry";
  status: CortexSidecarProviderStatus;
  connectionProfileId?: string | null;
  installationId?: string;
}

const CONSUMER_PROVIDER_SCOPE = "frontend";
const sidecarConsumerRevisions = new Map<string, number>();

function sidecarDisplayName(record: RegisteredProvider): string {
  const description = record.descriptor.description;
  if (description && typeof description === "object" && !Array.isArray(description)) {
    const name = (description as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return record.key.id;
}

function sidecarRecordStatus(record: RegisteredProvider): CortexSidecarProviderStatus | "denied" {
  const description = record.descriptor.description;
  if (description && typeof description === "object" && !Array.isArray(description)) {
    const rec = description as Record<string, unknown>;
    if (rec.denied === true || rec.visible === false || rec.status === "denied") return "denied";
    if (rec.status === "timeout" || rec.availability === "timeout") return "timeout";
    if (rec.status === "unavailable" || rec.availability === "unavailable") return "unavailable";
  }
  return "ok";
}

function visibleSidecarRecords(userId?: string): RegisteredProvider[] {
  const scopes = userId ? [`user:${userId}` as const, "system" as const] : undefined;
  const records = scopes ? providerRegistry.listVisible([...scopes]) : providerRegistry.getProviders();
  const extra: RegisteredProvider[] = [];
  for (const record of records) {
    try {
      if (record.key.kind !== "sidecar") continue;
      extra.push(record);
    } catch {
      // Isolated mapping.
    }
  }
  return extra;
}

/** Configured cortex sidecar endpoints plus live spindle-registered sidecar drivers. */
export function listCortexSidecarProviders(options?: {
  userId?: string;
  config?: MemoryCortexConfig;
}): CortexSidecarProviderInfo[] {
  const listed: CortexSidecarProviderInfo[] = [];
  if (options?.config) {
    const endpoints = listCortexSidecarEndpoints(options.config);
    const configured = [
      endpoints.queryGeneration.primary,
      endpoints.queryGeneration.secondary,
      endpoints.memorySummarization.primary,
      endpoints.memorySummarization.secondary,
    ];
    for (const endpoint of configured) {
      if (!endpoint?.connectionProfileId) continue;
      listed.push({
        id: endpoint.connectionProfileId,
        name: endpoint.model || endpoint.connectionProfileId,
        kind: "sidecar",
        source: "config",
        status: "ok",
        connectionProfileId: endpoint.connectionProfileId,
      });
    }
  }

  try {
    for (const record of visibleSidecarRecords(options?.userId)) {
      try {
        const status = sidecarRecordStatus(record);
        if (status === "denied") continue;
        listed.push({
          id: record.key.id,
          name: sidecarDisplayName(record),
          kind: "sidecar",
          source: "registry",
          status,
          installationId: record.key.installationId,
        });
      } catch {
        // Isolated: a broken sidecar descriptor cannot hide others.
      }
    }
  } catch {
    return listed;
  }
  return listed;
}

function nextSidecarRevision(userId: string): { generation: number; revision: number } {
  const revision = (sidecarConsumerRevisions.get(userId) ?? 0) + 1;
  sidecarConsumerRevisions.set(userId, revision);
  return { generation: 1, revision };
}

export function publishSidecarProviderRegistryChanged(args: {
  userId: string;
  action: "add" | "remove" | "change";
  payload: unknown;
}): void {
  const clock = nextSidecarRevision(args.userId);
  emitProviderRegistryChanged({
    userId: args.userId,
    scope: CONSUMER_PROVIDER_SCOPE,
    action: args.action,
    generation: clock.generation,
    revision: clock.revision,
    payload: args.payload,
  });
}

export function commitSidecarRegistryProvider(
  descriptor: ProviderDescriptor,
  host: HostScopeContext & { installationId: string },
  userId: string,
): RegisteredProvider {
  const record = providerRegistry.register(descriptor, host);
  publishSidecarProviderRegistryChanged({
    userId,
    action: "add",
    payload: {
      id: record.key.id,
      kind: record.key.kind,
      name: sidecarDisplayName(record),
      installationId: record.key.installationId,
    },
  });
  return record;
}

export function revokeSidecarRegistryProvider(
  ref: { kind: string; id: string },
  host: HostScopeContext & { installationId: string },
  userId: string,
): boolean {
  const removed = providerRegistry.unregister(ref, host);
  if (removed) {
    publishSidecarProviderRegistryChanged({
      userId,
      action: "remove",
      payload: { id: ref.id, kind: ref.kind },
    });
  }
  return removed;
}

export type CortexGenerateRawFn = (opts: {
  connectionId: string;
  messages: Array<{ role: string; content: string }>;
  parameters: Record<string, any>;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}) => Promise<{ content: string; tool_calls?: Array<{ name: string; args: Record<string, unknown> }> }>;

export function createCortexSidecarGenerateRawAdapter(options: {
  userId: string;
  sidecarProvider: string;
  cortexConfig: MemoryCortexConfig;
}): CortexGenerateRawFn {
  const { userId, sidecarProvider, cortexConfig } = options;

  return async (opts) => {
    await waitForCortexSidecarRpmSlot({
      userId,
      provider: sidecarProvider,
      requestsPerMinute: cortexConfig.sidecar?.requestsPerMinute,
      signal: opts.signal,
    });

    const { quietGenerate } = await import("../generate.service");
    const toolChoiceParams = opts.tools?.length
      ? getToolChoiceParams(sidecarProvider)
      : {};
    const defaultModel = cortexConfig.queryGeneration?.primary?.model
      ?? cortexConfig.sidecar?.model
      ?? null;
    const sidecarParams: Record<string, any> = {
      temperature: cortexConfig.sidecar?.temperature ?? 0.1,
      top_p: cortexConfig.sidecar?.topP ?? 1.0,
      max_tokens: cortexConfig.sidecar?.maxTokens ?? 4096,
      ...toolChoiceParams,
      ...opts.parameters,
    };
    if (defaultModel && sidecarParams.model == null) sidecarParams.model = defaultModel;

    const result = await quietGenerate(userId, {
      connection_id: opts.connectionId,
      messages: opts.messages as any,
      parameters: sidecarParams,
      tools: opts.tools,
      signal: opts.signal,
    });

    return {
      content: typeof result.content === "string" ? result.content : "",
      tool_calls: result.tool_calls,
    };
  };
}
