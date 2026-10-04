/**
 * Task 3.16 — focused unit tests for the surfaces the Edit-and-Send 401 fix
 * adds:
 *
 *   - `connections.service.resolveActiveConnectionId` (the STRICT active rung)
 *   - `connections.service.resolveActingConnectionId` (the full chain)
 *   - `multiplayer.service.resolveHostConnectionId` (now a delegate)
 *   - `generate.service.resolveChatGenerationConnection` (both ladders)
 *   - `generate.service.readEditAndSendAlwaysUseActiveConnection` (strict read)
 *   - `startGeneration`'s origin gating (proved by a `getSetting` spy)
 *   - `generate.service.resolveProviderAndKey`'s credential classification
 *   - the dispatcher's terminal `credential_unresolved` path
 *
 * Credential hygiene (requirement 2.8): opaque placeholder values only. No
 * assertion or log line ever carries a credential VALUE; credential assertions
 * reference the secret KEY NAME.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import type { ConnectionProfile } from "../types/connection-profile";

import { closeDatabase, getDb, initDatabase } from "../db/connection";

// Deterministic AES-256 key so opaque placeholder secrets are readable without
// a real identity file on disk.
mock.module("../crypto/init", () => ({
  getEncryptionKeyBytes: () => new Uint8Array(32).fill(7),
}));

// Static import (hoisted) captures the REAL resolver before the wrapper below
// replaces the module for importers such as generate.service. The snapshot is
// spread into a plain object eagerly: Bun's mock.module swaps the live module
// entry in place, so a live namespace reference would recursively observe the
// mock instead of the original.
import * as connectionResolutionModule from "./generation/connection-resolution";
import type { ResolveChatGenerationConnectionOptions } from "./generation/connection-resolution";
const realConnectionResolution = { ...connectionResolutionModule };

/**
 * Staging (c2ae02a3) made `startGeneration`/`dryRunGeneration` reassign their
 * `input` (`input = { ...input, frontendSessionId }`), so the
 * `input.connection_id` mutations these wiring tests used to observe are no
 * longer visible to the caller. The wrapper below records what the REAL
 * resolver ladder settled on instead: it delegates to the actual
 * implementation (nothing about connection or credential resolution is
 * stubbed) and appends each call's options + result for assertions.
 */
const generationConnectionResolutions: Array<{
  requestedConnectionId?: string;
  options: ResolveChatGenerationConnectionOptions | undefined;
  resolvedId: string;
}> = [];

mock.module("./generation/connection-resolution", () => ({
  ...realConnectionResolution,
  resolveChatGenerationConnection: (
    userId: string,
    metadata: Record<string, any> | null | undefined,
    requestedConnectionId?: string,
    options?: ResolveChatGenerationConnectionOptions,
  ) => {
    const resolved = realConnectionResolution.resolveChatGenerationConnection(
      userId,
      metadata,
      requestedConnectionId,
      options,
    );
    generationConnectionResolutions.push({ requestedConnectionId, options, resolvedId: resolved.id });
    return resolved;
  },
}));

const chatsSvc = await import("./chats.service");
const connectionsSvc = await import("./connections.service");
const secretsSvc = await import("./secrets.service");
const settingsSvc = await import("./settings.service");
const multiplayerSvc = await import("./multiplayer.service");
const chatBackground = await import("./chat-background.service");
const councilProfilesSvc = await import("./council/council-profiles.service");
const pool = await import("./generation-pool.service");
const generateSvc = await import("./generate.service");
const dispatcher = await import("./edit-and-send-dispatcher.service");
const { ConnectionCredentialError } = await import("../utils/provider-errors");
const { eventBus } = await import("../ws/bus");
const { EventType } = await import("../ws/events");

const resolveChatConnection = generateSvc.__test__.resolveChatGenerationConnection;
const resolveProviderAndKey = generateSvc.__test__.resolveProviderAndKey;
const readAlwaysActive = generateSvc.__test__.readEditAndSendAlwaysUseActiveConnection;

const USER = "user:acting";

/** Opaque, obviously-not-a-credential placeholder. Never asserted on. */
const PLACEHOLDER_SECRET = "opaque-placeholder-not-a-credential";

const NO_CONNECTION_MESSAGE =
  "No connection profile found. Configure a default connection or select one for this chat.";
const BINDING_MODEL_OVERRIDE = "binding-model-override";

// ── Fixture ────────────────────────────────────────────────────────────────

function initTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run(`CREATE TABLE characters (
    id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    personality TEXT NOT NULL DEFAULT '', scenario TEXT NOT NULL DEFAULT '', first_mes TEXT NOT NULL DEFAULT '',
    mes_example TEXT NOT NULL DEFAULT '', creator TEXT NOT NULL DEFAULT '', creator_notes TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '', post_history_instructions TEXT NOT NULL DEFAULT '', avatar_path TEXT,
    image_id TEXT, tags TEXT NOT NULL DEFAULT '[]', alternate_greetings TEXT NOT NULL DEFAULT '[]',
    extensions TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 1
  )`);
  db.run(`CREATE TABLE chats (
    id TEXT PRIMARY KEY, user_id TEXT, character_id TEXT, name TEXT NOT NULL DEFAULT '', metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, index_in_chat INTEGER NOT NULL, is_user INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', send_date INTEGER NOT NULL, swipe_id INTEGER NOT NULL DEFAULT 0,
    swipes TEXT NOT NULL DEFAULT '[]', swipe_dates TEXT NOT NULL DEFAULT '[]', extra TEXT NOT NULL DEFAULT '{}',
    parent_message_id TEXT, branch_id TEXT, created_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1
  )`);
  db.run(`CREATE TABLE chat_memory_cache (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, settings_key TEXT NOT NULL,
    source_message_count INTEGER NOT NULL DEFAULT 0, query_preview TEXT NOT NULL DEFAULT '', chunks_json TEXT NOT NULL DEFAULT '[]',
    formatted TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
    settings_source TEXT NOT NULL DEFAULT 'global', chunks_available INTEGER NOT NULL DEFAULT 0,
    chunks_pending INTEGER NOT NULL DEFAULT 0, retrieval_mode TEXT NOT NULL DEFAULT 'empty', created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, UNIQUE(chat_id, settings_key)
  )`);
  db.run(`CREATE TABLE generation_outbox (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL, user_id TEXT NOT NULL, chat_id TEXT NOT NULL,
    branch_chat_id TEXT NOT NULL, edited_message_id TEXT NOT NULL, target_message_id TEXT, target_swipe_index INTEGER,
    expected_version INTEGER NOT NULL, generation_id TEXT NOT NULL UNIQUE, mode TEXT NOT NULL CHECK(mode IN ('normal', 'swipe')),
    status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled')),
    lease_owner TEXT, lease_expires_at INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER,
    last_error_code TEXT, terminal_reason TEXT, dispatched_at INTEGER, completed_at INTEGER, cancelled_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    -- migrations/111_generation_outbox_connection_id.sql. Hand-written schema
    -- (no migrations run here), so the column is mirrored LAST to match the
    -- ALTER TABLE append order.
    connection_id TEXT
  )`);
  db.run(`CREATE TABLE settings (
    key TEXT NOT NULL, value TEXT NOT NULL, user_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key, user_id)
  )`);
  db.run(`CREATE TABLE connection_profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, api_url TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '', preset_id TEXT, is_default INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 1,
    has_api_key INTEGER NOT NULL DEFAULT 0, user_id TEXT
  )`);
  db.run(`CREATE TABLE secrets (
    key TEXT NOT NULL, encrypted_value TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL,
    user_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, user_id)
  )`);
  // migrations/022_tokenizers.sql — column shapes mirrored (minus FK clauses,
  // like the rest of this hand-rolled schema) so staging's tokenizer subsystem
  // reads on the generation path find real, empty tables instead of throwing.
  db.run(`CREATE TABLE tokenizer_configs (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}',
    is_built_in INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 1
  )`);
  db.run(`CREATE TABLE tokenizer_model_patterns (
    id TEXT PRIMARY KEY, tokenizer_id TEXT NOT NULL, pattern TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0, is_built_in INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 1
  )`);
  db.run(`CREATE TABLE message_breakdowns (
    message_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, data TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 1
  )`);
  getDb().query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)").run("char-acting", USER, "Acting");
}

function seedProfile(input: {
  id: string;
  name?: string;
  provider?: string;
  model?: string;
  is_default?: boolean;
  has_api_key?: boolean;
  metadata?: Record<string, unknown>;
}): void {
  getDb().query(
    `INSERT INTO connection_profiles
       (id, name, provider, api_url, model, preset_id, is_default, metadata, created_at, updated_at, has_api_key, user_id)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 1, 1, ?, ?)`,
  ).run(
    input.id,
    input.name ?? input.id,
    input.provider ?? "custom",
    "http://127.0.0.1:1234/v1",
    input.model ?? `${input.id}-model`,
    input.is_default ? 1 : 0,
    JSON.stringify(input.metadata ?? {}),
    input.has_api_key ? 1 : 0,
    USER,
  );
}

function seedSetting(key: string, value: unknown): void {
  getDb().query(
    `INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, 1)
     ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value), USER);
}

/** Write a settings row whose JSON is a bare scalar/array, bypassing helpers. */
function clearSetting(key: string): void {
  getDb().query("DELETE FROM settings WHERE key = ? AND user_id = ?").run(key, USER);
}

function seedChat(id: string, metadata: Record<string, unknown> = {}): void {
  getDb().query(
    "INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)",
  ).run(id, USER, "char-acting", id, JSON.stringify(metadata));
}

function seedMessage(id: string, chatId: string, index: number, isUser: boolean): void {
  getDb().query(`INSERT INTO messages (
    id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra,
    parent_message_id, branch_id, created_at, revision
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, '{}', NULL, NULL, ?, 1)`).run(
    id, chatId, index, isUser ? 1 : 0, isUser ? "User" : "Assistant", "hello",
    100 + index, JSON.stringify(["hello"]), JSON.stringify([100 + index]), 100 + index,
  );
}

function insertOutbox(overrides: Record<string, string | number | null> = {}): string {
  const id = typeof overrides.id === "string" ? overrides.id : crypto.randomUUID();
  const now = Date.now();
  getDb().query(
    `INSERT INTO generation_outbox (
      id, request_id, user_id, chat_id, branch_chat_id, edited_message_id,
      target_message_id, target_swipe_index, expected_version, generation_id,
      mode, status, lease_owner, lease_expires_at, attempt_count, next_attempt_at,
      last_error_code, terminal_reason, dispatched_at, completed_at, cancelled_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(
    id,
    (overrides.request_id as SQLQueryBindings) ?? "req-1",
    USER,
    "c1",
    "b1",
    "m1",
    (overrides.generation_id as SQLQueryBindings) ?? `gen-${id}`,
    (overrides.mode as SQLQueryBindings) ?? "normal",
    (overrides.status as SQLQueryBindings) ?? "pending",
    (overrides.lease_owner as SQLQueryBindings | null) ?? null,
    (overrides.lease_expires_at as SQLQueryBindings | null) ?? null,
    (overrides.attempt_count as SQLQueryBindings) ?? 0,
    now,
    now,
  );
  return id;
}

function outcomeOf(fn: () => ConnectionProfile): { id: string; model: string } | { threw: string } {
  try {
    const profile = fn();
    return { id: profile.id, model: profile.model };
  } catch (err) {
    return { threw: err instanceof Error ? err.message : String(err) };
  }
}

const spies: Array<{ mockRestore: () => void }> = [];
function track<T extends { mockRestore: () => void }>(spy: T): T {
  spies.push(spy);
  return spy;
}

/**
 * Minimum stubbing that lets `startGeneration` reach connection resolution and
 * pool registration without prompt assembly or any outbound call. Nothing about
 * connection or credential resolution is stubbed.
 */
function stubGenerationSurroundings(): void {
  track(spyOn(chatBackground, "abortChatBackground").mockResolvedValue(undefined));
  track(spyOn(councilProfilesSvc, "resolveProfile").mockImplementation(() => {
    throw new Error("skip-assembly");
  }));
}

let priorAssemblyWorkerEnv: string | undefined;

beforeEach(() => {
  initTestDb();
  dispatcher.resetEditAndSendDispatcherForTests();
  generationConnectionResolutions.length = 0;
  // Staging moved prompt assembly behind a worker-pool client; the spawned
  // worker initializes its OWN database and cannot see this file's hand-rolled
  // `:memory:` schema, so it only fails noisily into the in-process fallback.
  // Keep assembly in-process, where the `skip-assembly` stub above applies.
  priorAssemblyWorkerEnv = process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER;
  process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER = "false";
});

afterEach(() => {
  generateSvc.stopAllGenerations();
  pool.clearAllPoolEntries();
  generateSvc.stopGenerationSweep();
  dispatcher.resetEditAndSendDispatcherForTests();
  for (const spy of spies.splice(0)) spy.mockRestore();
  if (priorAssemblyWorkerEnv === undefined) {
    delete process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER;
  } else {
    process.env.LUMIVERSE_PROMPT_ASSEMBLY_WORKER = priorAssemblyWorkerEnv;
  }
  closeDatabase();
});

// ── resolveActiveConnectionId — the five cases that decide the override ─────

describe("resolveActiveConnectionId — the strict active rung", () => {
  test("returns the id for a live activeProfileId", () => {
    seedProfile({ id: "live" });
    seedSetting("activeProfileId", "live");
    expect(connectionsSvc.resolveActiveConnectionId(USER)).toBe("live");
  });

  test("undefined for an absent setting", () => {
    seedProfile({ id: "live", is_default: true });
    clearSetting("activeProfileId");
    expect(connectionsSvc.resolveActiveConnectionId(USER)).toBeUndefined();
  });

  test("undefined for an empty string", () => {
    seedProfile({ id: "live", is_default: true });
    seedSetting("activeProfileId", "");
    expect(connectionsSvc.resolveActiveConnectionId(USER)).toBeUndefined();
  });

  test("undefined for a non-string value", () => {
    seedProfile({ id: "live", is_default: true });
    seedSetting("activeProfileId", { id: "live" });
    expect(connectionsSvc.resolveActiveConnectionId(USER)).toBeUndefined();
  });

  test("undefined for an id naming a deleted profile", () => {
    seedProfile({ id: "live", is_default: true });
    seedSetting("activeProfileId", "deleted-never-existed");
    expect(connectionsSvc.resolveActiveConnectionId(USER)).toBeUndefined();
  });
});

// ── resolveActingConnectionId + resolveHostConnectionId — the five rungs ────

/** The five rungs of the chain, each seeded in isolation. */
const CHAIN_RUNGS: Array<{ label: string; seed: () => void; expected: string | undefined }> = [
  {
    label: "1. valid active id",
    seed: () => {
      seedProfile({ id: "chain-active" });
      seedProfile({ id: "chain-default", is_default: true });
      seedSetting("activeProfileId", "chain-active");
    },
    expected: "chain-active",
  },
  {
    label: "2. active id naming a deleted profile → the default",
    seed: () => {
      seedProfile({ id: "chain-default", is_default: true });
      seedSetting("activeProfileId", "chain-deleted");
    },
    expected: "chain-default",
  },
  {
    label: "3. no active setting, default present → the default",
    seed: () => {
      seedProfile({ id: "chain-default", is_default: true });
      clearSetting("activeProfileId");
    },
    expected: "chain-default",
  },
  {
    label: "4. neither, one owned profile → that profile",
    seed: () => {
      seedProfile({ id: "chain-only" });
      clearSetting("activeProfileId");
    },
    expected: "chain-only",
  },
  {
    label: "5. no profiles at all → undefined",
    seed: () => { clearSetting("activeProfileId"); },
    expected: undefined,
  },
];

describe("resolveActingConnectionId — each rung in isolation", () => {
  for (const rung of CHAIN_RUNGS) {
    test(rung.label, () => {
      initTestDb();
      rung.seed();
      expect(connectionsSvc.resolveActingConnectionId(USER)).toBe(rung.expected as string);
    });
  }
});

describe("resolveHostConnectionId delegates to the shared resolver", () => {
  test("identical results for all five rungs (multiplayer anti-drift guard)", () => {
    const observed: Array<{ label: string; host: string | undefined; acting: string | undefined }> = [];
    for (const rung of CHAIN_RUNGS) {
      initTestDb();
      rung.seed();
      observed.push({
        label: rung.label,
        host: multiplayerSvc.resolveHostConnectionId(USER),
        acting: connectionsSvc.resolveActingConnectionId(USER),
      });
    }
    expect(observed).toEqual(CHAIN_RUNGS.map((rung) => ({
      label: rung.label,
      host: rung.expected,
      acting: rung.expected,
    })));
  });
});

// ── resolveChatGenerationConnection — both ladders ──────────────────────────

function seedLadder(): void {
  seedProfile({ id: "bound", model: "model-bound", has_api_key: true });
  seedProfile({ id: "active", model: "model-active", has_api_key: true });
  seedProfile({ id: "default", model: "model-default", is_default: true });
  seedSetting("activeProfileId", "active");
}

describe("resolveChatGenerationConnection — the default ladder", () => {
  test("a live binding wins over the acting connection", () => {
    seedLadder();
    expect(outcomeOf(() => resolveChatConnection(USER, { connection_profile_id: "bound" })))
      .toEqual({ id: "bound", model: "model-bound" });
  });

  test("an explicit requested id wins over the acting connection", () => {
    seedLadder();
    expect(outcomeOf(() => resolveChatConnection(USER, {}, "default")))
      .toEqual({ id: "default", model: "model-default" });
  });

  test("with no id and no binding the ACTING connection is used, not is_default", () => {
    // This is the 401 fix: `is_default` is a different piece of state from the
    // `activeProfileId` the UI sends as `connection_id`.
    seedLadder();
    expect(outcomeOf(() => resolveChatConnection(USER, {}, undefined)))
      .toEqual({ id: "active", model: "model-active" });
  });

  test("connection_model overrides the bound profile's model, and only when bound", () => {
    seedLadder();
    expect(outcomeOf(() => resolveChatConnection(
      USER,
      { connection_profile_id: "bound", connection_model: BINDING_MODEL_OVERRIDE },
    ))).toEqual({ id: "bound", model: BINDING_MODEL_OVERRIDE });
    expect(outcomeOf(() => resolveChatConnection(USER, { connection_model: BINDING_MODEL_OVERRIDE })))
      .toEqual({ id: "active", model: "model-active" });
  });

  test("a deleted bound profile falls back without bricking the chat, and drops the override", () => {
    seedLadder();
    expect(outcomeOf(() => resolveChatConnection(
      USER,
      { connection_profile_id: "conn-deleted", connection_model: BINDING_MODEL_OVERRIDE },
    ))).toEqual({ id: "active", model: "model-active" });
  });

  test("a supplied-but-stale id still throws the original message byte-for-byte", () => {
    seedLadder();
    expect(outcomeOf(() => resolveChatConnection(USER, {}, "conn-never-existed")))
      .toEqual({ threw: NO_CONNECTION_MESSAGE });
  });

  test("nothing resolvable still throws the original message byte-for-byte", () => {
    expect(outcomeOf(() => resolveChatConnection(USER, {}, undefined)))
      .toEqual({ threw: NO_CONNECTION_MESSAGE });
  });
});

describe("resolveChatGenerationConnection — the preferActiveConnection ladder", () => {
  const opts = { preferActiveConnection: true };

  test("the strict active profile beats a live binding", () => {
    seedLadder();
    expect(outcomeOf(() => resolveChatConnection(USER, { connection_profile_id: "bound" }, undefined, opts)))
      .toEqual({ id: "active", model: "model-active" });
  });

  test("the binding's connection_model is dropped with the binding", () => {
    seedLadder();
    expect(outcomeOf(() => resolveChatConnection(
      USER,
      { connection_profile_id: "bound", connection_model: BINDING_MODEL_OVERRIDE },
      undefined,
      opts,
    ))).toEqual({ id: "active", model: "model-active" });
  });

  test("an explicit requested id still beats the active profile", () => {
    // The `!requestedId` guard: an explicitly supplied id is never overridden,
    // which is what keeps every interactive path bit-identical under the opt-in.
    seedLadder();
    expect(outcomeOf(() => resolveChatConnection(USER, {}, "default", opts)))
      .toEqual({ id: "default", model: "model-default" });
    // ...and with a live binding present, an explicit id keeps losing to the
    // binding exactly as it does today, because the override never fires.
    expect(outcomeOf(() => resolveChatConnection(USER, { connection_profile_id: "bound" }, "default", opts)))
      .toEqual({ id: "bound", model: "model-bound" });
  });

  test("an unresolvable active profile degrades to the binding", () => {
    seedLadder();
    seedSetting("activeProfileId", "deleted-never-existed");
    expect(outcomeOf(() => resolveChatConnection(
      USER,
      { connection_profile_id: "bound", connection_model: BINDING_MODEL_OVERRIDE },
      undefined,
      opts,
    ))).toEqual({ id: "bound", model: BINDING_MODEL_OVERRIDE });
  });

  test("with no binding either, it degrades to is_default and then to any owned profile", () => {
    seedLadder();
    clearSetting("activeProfileId");
    expect(outcomeOf(() => resolveChatConnection(USER, {}, undefined, opts)))
      .toEqual({ id: "default", model: "model-default" });

    getDb().query("UPDATE connection_profiles SET is_default = 0 WHERE user_id = ?").run(USER);
    const anyOwned = outcomeOf(() => resolveChatConnection(USER, {}, undefined, opts));
    expect("id" in anyOwned && ["bound", "active", "default"].includes(anyOwned.id)).toBe(true);
  });
});

// ── resolveChatGenerationConnection — the character bind ("bind to char") rung ──

const CHAR_ID = "char-acting";

/** Seed a `characterConnection:{characterId}` settings row (the raw storage shape). */
function seedCharacterBind(connectionId: string, characterId: string = CHAR_ID): void {
  seedSetting(`characterConnection:${characterId}`, connectionId);
}

describe("resolveChatGenerationConnection — the character bind rung", () => {
  test("a live character bind beats the requested id and the acting connection", () => {
    seedLadder();
    seedCharacterBind("bound");
    // Requested id present: the bind still outranks it (rung 4 above rung 5).
    expect(outcomeOf(() => resolveChatConnection(USER, {}, "default", { characterId: CHAR_ID })))
      .toEqual({ id: "bound", model: "model-bound" });
    // No requested id: the bind outranks the active profile too.
    expect(outcomeOf(() => resolveChatConnection(USER, {}, undefined, { characterId: CHAR_ID })))
      .toEqual({ id: "bound", model: "model-bound" });
  });

  test("a chat pin beats the character bind", () => {
    seedLadder();
    seedCharacterBind("active");
    expect(outcomeOf(() => resolveChatConnection(
      USER,
      { connection_profile_id: "bound" },
      undefined,
      { characterId: CHAR_ID },
    ))).toEqual({ id: "bound", model: "model-bound" });
  });

  test("metadata.group === true skips the character bind entirely", () => {
    // Group precedent: preset-profile character bindings are skipped in group
    // chats because per-member bindings would be ambiguous.
    seedLadder();
    seedCharacterBind("bound");
    expect(outcomeOf(() => resolveChatConnection(USER, { group: true }, "default", { characterId: CHAR_ID })))
      .toEqual({ id: "default", model: "model-default" });
    expect(outcomeOf(() => resolveChatConnection(USER, { group: true }, undefined, { characterId: CHAR_ID })))
      .toEqual({ id: "active", model: "model-active" });
  });

  test("a bind naming a deleted connection falls through to requested/active", () => {
    seedLadder();
    seedCharacterBind("conn-deleted-never-existed");
    expect(outcomeOf(() => resolveChatConnection(USER, {}, "default", { characterId: CHAR_ID })))
      .toEqual({ id: "default", model: "model-default" });
    expect(outcomeOf(() => resolveChatConnection(USER, {}, undefined, { characterId: CHAR_ID })))
      .toEqual({ id: "active", model: "model-active" });
  });

  test("the chat-pin connection_model override is never applied to a character bind", () => {
    // A character binding pins a CONNECTION, never a model: the override is
    // keyed to the chat pin (`boundConnection`) and must not travel.
    seedLadder();
    seedCharacterBind("bound");
    expect(outcomeOf(() => resolveChatConnection(
      USER,
      { connection_model: BINDING_MODEL_OVERRIDE },
      undefined,
      { characterId: CHAR_ID },
    ))).toEqual({ id: "bound", model: "model-bound" });
  });

  test("without opts.characterId the rung is inert (every pre-existing caller)", () => {
    seedLadder();
    seedCharacterBind("bound");
    expect(outcomeOf(() => resolveChatConnection(USER, {}, "default")))
      .toEqual({ id: "default", model: "model-default" });
    expect(outcomeOf(() => resolveChatConnection(USER, {}, undefined, {})))
      .toEqual({ id: "active", model: "model-active" });
  });
});

// ── resolveEditAndSendConnectionId — the character bind mirror rung ─────────

describe("resolveEditAndSendConnectionId — the character bind rung", () => {
  test("a live character bind beats the acting chain", () => {
    seedLadder();
    seedCharacterBind("bound");
    expect(connectionsSvc.resolveEditAndSendConnectionId(USER, {}, CHAR_ID)).toBe("bound");
  });

  test("a chat pin beats the character bind", () => {
    seedLadder();
    seedCharacterBind("active");
    expect(connectionsSvc.resolveEditAndSendConnectionId(
      USER,
      { connection_profile_id: "bound" },
      CHAR_ID,
    )).toBe("bound");
  });

  test("a group chat skips the character bind and lands on the acting chain", () => {
    seedLadder();
    seedCharacterBind("bound");
    expect(connectionsSvc.resolveEditAndSendConnectionId(USER, { group: true }, CHAR_ID))
      .toBe("active");
  });

  test("a bind naming a deleted connection degrades to the acting chain", () => {
    seedLadder();
    seedCharacterBind("conn-deleted-never-existed");
    expect(connectionsSvc.resolveEditAndSendConnectionId(USER, {}, CHAR_ID)).toBe("active");
  });

  test("no characterId (legacy/2-arg callers) leaves resolution unchanged", () => {
    seedLadder();
    seedCharacterBind("bound");
    expect(connectionsSvc.resolveEditAndSendConnectionId(USER, {})).toBe("active");
  });
});

// ── Character bind wiring — the real code paths forward chat.character_id ──

/**
 * The unit tests above exercise the RESOLVERS with an explicitly passed
 * `characterId`. These tests pin the wiring one level up: the entry points
 * (`startGeneration`, `dryRunGeneration`) actually forward the CHAT's
 * `character_id` into the resolver, so a seeded character bind changes the
 * connection a real generation runs on — not just what the resolver returns
 * when handed the id by hand.
 */
describe("character bind wiring — startGeneration and dryRunGeneration forward chat.character_id", () => {
  function seedBindFixture(chatId: string): void {
    // Keyless `custom` profiles so the credential preflight is not what these
    // tests exercise; the char-bind target must differ from the active
    // profile for the assertion to be meaningful.
    seedProfile({ id: "wiring-bound", model: "model-bound" });
    seedProfile({ id: "wiring-active", model: "model-active" });
    seedSetting("activeProfileId", "wiring-active");
    seedCharacterBind("wiring-bound");
    // No `connection_profile_id` pin in the metadata: the character bind must
    // win on its own, purely via `chats.character_id` → resolver opts.
    seedChat(chatId, { temporary: true, no_preset: true });
    seedMessage(`${chatId}-user`, chatId, 0, true);
  }

  test("startGeneration resolves a character bind into the generation input", async () => {
    seedBindFixture("wiring-start");
    stubGenerationSurroundings();

    const input = {
      userId: USER,
      chat_id: "wiring-start",
      generationId: "gen-wiring-start",
      generation_type: "normal" as const,
    };
    await generateSvc.startGeneration(input).catch(() => { /* assembly is stubbed out */ });

    // Staging (c2ae02a3) copies `input` for `frontendSessionId`, so the wiring
    // is pinned at the resolution call itself: exactly one resolution, the
    // chat's character_id forwarded, and the bind winning it.
    expect(generationConnectionResolutions).toHaveLength(1);
    expect(generationConnectionResolutions[0]?.options?.characterId).toBe(CHAR_ID);
    expect(generationConnectionResolutions[0]?.resolvedId).toBe("wiring-bound");
    // The connection really reached pool registration, not just the resolver.
    expect(pool.getPoolEntry("gen-wiring-start")?.model).toBe("model-bound");
  });

  test("dryRunGeneration resolves the same character bind into the dry-run input", async () => {
    seedBindFixture("wiring-dry");
    stubGenerationSurroundings();

    const input = {
      userId: USER,
      chat_id: "wiring-dry",
      generation_type: "normal" as const,
    };
    await generateSvc.dryRunGeneration(input).catch(() => {
      /* prompt assembly beyond resolution is not what this test pins */
    });

    expect(generationConnectionResolutions).toHaveLength(1);
    expect(generationConnectionResolutions[0]?.options?.characterId).toBe(CHAR_ID);
    expect(generationConnectionResolutions[0]?.resolvedId).toBe("wiring-bound");
  });
});

// ── Character bind + model roulette — commit stable, spin at generation ─────

/**
 * Roulette semantics under a character bind mirror the chat-pin precedent:
 * `resolveEditAndSendConnectionId` validates with `getConnection` (NOT
 * `resolveConnection`), so a bind pointing at a `model_roulette` profile
 * commits the roulette's OWN stable id on `generation_outbox.connection_id` —
 * never a spun member, which would pin one random draw for the life of the
 * row. The spin happens later, in `resolveChatGenerationConnection`'s
 * roulette-aware rungs (`resolveConnection`), so every dispatch/retry can
 * re-draw instead.
 */
describe("character bind pointing at a model roulette profile", () => {
  function seedRouletteLadder(): void {
    seedProfile({ id: "roul-a", model: "model-a" });
    seedProfile({ id: "roul-b", model: "model-b" });
    seedProfile({
      id: "roul",
      provider: connectionsSvc.MODEL_ROULETTE_PROVIDER,
      name: "Roulette",
      metadata: { connection_roulette: { connection_ids: ["roul-a", "roul-b"] } },
    });
    seedProfile({ id: "roul-active", model: "model-active" });
    seedSetting("activeProfileId", "roul-active");
  }

  test("resolveEditAndSendConnectionId commits the roulette's OWN stable id", () => {
    seedRouletteLadder();
    seedCharacterBind("roul");
    const committed = connectionsSvc.resolveEditAndSendConnectionId(USER, {}, CHAR_ID);
    expect(committed).toBe("roul");
    expect(committed).not.toBe("roul-a");
    expect(committed).not.toBe("roul-b");
  });

  test("resolveChatGenerationConnection spins the roulette to a live member", () => {
    seedRouletteLadder();
    seedCharacterBind("roul");
    for (let i = 0; i < 12; i++) {
      const outcome = outcomeOf(() => resolveChatConnection(USER, {}, undefined, { characterId: CHAR_ID }));
      expect("id" in outcome && ["roul-a", "roul-b"].includes(outcome.id)).toBe(true);
    }
  });

  test("the roulette's own id never leaks out of the generation resolver", () => {
    seedRouletteLadder();
    seedCharacterBind("roul");
    // Contrast with the commit resolver above: generation resolution is
    // roulette-aware, so no outcome is ever the roulette profile itself.
    const outcomes = Array.from({ length: 12 }, () =>
      outcomeOf(() => resolveChatConnection(USER, {}, undefined, { characterId: CHAR_ID })));
    expect(outcomes.every((outcome) => "id" in outcome && outcome.id !== "roul")).toBe(true);
  });
});

// ── Character bind storage + deleteConnection cleanup ───────────────────────

describe("character bind helpers and deleteConnection cleanup", () => {
  test("setCharacterConnectionBind validates character and connection, and get/clear round-trip", async () => {
    seedLadder();
    expect(connectionsSvc.getCharacterConnectionBind(USER, CHAR_ID)).toBeNull();

    expect(() => connectionsSvc.setCharacterConnectionBind(USER, "char-missing", "bound"))
      .toThrow("Character not found");
    expect(() => connectionsSvc.setCharacterConnectionBind(USER, CHAR_ID, "conn-missing"))
      .toThrow("Connection not found");

    expect(connectionsSvc.setCharacterConnectionBind(USER, CHAR_ID, "bound")).toBe("bound");
    expect(connectionsSvc.getCharacterConnectionBind(USER, CHAR_ID)).toBe("bound");

    connectionsSvc.clearCharacterConnectionBind(USER, CHAR_ID);
    expect(connectionsSvc.getCharacterConnectionBind(USER, CHAR_ID)).toBeNull();
    // Idempotent clear: still fine, still null.
    connectionsSvc.clearCharacterConnectionBind(USER, CHAR_ID);
    expect(connectionsSvc.getCharacterConnectionBind(USER, CHAR_ID)).toBeNull();
  });

  test("set/clear emit the user-scoped CHARACTER_CONNECTION_BIND_CHANGED event", () => {
    seedLadder();
    const emitted: Array<{ type: unknown; payload: unknown; userId: unknown }> = [];
    track(spyOn(eventBus, "emit").mockImplementation(((type: unknown, payload: unknown, userId: unknown) => {
      emitted.push({ type, payload, userId });
    }) as never));

    connectionsSvc.setCharacterConnectionBind(USER, CHAR_ID, "bound");
    connectionsSvc.clearCharacterConnectionBind(USER, CHAR_ID);

    const bindEvents = emitted.filter((e) => e.type === EventType.CHARACTER_CONNECTION_BIND_CHANGED);
    expect(bindEvents).toEqual([
      { type: EventType.CHARACTER_CONNECTION_BIND_CHANGED, payload: { characterId: CHAR_ID, connectionId: "bound" }, userId: USER },
      { type: EventType.CHARACTER_CONNECTION_BIND_CHANGED, payload: { characterId: CHAR_ID, connectionId: null }, userId: USER },
    ]);
  });

  test("deleteConnection removes dangling binds, leaves unrelated ones, and never crosses users", async () => {
    seedLadder();
    seedProfile({ id: "doomed" });
    seedProfile({ id: "kept" });
    getDb().query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)")
      .run("char-other", USER, "Other");
    getDb().query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)")
      .run("char-foreign", "user:other", "Foreign");

    // bound to the doomed connection, via the service (real storage shape)
    connectionsSvc.setCharacterConnectionBind(USER, CHAR_ID, "doomed");
    // bound to a surviving connection
    connectionsSvc.setCharacterConnectionBind(USER, "char-other", "kept");
    // ANOTHER user's bind that happens to name the same doomed id
    getDb()
      .query("INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, 1)")
      .run(`characterConnection:char-foreign`, JSON.stringify("doomed"), "user:other");

    expect(await connectionsSvc.deleteConnection(USER, "doomed")).toBe(true);

    expect({
      danglingRemoved: connectionsSvc.getCharacterConnectionBind(USER, CHAR_ID),
      unrelatedKept: connectionsSvc.getCharacterConnectionBind(USER, "char-other"),
      foreignUserUntouched: connectionsSvc.getCharacterConnectionBind("user:other", "char-foreign"),
    }).toEqual({ danglingRemoved: null, unrelatedKept: "kept", foreignUserUntouched: "doomed" });

    // A dangling bind (say from a restored backup) still degrades gracefully
    // in resolution rather than bricking the chat.
    expect(outcomeOf(() => resolveChatConnection(USER, {}, undefined, { characterId: CHAR_ID })))
      .toEqual({ id: "active", model: "model-active" });
  });
});

// ── readEditAndSendAlwaysUseActiveConnection — strict `=== true` ────────────

describe("readEditAndSendAlwaysUseActiveConnection — no truthiness coercion", () => {
  test("true only for a literal true", () => {
    seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: true });
    expect(readAlwaysActive(USER)).toBe(true);
  });

  const offCases: Array<{ label: string; seed: () => void }> = [
    { label: "a missing settings row", seed: () => clearSetting("quickToolbarSettings") },
    { label: "a row without the key", seed: () => seedSetting("quickToolbarSettings", { editAndSendSide: "left" }) },
    { label: "false", seed: () => seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: false }) },
    { label: "null", seed: () => seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: null }) },
    // These two exist specifically to pin the absence of truthiness coercion.
    { label: "the number 0", seed: () => seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: 0 }) },
    { label: 'the string "true"', seed: () => seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: "true" }) },
    { label: "an array", seed: () => seedSetting("quickToolbarSettings", [{ editAndSendAlwaysUseActiveConnection: true }]) },
    { label: "a non-object scalar", seed: () => seedSetting("quickToolbarSettings", "not-an-object") },
  ];

  for (const offCase of offCases) {
    test(`false for ${offCase.label}`, () => {
      offCase.seed();
      expect(readAlwaysActive(USER)).toBe(false);
    });
  }
});

// ── startGeneration origin gating ───────────────────────────────────────────

describe("startGeneration origin gating — zero extra queries on interactive paths", () => {
  function seedGatingFixture(chatId: string): void {
    // Genuinely keyless `custom` profiles so the credential preflight is not
    // what this test exercises: it must reach pool registration.
    seedProfile({ id: "gate-bound", model: "model-bound" });
    seedProfile({ id: "gate-active", model: "model-active" });
    seedSetting("activeProfileId", "gate-active");
    seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: true });
    seedChat(chatId, {
      temporary: true,
      no_preset: true,
      connection_profile_id: "gate-bound",
      connection_model: BINDING_MODEL_OVERRIDE,
    });
    seedMessage(`${chatId}-user`, chatId, 0, true);
  }

  test("called with NO second argument: no quickToolbarSettings read, resolution unchanged", async () => {
    seedGatingFixture("gate-interactive");
    stubGenerationSurroundings();
    const getSettingSpy = track(spyOn(settingsSvc, "getSetting"));

    const input = {
      userId: USER,
      chat_id: "gate-interactive",
      generationId: "gen-gate-interactive",
      generation_type: "normal" as const,
    };
    await generateSvc.startGeneration(input).catch(() => { /* assembly is stubbed out */ });

    // The setting is seeded `true`, yet the bound profile still wins — and the
    // spy proves the read never happened, rather than asserting it in prose.
    expect(generationConnectionResolutions.at(-1)?.resolvedId).toBe("gate-bound");
    expect(getSettingSpy.mock.calls.map((call) => call[1])).not.toContain("quickToolbarSettings");
  });

  test('called with { origin: "edit_and_send" }: the read occurs and the override applies', async () => {
    seedGatingFixture("gate-dispatch");
    stubGenerationSurroundings();
    const getSettingSpy = track(spyOn(settingsSvc, "getSetting"));

    const input = {
      userId: USER,
      chat_id: "gate-dispatch",
      generationId: "gen-gate-dispatch",
      generation_type: "normal" as const,
    };
    await generateSvc.startGeneration(input, { origin: "edit_and_send" })
      .catch(() => { /* assembly is stubbed out */ });

    expect(generationConnectionResolutions.at(-1)?.resolvedId).toBe("gate-active");
    expect(pool.getPoolEntry("gen-gate-dispatch")?.model).toBe("model-active");
    expect(getSettingSpy.mock.calls.map((call) => call[1])).toContain("quickToolbarSettings");
  });
});

// ── resolveProviderAndKey — the classification table ───────────────────────

describe("resolveProviderAndKey — the credential classification table", () => {
  interface Triple {
    hasApiKey: boolean;
    secretPresent: boolean;
    /** `openai` declares apiKeyRequired: true; `custom` declares false. */
    provider: "openai" | "custom";
  }

  async function classify(triple: Triple, index: number): Promise<string> {
    const id = `triple-${index}`;
    seedProfile({
      id,
      name: `Triple ${index}`,
      provider: triple.provider,
      has_api_key: triple.hasApiKey,
    });
    if (triple.secretPresent) {
      await secretsSvc.putSecret(USER, connectionsSvc.connectionSecretKey(id), PLACEHOLDER_SECRET);
    }
    try {
      const resolved = await resolveProviderAndKey(USER, id);
      return resolved.apiKey ? "authenticated" : "keyless";
    } catch (err) {
      if (err instanceof ConnectionCredentialError) return "credential_unresolved";
      const message = err instanceof Error ? err.message : String(err);
      return message === `No API key found for connection "Triple ${index}". Add one via the connection settings.`
        ? "missing_required_key"
        : `unexpected:${message}`;
    }
  }

  test("all eight (has_api_key, secret present, apiKeyRequired) combinations", async () => {
    const triples: Triple[] = [];
    for (const hasApiKey of [false, true]) {
      for (const secretPresent of [false, true]) {
        for (const provider of ["openai", "custom"] as const) {
          triples.push({ hasApiKey, secretPresent, provider });
        }
      }
    }

    const observed: Array<Record<string, unknown>> = [];
    for (const [index, triple] of triples.entries()) {
      initTestDb();
      observed.push({ ...triple, classification: await classify(triple, index) });
    }

    expect(observed).toEqual([
      // has_api_key = false, no secret.
      { hasApiKey: false, secretPresent: false, provider: "openai", classification: "missing_required_key" },
      // Intentionally keyless: permissive on purpose, so working local
      // endpoints keep working with the Authorization header omitted.
      { hasApiKey: false, secretPresent: false, provider: "custom", classification: "keyless" },
      // A resolvable secret always authenticates, whatever has_api_key says.
      { hasApiKey: false, secretPresent: true, provider: "openai", classification: "authenticated" },
      { hasApiKey: false, secretPresent: true, provider: "custom", classification: "authenticated" },
      // has_api_key = true, no secret: MISCONFIGURED. The existing
      // apiKeyRequired branch keeps its exact wording and fires first.
      { hasApiKey: true, secretPresent: false, provider: "openai", classification: "missing_required_key" },
      { hasApiKey: true, secretPresent: false, provider: "custom", classification: "credential_unresolved" },
      { hasApiKey: true, secretPresent: true, provider: "openai", classification: "authenticated" },
      { hasApiKey: true, secretPresent: true, provider: "custom", classification: "authenticated" },
    ]);
  });

  test("the thrown message names the connection and the secret KEY NAME, never a value", async () => {
    seedProfile({ id: "declared", name: "Declared Key", provider: "custom", has_api_key: true });
    const secretKeyName = connectionsSvc.connectionSecretKey("declared");

    const logs: string[] = [];
    const capture = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    track(spyOn(console, "warn").mockImplementation(capture));
    track(spyOn(console, "error").mockImplementation(capture));
    track(spyOn(console, "log").mockImplementation(capture));

    // Seed the secret for a DIFFERENT connection so a placeholder value exists
    // in the database while the connection under test cannot produce one.
    seedProfile({ id: "other", provider: "custom", has_api_key: true });
    await secretsSvc.putSecret(USER, connectionsSvc.connectionSecretKey("other"), PLACEHOLDER_SECRET);

    const err = await resolveProviderAndKey(USER, "declared").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionCredentialError);
    const credentialError = err as InstanceType<typeof ConnectionCredentialError>;
    expect(credentialError.code).toBe("credential_unresolved");
    expect(credentialError.retryable).toBe(false);
    expect(credentialError.secretKeyName).toBe(secretKeyName);
    expect(credentialError.message).toContain("Declared Key");
    expect(credentialError.message).toContain("Custom (OpenAI-compatible)");
    expect(credentialError.message).toContain(secretKeyName);
    expect(credentialError.message).not.toContain(PLACEHOLDER_SECRET);
    expect(logs.join("\n")).not.toContain(PLACEHOLDER_SECRET);
  });
});

// ── Dispatcher — the terminal credential path ─────────────────────────────

describe("dispatcher — credential failures are terminal", () => {
  function credentialError(): InstanceType<typeof ConnectionCredentialError> {
    return new ConnectionCredentialError({
      connectionId: "conn-x",
      connectionName: "Unrelated Custom Endpoint",
      provider: "Custom (OpenAI-compatible)",
      secretKeyName: connectionsSvc.connectionSecretKey("conn-x"),
    });
  }

  test("terminal row, one GENERATION_ENDED, and skipped by claim/reconcile/recover afterwards", async () => {
    const rowId = insertOutbox({ id: "row-credential", generation_id: "gen-credential" });
    dispatcher.setEditAndSendStartGeneration(async () => { throw credentialError(); });
    dispatcher.setEditAndSendGenerationActiveCheck(() => false);

    const ended: Array<Record<string, unknown>> = [];
    track(spyOn(eventBus, "emit").mockImplementation(((type: unknown, payload: unknown) => {
      if (type === EventType.GENERATION_ENDED) ended.push(payload as Record<string, unknown>);
    }) as never));

    const claimed = dispatcher.claimNextEditAndSendOutbox();
    expect(claimed?.id).toBe(rowId);
    const row = await dispatcher.dispatchClaimedEditAndSendOutbox(claimed!);

    expect({
      status: row?.status,
      terminalReason: row?.terminal_reason,
      lastErrorCode: row?.last_error_code,
      completedAtSet: row?.completed_at != null,
      nextAttemptAt: row?.next_attempt_at ?? null,
      leaseOwner: row?.lease_owner ?? null,
      endedGenerationIds: ended.map((payload) => payload.generationId),
      endedNamesConnection: ended.every((payload) =>
        String(payload.error).includes("Unrelated Custom Endpoint")),
      endedFailureMetadata: ended.map((payload) => ({
        errorCode: payload.errorCode,
        errorMessage: payload.errorMessage,
        connectionName: payload.connectionName,
      })),
    }).toEqual({
      status: "failed",
      terminalReason: "credential_unresolved",
      lastErrorCode: "credential_unresolved",
      completedAtSet: true,
      nextAttemptAt: null,
      leaseOwner: null,
      endedGenerationIds: ["gen-credential"],
      endedNamesConnection: true,
      endedFailureMetadata: [{
        errorCode: "credential_unresolved",
        errorMessage: credentialError().message,
        connectionName: "Unrelated Custom Endpoint",
      }],
    });

    // Never re-dispatched on any later tick or recovery pass.
    expect(dispatcher.claimNextEditAndSendOutbox()).toBeNull();
    dispatcher.reconcileEditAndSendOutbox();
    await dispatcher.recoverEditAndSendOutbox();
    const after = dispatcher.getGenerationOutboxById(rowId);
    expect({ status: after?.status, terminalReason: after?.terminal_reason }).toEqual({
      status: "failed",
      terminalReason: "credential_unresolved",
    });
  });

  test("a generic error is terminal so an uncertain provider dispatch is never replayed", async () => {
    const rowId = insertOutbox({ id: "row-generic", generation_id: "gen-generic" });
    dispatcher.setEditAndSendStartGeneration(async () => { throw new Error("provider_down"); });

    const claimed = dispatcher.claimNextEditAndSendOutbox();
    const row = await dispatcher.dispatchClaimedEditAndSendOutbox(claimed!);

    expect({
      status: row?.status,
      terminalReason: row?.terminal_reason,
      lastErrorCode: row?.last_error_code,
      nextAttemptAtSet: (row?.next_attempt_at ?? null) != null,
      dispatchedAt: row?.dispatched_at ?? null,
      completedAtSet: row?.completed_at != null,
    }).toEqual({
      status: "failed",
      terminalReason: "dispatch_failed",
      lastErrorCode: "provider_down",
      nextAttemptAtSet: false,
      dispatchedAt: null,
      completedAtSet: true,
    });
    expect(dispatcher.getGenerationOutboxById(rowId)?.attempt_count).toBe(1);
  });
});
