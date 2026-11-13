import { getDb } from "../db/connection";
import type { SQLQueryBindings } from "bun:sqlite";
import type { EditAndSendContext } from "../llm/types";
import { clampErrorMessage, ConnectionCredentialError } from "../utils/provider-errors";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

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
  /**
   * The connection profile this request was COMMITTED against, resolved once by
   * `chats.service.editAndSend` and never re-resolved. `null` for rows written
   * before `migrations/111_generation_outbox_connection_id.sql`, and for the
   * rare commit where nothing resolved; both cases fall back to the unchanged
   * resolve-at-dispatch ladder in `generate.service`.
   */
  connection_id: string | null;
}

export interface StartEditAndSendGenerationInput {
  userId: string;
  chat_id: string;
  generationId: string;
  generation_type: EditAndSendOutboxMode;
  message_id?: string;
}

/**
 * Out-of-band declaration that a generation start came from the Edit-and-Send
 * outbox dispatch. Passed as a SECOND POSITIONAL ARGUMENT to `startGeneration`,
 * never as a field on `StartEditAndSendGenerationInput` or `GenerateInput`:
 * `chatRoute` in `src/routes/generate.routes.ts` builds its service input as
 * `handler({ ...body, userId, signal, ...extras })`, so an in-band field would
 * be settable by any client on `POST /generate`, `/regenerate`, and `/continue`,
 * handing a forged interactive send the Edit-and-Send connection override. A
 * second positional argument is structurally unreachable from body spreading,
 * because `chatRoute` calls `handler(inputObject)` with exactly one argument.
 *
 * `origin` is a compile-time constant at the single call site
 * (`dispatchClaimedEditAndSendOutbox` is only ever invoked for Edit-and-Send
 * rows), so the dispatcher performs no query and gains no table dependency.
 */
export interface StartGenerationOptions {
  origin: "edit_and_send";
  /**
   * The connection recorded on the outbox row at commit time, forwarded verbatim
   * and authoritatively. Travels in this out-of-band options bag for the exact
   * same reason `origin` does: an in-band field on
   * `StartEditAndSendGenerationInput` would be spread out of the request body by
   * `chatRoute`, letting any client forge a connection override on
   * `POST /generate`. `undefined` for pre-migration rows, which then take the
   * unchanged legacy ladder.
   */
  connectionId?: string;
  /** Trusted cursor identity, kept out of the client-controlled request body. */
  editAndSendContext?: EditAndSendContext;
}

export type StartEditAndSendGenerationFn = (
  input: StartEditAndSendGenerationInput,
  options?: StartGenerationOptions,
) => Promise<{ generationId: string; status: string }>;

export type StopEditAndSendGenerationFn = (userId: string, generationId: string) => boolean;
export type IsEditAndSendGenerationActiveFn = (userId: string, generationId: string) => boolean;

const LEASE_MS = 30_000;
// A claimed dispatch may already have reached a provider when the process dies.
// Never reclaim it for another generation attempt.
const MAX_ATTEMPTS = 1;
/** Slack (seconds) absorbing clock skew between outbox (ms) and
 *  messages.created_at (unixepoch seconds) during crash verification. */
const RECOVERY_TIMESTAMP_SLACK_SECONDS = 5;
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
    connection_id: row.connection_id ?? null,
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

/** Validate the stored cursor against the tenant, request, generation, and targets. */
function readCommittedEditAndSendContext(
  row: GenerationOutboxRow,
): EditAndSendContext | null {
  const stored = getDb()
    .query(
      `SELECT cursor FROM edit_and_send_requests
       WHERE user_id = ? AND chat_id = ? AND request_id = ?`,
    )
    .get(row.user_id, row.chat_id, row.request_id) as { cursor?: string } | undefined;
  if (!stored || typeof stored.cursor !== "string") return null;

  let cursor: unknown;
  try {
    cursor = JSON.parse(stored.cursor);
  } catch {
    return null;
  }
  if (!cursor || typeof cursor !== "object") return null;
  const record = cursor as Record<string, unknown>;

  if (record.generationId !== row.generation_id) return null;
  if (record.chatId !== row.branch_chat_id) return null;

  const context = record.editAndSendContext;
  if (!context || typeof context !== "object") return null;
  const { editedUserMessageId, committedRevision } = context as Record<string, unknown>;

  if (editedUserMessageId !== row.edited_message_id) return null;
  if (
    typeof committedRevision !== "number" ||
    !Number.isInteger(committedRevision) ||
    committedRevision < 1
  ) {
    return null;
  }

  return { editedUserMessageId, committedRevision };
}

function isClaimable(row: GenerationOutboxRow, now: number): boolean {
  // Rows whose attempts are exhausted are terminal-in-waiting: re-claiming
  // them would retry forever, so only reconcile/failure paths may close them.
  if (row.attempt_count >= MAX_ATTEMPTS) return false;
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
         AND (status != 'running' OR dispatched_at IS NULL)
         AND attempt_count < ?`,
    ).run(INSTANCE_ID, leaseExpires, now, id, now, now, MAX_ATTEMPTS);
    if (result.changes !== 1) return null;
    return getGenerationOutboxById(id);
  });
}

export function claimNextEditAndSendOutbox(now = nowMs()): GenerationOutboxRow | null {
  return withImmediateTransaction(() => {
    const candidate = getDb().query(
      `SELECT id FROM generation_outbox
       WHERE attempt_count < ?
         AND (
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
    ).get(MAX_ATTEMPTS, now, now) as { id: string } | null;
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
         AND (status != 'running' OR dispatched_at IS NULL)
         AND attempt_count < ?`,
    ).run(INSTANCE_ID, leaseExpires, now, candidate.id, now, now, MAX_ATTEMPTS);
    if (result.changes !== 1) return null;
    return getGenerationOutboxById(candidate.id);
  });
}

/**
 * `options` used to be a shared module-level constant (`EDIT_AND_SEND_ORIGIN`)
 * because `origin` was its only field and was the same for every row. The
 * committed connection is PER-ROW, so the bag is now built per dispatch by
 * `dispatchClaimedEditAndSendOutbox` and threaded through here. A mutable shared
 * object was the rejected alternative: two concurrent dispatches (the retry tick
 * overlapping a POST) would stomp each other's connection id.
 */
async function invokeStartGeneration(
  input: StartEditAndSendGenerationInput,
  options: StartGenerationOptions,
) {
  if (startGenerationFn) return startGenerationFn(input, options);
  const { startGeneration } = await import("./generate.service");
  return startGeneration(input, options);
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
  const values: SQLQueryBindings[] = [];
  for (const [key, value] of Object.entries(fields)) {
    assignments.push(`${key} = ?`);
    values.push(toSqlBinding(value));
  }
  assignments.push("updated_at = ?");
  values.push(nowMs());
  values.push(id);
  getDb().query(`UPDATE generation_outbox SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
}

/** Coerce arbitrary field values into SQLite-bindable primitives. */
function toSqlBinding(value: unknown): SQLQueryBindings {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Uint8Array) return value;
  return String(value);
}

function markDispatchFailure(
  row: GenerationOutboxRow,
  errorCode: string,
  terminalReason?: string,
): void {
  const now = nowMs();
  markOutbox(row.id, {
    status: "failed",
    last_error_code: errorCode,
    terminal_reason: terminalReason ?? "dispatch_failed",
    completed_at: now,
    next_attempt_at: null,
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

  // An invalid immutable cursor is terminal; retry cannot repair it.
  const editAndSendContext = readCommittedEditAndSendContext(row);
  if (!editAndSendContext) {
    markDispatchFailure(row, "edit_and_send_context_invalid", "edit_and_send_context_invalid");
    eventBus.emit(
      EventType.GENERATION_ENDED,
      {
        generationId: row.generation_id,
        chatId: row.branch_chat_id,
        error: "Edit-and-Send context is no longer valid",
        errorCode: "edit_and_send_context_invalid",
        errorMessage: "Edit-and-Send context is no longer valid",
        generationType: row.mode,
      },
      row.user_id,
    );
    return getGenerationOutboxById(row.id);
  }

  const input: StartEditAndSendGenerationInput = {
    userId: row.user_id,
    chat_id: row.branch_chat_id,
    generationId: row.generation_id,
    generation_type: row.mode,
    ...(row.mode === "swipe" && row.target_message_id
      ? { message_id: row.target_message_id }
      : {}),
  };

  // Strictly out of band. `connection_id` must NOT become a field on `input`:
  // `chatRoute` in `src/routes/generate.routes.ts` builds its service input as
  // `handler({ ...body, userId, signal, ...extras })`, so an in-band field is
  // client-settable on `POST /generate`, `/regenerate` and `/continue`, which
  // would hand a forged interactive send an arbitrary connection override.
  // `chatRoute` calls `handler(inputObject)` with exactly ONE argument, so a
  // second positional argument is structurally unreachable from body spreading.
  // `??  undefined` rather than passing `null`: `StartGenerationOptions.connectionId`
  // is optional, and "absent" is what the legacy ladder keys off.
  const options: StartGenerationOptions = {
    origin: "edit_and_send",
    connectionId: row.connection_id ?? undefined,
    editAndSendContext,
  };

  try {
    const started = await invokeStartGeneration(input, options);
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
    // Classify by CLASS, not by message text: the `slice(0, 200)` truncation
    // above could otherwise change the outcome. A credential that cannot be
    // resolved will not resolve on a later tick either, so it is terminal.
    if (err instanceof ConnectionCredentialError) {
      markDispatchFailure(row, err.code, "credential_unresolved");
      // Dispatches from the periodic retry tick and from startup recovery have
      // never had a user-facing error path. This is it — the same channel the
      // frontend already handles for interactive failures. `src/ws/bus` is
      // DB-free, and with no server attached (as in the dispatcher's own tests)
      // the emit is inert.
      eventBus.emit(
        EventType.GENERATION_ENDED,
        {
          generationId: row.generation_id,
          chatId: row.branch_chat_id,
          error: clampErrorMessage(err.message),
          errorCode: err.code,
          errorMessage: clampErrorMessage(err.message),
          connectionName: err.connectionName,
          generationType: row.mode,
        },
        row.user_id,
      );
      return getGenerationOutboxById(row.id);
    }
    markDispatchFailure(row, code || "dispatch_failed");
    const message = clampErrorMessage(code || "Generation dispatch failed");
    eventBus.emit(
      EventType.GENERATION_ENDED,
      {
        generationId: row.generation_id,
        chatId: row.branch_chat_id,
        error: message,
        errorCode: "dispatch_failed",
        errorMessage: message,
        generationType: row.mode,
      },
      row.user_id,
    );
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
  // Zombie sweep: pending rows whose attempts are exhausted are unclaimable
  // (claimNextEditAndSendOutbox filters attempt_count >= MAX_ATTEMPTS), so
  // without this they would sit in 'pending' forever. Fail them terminally.
  const failedZombies = getDb().query(
    `UPDATE generation_outbox
     SET status = 'failed',
         terminal_reason = COALESCE(terminal_reason, 'max_attempts'),
         completed_at = COALESCE(completed_at, ?),
         next_attempt_at = NULL,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = ?
     WHERE status = 'pending'
       AND attempt_count >= ?`,
  ).run(now, now, MAX_ATTEMPTS).changes;

  const rows = getDb()
    .query(
      `SELECT * FROM generation_outbox
       WHERE status IN ('claimed', 'running')`,
    )
    .all() as any[];
  let changed = failedZombies;
  for (const raw of rows) {
    const row = rowToOutbox(raw);
    if (row.status === "running" && row.dispatched_at) {
      // In-memory pool liveness is ONLY a skip signal: a live generation on
      // this instance is still in flight, so leave its row alone. Anything
      // else (crashed generation, cleared pool entry) goes through the SAME
      // durable verification as startup recovery: preserve saved output or
      // fail the interrupted dispatch without replaying it.
      if (invokeIsGenerationActive(row.user_id, row.generation_id)) continue;
      resolveOrphanedRunningRow(row, now);
      changed++;
      continue;
    }
    if (row.lease_expires_at != null && row.lease_expires_at < now && row.dispatched_at == null) {
      if (row.attempt_count >= MAX_ATTEMPTS) {
        // Exhausted stale claims are terminal: never re-queue them.
        markOutbox(row.id, {
          status: "failed",
          lease_owner: null,
          lease_expires_at: null,
          next_attempt_at: null,
          last_error_code: "max_attempts",
          terminal_reason: "max_attempts",
          completed_at: now,
        });
      } else {
        markOutbox(row.id, {
          status: "pending",
          lease_owner: null,
          lease_expires_at: null,
          next_attempt_at: now,
        });
      }
      changed++;
    }
  }
  return changed;
}

/**
 * Durable output verification for crash recovery. The messages table has no
 * generation_id column, so linkage uses conservative heuristics:
 * - normal mode: an assistant message row inserted into the branch chat at or
 *   after the dispatch timestamp (messages.created_at is unixepoch seconds,
 *   outbox timestamps are ms; a small slack window absorbs skew).
 *   Residual false-positive window: ANY assistant row in branch_chat_id after
 *   dispatch-5s counts as this row's output, including messages written by
 *   unrelated activity in the same branch chat during a crash window. Swipe
 *   rows have the stronger expected_version revision check and are not
 *   affected.
 * - swipe mode: the target assistant message's revision must have advanced
 *   past expected_version (chats.service bumps revision on every
 *   edit-and-send swipe write).
 */
function hasPersistedEditAndSendOutput(row: GenerationOutboxRow): boolean {
  const dispatchedAt = row.dispatched_at ?? 0;
  if (!dispatchedAt) return false;
  const afterSeconds = Math.floor(dispatchedAt / 1000) - RECOVERY_TIMESTAMP_SLACK_SECONDS;
  const inserted = getDb()
    .query(
      `SELECT id FROM messages
       WHERE chat_id = ? AND is_user = 0 AND created_at >= ?
       LIMIT 1`,
    )
    .get(row.branch_chat_id, afterSeconds);
  if (inserted) return true;
  if (row.mode === "swipe" && row.target_message_id) {
    const target = getDb()
      .query(`SELECT revision FROM messages WHERE id = ? AND chat_id = ? LIMIT 1`)
      .get(row.target_message_id, row.branch_chat_id) as { revision?: number } | undefined;
    return !!target && typeof target.revision === "number" && target.revision > row.expected_version;
  }
  return false;
}

/**
 * Durable resolution for a dispatched-but-unfinished running row whose
 * generating instance is gone. Shared by startup crash recovery and the
 * periodic reconcile tick: verify persisted output before completing;
 * otherwise mark it failed without issuing another generation request.
 */
function resolveOrphanedRunningRow(row: GenerationOutboxRow, now: number): void {
  if (hasPersistedEditAndSendOutput(row)) {
    markOutbox(row.id, {
      status: "completed",
      completed_at: row.completed_at ?? now,
      lease_owner: null,
      lease_expires_at: null,
      terminal_reason: "verified_output",
      last_error_code: null,
    });
    return;
  }

  markOutbox(row.id, {
    status: "failed",
    lease_owner: null,
    lease_expires_at: null,
    next_attempt_at: null,
    last_error_code: "output_not_verified",
    terminal_reason: "output_not_verified",
    completed_at: now,
  });
}

export async function recoverEditAndSendOutbox(): Promise<number> {
  const now = nowMs();
  withImmediateTransaction(() => {
    // Release stale, never-dispatched claims back to the pending queue.
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

    // Dispatched-but-unfinished rows: verify durably whether the assistant
    // output actually persisted before declaring success.
    const orphaned = getDb()
      .query(
        `SELECT * FROM generation_outbox WHERE status = 'running' AND dispatched_at IS NOT NULL`,
      )
      .all() as any[];
    for (const raw of orphaned) {
      resolveOrphanedRunningRow(rowToOutbox(raw), now);
    }
  });
  reconcileEditAndSendOutbox(now);
  return dispatchPendingEditAndSendOutbox();
}
