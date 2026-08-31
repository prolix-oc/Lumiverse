import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  buildGenerationAssemblySnapshot,
  liveConnectionInputRevision,
  liveCredentialInputRevision,
  liveEndpointInputRevision,
  liveSettingsInputRevision,
  SnapshotInputError,
  SnapshotLimitError,
  type GenerationAssemblySnapshotInputV1,
  type GenerationAssemblySnapshotV1,
} from "./prompt-assembly-snapshot.service";
import { canonicalRuntimeCapabilityDigest } from "./agent-runtime-decision.service";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function schema(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE chats (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, character_id TEXT, name TEXT NOT NULL, metadata TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, generation_revision INTEGER NOT NULL DEFAULT 0)");
  db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, index_in_chat INTEGER NOT NULL, is_user INTEGER NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, send_date INTEGER NOT NULL, swipe_id INTEGER NOT NULL, swipes TEXT NOT NULL, swipe_dates TEXT NOT NULL, extra TEXT NOT NULL, parent_message_id TEXT, branch_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, generation_revision INTEGER NOT NULL DEFAULT 0)");
  db.run("CREATE TABLE presets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL, engine TEXT NOT NULL, parameters TEXT NOT NULL, prompt_order TEXT NOT NULL, metadata TEXT NOT NULL, prompts TEXT NOT NULL, updated_at INTEGER NOT NULL, cache_revision INTEGER NOT NULL)");
  db.run("CREATE TABLE characters (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, personality TEXT NOT NULL, scenario TEXT NOT NULL, first_mes TEXT NOT NULL, mes_example TEXT NOT NULL, system_prompt TEXT NOT NULL, post_history_instructions TEXT NOT NULL, extensions TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE personas (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, subjective_pronoun TEXT NOT NULL, objective_pronoun TEXT NOT NULL, possessive_pronoun TEXT NOT NULL, reflexive_pronoun TEXT NOT NULL, possessive_pronoun_standalone TEXT NOT NULL, attached_world_book_id TEXT, is_narrator INTEGER NOT NULL, is_default INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE settings (key TEXT NOT NULL, value TEXT NOT NULL, user_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, user_id))");
  db.run("CREATE TABLE connection_profiles (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, provider TEXT NOT NULL, api_url TEXT NOT NULL, model TEXT NOT NULL, preset_id TEXT, is_default INTEGER NOT NULL, has_api_key INTEGER NOT NULL, metadata TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE regex_scripts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, find_regex TEXT NOT NULL, replace_string TEXT NOT NULL, actions TEXT NOT NULL, flags TEXT NOT NULL, placement TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT, target TEXT NOT NULL, trim_strings TEXT NOT NULL, disabled INTEGER NOT NULL, sort_order INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE world_books (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, metadata TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE world_book_entries (id TEXT PRIMARY KEY, world_book_id TEXT NOT NULL, order_value INTEGER NOT NULL)");
  return db;
}

function config(): Record<string, unknown> {
  return {
    version: 2,
    agentsEnabled: true,
    allowedModes: ["response", "agentic"],
    defaultMode: "agentic",
    maxInvocations: 4,
    maxToolCalls: 4,
    mainToolIds: [],
    mainLoreScope: "active",
    profiles: [{
      id: "writer",
      name: "Writer",
      systemPrompt: "",
      connectionRef: { kind: "inherit_main" },
      toolIds: [],
      loreScope: "active",
      allowMainDelegation: false,
      failurePolicy: "required",
      streamActivity: false,
      maxOutputTokens: 64,
      timeoutMs: 5000,
    }],
    connectionSlots: [],
  };
}

const concrete = Object.freeze({
  logicalId: "logical-connection",
  concreteId: "concrete-connection",
  label: "Frozen provider",
  provider: "openai",
  model: "model",
  effectiveEndpoint: "https://provider/v1",
  endpointRevision: "endpoint-22",
  credentialRevision: "credential-33",
  candidateRevision: "candidate-11",
  capabilityDigest: canonicalRuntimeCapabilityDigest({}),
  capabilities: {},
});

function input(db: Database, overrides: Partial<GenerationAssemblySnapshotInputV1> = {}): GenerationAssemblySnapshotInputV1 {
  return {
    userId: "user-1",
    chatId: "chat-1",
    generationId: "generation-1",
    assemblySurface: "WORK",
    generationType: "normal",
    connectionId: "logical-connection",
    presetId: "preset-1",
    targetMessageId: null,
    targetSwipeId: null,
    userInput: "",
    toolIds: [],
    concreteConnection: concrete,
    configRevision: 41,
    bindingRevision: 73,
    agentConfig: config(),
    db,
    ...overrides,
  };
}

function seed(db: Database): void {
  db.query("INSERT INTO chats VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("chat-1", "user-1", "character-1", "Chat", "{}", 1, 2, 3);
  db.query("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("message-1", "chat-1", 0, 1, "User", "hello", 1, 0, JSON.stringify(["hello"]), JSON.stringify([1]), "{}", null, null, 1, 1, 4);
  db.query("INSERT INTO presets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("preset-1", "user-1", "Preset", "openai", "classic", "{}", "[]", "{}", "{}", 5, 6);
  db.query("INSERT INTO characters VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("character-1", "user-1", "Character", "description", "personality", "scenario", "hello", "example", "", "", "{}", 7);
  db.query("INSERT INTO personas VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("persona-1", "user-1", "Persona", "", "", "I", "me", "my", "myself", "mine", null, 0, 1, 8);
  db.query("INSERT INTO connection_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("logical-connection", "user-1", "Live row", "other-provider", "https://live", "live-model", "preset-1", 1, 0, "{}", 99);
}

function snapshot(overrides: Partial<GenerationAssemblySnapshotInputV1> = {}): GenerationAssemblySnapshotV1 {
  const db = schema();
  try {
    seed(db);
    return buildGenerationAssemblySnapshot(input(db, overrides));
  } finally {
    db.close();
  }
}

describe("authenticated assembly snapshot revisions", () => {
  test("uses authenticated config, binding, candidate, endpoint, and credential revisions", () => {
    const result = snapshot();
    const configRevision = result.inputRevisionSet.config[0]!;
    const bindingRevision = result.inputRevisionSet.slotBinding[0]!;
    const connectionRevision = result.inputRevisionSet.connection[0]!;
    const endpointRevision = result.inputRevisionSet.endpoint[0]!;
    const credentialRevision = result.inputRevisionSet.credential[0]!;

    expect(configRevision).toMatchObject({ id: "preset-1", revision: "41", digest: digest(result.agentConfig) });
    expect(bindingRevision).toMatchObject({
      id: "preset-1",
      revision: "73",
      digest: digest({ logicalId: concrete.logicalId, concreteId: concrete.concreteId, bindingRevision: 73 }),
    });
    expect(connectionRevision).toMatchObject({
      id: concrete.concreteId,
      ...liveConnectionInputRevision(concrete.concreteId, concrete.candidateRevision),
    });
    expect(endpointRevision).toMatchObject({
      id: concrete.concreteId,
      ...liveEndpointInputRevision(concrete.concreteId, concrete.endpointRevision),
    });
    expect(credentialRevision).toMatchObject({
      id: concrete.concreteId,
      ...liveCredentialInputRevision(concrete.concreteId, concrete.credentialRevision),
    });
  });

  test("uses raw UTF-8 ordering for production settings digests", () => {
    const actual = liveSettingsInputRevision({
      globalWorldBooks: { "é": 2, z: 1 },
    }, "preset-1");
    const expected = createHash("sha256")
      .update("{\"globalWorldBooks\":{\"z\":1,\"é\":2}}")
      .digest("hex");
    expect(actual).toEqual({ revision: expected, digest: expected });
  });

  test("rematerialized label or URL do not change connection fence identity when capabilities stay admitted", () => {
    const baseline = snapshot();
    const rematerialized = snapshot({
      concreteConnection: {
        ...concrete,
        label: "Rematerialized provider",
        capabilities: concrete.capabilities,
        effectiveEndpoint: "https://rematerialized.example/v1",
        provider: "anthropic",
        model: "other-model",
      },
    });
    expect(rematerialized.inputRevisionSet.connection[0]).toEqual(baseline.inputRevisionSet.connection[0]);
    expect(rematerialized.inputRevisionSet.endpoint[0]).toEqual(baseline.inputRevisionSet.endpoint[0]);
    expect(rematerialized.inputRevisionSet.credential[0]).toEqual(baseline.inputRevisionSet.credential[0]);

    const bumped = snapshot({
      concreteConnection: { ...concrete, candidateRevision: "candidate-hostile" },
    });
    expect(bumped.inputRevisionSet.connection[0]!.revision).toBe("candidate-hostile");
    expect(bumped.inputRevisionSet.connection[0]!.digest).not.toBe(baseline.inputRevisionSet.connection[0]!.digest);
    expect(bumped.inputRevisionSet.endpoint[0]).toEqual(baseline.inputRevisionSet.endpoint[0]);
  });

  test("binds slot digest to both logical and concrete identities", () => {
    const baseline = snapshot();
    const changedLogical = snapshot({ concreteConnection: { ...concrete, logicalId: "logical-other" } });
    const changedConcrete = snapshot({ concreteConnection: { ...concrete, concreteId: "concrete-other" } });
    const baselineBinding = baseline.inputRevisionSet.slotBinding[0]!;
    expect(changedLogical.inputRevisionSet.slotBinding[0]!.id).toBe("preset-1");
    expect(changedConcrete.inputRevisionSet.slotBinding[0]!.id).toBe("preset-1");
    expect(changedLogical.inputRevisionSet.slotBinding[0]!.digest).not.toBe(baselineBinding.digest);
    expect(changedConcrete.inputRevisionSet.slotBinding[0]!.digest).not.toBe(baselineBinding.digest);
  });

  test("keeps target revision independent from user input while snapshot identity retains it", () => {
    const preflight = snapshot({ userInput: "" });
    const assembly = snapshot({ userInput: "request bytes" });
    expect(assembly.inputRevisionSet.target[0]!.revision).toBe(preflight.inputRevisionSet.target[0]!.revision);
    expect(assembly.inputRevisionSet.target[0]!.digest).toBe(preflight.inputRevisionSet.target[0]!.digest);
    expect(assembly.target.userInput).toBe("request bytes");
    expect(assembly.snapshotId).not.toBe(preflight.snapshotId);
  });

  test("rejects unsafe numeric revision strings but preserves opaque revision labels", () => {
    expect(() => snapshot({ configRevision: "-1.5" })).toThrow(SnapshotInputError);
    expect(() => snapshot({ configRevision: "-1e3" })).toThrow(SnapshotInputError);
    expect(() => snapshot({ bindingRevision: "9007199254740992" })).toThrow(SnapshotInputError);
    expect(() => snapshot({ bindingRevision: "revision-\u0001" })).toThrow(SnapshotInputError);
    expect(() => snapshot({ configRevision: "-1e-999" })).toThrow(SnapshotInputError);
    expect(() => snapshot({ configRevision: "1.00000000000000001" })).toThrow(SnapshotInputError);
    expect(() => snapshot({ configRevision: "1e-1" })).toThrow(SnapshotInputError);
    expect(snapshot({ configRevision: "config-hash" }).inputRevisionSet.config[0]!.revision).toBe("config-hash");
  });

  test("requires concrete identity, revision fields, and an exact capability digest", () => {
    const { candidateRevision: _candidateRevision, ...missingCandidateRevision } = concrete;
    expect(() => snapshot({ concreteConnection: missingCandidateRevision })).toThrow(SnapshotInputError);
    const { capabilityDigest: _capabilityDigest, ...missingCapabilityDigest } = concrete;
    expect(() => snapshot({ concreteConnection: missingCapabilityDigest })).toThrow(SnapshotInputError);
    expect(() => snapshot({
      concreteConnection: {
        ...concrete,
        capabilityDigest: "0".repeat(64),
      },
    })).toThrow(SnapshotInputError);
  });
  test("allows nullable connection revisions while retaining the capability digest", () => {
    const nullable = snapshot({
      concreteConnection: {
        ...concrete,
        revision: "stale-generic",
        candidateRevision: null,
        endpointRevision: null,
        credentialRevision: null,
      },
    });
    const connectionLive = liveConnectionInputRevision(concrete.concreteId, null);
    const endpointLive = liveEndpointInputRevision(concrete.concreteId, null);
    const credentialLive = liveCredentialInputRevision(concrete.concreteId, null);
    expect(nullable.inputRevisionSet.connection[0]).toMatchObject({
      id: concrete.concreteId,
      digest: connectionLive.digest,
      revision: connectionLive.revision.length > 0 ? connectionLive.revision : connectionLive.digest,
    });
    expect(nullable.inputRevisionSet.endpoint[0]).toMatchObject({
      id: concrete.concreteId,
      digest: endpointLive.digest,
      revision: endpointLive.revision.length > 0 ? endpointLive.revision : endpointLive.digest,
    });
    expect(nullable.inputRevisionSet.credential[0]).toMatchObject({
      id: concrete.concreteId,
      digest: credentialLive.digest,
      revision: credentialLive.revision.length > 0 ? credentialLive.revision : credentialLive.digest,
    });
  });
  test("fails closed when an owner-scoped connection points at a missing effective preset", () => {
    const db = schema();
    try {
      seed(db);
      db.query("DELETE FROM presets WHERE id = ?").run("preset-1");
      expect(() => buildGenerationAssemblySnapshot(input(db, {
        presetId: null,
        concreteConnection: undefined,
      }))).toThrow(/preset/i);
    } finally {
      db.close();
    }
  });

  test("fails when an authenticated preset is not owned and bounds duplicate tool IDs", () => {
    expect(() => snapshot({ presetId: "missing-preset" })).toThrow(/preset/i);
    expect(() => snapshot({ toolIds: Array.from({ length: 1025 }, () => "lore_list_books") })).toThrow(SnapshotLimitError);
  });

  test("fails closed when the lowered aggregate input cap is exceeded", () => {
    expect(() => snapshot({ limits: { maxInputBytes: 1 } })).toThrow(SnapshotLimitError);
  });
});
