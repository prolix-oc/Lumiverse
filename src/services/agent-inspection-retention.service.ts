import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import type {
  AgentActivityMilestoneV1,
  AgentActivityUsageV2,
  AgentWorkspaceAssociationV1,
} from "../types/agent-run-projection";

const MAX_ID_LENGTH = 256;
const MAX_LIST_LIMIT = 64;
const MAX_ACTIVITY_NODES = 128;
const MAX_ACTIVITY_JSON_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const EMPTY_USAGE: AgentActivityUsageV2 = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  toolCalls: 0,
  childInvocations: 0,
});

export type AgentInspectionDeletedSourceKindV1 = "chat" | "message" | "swipe";

export interface RetainAgentInspectionSourceDeletionInputV1 {
  readonly userId: string;
  readonly chatId: string;
  readonly sourceKind: AgentInspectionDeletedSourceKindV1;
  readonly targetMessageId?: string | null;
  readonly targetSwipeId?: number | null;
  readonly sourceDeletedAt?: number;
}

export interface LoadAgentInspectionSourceDeletionInputV1 {
  readonly userId: string;
  readonly attemptId: string;
  readonly chatId?: string;
}

export interface ListAgentInspectionSourceDeletionsInputV1 {
  readonly userId: string;
  readonly chatId: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface AgentInspectionSourceDeletionV1 {
  readonly userId: string;
  readonly attemptId: string;
  readonly previousAttemptId: string | null;
  readonly chatId: string;
  readonly sourceKind: AgentInspectionDeletedSourceKindV1;
  readonly targetMessageId: string | null;
  readonly targetSwipeId: number | null;
  readonly runId: string;
  readonly turnId: string;
  readonly generationId: string;
  readonly generationType: "normal" | "continue" | "regenerate" | "swipe";
  readonly lifecycle: "ADMIT" | "ASSEMBLE" | "WORK" | "PREPARE_COMMIT" | "RENDER" | "COMMIT" | "TERMINAL";
  readonly status: "pending" | "running" | "waiting" | "cancelling" | "terminal";
  readonly outcome: "completed" | "stopped" | "failed" | "exhausted" | "rejected" | null;
  readonly terminal: boolean;
  readonly attemptReason: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly terminalAt: number | null;
  readonly hostCorrelationId: string;
  readonly reconciliationState: "authoritative" | "reconciling" | "recovered" | "stale";
  readonly attemptVersion: number;
  readonly createdAt: number;
  readonly sourceDeletedAt: number;
  readonly activity: readonly AgentActivityMilestoneV1[];
  readonly usage: AgentActivityUsageV2;
  readonly workspaceAssociations: readonly AgentWorkspaceAssociationV1[];
}

interface AttemptRow {
  readonly user_id: string;
  readonly attempt_id: string;
  readonly previous_attempt_id: string | null;
  readonly chat_id: string;
  readonly target_message_id: string | null;
  readonly target_swipe_id: number | null;
  readonly run_id: string;
  readonly turn_id: string;
  readonly generation_id: string;
  readonly generation_type: AgentInspectionSourceDeletionV1["generationType"];
  readonly lifecycle: AgentInspectionSourceDeletionV1["lifecycle"];
  readonly status: AgentInspectionSourceDeletionV1["status"];
  readonly outcome: AgentInspectionSourceDeletionV1["outcome"];
  readonly terminal: number;
  readonly reason: string;
  readonly started_at: number;
  readonly updated_at: number;
  readonly terminal_at: number | null;
  readonly host_correlation_id: string;
  readonly reconciliation_state: AgentInspectionSourceDeletionV1["reconciliationState"];
  readonly version: number;
  readonly created_at: number;
}

interface DeletionRow {
  readonly user_id: string;
  readonly attempt_id: string;
  readonly previous_attempt_id: string | null;
  readonly chat_id: string;
  readonly source_kind: AgentInspectionDeletedSourceKindV1;
  readonly target_message_id: string | null;
  readonly target_swipe_id: number | null;
  readonly run_id: string;
  readonly turn_id: string;
  readonly generation_id: string;
  readonly generation_type: AgentInspectionSourceDeletionV1["generationType"];
  readonly lifecycle: AgentInspectionSourceDeletionV1["lifecycle"];
  readonly status: AgentInspectionSourceDeletionV1["status"];
  readonly outcome: AgentInspectionSourceDeletionV1["outcome"];
  readonly terminal: number;
  readonly attempt_reason: string;
  readonly started_at: number;
  readonly updated_at: number;
  readonly terminal_at: number | null;
  readonly host_correlation_id: string;
  readonly reconciliation_state: AgentInspectionSourceDeletionV1["reconciliationState"];
  readonly attempt_version: number;
  readonly created_at: number;
  readonly source_deleted_at: number;
  readonly activity_json: string;
  readonly usage_json: string;
}

interface WorkspaceRow {
  readonly association_id: string;
  readonly workspace_id: string;
  readonly workspace_revision: number;
  readonly relation: AgentWorkspaceAssociationV1["relation"];
  readonly object_kind: AgentWorkspaceAssociationV1["objectKind"];
  readonly object_id: string | null;
  readonly source_revision: number | null;
  readonly source_deleted: number;
  readonly provenance_digest: string | null;
  readonly host_sequence: number;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_ID_LENGTH;
}

function validNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasTable(db: Database, table: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table) !== null;
}

function correlation(row: Pick<DeletionRow, "turn_id" | "run_id" | "attempt_id" | "chat_id" | "generation_id" | "target_message_id" | "target_swipe_id" | "lifecycle" | "host_correlation_id">, hostSequence: number) {
  return Object.freeze({
    turnSessionId: row.turn_id,
    runId: row.run_id,
    attemptId: row.attempt_id,
    chatId: row.chat_id,
    generationId: row.generation_id,
    messageId: row.target_message_id,
    swipeId: row.target_swipe_id,
    actorId: null,
    recipientId: null,
    phase: row.lifecycle,
    taskId: null,
    toolId: null,
    parentId: null,
    hostCorrelationId: row.host_correlation_id,
    hostSequence,
  });
}

function safeActivity(db: Database, row: AttemptRow): readonly AgentActivityMilestoneV1[] {
  if (!hasTable(db, "agent_run_activity_nodes")) return Object.freeze([]);
  const rows = db.query(
    `SELECT node_id, parent_node_id, kind, actor, phase, status, safe_label, tool_id, task_id,
            host_sequence, started_at, ended_at, elapsed_ms
       FROM agent_run_activity_nodes
      WHERE user_id = ? AND attempt_id = ?
      ORDER BY host_sequence, node_id LIMIT ?`,
  ).all(row.user_id, row.attempt_id, MAX_ACTIVITY_NODES) as Array<Record<string, unknown>>;
  return Object.freeze(rows.flatMap((item): AgentActivityMilestoneV1[] => {
    if (
      !validId(item.node_id)
      || !(item.parent_node_id === null || validId(item.parent_node_id))
      || !["root", "provider", "child", "tool", "milestone"].includes(String(item.kind))
      || !["host", "owner", "provider", "agent", "child", "tool"].includes(String(item.actor))
      || !["ADMIT", "ASSEMBLE", "WORK", "PREPARE_COMMIT", "RENDER", "COMMIT", "TERMINAL"].includes(String(item.phase))
      || !["pending", "running", "waiting", "cancelling", "terminal", "omitted"].includes(String(item.status))
      || typeof item.safe_label !== "string"
      || item.safe_label.length > MAX_ID_LENGTH
      || !(item.tool_id === null || validId(item.tool_id))
      || !(item.task_id === null || validId(item.task_id))
      || !validNonNegativeInteger(item.host_sequence)
      || !validNonNegativeInteger(item.started_at)
      || !(item.ended_at === null || validNonNegativeInteger(item.ended_at))
      || !(item.elapsed_ms === null || validNonNegativeInteger(item.elapsed_ms))
    ) return [];
    return [Object.freeze({
      version: 1,
      id: item.node_id,
      parentId: item.parent_node_id as string | null,
      kind: item.kind as AgentActivityMilestoneV1["kind"],
      actor: item.actor as AgentActivityMilestoneV1["actor"],
      phase: item.phase as AgentActivityMilestoneV1["phase"],
      status: item.status as AgentActivityMilestoneV1["status"],
      label: item.safe_label,
      toolId: item.tool_id as string | null,
      taskId: item.task_id as string | null,
      sequence: item.host_sequence,
      startedAt: item.started_at,
      endedAt: item.ended_at as number | null,
      elapsedMs: item.elapsed_ms as number | null,
      usage: null,
      correlation: correlation({
        turn_id: row.turn_id,
        run_id: row.run_id,
        attempt_id: row.attempt_id,
        chat_id: row.chat_id,
        generation_id: row.generation_id,
        target_message_id: row.target_message_id,
        target_swipe_id: row.target_swipe_id,
        lifecycle: row.lifecycle,
        host_correlation_id: row.host_correlation_id,
      }, item.host_sequence),
    })];
  }));
}

function serializeActivity(activity: readonly AgentActivityMilestoneV1[]): string {
  const parts: string[] = [];
  let byteLength = 2;
  for (const item of activity) {
    const json = JSON.stringify(item);
    const itemBytes = encoder.encode(json).byteLength + (parts.length === 0 ? 0 : 1);
    if (byteLength + itemBytes > MAX_ACTIVITY_JSON_BYTES) break;
    parts.push(json);
    byteLength += itemBytes;
  }
  return `[${parts.join(",")}]`;
}

function safeUsage(db: Database, row: AttemptRow): AgentActivityUsageV2 {
  if (!hasTable(db, "agent_run_usage_evidence")) return EMPTY_USAGE;
  const totals = db.query(
    `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(tool_calls), 0) AS tool_calls,
            COALESCE(SUM(child_invocations), 0) AS child_invocations
       FROM agent_run_usage_evidence
      WHERE user_id = ? AND attempt_id = ? AND source <> 'recovered_duplicate'`,
  ).get(row.user_id, row.attempt_id) as Record<string, unknown> | null;
  if (!totals) return EMPTY_USAGE;
  const values = [totals.input_tokens, totals.output_tokens, totals.total_tokens, totals.tool_calls, totals.child_invocations];
  if (!values.every(validNonNegativeInteger)) return EMPTY_USAGE;
  return Object.freeze({
    inputTokens: totals.input_tokens as number,
    outputTokens: totals.output_tokens as number,
    totalTokens: totals.total_tokens as number,
    toolCalls: totals.tool_calls as number,
    childInvocations: totals.child_invocations as number,
  });
}

function workspaceRows(db: Database, userId: string, attemptId: string): WorkspaceRow[] {
  return db.query(
    `SELECT association_id, workspace_id, workspace_revision, relation, object_kind, object_id,
            source_revision, source_deleted, provenance_digest, host_sequence
       FROM agent_run_source_deletion_workspace
      WHERE user_id = ? AND attempt_id = ?
      ORDER BY host_sequence, association_id`,
  ).all(userId, attemptId) as WorkspaceRow[];
}

function parseActivity(json: string): readonly AgentActivityMilestoneV1[] {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? Object.freeze(value.slice(0, MAX_ACTIVITY_NODES)) : Object.freeze([]);
  } catch {
    return Object.freeze([]);
  }
}

function parseUsage(json: string): AgentActivityUsageV2 {
  try {
    const value = JSON.parse(json) as Partial<AgentActivityUsageV2>;
    if ([value.inputTokens, value.outputTokens, value.totalTokens, value.toolCalls, value.childInvocations].every(validNonNegativeInteger)) {
      return Object.freeze({
        inputTokens: value.inputTokens!,
        outputTokens: value.outputTokens!,
        totalTokens: value.totalTokens!,
        toolCalls: value.toolCalls!,
        childInvocations: value.childInvocations!,
      });
    }
  } catch {
    // Fall through to the bounded empty aggregate.
  }
  return EMPTY_USAGE;
}

function fromRow(db: Database, row: DeletionRow): AgentInspectionSourceDeletionV1 {
  const workspaceAssociations = workspaceRows(db, row.user_id, row.attempt_id).map((item) => Object.freeze({
    version: 1 as const,
    id: item.association_id,
    workspaceId: item.workspace_id,
    workspaceRevision: item.workspace_revision,
    relation: item.relation,
    objectKind: item.object_kind,
    objectId: item.object_id,
    sourceRevision: item.source_revision,
    sourceDeleted: true,
    provenanceDigest: item.provenance_digest,
    correlation: correlation(row, item.host_sequence),
  }));
  return Object.freeze({
    userId: row.user_id,
    attemptId: row.attempt_id,
    previousAttemptId: row.previous_attempt_id,
    chatId: row.chat_id,
    sourceKind: row.source_kind,
    targetMessageId: row.target_message_id,
    targetSwipeId: row.target_swipe_id,
    runId: row.run_id,
    turnId: row.turn_id,
    generationId: row.generation_id,
    generationType: row.generation_type,
    lifecycle: row.lifecycle,
    status: row.status,
    outcome: row.outcome,
    terminal: row.terminal === 1,
    attemptReason: row.attempt_reason,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
    hostCorrelationId: row.host_correlation_id,
    reconciliationState: row.reconciliation_state,
    attemptVersion: row.attempt_version,
    createdAt: row.created_at,
    sourceDeletedAt: row.source_deleted_at,
    activity: parseActivity(row.activity_json),
    usage: parseUsage(row.usage_json),
    workspaceAssociations: Object.freeze(workspaceAssociations),
  });
}

function attemptWhere(input: RetainAgentInspectionSourceDeletionInputV1): { sql: string; params: Array<string | number | null> } {
  if (input.sourceKind === "chat") return { sql: "user_id = ? AND chat_id = ?", params: [input.userId, input.chatId] };
  if (input.sourceKind === "message") {
    return { sql: "user_id = ? AND chat_id = ? AND target_message_id = ?", params: [input.userId, input.chatId, input.targetMessageId ?? null] };
  }
  return {
    sql: "user_id = ? AND chat_id = ? AND target_message_id = ? AND target_swipe_id = ?",
    params: [input.userId, input.chatId, input.targetMessageId ?? null, input.targetSwipeId ?? null],
  };
}

function detachLegacySourceReferences(db: Database, input: RetainAgentInspectionSourceDeletionInputV1): void {
  const tables = ["agent_turn_commit_receipts", "agent_published_workspace_artifacts"] as const;
  for (const table of tables) {
    if (!hasTable(db, table)) continue;
    if (input.sourceKind === "chat") {
      db.query(
        `UPDATE ${table} SET message_id = NULL, swipe_id = NULL
          WHERE user_id = ? AND chat_id = ?
            AND (message_id IS NOT NULL OR swipe_id IS NOT NULL)`,
      ).run(input.userId, input.chatId);
      continue;
    }
    if (input.sourceKind === "swipe") {
      db.query(
        `UPDATE ${table} SET message_id = NULL, swipe_id = NULL
          WHERE user_id = ? AND chat_id = ? AND message_id = ? AND swipe_id = ?`,
      ).run(input.userId, input.chatId, input.targetMessageId!, input.targetSwipeId!);
      db.query(
        `UPDATE ${table} SET swipe_id = swipe_id - 1
          WHERE user_id = ? AND chat_id = ? AND message_id = ? AND swipe_id > ?`,
      ).run(input.userId, input.chatId, input.targetMessageId!, input.targetSwipeId!);
      continue;
    }
    db.query(
      `UPDATE ${table} SET message_id = NULL, swipe_id = NULL
        WHERE user_id = ? AND chat_id = ? AND message_id = ?`,
    ).run(input.userId, input.chatId, input.targetMessageId!);
  }
}

const ATTEMPT_PRIVATE_TABLES = [
  "agent_run_audit_records",
  "agent_run_turn_session_entries",
  "agent_run_activity_nodes",
  "agent_run_inspection_markers",
  "agent_run_usage_evidence",
  "agent_run_prompt_evidence",
  "agent_run_cortex_receipts",
  "agent_run_council_receipts",
  "agent_run_workspace_associations",
] as const;

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function deleteAttemptPrivateRows(db: Database, attempts: readonly AttemptRow[]): void {
  if (attempts.length === 0) return;
  const userId = attempts[0]!.user_id;
  const attemptIds = [...new Set(attempts.map((row) => row.attempt_id))];
  const marks = placeholders(attemptIds.length);

  // The explicit NULL update keeps surviving retry lineage valid when a
  // deployment has foreign-key enforcement disabled.
  if (hasTable(db, "agent_run_attempts")) {
    db.query(
      `UPDATE agent_run_attempts
          SET previous_attempt_id = NULL
        WHERE user_id = ? AND previous_attempt_id IN (${marks})`,
    ).run(userId, ...attemptIds);
  }
  for (const table of ATTEMPT_PRIVATE_TABLES) {
    if (!hasTable(db, table)) continue;
    db.query(
      `DELETE FROM ${table}
        WHERE user_id = ? AND attempt_id IN (${marks})`,
    ).run(userId, ...attemptIds);
  }
  if (hasTable(db, "agent_run_attempts")) {
    db.query(
      `DELETE FROM agent_run_attempts
        WHERE user_id = ? AND attempt_id IN (${marks})`,
    ).run(userId, ...attemptIds);
  }
}

function deleteLegacyActivityRows(db: Database, input: RetainAgentInspectionSourceDeletionInputV1): void {
  if (!hasTable(db, "agent_activity_runs")) return;
  if (input.sourceKind === "chat") {
    db.query(
      `DELETE FROM agent_activity_runs WHERE user_id = ? AND chat_id = ?`,
    ).run(input.userId, input.chatId);
    return;
  }
  db.query(
    `DELETE FROM agent_activity_runs
      WHERE user_id = ? AND chat_id = ? AND target_message_id = ?
        ${input.sourceKind === "swipe" ? "AND target_swipe_id = ?" : ""}`,
  ).run(
    input.userId,
    input.chatId,
    input.targetMessageId!,
    ...(input.sourceKind === "swipe" ? [input.targetSwipeId!] : []),
  );
}

type ExecutionOwnershipColumn =
  | "turn_id"
  | "execution_id"
  | "workspace_id"
  | "task_id"
  | "source_task_id";

function deleteExecutionScopedRows(
  db: Database,
  table: string,
  userId: string,
  executionIds: readonly string[],
  workspaceIds: readonly string[],
  taskIds: readonly string[],
  columns: readonly ExecutionOwnershipColumn[],
  columnCache: Map<string, ReadonlySet<string>>,
): void {
  let tableColumns = columnCache.get(table);
  if (tableColumns === undefined) {
    const discoveredColumns = new Set<string>();
    if (hasTable(db, table)) {
      const quotedTable = table.replaceAll('"', '""');
      const rows = db.query(`PRAGMA table_info("${quotedTable}")`).all() as unknown[];
      for (const row of rows) {
        if (typeof row === "object" && row !== null && "name" in row && typeof row.name === "string") {
          discoveredColumns.add(row.name);
        }
      }
    }
    tableColumns = discoveredColumns;
    columnCache.set(table, tableColumns);
  }
  if (!tableColumns.has("user_id")) return;

  const predicates: string[] = [];
  const params: string[] = [userId];
  for (const column of columns) {
    if (!tableColumns.has(column)) continue;
    const ids = column === "workspace_id"
      ? workspaceIds
      : column === "task_id" || column === "source_task_id"
        ? taskIds
        : executionIds;
    if (ids.length === 0) continue;
    predicates.push(`${column} IN (${placeholders(ids.length)})`);
    params.push(...ids);
  }
  if (predicates.length === 0) return;
  const quotedTable = table.replaceAll('"', '""');
  db.query(
    `DELETE FROM "${quotedTable}"
      WHERE user_id = ? AND (${predicates.join(" OR ")})`,
  ).run(...params);
}

function removeOperationalSourceRows(db: Database, input: RetainAgentInspectionSourceDeletionInputV1): void {
  if (!hasTable(db, "agent_turn_executions")) return;
  const target = input.sourceKind === "chat"
    ? { sql: "user_id = ? AND chat_id = ?", params: [input.userId, input.chatId] }
    : input.sourceKind === "message"
      ? {
        sql: "user_id = ? AND chat_id = ? AND target_message_id = ?",
        params: [input.userId, input.chatId, input.targetMessageId!],
      }
      : {
        sql: "user_id = ? AND chat_id = ? AND target_message_id = ? AND target_swipe_id = ?",
        params: [input.userId, input.chatId, input.targetMessageId!, input.targetSwipeId!],
      };
  const executions = db.query(
    `SELECT id FROM agent_turn_executions WHERE ${target.sql}`,
  ).all(...target.params) as Array<{ id: string }>;
  const executionIds = [...new Set(executions.map((row) => row.id).filter(validId))];
  if (executionIds.length === 0) return;
  const tableColumnCache = new Map<string, ReadonlySet<string>>();
  const executionMarks = placeholders(executionIds.length);
  const workspaceIds = hasTable(db, "agent_turn_workspaces")
    ? (db.query(
      `SELECT workspace_id FROM agent_turn_workspaces
        WHERE user_id = ? AND (execution_id IN (${executionMarks}) OR turn_id IN (${executionMarks}))`,
    ).all(input.userId, ...executionIds, ...executionIds) as Array<{ workspace_id: string }>)
      .map((row) => row.workspace_id)
      .filter(validId)
    : [];
  const workspaceMarks = placeholders(workspaceIds.length);
  const taskIds = hasTable(db, "agent_workspace_tasks")
    ? (db.query(
      `SELECT task_id FROM agent_workspace_tasks
        WHERE user_id = ? AND (
          turn_id IN (${executionMarks})
          ${workspaceIds.length > 0 ? `OR workspace_id IN (${workspaceMarks})` : ""}
        )`,
    ).all(
      input.userId,
      ...executionIds,
      ...workspaceIds,
    ) as Array<{ task_id: string }>)
      .map((row) => row.task_id)
      .filter(validId)
    : [];
  // These status-only projections are operational children of the execution.
  // Remove them explicitly so foreign-key-disabled databases do not retain
  // orphaned source projections or events.
  deleteExecutionScopedRows(
    db,
    "agent_chat_events",
    input.userId,
    executionIds,
    [],
    [],
    ["turn_id"],
    tableColumnCache,
  );
  deleteExecutionScopedRows(
    db,
    "agent_run_projections",
    input.userId,
    executionIds,
    [],
    [],
    ["turn_id"],
    tableColumnCache,
  );


  // Commit receipts are operational and may carry RESTRICT references to the
  // source message. Delete them before the execution/workspace rows.
  deleteExecutionScopedRows(
    db,
    "agent_turn_commit_receipts",
    input.userId,
    executionIds,
    workspaceIds,
    taskIds,
    ["turn_id", "execution_id", "workspace_id"],
    tableColumnCache,
  );
  deleteExecutionScopedRows(
    db,
    "agent_artifact_blob_journal",
    input.userId,
    executionIds,
    [],
    [],
    ["turn_id"],
    tableColumnCache,
  );
  for (const table of ["agent_workspace_records", "agent_workspace_submissions"] as const) {
    deleteExecutionScopedRows(
      db,
      table,
      input.userId,
      executionIds,
      workspaceIds,
      taskIds,
      ["turn_id", "workspace_id", "task_id"],
      tableColumnCache,
    );
  }
  deleteExecutionScopedRows(
    db,
    "agent_workspace_artifacts",
    input.userId,
    executionIds,
    workspaceIds,
    taskIds,
    ["turn_id", "workspace_id", "source_task_id"],
    tableColumnCache,
  );
  deleteExecutionScopedRows(
    db,
    "agent_workspace_tasks",
    input.userId,
    executionIds,
    workspaceIds,
    [],
    ["turn_id", "workspace_id"],
    tableColumnCache,
  );
  deleteExecutionScopedRows(
    db,
    "agent_turn_workspaces",
    input.userId,
    executionIds,
    workspaceIds,
    [],
    ["turn_id", "execution_id", "workspace_id"],
    tableColumnCache,
  );
  db.query(
    `DELETE FROM agent_turn_executions WHERE id IN (${executionMarks}) AND user_id = ?`,
  ).run(...executionIds, input.userId);

  if (input.sourceKind === "swipe") {
    db.query(
      `UPDATE agent_turn_executions
          SET target_swipe_id = target_swipe_id - 1,
              terminal_receipt_json = CASE
                WHEN terminal_receipt_json IS NOT NULL
                 AND json_valid(terminal_receipt_json)
                 AND json_type(terminal_receipt_json, '$.target.swipeId') = 'integer'
                  THEN json_set(terminal_receipt_json, '$.target.swipeId', json_extract(terminal_receipt_json, '$.target.swipeId') - 1)
                ELSE terminal_receipt_json
              END
        WHERE user_id = ? AND chat_id = ? AND target_message_id = ? AND target_swipe_id > ?`,
    ).run(input.userId, input.chatId, input.targetMessageId!, input.targetSwipeId!);
  }
}

function rebaseSurvivingSwipeInspection(
  db: Database,
  input: RetainAgentInspectionSourceDeletionInputV1,
): void {
  if (input.sourceKind !== "swipe") return;
  const params = [input.userId, input.chatId, input.targetMessageId!, input.targetSwipeId!] as const;
  if (hasTable(db, "agent_run_attempts")) {
    if (hasTable(db, "agent_run_audit_records")) {
      db.query(
        `UPDATE agent_run_audit_records
            SET payload_json = CASE
              WHEN json_type(payload_json, '$.correlation.swipeId') = 'integer'
                THEN json_set(payload_json, '$.correlation.swipeId', json_extract(payload_json, '$.correlation.swipeId') - 1)
              ELSE payload_json
            END
          WHERE user_id = ? AND chat_id = ? AND attempt_id IN (
            SELECT attempt_id FROM agent_run_attempts
             WHERE user_id = ? AND chat_id = ? AND target_message_id = ? AND target_swipe_id > ?
          )`,
      ).run(input.userId, input.chatId, ...params);
    }
    if (hasTable(db, "agent_run_turn_session_entries")) {
      db.query(
        `UPDATE agent_run_turn_session_entries
            SET detail_json = CASE
              WHEN json_type(detail_json, '$.correlation.swipeId') = 'integer'
                THEN json_set(detail_json, '$.correlation.swipeId', json_extract(detail_json, '$.correlation.swipeId') - 1)
              ELSE detail_json
            END
          WHERE user_id = ? AND chat_id = ? AND attempt_id IN (
            SELECT attempt_id FROM agent_run_attempts
             WHERE user_id = ? AND chat_id = ? AND target_message_id = ? AND target_swipe_id > ?
          )`,
      ).run(input.userId, input.chatId, ...params);
    }
    db.query(
      `UPDATE agent_run_attempts
          SET target_swipe_id = target_swipe_id - 1,
              terminal_receipt_json = CASE
                WHEN terminal_receipt_json IS NOT NULL
                 AND json_valid(terminal_receipt_json)
                 AND json_type(terminal_receipt_json, '$.target.swipeId') = 'integer'
                  THEN json_set(terminal_receipt_json, '$.target.swipeId', json_extract(terminal_receipt_json, '$.target.swipeId') - 1)
                ELSE terminal_receipt_json
              END
        WHERE user_id = ? AND chat_id = ? AND target_message_id = ? AND target_swipe_id > ?`,
    ).run(...params);
  }
  if (hasTable(db, "agent_activity_runs")) {
    db.query(
      `UPDATE agent_activity_runs SET target_swipe_id = target_swipe_id - 1
        WHERE user_id = ? AND chat_id = ? AND target_message_id = ? AND target_swipe_id > ?`,
    ).run(...params);
  }
  if (hasTable(db, "agent_run_projections")) {
    db.query(
      `UPDATE agent_run_projections SET target_swipe_id = target_swipe_id - 1
        WHERE user_id = ? AND chat_id = ? AND target_message_id = ? AND target_swipe_id > ?`,
    ).run(...params);
  }
  if (hasTable(db, "agent_run_source_deletions")) {
    db.query(
      `UPDATE agent_run_source_deletions SET target_swipe_id = target_swipe_id - 1
        WHERE user_id = ? AND chat_id = ? AND target_message_id = ? AND target_swipe_id > ?`,
    ).run(...params);
  }
}

function deleteInspectionAttemptRows(
  db: Database,
  attempts: readonly AttemptRow[],
): void {
  deleteAttemptPrivateRows(db, attempts);
}

function removeOperationalSourceRowsAndPrivateEvidence(
  db: Database,
  input: RetainAgentInspectionSourceDeletionInputV1,
  attempts: readonly AttemptRow[],
): void {
  deleteLegacyActivityRows(db, input);
  removeOperationalSourceRows(db, input);
  deleteInspectionAttemptRows(db, attempts);
  rebaseSurvivingSwipeInspection(db, input);
}

export function retainAgentInspectionSourceDeletionInTransaction(
  db: Database,
  input: RetainAgentInspectionSourceDeletionInputV1,
): readonly AgentInspectionSourceDeletionV1[] {
  if (!validId(input.userId) || !validId(input.chatId)) return Object.freeze([]);
  if (input.sourceKind !== "chat" && !validId(input.targetMessageId)) return Object.freeze([]);
  if (input.sourceKind === "swipe" && !validNonNegativeInteger(input.targetSwipeId)) return Object.freeze([]);
  const sourceDeletedAt = input.sourceDeletedAt ?? Math.floor(Date.now() / 1000);
  if (!validNonNegativeInteger(sourceDeletedAt)) return Object.freeze([]);
  const inspectionAvailable = hasTable(db, "agent_run_attempts")
    && hasTable(db, "agent_run_source_deletions");
  const where = attemptWhere(input);
  const attempts = inspectionAvailable
    ? db.query(
      `SELECT user_id, attempt_id, previous_attempt_id, chat_id, target_message_id, target_swipe_id,
              run_id, turn_id, generation_id, generation_type, lifecycle, status, outcome, terminal,
              reason, started_at, updated_at, terminal_at, host_correlation_id, reconciliation_state,
              version, created_at
         FROM agent_run_attempts WHERE ${where.sql}
        ORDER BY updated_at, attempt_id`,
    ).all(...where.params) as AttemptRow[]
    : [];
  if (inspectionAvailable) {
    const insertDeletion = db.query(
      `INSERT INTO agent_run_source_deletions
        (user_id, attempt_id, previous_attempt_id, chat_id, source_kind, target_message_id, target_swipe_id,
         run_id, turn_id, generation_id, generation_type, lifecycle, status, outcome, terminal,
         attempt_reason, started_at, updated_at, terminal_at, host_correlation_id, reconciliation_state,
         attempt_version, created_at, source_deleted_at, reason, activity_json, usage_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'source_deleted', ?, ?)
       ON CONFLICT(user_id, attempt_id) DO UPDATE SET
         source_kind = excluded.source_kind,
         source_deleted_at = MIN(agent_run_source_deletions.source_deleted_at, excluded.source_deleted_at)`,
    );
    const canRetainWorkspace = hasTable(db, "agent_run_source_deletion_workspace")
      && hasTable(db, "agent_run_workspace_associations");
    const insertWorkspace = canRetainWorkspace
      ? db.query(
        `INSERT OR REPLACE INTO agent_run_source_deletion_workspace
          (user_id, attempt_id, association_id, workspace_id, workspace_revision, relation, object_kind,
           object_id, source_revision, source_deleted, provenance_digest, host_sequence)
         SELECT user_id, attempt_id, association_id, workspace_id, workspace_revision, relation, object_kind,
                object_id, source_revision, 1, provenance_digest, host_sequence
           FROM agent_run_workspace_associations WHERE user_id = ? AND attempt_id = ?`,
      )
      : null;
    for (const row of attempts) {
      const activity = safeActivity(db, row);
      const usage = safeUsage(db, row);
      insertDeletion.run(
        row.user_id, row.attempt_id, row.previous_attempt_id, row.chat_id, input.sourceKind,
        row.target_message_id, row.target_swipe_id, row.run_id, row.turn_id, row.generation_id,
        row.generation_type, row.lifecycle, row.status, row.outcome, row.terminal, row.reason,
        row.started_at, row.updated_at, row.terminal_at, row.host_correlation_id,
        row.reconciliation_state, row.version, row.created_at, sourceDeletedAt,
        serializeActivity(activity), JSON.stringify(usage),
      );
      insertWorkspace?.run(row.user_id, row.attempt_id);
    }
  }
  detachLegacySourceReferences(db, input);
  removeOperationalSourceRowsAndPrivateEvidence(db, input, attempts);
  return Object.freeze(attempts.flatMap((row) => {
    const retained = loadAgentInspectionSourceDeletionFromDb(db, {
      userId: row.user_id,
      attemptId: row.attempt_id,
      chatId: row.chat_id,
    });
    return retained ? [retained] : [];
  }));
}

export function loadAgentInspectionSourceDeletionFromDb(
  db: Database,
  input: LoadAgentInspectionSourceDeletionInputV1,
): AgentInspectionSourceDeletionV1 | null {
  if (!validId(input.userId) || !validId(input.attemptId) || (input.chatId !== undefined && !validId(input.chatId))) return null;
  const row = db.query(
    `SELECT user_id, attempt_id, previous_attempt_id, chat_id, source_kind, target_message_id,
            target_swipe_id, run_id, turn_id, generation_id, generation_type, lifecycle, status,
            outcome, terminal, attempt_reason, started_at, updated_at, terminal_at,
            host_correlation_id, reconciliation_state, attempt_version, created_at, source_deleted_at,
            activity_json, usage_json
       FROM agent_run_source_deletions
      WHERE user_id = ? AND attempt_id = ?${input.chatId === undefined ? "" : " AND chat_id = ?"}
      LIMIT 1`,
  ).get(input.userId, input.attemptId, ...(input.chatId === undefined ? [] : [input.chatId])) as DeletionRow | null;
  return row ? fromRow(db, row) : null;
}

export function loadAgentInspectionSourceDeletion(
  input: LoadAgentInspectionSourceDeletionInputV1,
): AgentInspectionSourceDeletionV1 | null {
  try {
    return loadAgentInspectionSourceDeletionFromDb(getDb(), input);
  } catch {
    return null;
  }
}

export function listAgentInspectionSourceDeletions(
  input: ListAgentInspectionSourceDeletionsInputV1,
): readonly AgentInspectionSourceDeletionV1[] {
  if (!validId(input.userId) || !validId(input.chatId)) return Object.freeze([]);
  const limit = validNonNegativeInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, MAX_LIST_LIMIT) : MAX_LIST_LIMIT;
  const offset = validNonNegativeInteger(input.offset) ? Math.min(input.offset, 100000) : 0;
  try {
    const db = getDb();
    const rows = db.query(
      `SELECT user_id, attempt_id, previous_attempt_id, chat_id, source_kind, target_message_id,
              target_swipe_id, run_id, turn_id, generation_id, generation_type, lifecycle, status,
              outcome, terminal, attempt_reason, started_at, updated_at, terminal_at,
              host_correlation_id, reconciliation_state, attempt_version, created_at, source_deleted_at,
              activity_json, usage_json
         FROM agent_run_source_deletions WHERE user_id = ? AND chat_id = ?
        ORDER BY updated_at DESC, attempt_id DESC LIMIT ? OFFSET ?`,
    ).all(input.userId, input.chatId, limit, offset) as DeletionRow[];
    return Object.freeze(rows.map((row) => fromRow(db, row)));
  } catch {
    return Object.freeze([]);
  }
}

export function isAgentInspectionSourceDeleted(input: LoadAgentInspectionSourceDeletionInputV1): boolean {
  return loadAgentInspectionSourceDeletion(input) !== null;
}
