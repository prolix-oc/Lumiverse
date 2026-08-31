import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { applyFeatureMigrationsThrough, createPreBundleDatabase } from "./test-helpers";

const migrationSql = await Bun.file(join(import.meta.dir, "135_agent_work_segments.sql")).text();
const TABLES = [
  "agent_work_segment_recovery",
  "agent_work_segments",
  "agent_work_segment_transitions",
  "agent_work_segment_dispatches",
] as const;

function createPre135Database(): Database {
  const db = createPreBundleDatabase();
  applyFeatureMigrationsThrough(db, 134);
  return db;
}

function seedHistoricalExecution(db: Database): void {
  db.query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)')
    .run("segment-user", "Segment User", "segment-user@example.test");
  db.query("INSERT INTO characters (id, name) VALUES (?, ?)")
    .run("segment-character", "Segment Character");
  db.query("INSERT INTO chats (id, user_id, character_id, name) VALUES (?, ?, ?, ?)")
    .run("segment-chat", "segment-user", "segment-character", "Segment Chat");
  db.query(`INSERT INTO agent_turn_executions
    (id, user_id, chat_id, generation_id, target_kind, target_chat_revision, mode,
     runtime_epoch, deadline_at, state, cas_revision, cas_owner, cas_expires_at,
     root_ledger_json, frame_capabilities_json, workspace_id, workspace_revision,
     commit_key, expires_at)
    VALUES (?, ?, ?, ?, 'normal', 0, 'agentic', 1, ?, 'WORK', 0, ?, ?, '{}', '{}', ?, 0, ?, ?)`)
    .run(
      "segment-execution",
      "segment-user",
      "segment-chat",
      "segment-generation",
      2_000_000_000,
      "segment-owner",
      2_000_000_000,
      "segment-workspace",
      "segment-commit",
      2_000_000_000,
    );
  db.query(`INSERT INTO agent_turn_workspaces
    (workspace_id, turn_id, execution_id, user_id, chat_id, objective,
     constraints_json, state, revision, operation_caps_json, field_caps_json,
     retention, expires_at, quota_tasks, quota_records, quota_submissions,
     quota_artifacts, quota_bytes)
    VALUES (?, ?, ?, ?, ?, ?, '[]', 'active', 0, '{}', '{}', 'turn_terminal', ?, 10, 10, 10, 10, 1000000)`)
    .run(
      "segment-workspace",
      "segment-execution",
      "segment-execution",
      "segment-user",
      "segment-chat",
      "Historical objective",
      2_000_000_000,
    );
  db.query(`INSERT INTO agent_run_attempts
    (user_id, chat_id, attempt_id, run_id, turn_id, generation_id, generation_type,
     lifecycle, status, outcome, reason, terminal, started_at, updated_at,
     host_correlation_id, reconciliation_state)
    VALUES (?, ?, ?, ?, ?, ?, 'normal', 'WORK', 'running', NULL, 'none', 0, 1, 1, ?, 'authoritative')`)
    .run(
      "segment-user",
      "segment-chat",
      "segment-attempt",
      "segment-run",
      "segment-execution",
      "segment-generation",
      "workspace-attempt:segment-attempt",
    );
}

function tableNames(db: Database): string[] {
  return (db.query(
    `SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'agent_work_segment%'
      ORDER BY name`,
  ).all() as Array<{ name: string }>).map((row) => row.name);
}

describe("135 bounded WORK segment schema", () => {
  test("does not backfill historical executions and is idempotent", () => {
    const db = createPre135Database();
    try {
      seedHistoricalExecution(db);
      db.run(migrationSql);
      expect(tableNames(db)).toEqual([...TABLES].sort());
      for (const table of TABLES) {
        expect(db.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
      db.run(migrationSql);
      expect(tableNames(db)).toEqual([...TABLES].sort());
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("stores only bounded recovery metadata with explicit owner and execution fences", () => {
    const db = createPre135Database();
    try {
      db.run(migrationSql);
      const forbiddenColumns: Record<string, true> = {
        transcript: true,
        messages: true,
        reasoning: true,
        carrier: true,
        tool_arguments: true,
        tool_result: true,
        provider_response: true,
        external_effect: true,
      };
      for (const table of TABLES) {
        const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
          notnull: number;
        }>;
        expect(columns.some((column) => Object.hasOwn(forbiddenColumns, column.name))).toBe(false);
        expect(columns.some((column) => column.name === "user_id" && column.notnull === 1)).toBe(true);
        expect(columns.some((column) => column.name === "execution_id" && column.notnull === 1)).toBe(true);
        expect(columns.some((column) => column.name === "workspace_revision" && column.notnull === 1)).toBe(true);
        expect(columns.some((column) => column.name === "execution_cas_revision" && column.notnull === 1)).toBe(true);
        expect(columns.some((column) => column.name === "schema_version" && column.notnull === 1)).toBe(true);
        expect(columns.some((column) => column.name === "record_complete" && column.notnull === 1)).toBe(true);
        expect(columns.some((column) => column.name === "payload_digest" && column.notnull === 1)).toBe(true);
      }

      // The sqlite_schema projection fixes this in-process row shape.
      const transitionSchemaRow = db.query(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'agent_work_segment_transitions'",
      ).get() as { sql: string };
      const transitionSql = transitionSchemaRow.sql;
      expect(transitionSql).toContain("advisory_authority");
      expect(transitionSql).toContain("accepted_ids_authority");
      expect(transitionSql).toContain("UNIQUE (user_id, execution_id, source_segment_id)");

      // The sqlite_schema projection fixes this in-process row shape.
      const dispatchSchemaRow = db.query(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'agent_work_segment_dispatches'",
      ).get() as { sql: string };
      const dispatchSql = dispatchSchemaRow.sql;
      expect(dispatchSql).toContain("fence_generation");
      expect(dispatchSql).toContain("lease_expires_at");
      expect(dispatchSql).toContain("settlement_digest");

      const recoveryColumns = (db.query("PRAGMA table_info(agent_work_segment_recovery)").all() as Array<{ name: string; notnull: number }>);
      for (const required of [
        "initial_required_phase_count",
        "remaining_required_phase_count",
        "max_output_tokens_per_dispatch",
        "protected_recovery_reserve_output_tokens",
        "protected_future_phase_reserve_output_tokens",
        "terminal_close_result",
        "terminal_close_reason",
        "terminal_boundary_class",
      ]) expect(recoveryColumns.map((column) => column.name)).toContain(required);
      for (const required of [
        "budget_class",
        "ordinary_output_tokens_reserved",
        "recovery_reserve_output_tokens_reserved",
        "recovery_reserve_output_tokens_consumed",
        "interruption_reason",
        "fence_generation",
      ]) {
        expect((db.query("PRAGMA table_info(agent_work_segment_dispatches)").all() as Array<{ name: string }>)
          .map((column) => column.name)).toContain(required);
      }

      const segmentSchema = (db.query(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'agent_work_segments'",
      ).get() as { sql: string }).sql;
      expect(segmentSchema).toContain("FOREIGN KEY (user_id, execution_id, attempt_id, workspace_id)");
      expect(segmentSchema).toContain("REFERENCES agent_work_segment_recovery(user_id, execution_id, attempt_id, workspace_id)");
      expect(dispatchSql).toContain("FOREIGN KEY (user_id, execution_id, segment_id, attempt_id, workspace_id)");
      expect(dispatchSql).toContain("REFERENCES agent_work_segments(user_id, execution_id, segment_id, attempt_id, workspace_id)");
      expect(dispatchSql).toContain("REFERENCES agent_work_segments(user_id, execution_id, segment_id, attempt_id, workspace_id)");

      const receiptColumns = db.query("PRAGMA table_info(agent_work_workspace_receipts)").all() as Array<{
        name: string;
        notnull: number;
      }>;
      for (const required of ["segment_id", "logical_dispatch", "frame_id"]) {
        expect(receiptColumns.find((column) => column.name === required)?.notnull).toBe(1);
      }
      const receiptSchema = (db.query(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'agent_work_workspace_receipts'",
      ).get() as { sql: string }).sql;
      expect(receiptSchema).toContain("FOREIGN KEY (user_id, execution_id, segment_id, logical_dispatch)");
      expect(receiptSchema).toContain("REFERENCES agent_work_segment_dispatches(user_id, execution_id, segment_id, dispatch_ordinal)");
      const receiptDispatchIndex = db.query(
        "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'idx_agent_work_workspace_receipts_dispatch'",
      ).get() as { sql: string };
      expect(receiptDispatchIndex.sql).toContain("user_id, execution_id, segment_id, logical_dispatch");
      const activeIndex = db.query(
        "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'idx_agent_work_segments_one_active'",
      ).get() as { sql: string };
      expect(activeIndex.sql).toContain("UNIQUE INDEX");
      expect(activeIndex.sql).toContain("WHERE lifecycle IN ('admitted', 'running')");
    } finally {
      db.close();
    }
  });
});
