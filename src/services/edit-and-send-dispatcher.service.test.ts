import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  cancelEditAndSendOutbox,
  claimNextEditAndSendOutbox,
  dispatchEditAndSendRequest,
  dispatchPendingEditAndSendOutbox,
  getGenerationOutboxById,
  getGenerationOutboxByRequest,
  reconcileEditAndSendOutbox,
  recoverEditAndSendOutbox,
  resetEditAndSendDispatcherForTests,
  setEditAndSendGenerationActiveCheck,
  setEditAndSendStartGeneration,
  setEditAndSendStopGeneration,
} from "./edit-and-send-dispatcher.service";

function initDispatcherDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run(`CREATE TABLE generation_outbox (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    branch_chat_id TEXT NOT NULL,
    edited_message_id TEXT NOT NULL,
    target_message_id TEXT,
    target_swipe_index INTEGER,
    expected_version INTEGER NOT NULL,
    generation_id TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL CHECK(mode IN ('normal', 'swipe')),
    status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled')),
    lease_owner TEXT,
    lease_expires_at INTEGER,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    last_error_code TEXT,
    terminal_reason TEXT,
    dispatched_at INTEGER,
    completed_at INTEGER,
    cancelled_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    -- migrations/111_generation_outbox_connection_id.sql. Hand-written schema
    -- (no migrations run here), so the column is mirrored last to match the
    -- ALTER TABLE append order.
    connection_id TEXT
  )`);
  // The dispatcher reads the committed edit identity off this table's stored
  // cursor before dispatching, so every dispatchable fixture must carry a real
  // cursor row. Mirrors the production shape (chats.service INSERT).
  getDb().run(`CREATE TABLE edit_and_send_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    branch_chat_id TEXT NOT NULL,
    edited_message_id TEXT NOT NULL,
    target_message_id TEXT,
    target_swipe_index INTEGER,
    generation_id TEXT NOT NULL,
    response TEXT NOT NULL,
    cursor TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, chat_id, request_id)
  )`);
  getDb().run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    index_in_chat INTEGER NOT NULL DEFAULT 0,
    is_user INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1
  )`);
}

function insertMessage(overrides: Record<string, unknown> = {}): string {
  const id = typeof overrides.id === "string" ? overrides.id : crypto.randomUUID();
  const chatId = typeof overrides.chat_id === "string" ? overrides.chat_id : "b1";
  const indexInChat = typeof overrides.index_in_chat === "number" ? overrides.index_in_chat : 0;
  const isUser = typeof overrides.is_user === "number" ? overrides.is_user : 0;
  const content = typeof overrides.content === "string" ? overrides.content : "";
  const createdAt =
    typeof overrides.created_at === "number" ? overrides.created_at : Math.floor(Date.now() / 1000);
  const revision = typeof overrides.revision === "number" ? overrides.revision : 1;
  getDb().query(
    `INSERT INTO messages (id, chat_id, index_in_chat, is_user, content, created_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, chatId, indexInChat, isUser, content, createdAt, revision);
  return id;
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    overrides.request_id as SQLQueryBindings ?? "req-1",
    overrides.user_id as SQLQueryBindings ?? "u1",
    overrides.chat_id as SQLQueryBindings ?? "c1",
    overrides.branch_chat_id as SQLQueryBindings ?? "b1",
    overrides.edited_message_id as SQLQueryBindings ?? "m1",
    overrides.target_message_id as SQLQueryBindings | null ?? null,
    overrides.target_swipe_index as SQLQueryBindings | null ?? null,
    overrides.expected_version as SQLQueryBindings ?? 1,
    overrides.generation_id as SQLQueryBindings ?? `gen-${id}`,
    overrides.mode as SQLQueryBindings ?? "normal",
    overrides.status as SQLQueryBindings ?? "pending",
    overrides.lease_owner as SQLQueryBindings | null ?? null,
    overrides.lease_expires_at as SQLQueryBindings | null ?? null,
    overrides.attempt_count as SQLQueryBindings ?? 0,
    overrides.next_attempt_at as SQLQueryBindings | null ?? null,
    overrides.last_error_code as SQLQueryBindings | null ?? null,
    overrides.terminal_reason as SQLQueryBindings | null ?? null,
    overrides.dispatched_at as SQLQueryBindings | null ?? null,
    overrides.completed_at as SQLQueryBindings | null ?? null,
    overrides.cancelled_at as SQLQueryBindings | null ?? null,
    overrides.created_at as SQLQueryBindings ?? now,
    overrides.updated_at as SQLQueryBindings ?? now,
  );
  return id;
}

/**
 * Seed the stored request cursor the dispatcher reads before dispatching, shaped
 * exactly like the production `chats.service.editAndSend` write: the cursor
 * carries the generation cursor plus the committed edit identity, and its
 * `chatId` is the chat the generation runs in (the branch chat). By default it
 * is derived from the matching outbox row so the two can never disagree. Pass
 * `cursor` to write a deliberately mismatched/absent payload for the
 * strict-validation cases.
 */
function insertRequestCursor(overrides: {
  user_id?: string;
  chat_id?: string;
  request_id: string;
  branch_chat_id?: string;
  edited_message_id?: string;
  generation_id?: string;
  cursor?: unknown;
}): void {
  const userId = overrides.user_id ?? "u1";
  const chatId = overrides.chat_id ?? "c1";
  const branchChatId = overrides.branch_chat_id ?? "b1";
  const editedMessageId = overrides.edited_message_id ?? "m1";
  const generationId = overrides.generation_id ?? `gen-${overrides.request_id}`;
  const cursor =
    overrides.cursor !== undefined
      ? overrides.cursor
      : {
          generationId,
          chatId: branchChatId,
          requestId: overrides.request_id,
          mode: "normal",
          editAndSendContext: { editedUserMessageId: editedMessageId, committedRevision: 1 },
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

beforeEach(() => {
  initDispatcherDb();
  resetEditAndSendDispatcherForTests();
});

afterEach(() => {
  resetEditAndSendDispatcherForTests();
  closeDatabase();
});

describe("edit-and-send dispatcher", () => {
  test("outbox claim", () => {
    const firstId = insertOutbox({ request_id: "req-a", created_at: 1 });
    insertOutbox({ request_id: "req-b", created_at: 2, generation_id: "gen-b" });

    const claimed = claimNextEditAndSendOutbox();
    expect(claimed?.id).toBe(firstId);
    expect(claimed?.status).toBe("claimed");
    expect(claimed?.lease_owner).toBeString();
    expect(claimed?.attempt_count).toBe(1);

    const second = claimNextEditAndSendOutbox();
    expect(second?.request_id).toBe("req-b");
    expect(claimNextEditAndSendOutbox()).toBeNull();
    expect(getGenerationOutboxById(firstId)?.status).toBe("claimed");
  });

  test("single dispatch, cancellation and reconciliation", async () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const active = new Set<string>();
    setEditAndSendStartGeneration(async (input) => {
      starts.push(input.generationId);
      if (input.generationId === "gen-fail") throw new Error("provider_down");
      active.add(input.generationId);
      return { generationId: input.generationId, status: "streaming" };
    });
    setEditAndSendStopGeneration((userId, generationId) => {
      expect(userId).toBe("u1");
      stops.push(generationId);
      active.delete(generationId);
      return true;
    });
    setEditAndSendGenerationActiveCheck((_userId, generationId) => active.has(generationId));

    insertOutbox({
      id: "expired",
      request_id: "req-expired",
      generation_id: "gen-expired",
      status: "claimed",
      lease_owner: "dead-worker",
      lease_expires_at: Date.now() - 5_000,
      attempt_count: 1,
    });
    const expired = claimNextEditAndSendOutbox();
    expect(expired).toBeNull();
    reconcileEditAndSendOutbox();
    expect(getGenerationOutboxById("expired")?.status).toBe("failed");

    insertOutbox({
      id: "fail-row",
      request_id: "req-fail",
      generation_id: "gen-fail",
      status: "pending",
    });
    insertRequestCursor({ request_id: "req-fail", generation_id: "gen-fail" });
    const failed = await dispatchEditAndSendRequest("u1", "c1", "req-fail");
    expect(failed?.status).toBe("failed");
    expect(failed?.last_error_code).toBe("provider_down");
    expect(failed?.next_attempt_at).toBeNull();

    insertOutbox({
      id: "run-row",
      request_id: "req-run",
      generation_id: "gen-run",
      mode: "swipe",
      target_message_id: "asst-1",
      target_swipe_index: 1,
    });
    insertRequestCursor({
      request_id: "req-run",
      generation_id: "gen-run",
      edited_message_id: "m1",
    });
    const running = await dispatchEditAndSendRequest("u1", "c1", "req-run");
    expect(running?.status).toBe("running");
    expect(running?.dispatched_at).toBeNumber();
    expect(starts).toContain("gen-run");

    const replay = await dispatchEditAndSendRequest("u1", "c1", "req-run");
    expect(replay?.status).toBe("running");
    expect(starts.filter((id) => id === "gen-run")).toHaveLength(1);

    const cancelled = cancelEditAndSendOutbox("u1", { requestId: "req-run", chatId: "c1" });
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.cancelled_at).toBeNumber();
    expect(stops).toEqual(["gen-run"]);

    insertOutbox({
      id: "recon",
      request_id: "req-recon",
      generation_id: "gen-recon",
      status: "running",
      dispatched_at: Date.now() - 1_000,
    });
    // No active generation and no persisted output: fail without replaying.
    expect(reconcileEditAndSendOutbox()).toBe(1);
    const recon = getGenerationOutboxById("recon");
    expect(recon?.status).toBe("failed");
    expect(recon?.attempt_count).toBe(0);
    expect(recon?.last_error_code).toBe("output_not_verified");
    expect(recon?.next_attempt_at).toBeNull();
  });

  test("periodic reconcile skips live generations and durably resolves dead ones", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    setEditAndSendGenerationActiveCheck((_userId, generationId) => generationId === "gen-live");

    // Live in-memory generation: skipped entirely, row stays running.
    insertOutbox({
      id: "live-row",
      request_id: "req-live",
      generation_id: "gen-live",
      branch_chat_id: "branch-live",
      status: "running",
      dispatched_at: Date.now() - 1_000,
    });

    // Dead pool entry + persisted assistant output -> completed/verified_output.
    insertOutbox({
      id: "dead-verified-row",
      request_id: "req-dead-verified",
      generation_id: "gen-dead-verified",
      branch_chat_id: "branch-dead-verified",
      status: "running",
      attempt_count: 2,
      dispatched_at: Date.now() - 2_000,
    });
    insertMessage({ id: "asst-dead-verified", chat_id: "branch-dead-verified", created_at: nowSec });

    // Dead pool entry + NO persisted output -> failed without redispatch.
    insertOutbox({
      id: "dead-lost-row",
      request_id: "req-dead-lost",
      generation_id: "gen-dead-lost",
      branch_chat_id: "branch-dead-lost",
      status: "running",
      attempt_count: 3,
      dispatched_at: Date.now() - 2_000,
    });

    expect(reconcileEditAndSendOutbox()).toBe(2);

    expect(getGenerationOutboxById("live-row")?.status).toBe("running");
    expect(getGenerationOutboxById("live-row")?.terminal_reason).toBeNull();

    const verified = getGenerationOutboxById("dead-verified-row");
    expect(verified?.status).toBe("completed");
    expect(verified?.terminal_reason).toBe("verified_output");

    const lost = getGenerationOutboxById("dead-lost-row");
    expect(lost?.status).not.toBe("completed");
    expect(lost?.status).toBe("failed");
    expect(lost?.attempt_count).toBe(3);
    expect(lost?.last_error_code).toBe("output_not_verified");
    expect(lost?.next_attempt_at).toBeNull();
    expect(lost?.lease_owner).toBeNull();
  });

  test("rows with exhausted attempts are never claimable and reconcile marks them failed", async () => {
    // Pending row already at MAX_ATTEMPTS: the periodic sweep must skip it.
    insertOutbox({
      id: "exhausted-pending",
      request_id: "req-exhausted-pending",
      generation_id: "gen-exhausted-pending",
      status: "pending",
      attempt_count: 8,
    });
    expect(claimNextEditAndSendOutbox()).toBeNull();
    expect(getGenerationOutboxById("exhausted-pending")?.status).toBe("pending");

    // Stale claim at MAX_ATTEMPTS: reconcile fails it terminally instead of
    // re-queueing it forever.
    insertOutbox({
      id: "exhausted-stale",
      request_id: "req-exhausted-stale",
      generation_id: "gen-exhausted-stale",
      status: "claimed",
      lease_owner: "dead-worker",
      lease_expires_at: Date.now() - 5_000,
      attempt_count: 8,
    });
    // Both the stale claim AND the zombie pending row are swept to failed.
    expect(reconcileEditAndSendOutbox()).toBe(2);
    const stale = getGenerationOutboxById("exhausted-stale");
    expect(stale?.status).toBe("failed");
    expect(stale?.terminal_reason).toBe("max_attempts");
    expect(stale?.lease_owner).toBeNull();

    // Zombie pending rows with exhausted attempts transition to failed too —
    // they were previously unclaimable and stuck in 'pending' forever.
    const zombie = getGenerationOutboxById("exhausted-pending");
    expect(zombie?.status).toBe("failed");
    expect(zombie?.terminal_reason).toBe("max_attempts");
    expect(zombie?.completed_at).toBeNumber();
    expect(zombie?.lease_owner).toBeNull();
    expect(zombie?.lease_expires_at).toBeNull();

    // A fresh pending row is still claimable after the gate.
    insertOutbox({
      id: "fresh-after-gate",
      request_id: "req-fresh-after-gate",
      generation_id: "gen-fresh-after-gate",
      status: "pending",
      attempt_count: 0,
    });
    expect(claimNextEditAndSendOutbox()?.id).toBe("fresh-after-gate");
  });

  test("reconcile zombie sweep preserves an existing terminal_reason", async () => {
    insertOutbox({
      id: "zombie-reasoned",
      request_id: "req-zombie-reasoned",
      generation_id: "gen-zombie-reasoned",
      status: "pending",
      attempt_count: 9,
      terminal_reason: "duplicate_generation_id",
    });
    expect(reconcileEditAndSendOutbox()).toBe(1);
    const row = getGenerationOutboxById("zombie-reasoned");
    expect(row?.status).toBe("failed");
    expect(row?.terminal_reason).toBe("duplicate_generation_id");
  });

  test("dispatcher/startup", async () => {
    const started: string[] = [];
    setEditAndSendStartGeneration(async (input) => {
      started.push(input.generationId);
      return { generationId: input.generationId, status: "streaming" };
    });

    insertOutbox({
      id: "stale-claim",
      request_id: "req-stale",
      generation_id: "gen-stale",
      status: "claimed",
      lease_owner: "old",
      lease_expires_at: Date.now() - 10_000,
    });
    insertOutbox({
      id: "already-sent",
      request_id: "req-sent",
      generation_id: "gen-sent",
      status: "running",
      dispatched_at: Date.now() - 1_000,
    });
    insertMessage({ chat_id: "b1", created_at: Math.floor(Date.now() / 1000) });
    insertOutbox({
      id: "fresh",
      request_id: "req-fresh",
      generation_id: "gen-fresh",
      status: "pending",
    });
    // Both stale-claim and fresh rows reach dispatch, so each needs a real
    // cursor keyed to its own request/generation/branch chat.
    insertRequestCursor({ request_id: "req-stale", generation_id: "gen-stale" });
    insertRequestCursor({ request_id: "req-fresh", generation_id: "gen-fresh" });

    const dispatched = await recoverEditAndSendOutbox();
    expect(dispatched).toBe(2);
    expect(started.sort()).toEqual(["gen-fresh", "gen-stale"]);
    expect(getGenerationOutboxByRequest("u1", "c1", "req-sent")?.status).toBe("completed");
    expect(getGenerationOutboxByRequest("u1", "c1", "req-sent")?.terminal_reason).toBe("verified_output");
    expect(getGenerationOutboxByRequest("u1", "c1", "req-fresh")?.status).toBe("running");
    expect(getGenerationOutboxByRequest("u1", "c1", "req-stale")?.status).toBe("running");

    expect(await dispatchPendingEditAndSendOutbox()).toBe(0);
  });

  test("crash recovery verifies persisted output before completing running rows", async () => {
    const nowSec = Math.floor(Date.now() / 1000);

    // (a) running row + persisted assistant message -> completed/verified_output
    insertOutbox({
      id: "verified-row",
      request_id: "req-verified",
      generation_id: "gen-verified",
      branch_chat_id: "branch-verified",
      status: "running",
      lease_owner: "dead-worker",
      lease_expires_at: Date.now() + 30_000,
      attempt_count: 3,
      dispatched_at: Date.now() - 2_000,
    });
    insertMessage({ id: "asst-verified", chat_id: "branch-verified", created_at: nowSec });

    // (b) running row + NO message -> failed, no further provider attempt
    insertOutbox({
      id: "lost-row",
      request_id: "req-lost",
      generation_id: "gen-lost",
      branch_chat_id: "branch-lost",
      status: "running",
      lease_owner: "dead-worker",
      lease_expires_at: Date.now() + 30_000,
      attempt_count: 1,
      dispatched_at: Date.now() - 2_000,
    });

    await recoverEditAndSendOutbox();

    const verified = getGenerationOutboxById("verified-row");
    expect(verified?.status).toBe("completed");
    expect(verified?.terminal_reason).toBe("verified_output");

    const lost = getGenerationOutboxById("lost-row");
    expect(lost?.status).toBe("failed");
    expect(lost?.attempt_count).toBe(1);
    expect(lost?.lease_owner).toBeNull();
    expect(lost?.lease_expires_at).toBeNull();
    expect(lost?.last_error_code).toBe("output_not_verified");
    expect(lost?.next_attempt_at).toBeNull();
  });

  test("crash recovery marks swipe output verified via target message revision bump", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    insertMessage({
      id: "asst-swipe-target",
      chat_id: "branch-swipe",
      is_user: 0,
      revision: 4,
      created_at: nowSec - 600,
    });
    insertOutbox({
      id: "swipe-row",
      request_id: "req-swipe-recover",
      generation_id: "gen-swipe-recover",
      branch_chat_id: "branch-swipe",
      mode: "swipe",
      target_message_id: "asst-swipe-target",
      expected_version: 3,
      status: "running",
      lease_owner: "dead-worker",
      lease_expires_at: Date.now() + 30_000,
      attempt_count: 2,
      dispatched_at: Date.now() - 2_000,
    });

    await recoverEditAndSendOutbox();

    const row = getGenerationOutboxById("swipe-row");
    expect(row?.status).toBe("completed");
    expect(row?.terminal_reason).toBe("verified_output");
  });

  test("crash recovery fails rows whose attempts are exhausted without verified output", async () => {
    insertOutbox({
      id: "exhausted-row",
      request_id: "req-exhausted",
      generation_id: "gen-exhausted",
      branch_chat_id: "branch-exhausted",
      status: "running",
      lease_owner: "dead-worker",
      lease_expires_at: Date.now() + 30_000,
      attempt_count: 8,
      dispatched_at: Date.now() - 2_000,
    });

    await recoverEditAndSendOutbox();

    const row = getGenerationOutboxById("exhausted-row");
    expect(row?.status).toBe("failed");
    expect(row?.terminal_reason).toBe("output_not_verified");
    expect(row?.last_error_code).toBe("output_not_verified");
    expect(row?.lease_owner).toBeNull();
  });

  test("dispatches the validated committed context to startGeneration", async () => {
    const observed: Array<{ generationId: string; context?: unknown }> = [];
    setEditAndSendStartGeneration(async (input, options) => {
      observed.push({ generationId: input.generationId, context: options?.editAndSendContext });
      return { generationId: input.generationId, status: "streaming" };
    });

    insertOutbox({ id: "ctx-row", request_id: "req-ctx", generation_id: "gen-ctx" });
    insertRequestCursor({
      request_id: "req-ctx",
      generation_id: "gen-ctx",
      edited_message_id: "m1",
      cursor: {
        generationId: "gen-ctx",
        chatId: "b1",
        requestId: "req-ctx",
        mode: "normal",
        editAndSendContext: { editedUserMessageId: "m1", committedRevision: 5 },
      },
    });

    const running = await dispatchEditAndSendRequest("u1", "c1", "req-ctx");
    expect(running?.status).toBe("running");
    expect(observed).toEqual([
      { generationId: "gen-ctx", context: { editedUserMessageId: "m1", committedRevision: 5 } },
    ]);
  });

  test("invalid or absent committed cursors fail closed terminally without retry", async () => {
    const started: string[] = [];
    setEditAndSendStartGeneration(async (input) => {
      started.push(input.generationId);
      return { generationId: input.generationId, status: "streaming" };
    });

    const cases: Array<{ label: string; overrides: Parameters<typeof insertRequestCursor>[0] }> = [
      {
        label: "generation mismatch",
        overrides: {
          request_id: "req-gen-mismatch",
          generation_id: "gen-gen-mismatch",
          cursor: {
            generationId: "some-other-gen",
            chatId: "b1",
            requestId: "req-gen-mismatch",
            mode: "normal",
            editAndSendContext: { editedUserMessageId: "m1", committedRevision: 1 },
          },
        },
      },
      {
        label: "branch chat mismatch",
        overrides: {
          request_id: "req-chat-mismatch",
          generation_id: "gen-chat-mismatch",
          cursor: {
            generationId: "gen-chat-mismatch",
            chatId: "some-other-chat",
            requestId: "req-chat-mismatch",
            mode: "normal",
            editAndSendContext: { editedUserMessageId: "m1", committedRevision: 1 },
          },
        },
      },
      {
        label: "edited message mismatch",
        overrides: {
          request_id: "req-edited-mismatch",
          generation_id: "gen-edited-mismatch",
          cursor: {
            generationId: "gen-edited-mismatch",
            chatId: "b1",
            requestId: "req-edited-mismatch",
            mode: "normal",
            editAndSendContext: { editedUserMessageId: "some-other-message", committedRevision: 1 },
          },
        },
      },
      {
        label: "non-integer revision",
        overrides: {
          request_id: "req-bad-rev",
          generation_id: "gen-bad-rev",
          cursor: {
            generationId: "gen-bad-rev",
            chatId: "b1",
            requestId: "req-bad-rev",
            mode: "normal",
            editAndSendContext: { editedUserMessageId: "m1", committedRevision: 0 },
          },
        },
      },
      {
        label: "missing editAndSendContext",
        overrides: {
          request_id: "req-no-context",
          generation_id: "gen-no-context",
          cursor: {
            generationId: "gen-no-context",
            chatId: "b1",
            requestId: "req-no-context",
            mode: "normal",
          },
        },
      },
    ];

    for (const testCase of cases) {
      const requestId = testCase.overrides.request_id;
      insertOutbox({
        id: `row-${requestId}`,
        request_id: requestId,
        generation_id: testCase.overrides.generation_id ?? `gen-${requestId}`,
        status: "pending",
      });
      insertRequestCursor(testCase.overrides);

      const result = await dispatchEditAndSendRequest("u1", "c1", requestId);
      expect(result?.status).toBe("failed");
      expect(result?.last_error_code).toBe("edit_and_send_context_invalid");
      expect(result?.terminal_reason).toBe("edit_and_send_context_invalid");
      expect(result?.next_attempt_at).toBeNull();

      // A second dispatch attempt must not retry: the row is terminal `failed`.
      const retry = await dispatchEditAndSendRequest("u1", "c1", requestId);
      expect(retry?.status).toBe("failed");
      expect(retry?.last_error_code).toBe("edit_and_send_context_invalid");
    }

    // A row with NO request cursor at all fails closed too.
    insertOutbox({ id: "row-no-cursor", request_id: "req-no-cursor", generation_id: "gen-no-cursor" });
    const noCursor = await dispatchEditAndSendRequest("u1", "c1", "req-no-cursor");
    expect(noCursor?.status).toBe("failed");
    expect(noCursor?.last_error_code).toBe("edit_and_send_context_invalid");

    expect(started).toEqual([]);
  });

  test("context validation is scoped per user: another user's request cursor never authorizes this row", async () => {
    const started: string[] = [];
    setEditAndSendStartGeneration(async (input) => {
      started.push(input.generationId);
      return { generationId: input.generationId, status: "streaming" };
    });

    // The cursor exists, but for user "alpha" on the same chat/request id.
    insertOutbox({
      id: "cross-user-row",
      request_id: "req-cross-user",
      user_id: "beta",
      chat_id: "c1",
      branch_chat_id: "b1",
      generation_id: "gen-cross-user",
    });
    insertRequestCursor({
      user_id: "alpha",
      request_id: "req-cross-user",
      generation_id: "gen-cross-user",
    });

    const result = await dispatchEditAndSendRequest("beta", "c1", "req-cross-user");
    expect(result?.status).toBe("failed");
    expect(result?.last_error_code).toBe("edit_and_send_context_invalid");
    expect(started).toEqual([]);
  });
});
