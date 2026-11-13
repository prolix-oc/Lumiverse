/**
 * Durable connection identity for Edit-and-Send — the COMMIT half.
 *
 * The finding: "Edit-and-Send does not durably preserve connection identity. The
 * outbox stores no connection_id; active connection/settings are reread during
 * dispatch, retry, or recovery. Switching profiles can therefore change an
 * already-committed request."
 *
 * `edit-and-send-active-connection-optin.integration.test.ts` covers the DISPATCH
 * half end to end (POST handler, retry tick, startup recovery, NULL legacy rows,
 * deleted committed profiles). This suite covers what that one cannot:
 *
 *   - `editAndSend` persists a NON-NULL `generation_outbox.connection_id`, and it
 *     is exactly what `connections.service.resolveEditAndSendConnectionId` returns
 *     for the same (user, chat metadata) — asserted against the real function, so
 *     the two cannot drift into agreeing by coincidence;
 *   - a multi-tenant matrix: two distinct user scopes with disjoint profile sets
 *     record their OWN connection, and churning one tenant's live state cannot
 *     move the other tenant's committed row;
 *   - the dispatch INPUT field set is unchanged, so the override is unforgeable
 *     in band. `chatRoute` in `src/routes/generate.routes.ts` builds service input
 *     as `handler({ ...body, userId, signal, ...extras })`, so any in-band field
 *     is client-settable on `POST /generate`, `/regenerate` and `/continue`. The
 *     committed connection therefore travels ONLY in the second-positional-
 *     argument options bag, which body spreading cannot reach.
 *
 * Every case here fails on a tree without `generation_outbox.connection_id`:
 * there is nothing to persist and nothing to forward.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { closeDatabase, getDb, initDatabase } from "../db/connection";

const chatsSvc = await import("./chats.service");
const connectionsSvc = await import("./connections.service");
const settingsSvc = await import("./settings.service");
const dispatcher = await import("./edit-and-send-dispatcher.service");

import type { StartEditAndSendGenerationInput } from "./edit-and-send-dispatcher.service";

// Two distinct user scopes with DISJOINT profile sets, so any cross-tenant leak
// shows up as a concrete foreign id rather than as a coincidental match.
const USER_ALPHA = "user:alpha";
const USER_BETA = "user:beta";

const ALPHA_ACTIVE = "alpha-active";
const ALPHA_DEFAULT = "alpha-default";
const ALPHA_PINNED = "alpha-pinned";
const BETA_ACTIVE = "beta-active";
const BETA_DEFAULT = "beta-default";
const BETA_PINNED = "beta-pinned";

const PINNED_MODEL_OVERRIDE = "pinned-model-override";

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
  for (const userId of [USER_ALPHA, USER_BETA]) {
    db.query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)")
      .run(`char-${userId}`, userId, userId);
  }
}

/** Keyless `custom` profiles: credential resolution is not what this suite tests. */
function seedProfile(userId: string, id: string, isDefault = false): void {
  getDb().query(
    `INSERT INTO connection_profiles
       (id, name, provider, api_url, model, preset_id, is_default, metadata, created_at, updated_at, has_api_key, user_id)
     VALUES (?, ?, 'custom', 'http://127.0.0.1:1234/v1', ?, NULL, ?, '{}', 1, 1, 0, ?)`,
  ).run(id, id, `${id}-model`, isDefault ? 1 : 0, userId);
}

function seedSetting(userId: string, key: string, value: unknown): void {
  getDb().query(
    `INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, 1)
     ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value), userId);
}

function clearSetting(userId: string, key: string): void {
  getDb().query("DELETE FROM settings WHERE key = ? AND user_id = ?").run(key, userId);
}

function seedChat(userId: string, id: string, metadata: Record<string, unknown> = {}): void {
  getDb().query(
    "INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)",
  ).run(id, userId, `char-${userId}`, id, JSON.stringify({ temporary: true, no_preset: true, ...metadata }));
}

function seedUserMessage(chatId: string, index = 0): string {
  const id = `${chatId}-user`;
  getDb().query(`INSERT INTO messages (
    id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra,
    parent_message_id, branch_id, created_at, revision
  ) VALUES (?, ?, ?, 1, 'User', 'original', 100, 0, ?, ?, '{}', NULL, NULL, 100, 2)`).run(
    id, chatId, index, JSON.stringify(["original"]), JSON.stringify([100]),
  );
  return id;
}

function seedAssistantMessage(chatId: string, index = 1): string {
  const id = `${chatId}-assistant`;
  getDb().query(`INSERT INTO messages (
    id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra,
    parent_message_id, branch_id, created_at, revision
  ) VALUES (?, ?, ?, 0, 'Assistant', 'reply', 101, 0, ?, ?, '{}', NULL, NULL, 101, 1)`).run(
    id, chatId, index, JSON.stringify(["reply"]), JSON.stringify([101]),
  );
  return id;
}

function commitEditAndSend(userId: string, chatId: string, branch: boolean): string {
  const requestId = `${chatId}-request`;
  const result = chatsSvc.editAndSend(userId, chatId, {
    messageId: `${chatId}-user`,
    content: "rewritten",
    expectedVersion: 2,
    requestId,
    branchChatOnEditAndSend: branch,
  });
  expect(result.status).toBe("ok");
  return requestId;
}

beforeEach(() => {
  initTestDb();
  dispatcher.resetEditAndSendDispatcherForTests();
  seedProfile(USER_ALPHA, ALPHA_ACTIVE);
  seedProfile(USER_ALPHA, ALPHA_DEFAULT, true);
  seedProfile(USER_ALPHA, ALPHA_PINNED);
  seedProfile(USER_BETA, BETA_ACTIVE);
  seedProfile(USER_BETA, BETA_DEFAULT, true);
  seedProfile(USER_BETA, BETA_PINNED);
  seedSetting(USER_ALPHA, "activeProfileId", ALPHA_ACTIVE);
  seedSetting(USER_BETA, "activeProfileId", BETA_ACTIVE);
});

afterEach(() => {
  dispatcher.resetEditAndSendDispatcherForTests();
  closeDatabase();
});

// ── Commit-time persistence, against the real resolver ─────────────────────

/**
 * The whole (opt-in × pin) input space of `resolveEditAndSendConnectionId`, with
 * the rung each shape is expected to land on named explicitly so a wrong answer
 * reports WHICH rung moved rather than just an id mismatch.
 */
interface CommitShape {
  label: string;
  optIn: boolean | "absent";
  pin: "none" | "live" | "deleted";
  rung: string;
  expectedFor(userId: string): string;
}

const COMMIT_SHAPES: CommitShape[] = [
  {
    label: "opt-in ON, no pin",
    optIn: true,
    pin: "none",
    rung: "1 — strict active profile",
    expectedFor: (u) => (u === USER_ALPHA ? ALPHA_ACTIVE : BETA_ACTIVE),
  },
  {
    label: "opt-in ON, live pin (the opt-in outranks the pin)",
    optIn: true,
    pin: "live",
    rung: "1 — strict active profile",
    expectedFor: (u) => (u === USER_ALPHA ? ALPHA_ACTIVE : BETA_ACTIVE),
  },
  {
    label: "opt-in OFF, live pin",
    optIn: false,
    pin: "live",
    rung: "2 — live chat connection_profile_id",
    expectedFor: (u) => (u === USER_ALPHA ? ALPHA_PINNED : BETA_PINNED),
  },
  {
    label: "opt-in absent, live pin",
    optIn: "absent",
    pin: "live",
    rung: "2 — live chat connection_profile_id",
    expectedFor: (u) => (u === USER_ALPHA ? ALPHA_PINNED : BETA_PINNED),
  },
  {
    label: "opt-in absent, no pin",
    optIn: "absent",
    pin: "none",
    rung: "3 — acting chain (active first)",
    expectedFor: (u) => (u === USER_ALPHA ? ALPHA_ACTIVE : BETA_ACTIVE),
  },
  {
    label: "opt-in absent, pin naming a deleted profile",
    optIn: "absent",
    pin: "deleted",
    rung: "3 — acting chain (the pin failed validation)",
    expectedFor: (u) => (u === USER_ALPHA ? ALPHA_ACTIVE : BETA_ACTIVE),
  },
];

function applyOptIn(userId: string, optIn: boolean | "absent"): void {
  if (optIn === "absent") clearSetting(userId, "quickToolbarSettings");
  else seedSetting(userId, "quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: optIn });
}

function pinMetadata(userId: string, pin: CommitShape["pin"]): Record<string, unknown> {
  if (pin === "none") return {};
  const pinnedId = pin === "deleted"
    ? "conn-deleted-never-existed"
    : (userId === USER_ALPHA ? ALPHA_PINNED : BETA_PINNED);
  return { connection_profile_id: pinnedId, connection_model: PINNED_MODEL_OVERRIDE };
}

describe("editAndSend records the committed connection on the outbox row", () => {
  for (const shape of COMMIT_SHAPES) {
    for (const branch of [false, true]) {
      test(`${shape.label}, branchChatOnEditAndSend = ${branch}`, () => {
        const observed: Array<Record<string, unknown>> = [];
        const expected: Array<Record<string, unknown>> = [];

        // The multi-tenant matrix: both scopes commit the SAME logical shape at
        // the same time, so a leak between them is visible as a foreign id.
        for (const userId of [USER_ALPHA, USER_BETA]) {
          applyOptIn(userId, shape.optIn);
          const chatId = `commit-${userId}`;
          seedChat(userId, chatId, pinMetadata(userId, shape.pin));
          seedUserMessage(chatId);
        }

        for (const userId of [USER_ALPHA, USER_BETA]) {
          const chatId = `commit-${userId}`;
          // The real resolver's answer, captured BEFORE the commit so the
          // comparison is against an independent computation rather than a
          // read-back of whatever `editAndSend` happened to write.
          const resolverAnswer = connectionsSvc.resolveEditAndSendConnectionId(
            userId,
            chatsSvc.getChat(userId, chatId)?.metadata,
          );
          const requestId = commitEditAndSend(userId, chatId, branch);
          const row = dispatcher.getGenerationOutboxByRequest(userId, chatId, requestId);

          observed.push({
            userId,
            rung: shape.rung,
            resolverAnswer,
            recorded: row?.connection_id,
            recordedIsNull: row?.connection_id === null,
            rowUserId: row?.user_id,
          });
          expected.push({
            userId,
            rung: shape.rung,
            resolverAnswer: shape.expectedFor(userId),
            recorded: shape.expectedFor(userId),
            recordedIsNull: false,
            rowUserId: userId,
          });
        }

        expect(observed).toEqual(expected);
      });
    }
  }

  test("no tenant's committed row is reachable or mutable from the other scope", () => {
    applyOptIn(USER_ALPHA, true);
    applyOptIn(USER_BETA, true);
    for (const userId of [USER_ALPHA, USER_BETA]) {
      const chatId = `isolate-${userId}`;
      seedChat(userId, chatId);
      seedUserMessage(chatId);
      commitEditAndSend(userId, chatId, false);
    }

    const alphaRequest = `isolate-${USER_ALPHA}-request`;
    const betaRequest = `isolate-${USER_BETA}-request`;

    // Churn ALPHA's live state hard: move the active profile and drop the opt-in.
    seedSetting(USER_ALPHA, "activeProfileId", ALPHA_DEFAULT);
    clearSetting(USER_ALPHA, "quickToolbarSettings");

    expect({
      alphaRecorded: dispatcher
        .getGenerationOutboxByRequest(USER_ALPHA, `isolate-${USER_ALPHA}`, alphaRequest)?.connection_id,
      betaRecorded: dispatcher
        .getGenerationOutboxByRequest(USER_BETA, `isolate-${USER_BETA}`, betaRequest)?.connection_id,
      // The lookup key is (user_id, chat_id, request_id): neither tenant can read
      // the other's row, even knowing its chat id and request id.
      alphaSeenAsBeta: dispatcher
        .getGenerationOutboxByRequest(USER_BETA, `isolate-${USER_ALPHA}`, alphaRequest),
      betaSeenAsAlpha: dispatcher
        .getGenerationOutboxByRequest(USER_ALPHA, `isolate-${USER_BETA}`, betaRequest),
    }).toEqual({
      alphaRecorded: ALPHA_ACTIVE,
      betaRecorded: BETA_ACTIVE,
      alphaSeenAsBeta: null,
      betaSeenAsAlpha: null,
    });
  });

  test("a chat pin naming ANOTHER tenant's profile is not honoured", () => {
    // `resolveEditAndSendConnectionId` validates the pin with a user-scoped
    // `getConnection`, so a cross-tenant id fails validation and falls to the
    // acting chain rather than committing a foreign connection.
    applyOptIn(USER_ALPHA, false);
    const chatId = "cross-tenant-pin";
    seedChat(USER_ALPHA, chatId, { connection_profile_id: BETA_PINNED });
    seedUserMessage(chatId);

    const requestId = commitEditAndSend(USER_ALPHA, chatId, false);
    const row = dispatcher.getGenerationOutboxByRequest(USER_ALPHA, chatId, requestId);

    expect({
      recorded: row?.connection_id,
      isForeign: row?.connection_id === BETA_PINNED,
      resolverAnswer: connectionsSvc.resolveEditAndSendConnectionId(
        USER_ALPHA,
        { connection_profile_id: BETA_PINNED },
      ),
    }).toEqual({
      recorded: ALPHA_ACTIVE,
      isForeign: false,
      resolverAnswer: ALPHA_ACTIVE,
    });
  });

  test("the commit survives a user who owns no connections at all", () => {
    // NULL is a first-class value, and a connection lookup must never be able to
    // fail the user's edit. The rejected alternative — throwing, or refusing the
    // commit — would make Edit-and-Send unusable for a brand-new account.
    getDb().query("DELETE FROM connection_profiles WHERE user_id = ?").run(USER_ALPHA);
    clearSetting(USER_ALPHA, "activeProfileId");
    const chatId = "no-profiles";
    seedChat(USER_ALPHA, chatId);
    seedUserMessage(chatId);

    const requestId = commitEditAndSend(USER_ALPHA, chatId, false);
    const row = dispatcher.getGenerationOutboxByRequest(USER_ALPHA, chatId, requestId);
    expect({
      recorded: row?.connection_id,
      status: row?.status,
      resolverAnswer: connectionsSvc.resolveEditAndSendConnectionId(USER_ALPHA, {}),
    }).toEqual({ recorded: null, status: "pending", resolverAnswer: undefined });
  });

  test("the shared setting owner is the one both ends read", () => {
    // One owner for `editAndSendAlwaysUseActiveConnection`
    // (`settings.service.readEditAndSendAlwaysUseActiveConnection`), consumed by
    // BOTH the commit-time resolver and the legacy dispatch-time ladder. Two
    // copies of a strict read is exactly how the two answers would drift, which
    // is the class of bug this change removes.
    seedSetting(USER_ALPHA, "quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: true });
    seedSetting(USER_BETA, "quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: "true" });
    expect({
      alpha: settingsSvc.readEditAndSendAlwaysUseActiveConnection(USER_ALPHA),
      // Strict `=== true`: the coercible string is OFF.
      beta: settingsSvc.readEditAndSendAlwaysUseActiveConnection(USER_BETA),
    }).toEqual({ alpha: true, beta: false });
  });
});

// ── The dispatch payload stays unforgeable ─────────────────────────────────

describe("the committed connection travels out of band only", () => {
  interface Capture {
    input: StartEditAndSendGenerationInput;
    options:
      | {
          origin?: string;
          connectionId?: string;
          editAndSendContext?: { editedUserMessageId: string; committedRevision: number };
        }
      | undefined;
  }

  function captureDispatches(): Capture[] {
    const captured: Capture[] = [];
    dispatcher.setEditAndSendStartGeneration(async (input, options) => {
      captured.push({ input, options });
      return { generationId: input.generationId, status: "streaming" };
    });
    return captured;
  }

  for (const historical of [false, true]) {
    test(`${historical ? "swipe" : "normal"} mode: input keeps exactly its current field set`, async () => {
      applyOptIn(USER_ALPHA, true);
      const chatId = `fieldset-${historical ? "swipe" : "normal"}`;
      seedChat(USER_ALPHA, chatId);
      seedUserMessage(chatId);
      if (historical) seedAssistantMessage(chatId);

      const requestId = commitEditAndSend(USER_ALPHA, chatId, false);
      const captured = captureDispatches();
      await dispatcher.dispatchEditAndSendRequest(USER_ALPHA, chatId, requestId);
      expect(captured).toHaveLength(1);

      const { input, options } = captured[0]!;
      // The exact field set, unchanged by this fix. `connection_id` /
      // `connectionId` must NOT appear: `chatRoute` spreads the request body into
      // service input, so an in-band field would let any client forge a
      // connection override on `POST /generate`.
      expect(Object.keys(input).sort()).toEqual(
        historical
          ? ["chat_id", "generationId", "generation_type", "message_id", "userId"]
          : ["chat_id", "generationId", "generation_type", "userId"],
      );
      // Complete payload schema, not just the discriminator.
      expect(input).toEqual(
        historical
          ? {
              userId: USER_ALPHA,
              chat_id: chatId,
              generationId: expect.any(String),
              generation_type: "swipe",
              message_id: `${chatId}-assistant`,
            }
          : {
              userId: USER_ALPHA,
              chat_id: chatId,
              generationId: expect.any(String),
              generation_type: "normal",
            },
      );
      // ...and the identity arrives in the second positional argument instead.
      expect(options).toEqual({
        origin: "edit_and_send",
        connectionId: ALPHA_ACTIVE,
        editAndSendContext: {
          editedUserMessageId: `${chatId}-user`,
          committedRevision: 3,
        },
      });
    });
  }

  test("each tenant's dispatch carries its OWN committed connection", async () => {
    applyOptIn(USER_ALPHA, true);
    applyOptIn(USER_BETA, true);
    for (const userId of [USER_ALPHA, USER_BETA]) {
      const chatId = `dispatch-${userId}`;
      seedChat(userId, chatId);
      seedUserMessage(chatId);
      commitEditAndSend(userId, chatId, false);
    }

    const captured = captureDispatches();
    // The shared retry tick drains BOTH tenants' rows in one pass. The options
    // bag used to be a module-level constant; a per-row value in a shared object
    // would let one tenant's dispatch stomp the other's.
    expect(await dispatcher.dispatchPendingEditAndSendOutbox()).toBe(2);

    expect(
      captured
        .map((entry) => ({ userId: entry.input.userId, options: entry.options }))
        .sort((a, b) => a.userId.localeCompare(b.userId)),
    ).toEqual([
      {
        userId: USER_ALPHA,
        options: {
          origin: "edit_and_send",
          connectionId: ALPHA_ACTIVE,
          editAndSendContext: {
            editedUserMessageId: `dispatch-${USER_ALPHA}-user`,
            committedRevision: 3,
          },
        },
      },
      {
        userId: USER_BETA,
        options: {
          origin: "edit_and_send",
          connectionId: BETA_ACTIVE,
          editAndSendContext: {
            editedUserMessageId: `dispatch-${USER_BETA}-user`,
            committedRevision: 3,
          },
        },
      },
    ]);
  });

  test("a NULL committed connection forwards `undefined`, not `null`", async () => {
    // The legacy ladder keys off "absent". Forwarding `null` would make
    // `authoritativeConnectionId` present-but-unusable and is the shape a naive
    // pass-through produces, so it is pinned explicitly.
    applyOptIn(USER_ALPHA, true);
    const chatId = "null-forward";
    seedChat(USER_ALPHA, chatId);
    seedUserMessage(chatId);
    const requestId = commitEditAndSend(USER_ALPHA, chatId, false);
    getDb().query(
      "UPDATE generation_outbox SET connection_id = NULL WHERE user_id = ? AND request_id = ?",
    ).run(USER_ALPHA, requestId);

    const captured = captureDispatches();
    await dispatcher.dispatchEditAndSendRequest(USER_ALPHA, chatId, requestId);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.options).toEqual({
      origin: "edit_and_send",
      connectionId: undefined,
      editAndSendContext: {
        editedUserMessageId: `${chatId}-user`,
        committedRevision: 3,
      },
    });
    expect(captured[0]!.options?.connectionId).toBeUndefined();
  });
});
