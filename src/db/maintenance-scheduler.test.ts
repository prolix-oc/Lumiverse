import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { closeDatabase, getDb, initDatabase } from "./connection";
import {
  startAutomaticDatabaseMaintenance,
  stopAutomaticDatabaseMaintenance,
} from "./maintenance-scheduler";
import {
  resetEditAndSendDispatcherForTests,
  setEditAndSendGenerationActiveCheck,
  setEditAndSendStartGeneration,
} from "../services/edit-and-send-dispatcher.service";

function initSchedulerDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(readFileSync(new URL("./baseline.sql", import.meta.url), "utf8"));
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
  // Dispatch requires the immutable cursor committed alongside the outbox row.
  const committed = row(id);
  const cursor = {
    generationId: committed.generation_id,
    chatId: committed.branch_chat_id,
    requestId: committed.request_id,
    mode: committed.mode,
    editAndSendContext: {
      editedUserMessageId: committed.edited_message_id,
      committedRevision: committed.expected_version + 1,
    },
  };
  getDb().query(
    `INSERT INTO edit_and_send_requests (
      id, request_id, user_id, chat_id, request_fingerprint, branch_chat_id,
      edited_message_id, target_message_id, target_swipe_index, generation_id,
      response, cursor, created_at, updated_at
    ) SELECT id, request_id, user_id, chat_id, 'scheduler-fixture', branch_chat_id,
      edited_message_id, target_message_id, target_swipe_index, generation_id,
      '{}', ?, created_at, updated_at FROM generation_outbox WHERE id = ?`,
  ).run(JSON.stringify(cursor), id);
  return id;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

function row(id: string): any {
  return getDb().query("SELECT * FROM generation_outbox WHERE id = ?").get(id);
}

beforeEach(() => {
  initSchedulerDb();
  resetEditAndSendDispatcherForTests();
});

afterEach(() => {
  stopAutomaticDatabaseMaintenance();
  resetEditAndSendDispatcherForTests();
  closeDatabase();
});

describe("automatic maintenance outbox sweep", () => {
  test("tick terminalizes an expired claim that may already have reached the provider", async () => {
    const starts: string[] = [];
    const active = new Set<string>();
    setEditAndSendStartGeneration(async (input) => {
      starts.push(input.generationId);
      active.add(input.generationId);
      return { generationId: input.generationId, status: "streaming" };
    });
    setEditAndSendGenerationActiveCheck((_userId, generationId) => active.has(generationId));

    insertOutbox({
      id: "stale-claim",
      request_id: "req-stale",
      generation_id: "gen-stale",
      status: "claimed",
      lease_owner: "dead-worker",
      lease_expires_at: Date.now() - 5_000,
      attempt_count: 1,
    });

    startAutomaticDatabaseMaintenance(
      () => getDb(),
      () => null,
      () => ":memory:",
      () => null,
      async (_name, fn) => fn(),
      10,
    );

    // Claims increment attempt_count before invoking the provider. Replaying an
    // expired claim could duplicate a generation whose acknowledgement was
    // lost, so the scheduler must converge it terminally instead.
    expect(await waitFor(() => row("stale-claim")?.status === "failed")).toBe(true);
    expect(starts).toEqual([]);
    expect(row("stale-claim")).toMatchObject({
      terminal_reason: "max_attempts",
      last_error_code: "max_attempts",
      next_attempt_at: null,
      lease_owner: null,
      lease_expires_at: null,
    });
    expect(row("stale-claim")?.completed_at).toBeNumber();
  });

  test("tick dispatches a never-attempted pending row once its backoff elapses", async () => {
    const starts: string[] = [];
    const contexts: unknown[] = [];
    const active = new Set<string>();
    setEditAndSendStartGeneration(async (input, options) => {
      starts.push(input.generationId);
      contexts.push(options?.editAndSendContext);
      active.add(input.generationId);
      return { generationId: input.generationId, status: "streaming" };
    });
    setEditAndSendGenerationActiveCheck((_userId, generationId) => active.has(generationId));

    insertOutbox({
      id: "orphan-run",
      request_id: "req-orphan",
      generation_id: "gen-orphan",
      branch_chat_id: "branch-orphan",
      status: "pending",
      attempt_count: 0,
      next_attempt_at: Date.now() + 60_000,
    });

    startAutomaticDatabaseMaintenance(
      () => getDb(),
      () => null,
      () => ":memory:",
      () => null,
      async (_name, fn) => fn(),
      10,
    );

    // A future backoff keeps a never-attempted row pending.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(row("orphan-run")?.status).toBe("pending");
    expect(starts).toEqual([]);
    expect(row("orphan-run")?.next_attempt_at).toBeGreaterThan(Date.now());

    // Simulate backoff expiry; the very next tick's sweep must pick it up.
    getDb()
      .query("UPDATE generation_outbox SET next_attempt_at = ? WHERE id = ?")
      .run(Date.now() - 1, "orphan-run");

    expect(await waitFor(() => row("orphan-run")?.status === "running")).toBe(true);
    expect(starts).toEqual(["gen-orphan"]);
    expect(contexts).toEqual([{ editedUserMessageId: "m1", committedRevision: 2 }]);
  });
});
