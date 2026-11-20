import type { TtsProvider } from "./provider";
import type { TtsProviderCapabilities } from "./param-schema";
import type { TtsRequest, TtsResponse, TtsStreamChunk } from "./types";
import {
  providerRegistry,
  type HostScopeContext,
  type ProviderDescriptor,
  type ProviderScope,
  type RegisteredProvider,
} from "../spindle/provider-registry";
import { emitProviderRegistryChanged } from "../ws/bus";

const providers = new Map<string, TtsProvider>();
const CONSUMER_PROVIDER_SCOPE = "frontend";
const ttsConsumerRevisions = new Map<string, number>();

const REGISTRY_TTS_CAPABILITIES: TtsProviderCapabilities = {
  parameters: {},
  apiKeyRequired: false,
  voiceListStyle: "static",
  staticVoices: [],
  modelListStyle: "static",
  staticModels: [],
  supportsStreaming: false,
  supportedFormats: ["mp3"],
  defaultUrl: "",
  defaultFormat: "mp3",
};

export function registerTtsProvider(provider: TtsProvider): void {
  providers.set(provider.name, provider);
}

function ttsDisplayName(record: RegisteredProvider): string {
  const description = record.descriptor.description;
  if (description && typeof description === "object" && !Array.isArray(description)) {
    const name = (description as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return record.key.id;
}

function ttsDenied(record: RegisteredProvider): boolean {
  const description = record.descriptor.description;
  if (!description || typeof description !== "object" || Array.isArray(description)) return false;
  const rec = description as Record<string, unknown>;
  return rec.denied === true || rec.visible === false || rec.status === "denied";
}

function visibleTtsRecords(userId?: string): RegisteredProvider[] {
  // Absent userId resolves SYSTEM-scope providers ONLY — never an all-scopes
  // sweep across other users' records. Every production caller passes the
  // authenticated user id explicitly; tests may pass "system" semantics.
  const scopes: readonly (`user:${string}` | "system")[] = userId
    ? [`user:${userId}`, "system"]
    : ["system"];
  const records = providerRegistry.listVisible(scopes);
  const extra: RegisteredProvider[] = [];
  try {
    for (const record of records) {
      try {
        if (record.key.kind !== "tts") continue;
        if (ttsDenied(record)) continue;
        extra.push(record);
      } catch {
        // Isolated: a broken descriptor cannot hide other engines.
      }
    }
  } catch {
    return [];
  }
  return extra;
}

class RegistryTtsAdapter implements TtsProvider {
  readonly name: string;
  readonly displayName: string;
  readonly capabilities = REGISTRY_TTS_CAPABILITIES;

  constructor(
    private readonly record: RegisteredProvider,
    private readonly callerUserId: string | null,
  ) {
    this.name = record.key.id;
    this.displayName = ttsDisplayName(record);
  }

  async synthesize(_apiKey: string, _apiUrl: string, request: TtsRequest): Promise<TtsResponse> {
    try {
      // The caller's real scope, never the provider's own scope: passing the
      // record's effectiveScope here would let any caller slip past the
      // registry's cross-scope isolation check.
      const result = await providerRegistry.invoke(this.record.key, request, {
        callerScope: this.callerScope(),
      });
      if (result && typeof result === "object" && result instanceof ArrayBuffer) {
        return {
          audioData: result,
          contentType: "audio/mpeg",
          model: request.model,
          provider: this.name,
        };
      }
      throw new Error("registry tts returned no audio");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`tts provider ${this.name} failed: ${message}`);
    }
  }

  private callerScope(): ProviderScope {
    return this.callerUserId ? `user:${this.callerUserId}` : "system";
  }

  async *synthesizeStream(): AsyncGenerator<TtsStreamChunk, void, unknown> {
    throw new Error(`tts provider ${this.name} does not support streaming`);
  }

  async validateKey(): Promise<boolean> {
    return true;
  }

  async listModels(): Promise<Array<{ id: string; label: string }>> {
    return [];
  }

  async listVoices() {
    return [];
  }
}

function registryTtsAdapter(record: RegisteredProvider, callerUserId?: string): TtsProvider {
  return new RegistryTtsAdapter(record, callerUserId ?? null);
}

export function getTtsProvider(name: string, userId?: string): TtsProvider | undefined {
  const builtin = providers.get(name);
  if (builtin) return builtin;
  const record = visibleTtsRecords(userId).find((entry) => entry.key.id === name);
  return record ? registryTtsAdapter(record, userId) : undefined;
}

export function listTtsProviders(userId?: string): string[] {
  return getTtsProviderList(userId).map((provider) => provider.name);
}

export function getTtsProviderList(userId?: string): TtsProvider[] {
  const extras: TtsProvider[] = [];
  for (const record of visibleTtsRecords(userId)) {
    try {
      extras.push(registryTtsAdapter(record, userId));
    } catch {
      // Isolated adapter construction.
    }
  }
  return [...providers.values(), ...extras];
}

function nextTtsRevision(userId: string): { generation: number; revision: number } {
  const revision = (ttsConsumerRevisions.get(userId) ?? 0) + 1;
  ttsConsumerRevisions.set(userId, revision);
  return { generation: 1, revision };
}

export function publishTtsProviderRegistryChanged(args: {
  userId: string;
  action: "add" | "remove" | "change";
  payload: unknown;
}): void {
  const clock = nextTtsRevision(args.userId);
  emitProviderRegistryChanged({
    userId: args.userId,
    scope: CONSUMER_PROVIDER_SCOPE,
    action: args.action,
    generation: clock.generation,
    revision: clock.revision,
    payload: args.payload,
  });
}

export function commitTtsRegistryProvider(
  descriptor: ProviderDescriptor,
  host: HostScopeContext & { installationId: string },
  userId: string,
): RegisteredProvider {
  const record = providerRegistry.register(descriptor, host);
  publishTtsProviderRegistryChanged({
    userId,
    action: "add",
    payload: {
      id: record.key.id,
      kind: record.key.kind,
      name: ttsDisplayName(record),
      installationId: record.key.installationId,
    },
  });
  return record;
}

export function revokeTtsRegistryProvider(
  ref: { kind: string; id: string },
  host: HostScopeContext & { installationId: string },
  userId: string,
): boolean {
  const removed = providerRegistry.unregister(ref, host);
  if (removed) {
    publishTtsProviderRegistryChanged({
      userId,
      action: "remove",
      payload: { id: ref.id, kind: ref.kind },
    });
  }
  return removed;
}

export type HostTtsEngine = Omit<ProviderDescriptor, "kind" | "id"> & Partial<HostScopeContext> & {
  installationId?: string;
};

function hostScopeFromTtsEngine(engine: HostTtsEngine): HostScopeContext & { installationId: string } {
  const installationId = typeof engine.installationId === "string" && engine.installationId.trim()
    ? engine.installationId.trim()
    : "host";
  const installScope = engine.installScope === "user" || engine.installScope === "operator" || engine.installScope === "system"
    ? engine.installScope
    : "system";
  return {
    installationId,
    installScope,
    installedByUserId: engine.installedByUserId,
    authenticatedSubject: engine.authenticatedSubject,
  };
}

export function registerTtsEngine(id: string, engine: HostTtsEngine): () => void {
  const host = hostScopeFromTtsEngine(engine);
  providerRegistry.register({
    kind: "tts",
    id,
    description: engine.description ?? engine,
    broker: engine.broker,
    generation: engine.generation,
    revision: engine.revision,
    owner: engine.owner,
  }, host);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    providerRegistry.unregister({ kind: "tts", id }, host);
  };
}
