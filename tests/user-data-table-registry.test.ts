import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  ARCHIVE_CANONICAL_TABLES,
  ARCHIVE_REGISTRY_VERSION,
  ARCHIVE_TABLE_REGISTRY,
  assertArchiveRegistryCoverage,
  getArchiveTableSpec,
  getCanonicalImportOrder,
  buildArchiveOwnerPredicate,
  getArchiveVectorTables,
} from "../src/services/user-data/table-registry";
describe("archive table registry", () => {
  test("classifies the current archive-sensitive table families exactly once", () => {
    const names = ARCHIVE_TABLE_REGISTRY.map((spec) => spec.table);
    expect(new Set(names).size).toBe(names.length);
    expect(ARCHIVE_REGISTRY_VERSION).toBe(5);
    expect(getArchiveTableSpec("audio_files")?.kind).toBe("canonical");
    expect(getArchiveTableSpec("agent_run_projections")?.kind).toBe("operational");
    expect(getArchiveTableSpec("agent_activity_runs")?.kind).toBe("operational");
    expect(getArchiveTableSpec("multiplayer_rooms")?.kind).toBe("operational");
    expect(getArchiveTableSpec("user_data_import_receipts")?.kind).toBe("operational");
    for (const table of [
      "agent_work_segment_recovery",
      "agent_work_segments",
      "agent_work_segment_transitions",
      "agent_work_segment_dispatches",
      "agent_work_workspace_receipts",
    ]) {
      expect(getArchiveTableSpec(table)?.kind).toBe("operational");
      expect(getArchiveTableSpec(table)?.owner).toEqual({ kind: "direct", column: "user_id" });
    }
    expect(getArchiveTableSpec("agent_work_segment_recovery")?.parentEdges.map((edge) => edge.parentTable)).toEqual([
      "user",
      "agent_turn_executions",
      "agent_run_attempts",
      "agent_turn_workspaces",
    ]);
    const receiptDispatchEdge = getArchiveTableSpec("agent_work_workspace_receipts")?.parentEdges.find(
      (edge) => edge.parentTable === "agent_work_segment_dispatches",
    );
    expect(receiptDispatchEdge).toEqual({
      column: "user_id",
      parentTable: "agent_work_segment_dispatches",
      parentColumn: "user_id",
      columns: ["user_id", "execution_id", "segment_id", "logical_dispatch"],
      parentColumns: ["user_id", "execution_id", "segment_id", "dispatch_ordinal"],
      nullable: false,
      onMissing: "reject",
    });
    const sourceTransitionEdge = getArchiveTableSpec("agent_work_segments")?.parentEdges.find(
      (edge) => edge.parentTable === "agent_work_segment_transitions",
    );
    expect(sourceTransitionEdge?.nullable).toBe(true);
    expect(sourceTransitionEdge?.deferred).toBe(true);
    expect(getArchiveTableSpec("sso_providers")?.kind).toBe("forbidden");
    expect(getArchiveTableSpec("characters_fts_data")?.kind).toBe("forbidden");
    expect(getArchiveTableSpec("stream_deck_tokens")?.kind).toBe("forbidden");
    expect(getArchiveVectorTables()).toEqual(["embeddings_world_books", "embeddings"]);
    const themeFileRef = getArchiveTableSpec("theme_assets")?.fileRefs[0];
    expect(themeFileRef?.applies?.({ storage_type: "file", file_name: "theme.css" })).toBe(true);
    expect(themeFileRef?.applies?.({ storage_type: "url", file_name: "theme.css" })).toBe(false);
  });
  test("rejects both unclassified and missing required schema tables", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE rogue_archive_table (id TEXT PRIMARY KEY)");
    expect(() => assertArchiveRegistryCoverage(db)).toThrow(/unclassified=rogue_archive_table/);
    expect(() => assertArchiveRegistryCoverage(db)).toThrow(/missing=.*audio_files/);
    db.close();
  });
  test("ignores AR-008 retired tables during legacy schema coverage", () => {
    const db = new Database(":memory:");
    for (const table of ["edit_and_send_requests", "generation_outbox", "image_processing_queue"]) {
      db.run('CREATE TABLE "' + table + '" (id TEXT PRIMARY KEY)');
    }
    let error: unknown = null;
    try {
      assertArchiveRegistryCoverage(db);
    } catch (candidate) {
      error = candidate;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("unclassified=");
    expect((error as Error).message).toContain("missing=");
    db.close();
  });
  
  test("registers the migrated Weaver people table with account and session edges", () => {
    expect(getArchiveTableSpec("weaver_people")).toEqual({
      table: "weaver_people",
      kind: "canonical",
      owner: { kind: "direct", column: "user_id" },
      primaryKey: ["id"],
      uniqueKeys: [["id"]],
      parentEdges: [
        {
          column: "user_id",
          parentTable: "user",
          parentColumn: "id",
          nullable: false,
          onMissing: "reject",
        },
        {
          column: "session_id",
          parentTable: "weaver_sessions",
          parentColumn: "id",
          nullable: false,
          onMissing: "reject",
        },
      ],
      mergePolicy: "upsert",
      authorityReset: "preserve",
      fileRefs: [],
    });
    expect(getArchiveTableSpec("weaver_cast")).toBeUndefined();
  });
  test("computes parent-first order from declared canonical edges", () => {
    const order = getCanonicalImportOrder();
    const positions = new Map(order.map((table, index) => [table, index]));
    for (const spec of ARCHIVE_CANONICAL_TABLES) {
      const childPosition = positions.get(spec.table);
      expect(childPosition).toBeDefined();
      for (const edge of spec.parentEdges) {
        if (edge.deferred || edge.parentTable === spec.table) continue;
        const parentSpec = getArchiveTableSpec(edge.parentTable);
        if (parentSpec?.kind !== "canonical") continue;
        expect(positions.get(edge.parentTable)!).toBeLessThan(childPosition!);
      }
    }
  });

  test("builds nested parent ownership predicates without leaking another user", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE users (id TEXT PRIMARY KEY)");
    db.run("CREATE TABLE user_data_imports (job_id TEXT PRIMARY KEY, user_id TEXT NOT NULL)");
    db.run("CREATE TABLE user_data_import_files (id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, archive_path TEXT NOT NULL)");
    db.run("INSERT INTO users (id) VALUES ('alice'), ('bob')");
    db.run("INSERT INTO user_data_imports (job_id, user_id) VALUES ('job-a', 'alice'), ('job-b', 'bob')");
    db.run("INSERT INTO user_data_import_files (id, job_id, archive_path) VALUES (1, 'job-a', 'alice-file'), (2, 'job-b', 'bob-file')");

    const spec = getArchiveTableSpec("user_data_import_files");
    expect(spec).toBeDefined();
    const predicate = buildArchiveOwnerPredicate(spec!, "alice", '"user_data_import_files"');
    expect(predicate).toBeDefined();
    const rows = db
      .query(`SELECT archive_path FROM user_data_import_files WHERE ${predicate!.sql}`)
      .all(...predicate!.params) as { archive_path: string }[];
    expect(rows).toEqual([{ archive_path: "alice-file" }]);
    db.close();
  });

  test("builds predicate-owned extension filters as executable SQL", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE extensions (id TEXT PRIMARY KEY, installed_by_user_id TEXT, install_scope TEXT)");
    db.run("INSERT INTO extensions VALUES ('user-ext', 'alice', 'user'), ('operator-ext', 'alice', 'operator'), ('other-ext', 'bob', 'user')");

    const spec = getArchiveTableSpec("extensions");
    expect(spec).toBeDefined();
    const predicate = buildArchiveOwnerPredicate(spec!, "alice", '"extensions"');
    expect(predicate).toBeDefined();
    const rows = db
      .query(`SELECT id FROM extensions WHERE ${predicate!.sql}`)
      .all(...predicate!.params) as { id: string }[];
    expect(rows).toEqual([{ id: "user-ext" }]);
    db.close();
  });
});
