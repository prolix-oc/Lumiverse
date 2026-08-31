import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { COUNCIL_TOOLS_DEFAULTS, SIDECAR_DEFAULTS } from "lumiverse-spindle-types";
import {
  AgentRuntimeDecisionService,
  RuntimeDecisionTokenStore,
  normalizeEffectiveRuntimeRequest,
  resolveLoomRuntimePolicy,
  toPublicRuntimeDecision,
  type RuntimeDecisionDependencies,
} from "./agent-runtime-decision.service";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import type {
  AgenticReadinessVectorV1,
  EffectiveRuntimeRequestV1,
  FrozenConcreteConnectionV1,
  InputRevisionSetV1,
} from "../types/agent-runtime-decision";
import { encodeCanonicalPlainData } from "../utils/canonical-plain-data";

type FakeConnection = FrozenConcreteConnectionV1 & { presetId?: string | null };

const USER_ID = "user-a";
const CHAT_ID = "chat-a";
const fullRevisions: InputRevisionSetV1 = {
  target: 1,
  chat: 2,
  message: 3,
  preset: 4,
  block: 5,
  config: 6,
  binding: 7,
  connection: 8,
  endpoint: 9,
  credential: 10,
  persona: 11,
  character: 12,
  group: 13,
  world: 14,
  lore: 15,
  settings: 16,
  macro: 17,
  regex: 18,
  cognition: 21,
  readiness: 22,
};

function connection(id: string, overrides: Partial<FakeConnection> = {}): FakeConnection {
  return {
    logicalId: id,
    concreteId: id,
    label: id,
    provider: "test-provider",
    model: "test-model",
    endpointRevision: `endpoint-${id}`,
    credentialSecretRef: `secret-${id}`,
    credentialRevision: `credential-${id}`,
    candidateRevision: `candidate-${id}`,
    revision: `revision-${id}`,
    fingerprint: "domain-a",
    capabilityDigest: "capability-placeholder",
    capabilities: {
      streaming: true,
      toolCalling: true,
      toolsDisabledFinalization: true,
      nativeToolContinuation: true,
      toolContinuationMode: "native",
    },
    ...overrides,
    effectiveEndpoint: Object.hasOwn(overrides, "effectiveEndpoint")
      ? overrides.effectiveEndpoint ?? null
      : "https://default.example/v1",
  };
}

type TestPreset = {
  id: string;
  name?: string;
  cache_revision?: number;
  agent_config?: unknown;
};

function request(overrides: Partial<EffectiveRuntimeRequestV1> = {}): EffectiveRuntimeRequestV1 {
  return {
    chatId: CHAT_ID,
    logicalConnectionId: "root",
    presetId: "preset-default",
    mode: "agentic",
    generationType: "normal",
    requestEpoch: 1,
    inputRevisions: fullRevisions,
    readinessVector: readiness(),
    ...overrides,
  };
}

function readiness(overrides: Partial<AgenticReadinessVectorV1> = {}): AgenticReadinessVectorV1 {
  return {
    schemaEpoch: 1,
    runtimeEpoch: 1,
    reconciliationEpoch: 1,
    archiveRegistryVersion: 1,
    isolateHealthEpoch: 1,
    publicationStoreHealthEpoch: 1,
    providerCapabilityRevision: 1,
    configRevision: 1,
    bindingRevision: 1,
    concreteConnectionRevision: 1,
    targetRevision: 1,
    inputRevisionDigest: "snapshot",
    cognitionRevision: 1,
    killSwitchState: "auto",
    ready: true,
    reasons: [],
    ...overrides,
  };
}

function makeService(options: {
  chat?: Record<string, unknown>;
  preset?: TestPreset | null;
  connections?: Record<string, FakeConnection>;
  override?: { mode: "response" | "agentic" | null; revision: number; state: "ready" | "review_required" | "repair_required" } | null;
  presetReviewState?: "ready" | "review_required" | "repair_required";
  presetReviewCode?: string | null;
  presetReviewAcknowledged?: boolean;
  resolveCouncilProfile?: RuntimeDecisionDependencies["resolveCouncilProfile"];
  getReadinessVector?: RuntimeDecisionDependencies["getReadinessVector"];
  getInputRevisions?: RuntimeDecisionDependencies["getInputRevisions"];
  now?: () => number;
  defaultMode?: "response" | "agentic";
} = {}) {
  const chat = {
    id: CHAT_ID,
    character_id: "character-a",
    metadata: {},
    ...options.chat,
  };
  const preset = options.preset === null ? null : options.preset ?? {
    id: "preset-default",
    name: "Default",
    cache_revision: 3,
    agent_config: {
      version: 2,
      agentsEnabled: true,
      allowedModes: ["response", "agentic"],
      defaultMode: options.defaultMode ?? "response",
      maxInvocations: 8,
      maxToolCalls: 8,
      mainToolIds: [],
      mainLoreScope: "active",
      profiles: [],
      connectionSlots: [],
      slotBindings: {},
    },
  };
  const connections = options.connections ?? { root: connection("root") };
  let override = options.override ?? null;
  const tokenStore = new RuntimeDecisionTokenStore(options.now ?? (() => 1_000), { ttlMs: 60_000 });
  return new AgentRuntimeDecisionService({
    now: options.now ?? (() => 1_000),
    tokenStore,
    dependencies: {
      getChat: () => chat,
      getPreset: (_userId, presetId) => preset && preset.id === presetId ? preset : null,
      getPresetAgentConfig: (_userId, presetId) => {
        if (!preset || preset.id !== presetId || !preset.agent_config || typeof preset.agent_config !== "object") return null;
        const config = preset.agent_config as Record<string, unknown>;
        const rawBindings = config.slotBindings;
        const { slotBindings: _slotBindings, ...authoredConfig } = config;
        const bindings = rawBindings && typeof rawBindings === "object" && !Array.isArray(rawBindings)
          ? Object.entries(rawBindings as Record<string, unknown>).map(([slotId, connectionId]) => ({
            slotId,
            connectionId: typeof connectionId === "string" ? connectionId : null,
            bindingRevision: 1,
            state: "ready" as const,
          }))
          : [];
        return {
          config: authoredConfig,
          review: {
            state: options.presetReviewState ?? "ready",
            reasonCode: options.presetReviewCode ?? null,
            unresolvedSlotIds: [],
            staleSlotIds: [],
            acknowledged: options.presetReviewAcknowledged ?? false,
          },
          configRevision: 1,
          bindings,
        };
      },
      resolveProfile: () => ({ preset_id: preset?.id ?? null, source: "chat", binding: null }),
      ...(options.resolveCouncilProfile ? { resolveCouncilProfile: options.resolveCouncilProfile } : {}),
      ...(options.getInputRevisions ? { getInputRevisions: options.getInputRevisions } : {}),
      ...(options.getReadinessVector ? { getReadinessVector: options.getReadinessVector } : {}),
      resolvePersona: () => ({ id: "persona-a" }),
      resolveConcreteConnection: async (_userId, logicalId) => logicalId ? connections[logicalId] ?? null : null,
      getChatAgentModeOverride: () => override,
      setChatAgentModeOverride: (_userId, _chatId, mode, expectedRevision) => {
        if (expectedRevision !== undefined && override && expectedRevision !== override.revision) {
          throw new Error("stale");
        }
        const revision = (override?.revision ?? 0) + 1;
        override = { mode, revision, state: "ready" };
        return { chatId: CHAT_ID, mode, revision, state: "ready" };
      },
    },
  });
}

describe("AgentRuntimeDecisionService", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await runMigrations(getDb());
  });

  afterEach(() => {
    closeDatabase();
  });
  test("uses the first nonblank frozen endpoint alias before issuing a token", async () => {
    let observedEndpoint: string | null | undefined;
    const root = {
      ...connection("root", { effectiveEndpoint: "https://canonical.example/v1" }),
      endpoint: "   ",
    } as FakeConnection & { endpoint: string };
    const service = makeService({
      connections: { root },
      getReadinessVector: (_userId, _request, context) => {
        observedEndpoint = context.rootConnection?.effectiveEndpoint;
        return readiness();
      },
    });

    const decision = await service.resolve(USER_ID, request());
    expect(observedEndpoint).toBe("https://canonical.example/v1");
    expect(decision.runtimeDecisionToken).toMatch(/^lvrd_/);
  });

  test("fails readiness for a provider without an endpoint before token issuance", async () => {
    const service = makeService({
      connections: { root: connection("root", { effectiveEndpoint: null }) },
    });

    const decision = await service.resolve(USER_ID, request());
    expect(decision.runtimeDecisionToken).toBeNull();
    expect(decision.repairCodes).toContain("agentic_connection_unavailable");
  });

  test("resolves chat precedence and skips character bindings for groups", async () => {
    const calls: Array<{ characterId: string | null; isGroup?: boolean }> = [];
    const service = makeService({ chat: { metadata: { group: true, character_ids: ["character-a"] } } });
    const resolved = await new AgentRuntimeDecisionService({
      dependencies: {
        getChat: () => ({ id: CHAT_ID, character_id: "character-a", metadata: { group: true, character_ids: ["character-a"] } }),
        getPreset: (_userId, id) => id === "chat-preset" ? { id, name: "Chat" } : null,
        resolveConcreteConnection: () => Promise.resolve(connection("root")),
        resolveProfile: (_userId, _fallback, _chatId, characterId, options) => {
          calls.push({ characterId, isGroup: options.isGroup });
          return { preset_id: "chat-preset", source: "chat" };
        },
        resolvePersona: () => null,
        getChatAgentModeOverride: () => null,
        setChatAgentModeOverride: () => ({ chatId: CHAT_ID, mode: null, revision: 1, state: "ready" }),
      },
    }).resolve(USER_ID, request({ mode: "response" }));

    expect(resolved.preset.id).toBe("chat-preset");
    expect(calls).toEqual([{ characterId: "character-a", isGroup: true }]);
    expect(service).toBeDefined();
  });

  test("forced preset and no-preset chat bypass the profile chain", async () => {
    let profileCalls = 0;
    const service = makeService({
      chat: { metadata: { no_preset: true } },
      preset: { id: "forced", name: "Forced", agent_config: { version: 2, agentsEnabled: true, allowedModes: ["response", "agentic"], defaultMode: "agentic", profiles: [], connectionSlots: [] } },
    });
    const decision = await new AgentRuntimeDecisionService({
      dependencies: {
        getChat: () => ({ id: CHAT_ID, metadata: { no_preset: true } }),
        getPreset: (_userId, id) => id === "forced" ? { id, name: "Forced" } : null,
        resolveConcreteConnection: () => Promise.resolve(connection("root")),
        resolveProfile: () => { profileCalls++; return { preset_id: "forced" }; },
        resolvePersona: () => null,
        getChatAgentModeOverride: () => null,
        setChatAgentModeOverride: () => ({ chatId: CHAT_ID, mode: null, revision: 1, state: "ready" }),
      },
    }).resolve(USER_ID, request({ presetId: "forced", forcePresetId: true, mode: "response" }));

    expect(decision.preset.id).toBeNull();
    expect(profileCalls).toBe(0);
    expect(service).toBeDefined();
  });
  test("rejects malformed-present runtime policies at decision admission", async () => {
    const invalidPolicies: unknown[] = [null, 1, "invalid", []];
    for (const runtimePolicy of invalidPolicies) {
      const service = makeService({
        preset: {
          id: "preset-default",
          name: "Default",
          agent_config: {
            version: 2,
            agentsEnabled: true,
            allowedModes: ["response", "agentic"],
            defaultMode: "response",
            maxInvocations: 8,
            maxToolCalls: 8,
            mainToolIds: [],
            mainLoreScope: "active",
            profiles: [],
            connectionSlots: [],
            runtimePolicy,
          },
        },
      });
      await expect(service.resolve(USER_ID, request())).rejects.toMatchObject({
        code: "runtime_policy_invalid",
      });
    }
  });

  test("omits undecided required and optional Loom outcomes until authoritative assembly", async () => {
    const block = {
      id: "outlet-policy",
      name: "Outlet policy",
      content: "Authoritative {{outlet::policy_context}}",
      role: "system",
      enabled: true,
      position: "pre_history",
      depth: 0,
      marker: null,
      isLocked: false,
      color: null,
      injectionTrigger: [],
      revision: 1,
    };
    const optionalBlock = {
      ...block,
      id: "optional-policy",
      name: "Optional policy",
      content: "Optional authored policy",
    };
    getDb().run(
      `INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)`,
      [USER_ID, "Runtime decision user", "runtime-decision@example.test"],
    );
    getDb().run(
      `INSERT INTO presets (id, name, provider, user_id, cache_revision, prompt_order) VALUES (?, ?, ?, ?, ?, ?)`,
      ["preset-default", "Default", "test", USER_ID, 3, JSON.stringify([block, optionalBlock])],
    );
    const runtimePolicy = {
      version: 1,
      authority: "loom",
      scope: "preset",
      defaultMode: "agentic",
      loomPolicy: {
        version: 1,
        workPolicy: [{
          version: 1,
          id: "outlet-policy-entry",
          source: {
            kind: "loom_block",
            blockId: block.id,
            presetRevision: 3,
            blockRevision: 1,
            promptOrder: 0,
          },
          destination: "root_work",
          checkpoint: "WORK",
          required: true,
          visibility: "work_only",
        }, {
          version: 1,
          id: "optional-policy-entry",
          source: {
            kind: "loom_block",
            blockId: optionalBlock.id,
            presetRevision: 3,
            blockRevision: 1,
            promptOrder: 1,
          },
          destination: "root_work",
          checkpoint: "WORK",
          required: false,
          visibility: "work_only",
        }],
        workspaceUsage: [],
        completionCriteria: [],
        renderPolicy: [],
      },
      phases: [],
    };
    const service = makeService({
      preset: {
        id: "preset-default",
        name: "Default",
        cache_revision: 3,
        agent_config: {
          version: 2,
          agentsEnabled: true,
          allowedModes: ["response", "agentic"],
          defaultMode: "agentic",
          maxInvocations: 8,
          maxToolCalls: 8,
          mainToolIds: [],
          mainLoreScope: "active",
          profiles: [],
          connectionSlots: [],
          runtimePolicy,
        },
      },
    });

    const selected = await service.resolve(USER_ID, request());
    expect(selected.inspection).toMatchObject({
      effectiveEntryIds: [],
      items: [],
    });
    expect(JSON.stringify(selected.inspection)).not.toMatch(/required_source_unavailable|stale_source|rejected/);
  });

  test("issues an opaque token and rejects mismatch, replay, expiry, and revision races", async () => {
    let now = 1_000;
    const connections = { root: connection("root") };
    const service = makeService({ connections, now: () => now });
    const issued = await service.resolve(USER_ID, request());
    expect(issued.effectiveMode).toBe("agentic");
    expect(issued.runtimeDecisionToken).toMatch(/^lvrd_[A-Za-z0-9_-]+$/);
    expect(issued.runtimeDecisionExpiresAt).toBe(61_000);

    const mismatched = await service.consume(USER_ID, issued.runtimeDecisionToken!, request({ chatId: "other-chat" }));
    expect(mismatched).toEqual({ accepted: false, code: "decision_refresh_required", decision: null });
    const replayed = await service.consume(USER_ID, issued.runtimeDecisionToken!, request());
    expect(replayed.accepted).toBe(false);

    const issuedAgain = await service.resolve(USER_ID, request());
    connections.root = connection("root", { candidateRevision: "changed" });
    const stale = await service.consume(USER_ID, issuedAgain.runtimeDecisionToken!, request());
    expect(stale).toEqual({
      accepted: false,
      code: "decision_refresh_required",
      decision: null,
      mismatch: "candidate_revision",
    });

    connections.root = connection("root");
    const issuedCapability = await service.resolve(USER_ID, request());
    const admittedCapabilities = connections.root.capabilities;
    connections.root = connection("root", {
      capabilities: { ...admittedCapabilities, adapterRevision: "changed" },
    });
    const staleCapability = await service.consume(USER_ID, issuedCapability.runtimeDecisionToken!, request());
    expect(staleCapability).toEqual({
      accepted: false,
      code: "decision_refresh_required",
      decision: null,
      mismatch: "capability_digest",
    });

    connections.root = connection("root");
    const issuedExpired = await service.resolve(USER_ID, request());
    now = 61_001;
    const expired = await service.consume(USER_ID, issuedExpired.runtimeDecisionToken!, request());
    expect(expired.accepted).toBe(false);
  });
  test("claims one-use tokens without resolving a target and burns cross-user claims", async () => {
    const service = makeService();

    const owned = await service.resolve(USER_ID, request());
    expect(service.claim(USER_ID, "not-a-runtime-token")).toBe(false);
    expect(service.claim(USER_ID, owned.runtimeDecisionToken!)).toBe(true);
    expect(service.claim(USER_ID, owned.runtimeDecisionToken!)).toBe(false);
    await expect(service.consume(USER_ID, owned.runtimeDecisionToken!, request())).resolves.toMatchObject({
      accepted: false,
      code: "decision_refresh_required",
    });

    const crossUser = await service.resolve(USER_ID, request());
    expect(service.claim("user-b", crossUser.runtimeDecisionToken!)).toBe(false);
    expect(service.claim(USER_ID, crossUser.runtimeDecisionToken!)).toBe(false);
    await expect(service.consume(USER_ID, crossUser.runtimeDecisionToken!, request())).resolves.toMatchObject({
      accepted: false,
      code: "decision_refresh_required",
    });
  });

  test("consumes a token when readiness is absent from both requests", async () => {
    const service = makeService();
    const issueRequest = request();
    delete issueRequest.readinessVector;
    const issued = await service.resolve(USER_ID, issueRequest);
    const consumeRequest = request();
    delete consumeRequest.readinessVector;
    const consumed = await service.consume(USER_ID, issued.runtimeDecisionToken!, consumeRequest);
    expect(consumed.accepted).toBe(true);
    expect(consumed.code).toBe("accepted");
  });

  test("uses canonical ordering for the runtime decision input digest", async () => {
    const inputRevisions = { ...fullRevisions };
    const expectedNormalized = Object.fromEntries(
      Object.entries(inputRevisions).map(([key, value]) => [key, value]),
    );
    const expectedDigest = createHash("sha256")
      .update(encodeCanonicalPlainData(expectedNormalized), "utf8")
      .digest("hex");
    const decision = await makeService().resolve(USER_ID, request({ inputRevisions }));
    expect(decision.internal.binding.inputRevisionDigest).toBe(expectedDigest);
  });
  test("preserves durable preset and chat Agentic policy while consuming tokens", async () => {
    const service = makeService({ defaultMode: "agentic" });
    const durableRequest = request({ requestEpoch: 29 });
    delete durableRequest.mode;

    const issued = await service.resolve(USER_ID, durableRequest);
    expect(issued.runtimePolicy).toMatchObject({
      authoredValue: "agentic",
      effectiveValue: "agentic",
      source: "reviewed_preset_default",
      scope: "preset",
      transientSelection: null,
    });

    const consumed = await service.consume(
      USER_ID,
      issued.runtimeDecisionToken!,
      request({ mode: "agentic", requestEpoch: 29 }),
    );
    expect(consumed).toMatchObject({
      accepted: true,
      code: "accepted",
      decision: {
        runtimePolicy: {
          authoredValue: "agentic",
          effectiveValue: "agentic",
          source: "reviewed_preset_default",
          scope: "preset",
          transientSelection: null,
        },
      },
    });
    const chatService = makeService({
      override: { mode: "agentic", revision: 5, state: "ready" },
    });
    const durableChatRequest = request({ requestEpoch: 30 });
    delete durableChatRequest.mode;
    const chatIssued = await chatService.resolve(USER_ID, durableChatRequest);
    expect(chatIssued.runtimePolicy).toMatchObject({
      source: "durable_chat_override",
      scope: "chat",
      transientSelection: null,
    });
    const chatConsumed = await chatService.consume(
      USER_ID,
      chatIssued.runtimeDecisionToken!,
      request({ mode: "agentic", requestEpoch: 30 }),
    );
    expect(chatConsumed).toMatchObject({
      accepted: true,
      code: "accepted",
      decision: {
        runtimePolicy: {
          source: "durable_chat_override",
          scope: "chat",
          transientSelection: null,
        },
      },
    });
  });

  test("keeps explicit one-turn Response serialized as turn authority", async () => {
    const decision = await makeService({ defaultMode: "agentic" }).resolve(
      USER_ID,
      request({ mode: "response", requestEpoch: 31 }),
    );

    expect(decision).toMatchObject({
      requestedMode: "response",
      effectiveMode: "response",
      runtimeDecisionToken: null,
      runtimePolicy: {
        authoredValue: "response",
        effectiveValue: "response",
        source: "authenticated_one_turn",
        scope: "turn",
        transientSelection: {
          mode: "response",
          turnFence: 31,
          authenticated: true,
        },
      },
    });
  });

  test("fails closed when durable Agentic policy authority changes before consume", async () => {
    const service = makeService({ defaultMode: "agentic" });
    const durableRequest = request({ requestEpoch: 37 });
    delete durableRequest.mode;
    const issued = await service.resolve(USER_ID, durableRequest);

    service.setChatAgentModeOverride(USER_ID, CHAT_ID, "agentic", 0);
    const consumed = await service.consume(
      USER_ID,
      issued.runtimeDecisionToken!,
      request({ mode: "agentic", requestEpoch: 37 }),
    );
    expect(consumed).toEqual({
      accepted: false,
      code: "decision_refresh_required",
      decision: null,
      mismatch: "runtime_policy",
    });
  });
  test("consumes an authenticated one-turn decision once", async () => {
    const service = makeService();
    const issued = await service.resolve(USER_ID, request({
      mode: "agentic",
      requestEpoch: 7,
      transientSelection: {
        mode: "agentic",
        turnFence: 7,
        authenticated: true,
      },
    }));

    const accepted = await service.consume(USER_ID, issued.runtimeDecisionToken!, request({
      mode: "agentic",
      requestEpoch: 7,
      transientSelection: {
        mode: "agentic",
        turnFence: 7,
        authenticated: true,
      },
    }));
    expect(accepted.accepted).toBe(true);
    expect(accepted.code).toBe("accepted");
    expect(accepted.decision?.runtimePolicy).toMatchObject({
      source: "authenticated_one_turn",
      scope: "turn",
      transientSelection: { mode: "agentic", turnFence: 7, authenticated: true },
    });

    const replayed = await service.consume(USER_ID, issued.runtimeDecisionToken!, request({
      mode: "agentic",
      requestEpoch: 7,
      transientSelection: {
        mode: "agentic",
        turnFence: 7,
        authenticated: true,
      },
    }));
    expect(replayed).toEqual({
      accepted: false,
      code: "decision_refresh_required",
      decision: null,
    });
  });


  test("rejects legacy group metadata before issuing an Agentic token", async () => {
    const decision = await makeService({
      chat: { metadata: { group: 1 } },
    }).resolve(USER_ID, request());

    expect(decision.effectiveMode).toBe("response");
    expect(decision.runtimeDecisionToken).toBeNull();
    expect(decision.repairCodes).toContain("agentic_target_unsupported");
  });
  test("rejects an active owner-scoped Council profile without metadata flags", async () => {
    const councilSettings = {
      councilMode: true,
      members: [{
        id: "member-a",
        packId: "pack-a",
        packName: "Pack A",
        itemId: "item-a",
        itemName: "Member A",
        tools: ["test-tool"],
        role: "test",
        chance: 100,
      }],
      toolsSettings: { ...COUNCIL_TOOLS_DEFAULTS },
    };
    const sidecarSettings = {
      ...SIDECAR_DEFAULTS,
      connectionProfileId: "council-sidecar",
    };
    const decision = await makeService({
      resolveCouncilProfile: () => ({
        binding: {
          council_settings: councilSettings,
          sidecar_settings: sidecarSettings,
          captured_at: 1_000,
        },
        source: "defaults",
        council_settings: councilSettings,
        sidecar_settings: sidecarSettings,
      }),
    }).resolve(USER_ID, request());

    expect(decision.effectiveMode).toBe("response");
    expect(decision.capabilityReadiness.ready).toBe(false);
    expect(decision.runtimeDecisionToken).toBeNull();
    expect(decision.repairCodes).toContain("agentic_target_unsupported");
  });

  test("requires both native continuation signals and keeps legacy continuation in Response", async () => {
    const resolveWithCapabilities = (capabilities: FakeConnection["capabilities"]) => makeService({
      connections: {
        root: connection("root", { capabilities }),
      },
    }).resolve(USER_ID, request());

    const native = await resolveWithCapabilities({
      streaming: true,
      toolCalling: true,
      toolsDisabledFinalization: true,
      nativeToolContinuation: true,
      toolContinuationMode: "native",
    });
    expect(native.effectiveMode).toBe("agentic");
    expect(native.capabilityReadiness.ready).toBe(true);

    for (const incapable of [
      {
        streaming: true,
        toolCalling: true,
        toolsDisabledFinalization: true,
        nativeToolContinuation: false,
        toolContinuationMode: "native" as const,
      },
      {
        streaming: true,
        toolCalling: true,
        toolsDisabledFinalization: true,
        nativeToolContinuation: true,
        toolContinuationMode: "legacy" as const,
      },
      {
        streaming: true,
        toolCalling: true,
        toolsDisabledFinalization: true,
      },
    ]) {
      const decision = await resolveWithCapabilities(incapable);
      expect(decision.effectiveMode).toBe("response");
      expect(decision.capabilityReadiness.ready).toBe(false);
      expect(decision.capabilityReadiness.missing).toContain("native_tool_continuation");
      expect(decision.repairCodes).toContain("agentic_capability_missing_native_tool_continuation");
    }
  });
  test("returns an explicit Response escape for slot, capability, and domain failures", async () => {
    const preset = {
      id: "preset-default",
      name: "Agentic",
      agent_config: {
        version: 2,
        agentsEnabled: true,
        allowedModes: ["response", "agentic"],
        defaultMode: "agentic",
        maxInvocations: 8,
        maxToolCalls: 8,
        mainToolIds: [],
        mainLoreScope: "active",
        profiles: [{
          id: "writer",
          name: "Writer",
          systemPrompt: "",
          connectionRef: { kind: "slot", slotId: "profile/writer" },
          toolIds: [],
          workspaceCapabilities: [],
          loreScope: "active",
          allowMainDelegation: false,
          failurePolicy: "required",
          streamActivity: false,
          maxOutputTokens: 64,
          timeoutMs: 5_000,
        }],
        connectionSlots: [{ id: "profile/writer", label: "Writer", requiredCapabilities: ["tool_calling"] }],
        slotBindings: { "profile/writer": "child" },
      },
    };
    const service = makeService({
      preset,
      connections: {
        root: connection("root"),
        child: connection("child", { fingerprint: "domain-b", capabilities: { streaming: true } }),
      },
    });
    const decision = await service.resolve(USER_ID, request());
    expect(decision.effectiveMode).toBe("response");
    expect(decision.capabilityReadiness.responseEscape).toBe("available");
    expect(decision.repairCodes).toEqual(expect.arrayContaining([
      "agentic_domain_mismatch",
      "agentic_capability_missing_tool_calling",
      "agentic_response_escape",
    ]));
  });

  test("escapes Agentic for a null-mode import tombstone override", async () => {
    const service = makeService({
      override: { mode: null, revision: 1, state: "review_required" },
    });
    const decision = await service.resolve(USER_ID, request());
    expect(decision.effectiveMode).toBe("response");
    expect(decision.capabilityReadiness.ready).toBe(false);
    expect(decision.repairCodes).toContain("agentic_response_escape");
  });

  test("does not escape Agentic when a chat override is missing", async () => {
    const service = makeService({ override: null });
    const decision = await service.resolve(USER_ID, request());
    expect(decision.effectiveMode).toBe("agentic");
    expect(decision.capabilityReadiness.ready).toBe(true);
    expect(decision.repairCodes).not.toContain("agentic_response_escape");
  });


  test("still escapes Agentic when a review-required override still carries a mode", async () => {
    const service = makeService({
      override: { mode: "agentic", revision: 1, state: "review_required" },
    });
    const decision = await service.resolve(USER_ID, request());

    expect(decision.effectiveMode).toBe("response");
    expect(decision.capabilityReadiness.ready).toBe(false);
    expect(decision.repairCodes).toContain("agentic_response_escape");
  });
  test("records one-turn provenance without persisting it over the durable chat choice", async () => {
    const service = makeService({
      override: { mode: "response", revision: 3, state: "ready" },
    });
    const oneTurn = await service.resolve(USER_ID, request({
      mode: "agentic",
      requestEpoch: 17,
      transientSelection: {
        mode: "agentic",
        turnFence: 17,
        authenticated: true,
      },
    }));

    expect(oneTurn.runtimePolicy).toMatchObject({
      authoredValue: "agentic",
      effectiveValue: "agentic",
      source: "authenticated_one_turn",
      scope: "turn",
      cap: { authority: "host" },
      availability: { state: "available" },
      nextTurnOnly: true,
      transientSelection: {
        mode: "agentic",
        turnFence: 17,
        authenticated: true,
      },
      durableChatOverride: {
        mode: "response",
        revision: 3,
        state: "ready",
      },
    });

    const nextTurnRequest = request({
      transientSelection: null,
      requestEpoch: 18,
    });
    delete nextTurnRequest.mode;
    const nextTurn = await service.resolve(USER_ID, nextTurnRequest);
    expect(nextTurn.runtimePolicy).toMatchObject({
      authoredValue: "response",
      effectiveValue: "response",
      source: "durable_chat_override",
      scope: "chat",
      nextTurnOnly: true,
      transientSelection: null,
    });
    expect(service.getChatAgentModeOverride(USER_ID, CHAT_ID)).toMatchObject({
      mode: "response",
      revision: 3,
    });
  });

  test("durable Response stays agentic-free when the provider lacks Agentic capabilities", async () => {
    const service = makeService({
      override: { mode: "response", revision: 3, state: "ready" },
      connections: {
        root: connection("root", {
          capabilities: {
            streaming: true,
            toolCalling: false,
            toolsDisabledFinalization: false,
            nativeToolContinuation: false,
            toolContinuationMode: "unsupported",
          },
        }),
      },
      getInputRevisions: () => null,
      getReadinessVector: () => ({
        ready: false,
        reasons: ["input_revisions_incomplete", "provider_capability_unavailable"],
      }),
    });
    const responseRequest = request({
      transientSelection: null,
      requestEpoch: 28,
      inputRevisions: {},
    });
    delete responseRequest.mode;
    const decision = await service.resolve(USER_ID, responseRequest);
    expect(decision.requestedMode).toBe("response");
    expect(decision.effectiveMode).toBe("response");
    expect(decision.runtimePolicy).toMatchObject({
      authoredValue: "response",
      effectiveValue: "response",
      source: "durable_chat_override",
      scope: "chat",
      availability: { state: "available", reasonCode: null },
    });
    expect(decision.capabilityReadiness).toMatchObject({
      ready: true,
      sameDomain: true,
      required: [],
      missing: [],
      responseEscape: "available",
    });
    expect(decision.capabilityReadiness.repairCodes).toEqual([]);
    expect(decision.repairCodes).toEqual([]);
  });

  test("one-turn Response stays agentic-free when the provider lacks Agentic capabilities", async () => {
    const service = makeService({
      connections: {
        root: connection("root", {
          capabilities: {
            streaming: true,
            toolCalling: false,
            toolsDisabledFinalization: false,
            nativeToolContinuation: false,
            toolContinuationMode: "unsupported",
          },
        }),
      },
      getInputRevisions: () => null,
      getReadinessVector: () => ({
        ready: false,
        reasons: ["input_revisions_incomplete", "provider_capability_unavailable"],
      }),
    });
    const decision = await service.resolve(USER_ID, request({
      mode: "response",
      transientSelection: { mode: "response", turnFence: 7, authenticated: true },
      inputRevisions: {},
    }));
    expect(decision.requestedMode).toBe("response");
    expect(decision.effectiveMode).toBe("response");
    expect(decision.runtimePolicy).toMatchObject({
      authoredValue: "response",
      effectiveValue: "response",
      source: "authenticated_one_turn",
      scope: "turn",
      availability: { state: "available", reasonCode: null },
    });
    expect(decision.capabilityReadiness.ready).toBe(true);
    expect(decision.capabilityReadiness.required).toEqual([]);
    expect(decision.capabilityReadiness.missing).toEqual([]);
    expect(decision.capabilityReadiness.repairCodes).toEqual([]);
    expect(decision.repairCodes).toEqual([]);
  });

  test("Agentic stays host-rejected when input revisions are incomplete", async () => {
    const service = makeService({
      getInputRevisions: () => null,
      getReadinessVector: () => ({
        ready: false,
        reasons: ["input_revisions_incomplete"],
      }),
    });
    const decision = await service.resolve(USER_ID, request({ mode: "agentic", inputRevisions: {} }));
    expect(decision.requestedMode).toBe("agentic");
    expect(decision.effectiveMode).toBe("response");
    expect(decision.runtimePolicy.source).toBe("host_rejected");
    expect(decision.runtimePolicy.availability).toMatchObject({
      state: "unavailable",
      reasonCode: "input_revisions_incomplete",
    });
    expect(decision.capabilityReadiness.ready).toBe(false);
    expect(decision.repairCodes).toEqual(expect.arrayContaining([
      "agentic_input_revisions_incomplete",
      "input_revisions_incomplete",
    ]));
  });

  test("Agentic stays host-rejected when the provider lacks Agentic-only capabilities", async () => {
    const service = makeService({
      connections: {
        root: connection("root", {
          capabilities: {
            streaming: true,
            toolCalling: false,
            toolsDisabledFinalization: false,
            nativeToolContinuation: false,
            toolContinuationMode: "unsupported",
          },
        }),
      },
    });
    const decision = await service.resolve(USER_ID, request({ mode: "agentic" }));
    expect(decision.requestedMode).toBe("agentic");
    expect(decision.effectiveMode).toBe("response");
    expect(decision.runtimePolicy.source).toBe("host_rejected");
    expect(decision.capabilityReadiness.ready).toBe(false);
    expect(decision.capabilityReadiness.missing).toEqual(expect.arrayContaining([
      "tool_calling",
      "native_tool_continuation",
      "tools_disabled_finalization",
    ]));
    expect(decision.repairCodes).toEqual(expect.arrayContaining([
      "agentic_capability_missing_tool_calling",
      "agentic_capability_missing_native_tool_continuation",
      "agentic_capability_missing_tools_disabled_finalization",
    ]));
  });



  test("keeps repair acknowledgement separate from an unavailable mode choice", () => {
    const policy = resolveLoomRuntimePolicy({
      transientSelection: {
        mode: "agentic",
        turnFence: 21,
        authenticated: true,
      },
      durableChatOverride: {
        mode: "response",
        revision: 2,
        state: "ready",
        reviewCode: null,
        acknowledged: true,
      },
      presetDefault: "response",
      presetRevision: 9,
      presetState: "repair_required",
      presetRepairCode: "loom_policy_invalid",
      hostAllowedModes: ["response"],
      hostAvailability: "unavailable",
      hostReasonCode: "loom_policy_unavailable",
      repairAcknowledgement: {
        state: "acknowledged",
        presetRevision: 9,
        reasonCode: "loom_policy_invalid",
        acknowledgedAt: 1234,
      },
    });

    expect(policy).toMatchObject({
      authoredValue: "agentic",
      effectiveValue: "response",
      source: "host_rejected",
      scope: "host",
      availability: {
        state: "unavailable",
        reasonCode: "loom_policy_unavailable",
      },
      repairAcknowledgement: {
        state: "acknowledged",
        presetRevision: 9,
        reasonCode: "loom_policy_invalid",
        acknowledgedAt: 1234,
      },
      nextTurnOnly: true,
    });
  });



  test("persists repair acknowledgement independently of runtime mode", async () => {
    const service = makeService({
      now: () => 1_234,
      presetReviewState: "review_required",
      presetReviewCode: "loom_policy_repair_required",
    });
    getDb().run(
      `INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)`,
      [USER_ID, "Test User", "user-a@example.test"],
    );
    getDb().run(
      `INSERT INTO presets (id, name, provider, user_id, cache_revision) VALUES (?, ?, ?, ?, ?)`,
      ["preset-default", "Default", "test", USER_ID, 3],
    );
    const acknowledgement = service.acknowledgeRuntimeRepair(
      USER_ID,
      "preset-default",
      3,
      "loom_policy_repair_required",
    );

    expect(acknowledgement).toEqual({
      presetId: "preset-default",
      presetRevision: 3,
      reasonCode: "loom_policy_repair_required",
      acknowledgedAt: 1_234,
      revision: 1,
      scope: "repair/review",
      state: "acknowledged",
    });

    const decision = await service.resolve(USER_ID, request({
      mode: "agentic",
      requestEpoch: 2,
    }));
    expect(decision.runtimePolicy).toMatchObject({
      authoredValue: "agentic",
      effectiveValue: "response",
      repairAcknowledgement: {
        state: "acknowledged",
        presetRevision: 3,
        reasonCode: "loom_policy_repair_required",
        acknowledgedAt: 1_234,
      },
    });
  });

  test("public projection redacts credential references and trust fingerprints", async () => {
    const service = makeService();
    const decision = await service.resolve(USER_ID, request({ mode: "response" }));
    const publicProjection = toPublicRuntimeDecision(decision);
    const serialized = JSON.stringify(publicProjection);
    expect(serialized).not.toContain("secret-root");
    expect(serialized).not.toContain("domain-a");
    expect((publicProjection as unknown as Record<string, unknown>).internal).toBeUndefined();
  });


  test("unforced and forced preset forcePresetId survive same-call consume", async () => {
    const service = makeService({
      getInputRevisions: (_userId, request) => ({
        ...fullRevisions,
        macro: request.forcePresetId === true ? 99 : 17,
      }),
    });
    const unforcedIssued = await service.resolve(USER_ID, request({ forcePresetId: false }));
    const unforced = await service.consume(USER_ID, unforcedIssued.runtimeDecisionToken!, request({ forcePresetId: false }));
    expect(unforced.accepted).toBe(true);
    expect(unforced.code).toBe("accepted");

    const forcedIssued = await service.resolve(USER_ID, request({ forcePresetId: true }));
    const forced = await service.consume(USER_ID, forcedIssued.runtimeDecisionToken!, request({ forcePresetId: true }));
    expect(forced.accepted).toBe(true);
    expect(forced.code).toBe("accepted");
  });

  test("live input revision digest drift returns the exact mismatch", async () => {
    let chatRevision: number = 2;
    const service = makeService({
      getInputRevisions: () => ({ ...fullRevisions, chat: chatRevision }),
    });
    const issued = await service.resolve(USER_ID, request());
    chatRevision = 99;
    const consumed = await service.consume(USER_ID, issued.runtimeDecisionToken!, request());
    expect(consumed).toEqual({
      accepted: false,
      code: "decision_refresh_required",
      decision: null,
      mismatch: "input_revision_digest",
    });
  });
});

describe("effective runtime request DTO", () => {
  test("rejects unknown fields and malformed nested revisions instead of silently dropping them", () => {
    expect(() => normalizeEffectiveRuntimeRequest({ chatId: CHAT_ID, unexpected: true })).toThrow("request.unexpected is not allowed");
    expect(() => normalizeEffectiveRuntimeRequest({ chatId: CHAT_ID, target: { generationType: "normal", extra: true } })).toThrow("target.extra is not allowed");
    expect(() => normalizeEffectiveRuntimeRequest({ chatId: CHAT_ID, inputRevisions: { chat: {} } })).toThrow("inputRevisions.chat must be a revision");
  });
  test("rejects negative, unsafe, and malformed revision metadata", () => {
    const invalidRequests: unknown[] = [
      { chatId: CHAT_ID, requestEpoch: -1 },
      { chatId: CHAT_ID, requestEpoch: Number.MAX_SAFE_INTEGER + 1 },
      { chatId: CHAT_ID, requestEpoch: true },
      { chatId: CHAT_ID, requestEpoch: "-1" },
      { chatId: CHAT_ID, target: { generationType: "normal", revision: -1 } },
      { chatId: CHAT_ID, inputRevisions: { chat: -1 } },
      { chatId: CHAT_ID, inputRevisions: { chat: true } },
      { chatId: CHAT_ID, readinessVector: { runtimeEpoch: -1 } },
      { chatId: CHAT_ID, readinessVector: { runtimeEpoch: {} } },
    ];
    for (const invalid of invalidRequests) {
      expect(() => normalizeEffectiveRuntimeRequest(invalid)).toThrow();
    }
  });
  test("preserves absent optional fields when normalizing an already normalized request", () => {
    const absent = normalizeEffectiveRuntimeRequest({ chatId: CHAT_ID, requestEpoch: 1 });
    expect(Object.hasOwn(absent, "personaId")).toBe(false);
    expect(Object.hasOwn(absent, "mode")).toBe(false);
    expect(() => normalizeEffectiveRuntimeRequest(absent)).not.toThrow();

    const oneTurn = normalizeEffectiveRuntimeRequest({
      chatId: CHAT_ID,
      transientSelection: {
        mode: "agentic",
        turnFence: 1,
        authenticated: true,
      },
    });
    expect(Object.hasOwn(oneTurn, "mode")).toBe(false);
    expect(() => normalizeEffectiveRuntimeRequest(oneTurn)).not.toThrow();
  });

  test("serializes wire mode into one canonical transient authority shape", () => {
    const canonical = normalizeEffectiveRuntimeRequest({
      chatId: CHAT_ID,
      mode: "response",
      requestEpoch: 41,
    });

    expect(Object.hasOwn(canonical, "mode")).toBe(false);
    expect(canonical.transientSelection).toEqual({
      mode: "response",
      turnFence: 41,
      authenticated: true,
    });
    expect(normalizeEffectiveRuntimeRequest(canonical)).toEqual(canonical);
    expect(() => normalizeEffectiveRuntimeRequest({
      chatId: CHAT_ID,
      mode: "agentic",
      transientSelection: null,
      requestEpoch: 41,
    })).toThrow("mode conflicts with transientSelection");
  });
  test("accepts the documented aliases only when they agree and preserves a closed target", () => {
    const parsed = normalizeEffectiveRuntimeRequest({
      chat_id: CHAT_ID,
      connection_id: "logical",
      generation_type: "swipe",
      target: { generationType: "swipe", message_id: "message-1", swipeId: 2, revision: 7 },
      input_revisions: { chat: 3, message: null },
    });
    expect(parsed).toMatchObject({
      chatId: CHAT_ID,
      logicalConnectionId: "logical",
      generationType: "swipe",
      target: { generationType: "swipe", messageId: "message-1", swipeId: 2, revision: 7 },
      inputRevisions: { chat: 3, message: null },
    });
    expect(() => normalizeEffectiveRuntimeRequest({ chatId: CHAT_ID, chat_id: "different" })).toThrow("chatId has conflicting aliases");
  });
  test("rejects unauthenticated or open transient selections", () => {
    expect(() => normalizeEffectiveRuntimeRequest({
      chatId: CHAT_ID,
      transientSelection: {
        mode: "agentic",
        turnFence: 1,
        authenticated: false,
      },
    })).toThrow("transientSelection is invalid");
    expect(() => normalizeEffectiveRuntimeRequest({
      chatId: CHAT_ID,
      transientSelection: {
        mode: "agentic",
        turnFence: 1,
        authenticated: true,
        persisted: true,
      },
    })).toThrow("transientSelection.persisted is not allowed");
    expect(() => normalizeEffectiveRuntimeRequest({
      chatId: CHAT_ID,
      transientSelection: {
        mode: "agentic",
        authenticated: true,
      },
    })).toThrow("transientSelection.turnFence is required");
  });

});
