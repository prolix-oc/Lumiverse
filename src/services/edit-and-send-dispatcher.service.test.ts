import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
    updated_at INTEGER NOT NULL
  )`);
}

function insertOutbox(overrides: Record<string, unknown> = {}): string {
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
    overrides.request_id ?? "req-1",
    overrides.user_id ?? "u1",
    overrides.chat_id ?? "c1",
    overrides.branch_chat_id ?? "b1",
    overrides.edited_message_id ?? "m1",
    overrides.target_message_id ?? null,
    overrides.target_swipe_index ?? null,
    overrides.expected_version ?? 1,
    overrides.generation_id ?? `gen-${id}`,
    overrides.mode ?? "normal",
    overrides.status ?? "pending",
    overrides.lease_owner ?? null,
    overrides.lease_expires_at ?? null,
    overrides.attempt_count ?? 0,
    overrides.next_attempt_at ?? null,
    overrides.last_error_code ?? null,
    overrides.terminal_reason ?? null,
    overrides.dispatched_at ?? null,
    overrides.completed_at ?? null,
    overrides.cancelled_at ?? null,
    overrides.created_at ?? now,
    overrides.updated_at ?? now,
  );
  return id;
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

  test("crash/retry/cancellation/reconciliation", async () => {
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
    expect(expired?.id).toBe("expired");
    expect(expired?.attempt_count).toBe(2);

    insertOutbox({
      id: "fail-row",
      request_id: "req-fail",
      generation_id: "gen-fail",
      status: "pending",
    });
    const failed = await dispatchEditAndSendRequest("u1", "c1", "req-fail");
    expect(failed?.status).toBe("pending");
    expect(failed?.last_error_code).toBe("provider_down");
    expect(failed?.next_attempt_at).toBeGreaterThan(Date.now());

    insertOutbox({
      id: "run-row",
      request_id: "req-run",
      generation_id: "gen-run",
      mode: "swipe",
      target_message_id: "asst-1",
      target_swipe_index: 1,
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
    expect(reconcileEditAndSendOutbox()).toBe(1);
    expect(getGenerationOutboxById("recon")?.status).toBe("completed");
    expect(getGenerationOutboxById("recon")?.terminal_reason).toBe("reconciled");
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
    insertOutbox({
      id: "fresh",
      request_id: "req-fresh",
      generation_id: "gen-fresh",
      status: "pending",
    });

    const dispatched = await recoverEditAndSendOutbox();
    expect(dispatched).toBe(2);
    expect(started.sort()).toEqual(["gen-fresh", "gen-stale"]);
    expect(getGenerationOutboxByRequest("u1", "c1", "req-sent")?.status).toBe("completed");
    expect(getGenerationOutboxByRequest("u1", "c1", "req-fresh")?.status).toBe("running");
    expect(getGenerationOutboxByRequest("u1", "c1", "req-stale")?.status).toBe("running");

    expect(await dispatchPendingEditAndSendOutbox()).toBe(0);
  });
});
