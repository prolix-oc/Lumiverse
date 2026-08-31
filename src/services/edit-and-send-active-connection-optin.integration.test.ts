/**
 * Task 3.18 — dispatch-time resolution and safe degradation, end to end through
 * the real outbox.
 *
 * What this suite proves that the unit and property suites cannot:
 *   - the dispatcher really does forward `{ origin: "edit_and_send" }` as a
 *     second positional argument on ALL THREE dispatch paths — the POST-handler
 *     path (`dispatchEditAndSendRequest`), the periodic retry tick
 *     (`dispatchPendingEditAndSendOutbox`), and startup recovery
 *     (`recoverEditAndSendOutbox`);
 *   - the connection identity is COMMITTED, not re-derived: it is resolved once
 *     by `chats.service.editAndSend`, persisted on
 *     `generation_outbox.connection_id`, and forwarded verbatim on all three
 *     dispatch occasions. Shown by churning the live state (flipping the opt-in,
 *     deleting it, moving `activeProfileId`) BETWEEN the commit and the dispatch
 *     and observing that the dispatch does NOT follow. The `flipping ...` case
 *     below asserted the opposite before the durable-identity fix; its former
 *     outcome WAS the defect, so it is inverted rather than deleted;
 *   - rows with a NULL `connection_id` (committed before that column existed)
 *     still resolve through the unchanged legacy ladder, which is where the
 *     dispatch-time settings read still lives;
 *   - safe degradation (2.14): setting on, binding live, `activeProfileId`
 *     naming a deleted profile resolves the BOUND profile, starts, and reaches
 *     `running` — no throw, no `failed`, no `terminal_reason`;
 *   - the acting-connection fix itself lands through the whole flow for both
 *     `branchChatOnEditAndSend` values.
 *
 * Harness note: the injected `setEditAndSendStartGeneration` seam delegates to
 * the REAL `startGeneration`, forwarding the options it was handed, so the real
 * dispatch-time settings read and the real resolution ladder run. Only the
 * detached prompt-assembly failure is swallowed (council profile resolution is
 * stubbed to throw so nothing reaches a provider), and the seam then reports the
 * success the row would have seen. The connection identity under test is never
 * stubbed.
 *
 * This suite creates `settings` and `connection_profiles` in ITS OWN harness.
 * The existing dispatcher harnesses deliberately create neither, because the
 * dispatcher itself queries nothing.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { closeDatabase, getDb, initDatabase } from "../db/connection";

mock.module("../crypto/init", () => ({
  getEncryptionKeyBytes: () => new Uint8Array(32).fill(7),
}));

const chatsSvc = await import("./chats.service");
const chatBackground = await import("./chat-background.service");
const councilProfilesSvc = await import("./council/council-profiles.service");
const pool = await import("./generation-pool.service");
const generateSvc = await import("./generate.service");
const dispatcher = await import("./edit-and-send-dispatcher.service");

const USER = "user:optin-integration";

const ACTIVE = "int-active";
const DEFAULT = "int-default";
const BOUND = "int-bound";
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
  getDb().query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)")
    .run("char-int", USER, "Integration");
}

/** Keyless `custom` profiles: the credential preflight is not what this suite tests. */
function seedProfile(id: string, model: string, isDefault = false): void {
  getDb().query(
    `INSERT INTO connection_profiles
       (id, name, provider, api_url, model, preset_id, is_default, metadata, created_at, updated_at, has_api_key, user_id)
     VALUES (?, ?, 'custom', 'http://127.0.0.1:1234/v1', ?, NULL, ?, '{}', 1, 1, 0, ?)`,
  ).run(id, id, model, isDefault ? 1 : 0, USER);
}

function seedSetting(key: string, value: unknown): void {
  getDb().query(
    `INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, 1)
     ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value), USER);
}

function seedChat(id: string, metadata: Record<string, unknown> = {}): void {
  getDb().query(
    "INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)",
  ).run(id, USER, "char-int", id, JSON.stringify({ temporary: true, no_preset: true, ...metadata }));
}

function seedUserMessage(chatId: string): string {
  const id = `${chatId}-user`;
  getDb().query(`INSERT INTO messages (
    id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra,
    parent_message_id, branch_id, created_at, revision
  ) VALUES (?, ?, 0, 1, 'User', 'original', 100, 0, ?, ?, '{}', NULL, NULL, 100, 2)`).run(
    id, chatId, JSON.stringify(["original"]), JSON.stringify([100]),
  );
  return id;
}

const spies: Array<{ mockRestore: () => void }> = [];
function track<T extends { mockRestore: () => void }>(spy: T): T {
  spies.push(spy);
  return spy;
}

interface DispatchObservation {
  /**
   * The second positional argument the dispatcher handed `startGeneration`,
   * including `connectionId` — the connection recorded on the outbox row at
   * commit time. Observed here rather than inferred, because the whole point of
   * the durable-identity fix is WHICH id reaches this bag, and it must reach it
   * out of band (never as a field on the dispatch input, which `chatRoute` would
   * make client-settable).
   */
  options: { origin?: string; connectionId?: string } | undefined;
  /** The connection id the REAL resolution ladder settled on. */
  connectionId: string | undefined;
  /** The model the pool entry was registered with, when it got that far. */
  model: string | undefined;
}

/**
 * Install the dispatcher seam so it delegates to the real `startGeneration`,
 * forwarding the options it received. Prompt assembly is stubbed to throw, so
 * nothing reaches a provider; the seam reports the success the outbox row would
 * have seen, leaving the row's state machine to behave normally.
 */
function observeRealDispatches(): DispatchObservation[] {
  const observed: DispatchObservation[] = [];
  track(spyOn(chatBackground, "abortChatBackground").mockResolvedValue(undefined));
  const resolveProfile = councilProfilesSvc.resolveProfile;
  track(spyOn(councilProfilesSvc, "resolveProfile").mockImplementation((...args) => {
    if (pool.getActivePoolsForUser(USER).length === 0) return resolveProfile(...args);
    throw new Error("skip-assembly");
  }));
  dispatcher.setEditAndSendStartGeneration(async (input, options) => {
    await generateSvc.startGeneration(input as never, options)
      .catch(() => { /* the stubbed prompt assembly, not the resolution */ });
    const entry = pool.getPoolEntry(input.generationId);
    observed.push({
      options,
      connectionId: entry?.connectionId,
      model: entry?.model,
    });
    // Between paths, clear the in-memory generation state so a later dispatch
    // of a different row is resolved afresh rather than short-circuiting on a
    // live pool entry.
    generateSvc.stopAllGenerations();
    pool.clearAllPoolEntries();
    return { generationId: input.generationId, status: "streaming" };
  });
  return observed;
}

/** Commit an Edit-and-Send request; returns its request id. */
function commitEditAndSend(chatId: string, branch: boolean): string {
  const requestId = `${chatId}-request`;
  const result = chatsSvc.editAndSend(USER, chatId, {
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
  seedProfile(ACTIVE, "model-active");
  seedProfile(DEFAULT, "model-default", true);
  seedProfile(BOUND, "model-bound");
  seedSetting("activeProfileId", ACTIVE);
});

afterEach(() => {
  generateSvc.stopAllGenerations();
  pool.clearAllPoolEntries();
  generateSvc.stopGenerationSweep();
  dispatcher.resetEditAndSendDispatcherForTests();
  for (const spy of spies.splice(0)) spy.mockRestore();
  closeDatabase();
});

// ── Dispatch-time resolution on all three paths ────────────────────────────

describe("the opt-in resolves at dispatch time on all three dispatch paths", () => {
  test("POST handler, retry tick, and startup recovery all resolve the ACTIVE profile", async () => {
    seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: true });
    const observed = observeRealDispatches();

    // (a) The POST-handler path.
    seedChat("path-a", { connection_profile_id: BOUND, connection_model: BINDING_MODEL_OVERRIDE });
    seedUserMessage("path-a");
    const requestA = commitEditAndSend("path-a", false);
    const rowA = await dispatcher.dispatchEditAndSendRequest(USER, "path-a", requestA);

    // (b) The periodic retry tick: the row is committed `pending` and never
    // dispatched from the handler, exactly as a deferred dispatch would be.
    seedChat("path-b", { connection_profile_id: BOUND, connection_model: BINDING_MODEL_OVERRIDE });
    seedUserMessage("path-b");
    commitEditAndSend("path-b", false);
    expect(await dispatcher.dispatchPendingEditAndSendOutbox()).toBe(1);

    // (c) Startup recovery.
    seedChat("path-c", { connection_profile_id: BOUND, connection_model: BINDING_MODEL_OVERRIDE });
    seedUserMessage("path-c");
    commitEditAndSend("path-c", false);
    expect(await dispatcher.recoverEditAndSendOutbox()).toBe(1);

    expect(observed.map((entry) => ({
      origin: entry.options?.origin,
      connectionId: entry.connectionId,
      model: entry.model,
    }))).toEqual([
      { origin: "edit_and_send", connectionId: ACTIVE, model: "model-active" },
      { origin: "edit_and_send", connectionId: ACTIVE, model: "model-active" },
      { origin: "edit_and_send", connectionId: ACTIVE, model: "model-active" },
    ]);
    expect(rowA?.status).toBe("running");
  });

  test("flipping the setting to false BETWEEN commit and the retry tick does NOT change the dispatch", async () => {
    // INVERTED (durable-identity fix). This case previously asserted that the
    // dispatch FOLLOWED the flipped value, on the reasoning that reading the
    // setting at dispatch time made a `generation_outbox` column unnecessary.
    // That reasoning was the defect: the outbox is durable but its dispatch is
    // not a single event, so re-reading live state on a later tick silently
    // retargets a request the user already committed. The connection is now
    // resolved ONCE at commit time and persisted on
    // `generation_outbox.connection_id`, which is what this case now pins.
    seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: true });
    const observed = observeRealDispatches();

    seedChat("flip", { connection_profile_id: BOUND, connection_model: BINDING_MODEL_OVERRIDE });
    seedUserMessage("flip");
    const requestId = commitEditAndSend("flip", false);

    // The identity was recorded at COMMIT time, before anything was flipped.
    const committed = dispatcher.getGenerationOutboxByRequest(USER, "flip", requestId);
    expect(committed?.connection_id).toBe(ACTIVE);

    // Mid-flight: the user unticks the checkbox after committing the edit but
    // before the deferred dispatch runs.
    seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: false });

    expect(await dispatcher.dispatchPendingEditAndSendOutbox()).toBe(1);
    // Full observation, not just the id: the origin still travels out of band,
    // the persisted id is what reaches the options bag, and the resolved model
    // is the committed profile's own (the binding's `connection_model` belongs
    // to the binding, which the opt-in deliberately did not select).
    expect(observed).toEqual([
      {
        options: { origin: "edit_and_send", connectionId: ACTIVE },
        connectionId: ACTIVE,
        model: "model-active",
      },
    ]);
  });
});

// ── Durable connection identity across every dispatch occasion ─────────────

/**
 * The finding these cases exist for: "Edit-and-Send does not durably preserve
 * connection identity. The outbox stores no connection_id; active
 * connection/settings are reread during dispatch, retry, or recovery. Switching
 * profiles can therefore change an already-committed request."
 *
 * Every case below fails on a tree without `generation_outbox.connection_id`,
 * because on such a tree the dispatch re-derives the connection from whatever
 * live state happens to be current at the moment the tick fires.
 */
describe("the committed connection survives live-state churn", () => {
  /** Move the user's active profile AFTER the commit, before the dispatch. */
  function switchActiveProfileTo(id: string): void {
    seedSetting("activeProfileId", id);
  }

  test("switching activeProfileId after commit does not retarget the POST-handler dispatch", async () => {
    seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: true });
    const observed = observeRealDispatches();

    seedChat("switch-post");
    seedUserMessage("switch-post");
    const requestId = commitEditAndSend("switch-post", false);
    expect(dispatcher.getGenerationOutboxByRequest(USER, "switch-post", requestId)?.connection_id)
      .toBe(ACTIVE);

    switchActiveProfileTo(DEFAULT);
    const row = await dispatcher.dispatchEditAndSendRequest(USER, "switch-post", requestId);

    expect(observed).toEqual([
      {
        options: { origin: "edit_and_send", connectionId: ACTIVE },
        connectionId: ACTIVE,
        model: "model-active",
      },
    ]);
    expect({ status: row?.status, connectionId: row?.connection_id }).toEqual({
      status: "running",
      connectionId: ACTIVE,
    });
  });

  test("switching activeProfileId after commit does not retarget a RETRY-TICK dispatch", async () => {
    seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: true });
    const observed = observeRealDispatches();

    seedChat("switch-retry");
    seedUserMessage("switch-retry");
    const requestId = commitEditAndSend("switch-retry", false);

    // Simulate a first attempt that failed and backed off: the row is pending
    // with an elapsed `next_attempt_at`, which is exactly the state the periodic
    // tick picks up, potentially hours after the commit.
    getDb().query(
      `UPDATE generation_outbox
       SET attempt_count = 1, last_error_code = 'dispatch_failed', next_attempt_at = ?
       WHERE user_id = ? AND request_id = ?`,
    ).run(Date.now() - 60_000, USER, requestId);

    switchActiveProfileTo(BOUND);
    expect(await dispatcher.dispatchPendingEditAndSendOutbox()).toBe(1);

    expect(observed).toEqual([
      {
        options: { origin: "edit_and_send", connectionId: ACTIVE },
        connectionId: ACTIVE,
        model: "model-active",
      },
    ]);
  });

  test("switching activeProfileId after commit does not retarget STARTUP RECOVERY", async () => {
    seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: true });
    const observed = observeRealDispatches();

    seedChat("switch-recover");
    seedUserMessage("switch-recover");
    const requestId = commitEditAndSend("switch-recover", false);

    // A crash between claim and dispatch: the row is left `claimed` with an
    // expired lease and no `dispatched_at`, which `recoverEditAndSendOutbox`
    // releases back to pending and then re-dispatches.
    getDb().query(
      `UPDATE generation_outbox
       SET status = 'claimed', lease_owner = 'dead-instance', lease_expires_at = ?
       WHERE user_id = ? AND request_id = ?`,
    ).run(Date.now() - 120_000, USER, requestId);

    switchActiveProfileTo(DEFAULT);
    expect(await dispatcher.recoverEditAndSendOutbox()).toBe(1);

    expect(observed).toEqual([
      {
        options: { origin: "edit_and_send", connectionId: ACTIVE },
        connectionId: ACTIVE,
        model: "model-active",
      },
    ]);
  });

  test("deleting the opt-in setting entirely after commit does not retarget the dispatch", async () => {
    // The sibling of the flip case: not `false`, but the row gone altogether.
    // Both are live reads the dispatch must no longer depend on.
    seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: true });
    const observed = observeRealDispatches();

    seedChat("wipe", { connection_profile_id: BOUND, connection_model: BINDING_MODEL_OVERRIDE });
    seedUserMessage("wipe");
    const requestId = commitEditAndSend("wipe", false);

    getDb().query("DELETE FROM settings WHERE key = 'quickToolbarSettings' AND user_id = ?").run(USER);
    getDb().query("DELETE FROM settings WHERE key = 'activeProfileId' AND user_id = ?").run(USER);

    expect(await dispatcher.dispatchEditAndSendRequest(USER, "wipe", requestId)).not.toBeNull();
    expect(observed).toEqual([
      {
        options: { origin: "edit_and_send", connectionId: ACTIVE },
        connectionId: ACTIVE,
        model: "model-active",
      },
    ]);
  });

  test("a pinned chat keeps its connection_model when the pin IS the committed connection", async () => {
    // Preservation, not a new behaviour: with the opt-in OFF the committed
    // identity comes from the chat's `connection_profile_id`, so the binding's
    // `connection_model` override still applies. Dropping it on the new rung was
    // the rejected alternative — it would have silently changed the MODEL of
    // every pinned chat, which this finding never asked for.
    const observed = observeRealDispatches();

    seedChat("pinned-model", { connection_profile_id: BOUND, connection_model: BINDING_MODEL_OVERRIDE });
    seedUserMessage("pinned-model");
    const requestId = commitEditAndSend("pinned-model", false);
    expect(dispatcher.getGenerationOutboxByRequest(USER, "pinned-model", requestId)?.connection_id)
      .toBe(BOUND);

    switchActiveProfileTo(DEFAULT);
    await dispatcher.dispatchEditAndSendRequest(USER, "pinned-model", requestId);

    expect(observed).toEqual([
      {
        options: { origin: "edit_and_send", connectionId: BOUND },
        connectionId: BOUND,
        model: BINDING_MODEL_OVERRIDE,
      },
    ]);
  });

  test("a pre-migration row (connection_id NULL) still dispatches through the legacy ladder", async () => {
    // Rows committed before `migrations/111_generation_outbox_connection_id.sql`
    // carry no identity. They MUST keep resolving exactly as before — NULL is a
    // first-class value, not an error — otherwise the migration strands every
    // request that was already queued when the server was upgraded.
    seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: true });
    const observed = observeRealDispatches();

    seedChat("legacy", { connection_profile_id: BOUND, connection_model: BINDING_MODEL_OVERRIDE });
    seedUserMessage("legacy");
    const requestId = commitEditAndSend("legacy", false);

    // Backdate the row to the pre-migration shape.
    getDb().query(
      "UPDATE generation_outbox SET connection_id = NULL WHERE user_id = ? AND request_id = ?",
    ).run(USER, requestId);
    expect(dispatcher.getGenerationOutboxByRequest(USER, "legacy", requestId)?.connection_id).toBeNull();

    // Now churn the live state. The legacy ladder reads it, so the dispatch
    // follows it — which is precisely the drift the new column removes, and
    // exactly what a row with no recorded identity must fall back to.
    switchActiveProfileTo(DEFAULT);
    await dispatcher.dispatchEditAndSendRequest(USER, "legacy", requestId);

    expect(observed).toEqual([
      {
        options: { origin: "edit_and_send", connectionId: undefined },
        connectionId: DEFAULT,
        model: "model-default",
      },
    ]);
  });

  test("a committed profile deleted before dispatch falls through instead of stranding the request", async () => {
    // Miss policy. A deleted profile is unrecoverable: no retry brings it back,
    // so throwing would only guarantee the user's committed edit produces
    // nothing. Falling through to the unchanged ladder mirrors the precedent
    // already documented for a deleted chat binding ("an old metadata reference
    // cannot make the chat unusable"). The rejected alternative was failing the
    // row terminally.
    seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: true });
    const observed = observeRealDispatches();

    seedChat("deleted-commit");
    seedUserMessage("deleted-commit");
    const requestId = commitEditAndSend("deleted-commit", false);
    expect(dispatcher.getGenerationOutboxByRequest(USER, "deleted-commit", requestId)?.connection_id)
      .toBe(ACTIVE);

    getDb().query("DELETE FROM connection_profiles WHERE id = ? AND user_id = ?").run(ACTIVE, USER);
    switchActiveProfileTo(DEFAULT);
    const row = await dispatcher.dispatchEditAndSendRequest(USER, "deleted-commit", requestId);

    expect(observed).toEqual([
      {
        // The persisted id still travels — it simply no longer resolves.
        options: { origin: "edit_and_send", connectionId: ACTIVE },
        connectionId: DEFAULT,
        model: "model-default",
      },
    ]);
    expect({
      status: row?.status,
      terminalReason: row?.terminal_reason,
      lastErrorCode: row?.last_error_code,
      // The recorded identity is never rewritten by a dispatch.
      connectionId: row?.connection_id,
    }).toEqual({
      status: "running",
      terminalReason: null,
      lastErrorCode: null,
      connectionId: ACTIVE,
    });
  });

  test("the recorded identity is fixed on the FIRST commit and honoured by every replay", async () => {
    // `editAndSend` short-circuits a repeated requestId on the stored
    // `edit_and_send_requests` row and returns the ORIGINAL payload without
    // re-inserting into the outbox, so there is no second resolution to keep in
    // sync: a replay after a profile switch cannot move the committed identity.
    seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: true });

    seedChat("replay");
    seedUserMessage("replay");
    const requestId = commitEditAndSend("replay", false);
    const first = dispatcher.getGenerationOutboxByRequest(USER, "replay", requestId);
    expect(first?.connection_id).toBe(ACTIVE);

    switchActiveProfileTo(DEFAULT);
    const replayed = chatsSvc.editAndSend(USER, "replay", {
      messageId: "replay-user",
      content: "rewritten",
      expectedVersion: 2,
      requestId,
      branchChatOnEditAndSend: false,
    });
    expect(replayed).toEqual({ status: "ok", replayed: true, payload: expect.any(Object) });

    expect(getDb().query("SELECT COUNT(*) AS count FROM generation_outbox").get()).toEqual({ count: 1 });
    expect(dispatcher.getGenerationOutboxByRequest(USER, "replay", requestId)).toEqual(first!);
  });
});

// ── Safe degradation (2.14) ────────────────────────────────────────────────

describe("safe degradation when the active profile cannot be resolved", () => {
  test("setting on, binding live, activeProfileId deleted: resolves the BOUND profile and runs", async () => {
    seedSetting("quickToolbarSettings", { editAndSendAlwaysUseActiveConnection: true });
    seedSetting("activeProfileId", "int-deleted-never-existed");
    const observed = observeRealDispatches();

    seedChat("degrade", { connection_profile_id: BOUND, connection_model: BINDING_MODEL_OVERRIDE });
    seedUserMessage("degrade");
    const requestId = commitEditAndSend("degrade", false);
    const row = await dispatcher.dispatchEditAndSendRequest(USER, "degrade", requestId);

    expect(observed.map((entry) => ({ connectionId: entry.connectionId, model: entry.model }))).toEqual([
      { connectionId: BOUND, model: BINDING_MODEL_OVERRIDE },
    ]);
    // No throw, no failed row, no terminal reason for that reason alone.
    expect({
      status: row?.status,
      terminalReason: row?.terminal_reason,
      lastErrorCode: row?.last_error_code,
      dispatchedAtSet: row?.dispatched_at != null,
    }).toEqual({
      status: "running",
      terminalReason: null,
      lastErrorCode: null,
      dispatchedAtSet: true,
    });
  });
});

// ── The acting-connection fix through the whole flow ───────────────────────

describe("the Edit-and-Send flow starts on the acting connection", () => {
  for (const branch of [false, true]) {
    test(`activeProfileId != is_default, no binding, branchChatOnEditAndSend = ${branch}`, async () => {
      // No `quickToolbarSettings` row at all — the state every existing user is
      // in. This is the 401 fix on its own, with the opt-in absent.
      const observed = observeRealDispatches();

      const chatId = `flow-${branch}`;
      seedChat(chatId);
      seedUserMessage(chatId);
      const requestId = commitEditAndSend(chatId, branch);
      const row = await dispatcher.dispatchEditAndSendRequest(USER, chatId, requestId);

      expect(observed.map((entry) => ({ connectionId: entry.connectionId, model: entry.model }))).toEqual([
        { connectionId: ACTIVE, model: "model-active" },
      ]);
      expect({
        status: row?.status,
        attemptCount: row?.attempt_count,
        dispatchedAtSet: row?.dispatched_at != null,
        terminalReason: row?.terminal_reason,
      }).toEqual({
        status: "running",
        // `running` reached exactly once: one claim, one dispatch, no retry.
        attemptCount: 1,
        dispatchedAtSet: true,
        terminalReason: null,
      });

      // A replayed dispatch is idempotent and does not re-resolve.
      await dispatcher.dispatchEditAndSendRequest(USER, chatId, requestId);
      expect(observed).toHaveLength(1);
    });
  }
});
