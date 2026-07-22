import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  BoundDispatchProvider,
  BoundDispatchResolution,
  BoundInvocationContext,
  ConnectionDispatchDescriptorDTO,
  MainDispatchSnapshotInput,
  ParentGenerationSnapshot,
  ParentGenerationSnapshotInput,
  ParentRetrievalSnapshotInput,
  QuietTrackedRequestDTO,
  ReadOnlyEffectLeaseContext,
} from "./bound-generation-types";
import type { LlmProvider } from "../llm/provider";
import { registerProvider } from "../llm/registry";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import {
  resolveDispatchDescriptor,
  resolveMainDispatchSnapshot,
  type ResolvedDispatchDescriptor,
} from "../services/dispatch-state.service";
import {
  brandHostGenerationId,
  brandInvocationToken,
} from "./bound-generation-types";
import {
  captureMainDispatchSnapshot,
  captureParentGenerationSnapshot,
  captureParentRetrievalSnapshot,
  consumeParentPrefillAttestation,
  createBoundGenerationBinding,
  createBoundHostContainmentFatal,
  createParentPrefillAttestation,
  createReadOnlyEffectLease,
  denyBoundEffect,
  isHostContainmentFatal,
  mintParentPrefillChildUse,
  runBoundAssembly,
} from "./bound-generation";
import {
  createHostBoundGenerationCallbacks,
  type HostBoundGenerationCallbacks,
} from "./bound-generation-host";

const HOST_GENERATION = brandHostGenerationId("host-generation-1");
const REVISION = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const DESCRIPTOR = {
  connectionId: "connection-1",
  connectionName: "Loopback",
  provider: "openai-compatible",
  model: "loopback-model",
  endpointOrigin: "http://127.0.0.1:1",
  dispatchKind: "concrete" as const,
  connectionDispatchRevision: REVISION,
};

const HOST_DISPATCH_USER = "user-1";
const HOST_DEFAULT_CONNECTION = "default-connection";
const HOST_MAIN_CONNECTION = "main-connection";
const HOST_SLOT_CONNECTION = "slot-connection";
const HOST_DEFAULT_PRESET = "default-preset";
const HOST_MAIN_PRESET = "main-preset";
const HOST_SLOT_PRESET = "slot-preset";
const HOST_SLOT_ALT_PRESET = "slot-alt-preset";
const HOST_PROVIDER_NAME = "bound-generation-test-provider";
const HOST_MAIN_CONTEXT = {
  connectionId: HOST_MAIN_CONNECTION,
  presetId: HOST_MAIN_PRESET,
  reasoning: { apiReasoning: true, reasoningEffort: "high" },
  settings: { locale: "fr", dispatchMode: "main" },
} as const;

const BLOCKS = [{
  id: "block-1",
  name: "Prompt",
  content: "hello",
  role: "system" as const,
  enabled: true,
  position: "pre_history" as const,
  depth: 0,
  marker: null,
  isLocked: false,
  color: null,
  injectionTrigger: [],
  characterTagTrigger: [],
  group: null,
}];

function mainInput(overrides: Partial<MainDispatchSnapshotInput> = {}): MainDispatchSnapshotInput {
  return {
    hostGeneration: HOST_GENERATION,
    generationId: "generation-1",
    userId: "user-1",
    chatId: "chat-1",
    descriptor: { ...DESCRIPTOR },
    parameters: { temperature: 0.2, nested: { selected: true } },
    reasoning: { apiReasoning: false },
    authoritativeContext: { source: "parent", presetId: "preset-1" },
    capturedAt: 100,
    ...overrides,
  };
}

function retrievalInput(overrides: Partial<ParentRetrievalSnapshotInput> = {}): ParentRetrievalSnapshotInput {
  return {
    hostGeneration: HOST_GENERATION,
    generationId: "generation-1",
    userId: "user-1",
    chatId: "chat-1",
    capturedAt: 200,
    expiresAt: 10_000,
    vectorWorldInfo: { entries: ["world-info"] },
    chatMemory: { messages: ["memory"] },
    cortex: { result: "cortex" },
    databank: { result: "databank", embeddingConfig: { enabled: true } },
    settings: { retrieval: "frozen" },
    results: { exact: true },
    multiplayerMacroContext: null,
    multiplayerPersona: null,
    ...overrides,
  };
}

function parent(overrides: Partial<ParentGenerationSnapshotInput> = {}) {
  const main = captureMainDispatchSnapshot(mainInput());
  const retrieval = captureParentRetrievalSnapshot(retrievalInput());
  return captureParentGenerationSnapshot({
    hostGeneration: HOST_GENERATION,
    generationId: "generation-1",
    userId: "user-1",
    chatId: "chat-1",
    main,
    retrieval,
    parentIdentities: { chatId: "chat-1", personaId: null },
    options: { generationType: "normal" },
    parentPrefill: { id: "prefill-1", state: "absent" },
    interceptorDeadlineAt: 10_000,
    boundWorkDeadlineAt: 9_000,
    ...overrides,
  });
}

function context(parentSnapshot: ReturnType<typeof parent>, requestId = "request-1"): BoundInvocationContext {
  return {
    workerId: "worker-1",
    registrationGeneration: "registration-1",
    callbackUserId: parentSnapshot.userId,
    hostGeneration: parentSnapshot.hostGeneration,
    requestId,
    invocationToken: brandInvocationToken(`token-${requestId}`),
    parent: parentSnapshot,
  };
}

function resolverFor(parentSnapshot: ReturnType<typeof parent>, sources: string[] = []) {
  return async ({ source }: { source: { source: "main" | "slot"; expectedConnectionDispatchRevision: string; connectionId?: string } }): Promise<BoundDispatchResolution> => {
    sources.push(source.source);
    const connectionId = source.source === "main" ? parentSnapshot.main.descriptor.connectionId : source.connectionId!;
    return {
      source: source.source,
      connectionId,
      descriptor: { ...DESCRIPTOR, connectionId },
      dispatchRevision: source.expectedConnectionDispatchRevision,
    };
  };
}

function quietRequest(overrides: Partial<QuietTrackedRequestDTO> = {}): QuietTrackedRequestDTO {
  return {
    messages: [{ role: "user" as const, content: "hello" }],
    dispatch: { source: "main" as const, expectedConnectionDispatchRevision: REVISION },
    deadlineAt: 5_000,
    ...overrides,
  };
}

const provider: BoundDispatchProvider = async ({ resolution, parentPrefill }) => ({
  response: {
    content: resolution.source === "slot" ? "slot answer" : "answer",
    reasoning: "thinking summary",
    finish_reason: "stop",
    thinking_blocks: [{ type: "thinking", thinking: "opaque", signature: "signature-1" }],
  },
  terminalResponse: true,
  usage: { prompt_tokens: 2, completion_tokens: parentPrefill ? 4 : 3, total_tokens: parentPrefill ? 6 : 5, provider_raw: { request_id: "safe-id" } },
});

const hostProviderCalls: Array<{ readonly apiKey: string; readonly apiUrl: string; readonly model: string }> = [];

registerProvider({
  name: HOST_PROVIDER_NAME,
  displayName: "Bound generation test provider",
  defaultUrl: "http://bound-generation.invalid/v1",
  capabilities: {
    parameters: {},
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: false,
    modelListStyle: "none",
  },
  async generate(apiKey, apiUrl, request) {
    hostProviderCalls.push({ apiKey, apiUrl, model: request.model });
    return { content: "bound-provider-response", finish_reason: "stop" };
  },
  async *generateStream() {
    yield { token: "bound-provider-stream", finish_reason: "stop" };
  },
  async validateKey() {
    return true;
  },
  async listModels() {
    return [];
  },
} satisfies LlmProvider);

interface HostFixture {
  readonly callbacks: HostBoundGenerationCallbacks;
  readonly parentSnapshot: ParentGenerationSnapshot;
  readonly mainResolution: ResolvedDispatchDescriptor;
}

interface HostSlotFixture {
  readonly descriptor: ConnectionDispatchDescriptorDTO;
  readonly resolution: BoundDispatchResolution;
}

async function resetHostDispatchDb(): Promise<void> {
  closeDatabase();
  initDatabase(":memory:");
  await runMigrations(getDb());
  const db = getDb();
  db.run('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)', [
    HOST_DISPATCH_USER,
    "Bound generation user",
    "bound-generation@example.test",
  ]);
  for (const [id, name, parameters] of [
    [HOST_DEFAULT_PRESET, "Default preset", '{"temperature":0.1}'],
    [HOST_MAIN_PRESET, "Main preset", '{"temperature":0.2}'],
    [HOST_SLOT_PRESET, "Slot preset", '{"temperature":0.3}'],
    [HOST_SLOT_ALT_PRESET, "Slot alternate preset", '{"temperature":0.4}'],
  ] as const) {
    db.run(
      `INSERT INTO presets
        (id, name, provider, parameters, prompt_order, metadata, created_at, updated_at, prompts, user_id, engine)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, HOST_PROVIDER_NAME, parameters, "[]", "{}", 10, 10, "{}", HOST_DISPATCH_USER, "classic"],
    );
  }
  for (const [id, name, model, presetId, isDefault] of [
    [HOST_DEFAULT_CONNECTION, "Default connection", "default-model", HOST_DEFAULT_PRESET, 1],
    [HOST_MAIN_CONNECTION, "Main connection", "main-model", HOST_MAIN_PRESET, 0],
    [HOST_SLOT_CONNECTION, "Slot connection", "slot-model", HOST_SLOT_PRESET, 0],
  ] as const) {
    db.run(
      `INSERT INTO connection_profiles
        (id, name, provider, api_url, model, preset_id, is_default, metadata, created_at, updated_at, has_api_key, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        name,
        HOST_PROVIDER_NAME,
        "http://bound-generation.invalid/v1",
        model,
        presetId,
        isDefault,
        "{}",
        10,
        10,
        0,
        HOST_DISPATCH_USER,
      ],
    );
  }
}

function createHostFixture(): HostFixture {
  const mainResolution = resolveMainDispatchSnapshot(HOST_DISPATCH_USER, HOST_MAIN_CONTEXT);
  const parentSnapshot = parent({
    main: captureMainDispatchSnapshot(mainInput({
      descriptor: mainResolution.descriptor,
      reasoning: HOST_MAIN_CONTEXT.reasoning,
      authoritativeContext: HOST_MAIN_CONTEXT,
    })),
  });
  const callbacks = createHostBoundGenerationCallbacks({
    parent: parentSnapshot,
    extensionIdentifier: "bound-generation-test",
    signal: new AbortController().signal,
    mainApiKey: "main-api-key",
  });
  return { callbacks, parentSnapshot, mainResolution };
}

async function resolveHostSlot(fixture: HostFixture): Promise<HostSlotFixture> {
  const descriptor = await fixture.callbacks.inspectDispatch(HOST_SLOT_CONNECTION);
  if (!descriptor) throw new Error("Expected the test slot descriptor");
  const revision = descriptor.connectionDispatchRevision;
  if (typeof revision !== "string" || revision.trim().length === 0) throw new Error("Expected the test slot revision");
  const resolution = await fixture.callbacks.resolveDispatch({
    source: {
      source: "slot",
      connectionId: HOST_SLOT_CONNECTION,
      expectedConnectionDispatchRevision: revision,
    },
    parent: fixture.parentSnapshot,
  });
  if (!resolution) throw new Error("Expected the test slot resolution");
  return { descriptor, resolution };
}

function hostProviderInput(resolution: BoundDispatchResolution) {
  return {
    resolution,
    messages: [{ role: "user" as const, content: "slot request" }],
    parameters: { temperature: 0.3 },
    reasoning: {},
    tools: [],
    signal: new AbortController().signal,
  };
}

describe("Immutable parent snapshots", () => {
  test("deep-clones and freezes effective Main and retrieval inputs", () => {
    const input = mainInput();
    const main = captureMainDispatchSnapshot(input);
    const retrieval = captureParentRetrievalSnapshot(retrievalInput());
    const joined = parent();
    input.parameters!.nested = { selected: false };
    expect(main.parameters).toEqual({ temperature: 0.2, nested: { selected: true } });
    expect(Object.isFrozen(main)).toBe(true);
    expect(Object.isFrozen(main.descriptor)).toBe(true);
    expect(Object.isFrozen(retrieval)).toBe(true);
    expect(Object.isFrozen(retrieval.results)).toBe(true);
    expect(Object.isFrozen(joined)).toBe(true);
    expect(joined.chatId).toBe("chat-1");
  });

  test("requires a concrete retrieval snapshot and rejects wrong or expired scope", () => {
    expect(() => captureParentRetrievalSnapshot(retrievalInput({ expiresAt: 200 }))).toThrow("expiresAt");
    const retrieval = captureParentRetrievalSnapshot(retrievalInput({ generationId: "foreign" }));
    expect(() => parent({ retrieval })).toThrow("generation");
    expect(() => parent({ retrieval: captureParentRetrievalSnapshot(retrievalInput({ results: { payload: "x".repeat(4 * 1024 * 1024) } })) })).toThrow(/oversize/);
  });

  test("does not delete an attestation while minting multiple branch children", () => {
    const parentSnapshot = parent({
      parentPrefill: { id: "prefill-available", state: "available" },
      parentPrefillCarrier: [{ role: "assistant", content: "seed" }],
    });
    const attestation = createParentPrefillAttestation(parentSnapshot);
    const childA = mintParentPrefillChildUse(parentSnapshot, attestation, "request-a");
    const childB = mintParentPrefillChildUse(parentSnapshot, attestation, "request-b");
    expect(consumeParentPrefillAttestation(parentSnapshot, { id: "prefill-available", state: "available" }, attestation)).toBe(true);
    expect(childA.parentPrefillMessages).toEqual([{ role: "assistant", content: "seed" }]);
    expect(childB.parentPrefillMessages).toEqual([{ role: "assistant", content: "seed" }]);
    expect(() => mintParentPrefillChildUse(parentSnapshot, attestation, "request-a")).not.toThrow();
    const foreign = parent({
      generationId: "foreign-generation",
      retrieval: captureParentRetrievalSnapshot(retrievalInput({ generationId: "foreign-generation" })),
      main: captureMainDispatchSnapshot(mainInput({ generationId: "foreign-generation" })),
      parentPrefill: { id: "prefill-available", state: "available" },
      parentPrefillCarrier: [{ role: "assistant", content: "seed" }],
    });
    expect(consumeParentPrefillAttestation(foreign, { id: "prefill-available", state: "available" }, attestation)).toBe(false);
  });
});

describe("Bound assembly and tracked dispatch", () => {
  test("fails closed before assembly/provider for malformed source, stale revision, expired snapshot, and deadline", async () => {
    const parentSnapshot = parent();
    const assemblyCalls: string[] = [];
    let providerCalls = 0;
    const resolver = resolverFor(parentSnapshot);
    const binding = createBoundGenerationBinding({
      context: context(parentSnapshot),
      resolveDispatch: resolver,
      assemble: async () => {
        assemblyCalls.push("called");
        return { messages: [], breakdown: [] };
      },
      provider: async (...args) => {
        providerCalls++;
        return provider(...args);
      },
      now: () => 100,
    });
    const malformed = await binding.quietTracked(quietRequest({
      dispatch: { source: "foreign", expectedConnectionDispatchRevision: REVISION } as unknown as QuietTrackedRequestDTO["dispatch"],
    }));
    expect(malformed).toMatchObject({ ok: false, phase: "preflight", providerInvoked: false, receipt: null });
    const stale = await binding.quietTracked(quietRequest({ dispatch: { source: "main", expectedConnectionDispatchRevision: "stale" } }));
    expect(stale).toMatchObject({ ok: false, phase: "resolved", receipt: { providerInvoked: false } });
    const expiredParent = parent({ retrieval: captureParentRetrievalSnapshot(retrievalInput({ expiresAt: 300 })) });
    const expiredAssembly = await runBoundAssembly({
      context: context(expiredParent),
      request: { blocks: BLOCKS, dispatch: { source: "main", expectedConnectionDispatchRevision: REVISION }, deadlineAt: 5_000 },
      resolveDispatch: resolverFor(expiredParent),
      assemble: async () => { assemblyCalls.push("expired"); return { messages: [], breakdown: [] }; },
      now: () => 300,
    });
    expect(expiredAssembly).toMatchObject({ ok: false, error: { kind: "retrieval_snapshot", reason: "expired" } });
    const deadline = await binding.quietTracked(quietRequest({ deadlineAt: 100 }));
    expect(deadline).toMatchObject({ ok: false, phase: "preflight", providerInvoked: false, receipt: null });
    expect(assemblyCalls).toEqual([]);
    expect(providerCalls).toBe(0);
  });

  test("keeps Main and slot source identity distinct and emits truthful frozen receipts", async () => {
    const parentSnapshot = parent();
    const sources: string[] = [];
    const binding = createBoundGenerationBinding({
      context: context(parentSnapshot),
      resolveDispatch: resolverFor(parentSnapshot, sources),
      assemble: async () => ({ messages: [], breakdown: [] }),
      provider,
      now: () => 100,
    });
    const mainResult = await binding.quietTracked(quietRequest());
    const slotResult = await binding.quietTracked(quietRequest({ dispatch: { source: "slot", connectionId: "connection-1", expectedConnectionDispatchRevision: REVISION } }));
    expect(mainResult).toMatchObject({ ok: true, receipt: { providerInvoked: true, source: "main", connectionId: "connection-1", connectionDispatchRevision: REVISION } });
    expect(slotResult).toMatchObject({ ok: true, receipt: { providerInvoked: true, source: "slot", connectionId: "connection-1", connectionDispatchRevision: REVISION } });
    expect(sources).toEqual(["main", "slot"]);
    if (mainResult.ok) {
      expect(Object.isFrozen(mainResult.response)).toBe(true);
      expect(Object.isFrozen(mainResult.receipt)).toBe(true);
      expect(mainResult.receipt).not.toHaveProperty("apiKey");
    }
  });

  test("uses one-use children with request binding and rejects replay", async () => {
    const parentSnapshot = parent({ parentPrefill: { id: "prefill-available", state: "available" }, parentPrefillCarrier: [{ role: "assistant", content: "seed" }] });
    const attestation = createParentPrefillAttestation(parentSnapshot);
    const child = mintParentPrefillChildUse(parentSnapshot, attestation, "request-1");
    const binding = createBoundGenerationBinding({ context: context(parentSnapshot), resolveDispatch: resolverFor(parentSnapshot), assemble: async () => ({ messages: [], breakdown: [] }), provider, now: () => 100 });
    const request = quietRequest({ continuation: { parentPrefill: { id: "prefill-available", state: "available" }, mode: "append-parent-carrier-last" } });
    const first = await binding.quietTracked(request, { childUse: child });
    const replay = await binding.quietTracked(request, { childUse: child });
    expect(first).toMatchObject({ ok: true, receipt: { providerInvoked: true } });
    expect(replay).toMatchObject({ ok: false, phase: "preflight", error: { code: "PREFILL_CHILD_ALREADY_USED" } });
  });

  test("isolates cancellation between concurrent requests", async () => {
    const parentSnapshot = parent();
    const firstController = new AbortController();
    const secondController = new AbortController();
    let calls = 0;
    let releaseProviders: () => void = () => {};
    const providersReleased = new Promise<void>((resolve) => {
      releaseProviders = resolve;
    });
    let releaseStarted: () => void = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    const providerWithWait: BoundDispatchProvider = async ({ signal }) => {
      calls++;
      if (calls === 2) releaseStarted();
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => reject(new DOMException("aborted", "AbortError"));
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener("abort", onAbort, { once: true });
          void providersReleased.then(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          });
        }
      });
      return { response: { content: "survivor", finish_reason: "stop" }, terminalResponse: true };
    };
    const binding = createBoundGenerationBinding({
      context: context(parentSnapshot),
      resolveDispatch: resolverFor(parentSnapshot),
      assemble: async () => ({ messages: [], breakdown: [] }),
      provider: providerWithWait,
      now: () => 100,
    });
    const first = binding.quietTracked(quietRequest({ signal: firstController.signal }));
    const second = binding.quietTracked(quietRequest({ signal: secondController.signal }));
    await bothStarted;
    firstController.abort();
    releaseProviders();
    const [cancelled, survivor] = await Promise.all([first, second]);
    expect(cancelled).toMatchObject({ ok: false, phase: "resolved", error: { code: "BOUND_ABORTED" } });
    expect(survivor).toMatchObject({ ok: true, response: { content: "survivor" } });
    expect(calls).toBe(2);
  });
});

describe("Host-bound dispatch resolution", () => {
  beforeEach(async () => {
    hostProviderCalls.length = 0;
    await resetHostDispatchDb();
  });

  afterEach(() => {
    closeDatabase();
  });

  test("resolves an inspected slot without parent Main context through provider", async () => {
    const fixture = createHostFixture();
    const slot = await resolveHostSlot(fixture);
    const contextualSlot = resolveDispatchDescriptor(HOST_DISPATCH_USER, {
      source: "slot",
      connectionId: HOST_SLOT_CONNECTION,
      presetId: HOST_MAIN_CONTEXT.presetId,
      reasoning: HOST_MAIN_CONTEXT.reasoning,
      settings: HOST_MAIN_CONTEXT.settings,
    });

    expect(fixture.parentSnapshot.main.authoritativeContext).toEqual(HOST_MAIN_CONTEXT);
    expect(slot.descriptor.connectionDispatchRevision).toBe(slot.resolution.dispatchRevision);
    expect(slot.descriptor.connectionDispatchRevision).not.toBe(contextualSlot.dispatchRevision);
    expect(slot.resolution.connectionId).toBe(HOST_SLOT_CONNECTION);
    expect(slot.resolution.descriptor.model).toBe("slot-model");

    const result = await fixture.callbacks.provider(hostProviderInput(slot.resolution));

    expect(result.response.content).toBe("bound-provider-response");
    expect(hostProviderCalls).toEqual([{
      apiKey: "",
      apiUrl: "http://bound-generation.invalid/v1",
      model: "slot-model",
    }]);
  });

  test("rejects a slot revision after its selected preset changes before provider", async () => {
    const fixture = createHostFixture();
    const slot = await resolveHostSlot(fixture);
    getDb()
      .query("UPDATE connection_profiles SET preset_id = ? WHERE id = ? AND user_id = ?")
      .run(HOST_SLOT_ALT_PRESET, HOST_SLOT_CONNECTION, HOST_DISPATCH_USER);

    await expect(fixture.callbacks.provider(hostProviderInput(slot.resolution))).rejects.toMatchObject({
      name: "BoundProviderPreflightError",
    });
    expect(hostProviderCalls).toHaveLength(0);
  });

  test("rejects a slot revision after its selected preset row changes before provider", async () => {
    const fixture = createHostFixture();
    const slot = await resolveHostSlot(fixture);
    getDb()
      .query("UPDATE presets SET parameters = ? WHERE id = ? AND user_id = ?")
      .run('{"temperature":0.95}', HOST_SLOT_PRESET, HOST_DISPATCH_USER);

    await expect(fixture.callbacks.provider(hostProviderInput(slot.resolution))).rejects.toMatchObject({
      name: "BoundProviderPreflightError",
    });
    expect(hostProviderCalls).toHaveLength(0);
  });

  test("replays absent authoritative Main reasoning without normalized provider defaults", async () => {
    const authoritativeContext = {
      connectionId: HOST_MAIN_CONNECTION,
      presetId: HOST_MAIN_PRESET,
      settings: HOST_MAIN_CONTEXT.settings,
    };
    const mainResolution = resolveMainDispatchSnapshot(HOST_DISPATCH_USER, authoritativeContext);
    const parentSnapshot = parent({
      main: captureMainDispatchSnapshot(mainInput({
        descriptor: mainResolution.descriptor,
        reasoning: {},
        authoritativeContext,
      })),
    });
    const callbacks = createHostBoundGenerationCallbacks({
      parent: parentSnapshot,
      extensionIdentifier: "bound-generation-test",
      signal: new AbortController().signal,
      mainApiKey: "main-api-key",
    });

    await expect(callbacks.resolveDispatch({
      source: {
        source: "main",
        expectedConnectionDispatchRevision: mainResolution.dispatchRevision,
      },
      parent: parentSnapshot,
    })).resolves.toMatchObject({
      source: "main",
      connectionId: HOST_MAIN_CONNECTION,
      descriptor: { model: "main-model" },
    });
  });

  test("keeps a nondefault Main route parent-bound and rejects its stale revision", async () => {
    const fixture = createHostFixture();
    const resolved = await fixture.callbacks.resolveDispatch({
      source: {
        source: "main",
        expectedConnectionDispatchRevision: fixture.mainResolution.dispatchRevision,
      },
      parent: fixture.parentSnapshot,
    });

    expect(resolved).toMatchObject({
      source: "main",
      connectionId: HOST_MAIN_CONNECTION,
      descriptor: { model: "main-model" },
    });
    getDb()
      .query("UPDATE connection_profiles SET model = ? WHERE id = ? AND user_id = ?")
      .run("main-model-stale", HOST_MAIN_CONNECTION, HOST_DISPATCH_USER);

    await expect(fixture.callbacks.resolveDispatch({
      source: {
        source: "main",
        expectedConnectionDispatchRevision: fixture.mainResolution.dispatchRevision,
      },
      parent: fixture.parentSnapshot,
    })).rejects.toThrow("Bound Main dispatch changed before work");
  });
});

describe("Non-commit lease and fatal channel", () => {
  function leaseContext(): ReadOnlyEffectLeaseContext {
    return {
      workerId: "worker-1",
      registrationGeneration: "registration-1",
      callbackUserId: "user-1",
      hostGeneration: HOST_GENERATION,
      requestId: "request-lease",
      invocationToken: brandInvocationToken("token-lease"),
      operation: "context-hook",
    };
  }

  test("denies mutation/reentry/network/file effects but permits cancellation", () => {
    const lease = createReadOnlyEffectLease(leaseContext(), ["read:connection"]);
    lease.assertAllowed("read:connection");
    lease.assertAllowed("local:format");
    lease.assertAllowed("cancel_generation");
    expect(() => lease.assertAllowed("generate.quiet")).toThrow();
    expect(() => lease.assertAllowed("network:fetch")).toThrow();
    expect(() => lease.assertAllowed("file:write")).toThrow();
    expect(() => denyBoundEffect(lease, "prompt.assemble")).toThrow();
    lease.release();
    expect(lease.isActive()).toBe(false);
    expect(() => lease.assertAllowed("read:connection")).toThrow();
  });

  test("fatal precedence cannot be forged by worker-authored shape", () => {
    const fatal = createBoundHostContainmentFatal({
      code: "NONCOMMIT_CONTAINMENT_FAILED",
      message: "lease contradiction",
      hostGeneration: HOST_GENERATION,
      workerId: "worker-1",
      requestId: "request-fatal",
    });
    expect(isHostContainmentFatal(fatal)).toBe(true);
    expect(isHostContainmentFatal({ name: fatal.name, code: fatal.code })).toBe(false);
    expect(() => { throw fatal; }).toThrow("lease contradiction");
  });
});
