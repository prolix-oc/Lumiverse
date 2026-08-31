/**
 * Task 1 — bug-condition exploration tests for the Edit-and-Send 401.
 *
 * These tests encode `expectedBehavior`, i.e. they are written to be CORRECT
 * AFTER THE FIX. On the UNFIXED tree cases 1, 2, 3, 4, 5, 6 and 8 MUST FAIL:
 * those failures are the evidence for the identity gap (`activeProfileId` !=
 * `is_default`), the unauthenticated-call gap (`has_api_key = 1` with no
 * resolvable secret), the missing terminal outbox reason, and the inertness of
 * the requested `editAndSendAlwaysUseActiveConnection` opt-in.
 *
 * Cases 7a and 9 pass on both trees by design (tasks 1.7 and 1.9): they pin
 * rungs/guarantees rather than reproduce the defect.
 *
 * Credential hygiene (requirement 2.8): the seeded secret is an opaque
 * placeholder, no credential VALUE is ever asserted on or logged, and every
 * credential assertion references the secret KEY NAME only.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ConnectionProfile } from "../types/connection-profile";
import type { StartEditAndSendGenerationInput } from "./edit-and-send-dispatcher.service";

import { closeDatabase, getDb, initDatabase } from "../db/connection";

// Deterministic AES-256 key so the opaque placeholder secret is readable
// without a real identity file on disk.
mock.module("../crypto/init", () => ({
  getEncryptionKeyBytes: () => new Uint8Array(32).fill(7),
}));

const chatsSvc = await import("./chats.service");
const connectionsSvc = await import("./connections.service");
const secretsSvc = await import("./secrets.service");
const settingsSvc = await import("./settings.service");
const chatBackground = await import("./chat-background.service");
const councilProfilesSvc = await import("./council/council-profiles.service");
const pool = await import("./generation-pool.service");
const generateSvc = await import("./generate.service");
const dispatcher = await import("./edit-and-send-dispatcher.service");
const { getProvider } = await import("../llm/registry");
const { eventBus } = await import("../ws/bus");
const { EventType } = await import("../ws/events");

// ── Local widened TYPES (not assertions) ───────────────────────────────────
// The fix adds a second `options` argument to `startGeneration` and a fourth
// `opts` argument to `resolveChatGenerationConnection`. Declaring the widened
// shapes locally lets this file typecheck on BOTH the unfixed and the fixed
// tree without touching production code in this phase.
type StartArgs = Parameters<typeof generateSvc.startGeneration>[0];
type StartWithOrigin = (
  input: StartArgs,
  options?: { origin?: "edit_and_send" },
) => ReturnType<typeof generateSvc.startGeneration>;
const start = generateSvc.startGeneration as unknown as StartWithOrigin;

type ResolveChatConnection = (
  userId: string,
  metadata: Record<string, any> | null | undefined,
  requestedConnectionId?: string,
  opts?: { preferActiveConnection?: boolean },
) => ConnectionProfile;
const resolveChatConnection =
  generateSvc.__test__.resolveChatGenerationConnection as unknown as ResolveChatConnection;
const resolveProviderAndKey = generateSvc.__test__.resolveProviderAndKey;

const USER = "user:evidence";

/** Opaque, obviously-not-a-credential placeholder. Never asserted on. */
const PLACEHOLDER_SECRET = "opaque-placeholder-not-a-credential";

const PROFILE_A = "conn-a-active";
const PROFILE_B = "conn-b-default";
const PROFILE_C = "conn-c-pinned";
const PROFILE_D = "conn-d-declared-key";

const MODEL_A = "local-model-a";
const MODEL_B = "default-model-b";
const MODEL_C = "pinned-profile-model";
const BINDING_MODEL_OVERRIDE = "binding-model-override";

const NO_CONNECTION_MESSAGE =
  "No connection profile found. Configure a default connection or select one for this chat.";

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
  db.run(`CREATE TABLE edit_and_send_requests (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, request_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL, branch_chat_id TEXT NOT NULL, edited_message_id TEXT NOT NULL,
    target_message_id TEXT, target_swipe_index INTEGER, generation_id TEXT NOT NULL, response TEXT NOT NULL,
    cursor TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (user_id, chat_id, request_id)
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
  // Same column sets as `src/db/baseline.sql`, minus the `"user"(id)` foreign
  // keys this focused fixture does not create.
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
  db.query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)").run("char-evidence", USER, "Evidence");
}

interface SeedProfileInput {
  id: string;
  name: string;
  provider?: string;
  api_url?: string;
  model?: string;
  is_default?: boolean;
  has_api_key?: boolean;
  metadata?: Record<string, unknown>;
  userId?: string;
}

function seedProfile(input: SeedProfileInput): void {
  getDb().query(
    `INSERT INTO connection_profiles
       (id, name, provider, api_url, model, preset_id, is_default, metadata, created_at, updated_at, has_api_key, user_id)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.name,
    input.provider ?? "custom",
    input.api_url ?? "http://127.0.0.1:1234/v1",
    input.model ?? `${input.id}-model`,
    input.is_default ? 1 : 0,
    JSON.stringify(input.metadata ?? {}),
    1,
    1,
    input.has_api_key ? 1 : 0,
    input.userId ?? USER,
  );
}

function seedSetting(key: string, value: unknown, userId = USER): void {
  getDb().query(
    `INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), userId, 1);
}

function clearSetting(key: string, userId = USER): void {
  getDb().query("DELETE FROM settings WHERE key = ? AND user_id = ?").run(key, userId);
}

function seedChat(id: string, metadata: Record<string, unknown> = {}): void {
  getDb().query(
    "INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, USER, "char-evidence", id, JSON.stringify(metadata), 1, 1);
}

function seedMessage(id: string, chatId: string, content: string, index: number, isUser: boolean, revision = 1): void {
  getDb().query(`INSERT INTO messages (
    id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra,
    parent_message_id, branch_id, created_at, revision
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    chatId,
    index,
    isUser ? 1 : 0,
    isUser ? "User" : "Assistant",
    content,
    100 + index,
    0,
    JSON.stringify([content]),
    JSON.stringify([100 + index]),
    "{}",
    null,
    null,
    100 + index,
    revision,
  );
}

/**
 * The shared divergence fixture (task 1.2): the user's `activeProfileId` names
 * profile A while `is_default = 1` sits on profile B. That divergence is the
 * whole fixture.
 */
async function seedDivergenceFixture(): Promise<void> {
  seedProfile({ id: PROFILE_A, name: "Local LM Studio", model: MODEL_A, has_api_key: true });
  seedProfile({
    id: PROFILE_B,
    name: "Unrelated Custom Endpoint",
    api_url: "https://unrelated.invalid/v1",
    model: MODEL_B,
    is_default: true,
    has_api_key: false,
  });
  seedSetting("activeProfileId", PROFILE_A);
  // Profile A is the one the user actually selected, so it is the only one
  // holding a credential. Opaque placeholder; never asserted on by value.
  await secretsSvc.putSecret(USER, connectionsSvc.connectionSecretKey(PROFILE_A), PLACEHOLDER_SECRET);
}

/** The case-8 fixture: a live chat binding on profile C with a model override. */
async function seedOptInFixture(chatId: string): Promise<void> {
  seedProfile({ id: PROFILE_C, name: "Pinned Profile", model: MODEL_C, has_api_key: true });
  await secretsSvc.putSecret(USER, connectionsSvc.connectionSecretKey(PROFILE_C), PLACEHOLDER_SECRET);
  seedChat(chatId, {
    temporary: true,
    no_preset: true,
    connection_profile_id: PROFILE_C,
    connection_model: BINDING_MODEL_OVERRIDE,
  });
  seedMessage(`${chatId}-user`, chatId, "please continue", 0, true, 1);
  // Raw JSON only: a backend test must never import a frontend defaults module.
  seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: true });
}

/** The connection id an interactive swipe would send (`useSwipeAction.ts`). */
function interactiveConnectionId(): string | undefined {
  const active = settingsSvc.getSetting(USER, "activeProfileId");
  return (typeof active?.value === "string" && active.value) || undefined;
}

const spies: Array<{ mockRestore: () => void }> = [];
function track<T extends { mockRestore: () => void }>(spy: T): T {
  spies.push(spy);
  return spy;
}

/**
 * Minimum stubbing that lets `startGeneration` reach the connection
 * resolution + pool registration without performing prompt assembly or any
 * outbound call. Nothing about connection or credential resolution is stubbed.
 */
function stubGenerationSurroundings(): void {
  track(spyOn(chatBackground, "abortChatBackground").mockResolvedValue(undefined));
  const resolveProfile = councilProfilesSvc.resolveProfile;
  let profileResolutionCount = 0;
  track(spyOn(councilProfilesSvc, "resolveProfile").mockImplementation((...args) => {
    profileResolutionCount += 1;
    if (profileResolutionCount === 1) return resolveProfile(...args);
    throw new Error("skip-assembly");
  }));
}

beforeEach(async () => {
  initTestDb();
  dispatcher.resetEditAndSendDispatcherForTests();
  await seedDivergenceFixture();
});

afterEach(() => {
  generateSvc.stopAllGenerations();
  pool.clearAllPoolEntries();
  generateSvc.stopGenerationSweep();
  dispatcher.resetEditAndSendDispatcherForTests();
  for (const spy of spies.splice(0)) spy.mockRestore();
  closeDatabase();
});

// ── Case 1 (task 1.3) ──────────────────────────────────────────────────────

describe("Case 1 — identity divergence with no chat binding", () => {
  test("resolves the acting connection, not the is_default profile", () => {
    const resolved = resolveChatConnection(USER, {}, undefined);
    expect({
      resolvedId: resolved.id,
      activeProfileId: settingsSvc.getSetting(USER, "activeProfileId")?.value,
      isDefaultProfileId: connectionsSvc.getDefaultConnection(USER)?.id,
    }).toEqual({
      resolvedId: PROFILE_A,
      activeProfileId: PROFILE_A,
      isDefaultProfileId: PROFILE_B,
    });
  });

  test("scoped domain sweep: active wins for every (profileCount, activeIndex, defaultIndex, mode)", () => {
    // The identity gap is deterministic, so the generated domain is scoped to
    // the concrete failing shapes: activeIndex != defaultIndex, no chat-scoped
    // binding, mode in { normal, swipe }.
    const counterexamples: Array<Record<string, unknown>> = [];
    for (const profileCount of [2, 3, 4]) {
      for (let activeIndex = 0; activeIndex < profileCount; activeIndex++) {
        for (let defaultIndex = 0; defaultIndex < profileCount; defaultIndex++) {
          if (activeIndex === defaultIndex) continue;
          for (const mode of ["normal", "swipe"] as const) {
            initTestDb();
            const ids: string[] = [];
            for (let i = 0; i < profileCount; i++) {
              const id = `sweep-${profileCount}-${i}`;
              ids.push(id);
              seedProfile({
                id,
                name: `Sweep ${i}`,
                model: `sweep-model-${i}`,
                is_default: i === defaultIndex,
                has_api_key: true,
              });
            }
            seedSetting("activeProfileId", ids[activeIndex]);
            const resolved = resolveChatConnection(USER, {}, undefined);
            if (resolved.id !== ids[activeIndex]) {
              counterexamples.push({
                profileCount,
                activeIndex,
                defaultIndex,
                mode,
                expectedActiveId: ids[activeIndex],
                resolvedId: resolved.id,
                resolvedIsDefaultProfile: resolved.id === ids[defaultIndex],
              });
            }
          }
        }
      }
    }
    expect(counterexamples).toEqual([]);
  });
});

// ── Cases 2, 3, 4 (task 1.4) ───────────────────────────────────────────────

interface DispatchCapture {
  input: StartEditAndSendGenerationInput;
  chatMetadata: Record<string, any> | null | undefined;
}

async function captureEditAndSendDispatch(opts: {
  chatId: string;
  historical: boolean;
  branch: boolean;
}): Promise<DispatchCapture> {
  seedChat(opts.chatId);
  seedMessage(`${opts.chatId}-user`, opts.chatId, "original", 0, true, 2);
  if (opts.historical) seedMessage(`${opts.chatId}-assistant`, opts.chatId, "assistant reply", 1, false);

  const result = chatsSvc.editAndSend(USER, opts.chatId, {
    messageId: `${opts.chatId}-user`,
    content: "rewritten",
    expectedVersion: 2,
    requestId: `${opts.chatId}-request`,
    branchChatOnEditAndSend: opts.branch,
  });
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("edit-and-send fixture failed");

  const captured: StartEditAndSendGenerationInput[] = [];
  dispatcher.setEditAndSendStartGeneration(async (input) => {
    captured.push(input);
    return { generationId: input.generationId, status: "streaming" };
  });
  await dispatcher.dispatchEditAndSendRequest(USER, opts.chatId, `${opts.chatId}-request`);
  expect(captured).toHaveLength(1);

  const input = captured[0]!;
  const chat = chatsSvc.getChat(USER, input.chat_id);
  return { input, chatMetadata: chat?.metadata };
}

/** The dispatch payload's field set must not change to fix this defect. */
function expectUnchangedDispatchFieldSet(input: StartEditAndSendGenerationInput): void {
  const expected = input.generation_type === "swipe" && input.message_id
    ? ["chat_id", "generationId", "generation_type", "message_id", "userId"]
    : ["chat_id", "generationId", "generation_type", "userId"];
  expect(Object.keys(input).sort()).toEqual(expected);
}

describe("Case 2 — swipe-mode dispatch parity", () => {
  test("the dispatched swipe resolves the same connection an interactive swipe would", async () => {
    const { input, chatMetadata } = await captureEditAndSendDispatch({
      chatId: "case2",
      historical: true,
      branch: true,
    });
    expect(input.generation_type).toBe("swipe");
    expectUnchangedDispatchFieldSet(input);

    const dispatched = resolveChatConnection(input.userId, chatMetadata, undefined);
    // Interactive baseline exactly as `useSwipeAction.ts` builds it.
    const interactive = resolveChatConnection(USER, chatMetadata, interactiveConnectionId());

    expect({ dispatchedId: dispatched.id, interactiveId: interactive.id }).toEqual({
      dispatchedId: PROFILE_A,
      interactiveId: PROFILE_A,
    });
  });
});

describe("Case 3 — branchChatOnEditAndSend = true", () => {
  for (const historical of [false, true]) {
    test(`branch dispatch resolves the acting connection (${historical ? "swipe" : "normal"} mode)`, async () => {
      const { input, chatMetadata } = await captureEditAndSendDispatch({
        chatId: `case3-${historical ? "swipe" : "normal"}`,
        historical,
        branch: true,
      });
      // The branch chat's copied metadata carries no binding, which is why the
      // divergence is mode-independent.
      expect(chatMetadata?.connection_profile_id).toBeUndefined();
      expectUnchangedDispatchFieldSet(input);

      const dispatched = resolveChatConnection(input.userId, chatMetadata, undefined);
      const interactive = resolveChatConnection(USER, chatMetadata, interactiveConnectionId());
      expect({ dispatchedId: dispatched.id, interactiveId: interactive.id }).toEqual({
        dispatchedId: PROFILE_A,
        interactiveId: PROFILE_A,
      });
    });
  }
});

describe("Case 4 — branchChatOnEditAndSend = false", () => {
  for (const historical of [false, true]) {
    test(`in-place dispatch resolves the acting connection (${historical ? "swipe" : "normal"} mode)`, async () => {
      const chatId = `case4-${historical ? "swipe" : "normal"}`;
      const { input, chatMetadata } = await captureEditAndSendDispatch({
        chatId,
        historical,
        branch: false,
      });
      // In-place: the source chat and the source assistant are the targets.
      expect(input.chat_id).toBe(chatId);
      if (historical) expect(input.message_id).toBe(`${chatId}-assistant`);
      expectUnchangedDispatchFieldSet(input);

      const dispatched = resolveChatConnection(input.userId, chatMetadata, undefined);
      const interactive = resolveChatConnection(USER, chatMetadata, interactiveConnectionId());
      expect({ dispatchedId: dispatched.id, interactiveId: interactive.id }).toEqual({
        dispatchedId: PROFILE_A,
        interactiveId: PROFILE_A,
      });
    });
  }
});

// ── Case 5 (task 1.5) ──────────────────────────────────────────────────────

describe("Case 5 — unauthenticated call on a keyless-capable provider", () => {
  test("a declared-but-missing key fails before any outbound call, naming the secret key", async () => {
    seedProfile({
      id: PROFILE_D,
      name: "Declared Key Without Secret",
      provider: "custom",
      has_api_key: true,
    });
    const secretKeyName = connectionsSvc.connectionSecretKey(PROFILE_D);

    const logs: string[] = [];
    const capture = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    track(spyOn(console, "warn").mockImplementation(capture));
    track(spyOn(console, "error").mockImplementation(capture));
    track(spyOn(console, "log").mockImplementation(capture));

    const outcome = await resolveProviderAndKey(USER, PROFILE_D).then(
      (resolved) => ({ kind: "resolved" as const, apiKeyIsEmpty: resolved.apiKey === "", message: "" }),
      (err: unknown) => ({
        kind: "threw" as const,
        apiKeyIsEmpty: false,
        message: err instanceof Error ? err.message : String(err),
      }),
    );

    // Credential hygiene first: these hold on both trees.
    expect(logs.join("\n")).not.toContain(PLACEHOLDER_SECRET);
    expect(outcome.message).not.toContain(PLACEHOLDER_SECRET);

    // The bug-condition assertion. On the unfixed tree this reports
    // { kind: "resolved", apiKeyIsEmpty: true } — an unauthenticated call.
    expect({ kind: outcome.kind, apiKeyIsEmpty: outcome.apiKeyIsEmpty }).toEqual({
      kind: "threw",
      apiKeyIsEmpty: false,
    });
    expect(outcome.message).toContain(secretKeyName);
    expect(outcome.message).toContain("Declared Key Without Secret");
  });

  test("observation: OpenAI-compatible headers omit Authorization entirely for an empty key", () => {
    // Corrects bugfix.md 1.4 by reading provider code, not by changing it:
    // the defect is "an unauthenticated call is made", not "an empty bearer
    // token is sent".
    const provider = getProvider("custom")!;
    expect(provider.displayName).toBe("Custom (OpenAI-compatible)");
    expect(provider.capabilities.apiKeyRequired).toBe(false);
    const headers = (provider as unknown as { headers(apiKey: string): Record<string, string> }).headers("");
    expect(Object.keys(headers)).not.toContain("Authorization");
  });
});

// ── Case 6 (task 1.6) ──────────────────────────────────────────────────────

/**
 * The fix introduces `ConnectionCredentialError` in `src/utils/provider-errors.ts`.
 * Use the real class when it exists so `instanceof` classification (task 3.10)
 * is exercised after the fix; fall back to an equivalently shaped error on the
 * unfixed tree, where the class does not exist yet.
 */
async function makeCredentialError(connectionId: string, connectionName: string): Promise<Error> {
  const secretKeyName = connectionsSvc.connectionSecretKey(connectionId);
  const mod = (await import("../utils/provider-errors")) as Record<string, any>;
  if (typeof mod.ConnectionCredentialError === "function") {
    return new mod.ConnectionCredentialError({
      connectionId,
      connectionName,
      provider: "Custom (OpenAI-compatible)",
      secretKeyName,
    });
  }
  return Object.assign(
    new Error(
      `Connection "${connectionName}" declares an API key but none could be read from ${secretKeyName}. ` +
        "Re-enter the API key for this connection, or clear it if the endpoint needs none.",
    ),
    {
      name: "ConnectionCredentialError",
      code: "credential_unresolved",
      retryable: false,
      connectionId,
      connectionName,
      provider: "Custom (OpenAI-compatible)",
      secretKeyName,
    },
  );
}

describe("Case 6 — no terminal reason for a credential failure", () => {
  test("a credential rejection is terminal on the outbox row and surfaces once", async () => {
    const chatId = "case6";
    seedChat(chatId);
    seedMessage(`${chatId}-user`, chatId, "original", 0, true, 2);
    const result = chatsSvc.editAndSend(USER, chatId, {
      messageId: `${chatId}-user`,
      content: "rewritten",
      expectedVersion: 2,
      requestId: `${chatId}-request`,
      branchChatOnEditAndSend: false,
    });
    expect(result.status).toBe("ok");

    const credentialError = await makeCredentialError(PROFILE_B, "Unrelated Custom Endpoint");
    dispatcher.setEditAndSendStartGeneration(async () => { throw credentialError; });

    const ended: Array<Record<string, unknown>> = [];
    track(spyOn(eventBus, "emit").mockImplementation(((type: unknown, payload: unknown) => {
      if (type === EventType.GENERATION_ENDED) ended.push(payload as Record<string, unknown>);
    }) as never));

    const claimed = dispatcher.claimNextEditAndSendOutbox();
    expect(claimed).not.toBeNull();
    const row = await dispatcher.dispatchClaimedEditAndSendOutbox(claimed!);

    // One combined assertion so the whole counterexample is recorded in a
    // single diff: the row state, the fact that it is still re-claimable, and
    // the missing user-facing error path.
    expect({
      status: row?.status,
      terminalReason: row?.terminal_reason,
      completedAtSet: row?.completed_at != null,
      nextAttemptAtSet: (row?.next_attempt_at ?? null) != null,
      // Never re-dispatched with the identical credentials.
      reclaimable: dispatcher.claimNextEditAndSendOutbox() !== null,
      // Retry-tick and startup-recovery dispatches get a user-facing error path.
      generationEndedFor: ended.map((payload) => payload.generationId),
    }).toEqual({
      status: "failed",
      terminalReason: "credential_unresolved",
      completedAtSet: true,
      nextAttemptAtSet: false,
      reclaimable: false,
      generationEndedFor: [claimed!.generation_id],
    });
  });
});

// ── Case 7 (task 1.7) ──────────────────────────────────────────────────────

describe("Case 7 — active profile points at a deleted profile", () => {
  test("7a: falls back to the is_default profile (pins the validated-lookup rung)", () => {
    seedSetting("activeProfileId", "conn-deleted-never-existed");
    const resolved = resolveChatConnection(USER, {}, undefined);
    expect(resolved.id).toBe(PROFILE_B);
  });

  test("7b: with no is_default either, resolves any owned profile instead of throwing", () => {
    seedSetting("activeProfileId", "conn-deleted-never-existed");
    getDb().query("UPDATE connection_profiles SET is_default = 0 WHERE user_id = ?").run(USER);

    const outcome = (() => {
      try {
        return { kind: "resolved" as const, id: resolveChatConnection(USER, {}, undefined).id };
      } catch (err) {
        return { kind: "threw" as const, id: err instanceof Error ? err.message : String(err) };
      }
    })();

    expect(outcome.kind).toBe("resolved");
    expect([PROFILE_A, PROFILE_B]).toContain(outcome.id);
  });

  test("7c: still throws the unchanged message when the user owns no profiles at all", () => {
    getDb().query("DELETE FROM connection_profiles WHERE user_id = ?").run(USER);
    expect(() => resolveChatConnection(USER, {}, undefined)).toThrow(NO_CONNECTION_MESSAGE);
  });
});

// ── Case 8 (task 1.8) ──────────────────────────────────────────────────────

describe("Case 8 — the opt-in is inert on a chat that carries a live binding", () => {
  test("Edit-and-Send uses the active profile and drops the binding's model override", async () => {
    const chatId = "case8";
    await seedOptInFixture(chatId);
    stubGenerationSurroundings();

    const generationId = "gen-case8";
    const input: StartArgs = {
      userId: USER,
      chat_id: chatId,
      generationId,
      generation_type: "normal",
    } as StartArgs;

    // Pass the origin the way production will. `start` is a locally widened
    // TYPE over the real `startGeneration`, so this file typechecks on both
    // the unfixed and the fixed tree.
    await start(input, { origin: "edit_and_send" }).catch(() => { /* assembly is stubbed out */ });

    const entry = pool.getPoolEntry(generationId);
    expect({
      resolvedConnectionId: entry?.connectionId,
      resolvedModel: entry?.model,
    }).toEqual({
      resolvedConnectionId: PROFILE_A,
      resolvedModel: MODEL_A,
    });
  });

  test("the same fixture leaves an interactive swipe on the bound profile with its model override", async () => {
    const chatId = "case8-interactive";
    await seedOptInFixture(chatId);
    const metadata = chatsSvc.getChat(USER, chatId)?.metadata;

    // Interactive: `options` omitted, exactly as every interactive call site
    // invokes startGeneration.
    const interactive = resolveChatConnection(USER, metadata, interactiveConnectionId());
    expect({ id: interactive.id, model: interactive.model }).toEqual({
      id: PROFILE_C,
      model: BINDING_MODEL_OVERRIDE,
    });
  });
});

// ── Case 9 (task 1.9) ──────────────────────────────────────────────────────

describe("Case 9 — the origin cannot be forged in band", () => {
  test("body keys that mimic an Edit-and-Send origin do not change resolution", async () => {
    const chatId = "case9";
    await seedOptInFixture(chatId);
    stubGenerationSurroundings();

    const getSettingSpy = track(spyOn(settingsSvc, "getSetting"));

    // Model `chatRoute` in src/routes/generate.routes.ts exactly:
    //   handler({ ...body, userId, signal: c.req.raw.signal, ...extras })
    // ONE argument. A second positional argument is structurally unreachable
    // from body spreading, which is why the origin lives out of band.
    const body: Record<string, unknown> = {
      chat_id: chatId,
      generation_type: "normal",
      origin: "edit_and_send",
      edit_and_send: true,
      options: { origin: "edit_and_send" },
    };
    const input = { ...body, userId: USER, signal: undefined } as unknown as StartArgs;

    await start(input).catch(() => null);

    const entry = pool.getPoolForChat(USER, chatId);
    expect(entry?.connectionId).toBe(PROFILE_C);
    expect(entry?.model).toBe(BINDING_MODEL_OVERRIDE);
    expect(getSettingSpy.mock.calls.map((call) => call[1])).not.toContain("quickToolbarSettings");
  });
});

// ── Fixture self-check (task 1.10, re-derivation candidate 3) ───────────────

describe("Fixture self-check — the seeded configuration matches the user's", () => {
  test("activeProfileId is readable under the real settings read and differs from is_default", () => {
    // Candidate 3 of the task 1.10 re-derivation list: verify the fixture
    // against the real `settings` read before concluding anything about
    // production code.
    expect(settingsSvc.getSetting(USER, "activeProfileId")?.value).toBe(PROFILE_A);
    expect(connectionsSvc.getConnection(USER, PROFILE_A)?.id).toBe(PROFILE_A);
    expect(connectionsSvc.getDefaultConnection(USER)?.id).toBe(PROFILE_B);
    expect(connectionsSvc.getDefaultConnection(USER)?.id).not.toBe(PROFILE_A);
  });

  test("no chat-scoped binding exists on the no-binding cases (candidate 1)", () => {
    seedChat("selfcheck");
    expect(chatsSvc.getChat(USER, "selfcheck")?.metadata?.connection_profile_id).toBeUndefined();
  });

  test("the resolver under test is the one chat generations use (candidate 2)", () => {
    // `quietGenerate` / `summarizeGenerate` resolve via `resolveConnection`
    // with an explicit id; the chat generation path is the only one routed
    // through `resolveChatGenerationConnection`.
    expect(typeof generateSvc.__test__.resolveChatGenerationConnection).toBe("function");
    expect(typeof generateSvc.__test__.resolveProviderAndKey).toBe("function");
  });
});
