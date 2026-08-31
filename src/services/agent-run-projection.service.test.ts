import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { EventType, type EventMessage } from "../ws/events";
import { eventBus } from "../ws/bus";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import { env } from "../env";
import {
  getAgentRunInspection,
  persistAgentRunInspection,
} from "./agent-activity-runs.service";
import {
  AgentRunStopUnavailableError,
  __test__mintChatRunCursor,
  __test__decodeChatRunCursor,
  appendAgentRunSnapshot,
  getAgentRun,
  getAgentRunChanges,
  getWorkspacePreview,
  publishAgentRunCommit,
  reconcileAgentRunProjections,
  registerAgentRunStopHandler,
  drainPendingAgentRunEventsForUser,
  emitAgentRunProjectionEvent,
  repairAgentRunProjectionFromInterruptedExecution,
  repairAgentRunProjectionFromReceipt,
  requestAgentRunStop,
  withAgentRunProjectionTransaction,
} from "./agent-run-projection.service";
import {
  reconcileAgentTurns,
  registerAgentTurnReceiptRepair,
  registerAgentTurnTerminalRecovery,
} from "./turn-execution.service";

const OWNER = "projection-owner";
const OTHER = "projection-other";
const AGENT_RUN_CHANGED = "AGENT_RUN_CHANGED" as EventType;

function seedUser(userId: string): void {
  getDb().query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)').run(
    userId,
    userId,
    `${userId}@example.test`,
  );
}

function seedChat(userId: string, chatId: string): void {
  getDb().query(
    "INSERT INTO chats (id, name, metadata, user_id) VALUES (?, ?, '{}', ?)",
  ).run(chatId, chatId, userId);
}

function seedRun(
  userId: string,
  chatId: string,
  turnId: string,
  generationId = turnId,
  state = "ASSEMBLE",
): void {
  getDb().query(
    `INSERT INTO agent_turn_executions
      (id, user_id, chat_id, generation_id, target_kind, target_chat_revision,
       mode, runtime_epoch, deadline_at, state, root_ledger_json,
       frame_capabilities_json, commit_key, expires_at)
     VALUES (?, ?, ?, ?, 'normal', 0, 'agentic', 1, 9999999999999,
             ?, '{}', '{}', ?, 9999999999999)`,
  ).run(turnId, userId, chatId, generationId, state, `commit-${turnId}`);
}
function connectedSocket(): ServerWebSocket<unknown> {
  return {
    readyState: 1,
    subscribe: () => {},
    unsubscribe: () => {},
  } as unknown as ServerWebSocket<unknown>;
}

function baseInput(userId: string, chatId: string, turnId: string, generationId = turnId) {
  return {
    userId,
    chatId,
    turnId,
    generationId,
    generationType: "normal" as const,
    status: "WORK" as const,
    activity: [{
      id: "root",
      parentId: null,
      kind: "root",
      actor: "root",
      phase: "WORK",
      status: "running",
      startedAt: 1,
      elapsedMs: 2,
      prose: "private work prose",
      arguments: "private args",
      result: "private result",
    }],
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, toolCalls: 0, childInvocations: 0 },
  };
}

// Cursor signing fails closed without an application auth secret, so tests
// configure one exactly as startup identity derivation does in production.
const TEST_AUTH_SECRET = "agent-run-projection-test-auth-secret";
let priorProcessAuthSecret: string | undefined;

beforeEach(async () => {
  priorProcessAuthSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = TEST_AUTH_SECRET;
  closeDatabase();
  initDatabase(":memory:");
  await runMigrations(getDb());
  seedUser(OWNER);
  seedUser(OTHER);
});

afterEach(() => {
  if (priorProcessAuthSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = priorProcessAuthSecret;
  closeDatabase();
});

describe("AgentRunPublicV2 projection and cursor", () => {
  test("allocates a strictly increasing per-chat sequence and preserves run revisions", () => {
    seedChat(OWNER, "chat-sequence");
    seedRun(OWNER, "chat-sequence", "turn-a");
    seedRun(OWNER, "chat-sequence", "turn-b");

    const first = withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, baseInput(OWNER, "chat-sequence", "turn-a")));
    const second = withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-sequence", "turn-b"),
      revision: 4,
    }));
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(second.revision).toBe(4);

    const stale = withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-sequence", "turn-b"),
      revision: 3,
    }));
    expect(stale.sequence).toBe(2);
    expect(stale.revision).toBe(4);
    const delta = getAgentRunChanges(OWNER, "chat-sequence", __test__mintChatRunCursor(OWNER, "chat-sequence", 0).token);
    expect(delta?.events.map((event) => event.sequence)).toEqual([1, 2]);
  });
  test("maps internal completion chronology to the monotonic public lifecycle", () => {
    const chatId = "chat-public-phase-order";
    const turnId = "turn-public-phase-order";
    seedChat(OWNER, chatId);
    seedRun(OWNER, chatId, turnId);

    const workPhases = (["WORK", "COMPLETE", "RENDER", "PREPARE_COMMIT"] as const).map((status) => (
      withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
        ...baseInput(OWNER, chatId, turnId),
        status,
      })).run.workPhase
    ));
    expect(workPhases).toEqual(["WORK", "PREPARE_COMMIT", "RENDER", "COMMIT"]);

    const committing = withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, chatId, turnId),
      status: "COMMITTING",
    }));
    expect({
      workPhase: committing.run.workPhase,
      workStatus: committing.run.workStatus,
      workOutcome: committing.run.workOutcome,
    }).toEqual({ workPhase: "COMMIT", workStatus: "running", workOutcome: null });
    const stored = getAgentRun(OWNER, turnId);
    if (!stored) throw new Error("public phase projection was not persisted");
    expect({
      workPhase: stored.workPhase,
      workStatus: stored.workStatus,
      workOutcome: stored.workOutcome,
    }).toEqual({ workPhase: "COMMIT", workStatus: "running", workOutcome: null });
  });

  test("returns the processed page watermark and resumes after more than 128 events", () => {
    seedChat(OWNER, "chat-paged-delta");
    seedRun(OWNER, "chat-paged-delta", "turn-paged-delta");
    for (let revision = 1; revision <= 130; revision += 1) {
      withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
        ...baseInput(OWNER, "chat-paged-delta", "turn-paged-delta"),
        revision,
      }));
    }

    const first = getAgentRunChanges(
      OWNER,
      "chat-paged-delta",
      __test__mintChatRunCursor(OWNER, "chat-paged-delta", 0).token,
    );
    expect(first?.events).toHaveLength(128);
    expect(first?.lastSequence).toBe(first?.events.at(-1)?.sequence);
    expect(first?.cursorSequence).toBe(first?.lastSequence);
    expect(first?.tailSequence).toBe(130);
    expect(first?.hasMore).toBe(true);
    expect(__test__decodeChatRunCursor(first!.cursor.token).claims.s).toBe(first!.lastSequence);

    const second = getAgentRunChanges(OWNER, "chat-paged-delta", first!.cursor.token);
    expect(second?.events[0]?.sequence).toBe(129);
    expect(second?.events.at(-1)?.sequence).toBe(130);
    expect(second?.lastSequence).toBe(130);
    expect(second?.tailSequence).toBe(130);
    expect(second?.hasMore).toBe(false);

  });
  test("flushes websocket handoff only after the owning transaction commits", async () => {
    seedChat(OWNER, "chat-events");
    seedRun(OWNER, "chat-events", "turn-events");
    let emitted = 0;
    const emittedSignal = Promise.withResolvers<void>();
    const remove = eventBus.onInternal(AGENT_RUN_CHANGED, () => {
      emitted += 1;
      emittedSignal.resolve();
    });
    try {
      expect(() => withAgentRunProjectionTransaction((db) => {
        appendAgentRunSnapshot(db, baseInput(OWNER, "chat-events", "turn-events"));
        throw new Error("rollback projection");
      })).toThrow("rollback projection");
      expect(emitted).toBe(0);
      withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, baseInput(OWNER, "chat-events", "turn-events")));
      await emittedSignal.promise;
      expect(emitted).toBe(1);
    } finally {
      remove();
    }
  });

  test("publishes only redacted projection fields to the owner's browser topic", () => {
    seedChat(OWNER, "chat-browser-projection");
    seedRun(OWNER, "chat-browser-projection", "turn-browser-projection");
    const browserEvents: EventMessage[] = [];
    const server = {
      publish(topic: string, data: string): number {
        if (topic === `user:${OWNER}`) browserEvents.push(JSON.parse(data) as EventMessage);
        return topic === `user:${OWNER}` ? 1 : 0;
      },
    };
    eventBus.setServer(server as Parameters<typeof eventBus.setServer>[0]);
    try {
      withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(
        db,
        baseInput(OWNER, "chat-browser-projection", "turn-browser-projection"),
      ));
      expect(browserEvents).toHaveLength(1);
      expect(browserEvents[0].event).toBe(AGENT_RUN_CHANGED);
      expect(browserEvents[0].userId).toBe(OWNER);
      const serialized = JSON.stringify(browserEvents[0].payload);
      expect(serialized).not.toContain("private work prose");
      expect(serialized).not.toContain("private args");
      expect(serialized).not.toContain("private result");
      expect(serialized).not.toContain("reasoning");
      expect(serialized).not.toContain("renderGuidance");
    } finally {
      eventBus.setServer(null as unknown as Parameters<typeof eventBus.setServer>[0]);
    }
  });

  test("projects executed WORK tool and child counts without private payloads", () => {
    seedChat(OWNER, "chat-work-usage");
    seedRun(OWNER, "chat-work-usage", "turn-work-usage");
    const result = withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-work-usage", "turn-work-usage"),
      status: "COMMITTED",
      activity: [
        {
          id: "root",
          parentId: null,
          kind: "root",
          actor: "root",
          phase: "COMMITTED",
          status: "completed",
          startedAt: 1,
          elapsedMs: 2,
        },
        {
          id: "tool-a",
          parentId: "root",
          kind: "tool",
          actor: "tool",
          phase: "WORK",
          status: "completed",
          startedAt: 1,
          elapsedMs: 1,
          toolId: "chat_search_history",
          prose: "private work prose",
          arguments: { query: "secret" },
          result: "private result",
        },
        {
          id: "child-a",
          parentId: "root",
          kind: "child",
          actor: "child",
          phase: "WORK",
          status: "completed",
          startedAt: 1,
          elapsedMs: 1,
          profileId: "writer",
        },
      ],
      usage: { inputTokens: 17, outputTokens: 3, totalTokens: 20, toolCalls: 2, childInvocations: 1 },
    }));
    expect(result.run.usage).toEqual({
      inputTokens: 17,
      outputTokens: 3,
      totalTokens: 20,
      toolCalls: 2,
      childInvocations: 1,
    });
    const encoded = JSON.stringify(result.run);
    expect(encoded).not.toContain("private work prose");
    expect(encoded).not.toContain("secret");
    expect(encoded).not.toContain("private result");
    expect(result.run.activity.map((node) => node.kind)).toEqual(["root", "tool", "child"]);
  });


  test("replays only after an authenticated reconnect subscriber accepts delivery", async () => {
    seedChat(OWNER, "chat-replay");
    seedRun(OWNER, "chat-replay", "turn-replay");
    let localEvents = 0;
    const emittedSignal = Promise.withResolvers<void>();
    const remove = eventBus.onInternal(AGENT_RUN_CHANGED, () => {
      localEvents += 1;
      emittedSignal.resolve();
    });
    const socket = connectedSocket();
    try {
      // Bypass the live wrapper to model a process dying after SQLite commit
      // and before a websocket handoff.
      const committed = getDb().transaction(() => publishAgentRunCommit(getDb(), {
        ...baseInput(OWNER, "chat-replay", "turn-replay"),
        status: "COMMITTED",
      }))();
      expect(committed.run).toMatchObject({
        workPhase: "TERMINAL",
        workStatus: "terminal",
        workOutcome: "completed",
      });
      getDb().query(
        `UPDATE agent_chat_events
            SET delivery_state = 'leased',
                delivery_lease_token = 'crashed-process',
                delivery_lease_expires_at = unixepoch() + 30
          WHERE turn_id = ?`,
      ).run("turn-replay");

      const withoutSubscriber = drainPendingAgentRunEventsForUser(OWNER, getDb());
      expect(withoutSubscriber).toMatchObject({ inspected: 1, emitted: 0, skipped: 0 });
      expect(getDb().query(
        "SELECT delivery_state FROM agent_chat_events WHERE turn_id = ?",
      ).get("turn-replay")).toEqual({ delivery_state: "pending" });

      eventBus.addClient(socket, OWNER, "replay-session");
      const first = drainPendingAgentRunEventsForUser(OWNER, getDb());
      expect(first).toMatchObject({ inspected: 1, emitted: 1, skipped: 0 });
      expect(getDb().query(
        "SELECT delivery_state FROM agent_chat_events WHERE turn_id = ?",
      ).get("turn-replay")).toEqual({ delivery_state: "delivered" });
      await emittedSignal.promise;
      // EventBus listeners are local in-process observers and still see both
      // attempts; the outbox return/state above is the websocket delivery proof.
      expect(localEvents).toBe(2);
      const second = drainPendingAgentRunEventsForUser(OWNER, getDb());
      expect(second).toMatchObject({ inspected: 0, emitted: 0, skipped: 0 });
      expect(getDb().query(
        "SELECT delivery_state FROM agent_chat_events WHERE turn_id = ?",
      ).get("turn-replay")).toEqual({ delivery_state: "delivered" });
      expect(localEvents).toBe(2);
    } finally {
      eventBus.removeClient(socket);
      remove();
    }
  });
  test("fails closed when terminal outbox delivery columns are not migrated", () => {
    const partialTable = "chat-partial-outbox";
    getDb().run("DROP TABLE agent_chat_events");
    getDb().run(
      `CREATE TABLE agent_chat_events (
        user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        turn_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        run_revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        event_kind TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        terminal_handoff_json TEXT,
        omission_json TEXT
      )`,
    );
    const event = {
      event: AGENT_RUN_CHANGED,
      userId: OWNER,
      payload: {
        version: 2,
        chatId: partialTable,
        sequence: 1,
        run: { workStatus: "terminal" },
      },
    } as unknown as Parameters<typeof emitAgentRunProjectionEvent>[0];
    expect(emitAgentRunProjectionEvent(event, getDb())).toBe(false);
    const malformedTerminal = {
      ...event,
      userId: "",
      payload: {
        ...event.payload,
        chatId: "",
        sequence: 0,
      },
    } as unknown as Parameters<typeof emitAgentRunProjectionEvent>[0];
    expect(emitAgentRunProjectionEvent(malformedTerminal, getDb())).toBe(false);
    expect(drainPendingAgentRunEventsForUser(OWNER, getDb())).toEqual({
      inspected: 0,
      emitted: 0,
      skipped: 0,
    });
  });
  test("drains terminal outbox rows across bounded batches", () => {
    seedChat(OWNER, "chat-replay-batch");
    const rowCount = 257;
    const socket = connectedSocket();
    eventBus.addClient(socket, OWNER, "replay-batch-session");
    try {
      for (let index = 0; index < rowCount; index += 1) {
        const turnId = `turn-replay-batch-${index}`;
        seedRun(OWNER, "chat-replay-batch", turnId);
        getDb().transaction(() => publishAgentRunCommit(getDb(), {
          ...baseInput(OWNER, "chat-replay-batch", turnId),
          status: "COMMITTED",
        }))();
      }

      const replayed = drainPendingAgentRunEventsForUser(OWNER, getDb());
      expect(replayed.inspected).toBe(rowCount);
      expect(replayed.emitted).toBe(rowCount);
      expect(drainPendingAgentRunEventsForUser(OWNER, getDb()).emitted).toBe(0);
    } finally {
      eventBus.removeClient(socket);
    }
  });


  test("repairs a missing terminal projection from the receipt without private render data", () => {
    seedChat(OWNER, "chat-repair");
    seedRun(OWNER, "chat-repair", "turn-repair", "generation-repair");
    getDb().query(
      `INSERT INTO messages
        (id, chat_id, index_in_chat, is_user, name, content, swipes, generation_revision)
       VALUES (?, ?, 0, 0, 'assistant', 'committed', ?, 7)`,
    ).run("message-repair", "chat-repair", JSON.stringify(["first", "second"]));
    const execution = {
      id: "turn-repair",
      userId: OWNER,
      generationId: "generation-repair",
      targetKind: "normal" as const,
      chatId: "chat-repair",
      targetMessageId: "message-repair",
      targetSwipeId: 1,
      targetMessageRevision: 1,
      createdAt: 1,
      updatedAt: 2,
    };
    const receipt = { id: "receipt-repair", messageId: "message-repair", swipeId: 1, createdAt: 3 };
    const repaired = getDb().transaction(() => repairAgentRunProjectionFromReceipt(
      getDb(),
      execution,
      receipt,
    ))();
    expect(repaired.run).toMatchObject({
      runId: "generation-repair",
      turnId: "turn-repair",
      generationId: "generation-repair",
      workPhase: "TERMINAL",
      workStatus: "terminal",
      workOutcome: "completed",
    });
    expect(repaired.run.terminalHandoff).toMatchObject({
      messageId: "message-repair",
      swipeId: 1,
      messageRevision: 7,
      swipeRevision: 7,
    });
    const stored = getDb().query(
      "SELECT snapshot_json, terminal_handoff_json FROM agent_run_projections WHERE turn_id = ?",
    ).get("turn-repair") as { snapshot_json: string; terminal_handoff_json: string | null };
    const durable = `${stored.snapshot_json}${stored.terminal_handoff_json ?? ""}`;
    expect(durable).not.toContain("renderGuidance");
    expect(JSON.parse(stored.snapshot_json)).toMatchObject({
      runId: "generation-repair",
      turnId: "turn-repair",
      generationId: "generation-repair",
    });
    expect(getDb().query(
      "SELECT run_id, turn_id, generation_id FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?",
    ).get(OWNER, "turn-repair")).toEqual({
      run_id: "generation-repair",
      turn_id: "turn-repair",
      generation_id: "generation-repair",
    });
    expect(durable).not.toContain("private work");
    expect(durable).not.toContain("reasoning");

    // Removing only the durable event models a second crash/corruption
    // window. Receipt repair must recreate the event without replaying commit.
    getDb().query("DELETE FROM agent_chat_events WHERE turn_id = ?").run("turn-repair");
    const repairedEvent = getDb().transaction(() => repairAgentRunProjectionFromReceipt(
      getDb(),
      execution,
      receipt,
    ))();
    expect(repairedEvent.changed).toBe(true);
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_chat_events WHERE turn_id = ?",
    ).get("turn-repair")).toEqual({ count: 1 });

    // A repeated repair is a no-op and cannot allocate another chat sequence.
    const repeated = getDb().transaction(() => repairAgentRunProjectionFromReceipt(
      getDb(),
      execution,
      receipt,
    ))();
    expect(repeated.changed).toBe(false);
  });
  test("startup receipt repair upgrades COMMIT_FAILED projection_unavailable to COMMITTED", () => {
    const chatId = "chat-commit-failure-recovery";
    const turnId = "turn-commit-failure-recovery";
    const messageId = "message-commit-failure-recovery";
    const workspaceId = "workspace-commit-failure-recovery";
    seedChat(OWNER, chatId);
    seedRun(OWNER, chatId, turnId, turnId, "COMMITTED");
    getDb().query(
      `INSERT INTO messages
        (id, chat_id, index_in_chat, is_user, name, content, swipes, generation_revision)
       VALUES (?, ?, 0, 0, 'assistant', 'committed', ?, 7)`,
    ).run(messageId, chatId, JSON.stringify(["committed"]));
    getDb().query(
      `INSERT INTO agent_turn_workspaces
        (workspace_id, turn_id, execution_id, user_id, chat_id, objective,
         constraints_json, state, operation_caps_json, field_caps_json, retention,
         expires_at, quota_tasks, quota_records, quota_submissions, quota_artifacts,
         quota_bytes)
       VALUES (?, ?, ?, ?, ?, '', '{}', 'frozen', '{}', '{}', 'turn_terminal',
               9999999999, 0, 0, 0, 0, 1024)`,
    ).run(workspaceId, turnId, turnId, OWNER, chatId);
    getDb().query(
      `UPDATE agent_turn_executions
          SET workspace_id = ?, target_message_id = ?, target_swipe_id = ?
        WHERE id = ?`,
    ).run(workspaceId, messageId, 0, turnId);
    getDb().query(
      `INSERT INTO agent_turn_commit_receipts
        (receipt_id, turn_id, execution_id, workspace_id, user_id, chat_id,
         commit_key, idempotency_key, state, summary_digest, summary_json,
         message_id, swipe_id, committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, '{}', ?, 0, 3)`,
    ).run(
      "receipt-commit-failure-recovery",
      turnId,
      turnId,
      workspaceId,
      OWNER,
      chatId,
      `commit-${turnId}`,
      `commit-${turnId}`,
      "0".repeat(64),
      messageId,
    );
    const failedInspection = persistAgentRunInspection({
      userId: OWNER,
      chatId,
      attemptId: turnId,
      previousAttemptId: null,
      runId: turnId,
      turnSessionId: turnId,
      generationId: turnId,
      generationType: "normal",
      targetMessageId: messageId,
      targetSwipeId: 0,
      hostCorrelationId: `agentic:${turnId}:${turnId}`,
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "failed",
      reason: "unavailable",
      startedAt: 1,
      updatedAt: 2,
      terminalAt: 2,
      terminalReceipt: {
        receiptId: "receipt-commit-failure-recovery",
        messageId: undefined,
        swipeId: undefined,
        summary: { source: "coordinator-test" },
        error: { code: "projection_unavailable" },
      },
      markers: [{
        id: "failed-terminal-evidence",
        kind: "recovered_duplicate",
        scope: "run",
        firstSequence: 1,
        lastSequence: 1,
        recoverable: true,
        detail: "original failed terminal evidence",
      }],
    });
    const failedReceiptRow = getDb().query(
      "SELECT terminal_receipt_json FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?",
    ).get(OWNER, turnId) as { terminal_receipt_json?: string | null } | null;
    expect(JSON.parse(failedReceiptRow?.terminal_receipt_json ?? "{}")).toMatchObject({
      receiptId: "receipt-commit-failure-recovery",
      messageId: {},
      swipeId: {},
    });
    expect(failedInspection).toMatchObject({
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "failed",
      activity: { reconciliation: "authoritative" },
    });
    const failedAudit = getDb().query(
      `SELECT payload_json
         FROM agent_run_audit_records
        WHERE user_id = ? AND attempt_id = ? AND event_id = ?
        LIMIT 1`,
    ).get(OWNER, turnId, "failed-terminal-evidence") as { payload_json: string } | null;
    expect(failedAudit?.payload_json).toContain("original failed terminal evidence");
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, chatId, turnId),
      status: "COMMIT_FAILED",
      error: {
        code: "projection_unavailable",
        recoveryEligible: true,
        recoveryAction: "resync",
      },
      terminalHandoff: {
        version: 2,
        committed: false,
        messageId: null,
        swipeId: null,
        messageRevision: null,
        swipeRevision: null,
      },
    }));
    const before = getAgentRun(OWNER, turnId, chatId);
    expect(before).toMatchObject({
      workPhase: "TERMINAL",
      workStatus: "terminal",
      workOutcome: "failed",
      error: {
        code: "projection_unavailable",
        recoveryEligible: true,
        recoveryAction: "resync",
      },
      terminalHandoff: {
        committed: false,
        messageId: null,
        swipeId: null,
      },
    });
    expect(getDb().query(
      `SELECT COUNT(*) AS count
         FROM agent_chat_events
        WHERE user_id = ? AND chat_id = ? AND turn_id = ? AND generation_id = ?`,
    ).get(OWNER, chatId, turnId, turnId)).toEqual({ count: 1 });

    registerAgentTurnReceiptRepair((execution, receipt) => {
      repairAgentRunProjectionFromReceipt(getDb(), execution, receipt);
    });
    try {
      reconcileAgentTurns(getDb());
      const recovered = getAgentRun(OWNER, turnId, chatId);
      if (!recovered) {
        throw new Error("Expected recovered agent run projection");
      }
      expect(recovered).toMatchObject({
        workPhase: "TERMINAL",
        workStatus: "terminal",
        workOutcome: "completed",
        attemptLineage: {
          target: {
            chatId,
            generationType: "normal",
            messageId,
            swipeId: 0,
          },
        },
        error: {
          code: "projection_unavailable",
          recoveryEligible: true,
          recoveryAction: "resync",
          target: {
            chatId,
            generationType: "normal",
            messageId,
            swipeId: 0,
          },
        },
        target: { messageId, swipeId: 0 },
        terminalHandoff: {
          committed: true,
          messageId,
          swipeId: 0,
          messageRevision: 7,
          swipeRevision: 7,
        },
      });
      expect(getDb().query(
        "SELECT target_message_id, target_swipe_id FROM agent_activity_runs WHERE generation_id = ?",
      ).get(turnId)).toEqual({ target_message_id: messageId, target_swipe_id: 0 });
      const activitySnapshotRow = getDb().query(
        "SELECT snapshot_json FROM agent_activity_runs WHERE generation_id = ?",
      ).get(turnId) as { snapshot_json: string };
      expect(JSON.parse(activitySnapshotRow.snapshot_json)).toMatchObject({ snapshot: { status: "completed" } });
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM messages WHERE id = ? AND chat_id = ?",
      ).get(messageId, chatId)).toEqual({ count: 1 });
      const repairedEvents = getDb().query(
        `SELECT sequence, status, run_revision, event_kind, snapshot_json
           FROM agent_chat_events
          WHERE user_id = ? AND chat_id = ? AND turn_id = ? AND generation_id = ?
          ORDER BY sequence ASC`,
      ).all(OWNER, chatId, turnId, turnId) as Array<{
        sequence: number;
        status: string;
        run_revision: number;
        event_kind: string;
        snapshot_json: string;
      }>;
      expect(repairedEvents).toHaveLength(2);
      expect(repairedEvents.map(({ status, event_kind }) => [status, event_kind])).toEqual([
        ["COMMIT_FAILED", "terminal"],
        ["COMMITTED", "terminal"],
      ]);
      const latestEvent = repairedEvents[repairedEvents.length - 1];
      expect(latestEvent?.run_revision).toBe(recovered.revision);
      expect(JSON.parse(latestEvent?.snapshot_json ?? "{}")).toMatchObject({
        workOutcome: "completed",
        terminalHandoff: {
          committed: true,
          messageId,
          swipeId: 0,
          messageRevision: 7,
          swipeRevision: 7,
        },
      });
      const repairedInspection = getAgentRunInspection(OWNER, turnId, chatId);
      expect(repairedInspection).toMatchObject({
        lifecycle: "TERMINAL",
        status: "terminal",
        outcome: "completed",
        reason: "reconciled",
        target: { messageId, swipeId: 0 },
        committedTarget: { messageId, swipeId: 0 },
        activity: { reconciliation: "recovered" },
      });
      expect(repairedInspection?.markers).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "late_event",
          detail: expect.stringContaining("reconciled"),
        }),
      ]));
      expect(getDb().query(
        `SELECT lifecycle, status, outcome, reason, terminal, reconciliation_state
           FROM agent_run_attempts
          WHERE user_id = ? AND attempt_id = ?`,
      ).get(OWNER, turnId)).toEqual({
        lifecycle: "TERMINAL",
        status: "terminal",
        outcome: "completed",
        reason: "reconciled",
        terminal: 1,
        reconciliation_state: "recovered",
      });
      const repairedReceipt = getDb().query(
        "SELECT terminal_receipt_json FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?",
      ).get(OWNER, turnId) as { terminal_receipt_json?: string | null } | null;
      expect(repairedReceipt?.terminal_receipt_json).toContain("projection_unavailable");
      const firstAuditRow = getDb().query(
        `SELECT COUNT(*) AS count
           FROM agent_run_audit_records
          WHERE user_id = ? AND attempt_id = ?`,
      ).get(OWNER, turnId) as { count?: unknown } | null;
      const firstAuditCount = Number(firstAuditRow?.count ?? 0);
      expect(firstAuditCount).toBeGreaterThan(0);
      expect(getDb().query(
        `SELECT COUNT(*) AS count
           FROM agent_run_audit_records
          WHERE user_id = ? AND attempt_id = ? AND event_id = ?`,
      ).get(OWNER, turnId, "failed-terminal-evidence")).toEqual({ count: 1 });
      expect(getDb().query(
        `SELECT COUNT(*) AS count
           FROM agent_run_audit_records
          WHERE user_id = ? AND attempt_id = ? AND event_id = ?`,
      ).get(OWNER, turnId, `projection:${turnId}:late_event`)).toEqual({ count: 1 });
      const firstRevision = recovered?.revision;

      reconcileAgentTurns(getDb());
      const replayed = getAgentRun(OWNER, turnId, chatId);
      expect(replayed?.revision).toBe(firstRevision);
      expect(replayed).toMatchObject({
        workOutcome: "completed",
        error: { code: "projection_unavailable" },
        terminalHandoff: { committed: true, messageId, swipeId: 0 },
      });
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM messages WHERE id = ? AND chat_id = ?",
      ).get(messageId, chatId)).toEqual({ count: 1 });
      expect(getDb().query(
        `SELECT COUNT(*) AS count
           FROM agent_chat_events
          WHERE user_id = ? AND chat_id = ? AND turn_id = ? AND generation_id = ?`,
      ).get(OWNER, chatId, turnId, turnId)).toEqual({ count: 2 });
      const replayInspection = getAgentRunInspection(OWNER, turnId, chatId);
      expect(replayInspection?.outcome).toBe("completed");
      expect(replayInspection?.markers).toEqual(repairedInspection?.markers);
      const secondAuditRow = getDb().query(
        `SELECT COUNT(*) AS count
           FROM agent_run_audit_records
          WHERE user_id = ? AND attempt_id = ?`,
      ).get(OWNER, turnId) as { count?: unknown } | null;
      expect(Number(secondAuditRow?.count ?? 0)).toBe(firstAuditCount);
      expect(getDb().query(
        `SELECT COUNT(*) AS count
           FROM agent_run_audit_records
          WHERE user_id = ? AND attempt_id = ? AND event_id = ?`,
      ).get(OWNER, turnId, `projection:${turnId}:late_event`)).toEqual({ count: 1 });
    } finally {
      registerAgentTurnReceiptRepair(null);
    }
  });
  test("leaves a COMMIT_FAILED projection untouched for mismatched receipt target or receipt identity", () => {
    const chatId = "chat-commit-failure-receipt-mismatch";
    const turnId = "turn-commit-failure-receipt-mismatch";
    const messageId = "message-commit-failure-receipt-mismatch";
    const otherMessageId = "message-commit-failure-receipt-other";
    seedChat(OWNER, chatId);
    seedRun(OWNER, chatId, turnId, turnId, "COMMITTED");
    getDb().query(
      `INSERT INTO messages
        (id, chat_id, index_in_chat, is_user, name, content, swipes, generation_revision)
       VALUES (?, ?, 0, 0, 'assistant', 'committed', ?, 4)`,
    ).run(messageId, chatId, JSON.stringify(["committed"]));
    getDb().query(
      `INSERT INTO messages
        (id, chat_id, index_in_chat, is_user, name, content, swipes, generation_revision)
       VALUES (?, ?, 1, 0, 'assistant', 'other', ?, 4)`,
    ).run(otherMessageId, chatId, JSON.stringify(["other"]));
    const failedInspection = persistAgentRunInspection({
      userId: OWNER,
      chatId,
      attemptId: turnId,
      runId: turnId,
      turnSessionId: turnId,
      generationId: turnId,
      generationType: "swipe",
      targetMessageId: messageId,
      targetSwipeId: 0,
      hostCorrelationId: `agentic:${turnId}:${turnId}`,
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "failed",
      reason: "unavailable",
      startedAt: 1,
      updatedAt: 2,
      terminalAt: 2,
      terminalReceipt: {
        receiptId: `stored:${turnId}`,
        messageId: undefined,
        swipeId: undefined,
        summary: { source: "mismatch-test" },
        error: { code: "projection_unavailable" },
      },
      markers: [{
        id: "failed-terminal-evidence",
        kind: "recovered_duplicate",
        scope: "run",
        firstSequence: 1,
        lastSequence: 1,
        recoverable: true,
        detail: "original failed terminal evidence",
      }],
    });
    expect(failedInspection?.outcome).toBe("failed");
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, chatId, turnId),
      generationType: "swipe",
      targetMessageId: messageId,
      targetSwipeId: 0,
      status: "COMMIT_FAILED",
      error: {
        code: "projection_unavailable",
        recoveryEligible: true,
        recoveryAction: "resync",
      },
      terminalHandoff: {
        version: 2,
        committed: false,
        messageId,
        swipeId: 0,
        messageRevision: null,
        swipeRevision: null,
      },
    }));
    const execution = {
      id: turnId,
      userId: OWNER,
      generationId: turnId,
      targetKind: "swipe" as const,
      chatId,
      targetMessageId: messageId,
      targetSwipeId: 0,
      targetMessageRevision: 4,
      createdAt: 1,
      updatedAt: 2,
    };
    const beforeProjection = getDb().query(
      `SELECT status, phase, revision, sequence, target_message_id, target_swipe_id,
              snapshot_json, terminal_handoff_json
         FROM agent_run_projections
        WHERE user_id = ? AND chat_id = ? AND turn_id = ?`,
    ).get(OWNER, chatId, turnId);
    const beforeEvents = getDb().query(
      `SELECT sequence, status, run_revision, event_kind, snapshot_json,
              terminal_handoff_json
         FROM agent_chat_events
        WHERE user_id = ? AND chat_id = ? AND turn_id = ?
        ORDER BY sequence ASC`,
    ).all(OWNER, chatId, turnId);
    const beforeInspection = getDb().query(
      `SELECT lifecycle, status, outcome, reason, terminal, reconciliation_state,
              terminal_receipt_json
         FROM agent_run_attempts
        WHERE user_id = ? AND attempt_id = ?`,
    ).get(OWNER, turnId);
    const beforeAuditCountRow = getDb().query(
      `SELECT COUNT(*) AS count
         FROM agent_run_audit_records
        WHERE user_id = ? AND attempt_id = ?`,
    ).get(OWNER, turnId) as { count?: unknown } | null;
    const beforeAuditCount = Number(beforeAuditCountRow?.count ?? 0);
    expect(() => getDb().transaction(() => repairAgentRunProjectionFromReceipt(
      getDb(),
      execution,
      { id: `requested:${turnId}`, messageId: otherMessageId, swipeId: 0, createdAt: 3 },
    ))()).toThrow("target conflicts with failed projection");
    expect(getDb().query(
      `SELECT status, phase, revision, sequence, target_message_id, target_swipe_id,
              snapshot_json, terminal_handoff_json
         FROM agent_run_projections
        WHERE user_id = ? AND chat_id = ? AND turn_id = ?`,
    ).get(OWNER, chatId, turnId)).toEqual(beforeProjection);
    expect(getDb().query(
      `SELECT sequence, status, run_revision, event_kind, snapshot_json,
              terminal_handoff_json
         FROM agent_chat_events
        WHERE user_id = ? AND chat_id = ? AND turn_id = ?
        ORDER BY sequence ASC`,
    ).all(OWNER, chatId, turnId)).toEqual(beforeEvents);
    expect(getDb().query(
      `SELECT lifecycle, status, outcome, reason, terminal, reconciliation_state,
              terminal_receipt_json
         FROM agent_run_attempts
        WHERE user_id = ? AND attempt_id = ?`,
    ).get(OWNER, turnId)).toEqual(beforeInspection);
    const afterAuditCountRow = getDb().query(
      `SELECT COUNT(*) AS count
         FROM agent_run_audit_records
        WHERE user_id = ? AND attempt_id = ?`,
    ).get(OWNER, turnId) as { count?: unknown } | null;
    expect(Number(afterAuditCountRow?.count ?? 0)).toBe(beforeAuditCount);
    expect(() => getDb().transaction(() => repairAgentRunProjectionFromReceipt(
      getDb(),
      execution,
      { id: `requested:${turnId}`, messageId, swipeId: 0, createdAt: 3 },
    ))()).toThrow("agent run inspection repair conflicts with receipt identity");
    expect(getDb().query(
      `SELECT status, phase, revision, sequence, target_message_id, target_swipe_id,
              snapshot_json, terminal_handoff_json
         FROM agent_run_projections
        WHERE user_id = ? AND chat_id = ? AND turn_id = ?`,
    ).get(OWNER, chatId, turnId)).toEqual(beforeProjection);
    expect(getDb().query(
      `SELECT sequence, status, run_revision, event_kind, snapshot_json,
              terminal_handoff_json
         FROM agent_chat_events
        WHERE user_id = ? AND chat_id = ? AND turn_id = ?
        ORDER BY sequence ASC`,
    ).all(OWNER, chatId, turnId)).toEqual(beforeEvents);
    expect(getDb().query(
      `SELECT lifecycle, status, outcome, reason, terminal, reconciliation_state,
              terminal_receipt_json
         FROM agent_run_attempts
        WHERE user_id = ? AND attempt_id = ?`,
    ).get(OWNER, turnId)).toEqual(beforeInspection);
    const secondAfterAuditCountRow = getDb().query(
      `SELECT COUNT(*) AS count
         FROM agent_run_audit_records
        WHERE user_id = ? AND attempt_id = ?`,
    ).get(OWNER, turnId) as { count?: unknown } | null;
    expect(Number(secondAfterAuditCountRow?.count ?? 0)).toBe(beforeAuditCount);
  });
  test("rolls back receipt repair when its required inspection marker is unavailable", () => {
    const chatId = "chat-inspection-repair-fail";
    const turnId = "turn-inspection-repair-fail";
    seedChat(OWNER, chatId);
    seedRun(OWNER, chatId, turnId);
    getDb().query(
      `INSERT INTO agent_run_source_deletions
        (user_id, attempt_id, chat_id, source_kind, created_at, source_deleted_at)
       VALUES (?, ?, ?, 'chat', 1, 1)`,
    ).run(OWNER, turnId, chatId);

    expect(() => withAgentRunProjectionTransaction((db) => publishAgentRunCommit(db, {
      ...baseInput(OWNER, chatId, turnId),
      status: "COMMITTED",
      receiptId: "receipt-inspection-repair-fail",
      receiptRepair: true,
    }))).toThrow("agent run inspection repair projection unavailable");
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_run_projections WHERE turn_id = ?",
    ).get(turnId)).toEqual({ count: 0 });
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_chat_events WHERE turn_id = ?",
    ).get(turnId)).toEqual({ count: 0 });
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_activity_runs WHERE generation_id = ?",
    ).get(turnId)).toEqual({ count: 0 });
  });


  test("returns bounded full resync for tampered, cross-chat, and expired cursors", () => {
    seedChat(OWNER, "chat-resync");
    seedChat(OWNER, "chat-other");
    seedRun(OWNER, "chat-resync", "turn-resync");
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, baseInput(OWNER, "chat-resync", "turn-resync")));

    const valid = __test__mintChatRunCursor(OWNER, "chat-resync", 1).token;
    const tampered = `${valid.slice(0, -1)}${valid.endsWith("a") ? "b" : "a"}`;
    expect(getAgentRunChanges(OWNER, "chat-resync", tampered)?.resync).toBe(true);
    const crossChat = __test__mintChatRunCursor(OWNER, "chat-other", 1).token;
    expect(getAgentRunChanges(OWNER, "chat-resync", crossChat)?.resync).toBe(true);
    const expired = __test__mintChatRunCursor(OWNER, "chat-resync", 1, 1).token;
    const expiredResult = getAgentRunChanges(OWNER, "chat-resync", expired);
    expect(expiredResult?.resync).toBe(true);
    expect(expiredResult?.cursor.token).not.toBe(expired);
    expect(expiredResult?.runs).toHaveLength(1);
  });
  test("fails closed instead of signing chat cursors with a static fallback key", () => {
    seedChat(OWNER, "chat-cursor-key");
    seedRun(OWNER, "chat-cursor-key", "turn-cursor-key");
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(
      db,
      baseInput(OWNER, "chat-cursor-key", "turn-cursor-key"),
    ));

    const signed = __test__mintChatRunCursor(OWNER, "chat-cursor-key", 1).token;
    expect(__test__decodeChatRunCursor(signed).reason).toBe("ok");
    expect(getAgentRunChanges(OWNER, "chat-cursor-key", signed)?.resync).toBe(false);

    const priorEnvSecret = env.authSecret;
    const priorProcessSecret = process.env.AUTH_SECRET;
    env.authSecret = "";
    delete process.env.AUTH_SECRET;
    try {
      // Without a secret no cursor can be verified and none may be issued, so
      // the read path errors rather than handing out a forgeable watermark.
      expect(__test__decodeChatRunCursor(signed).reason).toBe("invalid");
      expect(() => __test__mintChatRunCursor(OWNER, "chat-cursor-key", 1))
        .toThrow("agent run cursor signing key is unavailable");
      expect(() => getAgentRunChanges(OWNER, "chat-cursor-key", signed))
        .toThrow("agent run cursor signing key is unavailable");
    } finally {
      env.authSecret = priorEnvSecret;
      if (priorProcessSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = priorProcessSecret;
    }

    // The configured secret still produces the exact prior cursor behavior.
    expect(__test__decodeChatRunCursor(signed).reason).toBe("ok");
    const resumed = getAgentRunChanges(OWNER, "chat-cursor-key", signed);
    expect(resumed?.resync).toBe(false);
    expect(__test__decodeChatRunCursor(resumed!.cursor.token).claims).toMatchObject({
      v: 1,
      u: OWNER,
      c: "chat-cursor-key",
      s: 1,
    });
  });
  test("paginates a full resync instead of reporting more than 16 runs as ready", () => {
    seedChat(OWNER, "chat-resync-pages");
    for (let index = 0; index < 17; index += 1) {
      const turnId = `turn-resync-page-${index}`;
      seedRun(OWNER, "chat-resync-pages", turnId);
      withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
        ...baseInput(OWNER, "chat-resync-pages", turnId),
        revision: 1,
      }));
    }

    const first = getAgentRunChanges(OWNER, "chat-resync-pages");
    expect(first?.resync).toBe(true);
    expect(first?.runs).toHaveLength(16);
    expect(first?.resyncPage).toMatchObject({
      offset: 0,
      returnedRuns: 16,
      totalRuns: 17,
      complete: false,
      omittedRuns: 1,
    });
    expect(first?.lastSequence).toBe(first?.cursorSequence);
    expect(__test__decodeChatRunCursor(first!.cursor.token).claims.s).toBe(first!.lastSequence);

    const snapshotMembers = Array.from({ length: 17 }, (_, index) => `turn-resync-page-${index}`);
    const updatedTurnId = first!.runs[0]!.turnId;
    const updatedRevision = first!.runs[0]!.revision + 1;
    const updatedAt = first!.runs[0]!.updatedAt + 1;
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-resync-pages", updatedTurnId),
      revision: updatedRevision,
      updatedAt,
    }));

    const second = getAgentRunChanges(OWNER, "chat-resync-pages", first!.cursor.token);
    expect(second?.resync).toBe(true);
    expect(second?.runs).toHaveLength(1);
    expect(second?.resyncPage).toMatchObject({
      offset: 16,
      returnedRuns: 1,
      totalRuns: 17,
      complete: true,
      omittedRuns: 0,
    });
    const snapshotIds = [...first!.runs, ...second!.runs].map((run) => run.turnId);
    expect(snapshotIds).toHaveLength(snapshotMembers.length);
    expect(new Set(snapshotIds).size).toBe(snapshotMembers.length);
    expect(snapshotIds).toEqual(expect.arrayContaining(snapshotMembers));

    const delta = getAgentRunChanges(OWNER, "chat-resync-pages", second!.cursor.token);
    expect(delta?.resync).toBe(false);
    expect(delta?.events).toHaveLength(1);
    expect(delta?.events[0]).toMatchObject({
      run: {
        turnId: updatedTurnId,
        revision: updatedRevision,
        updatedAt,
      },
    });
    expect(delta!.events[0]!.sequence).toBe(first!.cursorSequence + 1);
  });
  test("freezes resync membership across expiry and projection deletion", () => {
    seedChat(OWNER, "chat-resync-retention");
    for (let index = 0; index < 17; index += 1) {
      const turnId = `turn-resync-retention-${index}`;
      seedRun(OWNER, "chat-resync-retention", turnId);
      withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
        ...baseInput(OWNER, "chat-resync-retention", turnId),
        revision: 1,
      }));
    }

    const first = getAgentRunChanges(OWNER, "chat-resync-retention");
    expect(first?.resyncPage?.complete).toBe(false);
    const snapshotSequence = first!.resyncPage!.snapshotSequence;
    const snapshotId = __test__decodeChatRunCursor(first!.cursor.token).claims.r;
    expect(snapshotId).toEqual(expect.any(String));
    const expiredTurnId = first!.runs[0]!.turnId;
    const deletedTurnId = first!.runs[1]!.turnId;
    getDb().query("UPDATE agent_turn_executions SET expires_at = 1 WHERE user_id = ? AND id = ?")
      .run(OWNER, expiredTurnId);
    getDb().query("DELETE FROM agent_run_projections WHERE user_id = ? AND chat_id = ? AND turn_id = ?")
      .run(OWNER, "chat-resync-retention", deletedTurnId);

    const second = getAgentRunChanges(OWNER, "chat-resync-retention", first!.cursor.token);
    expect(second?.resyncPage).toMatchObject({
      offset: 16,
      totalRuns: 17,
      snapshotSequence,
      complete: true,
    });
    expect(second?.cursorSequence).toBe(first!.cursorSequence);
    expect(second?.lastSequence).toBe(first!.lastSequence);
    const snapshotIds = [...first!.runs, ...second!.runs].map((run) => run.turnId);
    expect(snapshotIds).toHaveLength(17);
    expect(new Set(snapshotIds).size).toBe(17);
    expect(snapshotIds).toEqual(expect.arrayContaining(
      Array.from({ length: 17 }, (_, index) => `turn-resync-retention-${index}`),
    ));
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_run_resync_snapshots WHERE snapshot_id = ?",
    ).get(snapshotId!)).toEqual({ count: 1 });
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_run_resync_snapshot_members WHERE snapshot_id = ?",
    ).get(snapshotId!)).toEqual({ count: 17 });
    getDb().query(
      "UPDATE agent_run_resync_snapshots SET expires_at = 1 WHERE snapshot_id = ?",
    ).run(snapshotId!);
    getAgentRunChanges(OWNER, "chat-resync-retention", second!.cursor.token);
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_run_resync_snapshots WHERE snapshot_id = ?",
    ).get(snapshotId!)).toEqual({ count: 0 });
  });

  test("keeps null, zero, negative, and malformed legacy expiry rows visible in resync", () => {
    seedChat(OWNER, "chat-resync-expiry-values");
    const turnIds = [
      "turn-resync-expiry-null",
      "turn-resync-expiry-zero",
      "turn-resync-expiry-negative",
      "turn-resync-expiry-malformed",
    ];
    for (const turnId of turnIds) {
      seedRun(OWNER, "chat-resync-expiry-values", turnId);
      withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
        ...baseInput(OWNER, "chat-resync-expiry-values", turnId),
        revision: 1,
      }));
    }
    // Production writes use the strict execution table. Rebuild only this
    // read fixture without constraints to exercise rows left by legacy schemas.
    getDb().run("PRAGMA foreign_keys = OFF");
    getDb().run("ALTER TABLE agent_turn_executions RENAME TO strict_agent_turn_executions");
    getDb().run(
      "CREATE TABLE agent_turn_executions AS SELECT * FROM strict_agent_turn_executions",
    );
    getDb().query("UPDATE agent_turn_executions SET expires_at = NULL WHERE id = ?")
      .run(turnIds[0]!);
    getDb().query("UPDATE agent_turn_executions SET expires_at = 0 WHERE id = ?")
      .run(turnIds[1]!);
    getDb().query("UPDATE agent_turn_executions SET expires_at = -1 WHERE id = ?")
      .run(turnIds[2]!);
    getDb().query("UPDATE agent_turn_executions SET expires_at = ? WHERE id = ?")
      .run("malformed", turnIds[3]!);

    const result = getAgentRunChanges(OWNER, "chat-resync-expiry-values");
    expect(result?.runs).toHaveLength(turnIds.length);
    expect(result?.runs.map((run) => run.turnId)).toEqual(expect.arrayContaining(turnIds));
  });

  test("uses the historical event set when the execution table is absent", () => {
    seedChat(OWNER, "chat-resync-legacy");
    for (let index = 0; index < 17; index += 1) {
      const turnId = `turn-resync-legacy-${index}`;
      seedRun(OWNER, "chat-resync-legacy", turnId);
      withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
        ...baseInput(OWNER, "chat-resync-legacy", turnId),
        revision: 1,
      }));
    }
    getDb().run("PRAGMA foreign_keys = OFF");
    getDb().run("DROP TABLE agent_turn_executions");

    const first = getAgentRunChanges(OWNER, "chat-resync-legacy");
    expect(first?.runs).toHaveLength(16);
    const updatedTurnId = first!.runs[0]!.turnId;
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-resync-legacy", updatedTurnId),
      revision: 2,
      updatedAt: first!.runs[0]!.updatedAt + 1,
    }));
    const second = getAgentRunChanges(OWNER, "chat-resync-legacy", first!.cursor.token);
    expect(second?.runs).toHaveLength(1);
    expect(new Set([...first!.runs, ...second!.runs].map((run) => run.turnId)).size).toBe(17);
  });

  test("fails the resync before issuing a cursor when a historical snapshot is malformed", () => {
    seedChat(OWNER, "chat-resync-malformed");
    seedRun(OWNER, "chat-resync-malformed", "turn-resync-malformed");
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-resync-malformed", "turn-resync-malformed"),
      revision: 1,
    }));
    getDb().query(
      "UPDATE agent_chat_events SET snapshot_json = ? WHERE user_id = ? AND chat_id = ? AND turn_id = ?",
    ).run("{", OWNER, "chat-resync-malformed", "turn-resync-malformed");
    expect(() => getAgentRunChanges(OWNER, "chat-resync-malformed")).toThrow(
      "agent run resync encountered malformed historical projection",
    );
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_run_resync_snapshots WHERE user_id = ? AND chat_id = ?",
    ).get(OWNER, "chat-resync-malformed")).toEqual({ count: 0 });
  });



  test("replays an immutable resync page after response loss", () => {
    seedChat(OWNER, "chat-resync-replay");
    for (let index = 0; index < 33; index += 1) {
      const turnId = `turn-resync-replay-${index}`;
      seedRun(OWNER, "chat-resync-replay", turnId);
      withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
        ...baseInput(OWNER, "chat-resync-replay", turnId),
        revision: 1,
      }));
    }

    const first = getAgentRunChanges(OWNER, "chat-resync-replay");
    expect(first?.resyncPage).toMatchObject({ offset: 0, returnedRuns: 16, complete: false });
    const firstClaims = __test__decodeChatRunCursor(first!.cursor.token).claims;
    const snapshotExpiry = getDb().query(
      "SELECT expires_at FROM agent_run_resync_snapshots WHERE snapshot_id = ?",
    ).get(firstClaims.r!) as { expires_at: number };
    expect(firstClaims.e).toBeLessThanOrEqual(snapshotExpiry.expires_at);
    const second = getAgentRunChanges(OWNER, "chat-resync-replay", first!.cursor.token);
    expect(second?.resyncPage).toMatchObject({ offset: 16, returnedRuns: 16, complete: false });
    const secondClaims = __test__decodeChatRunCursor(second!.cursor.token).claims;
    expect(secondClaims.e).toBeLessThanOrEqual(snapshotExpiry.expires_at);

    const retry = getAgentRunChanges(OWNER, "chat-resync-replay", first!.cursor.token);
    expect(retry?.resyncPage).toEqual(second?.resyncPage);
    expect(retry?.runs).toEqual(second?.runs);
    expect(retry?.cursorSequence).toBe(second?.cursorSequence);
    expect(retry?.lastSequence).toBe(second?.lastSequence);
    expect(retry?.tailSequence).toBe(second?.tailSequence);
    expect(retry?.hasMore).toBe(second?.hasMore);
    expect(retry?.events).toEqual(second?.events);
    expect(retry?.omission).toEqual(second?.omission);

    const third = getAgentRunChanges(OWNER, "chat-resync-replay", second!.cursor.token);
    expect(third?.resyncPage).toMatchObject({
      offset: 32,
      returnedRuns: 1,
      totalRuns: 33,
      complete: true,
    });
    const finalRetry = getAgentRunChanges(OWNER, "chat-resync-replay", second!.cursor.token);
    expect(finalRetry?.resyncPage).toEqual(third?.resyncPage);
    expect(finalRetry?.runs).toEqual(third?.runs);
  });

  test("fails closed when a persisted resync member is malformed", () => {
    seedChat(OWNER, "chat-resync-member-malformed");
    for (let index = 0; index < 17; index += 1) {
      const turnId = `turn-resync-member-malformed-${index}`;
      seedRun(OWNER, "chat-resync-member-malformed", turnId);
      withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
        ...baseInput(OWNER, "chat-resync-member-malformed", turnId),
        revision: 1,
      }));
    }

    const first = getAgentRunChanges(OWNER, "chat-resync-member-malformed");
    const snapshotId = __test__decodeChatRunCursor(first!.cursor.token).claims.r;
    expect(snapshotId).toEqual(expect.any(String));
    const storedMember = getDb().query(
      "SELECT run_json FROM agent_run_resync_snapshot_members WHERE snapshot_id = ? AND ordinal = ?",
    ).get(snapshotId!, 16) as { run_json: string };
    const malformed = JSON.parse(storedMember.run_json) as {
      activity?: Array<Record<string, unknown>>;
    };
    malformed.activity![0]!.phase = "INVALID_PHASE";
    getDb().query(
      "UPDATE agent_run_resync_snapshot_members SET run_json = ? WHERE snapshot_id = ? AND ordinal = ?",
    ).run(JSON.stringify(malformed), snapshotId!, 16);
    expect(() => getAgentRunChanges(
      OWNER,
      "chat-resync-member-malformed",
      first!.cursor.token,
    )).toThrow("agent run resync snapshot contains malformed membership");
  });
  test("fails closed when persisted resync membership bounds or ownership drift", () => {
    seedChat(OWNER, "chat-resync-membership-drift");
    for (let index = 0; index < 17; index += 1) {
      const turnId = `turn-resync-membership-drift-${index}`;
      seedRun(OWNER, "chat-resync-membership-drift", turnId);
      withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
        ...baseInput(OWNER, "chat-resync-membership-drift", turnId),
        revision: 1,
      }));
    }

    const first = getAgentRunChanges(OWNER, "chat-resync-membership-drift");
    const snapshotId = __test__decodeChatRunCursor(first!.cursor.token).claims.r;
    expect(snapshotId).toEqual(expect.any(String));
    getDb().query(
      "UPDATE agent_run_resync_snapshots SET total_runs = ? WHERE snapshot_id = ?",
    ).run(16, snapshotId!);
    expect(() => getAgentRunChanges(
      OWNER,
      "chat-resync-membership-drift",
      first!.cursor.token,
    )).toThrow("agent run resync snapshot membership is incomplete");
    getDb().query(
      "UPDATE agent_run_resync_snapshots SET total_runs = ? WHERE snapshot_id = ?",
    ).run(17, snapshotId!);
    getDb().query(
      "UPDATE agent_run_resync_snapshot_members SET user_id = ? WHERE snapshot_id = ? AND ordinal = ?",
    ).run(OTHER, snapshotId!, 16);
    expect(() => getAgentRunChanges(
      OWNER,
      "chat-resync-membership-drift",
      first!.cursor.token,
    )).toThrow("agent run resync snapshot membership is incomplete");
  });

  test("retains a deterministic 256-run snapshot and reports older omissions", () => {
    const chatId = "chat-resync-bound";
    seedChat(OWNER, chatId);
    for (let index = 0; index < 257; index += 1) {
      const turnId = `turn-resync-bound-${index.toString().padStart(3, "0")}`;
      seedRun(OWNER, chatId, turnId);
      withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
        ...baseInput(OWNER, chatId, turnId),
        revision: 1,
        updatedAt: index + 1,
      }));
    }

    const first = getAgentRunChanges(OWNER, chatId);
    if (!first?.resyncPage) throw new Error("initial bounded resync page is unavailable");
    expect(first.resync).toBe(true);
    expect(first.resyncPage).toMatchObject({
      offset: 0,
      returnedRuns: 16,
      totalRuns: 256,
      omittedRuns: 240,
      omittedOlderRuns: 1,
      complete: false,
    });
    const repeated = getAgentRunChanges(OWNER, chatId);
    if (!repeated?.resyncPage) throw new Error("reused bounded resync page is unavailable");
    expect(repeated.resyncPage.omittedOlderRuns).toBe(1);
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_run_resync_snapshots WHERE user_id = ? AND chat_id = ?",
    ).get(OWNER, chatId)).toEqual({ count: 1 });

    const retainedIds = new Set(first.runs.map((run) => run.turnId));
    let page = first;
    while (page.resyncPage?.complete === false) {
      const next = getAgentRunChanges(OWNER, chatId, page.cursor.token);
      if (!next?.resyncPage) throw new Error("bounded resync continuation is unavailable");
      page = next;
      for (const run of page.runs) retainedIds.add(run.turnId);
    }
    expect(retainedIds.size).toBe(256);
    expect(retainedIds.has("turn-resync-bound-000")).toBe(false);
    expect(page?.resyncPage).toMatchObject({
      totalRuns: 256,
      omittedRuns: 0,
      omittedOlderRuns: 1,
      complete: true,
    });
  });

  test("startup terminalization atomically repairs FAILED and COMMIT_FAILED projections and outbox rows", () => {
    seedChat(OWNER, "chat-recovery-terminal");
    seedRun(OWNER, "chat-recovery-terminal", "turn-recovery-failed", "generation-recovery-failed", "WORK");
    seedRun(OWNER, "chat-recovery-terminal", "turn-recovery-commit-failed", "generation-recovery-commit-failed", "COMMITTING");
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-recovery-terminal", "turn-recovery-failed"),
    }));
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-recovery-terminal", "turn-recovery-commit-failed"),
      status: "COMMITTING",
    }));
    registerAgentTurnTerminalRecovery((execution, status) => {
      repairAgentRunProjectionFromInterruptedExecution(getDb(), execution, status);
    });
    try {
      const recovered = reconcileAgentTurns(getDb());
      expect(recovered.failedInterrupted).toBe(1);
      expect(recovered.commitFailedWithoutReceipt).toBe(1);
    } finally {
      registerAgentTurnTerminalRecovery(null);
    }

    expect(getDb().query(
      "SELECT state FROM agent_turn_executions WHERE id = ?",
    ).get("turn-recovery-failed")).toEqual({ state: "FAILED" });
    expect(getDb().query(
      "SELECT state FROM agent_turn_executions WHERE id = ?",
    ).get("turn-recovery-commit-failed")).toEqual({ state: "COMMIT_FAILED" });
    expect(getAgentRun(OWNER, "turn-recovery-failed", "chat-recovery-terminal")).toMatchObject({
      workPhase: "TERMINAL",
      workStatus: "terminal",
      workOutcome: "failed",
      reason: "failed",
    });
    expect(getAgentRun(OWNER, "turn-recovery-commit-failed", "chat-recovery-terminal")).toMatchObject({
      workPhase: "TERMINAL",
      workStatus: "terminal",
      workOutcome: "failed",
      reason: "commit_failed",
    });
    expect(getDb().query(
      `SELECT status, event_kind
         FROM agent_chat_events
        WHERE turn_id = ?
        ORDER BY sequence DESC
        LIMIT 1`,
    ).get("turn-recovery-failed")).toEqual({ status: "FAILED", event_kind: "terminal" });
    expect(getDb().query(
      `SELECT status, event_kind
         FROM agent_chat_events
        WHERE turn_id = ?
        ORDER BY sequence DESC
        LIMIT 1`,
    ).get("turn-recovery-commit-failed")).toEqual({ status: "COMMIT_FAILED", event_kind: "terminal" });
  });

  test("terminal status-only snapshots cannot retain a nonterminal public lifecycle", () => {
    seedChat(OWNER, "chat-terminal-status-only");
    seedRun(OWNER, "chat-terminal-status-only", "turn-terminal-status-only");
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-terminal-status-only", "turn-terminal-status-only"),
    }));

    const terminal = withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      userId: OWNER,
      chatId: "chat-terminal-status-only",
      turnId: "turn-terminal-status-only",
      generationId: "turn-terminal-status-only",
      generationType: "normal",
      status: "FAILED",
    }));

    expect(terminal.run).toMatchObject({
      workPhase: "TERMINAL",
      workStatus: "terminal",
      workOutcome: "failed",
      reason: "failed",
      activity: [{
        phase: "TERMINAL",
        status: "failed",
      }],
      error: {
        workPhase: "TERMINAL",
        workStatus: "terminal",
        workOutcome: "failed",
      },
    });
  });
  test("keeps root wall-clock deadline failures failed without changing true budget exhaustion", () => {
    seedChat(OWNER, "chat-terminal-causes");
    seedRun(OWNER, "chat-terminal-causes", "turn-root-deadline");
    const rootDeadline = withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-terminal-causes", "turn-root-deadline"),
      status: undefined,
      workPhase: "TERMINAL",
      workStatus: "terminal",
      workOutcome: "failed",
      reason: "root_wall_clock_limit_exceeded",
      error: { code: "root_wall_clock_limit_exceeded" },
    }));
    expect(rootDeadline.run).toMatchObject({
      workPhase: "TERMINAL",
      workStatus: "terminal",
      workOutcome: "failed",
      reason: "root_wall_clock_limit_exceeded",
      error: { code: "root_wall_clock_limit_exceeded" },
    });

    seedRun(OWNER, "chat-terminal-causes", "turn-budget-exhausted");
    const budgetExhausted = withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-terminal-causes", "turn-budget-exhausted"),
      status: undefined,
      workPhase: "TERMINAL",
      workStatus: "terminal",
      workOutcome: "exhausted",
      reason: "agentic_work_exhausted",
      error: { code: "agentic_work_exhausted" },
    }));
    expect(budgetExhausted.run).toMatchObject({
      workPhase: "TERMINAL",
      workStatus: "terminal",
      workOutcome: "exhausted",
      reason: "agentic_work_exhausted",
      error: { code: "limit_exceeded" },
    });
  });

  test("keeps target association owner-scoped and atomically writes terminal handoff plus compatibility activity", () => {
    seedChat(OWNER, "chat-terminal");
    seedRun(OWNER, "chat-terminal", "turn-terminal", "generation-terminal");
    getDb().query(
      `INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, swipes)
       VALUES ('message-terminal', 'chat-terminal', 0, 0, 'assistant', 'safe', '["safe-0","safe-1","safe-2"]')`,
    ).run();
    const result = withAgentRunProjectionTransaction((db) => publishAgentRunCommit(db, {
      ...baseInput(OWNER, "chat-terminal", "turn-terminal", "generation-terminal"),
      status: "COMMITTED",
      targetMessageId: "message-terminal",
      targetSwipeId: 2,
      terminalHandoff: {
        committed: true,
        messageId: "message-terminal",
        swipeId: 2,
        messageRevision: 4,
        swipeRevision: 4,
      },
    }));
    expect(result.run).toMatchObject({
      runId: "generation-terminal",
      turnId: "turn-terminal",
      generationId: "generation-terminal",
    });
    expect(result.run.terminalHandoff?.messageId).toBe("message-terminal");
    expect(getDb().query("SELECT COUNT(*) AS count FROM agent_activity_runs WHERE generation_id = 'generation-terminal'").get()).toEqual({ count: 1 });
    expect(getAgentRun(OTHER, "turn-terminal")).toBeNull();
    expect(() => withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OTHER, "chat-terminal", "turn-terminal"),
    }))).toThrow();
    const encoded = JSON.stringify(result.run);
    expect(encoded).not.toContain("private work prose");
    expect(encoded).not.toContain("private args");
    expect(encoded).not.toContain("private result");
  });
  test("rolls back terminal projection when compatibility activity storage is unavailable", () => {
    const chatId = "chat-compatibility-storage-fail";
    const turnId = "turn-compatibility-storage-fail";
    seedChat(OWNER, chatId);
    seedRun(OWNER, chatId, turnId);
    getDb().run("DROP TABLE agent_activity_runs");

    expect(() => withAgentRunProjectionTransaction((db) => publishAgentRunCommit(db, {
      ...baseInput(OWNER, chatId, turnId),
      status: "COMMITTED",
    }))).toThrow();
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_run_projections WHERE turn_id = ?",
    ).get(turnId)).toEqual({ count: 0 });
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_chat_events WHERE turn_id = ?",
    ).get(turnId)).toEqual({ count: 0 });
  });

  test("cancels ownerless WORK durably before publishing the terminal projection", () => {
    seedChat(OWNER, "chat-stop");
    seedRun(OWNER, "chat-stop", "turn-stop", "generation-stop", "WORK");
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-stop", "turn-stop"),
      generationId: "generation-stop",
    }));

    const accepted = requestAgentRunStop(OWNER, "chat-stop", "turn-stop");
    expect(accepted).toMatchObject({ version: 2, status: "accepted", turnId: "turn-stop", generationId: "generation-stop", revision: 2 });
    expect(getDb().query(
      "SELECT state, cas_owner FROM agent_turn_executions WHERE id = 'turn-stop'",
    ).get()).toEqual({ state: "CANCELLED", cas_owner: null });
    expect(getAgentRun(OWNER, "turn-stop")).toMatchObject({
      workPhase: "TERMINAL",
      workStatus: "terminal",
      workOutcome: "stopped",
      reason: "stopped",
    });
    expect(getAgentRun(OWNER, "turn-stop")?.activity[0]).toMatchObject({
      phase: "TERMINAL",
      status: "cancelled",
    });

    expect(requestAgentRunStop(OWNER, "chat-stop", "turn-stop")).toMatchObject({
      version: 2,
      status: "terminal",
      generationId: "generation-stop",
      turnId: "turn-stop",
      revision: 2,
    });
    expect(requestAgentRunStop(OTHER, "chat-stop", "turn-stop")).toBeNull();
  });

  test("returns too_late throughout the irreversible post-WORK phases without output or commit", () => {
    for (const phase of ["COMPLETE", "RENDER", "PREPARE_COMMIT"] as const) {
      const chatId = "chat-stop-" + phase.toLowerCase();
      const turnId = "turn-stop-" + phase.toLowerCase();
      const generationId = "generation-" + turnId;
      seedChat(OWNER, chatId);
      seedRun(OWNER, chatId, turnId, generationId, phase);
      withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
        ...baseInput(OWNER, chatId, turnId),
        generationId,
        status: phase,
      }));

      expect(requestAgentRunStop(OWNER, chatId, turnId)).toMatchObject({
        version: 2,
        status: "too_late",
        turnId,
        generationId,
        revision: 1,
      });
      expect(getDb().query(
        "SELECT state, cas_owner FROM agent_turn_executions WHERE id = ?",
      ).get(turnId)).toEqual({ state: phase, cas_owner: null });
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?",
      ).get(chatId)).toEqual({ count: 0 });
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE turn_id = ?",
      ).get(turnId)).toEqual({ count: 0 });
    }
  });

  test("returns too_late for ownerless COMMITTING without changing either state", () => {
    seedChat(OWNER, "chat-committing-stop");
    seedRun(OWNER, "chat-committing-stop", "turn-committing-stop", "turn-committing-stop", "COMMITTING");
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-committing-stop", "turn-committing-stop"),
      status: "COMMITTING",
    }));

    expect(requestAgentRunStop(OWNER, "chat-committing-stop", "turn-committing-stop")).toMatchObject({
      version: 2,
      status: "too_late",
      turnId: "turn-committing-stop",
      generationId: "turn-committing-stop",
      revision: 1,
    });
    expect(getDb().query(
      "SELECT state, cas_owner FROM agent_turn_executions WHERE id = 'turn-committing-stop'",
    ).get()).toEqual({ state: "COMMITTING", cas_owner: null });
    expect(getAgentRun(OWNER, "turn-committing-stop")).toMatchObject({
      workPhase: "COMMIT",
      workStatus: "running",
      workOutcome: null,
    });
  });
  test("returns too_late for already COMMITTED without rewriting the terminal result", () => {
    seedChat(OWNER, "chat-committed-stop");
    seedRun(OWNER, "chat-committed-stop", "turn-committed-stop", "turn-committed-stop", "COMMITTED");
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-committed-stop", "turn-committed-stop"),
      status: "COMMITTED",
    }));

    expect(requestAgentRunStop(OWNER, "chat-committed-stop", "turn-committed-stop")).toMatchObject({
      version: 2,
      status: "too_late",
      turnId: "turn-committed-stop",
      generationId: "turn-committed-stop",
      revision: 1,
    });
    expect(getDb().query(
      "SELECT state, cas_owner FROM agent_turn_executions WHERE id = 'turn-committed-stop'",
    ).get()).toEqual({ state: "COMMITTED", cas_owner: null });
  });


  test("keeps an already-terminal durable execution idempotent", () => {
    seedChat(OWNER, "chat-terminal-stop");
    seedRun(OWNER, "chat-terminal-stop", "turn-terminal-stop", "generation-terminal-stop", "CANCELLED");
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-terminal-stop", "turn-terminal-stop"),
      generationId: "generation-terminal-stop",
      status: "CANCELLED",
    }));

    expect(requestAgentRunStop(OWNER, "chat-terminal-stop", "turn-terminal-stop")).toMatchObject({
      version: 2,
      status: "terminal",
      generationId: "generation-terminal-stop",
      turnId: "turn-terminal-stop",
      revision: 1,
    });
    expect(getDb().query(
      "SELECT state, cas_owner FROM agent_turn_executions WHERE id = 'turn-terminal-stop'",
    ).get()).toEqual({ state: "CANCELLED", cas_owner: null });
    expect(getAgentRun(OWNER, "turn-terminal-stop")).toMatchObject({
      workPhase: "TERMINAL",
      workStatus: "terminal",
      workOutcome: "stopped",
      reason: "stopped",
    });
  });

  test("repairs an active projection only after observing an already-terminal durable row", () => {
    seedChat(OWNER, "chat-terminal-repair");
    seedRun(OWNER, "chat-terminal-repair", "turn-terminal-repair", "turn-terminal-repair", "CANCELLED");
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, baseInput(OWNER, "chat-terminal-repair", "turn-terminal-repair")));

    expect(requestAgentRunStop(OWNER, "chat-terminal-repair", "turn-terminal-repair")).toMatchObject({
      version: 2,
      generationId: "turn-terminal-repair",
      status: "terminal",
      turnId: "turn-terminal-repair",
      revision: 2,
    });
    expect(getAgentRun(OWNER, "turn-terminal-repair")).toMatchObject({
      workPhase: "TERMINAL",
      workStatus: "terminal",
      workOutcome: "stopped",
      reason: "stopped",
    });
    expect(getDb().query(
      "SELECT state FROM agent_turn_executions WHERE id = 'turn-terminal-repair'",
    ).get()).toEqual({ state: "CANCELLED" });
  });

  test("redacts workspace prose while retaining closed preview labels and omission-free page shape", () => {
    seedChat(OWNER, "chat-workspace");
    seedRun(OWNER, "chat-workspace", "turn-workspace");
    getDb().query(
      `INSERT INTO agent_turn_workspaces
        (workspace_id, turn_id, execution_id, user_id, chat_id, objective, constraints_json,
         state, revision, operation_caps_json, field_caps_json, retention, expires_at,
         quota_tasks, quota_records, quota_submissions, quota_artifacts, quota_bytes)
       VALUES ('workspace-1', 'turn-workspace', 'turn-workspace', ?, ?,
               'private objective prose', '{}', 'active', 2, '{}', '{}', 'turn_terminal',
               9999999999, 10, 10, 10, 10, 100000)`,
    ).run(OWNER, "chat-workspace");
    getDb().query(
      `INSERT INTO agent_workspace_tasks
        (task_id, workspace_id, turn_id, user_id, chat_id, title, description, state,
         required, dependencies_json, progress, summary, byte_count, revision,
         retention, expires_at, created_at, updated_at)
       VALUES ('task-1', 'workspace-1', 'turn-workspace', ?, ?,
               'private task prose', 'private task prose', 'active', 1, '["dependency"]',
               0, NULL, 0, 0, 'turn_terminal', 9999999999, 1, 1)`,
    ).run(OWNER, "chat-workspace");
    getDb().query(
      `INSERT INTO agent_workspace_records
        (record_id, workspace_id, turn_id, user_id, chat_id, kind, summary, digest,
         task_id, source_frame_id, byte_count, revision, retention, expires_at, created_at)
       VALUES ('record-1', 'workspace-1', 'turn-workspace', ?, ?, 'finding',
               'private record prose', ?, NULL, NULL, 20, 0, 'turn_terminal',
               9999999999, 1)`,
    ).run(OWNER, "chat-workspace", "a".repeat(64));
    const preview = getWorkspacePreview(OWNER, "turn-workspace", "tasks");
    expect(preview?.entries[0]).toMatchObject({ kind: "task", id: "task-1", title: "Task task-1" });
    expect(JSON.stringify(preview)).not.toContain("private objective prose");
    expect(JSON.stringify(preview)).not.toContain("private task prose");
    const recordPreview = getWorkspacePreview(OWNER, "turn-workspace", "records");
    expect(recordPreview?.entries[0]).toMatchObject({ kind: "finding", id: "record-1", title: "finding" });
    expect(JSON.stringify(recordPreview)).not.toContain("private record prose");
  });
  test("rejects a stored target when its swipe disappears", () => {
    seedChat(OWNER, "chat-stale-swipe");
    seedRun(OWNER, "chat-stale-swipe", "turn-stale-swipe");
    getDb().query(
      `INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, swipes)
       VALUES ('message-stale', 'chat-stale-swipe', 0, 0, 'assistant', 'safe', '["swipe-0"]')`,
    ).run();
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-stale-swipe", "turn-stale-swipe"),
      targetMessageId: "message-stale",
      targetSwipeId: 0,
    }));
    getDb().query("UPDATE messages SET swipes = '[]' WHERE id = 'message-stale'").run();
    expect(getAgentRun(OWNER, "turn-stale-swipe")).toBeNull();
  });

  test("allows regenerate snapshots to target the append swipe slot", () => {
    seedChat(OWNER, "chat-append-swipe");
    seedChat(OTHER, "chat-foreign-append");
    seedRun(OWNER, "chat-append-swipe", "turn-append-regenerate");
    seedRun(OWNER, "chat-append-swipe", "turn-append-swipe");
    seedRun(OWNER, "chat-append-swipe", "turn-append-beyond");
    seedRun(OWNER, "chat-append-swipe", "turn-append-foreign");
    seedRun(OWNER, "chat-append-swipe", "turn-append-normal");
    getDb().query(
      `INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, swipes)
       VALUES ('message-append', 'chat-append-swipe', 0, 0, 'assistant', 'safe', '["swipe-0"]')`,
    ).run();
    getDb().query(
      `INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, swipes)
       VALUES ('message-foreign', 'chat-foreign-append', 0, 0, 'assistant', 'safe', '["swipe-0"]')`,
    ).run();

    const appended = withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-append-swipe", "turn-append-regenerate"),
      generationType: "regenerate",
      status: "ASSEMBLE",
      targetMessageId: "message-append",
      targetSwipeId: 1,
    }));
    expect(appended.changed).toBe(true);
    expect(appended.run.target).toEqual({ messageId: "message-append", swipeId: 1 });
    expect(getAgentRun(OWNER, "turn-append-regenerate")?.target?.swipeId).toBe(1);

    const coerced = withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-append-swipe", "turn-append-swipe"),
      generationType: "swipe",
      status: "ASSEMBLE",
      targetMessageId: "message-append",
      targetSwipeId: "1" as unknown as number,
    }));
    expect(coerced.run.target?.swipeId).toBe(1);

    expect(() => withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-append-swipe", "turn-append-normal"),
      generationType: "normal",
      status: "ASSEMBLE",
      targetMessageId: "message-append",
      targetSwipeId: 1,
    }))).toThrow("agent run projection ownership mismatch");

    expect(() => withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-append-swipe", "turn-append-beyond"),
      generationType: "regenerate",
      status: "ASSEMBLE",
      targetMessageId: "message-append",
      targetSwipeId: Number.NaN,
    }))).toThrow("agent run target association mismatch");


    expect(() => withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-append-swipe", "turn-append-beyond"),
      generationType: "regenerate",
      status: "ASSEMBLE",
      targetMessageId: "message-append",
      targetSwipeId: 2,
    }))).toThrow("agent run projection ownership mismatch");

    expect(() => withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-append-swipe", "turn-append-foreign"),
      generationType: "regenerate",
      status: "ASSEMBLE",
      targetMessageId: "message-foreign",
      targetSwipeId: 1,
    }))).toThrow("agent run projection ownership mismatch");
  });
  test("preserves immutable attempt lineage across phase and terminal projections", () => {
    seedChat(OWNER, "chat-lineage");
    seedRun(OWNER, "chat-lineage", "turn-lineage");
    getDb().query(
      `INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, swipes)
       VALUES ('message-lineage', 'chat-lineage', 0, 0, 'assistant', 'safe', '["zero","one","two"]')`,
    ).run();
    const attemptLineage = {
      version: 1 as const,
      attemptId: "attempt-lineage",
      previousAttemptId: "attempt-parent",
      target: {
        chatId: "chat-lineage",
        generationType: "swipe" as const,
        messageId: "message-lineage",
        swipeId: 2,
      },
      createdAt: 42,
    };
    const phase = withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-lineage", "turn-lineage"),
      generationType: "swipe",
      status: "WORK",
      targetMessageId: "message-lineage",
      targetSwipeId: 2,
      attemptLineage,
    }));
    expect(phase.run.attemptLineage).toEqual(attemptLineage);

    const terminal = withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-lineage", "turn-lineage"),
      generationType: "swipe",
      status: "FAILED",
      targetMessageId: "message-lineage",
      targetSwipeId: 2,
      attemptLineage,
      error: { code: "provider_error", retryable: true },
    }));
    expect(terminal.run.attemptLineage).toEqual(attemptLineage);
    expect(getAgentRun(OWNER, "turn-lineage")?.attemptLineage).toEqual(attemptLineage);
  });
  test("dispatches live Stop to the registered cancellation owner", () => {
    seedChat(OWNER, "chat-live-stop");
    seedRun(OWNER, "chat-live-stop", "turn-live-stop");
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, baseInput(OWNER, "chat-live-stop", "turn-live-stop")));
    let received: string | undefined;
    const unregister = registerAgentRunStopHandler(OWNER, "chat-live-stop", "turn-live-stop", (context) => {
      received = `${context.userId}/${context.chatId}/${context.turnId}/${context.generationId}`;
      getDb().query(
        "UPDATE agent_turn_executions SET cancel_requested_at = ? WHERE user_id = ? AND chat_id = ? AND id = ?",
      ).run(Date.now(), context.userId, context.chatId, context.turnId);
      return "accepted";
    });
    try {
      expect(requestAgentRunStop(OWNER, "chat-live-stop", "turn-live-stop")).toMatchObject({
        status: "accepted",
        turnId: "turn-live-stop",
        generationId: "turn-live-stop",
        revision: 2,
      });
      expect(received).toBe(`${OWNER}/chat-live-stop/turn-live-stop/turn-live-stop`);
      expect(getAgentRun(OWNER, "turn-live-stop")).toMatchObject({
        revision: 2,
        workPhase: "WORK",
        workStatus: "cancelling",
        workOutcome: null,
      });
    } finally {
      unregister();
    }
  });
  test("registered terminal handler returns the reconciled durable Stop projection", () => {
    const chatId = "chat-live-terminal-stop";
    const turnId = "turn-live-terminal-stop";
    seedChat(OWNER, chatId);
    seedRun(OWNER, chatId, turnId, turnId, "WORK");
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, baseInput(OWNER, chatId, turnId)));
    const unregister = registerAgentRunStopHandler(OWNER, chatId, turnId, () => {
      getDb().query(
        "UPDATE agent_turn_executions SET state = 'CANCELLED', terminal_code = 'cancelled', cas_owner = NULL WHERE user_id = ? AND chat_id = ? AND id = ?",
      ).run(OWNER, chatId, turnId);
      return "terminal";
    });
    try {
      const response = requestAgentRunStop(OWNER, chatId, turnId);
      expect(response).toMatchObject({
        version: 2,
        status: "terminal",
        turnId,
        workPhase: "TERMINAL",
        workStatus: "terminal",
        workOutcome: "stopped",
        generationId: turnId,
        reason: "stopped",
      });
      expect(getAgentRun(OWNER, turnId, chatId)).toMatchObject({
        generationId: turnId,
        workPhase: "TERMINAL",
        workStatus: "terminal",
        workOutcome: "stopped",
        reason: "stopped",
      });
    } finally {
      unregister();
    }
  });
  test("projects a compatible boolean cancellation marker for live Stop", () => {
    const chatId = "chat-live-stop-compatible-marker";
    const turnId = "turn-live-stop-compatible-marker";
    getDb().run("ALTER TABLE agent_turn_executions ADD COLUMN cancellation_requested INTEGER");
    seedChat(OWNER, chatId);
    seedRun(OWNER, chatId, turnId);
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, baseInput(OWNER, chatId, turnId)));
    const unregister = registerAgentRunStopHandler(OWNER, chatId, turnId, (context) => {
      getDb().query(
        "UPDATE agent_turn_executions SET cancellation_requested = 1 WHERE user_id = ? AND chat_id = ? AND id = ?",
      ).run(context.userId, context.chatId, context.turnId);
      return "accepted";
    });
    try {
      expect(requestAgentRunStop(OWNER, chatId, turnId)).toMatchObject({
        status: "accepted",
        turnId,
        generationId: turnId,
        revision: 2,
      });
      expect(getDb().query(
        "SELECT cancel_requested_at, cancellation_requested FROM agent_turn_executions WHERE id = ?",
      ).get(turnId)).toEqual({ cancel_requested_at: null, cancellation_requested: 1 });
      expect(getAgentRun(OWNER, turnId, chatId)).toMatchObject({
        revision: 2,
        workPhase: "WORK",
        workStatus: "cancelling",
        workOutcome: null,
      });
    } finally {
      unregister();
    }
  });

  test("fails closed when a live cancellation handler accepts without its durable marker", () => {
    const chatId = "chat-live-stop-without-marker";
    const turnId = "turn-live-stop-without-marker";
    seedChat(OWNER, chatId);
    seedRun(OWNER, chatId, turnId);
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, baseInput(OWNER, chatId, turnId)));
    const unregister = registerAgentRunStopHandler(OWNER, chatId, turnId, () => "accepted");
    try {
      expect(() => requestAgentRunStop(OWNER, chatId, turnId)).toThrow(AgentRunStopUnavailableError);
      expect(getDb().query(
        "SELECT cancel_requested_at FROM agent_turn_executions WHERE id = ?",
      ).get(turnId)).toEqual({ cancel_requested_at: null });
      expect(getAgentRun(OWNER, turnId, chatId)).toMatchObject({
        revision: 1,
        workPhase: "WORK",
        workStatus: "running",
        workOutcome: null,
      });
    } finally {
      unregister();
    }
  });

  test("fails closed when an active owner has no cancellation handler", () => {
    seedChat(OWNER, "chat-unowned-stop");
    seedRun(OWNER, "chat-unowned-stop", "turn-unowned-stop", "turn-unowned-stop", "WORK");
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, baseInput(OWNER, "chat-unowned-stop", "turn-unowned-stop")));
    getDb().query("UPDATE agent_turn_executions SET cas_owner = 'live-owner' WHERE id = 'turn-unowned-stop'").run();
    expect(() => requestAgentRunStop(OWNER, "chat-unowned-stop", "turn-unowned-stop")).toThrow(AgentRunStopUnavailableError);
    expect(getDb().query(
      "SELECT state, cas_owner FROM agent_turn_executions WHERE id = 'turn-unowned-stop'",
    ).get()).toEqual({ state: "WORK", cas_owner: "live-owner" });
    expect(getAgentRun(OWNER, "turn-unowned-stop")).toMatchObject({
      workPhase: "WORK",
      workStatus: "running",
      workOutcome: null,
    });
  });

  test("expires reads and bounds cleanup without deleting chat-lifetime workspace entries", () => {
    seedChat(OWNER, "chat-expiry");
    seedRun(OWNER, "chat-expiry", "turn-expiry");
    withAgentRunProjectionTransaction((db) => appendAgentRunSnapshot(db, {
      ...baseInput(OWNER, "chat-expiry", "turn-expiry"),
      status: "CANCELLED",
    }));
    getDb().query("UPDATE agent_turn_executions SET expires_at = 1 WHERE id = 'turn-expiry'").run();
    expect(getAgentRun(OWNER, "turn-expiry")).toBeNull();
    getDb().query(
      `INSERT INTO agent_turn_workspaces
        (workspace_id, turn_id, execution_id, user_id, chat_id, objective, constraints_json,
         state, revision, operation_caps_json, field_caps_json, retention, expires_at,
         quota_tasks, quota_records, quota_submissions, quota_artifacts, quota_bytes)
       VALUES ('workspace-expiry', 'turn-expiry', 'turn-expiry', ?, ?,
               'private', '{}', 'active', 1, '{}', '{}', 'turn_terminal',
               1, 10, 10, 10, 10, 100000)`,
    ).run(OWNER, "chat-expiry");
    getDb().query(
      `INSERT INTO agent_workspace_tasks
        (task_id, workspace_id, turn_id, user_id, chat_id, title, description, state,
         required, dependencies_json, progress, summary, byte_count, revision,
         retention, expires_at, created_at, updated_at)
       VALUES ('task-chat-life', 'workspace-expiry', 'turn-expiry', ?, ?,
               'private', '', 'active', 1, '[]', 0, NULL, 0, 0,
               'chat_lifetime', 1, 1, 1)`,
    ).run(OWNER, "chat-expiry");
    const result = reconcileAgentRunProjections(getDb(), { nowMilliseconds: 2_000, nowSeconds: 2 });
    expect(result.removedProjections).toBe(1);
    expect(result.removedWorkspaces).toBe(0);
    expect(result.preservedChatLifetimeEntries).toBe(1);
    expect(result.healthy).toBe(true);
    expect(getDb().query("SELECT state FROM agent_turn_workspaces WHERE workspace_id = 'workspace-expiry'").get()).toEqual({ state: "expired" });
    expect(getDb().query("SELECT COUNT(*) AS count FROM agent_workspace_tasks WHERE task_id = 'task-chat-life'").get()).toEqual({ count: 1 });
  });
  test("filters expired projections before applying the bounded cleanup cap", () => {
    const chatId = "chat-expiry-overflow";
    const expiredTurnId = "turn-expiry-overflow";
    const retainedCount = 256 + 1;
    seedChat(OWNER, chatId);

    getDb().transaction(() => {
      for (let index = 0; index < retainedCount; index += 1) {
        const turnId = `turn-expiry-retained-${index}`;
        seedRun(OWNER, chatId, turnId);
        appendAgentRunSnapshot(getDb(), baseInput(OWNER, chatId, turnId));
        getDb().query(
          "UPDATE agent_run_projections SET updated_at = ? WHERE user_id = ? AND turn_id = ?",
        ).run(index + 1, OWNER, turnId);
      }

      seedRun(OWNER, chatId, expiredTurnId, expiredTurnId, "CANCELLED");
      appendAgentRunSnapshot(getDb(), {
        ...baseInput(OWNER, chatId, expiredTurnId),
        status: "CANCELLED",
      });
      getDb().query(
        "UPDATE agent_run_projections SET updated_at = ? WHERE user_id = ? AND turn_id = ?",
      ).run(retainedCount + 1, OWNER, expiredTurnId);
      getDb().query("UPDATE agent_turn_executions SET expires_at = 1 WHERE id = ?")
        .run(expiredTurnId);
    })();

    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_chat_events WHERE user_id = ? AND chat_id = ?",
    ).get(OWNER, chatId)).toEqual({ count: retainedCount + 1 });

    const result = reconcileAgentRunProjections(getDb(), { nowMilliseconds: 2_000, nowSeconds: 2 });
    expect(result.inspectedProjections).toBe(1);
    expect(result.removedProjections).toBe(1);
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_run_projections WHERE user_id = ? AND chat_id = ?",
    ).get(OWNER, chatId)).toEqual({ count: retainedCount });
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_chat_events WHERE user_id = ? AND chat_id = ?",
    ).get(OWNER, chatId)).toEqual({ count: retainedCount });
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_run_projections WHERE user_id = ? AND turn_id = ?",
    ).get(OWNER, expiredTurnId)).toEqual({ count: 0 });
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_chat_events WHERE user_id = ? AND turn_id = ?",
    ).get(OWNER, expiredTurnId)).toEqual({ count: 0 });
    getDb().query(
      "UPDATE agent_turn_executions SET expires_at = 1 WHERE user_id = ? AND chat_id = ?",
    ).run(OWNER, chatId);
    const bounded = reconcileAgentRunProjections(getDb(), { nowMilliseconds: 2_000, nowSeconds: 2 });
    expect(bounded.inspectedProjections).toBe(256);
    expect(bounded.removedProjections).toBe(256);
    expect(bounded.healthy).toBe(true);
    expect(bounded.complete).toBe(false);
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_run_projections WHERE user_id = ? AND chat_id = ?",
    ).get(OWNER, chatId)).toEqual({ count: 1 });

    const converged = reconcileAgentRunProjections(getDb(), { nowMilliseconds: 2_000, nowSeconds: 2 });
    expect(converged.inspectedProjections).toBe(1);
    expect(converged.removedProjections).toBe(1);
    expect(converged.healthy).toBe(true);
    expect(converged.complete).toBe(true);
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_run_projections WHERE user_id = ? AND chat_id = ?",
    ).get(OWNER, chatId)).toEqual({ count: 0 });
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_chat_events WHERE user_id = ? AND chat_id = ?",
    ).get(OWNER, chatId)).toEqual({ count: 0 });
  });
  test("reports bounded workspace cleanup overflow until a follow-up pass converges", () => {
    const chatId = "chat-workspace-expiry-overflow";
    const workspaceCount = 256 + 1;
    seedChat(OWNER, chatId);

    getDb().transaction(() => {
      for (let index = 0; index < workspaceCount; index += 1) {
        const turnId = `turn-workspace-expiry-${index}`;
        const workspaceId = `workspace-expiry-${index}`;
        seedRun(OWNER, chatId, turnId);
        getDb().query(
          `INSERT INTO agent_turn_workspaces
            (workspace_id, turn_id, execution_id, user_id, chat_id, objective, constraints_json,
             state, revision, operation_caps_json, field_caps_json, retention, expires_at,
             quota_tasks, quota_records, quota_submissions, quota_artifacts, quota_bytes)
           VALUES (?, ?, ?, ?, ?, 'private', '{}', 'active', 1, '{}', '{}', 'turn_terminal',
                   1, 10, 10, 10, 10, 100000)`,
        ).run(workspaceId, turnId, turnId, OWNER, chatId);
      }
    })();

    const bounded = reconcileAgentRunProjections(getDb(), { nowMilliseconds: 2_000, nowSeconds: 2 });
    expect(bounded.inspectedWorkspaces).toBe(256);
    expect(bounded.removedWorkspaces).toBe(256);
    expect(bounded.healthy).toBe(true);
    expect(bounded.complete).toBe(false);
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_turn_workspaces WHERE user_id = ? AND chat_id = ?",
    ).get(OWNER, chatId)).toEqual({ count: 1 });

    const converged = reconcileAgentRunProjections(getDb(), { nowMilliseconds: 2_000, nowSeconds: 2 });
    expect(converged.inspectedWorkspaces).toBe(1);
    expect(converged.removedWorkspaces).toBe(1);
    expect(converged.healthy).toBe(true);
    expect(converged.complete).toBe(true);
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_turn_workspaces WHERE user_id = ? AND chat_id = ?",
    ).get(OWNER, chatId)).toEqual({ count: 0 });
  });
});
