/**
 * Task 2 — preservation property tests for the Edit-and-Send 401 fix.
 *
 * Property 2: Preservation — Explicit And Bound Connection Resolution Is
 * Untouched (plus Property 5's keyless / non-credential-retry half and
 * Property 7's OFF-representation half).
 *
 * Methodology: observation-first. Every assertion below records what the
 * UNFIXED code actually does for inputs where `isBugCondition(input) == false`.
 * EVERY case in this file MUST PASS on the unfixed tree; a failure means the
 * case encodes an assumption rather than an observation.
 *
 * Binding authority is asserted here for the setting-OFF/unset case (the
 * default, and what every existing user and suite is in) and unconditionally
 * for every interactive path in either position of the setting. The setting-ON
 * override on Edit-and-Send is Property 6 (task 3.17), not an exception to be
 * asserted away here.
 *
 * Credential hygiene (requirement 2.8): opaque placeholder values only; every
 * credential assertion references the secret KEY NAME.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, mock, test } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import type { ConnectionProfile } from "../types/connection-profile";
import type { StartEditAndSendGenerationInput } from "./edit-and-send-dispatcher.service";

import { closeDatabase, getDb, initDatabase } from "../db/connection";

// Deterministic AES-256 key so the opaque placeholder secrets are readable
// without a real identity file on disk.
mock.module("../crypto/init", () => ({
  getEncryptionKeyBytes: () => new Uint8Array(32).fill(7),
}));

const chatsSvc = await import("./chats.service");
const connectionsSvc = await import("./connections.service");
const secretsSvc = await import("./secrets.service");
const settingsSvc = await import("./settings.service");
const multiplayerSvc = await import("./multiplayer.service");
const generateSvc = await import("./generate.service");
const dispatcher = await import("./edit-and-send-dispatcher.service");
const { getProvider } = await import("../llm/registry");

// ── Local widened TYPE (not an assertion) ──────────────────────────────────
// The fix gives `resolveChatGenerationConnection` a fourth optional `opts`
// argument. Declaring the widened shape locally lets this file typecheck on
// both the unfixed and the fixed tree; on the unfixed tree the extra argument
// is simply ignored, which is exactly the OFF behaviour these cases pin.
type ResolveChatConnection = (
  userId: string,
  metadata: Record<string, any> | null | undefined,
  requestedConnectionId?: string,
  opts?: { preferActiveConnection?: boolean },
) => ConnectionProfile;
const resolveChatConnection =
  generateSvc.__test__.resolveChatGenerationConnection as unknown as ResolveChatConnection;
const resolveProviderAndKey = generateSvc.__test__.resolveProviderAndKey;

const USER = "user:preservation";

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
  db.run(`CREATE TABLE extensions (
    identifier TEXT PRIMARY KEY, enabled INTEGER NOT NULL,
    install_scope TEXT NOT NULL, installed_by_user_id TEXT
  )`);
  db.run("INSERT INTO extensions VALUES ('lumiverse_suite', 1, 'operator', NULL)");
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
  db.query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)").run("char-p", USER, "Preservation");
}

interface SeedProfileInput {
  id: string;
  name?: string;
  provider?: string;
  api_url?: string;
  model?: string;
  is_default?: boolean;
  has_api_key?: boolean;
  metadata?: Record<string, unknown>;
}

function seedProfile(input: SeedProfileInput): void {
  getDb().query(
    `INSERT INTO connection_profiles
       (id, name, provider, api_url, model, preset_id, is_default, metadata, created_at, updated_at, has_api_key, user_id)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.name ?? `Profile ${input.id}`,
    input.provider ?? "custom",
    input.api_url ?? "http://127.0.0.1:1234/v1",
    input.model ?? `${input.id}-model`,
    input.is_default ? 1 : 0,
    JSON.stringify(input.metadata ?? {}),
    1,
    1,
    input.has_api_key ? 1 : 0,
    USER,
  );
}

function seedSetting(key: string, value: unknown): void {
  getDb().query(
    `INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), USER, 1);
}

function clearSetting(key: string): void {
  getDb().query("DELETE FROM settings WHERE key = ? AND user_id = ?").run(key, USER);
}

function seedChat(id: string, metadata: Record<string, unknown> = {}): void {
  getDb().query(
    "INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, USER, "char-p", id, JSON.stringify(metadata), 1, 1);
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
 * The strict dispatch-time read the design prescribes (`=== true`, canonical
 * `quickToolbarSettings` row only). Test-local on purpose: the production
 * helper lands in task 3.6, and a backend test must never import a frontend
 * defaults module.
 */
function readAlwaysUseActiveConnection(userId: string): boolean {
  const value = settingsSvc.getSetting(userId, "quickToolbarSettings")?.value;
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).editAndSendAlwaysUseActiveConnection === true;
}

/** Generated profile-set domain: sizes crossed with active/default placement. */
interface ProfileSetShape {
  profileCount: number;
  activeIndex: number | "unset";
  defaultIndex: number | "none";
}

function profileSetDomain(): ProfileSetShape[] {
  const shapes: ProfileSetShape[] = [];
  for (const profileCount of [1, 2, 3]) {
    for (const activeIndex of [...Array(profileCount).keys(), "unset" as const]) {
      for (const defaultIndex of [...Array(profileCount).keys(), "none" as const]) {
        shapes.push({ profileCount, activeIndex, defaultIndex });
      }
    }
  }
  return shapes;
}

function seedProfileSet(shape: ProfileSetShape): string[] {
  const ids: string[] = [];
  for (let i = 0; i < shape.profileCount; i++) {
    const id = `p${shape.profileCount}-${i}`;
    ids.push(id);
    seedProfile({ id, model: `model-${id}`, is_default: shape.defaultIndex === i, has_api_key: true });
  }
  if (shape.activeIndex !== "unset") seedSetting("activeProfileId", ids[shape.activeIndex]);
  else clearSetting("activeProfileId");
  return ids;
}

function resolveOutcome(fn: () => ConnectionProfile): { id: string; model: string } | { threw: string } {
  try {
    const profile = fn();
    return { id: profile.id, model: profile.model };
  } catch (err) {
    return { threw: err instanceof Error ? err.message : String(err) };
  }
}

beforeEach(() => {
  initTestDb();
  dispatcher.resetEditAndSendDispatcherForTests();
});

afterEach(() => {
  dispatcher.resetEditAndSendDispatcherForTests();
  closeDatabase();
});

// ── Case 1 (task 2.1) — explicit `connection_id` precedence ────────────────

describe("Case 1 — explicit connection_id precedence", () => {
  test("a supplied non-empty id always wins over active and default", () => {
    const counterexamples: Array<Record<string, unknown>> = [];
    for (const shape of profileSetDomain()) {
      initTestDb();
      const ids = seedProfileSet(shape);
      for (const explicitId of ids) {
        const resolved = resolveOutcome(() => resolveChatConnection(USER, {}, explicitId));
        if (!("id" in resolved) || resolved.id !== explicitId) {
          counterexamples.push({ ...shape, explicitId, resolved });
        }
      }
    }
    expect(counterexamples).toEqual([]);
  });

  test("a supplied-but-stale id still throws the original message byte-for-byte", () => {
    const counterexamples: Array<Record<string, unknown>> = [];
    for (const shape of profileSetDomain()) {
      initTestDb();
      seedProfileSet(shape);
      const resolved = resolveOutcome(() => resolveChatConnection(USER, {}, "conn-never-existed"));
      if (!("threw" in resolved) || resolved.threw !== NO_CONNECTION_MESSAGE) {
        counterexamples.push({ ...shape, resolved });
      }
    }
    expect(counterexamples).toEqual([]);
  });

  test("an empty-string id is treated as no id supplied", () => {
    // RE-SCOPED (task 3.21). This case originally asserted the PRE-FIX outcome
    // `explicit-default`, but that input — no binding, no requested id,
    // `activeProfileId` naming a live non-`is_default` profile — is precisely
    // `isBugCondition == true`, so it did not belong in a Property 2 file. The
    // invariant this case was written to test is the one in its own comment:
    // an empty string FALLS THROUGH, i.e. it is treated as "no id supplied".
    // That is what task 3.4's `trim() || undefined` guarantees, and it is
    // asserted here by equivalence to the `undefined` call rather than by a
    // hardcoded pre-fix profile id. Post-fix, falling through reaches the
    // acting connection.
    seedProfile({ id: "explicit-active", model: "model-active", has_api_key: true });
    seedProfile({ id: "explicit-default", model: "model-default", is_default: true });
    seedSetting("activeProfileId", "explicit-active");
    const suppliedEmpty = resolveOutcome(() => resolveChatConnection(USER, {}, ""));
    const suppliedNothing = resolveOutcome(() => resolveChatConnection(USER, {}, undefined));
    expect(suppliedEmpty).toEqual(suppliedNothing);
    expect(suppliedEmpty).toEqual({ id: "explicit-active", model: "model-active" });
  });

  test("a whitespace-only id never silently retargets to a third profile", () => {
    // OBSERVED, not assumed: today `"   "` is truthy, so `resolveConnection`
    // looks it up as a profile id, finds nothing, and throws. Task 3.4's
    // `trim() || undefined` normalization deliberately moves this input onto
    // the fall-through rung instead, so the preserved guarantee is the one that
    // holds on BOTH trees: it either falls through to the profile a
    // server-triggered generation would use, or throws the unchanged message —
    // never a different, unrelated profile.
    seedProfile({ id: "ws-active", model: "model-active", has_api_key: true });
    seedProfile({ id: "ws-default", model: "model-default", is_default: true });
    seedProfile({ id: "ws-other", model: "model-other" });
    seedSetting("activeProfileId", "ws-active");

    const outcome = resolveOutcome(() => resolveChatConnection(USER, {}, "   "));
    if ("threw" in outcome) {
      expect(outcome.threw).toBe(NO_CONNECTION_MESSAGE);
    } else {
      expect(["ws-active", "ws-default"]).toContain(outcome.id);
    }
  });
});

// ── Case 2 (task 2.2) — bound-chat authority, all OFF representations ──────

/** Every absent/false representation of the new setting. All mean OFF. */
const OFF_REPRESENTATIONS: Array<{ label: string; seed: () => void }> = [
  { label: "(a) no quickToolbarSettings row at all", seed: () => clearSetting("quickToolbarSettings") },
  { label: "(b) row present without the key", seed: () => seedSetting("quickToolbarSettings", { editAndSendSide: "left" }) },
  { label: "(c) key set to false", seed: () => seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: false }) },
  { label: "(d1) key set to null", seed: () => seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: null }) },
  { label: "(d2) row value is a scalar", seed: () => seedSetting("quickToolbarSettings", "not-an-object") },
  { label: "(d3) row value is an array", seed: () => seedSetting("quickToolbarSettings", [{ editAndSendAlwaysUseActiveConnection: true }]) },
];

describe("Case 2 — bound-chat authority with connection_model, for all OFF representations", () => {
  for (const representation of OFF_REPRESENTATIONS) {
    test(`${representation.label} resolves identically to today`, () => {
      seedProfile({ id: "bound", model: "model-bound", has_api_key: true });
      seedProfile({ id: "active", model: "model-active", has_api_key: true });
      seedProfile({ id: "default", model: "model-default", is_default: true });
      seedSetting("activeProfileId", "active");
      representation.seed();

      // The dispatch-time decision every OFF representation must produce.
      const prefer = readAlwaysUseActiveConnection(USER);
      expect(prefer).toBe(false);
      const opts = { preferActiveConnection: prefer };

      // A live binding beats both active and default.
      expect(resolveOutcome(() => resolveChatConnection(USER, { connection_profile_id: "bound" }, undefined, opts)))
        .toEqual({ id: "bound", model: "model-bound" });

      // connection_model still overrides the bound profile's model.
      expect(resolveOutcome(() => resolveChatConnection(
        USER,
        { connection_profile_id: "bound", connection_model: BINDING_MODEL_OVERRIDE },
        undefined,
        opts,
      ))).toEqual({ id: "bound", model: BINDING_MODEL_OVERRIDE });

      // ...and only for bound profiles (the existing
      // `boundConnection && metadata.connection_model` gate).
      //
      // RE-SCOPED (task 3.21). The resolved ID here was originally the pre-fix
      // `default`, but this input — no live binding, no requested id,
      // `activeProfileId` naming a live non-`is_default` profile — is exactly
      // `isBugCondition == true`, so the id half did not belong in a Property 2
      // file. The invariant actually under test is the `connection_model` GATE,
      // which is orthogonal to which profile gets resolved: with no live
      // binding, a `connection_model` in metadata must NOT be applied. That is
      // asserted unchanged below — the resolved profile keeps its OWN model and
      // never takes the override. Only the resolved id moved, to the acting
      // connection.
      const unboundOverride = resolveOutcome(() => resolveChatConnection(
        USER,
        { connection_model: BINDING_MODEL_OVERRIDE },
        undefined,
        opts,
      ));
      expect(unboundOverride).toEqual({ id: "active", model: "model-active" });
      expect(unboundOverride).not.toEqual({ id: "active", model: BINDING_MODEL_OVERRIDE });

      // A deleted bound profile falls back instead of bricking the chat, and
      // takes no model override with it.
      //
      // RE-SCOPED (task 3.21), same reason: falling back to the acting
      // connection satisfies "does not brick the chat, and carries no model
      // override" just as fully as the pre-fix `default` did, and the pre-fix
      // id was a bug-condition outcome. Assert it resolves without throwing,
      // with the resolved profile's OWN model, never the binding's override.
      const deletedBinding = resolveOutcome(() => resolveChatConnection(
        USER,
        { connection_profile_id: "conn-deleted", connection_model: BINDING_MODEL_OVERRIDE },
        undefined,
        opts,
      ));
      expect(deletedBinding).toEqual({ id: "active", model: "model-active" });
      expect(deletedBinding).not.toHaveProperty("threw");
      expect(deletedBinding).not.toEqual({ id: "active", model: BINDING_MODEL_OVERRIDE });

      // An explicit caller-supplied id still loses to a live binding.
      expect(resolveOutcome(() => resolveChatConnection(
        USER,
        { connection_profile_id: "bound" },
        "active",
        opts,
      ))).toEqual({ id: "bound", model: "model-bound" });
    });
  }
});

// ── Case 2a (task 2.3) — interactive-path invariance, BOTH positions ───────

describe("Case 2a — interactive paths are invariant under both toggle positions", () => {
  const positions: Array<{ label: string; seed: () => void }> = [
    { label: "setting off", seed: () => clearSetting("quickToolbarSettings") },
    { label: "setting on", seed: () => seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: true }) },
  ];

  function interactiveResolutions(): Record<string, unknown> {
    const active = settingsSvc.getSetting(USER, "activeProfileId");
    const activeId = (typeof active?.value === "string" && active.value) || undefined;
    const boundMetadata = { connection_profile_id: "bound", connection_model: BINDING_MODEL_OVERRIDE };
    return {
      // swipe / regenerate / continue / normal send: the UI sends
      // `connection_id: activeProfileId || undefined`, and `chatRoute` calls
      // the handler with exactly ONE argument, so `options` is omitted.
      swipeUnbound: resolveOutcome(() => resolveChatConnection(USER, {}, activeId)),
      swipeBound: resolveOutcome(() => resolveChatConnection(USER, boundMetadata, activeId)),
      regenerateBound: resolveOutcome(() => resolveChatConnection(USER, boundMetadata, activeId)),
      continueBound: resolveOutcome(() => resolveChatConnection(USER, boundMetadata, activeId)),
      // RENAMED + RE-SCOPED (task 3.21). The old key `normalSendNoActive` was
      // misnamed: the fixture DOES seed `activeProfileId`, so this models "a
      // send that supplies no explicit `connection_id`", not "no active
      // profile". Its recorded baseline was the pre-fix `default`, which is a
      // bug-condition outcome; post-fix a send with no explicit id reaches the
      // acting connection. The load-bearing assertion in this test is the
      // toggle-position invariance below, and that is untouched.
      sendWithoutExplicitId: resolveOutcome(() => resolveChatConnection(USER, {}, undefined)),
      // dry run resolves the same way and can never express an origin.
      dryRunBound: resolveOutcome(() => resolveChatConnection(USER, boundMetadata, activeId)),
      // multiplayer host generation.
      hostConnectionId: multiplayerSvc.resolveHostConnectionId(USER),
    };
  }

  test("resolution is bit-identical with the setting on and off, binding included", () => {
    const observed: Record<string, unknown>[] = [];
    for (const position of positions) {
      initTestDb();
      seedProfile({ id: "bound", model: "model-bound", has_api_key: true });
      seedProfile({ id: "active", model: "model-active", has_api_key: true });
      seedProfile({ id: "default", model: "model-default", is_default: true });
      seedSetting("activeProfileId", "active");
      position.seed();
      observed.push(interactiveResolutions());
    }
    expect(observed[1]).toEqual(observed[0]!);
    // The observed baseline itself, recorded so task 3.21 compares against a
    // real observation rather than a restatement of the assertion.
    expect(observed[0]).toEqual({
      swipeUnbound: { id: "active", model: "model-active" },
      swipeBound: { id: "bound", model: BINDING_MODEL_OVERRIDE },
      regenerateBound: { id: "bound", model: BINDING_MODEL_OVERRIDE },
      continueBound: { id: "bound", model: BINDING_MODEL_OVERRIDE },
      sendWithoutExplicitId: { id: "active", model: "model-active" },
      dryRunBound: { id: "bound", model: BINDING_MODEL_OVERRIDE },
      hostConnectionId: "active",
    });
  });

  test("dryRunGeneration accepts a preparation callback but not an Edit-and-Send origin", () => {
    type DryRunArguments = Parameters<typeof generateSvc.dryRunGeneration>;
    // The optional callback must not admit the trusted options bag accepted
    // by startGeneration, nor may origin become a client-controlled input.
    expectTypeOf<NonNullable<DryRunArguments[1]>>().toBeFunction();
    expectTypeOf<{ origin: "edit_and_send" }>().not.toMatchTypeOf<DryRunArguments[1]>();
    expectTypeOf<"origin">().not.toMatchTypeOf<keyof DryRunArguments[0]>();
  });
});

// ── Case 3 (task 2.4) — dispatch-payload field-for-field identity ──────────

describe("Case 3 — the dispatch payload keeps exactly its current field set", () => {
  for (const branch of [false, true]) {
    for (const historical of [false, true]) {
      test(`branch=${branch}, ${historical ? "historical" : "tail"} target`, async () => {
        seedProfile({ id: "only", model: "model-only", is_default: true, has_api_key: true });
        const chatId = `payload-${branch ? "branch" : "inplace"}-${historical ? "hist" : "tail"}`;
        const requestId = `${chatId}-request`;
        seedChat(chatId);
        seedMessage(`${chatId}-user`, chatId, "original", 0, true, 2);
        if (historical) seedMessage(`${chatId}-assistant`, chatId, "assistant reply", 1, false);

        const sourceMessagesBefore = getDb()
          .query("SELECT * FROM messages WHERE chat_id = ? ORDER BY index_in_chat")
          .all(chatId) as Array<Record<string, unknown>>;

        const result = chatsSvc.editAndSend(USER, chatId, {
          messageId: `${chatId}-user`,
          content: "rewritten",
          expectedVersion: 2,
          requestId,
          branchChatOnEditAndSend: branch,
        });
        expect(result.status).toBe("ok");
        if (result.status !== "ok") return;

        const captured: StartEditAndSendGenerationInput[] = [];
        dispatcher.setEditAndSendStartGeneration(async (input) => {
          captured.push(input);
          return { generationId: input.generationId, status: "streaming" };
        });
        await dispatcher.dispatchEditAndSendRequest(USER, chatId, requestId);

        const targetChatId = branch ? result.payload.branchChatId : chatId;
        const generationId = result.payload.generationCursor.generationId;
        const expectedTargetMessageId = branch
          ? result.payload.immediateAssistantId
          : (historical ? `${chatId}-assistant` : null);

        // Field-for-field identity, including the conditional `message_id`
        // present ONLY for swipe mode with a target message. The origin signal
        // added in task 3.11 travels as a SECOND ARGUMENT, never as a payload
        // field — this assertion is the standing guard for that decision.
        expect(captured).toEqual([
          historical
            ? {
                userId: USER,
                chat_id: targetChatId,
                generationId,
                generation_type: "swipe",
                message_id: expectedTargetMessageId as string,
              }
            : {
                userId: USER,
                chat_id: targetChatId,
                generationId,
                generation_type: "normal",
              },
        ]);

        // The outbox lookup key stays (user_id, chat_id, request_id).
        expect(dispatcher.getGenerationOutboxByRequest(USER, chatId, requestId)).not.toBeNull();
        expect(dispatcher.getGenerationOutboxByRequest("user:other", chatId, requestId)).toBeNull();
        expect(dispatcher.getGenerationOutboxByRequest(USER, "wrong-chat", requestId)).toBeNull();
        expect(dispatcher.getGenerationOutboxByRequest(USER, chatId, "wrong-request")).toBeNull();

        // The fingerprint / idempotent replay payload is unchanged.
        const replay = chatsSvc.editAndSend(USER, chatId, {
          messageId: `${chatId}-user`,
          content: "rewritten",
          expectedVersion: 2,
          requestId,
          branchChatOnEditAndSend: branch,
        });
        expect(replay).toEqual({ status: "ok", replayed: true, payload: result.payload });
        expect(getDb().query("SELECT COUNT(*) AS count FROM generation_outbox").get()).toEqual({ count: 1 });
        expect(captured).toHaveLength(1);

        if (branch) {
          // Branch mode leaves the source chat and its messages untouched.
          expect(targetChatId).not.toBe(chatId);
          expect(
            getDb().query("SELECT * FROM messages WHERE chat_id = ? ORDER BY index_in_chat").all(chatId),
          ).toEqual(sourceMessagesBefore);
        } else {
          // In-place mode targets the source chat, source edited message and
          // source assistant.
          expect(targetChatId).toBe(chatId);
          expect(result.payload.editedMessageId).toBe(`${chatId}-user`);
          expect(chatsSvc.getMessage(USER, `${chatId}-user`)?.content).toBe("rewritten");
          if (historical) expect(captured[0]!.message_id).toBe(`${chatId}-assistant`);
        }
      });
    }
  }
});

// ── Case 4 (task 2.5) — keyless endpoints and required-key wording ─────────

describe("Case 4 — keyless endpoints and the required-key error wording", () => {
  test("has_api_key = 0 on a keyless-capable provider still resolves an empty key and proceeds", async () => {
    seedProfile({ id: "keyless", name: "Keyless Local", provider: "custom", has_api_key: false });
    const resolved = await resolveProviderAndKey(USER, "keyless");
    expect(resolved.apiKey).toBe("");
    expect(resolved.provider.capabilities.apiKeyRequired).toBe(false);
    const headers = (resolved.provider as unknown as { headers(apiKey: string): Record<string, string> })
      .headers(resolved.apiKey);
    expect(Object.keys(headers)).not.toContain("Authorization");
  });

  test("apiKeyRequired: true with no stored key still throws the original text", async () => {
    seedProfile({ id: "needs-key", name: "Needs A Key", provider: "openai", has_api_key: false });
    const outcome = await resolveProviderAndKey(USER, "needs-key").then(
      () => ({ threw: null as string | null }),
      (err: unknown) => ({ threw: err instanceof Error ? err.message : String(err) }),
    );
    expect(outcome.threw).toBe(
      'No API key found for connection "Needs A Key". Add one via the connection settings.',
    );
  });

  test("an unreadable secret on a key-requiring provider still raises the descriptive decryption error", async () => {
    seedProfile({ id: "unreadable", name: "Unreadable Key", provider: "openai", has_api_key: true });
    const secretKeyName = connectionsSvc.connectionSecretKey("unreadable");
    // Structurally valid but undecryptable ciphertext. No credential value.
    getDb().query(
      "INSERT INTO secrets (key, encrypted_value, iv, tag, user_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      secretKeyName,
      Buffer.alloc(8).toString("base64"),
      Buffer.alloc(12).toString("base64"),
      Buffer.alloc(16).toString("base64"),
      USER,
      1,
    );

    const outcome = await resolveProviderAndKey(USER, "unreadable").then(
      () => ({ threw: null as string | null }),
      (err: unknown) => ({ threw: err instanceof Error ? err.message : String(err) }),
    );
    expect(outcome.threw).toBe(
      `Stored credential "${secretKeyName}" cannot be decrypted. Restore the matching identity file or replace the credential in Settings.`,
    );
  });

  test("a readable stored key resolves without exposing its value", async () => {
    seedProfile({ id: "keyed", name: "Keyed", provider: "openai", has_api_key: true });
    const secretKeyName = connectionsSvc.connectionSecretKey("keyed");
    await secretsSvc.putSecret(USER, secretKeyName, PLACEHOLDER_SECRET);
    const resolved = await resolveProviderAndKey(USER, "keyed");
    expect(resolved.apiKey.length).toBeGreaterThan(0);
    expect(resolved.connection.id).toBe("keyed");
    expect(secretKeyName).toBe("connection_keyed_api_key");
  });
});

// ── Case 5 (task 2.6) — non-credential retry, backoff and max_attempts ────

const MAX_ATTEMPTS = 8;


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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    (overrides.request_id as SQLQueryBindings) ?? `req-${id}`,
    (overrides.user_id as SQLQueryBindings) ?? USER,
    (overrides.chat_id as SQLQueryBindings) ?? "retry-chat",
    (overrides.branch_chat_id as SQLQueryBindings) ?? "retry-chat",
    (overrides.edited_message_id as SQLQueryBindings) ?? "retry-user",
    (overrides.target_message_id as SQLQueryBindings | null) ?? null,
    (overrides.target_swipe_index as SQLQueryBindings | null) ?? null,
    (overrides.expected_version as SQLQueryBindings) ?? 1,
    (overrides.generation_id as SQLQueryBindings) ?? `gen-${id}`,
    (overrides.mode as SQLQueryBindings) ?? "normal",
    (overrides.status as SQLQueryBindings) ?? "pending",
    (overrides.lease_owner as SQLQueryBindings | null) ?? null,
    (overrides.lease_expires_at as SQLQueryBindings | null) ?? null,
    (overrides.attempt_count as SQLQueryBindings) ?? 0,
    (overrides.next_attempt_at as SQLQueryBindings | null) ?? null,
    (overrides.last_error_code as SQLQueryBindings | null) ?? null,
    (overrides.terminal_reason as SQLQueryBindings | null) ?? null,
    (overrides.dispatched_at as SQLQueryBindings | null) ?? null,
    (overrides.completed_at as SQLQueryBindings | null) ?? null,
    (overrides.cancelled_at as SQLQueryBindings | null) ?? null,
    (overrides.created_at as SQLQueryBindings) ?? now,
    (overrides.updated_at as SQLQueryBindings) ?? now,
  );
  return id;
}

/**
 * Seed the durable request cursor the dispatcher validates before dispatch, so
 * a manually-inserted outbox row reaches `startGeneration` instead of failing
 * closed on a missing context. The cursor is shaped exactly like the production
 * write (generation cursor + committed edit identity) and is keyed to the row
 * it belongs to: same user, source chat, request id, branch chat, edited user
 * id and generation id, so `readCommittedEditAndSendContext` accepts it.
 */
function insertRequestCursor(overrides: {
  user_id?: string;
  chat_id?: string;
  branch_chat_id?: string;
  request_id: string;
  edited_message_id?: string;
  generation_id?: string;
  committed_revision?: number;
}): void {
  const userId = overrides.user_id ?? USER;
  const chatId = overrides.chat_id ?? "retry-chat";
  const branchChatId = overrides.branch_chat_id ?? "retry-chat";
  const editedMessageId = overrides.edited_message_id ?? "retry-user";
  const generationId = overrides.generation_id ?? `gen-${overrides.request_id}`;
  const cursor = {
    generationId,
    chatId: branchChatId,
    requestId: overrides.request_id,
    mode: "normal",
    editAndSendContext: {
      editedUserMessageId: editedMessageId,
      committedRevision: overrides.committed_revision ?? 1,
    },
  };
  const now = Date.now();
  getDb().query(
    `INSERT INTO edit_and_send_requests (
      id, user_id, chat_id, request_id, request_fingerprint, branch_chat_id,
      edited_message_id, target_message_id, target_swipe_index, generation_id,
      response, cursor, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    userId,
    chatId,
    overrides.request_id,
    "fp",
    branchChatId,
    editedMessageId,
    null,
    null,
    generationId,
    "{}",
    JSON.stringify(cursor),
    now,
    now,
  );
}

describe("Case 5 — dispatch failures never replay a generation", () => {
  test("generic failures are terminal after one attempt", async () => {
    let calls = 0;
    dispatcher.setEditAndSendStartGeneration(async () => {
      calls++;
      throw new Error("provider_down");
    });
    const id = insertOutbox({ id: "failure" });
    insertRequestCursor({ request_id: "req-failure", generation_id: "gen-failure" });
    const claimed = dispatcher.claimNextEditAndSendOutbox();
    const row = await dispatcher.dispatchClaimedEditAndSendOutbox(claimed!);
    expect(row).toMatchObject({
      status: "failed", last_error_code: "provider_down",
      terminal_reason: "dispatch_failed", attempt_count: 1,
      next_attempt_at: null, lease_owner: null, lease_expires_at: null,
    });
    expect(row?.completed_at).toBeNumber();
    await dispatcher.recoverEditAndSendOutbox();
    await dispatcher.dispatchPendingEditAndSendOutbox();
    expect(calls).toBe(1);
    expect(dispatcher.getGenerationOutboxById(id)?.status).toBe("failed");
  });

  test("legacy pending retries and interrupted claims are never dispatched", async () => {
    const calls: string[] = [];
    dispatcher.setEditAndSendStartGeneration(async (input) => {
      calls.push(input.generationId);
      return { generationId: input.generationId, status: "streaming" };
    });
    for (let attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
      insertOutbox({ id: `legacy-${attempts}`, attempt_count: attempts });
    }
    insertOutbox({
      id: "interrupted-claim", status: "claimed", attempt_count: 1,
      lease_owner: "dead-worker", lease_expires_at: Date.now() - 5_000,
    });
    insertOutbox({
      id: "interrupted-running", status: "running", attempt_count: 1,
      branch_chat_id: "orphan-chat", dispatched_at: Date.now() - 1_000,
    });
    expect(await dispatcher.recoverEditAndSendOutbox()).toBe(0);
    expect(calls).toEqual([]);
    for (const id of ["legacy-1", "legacy-8", "interrupted-claim", "interrupted-running"]) {
      expect(dispatcher.getGenerationOutboxById(id)?.status).toBe("failed");
      expect(dispatcher.getGenerationOutboxById(id)?.next_attempt_at).toBeNull();
    }
  });
});

// ── Case 6 (task 2.7) — multiplayer host + preset/persona/roulette ─────────

describe("Case 6 — multiplayer host resolution and active selection resolution", () => {
  test("resolveHostConnectionId is identical across all five rungs of the chain", () => {
    // 1. Valid active id.
    initTestDb();
    seedProfile({ id: "host-active" });
    seedProfile({ id: "host-default", is_default: true });
    seedSetting("activeProfileId", "host-active");
    expect(multiplayerSvc.resolveHostConnectionId(USER)).toBe("host-active");

    // 2. Active id naming a deleted profile → the default.
    seedSetting("activeProfileId", "host-deleted");
    expect(multiplayerSvc.resolveHostConnectionId(USER)).toBe("host-default");

    // 3. No active setting, default present → the default.
    clearSetting("activeProfileId");
    expect(multiplayerSvc.resolveHostConnectionId(USER)).toBe("host-default");

    // 4. Neither, one owned profile → that profile.
    initTestDb();
    seedProfile({ id: "host-only" });
    expect(multiplayerSvc.resolveHostConnectionId(USER)).toBe("host-only");

    // 5. No profiles at all → undefined.
    initTestDb();
    expect(multiplayerSvc.resolveHostConnectionId(USER)).toBeUndefined();
  });

  test("model-roulette resolution is untouched", () => {
    seedProfile({ id: "roulette-a", model: "model-a" });
    seedProfile({ id: "roulette-b", model: "model-b" });
    seedProfile({
      id: "roulette",
      provider: connectionsSvc.MODEL_ROULETTE_PROVIDER,
      name: "Roulette",
      is_default: true,
      metadata: { connection_roulette: { connection_ids: ["roulette-a", "roulette-b"] } },
    });

    for (let i = 0; i < 12; i++) {
      const resolved = connectionsSvc.resolveConnection(USER, "roulette");
      expect(["roulette-a", "roulette-b"]).toContain(resolved?.id ?? "");
    }

    seedProfile({
      id: "roulette-empty",
      provider: connectionsSvc.MODEL_ROULETTE_PROVIDER,
      name: "Empty Roulette",
      metadata: { connection_roulette: { connection_ids: [] } },
    });
    expect(() => connectionsSvc.resolveConnection(USER, "roulette-empty"))
      .toThrow('Model roulette "Empty Roulette" has no available connection profiles.');
  });

  test("no-preset chat metadata does not change connection resolution", () => {
    seedProfile({ id: "np-active", model: "model-np-active", has_api_key: true });
    seedProfile({ id: "np-default", model: "model-np-default", is_default: true });
    seedSetting("activeProfileId", "np-active");
    expect(resolveOutcome(() => resolveChatConnection(USER, { no_preset: true, temporary: true }, "np-active")))
      .toEqual(resolveOutcome(() => resolveChatConnection(USER, {}, "np-active")));
  });

  test("active-preset and active-persona settings rows are left byte-for-byte intact", () => {
    seedProfile({ id: "sel-active", has_api_key: true });
    seedProfile({ id: "sel-default", is_default: true });
    seedSetting("activeProfileId", "sel-active");
    seedSetting("activePersonaId", "persona-42");
    seedSetting("activeLoomPresetId", "preset-7");

    const before = getDb().query("SELECT key, value, user_id FROM settings ORDER BY key").all();

    resolveChatConnection(USER, {}, undefined);
    resolveChatConnection(USER, { connection_profile_id: "sel-default" }, "sel-active");
    multiplayerSvc.resolveHostConnectionId(USER);

    expect(getDb().query("SELECT key, value, user_id FROM settings ORDER BY key").all()).toEqual(before);
    expect(settingsSvc.getSetting(USER, "activePersonaId")?.value).toBe("persona-42");
    expect(settingsSvc.getSetting(USER, "activeLoomPresetId")?.value).toBe("preset-7");
  });
});

// ── Case 7 (task 2.8) — active profile equals default ─────────────────────

describe("Case 7 — active profile equals the default profile", () => {
  test("resolution is bit-identical for every profile-set size", () => {
    const observed: Array<Record<string, unknown>> = [];
    for (const profileCount of [1, 2, 3, 4]) {
      for (let index = 0; index < profileCount; index++) {
        initTestDb();
        const ids: string[] = [];
        for (let i = 0; i < profileCount; i++) {
          const id = `eq-${profileCount}-${i}`;
          ids.push(id);
          seedProfile({ id, model: `model-${id}`, is_default: i === index, has_api_key: true });
        }
        // activeProfileId IS the is_default profile — the common case.
        seedSetting("activeProfileId", ids[index]);

        observed.push({
          profileCount,
          index,
          serverTriggered: resolveOutcome(() => resolveChatConnection(USER, {}, undefined)),
          interactive: resolveOutcome(() => resolveChatConnection(USER, {}, ids[index])),
          bound: resolveOutcome(() => resolveChatConnection(USER, { connection_profile_id: ids[0] }, undefined)),
        });
      }
    }

    // The server-triggered and interactive resolutions agree here, which is why
    // the fix is a no-op for the majority of users.
    const divergent = observed.filter((row) => {
      const server = row.serverTriggered as { id?: string };
      const interactive = row.interactive as { id?: string };
      return server.id !== interactive.id;
    });
    expect(divergent).toEqual([]);
  });
});
