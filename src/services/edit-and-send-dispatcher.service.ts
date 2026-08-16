import { getDb } from "../db/connection";

export type EditAndSendOutboxStatus =
  | "pending"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type EditAndSendOutboxMode = "normal" | "swipe";

export interface GenerationOutboxRow {
  id: string;
  request_id: string;
  user_id: string;
  chat_id: string;
  branch_chat_id: string;
  edited_message_id: string;
  target_message_id: string | null;
  target_swipe_index: number | null;
  expected_version: number;
  generation_id: string;
  mode: EditAndSendOutboxMode;
  status: EditAndSendOutboxStatus;
  lease_owner: string | null;
  lease_expires_at: number | null;
  attempt_count: number;
  next_attempt_at: number | null;
  last_error_code: string | null;
  terminal_reason: string | null;
  dispatched_at: number | null;
  completed_at: number | null;
  cancelled_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface StartEditAndSendGenerationInput {
  userId: string;
  chat_id: string;
  generationId: string;
  generation_type: EditAndSendOutboxMode;
  message_id?: string;
}

export type StartEditAndSendGenerationFn = (
  input: StartEditAndSendGenerationInput,
) => Promise<{ generationId: string; status: string }>;

export type StopEditAndSendGenerationFn = (userId: string, generationId: string) => boolean;
export type IsEditAndSendGenerationActiveFn = (userId: string, generationId: string) => boolean;

const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 8;
const INSTANCE_ID = `eas-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

let startGenerationFn: StartEditAndSendGenerationFn | null = null;
let stopGenerationFn: StopEditAndSendGenerationFn | null = null;
let isGenerationActiveFn: IsEditAndSendGenerationActiveFn | null = null;

export function setEditAndSendStartGeneration(fn: StartEditAndSendGenerationFn | null): void {
  startGenerationFn = fn;
}

export function setEditAndSendStopGeneration(fn: StopEditAndSendGenerationFn | null): void {
  stopGenerationFn = fn;
}

export function setEditAndSendGenerationActiveCheck(fn: IsEditAndSendGenerationActiveFn | null): void {
  isGenerationActiveFn = fn;
}

export function resetEditAndSendDispatcherForTests(): void {
  startGenerationFn = null;
  stopGenerationFn = null;
  isGenerationActiveFn = null;
}

function nowMs(): number {
  return Date.now();
}

function backoffMs(attemptCount: number): number {
  return Math.min(60_000, 1000 * (2 ** Math.max(0, attemptCount - 1)));
}

function withImmediateTransaction<T>(fn: () => T): T {
  const db = getDb();
  const txn = db.transaction(fn) as (() => T) & { immediate?: () => T };
  if (typeof txn.immediate === "function") return txn.immediate();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
}

function rowToOutbox(row: any): GenerationOutboxRow {
  return {
    id: row.id,
    request_id: row.request_id,
    user_id: row.user_id,
    chat_id: row.chat_id,
    branch_chat_id: row.branch_chat_id,
    edited_message_id: row.edited_message_id,
    target_message_id: row.target_message_id ?? null,
    target_swipe_index: typeof row.target_swipe_index === "number" ? row.target_swipe_index : null,
    expected_version: row.expected_version,
    generation_id: row.generation_id,
    mode: row.mode,
    status: row.status,
    lease_owner: row.lease_owner ?? null,
    lease_expires_at: row.lease_expires_at ?? null,
    attempt_count: row.attempt_count ?? 0,
    next_attempt_at: row.next_attempt_at ?? null,
    last_error_code: row.last_error_code ?? null,
    terminal_reason: row.terminal_reason ?? null,
    dispatched_at: row.dispatched_at ?? null,
    completed_at: row.completed_at ?? null,
    cancelled_at: row.cancelled_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getGenerationOutboxByRequest(
  userId: string,
  chatId: string,
  requestId: string,
): GenerationOutboxRow | null {
  const row = getDb()
    .query(
      `SELECT * FROM generation_outbox
       WHERE user_id = ? AND chat_id = ? AND request_id = ?`,
    )
    .get(userId, chatId, requestId) as any;
  return row ? rowToOutbox(row) : null;
}

export function getGenerationOutboxById(id: string): GenerationOutboxRow | null {
  const row = getDb().query("SELECT * FROM generation_outbox WHERE id = ?").get(id) as any;
  return row ? rowToOutbox(row) : null;
}

export function getGenerationOutboxByGenerationId(generationId: string): GenerationOutboxRow | null {
  const row = getDb()
    .query("SELECT * FROM generation_outbox WHERE generation_id = ?")
    .get(generationId) as any;
  return row ? rowToOutbox(row) : null;
}

function isClaimable(row: GenerationOutboxRow, now: number): boolean {
  if (row.status === "pending") {
    return row.next_attempt_at == null || row.next_attempt_at <= now;
  }
  if (row.status === "claimed" || (row.status === "running" && row.dispatched_at == null)) {
    return row.lease_expires_at != null && row.lease_expires_at < now;
  }
  return false;
}

function claimOutboxRow(id: string, now: number): GenerationOutboxRow | null {
  return withImmediateTransaction(() => {
    const current = getGenerationOutboxById(id);
    if (!current || !isClaimable(current, now)) return null;
    const leaseExpires = now + LEASE_MS;
    const result = getDb().query(
      `UPDATE generation_outbox
       SET status = 'claimed',
           lease_owner = ?,
           lease_expires_at = ?,
           attempt_count = attempt_count + 1,
           updated_at = ?
       WHERE id = ?
         AND status IN ('pending', 'claimed', 'running')
         AND (status = 'pending' OR (lease_expires_at IS NOT NULL AND lease_expires_at < ?))
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         AND (status != 'running' OR dispatched_at IS NULL)`,
    ).run(INSTANCE_ID, leaseExpires, now, id, now, now);
    if (result.changes !== 1) return null;
    return getGenerationOutboxById(id);
  });
}

export function claimNextEditAndSendOutbox(now = nowMs()): GenerationOutboxRow | null {
  return withImmediateTransaction(() => {
    const candidate = getDb().query(
      `SELECT id FROM generation_outbox
       WHERE (
         (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
         OR (
           status IN ('claimed', 'running')
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at < ?
           AND (status != 'running' OR dispatched_at IS NULL)
         )
       )
       ORDER BY created_at ASC
       LIMIT 1`,
    ).get(now, now) as { id: string } | null;
    if (!candidate) return null;
    const leaseExpires = now + LEASE_MS;
    const result = getDb().query(
      `UPDATE generation_outbox
       SET status = 'claimed',
           lease_owner = ?,
           lease_expires_at = ?,
           attempt_count = attempt_count + 1,
           updated_at = ?
       WHERE id = ?
         AND status IN ('pending', 'claimed', 'running')
         AND (status = 'pending' OR (lease_expires_at IS NOT NULL AND lease_expires_at < ?))
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         AND (status != 'running' OR dispatched_at IS NULL)`,
    ).run(INSTANCE_ID, leaseExpires, now, candidate.id, now, now);
    if (result.changes !== 1) return null;
    return getGenerationOutboxById(candidate.id);
  });
}

async function invokeStartGeneration(input: StartEditAndSendGenerationInput) {
  if (startGenerationFn) return startGenerationFn(input);
  const { startGeneration } = await import("./generate.service");
  return startGeneration(input);
}

function invokeStopGeneration(userId: string, generationId: string): boolean {
  if (stopGenerationFn) return stopGenerationFn(userId, generationId);
  return false;
}

function invokeIsGenerationActive(userId: string, generationId: string): boolean {
  if (isGenerationActiveFn) return isGenerationActiveFn(userId, generationId);
  return false;
}

function markOutbox(id: string, fields: Record<string, unknown>): void {
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    assignments.push(`${key} = ?`);
    values.push(value);
  }
  assignments.push("updated_at = ?");
  values.push(nowMs());
  values.push(id);
  getDb().query(`UPDATE generation_outbox SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
}

function markDispatchFailure(row: GenerationOutboxRow, errorCode: string): void {
  const now = nowMs();
  if (row.attempt_count >= MAX_ATTEMPTS) {
    markOutbox(row.id, {
      status: "failed",
      last_error_code: errorCode,
      terminal_reason: "max_attempts",
      completed_at: now,
      lease_owner: null,
      lease_expires_at: null,
    });
    return;
  }
  markOutbox(row.id, {
    status: "pending",
    last_error_code: errorCode,
    next_attempt_at: now + backoffMs(row.attempt_count),
    lease_owner: null,
    lease_expires_at: null,
  });
}

export async function dispatchClaimedEditAndSendOutbox(row: GenerationOutboxRow): Promise<GenerationOutboxRow | null> {
  if (row.status !== "claimed") return row;
  const existing = getGenerationOutboxByGenerationId(row.generation_id);
  if (existing && existing.id !== row.id) {
    markOutbox(row.id, {
      status: "failed",
      last_error_code: "duplicate_generation_id",
      terminal_reason: "duplicate_generation_id",
      completed_at: nowMs(),
    });
    return getGenerationOutboxById(row.id);
  }
  if (row.dispatched_at) return row;

  const input: StartEditAndSendGenerationInput = {
    userId: row.user_id,
    chat_id: row.branch_chat_id,
    generationId: row.generation_id,
    generation_type: row.mode,
    ...(row.mode === "swipe" && row.target_message_id
      ? { message_id: row.target_message_id }
      : {}),
  };

  try {
    const started = await invokeStartGeneration(input);
    const now = nowMs();
    withImmediateTransaction(() => {
      const current = getGenerationOutboxById(row.id);
      if (!current || current.status === "cancelled") return;
      getDb().query(
        `UPDATE generation_outbox
         SET status = 'running',
             dispatched_at = COALESCE(dispatched_at, ?),
             lease_owner = ?,
             lease_expires_at = ?,
             last_error_code = NULL,
             updated_at = ?
         WHERE id = ?
           AND status = 'claimed'
           AND generation_id = ?
           AND dispatched_at IS NULL`,
      ).run(now, INSTANCE_ID, now + LEASE_MS, now, row.id, row.generation_id);
    });
    if (started.generationId && started.generationId !== row.generation_id) {
      // startGeneration still mints its own id until the generate.service patch.
      // Keep the committed outbox identity as the durable dispatch key.
    }
    return getGenerationOutboxById(row.id);
  } catch (err) {
    const code = err instanceof Error ? err.message.slice(0, 200) : "dispatch_failed";
    markDispatchFailure(row, code || "dispatch_failed");
    return getGenerationOutboxById(row.id);
  }
}

export async function dispatchEditAndSendRequest(
  userId: string,
  chatId: string,
  requestId: string,
): Promise<GenerationOutboxRow | null> {
  const existing = getGenerationOutboxByRequest(userId, chatId, requestId);
  if (!existing) return null;
  if (existing.status === "completed" || existing.status === "cancelled") return existing;
  if (existing.status === "failed") return existing;
  if (existing.status === "running" && existing.dispatched_at) return existing;

  const claimed = claimOutboxRow(existing.id, nowMs());
  if (!claimed) return getGenerationOutboxByRequest(userId, chatId, requestId);
  return dispatchClaimedEditAndSendOutbox(claimed);
}

export async function dispatchPendingEditAndSendOutbox(limit = 16): Promise<number> {
  let dispatched = 0;
  for (let i = 0; i < limit; i++) {
    const claimed = claimNextEditAndSendOutbox();
    if (!claimed) break;
    await dispatchClaimedEditAndSendOutbox(claimed);
    dispatched++;
  }
  return dispatched;
}

export function cancelEditAndSendOutbox(
  userId: string,
  opts: { requestId?: string; generationId?: string; chatId?: string },
): GenerationOutboxRow | null {
  const now = nowMs();
  const cancelled = withImmediateTransaction(() => {
    const row = opts.generationId
      ? getGenerationOutboxByGenerationId(opts.generationId)
      : opts.requestId && opts.chatId
        ? getGenerationOutboxByRequest(userId, opts.chatId, opts.requestId)
        : null;
    if (!row || row.user_id !== userId) return null;
    if (row.status === "completed" || row.status === "cancelled") return row;
    getDb().query(
      `UPDATE generation_outbox
       SET status = 'cancelled',
           cancelled_at = ?,
           terminal_reason = 'cancelled',
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = ?
       WHERE id = ?
         AND user_id = ?
         AND status NOT IN ('completed', 'cancelled')`,
    ).run(now, now, row.id, userId);
    return getGenerationOutboxById(row.id);
  });
  if (cancelled?.generation_id) invokeStopGeneration(userId, cancelled.generation_id);
  return cancelled;
}

export function reconcileEditAndSendOutbox(now = nowMs()): number {
  const rows = getDb()
    .query(
      `SELECT * FROM generation_outbox
       WHERE status IN ('claimed', 'running')`,
    )
    .all() as any[];
  let changed = 0;
  for (const raw of rows) {
    const row = rowToOutbox(raw);
    if (row.status === "running" && row.dispatched_at) {
      if (!invokeIsGenerationActive(row.user_id, row.generation_id)) {
        markOutbox(row.id, {
          status: "completed",
          completed_at: now,
          lease_owner: null,
          lease_expires_at: null,
          terminal_reason: "reconciled",
        });
        changed++;
      }
      continue;
    }
    if (row.lease_expires_at != null && row.lease_expires_at < now && row.dispatched_at == null) {
      markOutbox(row.id, {
        status: "pending",
        lease_owner: null,
        lease_expires_at: null,
        next_attempt_at: now,
      });
      changed++;
    }
  }
  return changed;
}

export async function recoverEditAndSendOutbox(): Promise<number> {
  const now = nowMs();
  withImmediateTransaction(() => {
    getDb().query(
      `UPDATE generation_outbox
       SET status = 'pending',
           lease_owner = NULL,
           lease_expires_at = NULL,
           next_attempt_at = ?,
           updated_at = ?
       WHERE status IN ('claimed', 'running')
         AND dispatched_at IS NULL
         AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
    ).run(now, now, now);
    getDb().query(
      `UPDATE generation_outbox
       SET status = 'completed',
           completed_at = COALESCE(completed_at, ?),
           lease_owner = NULL,
           lease_expires_at = NULL,
           terminal_reason = COALESCE(terminal_reason, 'startup_reconciled'),
           updated_at = ?
       WHERE status = 'running'
         AND dispatched_at IS NOT NULL`,
    ).run(now, now);
  });
  return dispatchPendingEditAndSendOutbox();
}
