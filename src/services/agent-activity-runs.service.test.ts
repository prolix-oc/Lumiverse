import { Database } from "bun:sqlite";
import { beforeEach, afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { closeDatabaseAsync, getDb, initDatabase } from "../db/connection";
import * as embeddingsSvc from "./embeddings.service";
import { chatsRoutes } from "../routes/chats.routes";
import {
  AGENT_ACTIVITY_CHAT_MAX_BYTES,
  AGENT_ACTIVITY_RUN_MAX_BYTES,
  AGENT_ACTIVITY_RUN_MAX_COUNT,
  AGENT_RUN_INSPECTION_MAX_CURSOR_BYTES,
  AGENT_RUN_INSPECTION_MAX_RECORD_BYTES,
  AGENT_RUN_INSPECTION_MAX_PAYLOAD_BYTES,
  AGENT_RUN_INSPECTION_MAX_RECORDS,
  __test__mintAgentRunInspectionCursor,
  __test__serializeAgentActivityRun,
  createAgentInspectionWriter,
  getAgentRunInspection,
  listAgentActivityRuns,
  listAgentRunInspections,
  ownsChatForActivity,
  persistAgentRunInspection,
  persistTerminalAgentActivityRun,
} from "./agent-activity-runs.service";
import type { WorkSegmentContextV1 } from "../types/agent-work-segment";
import { encodeCanonicalPlainData } from "../utils/canonical-plain-data";
import { getBreakdown, getBreakdownForAttempt, storeBreakdown } from "./breakdown.service";
import { runMigrations } from "../db/migrate";
import type { AgentActivitySnapshotV1 } from "../types/agent-runtime";
import type { PersistAgentRunInspectionInputV1 } from "./agent-activity-runs.service";

import { createTurnExecution, transitionTurnExecution } from "./turn-execution.service";
import { computeWorkSegmentContextDigestV1 } from "./agentic-work-phase.service";
import {
  computeWorkPhasePlanDigestV1,
  computeWorkSegmentResumeEnvelopeDigestV1,
  createAndAdmitInitialWorkSegmentV1,
} from "./agentic-work-segment.repository";
import { ensurePersistentWorkspaceForChat, getPersistentWorkspaceById } from "./turn-workspace.service";
import { createChat, createMessage, deleteChat, deleteMessage, deleteSwipe } from "./chats.service";

const OWNER = "activity-owner";
const OTHER = "activity-other";
const app = new Hono();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId", userId);
  await next();
});
app.route("/", chatsRoutes);

async function applyActivitySchema(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "migrations", "078_chats_character_id_nullable.sql")).text());
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "migrations", "118_agent_run_projection.sql")).text());
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "migrations", "129_agent_inspection_source_retention.sql")).text());
}

function snapshot(status: AgentActivitySnapshotV1["status"] = "completed", extra: Record<string, unknown> = {}): AgentActivitySnapshotV1 {
  return {
    version: 1,
    rootId: "root-1",
    nodes: [{
      id: "root-node",
      parentId: null,
      kind: "root_turn",
      actor: "root",
      phase: status,
      status,
      startedAt: 1,
      elapsedMs: 2,
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7, toolCalls: 1, childInvocations: 1 },
    }],
    omittedNodeCount: 0,
    errorCounts: {},
    usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7, toolCalls: 1, childInvocations: 1 },
    status,
    ...extra,
  };
}

beforeEach(async () => {
  spyOn(embeddingsSvc, "deleteChatChunkEmbeddings").mockResolvedValue(undefined);
  await closeDatabaseAsync();
  initDatabase(":memory:");
  await applyActivitySchema();
});
afterEach(async () => closeDatabaseAsync());
function inspectionInput(
  chatId: string,
  overrides: Partial<PersistAgentRunInspectionInputV1> = {},
): PersistAgentRunInspectionInputV1 {
  return {
    userId: OWNER,
    chatId,
    attemptId: "inspection-attempt",
    runId: "inspection-run",
    turnSessionId: "inspection-turn",
    generationId: "inspection-generation",
    generationType: "normal",
    hostCorrelationId: `inspection-host:${overrides.attemptId ?? "inspection-attempt"}`,
    lifecycle: "TERMINAL",
    status: "terminal",
    outcome: "completed",
    ...overrides,
  };
}

describe("agent activity fallback persistence", () => {
  test("persists target-backed and no-target terminal outcomes without changing swipe scope", () => {
    const chat = createChat(OWNER, { name: "activity" });
    const target = persistTerminalAgentActivityRun({
      userId: OWNER,
      chatId: chat.id,
      generationId: "regen-generation",
      targetMessageId: "assistant-message",
      targetSwipeId: 3,
      snapshot: snapshot("completed"),
    });
    const noTarget = persistTerminalAgentActivityRun({
      userId: OWNER,
      chatId: chat.id,
      generationId: "setup-generation",
      snapshot: snapshot("failed"),
      status: "failed",
    });
    const stopped = persistTerminalAgentActivityRun({
      userId: OWNER,
      chatId: chat.id,
      generationId: "stop-generation",
      targetMessageId: null,
      targetSwipeId: null,
      snapshot: snapshot("cancelled"),
      status: "cancelled",
    });

    expect(target?.targetMessageId).toBe("assistant-message");
    expect(target?.targetSwipeId).toBe(3);
    expect(noTarget?.targetMessageId).toBeNull();
    expect(noTarget?.targetSwipeId).toBeNull();
    expect(stopped?.snapshot.status).toBe("cancelled");
    expect(listAgentActivityRuns(OWNER, chat.id).map((run) => run.generationId)).toEqual([
      "stop-generation", "setup-generation", "regen-generation",
    ]);
  });

  test("keeps identical generation replays idempotent and rejects semantic conflicts", () => {
    const chat = createChat(OWNER, { name: "activity-replay-boundary" });
    const first = persistTerminalAgentActivityRun({
      userId: OWNER,
      chatId: chat.id,
      generationId: "replay-generation",
      snapshot: snapshot("completed"),
      status: "completed",
    });
    const storedFirst = getDb().query(
      "SELECT snapshot_json, created_at FROM agent_activity_runs WHERE user_id = ? AND chat_id = ? AND generation_id = ?",
    ).get(OWNER, chat.id, "replay-generation") as { snapshot_json: string; created_at: number };
    const replay = persistTerminalAgentActivityRun({
      userId: OWNER,
      chatId: chat.id,
      generationId: "replay-generation",
      snapshot: snapshot("completed"),
      status: "completed",
    });
    const storedReplay = getDb().query(
      "SELECT snapshot_json, created_at FROM agent_activity_runs WHERE user_id = ? AND chat_id = ? AND generation_id = ?",
    ).get(OWNER, chat.id, "replay-generation") as { snapshot_json: string; created_at: number };
    expect(replay).toEqual(first);
    expect(storedReplay).toEqual(storedFirst);

    expect(persistTerminalAgentActivityRun({
      userId: OWNER,
      chatId: chat.id,
      generationId: "replay-generation",
      snapshot: snapshot("failed"),
      status: "failed",
    })).toBeNull();
    expect(getDb().query(
      "SELECT snapshot_json, created_at FROM agent_activity_runs WHERE user_id = ? AND chat_id = ? AND generation_id = ?",
    ).get(OWNER, chat.id, "replay-generation")).toEqual(storedFirst);
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_activity_runs WHERE user_id = ? AND chat_id = ? AND generation_id = ?",
    ).get(OWNER, chat.id, "replay-generation")).toEqual({ count: 1 });
  });

  test("compares oversized terminal replays against the bounded serialized run", () => {
    const chat = createChat(OWNER, { name: "activity-oversized-replay" });
    const oversizedSnapshot = (rootId: string) => snapshot("completed", {
      rootId,
      nodes: Array.from({ length: 128 }, (_, index) => ({
        id: `oversized-node-${index}-${"x".repeat(240)}`,
        parentId: null,
        kind: "root_turn",
        actor: "root",
        phase: "completed",
        status: "completed",
        startedAt: index,
        elapsedMs: index + 1,
      })),
    });
    const first = persistTerminalAgentActivityRun({
      userId: OWNER,
      chatId: chat.id,
      generationId: "oversized-replay-generation",
      snapshot: oversizedSnapshot("oversized-root"),
      status: "completed",
    });
    expect(first).not.toBeNull();
    expect(first!.snapshot.nodes.length).toBeLessThan(128);
    const storedFirst = getDb().query(
      "SELECT snapshot_json, created_at FROM agent_activity_runs WHERE user_id = ? AND chat_id = ? AND generation_id = ?",
    ).get(OWNER, chat.id, "oversized-replay-generation") as { snapshot_json: string; created_at: number };

    const replay = persistTerminalAgentActivityRun({
      userId: OWNER,
      chatId: chat.id,
      generationId: "oversized-replay-generation",
      snapshot: oversizedSnapshot("oversized-root"),
      status: "completed",
    });
    expect(replay).toEqual(first);
    expect(getDb().query(
      "SELECT snapshot_json, created_at FROM agent_activity_runs WHERE user_id = ? AND chat_id = ? AND generation_id = ?",
    ).get(OWNER, chat.id, "oversized-replay-generation")).toEqual(storedFirst);

    expect(persistTerminalAgentActivityRun({
      userId: OWNER,
      chatId: chat.id,
      generationId: "oversized-replay-generation",
      snapshot: oversizedSnapshot("conflicting-root"),
      status: "completed",
    })).toBeNull();
    expect(getDb().query(
      "SELECT snapshot_json, created_at FROM agent_activity_runs WHERE user_id = ? AND chat_id = ? AND generation_id = ?",
    ).get(OWNER, chat.id, "oversized-replay-generation")).toEqual(storedFirst);
  });

  test("drops prose, arguments, results, carriers, and unknown fields before storing", () => {
    const chat = createChat(OWNER, { name: "activity" });
    const input = snapshot("failed", {
      task: "private prompt",
      result: { secret: "tool result" },
      carrier: "encrypted provider carrier",
      nodes: Array.from({ length: 128 }, (_, index) => ({
        id: `node-${index}-${"x".repeat(240)}`,
        parentId: null,
        kind: "tool_attempt",
        actor: "tool",
        phase: "failed",
        status: "failed",
        startedAt: index,
        elapsedMs: 1,
        toolId: "unknown-provider-tool",
        arguments: "secret args",
        result: "secret result",
        prose: "secret prose",
      })),
    }) as unknown as AgentActivitySnapshotV1;
    const persisted = persistTerminalAgentActivityRun({
      userId: OWNER,
      chatId: chat.id,
      generationId: "hostile-generation",
      snapshot: input,
      status: "failed",
    });
    expect(persisted).not.toBeNull();
    const encoded = JSON.stringify(persisted);
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(AGENT_ACTIVITY_RUN_MAX_BYTES);
    expect(encoded).not.toContain("private prompt");
    expect(encoded).not.toContain("secret args");
    expect(encoded).not.toContain("secret result");
    expect(encoded).not.toContain("encrypted provider carrier");
    expect(persisted!.snapshot.nodes.every((node) => node.toolId === "unknown_tool")).toBe(true);
    expect(persisted!.snapshot.omittedNodeCount).toBeGreaterThan(0);
    const stored = getDb().query("SELECT snapshot_json FROM agent_activity_runs WHERE generation_id = ?").get("hostile-generation") as { snapshot_json: string };
    expect(stored.snapshot_json).not.toContain("arguments");
    expect(stored.snapshot_json).not.toContain("result");
  });

  test("evicts oldest rows transactionally at the count and byte bounds", () => {
    const chat = createChat(OWNER, { name: "activity" });
    for (let i = 0; i < AGENT_ACTIVITY_RUN_MAX_COUNT + 2; i++) {
      persistTerminalAgentActivityRun({
        userId: OWNER,
        chatId: chat.id,
        generationId: `generation-${i}`,
        snapshot: snapshot("completed"),
      });
    }
    const rows = listAgentActivityRuns(OWNER, chat.id);
    expect(rows).toHaveLength(AGENT_ACTIVITY_RUN_MAX_COUNT);
    expect(rows.map((row) => row.generationId)).not.toContain("generation-0");
    expect(rows.map((row) => row.generationId)).not.toContain("generation-1");
    const totals = getDb().query("SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes FROM agent_activity_runs WHERE user_id = ? AND chat_id = ?").get(OWNER, chat.id) as { count: number; bytes: number };
    expect(totals.count).toBeLessThanOrEqual(AGENT_ACTIVITY_RUN_MAX_COUNT);
    expect(totals.bytes).toBeLessThanOrEqual(AGENT_ACTIVITY_CHAT_MAX_BYTES);
  });

  test("rejects an oversized identity and reports ownership without leaking rows", () => {
    const ownedChat = createChat(OWNER, { name: "owned" });
    const otherChat = createChat(OTHER, { name: "other" });
    expect(persistTerminalAgentActivityRun({
      userId: OWNER,
      chatId: ownedChat.id,
      generationId: "bad-target",
      targetMessageId: "x".repeat(300),
      snapshot: snapshot(),
    })).toBeNull();
    expect(ownsChatForActivity(OWNER, ownedChat.id)).toBe(true);
    expect(ownsChatForActivity(OTHER, ownedChat.id)).toBe(false);
    expect(listAgentActivityRuns(OTHER, ownedChat.id)).toEqual([]);
    expect(ownsChatForActivity(OTHER, otherChat.id)).toBe(true);
  });

  test("serves only the authenticated owner's bounded runs", async () => {
    const ownerChat = createChat(OWNER, { name: "owned" });
    const otherChat = createChat(OTHER, { name: "other" });
    persistTerminalAgentActivityRun({ userId: OWNER, chatId: ownerChat.id, generationId: "owner-run", snapshot: snapshot() });
    persistTerminalAgentActivityRun({ userId: OTHER, chatId: otherChat.id, generationId: "other-run", snapshot: snapshot() });

    const ownerResponse = await app.request(`http://localhost/${ownerChat.id}/agent-activity-runs`, { headers: { "x-test-user": OWNER } });
    expect(ownerResponse.status).toBe(200);
    expect((await ownerResponse.json()).runs.map((run: { generationId: string }) => run.generationId)).toEqual(["owner-run"]);

    const forbiddenResponse = await app.request(`http://localhost/${ownerChat.id}/agent-activity-runs`, { headers: { "x-test-user": OTHER } });
    expect(forbiddenResponse.status).toBe(404);
    const missingResponse = await app.request("http://localhost/missing-chat/agent-activity-runs", { headers: { "x-test-user": OWNER } });
    expect(missingResponse.status).toBe(404);
  });
});

describe("agent activity migration compatibility", () => {
  test("fresh bootstrap includes the fallback table and records its migration", async () => {
    const db = new Database(":memory:");
    try {
      await runMigrations(db);
      const columns = db.query("PRAGMA table_info(agent_activity_runs)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "user_id", "chat_id", "generation_id", "target_message_id", "target_swipe_id", "snapshot_json", "byte_size",
      ]));
      expect(db.query("SELECT name FROM _migrations WHERE name = ?").get("113_agent_activity_runs.sql")).toEqual({
        name: "113_agent_activity_runs.sql",
      });
      const chatForeignKey = (
        db.query("PRAGMA foreign_key_list(agent_activity_runs)").all() as Array<{
          from: string;
          table: string;
          on_delete: string;
        }>
      ).find((foreignKey) => foreignKey.from === "chat_id");
      expect(chatForeignKey?.table).toBe("chats");
      expect(chatForeignKey?.on_delete).toBe("CASCADE");

      db.run("PRAGMA foreign_keys = ON");
      db.query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)').run(
        "fresh-owner",
        "Fresh Owner",
        "fresh-owner@example.test",
      );
      db.query(
        "INSERT INTO chats (id, name, metadata, user_id) VALUES (?, ?, ?, ?)",
      ).run("fresh-chat", "Fresh Chat", "{}", "fresh-owner");
      db.query(
        `INSERT INTO agent_activity_runs
          (user_id, chat_id, generation_id, snapshot_json, byte_size)
         VALUES (?, ?, ?, ?, ?)`,
      ).run("fresh-owner", "fresh-chat", "fresh-generation", "{}", 2);
      db.query("DELETE FROM chats WHERE id = ?").run("fresh-chat");
      expect(
        db.query("SELECT COUNT(*) AS count FROM agent_activity_runs").get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});

describe("agent run inspection terminal persistence", () => {
  test("canonicalizes omitted optional transcript fields at the writer boundary", () => {
    const chat = createChat(OWNER, { name: "inspection-writer" });
    const writer = createAgentInspectionWriter({
      userId: OWNER,
      chatId: chat.id,
      attemptId: "writer-attempt",
      runId: "writer-run",
      turnSessionId: "writer-turn",
      generationId: "writer-generation",
      generationType: "normal",
      hostCorrelationId: "writer-host",
      lifecycle: "WORK",
      status: "running",
    });

    const detail = writer.record("provider_exchange", {
      kind: "provider_exchange",
      actor: "provider",
      recipient: "agent",
      content: "provider output",
      arguments: "{}",
      result: "{\"finishReason\":\"tool_calls\"}",
      provider: {
        adapter: "agentic-work",
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        connectionId: "connection-frozen",
        configRevision: 17,
        connectionRevision: "candidate-4",
        fingerprint: "source-fingerprint",
      },
      correlation: { parentId: "root" },
    });

    expect(detail?.transcript).toHaveLength(1);
    expect(detail?.transcript[0]).toMatchObject({
      kind: "provider_exchange",
      durationMs: null,
      late: false,
      errorReason: null,
      provider: {
        adapter: "agentic-work",
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        connectionId: "connection-frozen",
        configRevision: 17,
        connectionRevision: "candidate-4",
        fingerprint: "source-fingerprint",
      },
    });
    expect(detail?.markers.some((marker) => marker.scope === "transcript")).toBe(false);
  });

  test("persists admission and terminal inspection before WORK segment authority exists", async () => {
    const db = getDb();
    db.run(await Bun.file(join(import.meta.dir, "..", "db", "migrations", "135_agent_work_segments.sql")).text());
    const chat = createChat(OWNER, { name: "inspection-pre-segment-authority" });
    const executionId = "inspection-pre-segment-turn";
    const attemptId = "inspection-pre-segment-attempt";
    createTurnExecution({
      id: executionId,
      userId: OWNER,
      chatId: chat.id,
      generationId: executionId,
      targetKind: "normal",
      targetChatRevision: 0,
      attemptLineage: { attemptId },
      mode: "agentic",
      deadlineAt: Date.now() + 60_000,
      workspaceId: `workspace:${executionId}`,
    }, db);

    const writer = createAgentInspectionWriter({
      userId: OWNER,
      chatId: chat.id,
      attemptId,
      runId: executionId,
      turnSessionId: executionId,
      generationId: executionId,
      generationType: "normal",
      hostCorrelationId: `agentic:${executionId}:${attemptId}`,
      lifecycle: "ADMIT",
      status: "pending",
    });
    const admission = writer.record("target", {
      id: "admit:target",
      kind: "target",
      actor: "host",
      recipient: "agent",
      arguments: JSON.stringify({
        generationType: "normal",
        messageId: null,
        swipeId: null,
        messageRevision: null,
        chatGenerationRevision: 0,
      }),
    }, { lifecycle: "ADMIT", status: "pending" });

    expect(admission).not.toBeNull();
    expect(admission?.workSegments).toBeNull();
    expect(db.query(
      "SELECT COUNT(*) AS count FROM agent_run_attempts WHERE user_id = ? AND turn_id = ? AND attempt_id = ?",
    ).get(OWNER, executionId, attemptId)).toEqual({ count: 1 });

    const terminal = writer.record("terminal", {
      id: "terminal:pre-work",
      kind: "terminal",
      actor: "host",
      recipient: "owner",
    }, {
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "failed",
      reason: "invalid_input",
    });

    expect(terminal).not.toBeNull();
    expect(terminal?.workSegments).toBeNull();
    expect(getAgentRunInspection(OWNER, attemptId, chat.id)?.outcome).toBe("failed");
  });

  test("projects populated WORK segments through the production inspection surface without private authority", async () => {
    const db = getDb();
    db.run(await Bun.file(join(import.meta.dir, "..", "db", "migrations", "135_agent_work_segments.sql")).text());
    const chat = createChat(OWNER, { name: "inspection-work-segment-redaction" });
    const executionId = "inspection-work-segment-turn";
    const attemptId = "inspection-work-segment-attempt";
    const workspaceId = "inspection-work-segment-workspace";
    const created = createTurnExecution({
      id: executionId,
      userId: OWNER,
      chatId: chat.id,
      generationId: executionId,
      targetKind: "normal",
      targetChatRevision: 0,
      attemptLineage: { attemptId },
      mode: "agentic",
      runtimeEpoch: 7,
      deadlineAt: Date.now() + 60_000,
      workspaceId,
    }, db);
    db.query(`INSERT INTO agent_turn_workspaces
      (workspace_id, turn_id, execution_id, user_id, chat_id, objective,
       constraints_json, state, revision, operation_caps_json, field_caps_json,
       retention, expires_at, quota_tasks, quota_records, quota_submissions,
       quota_artifacts, quota_bytes)
      VALUES (?, ?, ?, ?, ?, 'inspection objective', '[]', 'active', 0, '{}', '{}',
              'turn_terminal', ?, 10, 10, 10, 10, 1000000)`).run(
      workspaceId, executionId, executionId, OWNER, chat.id, Date.now() + 60_000,
    );
    const durable = transitionTurnExecution({
      db, executionId, ownerToken: created.ownerToken, expectedPhase: "ASSEMBLE", nextPhase: "WORK",
    }).execution;
    createAgentInspectionWriter({
      userId: OWNER,
      chatId: chat.id,
      attemptId,
      runId: executionId,
      turnSessionId: executionId,
      generationId: executionId,
      generationType: "normal",
      hostCorrelationId: "agentic:" + executionId + ":" + attemptId,
      lifecycle: "WORK",
      status: "running",
    }).record("condition", { id: "work:admission", kind: "condition", actor: "host", recipient: "agent" });

    const digest = (value: unknown): string => createHash("sha256")
      .update(encodeCanonicalPlainData(value), "utf8").digest("hex");
    const digestA = "a".repeat(64);
    const digestB = "b".repeat(64);
    const instructionRef = Object.freeze({
      kind: "loom_block" as const,
      blockId: "safe-phase-instruction",
      presetRevision: 1,
      blockRevision: 1,
      promptOrder: 0,
    });
    const customPhase = Object.freeze({
      version: 1 as const,
      id: "safe-phase",
      label: "Safe phase",
      instructionRefs: Object.freeze([instructionRef]),
      childInstructionSubsets: Object.freeze([]),
      required: true,
      enter: Object.freeze({ kind: "phase" as const, value: "WORK" as const }),
      exit: Object.freeze({ kind: "phase" as const, value: "WORK" as const }),
      capabilityRequests: Object.freeze(["workspace_read"]),
      repeatLimit: 0,
      nextPhaseIds: Object.freeze([]),
      index: 0,
      sourceStatus: "verified" as const,
      sourceIdentity: Object.freeze([Object.freeze({
        blockId: instructionRef.blockId,
        presetRevision: 1,
        blockRevision: 1,
        promptOrder: 0,
      })]),
      childInstructionSubsetIdentity: Object.freeze([]),
    });
    const transitionAuthorityDigest = digest({
      version: 1,
      id: customPhase.id,
      index: 0,
      enter: customPhase.enter,
      exit: customPhase.exit,
      capabilityRequests: customPhase.capabilityRequests,
      repeatLimit: customPhase.repeatLimit,
      nextPhaseIds: customPhase.nextPhaseIds,
      sourceStatus: customPhase.sourceStatus,
      sourceIdentity: customPhase.sourceIdentity,
    });
    const admittedCapabilityDigest = digest({ version: 1, admittedCapabilities: ["workspace_read"] });
    const phasePlan = Object.freeze({
      version: 1 as const,
      phases: Object.freeze([Object.freeze({
        id: "safe-phase",
        index: 0,
        required: true,
        nextPhaseIds: Object.freeze([]),
        repeatLimit: 0,
        transitionAuthorityDigest,
        skipEligibilityDigest: null,
      })]),
    });
    const phasePlanDigest = computeWorkPhasePlanDigestV1(phasePlan);
    const connection = Object.freeze({
      logicalId: "root",
      concreteId: "connection",
      label: "Connection",
      provider: "test",
      model: "model",
      effectiveEndpoint: "https://example.invalid",
      endpointRevision: "endpoint-1",
      credentialSecretRef: "inspection-secret-reference",
      credentialRevision: "credential-1",
      candidateRevision: "candidate-1",
      capabilities: Object.freeze({ toolCalls: true }),
      capabilityDigest: digestA,
      fingerprint: digestB,
    });
    const plan = Object.freeze({
      version: 1,
      customPhasePlan: Object.freeze({
        status: "ready" as const,
        phases: Object.freeze([customPhase]),
        issues: Object.freeze([]),
        omittedPhaseIds: Object.freeze([]),
      }),
      loomBlocks: Object.freeze([Object.freeze({
        source: instructionRef,
        content: "inspection-private-plan-instruction",
      })]),
      completionCriteriaMessages: Object.freeze([Object.freeze({ content: "safe completion" })]),
    });
    const envelopeAuthority = Object.freeze({
      version: 1 as const,
      snapshotDigest: digestA,
      planDigest: digest(plan),
      toolCatalogSchemaVersion: 1,
      toolCatalogDigest: digestB,
      configRevision: "config-1",
      authoredRootToolIds: Object.freeze([]),
      authoredChildToolIds: Object.freeze({}),
      snapshot: Object.freeze({ snapshotId: "snapshot" }),
      plan,
      rootConnection: connection,
      childConnections: Object.freeze({}),
      generationParameters: null,
      resumeInput: Object.freeze({ userId: OWNER, chatId: chat.id, generationType: "normal" }),
      decisionAuthority: Object.freeze({
        binding: Object.freeze({ userId: OWNER, chatId: chat.id, targetDigest: digestA }),
        readinessVector: Object.freeze({}),
      }),
      liveTargetBinding: Object.freeze({ targetDigest: digestA, inputRevisionDigest: digestB }),
      runtime: Object.freeze({
        deadlineAt: Date.now() + 60_000,
        rootFrameId: executionId,
        workspaceId,
        workspaceRevision: 0,
        ownerLimits: Object.freeze({ providerDispatches: 1 }),
        workspaceRetention: "turn_terminal" as const,
        workspaceSharing: "root_only" as const,
      }),
    });
    const resumeEnvelope = Object.freeze({
      ...envelopeAuthority,
      envelopeDigest: computeWorkSegmentResumeEnvelopeDigestV1(envelopeAuthority),
    });
    const attemptBudget = Object.freeze({
      maxSegments: 2,
      maxProviderDispatches: 2,
      maxProviderOutputTokens: 32,
      maxOutputTokensPerDispatch: 16,
      maxUnsignedBoundaries: 2,
      maxToolCalls: 2,
      maxWorkspaceOperations: 2,
      recoveryReserveOutputTokens: 0,
      futurePhaseReserveOutputTokens: 0,
    });
    const segmentBudget = Object.freeze({
      maxProviderDispatches: 1,
      maxProviderOutputTokens: 16,
      maxOutputTokensPerDispatch: 16,
      maxUnsignedBoundaries: 1,
      maxToolCalls: 1,
      maxWorkspaceOperations: 1,
    });
    const contextAuthority: Omit<WorkSegmentContextV1, "contextDigest"> = Object.freeze({
      version: 1,
      bindingDigest: digestB,
      resumeEnvelopeDigest: resumeEnvelope.envelopeDigest,
      phasePlanDigest,
      protocolDigest: digestA,
      capabilityDigest: admittedCapabilityDigest,
      phaseCapabilityDigest: admittedCapabilityDigest,
      rootObjective: "inspection-private-root-objective",
      rootSnapshotId: "snapshot",
      rootSnapshotDigest: digestA,
      phase: Object.freeze({
        id: "safe-phase",
        index: 0,
        occurrence: 0,
        instructions: Object.freeze(["inspection-private-plan-instruction"]),
        completionCriteria: Object.freeze(["safe completion"]),
        admittedCapabilities: Object.freeze(["workspace_read"]),
      }),
      workspace: Object.freeze({
        id: workspaceId,
        revision: 0,
        acceptedRecords: Object.freeze([]),
        openRequiredIds: Object.freeze([]),
      }),
      previousHandoff: null,
      attemptBudget,
      segmentBudget,
      protocol: Object.freeze({ completeTurnCallMode: "standalone_only", requiredToolModeAvailable: true }),
    });
    const context = Object.freeze({
      ...contextAuthority,
      contextDigest: computeWorkSegmentContextDigestV1(contextAuthority),
    });
    const now = Date.now();
    const authority = {
      userId: OWNER,
      executionId,
      ownerToken: created.ownerToken,
      expectedExecutionCasRevision: durable.casRevision,
      expectedWorkspaceRevision: 0,
      now,
    } as const;
    const admitted = createAndAdmitInitialWorkSegmentV1({
      db,
      attempt: {
        ...authority,
        attemptId,
        workspaceId,
        phaseId: "safe-phase",
        phaseIndex: 0,
        phaseOccurrence: 0,
        remainingRequiredPhaseCount: 0,
        snapshotDigest: digestA,
        phasePlanDigest,
        phasePlan,
        bindingDigest: digestB,
        idempotencyKey: "inspection-work-attempt",
        resumeEnvelope,
        budget: attemptBudget,
      },
      admission: {
        ...authority,
        attemptId,
        workspaceId,
        sourceTransitionId: null,
        phaseId: "safe-phase",
        phaseIndex: 0,
        phaseOccurrence: 0,
        segmentOrdinal: 0,
        admissionKey: "inspection-work-segment",
        contextDigest: context.contextDigest,
        context,
        budget: segmentBudget,
      },
    }).admission.record;

    const workSegments = getAgentRunInspection(OWNER, attemptId, chat.id)?.workSegments;
    expect(workSegments?.segments).toHaveLength(1);
    expect(workSegments?.segments[0]?.identity).toMatchObject({
      segmentId: admitted.identity.segmentId,
      phaseId: "safe-phase",
      segmentOrdinal: 0,
    });
    const serialized = JSON.stringify(workSegments);
    expect(serialized).not.toContain("inspection-secret-reference");
    expect(serialized).not.toContain("inspection-private-plan-instruction");
    expect(serialized).not.toContain("inspection-private-root-objective");
    expect(serialized).toContain(admitted.identity.segmentId);
  });

  test("redacts secret keys across casing and separator variants", () => {
    const chat = createChat(OWNER, { name: "inspection-secret-key-boundary" });
    const secretValues = [
      "api-key-sentinel",
      "api_key-sentinel",
      "api key sentinel",
      "access-token-sentinel",
      "client-secret-sentinel",
      "auth-secret-sentinel",
      "encryption-key-sentinel",
    ];
    const detail = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "secret-key-boundary-attempt",
      runId: "secret-key-boundary-run",
      turnSessionId: "secret-key-boundary-turn",
      transcript: [{
        id: "secret-key-boundary-record",
        kind: "tool",
        actor: "tool",
        API_KEY: secretValues[0],
        api_key: secretValues[1],
        "api-key": secretValues[2],
        "Access Token": secretValues[3],
        CLIENT_SECRET: secretValues[4],
        Auth_Secret: secretValues[5],
        encryption_key: secretValues[6],
      }],
    }));

    expect(detail).not.toBeNull();
    const encoded = JSON.stringify(detail);
    for (const secretValue of secretValues) expect(encoded).not.toContain(secretValue);
  });


  test("exposes a committed normal response separately from its input target", () => {
    const chat = createChat(OWNER, { name: "inspection-committed-target" });
    const writer = createAgentInspectionWriter({
      userId: OWNER,
      chatId: chat.id,
      attemptId: "committed-target-attempt",
      runId: "committed-target-run",
      turnSessionId: "committed-target-turn",
      generationId: "committed-target-generation",
      generationType: "normal",
      hostCorrelationId: "committed-target-host",
      lifecycle: "COMMIT",
      status: "waiting",
    });

    const detail = writer.record("terminal", {
      kind: "terminal",
      actor: "host",
      recipient: "owner",
    }, {
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "completed",
      reason: "none",
      terminalReceipt: {
        messageId: "committed-response-message",
        swipeId: 0,
      },
    });

    expect(detail?.target).toBeNull();
    expect(detail?.committedTarget).toEqual({
      messageId: "committed-response-message",
      swipeId: 0,
    });
  });

  test("stamps host correlation onto canonical usage evidence", () => {
    const chat = createChat(OWNER, { name: "inspection-usage-writer" });
    const writer = createAgentInspectionWriter({
      userId: OWNER,
      chatId: chat.id,
      attemptId: "usage-writer-attempt",
      runId: "usage-writer-run",
      turnSessionId: "usage-writer-turn",
      generationId: "usage-writer-generation",
      generationType: "normal",
      hostCorrelationId: "usage-writer-host",
      lifecycle: "WORK",
      status: "running",
    });

    const detail = writer.record("usage", {
      version: 1,
      id: "usage-writer-provider",
      source: "final",
      layer: "provider",
      correlation: { parentId: "root" },
      inputTokens: 7,
      outputTokens: 5,
      totalTokens: 12,
      toolCalls: 0,
      childInvocations: 0,
      canonical: true,
    });

    expect(detail?.usageEvidence).toHaveLength(1);
    expect(detail?.usageEvidence[0]).toMatchObject({
      id: "usage-writer-provider",
      inputTokens: 7,
      outputTokens: 5,
      totalTokens: 12,
      correlation: {
        turnSessionId: "usage-writer-turn",
        runId: "usage-writer-run",
        attemptId: "usage-writer-attempt",
        chatId: chat.id,
        generationId: "usage-writer-generation",
        hostCorrelationId: "usage-writer-host",
        parentId: "root",
        phase: "WORK",
      },
    });
    expect(detail?.markers.some((marker) => marker.scope === "usage")).toBe(false);
  });

  test("uses the authoritative Agent Run projection when no duplicate activity audit exists", () => {
    const chat = createChat(OWNER, { name: "inspection-projected-activity" });
    persistAgentRunInspection(inspectionInput(chat.id, {
      lifecycle: "WORK",
      status: "running",
      outcome: null,
      startedAt: 100,
      updatedAt: 120,
    }));
    const snapshot = JSON.stringify({
      version: 2,
      runId: "inspection-run",
      turnId: "inspection-turn",
      generationId: "inspection-generation",
      chatId: chat.id,
      inspectionAttemptId: "inspection-attempt",
      activity: [{
        version: 2,
        id: "provider-round-1",
        parentId: null,
        kind: "provider",
        actor: "provider",
        phase: "WORK",
        status: "completed",
        startedAt: 101,
        elapsedMs: 9,
        roundIndex: 0,
      }],
    });
    getDb().query(
      `INSERT INTO agent_run_projections
        (user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,
         target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
         snapshot_json, terminal_handoff_json, omission_json)
       VALUES (?, ?, ?, ?, 'normal', NULL, NULL, 'WORK', 'WORK', 1, 1, 100, 120, ?, NULL, ?)`,
    ).run(
      OWNER,
      chat.id,
      "inspection-turn",
      "inspection-generation",
      snapshot,
      JSON.stringify({
        omittedNodeCount: 0,
        omittedEventCount: 0,
        firstOmittedSequence: null,
        lastOmittedSequence: null,
      }),
    );

    const detail = getAgentRunInspection(OWNER, "inspection-attempt", chat.id);
    expect(detail?.activity.milestones).toEqual([
      expect.objectContaining({
        id: "projection:provider-round-1",
        kind: "provider",
        actor: "provider",
        phase: "WORK",
        status: "terminal",
        startedAt: 101,
        endedAt: 110,
        elapsedMs: 9,
      }),
    ]);
    expect(detail?.sectionAvailability.find((section) => section.section === "activity")?.state).toBe("available");
  });

  test("keeps terminal lifecycle and outcome while retaining late evidence", () => {
    const chat = createChat(OWNER, { name: "inspection" });
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      updatedAt: 100,
      terminalAt: 100,
    }))).not.toBeNull();

    const late = persistAgentRunInspection(inspectionInput(chat.id, {
      updatedAt: 200,
      transcript: [{
        id: "late-record",
        kind: "tool",
        actor: "tool",
        recipient: "agent",
        occurredAt: 90,
        hostSequence: 4,
        late: true,
        content: "late evidence",
        arguments: null,
        result: null,
        durationMs: null,
        provider: null,
        errorReason: null,
      }],
    }));

    expect(late?.lifecycle).toBe("TERMINAL");
    expect(late?.status).toBe("terminal");
    expect(late?.outcome).toBe("completed");
    expect(late?.transcript).toHaveLength(1);
    expect(late?.transcript[0]?.late).toBe(true);
    expect(late?.transcript[0]?.correlation.hostSequence).toBe(4);
    expect(late?.markers.map((marker) => marker.kind)).toContain("late_event");
  });

  test("compares oversized audit replays against their bounded persisted payload", () => {
    const chat = createChat(OWNER, { name: "inspection-oversized-replay" });
    const oversizedContent = "A".repeat(AGENT_RUN_INSPECTION_MAX_PAYLOAD_BYTES + 2048);
    const record = (content: string) => ({
      id: "oversized-audit-record",
      kind: "tool",
      actor: "tool",
      recipient: "agent",
      occurredAt: 10,
      hostSequence: 1,
      late: false,
      content,
      arguments: null,
      result: null,
      durationMs: null,
      provider: null,
      errorReason: null,
    });
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      updatedAt: 100,
      transcript: [record(oversizedContent)],
    }))).not.toBeNull();
    const storedFirst = getDb().query(
      `SELECT payload_json, byte_size
         FROM agent_run_audit_records
        WHERE user_id = ? AND attempt_id = ? AND record_kind = 'transcript'`,
    ).get(OWNER, "inspection-attempt") as { payload_json: string; byte_size: number };
    const storedPayload: unknown = JSON.parse(storedFirst.payload_json);
    const storedContentLength = storedPayload
      && typeof storedPayload === "object"
      && "content" in storedPayload
      && typeof storedPayload.content === "string"
      ? storedPayload.content.length
      : 0;
    expect(storedContentLength).toBeLessThan(oversizedContent.length);

    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      updatedAt: 200,
      transcript: [{ ...record(oversizedContent), occurredAt: 20, hostSequence: 4 }],
    }))).not.toBeNull();
    expect(getDb().query(
      `SELECT payload_json, byte_size
         FROM agent_run_audit_records
        WHERE user_id = ? AND attempt_id = ? AND record_kind = 'transcript'`,
    ).get(OWNER, "inspection-attempt")).toEqual(storedFirst);

    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      updatedAt: 300,
      transcript: [record(`B${oversizedContent.slice(1)}`)],
    }))).toBeNull();
    expect(getDb().query(
      `SELECT payload_json, byte_size
         FROM agent_run_audit_records
        WHERE user_id = ? AND attempt_id = ? AND record_kind = 'transcript'`,
    ).get(OWNER, "inspection-attempt")).toEqual(storedFirst);
  });

  test("rejects conflicting semantic duplicate late records while tolerating generated ordering metadata", () => {
    const chat = createChat(OWNER, { name: "inspection" });
    persistAgentRunInspection(inspectionInput(chat.id, { updatedAt: 100, terminalAt: 100 }));
    const lateRecord = {
      id: "duplicate-late",
      kind: "tool",
      actor: "tool",
      recipient: "agent",
      occurredAt: 90,
      hostSequence: 2,
      late: true,
      content: "first payload",
      arguments: null,
      result: null,
      durationMs: null,
      provider: null,
      errorReason: null,
    };
    persistAgentRunInspection(inspectionInput(chat.id, { transcript: [lateRecord] }));
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      transcript: [{ ...lateRecord, occurredAt: 190, hostSequence: 4 }],
    }))).not.toBeNull();
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      transcript: [{ ...lateRecord, content: "duplicate payload" }],
    }))).toBeNull();

    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_run_audit_records WHERE user_id = ? AND attempt_id = ? AND record_kind = ?",
    ).get(OWNER, "inspection-attempt", "transcript")).toEqual({ count: 1 });
    const inspection = getAgentRunInspection(OWNER, "inspection-attempt", chat.id);
    expect(inspection?.transcript).toHaveLength(1);
    expect(inspection?.markers.filter((marker) => marker.kind === "late_event")).toHaveLength(1);
  });
  test("canonicalizes non-ASCII audit replays with UTF-8 key ordering", () => {
    const chat = createChat(OWNER, { name: "inspection-utf8-order" });
    const supplementaryKey = "😀";
    const bmpKey = "\uE000";
    const record = (supplementaryFirst: boolean) => ({
      id: "utf8-order-record",
      kind: "tool",
      actor: "tool",
      recipient: "agent",
      content: "stable payload",
      ...(supplementaryFirst
        ? { [supplementaryKey]: "supplementary", [bmpKey]: "bmp" }
        : { [bmpKey]: "bmp", [supplementaryKey]: "supplementary" }),
    });
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      transcript: [record(true)],
    }))).not.toBeNull();
    const stored = getDb().query(
      `SELECT payload_json
         FROM agent_run_audit_records
        WHERE user_id = ? AND attempt_id = ? AND record_kind = 'transcript'`,
    ).get(OWNER, "inspection-attempt") as { payload_json: string };
    const storedKeys = Object.keys(JSON.parse(stored.payload_json) as Record<string, unknown>);
    expect(storedKeys.indexOf(bmpKey)).toBeLessThan(storedKeys.indexOf(supplementaryKey));
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      transcript: [{ ...record(false), occurredAt: 17, hostSequence: 3 }],
    }))).not.toBeNull();
  });


  test("rejects an immutable identity mismatch without adding evidence", () => {
    const chat = createChat(OWNER, { name: "inspection" });
    persistAgentRunInspection(inspectionInput(chat.id, { updatedAt: 100, terminalAt: 100 }));

    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      runId: "different-run",
      transcript: [{ id: "rejected", kind: "tool", actor: "tool", late: true }],
    }))).toBeNull();
    expect(getAgentRunInspection(OWNER, "inspection-attempt", chat.id)?.transcript).toHaveLength(0);
  });

  test("refuses terminal lifecycle and outcome changes", () => {
    const chat = createChat(OWNER, { name: "inspection" });
    persistAgentRunInspection(inspectionInput(chat.id, { updatedAt: 100, terminalAt: 100 }));

    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      lifecycle: "WORK",
      status: "running",
      outcome: null,
      transcript: [{ id: "invalid-transition", kind: "tool", actor: "tool", late: true }],
    }))).toBeNull();
    const inspection = getAgentRunInspection(OWNER, "inspection-attempt", chat.id);
    expect(inspection?.lifecycle).toBe("TERMINAL");
    expect(inspection?.status).toBe("terminal");
    expect(inspection?.outcome).toBe("completed");
    expect(inspection?.transcript).toHaveLength(0);
  });

  test("advances lifecycle by public phase before status and retains render chronology", () => {
    const chat = createChat(OWNER, { name: "inspection-phase-primary" });
    const writer = createAgentInspectionWriter({
      userId: OWNER,
      chatId: chat.id,
      attemptId: "phase-primary-attempt",
      runId: "phase-primary-run",
      turnSessionId: "phase-primary-turn",
      generationId: "phase-primary-generation",
      generationType: "normal",
      hostCorrelationId: "phase-primary-host",
      lifecycle: "PREPARE_COMMIT",
      status: "waiting",
      startedAt: 100,
    });

    expect(writer.record("milestone", {
      id: "phase:completion-handoff",
      kind: "milestone",
      actor: "host",
      recipient: "owner",
      occurredAt: 100,
      result: JSON.stringify({ workPhase: "PREPARE_COMMIT", workStatus: "waiting" }),
    }, {
      lifecycle: "PREPARE_COMMIT",
      status: "waiting",
      updatedAt: 100,
    })).not.toBeNull();

    const rendered = writer.record("milestone", {
      id: "phase:render",
      kind: "milestone",
      actor: "host",
      recipient: "owner",
      occurredAt: 200,
      result: JSON.stringify({ workPhase: "RENDER", workStatus: "running" }),
    }, {
      lifecycle: "RENDER",
      status: "running",
      updatedAt: 200,
    });
    expect(rendered?.lifecycle).toBe("RENDER");
    expect(rendered?.status).toBe("running");
    expect(rendered?.transcript.map(({ id }) => id)).toEqual([
      "phase:completion-handoff",
      "phase:render",
    ]);
    expect(rendered?.transcript[1]).toMatchObject({
      id: "phase:render",
      result: JSON.stringify({ workPhase: "RENDER", workStatus: "running" }),
      correlation: { phase: "RENDER", hostSequence: 2 },
    });

    expect(writer.record("milestone", {
      id: "phase:true-regression",
      kind: "milestone",
      actor: "host",
      recipient: "owner",
      occurredAt: 300,
      result: JSON.stringify({ workPhase: "PREPARE_COMMIT", workStatus: "waiting" }),
    }, {
      lifecycle: "PREPARE_COMMIT",
      status: "waiting",
      updatedAt: 300,
    })).toBeNull();

    const retained = getAgentRunInspection(OWNER, "phase-primary-attempt", chat.id);
    expect(retained?.lifecycle).toBe("RENDER");
    expect(retained?.status).toBe("running");
    expect(retained?.updatedAt).toBe(200);
    expect(retained?.transcript.map(({ id }) => id)).toEqual([
      "phase:completion-handoff",
      "phase:render",
    ]);
  });

  test("rejects stale phase, status, and timestamp replays", () => {
    const chat = createChat(OWNER, { name: "inspection-monotonic" });
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      lifecycle: "WORK",
      status: "running",
      outcome: null,
      updatedAt: 200,
    }))).not.toBeNull();

    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      lifecycle: "ADMIT",
      status: "pending",
      outcome: null,
      updatedAt: 100,
      transcript: [{ id: "stale-phase", kind: "tool", actor: "tool" }],
    }))).toBeNull();
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      lifecycle: "WORK",
      status: "pending",
      outcome: null,
      updatedAt: 199,
      transcript: [{ id: "stale-status", kind: "tool", actor: "tool" }],
    }))).toBeNull();
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      lifecycle: "WORK",
      status: "waiting",
      outcome: null,
      updatedAt: 210,
    }))).not.toBeNull();
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      lifecycle: "WORK",
      status: "waiting",
      outcome: null,
      updatedAt: 209,
      transcript: [{ id: "stale-time", kind: "tool", actor: "tool" }],
    }))).toBeNull();

    const inspection = getAgentRunInspection(OWNER, "inspection-attempt", chat.id);
    expect(inspection?.lifecycle).toBe("WORK");
    expect(inspection?.status).toBe("waiting");
    expect(inspection?.updatedAt).toBe(210);
    expect(inspection?.transcript).toHaveLength(0);
  });
  test("projects complete owner detail with causal lineage while keeping private evidence out of compact activity", () => {
    const chat = createChat(OWNER, { name: "inspection-rich" });
    const target = createMessage(
      chat.id,
      { is_user: false, name: "Assistant", content: "stable target" },
      OWNER,
    );
    const persistent = ensurePersistentWorkspaceForChat({
      userId: OWNER,
      chatId: chat.id,
      workspaceId: "workspace-1",
      objective: "Rich inspection workspace",
    });
    const correlation = {
      turnSessionId: "rich-turn",
      runId: "rich-run",
      attemptId: "rich-attempt",
      chatId: chat.id,
      generationId: "rich-generation",
      messageId: target.id,
      swipeId: 0,
      actorId: "agent",
      recipientId: "tool",
      phase: "WORK",
      taskId: "task-rich",
      toolId: "chat_search_history",
      parentId: null,
      hostCorrelationId: "inspection-host:rich-attempt",
      hostSequence: 1,
    };
    const detail = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "rich-attempt",
      runId: "rich-run",
      turnSessionId: "rich-turn",
      generationId: "rich-generation",
      generationType: "swipe",
      targetMessageId: target.id,
      targetSwipeId: 0,
      lifecycle: "WORK",
      status: "running",
      outcome: null,
      startedAt: 10,
      updatedAt: 20,
      transcript: [
        {
          id: "tool-request",
          kind: "tool",
          actor: "agent",
          recipient: "tool",
          occurredAt: 11,
          hostSequence: 2,
          late: false,
          content: null,
          arguments: "PRIVATE-TRANSCRIPT-PAYLOAD",
          result: null,
          durationMs: null,
          errorReason: null,
          correlation: { ...correlation, parentId: "prompt-1", hostSequence: 2 },
        },
        {
          id: "tool-result",
          kind: "tool",
          actor: "tool",
          recipient: "agent",
          occurredAt: 12,
          hostSequence: 3,
          late: false,
          content: null,
          arguments: null,
          result: "PRIVATE-TOOL-RESULT",
          durationMs: null,
          errorReason: null,
          correlation: {
            ...correlation,
            actorId: "tool",
            recipientId: "agent",
            parentId: "tool-request",
            hostSequence: 3,
          },
        },
      ],
      turnSession: [{
        id: "turn-input",
        kind: "input",
        occurredAt: 10,
        hostSequence: 1,
        detail: "PRIVATE-TURN-SESSION",
        transcriptRecordIds: ["tool-request"],
        correlation: { ...correlation, actorId: "owner", recipientId: "host", hostSequence: 1 },
      }],
      activity: [{
        id: "activity-tool",
        kind: "tool",
        actor: "tool",
        phase: "WORK",
        status: "running",
        parentId: null,
        label: "Search history",
        toolId: "chat_search_history",
        taskId: "task-rich",
        sequence: 2,
        startedAt: 11,
        endedAt: null,
        elapsedMs: null,
        usage: null,
        privatePayload: "PRIVATE-ACTIVITY-PAYLOAD",
        correlation: { ...correlation, actorId: "tool", hostSequence: 2 },
      }],
      promptEvidence: [{
        version: 1,
        id: "prompt-1",
        sourceId: "loom-block",
        sourceRevision: 3,
        promptOrder: 0,
        destination: "root_work",
        role: "system",
        correlation: { ...correlation, hostSequence: 4 },
        included: true,
        content: "PRIVATE-PROMPT-PAYLOAD",
        contentDigest: "a".repeat(64),
        omissionReason: null,
      }],
      cortexReceipts: [{
        version: 1,
        id: "cortex-1",
        requestId: "cortex-request",
        attemptId: "rich-attempt",
        checkpoint: "WORK",
        snapshotId: "snapshot-1",
        sourceRevision: 7,
        revision: 9,
        scope: { chatId: chat.id, targetMessageId: target.id, targetSwipeId: 0 },
        required: true,
        startedAt: 13,
        completedAt: 14,
        state: "accepted",
        resultDigest: "cortex-digest",
        resultCount: 2,
        correlation: { ...correlation, actorId: "cortex", recipientId: "host", hostSequence: 5 },
        reason: null,
        omission: null,
        canonical: false,
      }],
      councilReceipts: [{
        version: 1,
        id: "council-1",
        requestId: "council-request",
        checkpoint: "WORK",
        required: false,
        startedAt: 15,
        completedAt: 16,
        state: "omitted",
        memberCount: 3,
        resultDigest: null,
        correlation: { ...correlation, actorId: "council", recipientId: "host", hostSequence: 6 },
        reason: "unavailable",
        canonical: false,
      }],
      workspaceAssociations: [{
        version: 1,
        id: "publication-1",
        workspaceId: persistent.id,
        workspaceRevision: persistent.revision,
        relation: "published",
        objectKind: "publication",
        objectId: "publication-1",
        sourceRevision: persistent.revision,
        sourceDeleted: true,
        provenanceDigest: "a".repeat(64),
        correlation: { ...correlation, actorId: "host", recipientId: "owner", hostSequence: 7 },
      }],
    }));

    expect(detail).not.toBeNull();
    expect(detail).toMatchObject({
      runId: "rich-run",
      turnSessionId: "rich-turn",
      generationId: "rich-generation",
      attempt: {
        attemptId: "rich-attempt",
        target: {
          chatId: chat.id,
          generationType: "swipe",
          messageId: target.id,
          swipeId: 0,
        },
      },
      hostCorrelationId: "inspection-host:rich-attempt",
      lifecycle: "WORK",
      status: "running",
      outcome: null,
      target: { messageId: target.id, swipeId: 0 },
    });
    expect(detail!.transcript.map((entry) => entry.id)).toEqual(["tool-request", "tool-result"]);
    expect(detail!.transcript[1]!.correlation.parentId).toBe("tool-request");
    expect(detail!.transcript[1]!.correlation.hostSequence).toBe(3);
    expect(detail!.turnSession[0]!.detail).toBe("PRIVATE-TURN-SESSION");
    expect(detail!.promptEvidence[0]).toMatchObject({
      sourceId: "loom-block",
      destination: "root_work",
      content: "PRIVATE-PROMPT-PAYLOAD",
    });
    expect(detail!.cortexReceipts[0]!.resultDigest).toBe("cortex-digest");
    expect(detail!.cortexReceipts[0]).toEqual(expect.objectContaining({
      sourceRevision: 7,
      revision: 9,
    }));
    expect(detail!.councilReceipts[0]!.memberCount).toBe(3);
    expect(detail!.workspaceAssociations[0]!.sourceDeleted).toBe(true);
    expect(detail!.activity.milestones).toHaveLength(1);
    expect(detail!.activity.milestones[0]).not.toHaveProperty("privatePayload");
    expect(JSON.stringify(detail!.activity)).not.toContain("PRIVATE-");
  });

  test("retains exact prompt occurrences and suppresses missing or colliding order evidence", () => {
    const chat = createChat(OWNER, { name: "inspection-prompt-occurrences" });
    const evidence = (
      id: string,
      promptOrder: number,
      role: "system" | "user",
      content: string,
      hostSequence: number,
    ) => ({
      version: 1 as const,
      id,
      sourceId: "shared-source",
      sourceRevision: 7,
      promptOrder,
      destination: "root_work" as const,
      role,
      correlation: { hostSequence },
      included: true,
      content,
      contentDigest: (role === "system" ? "a" : "b").repeat(64),
      omissionReason: null,
      nativeProvenance: null,
      loomInspection: null,
    });
    const retained = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "prompt-occurrence-attempt",
      runId: "prompt-occurrence-run",
      turnSessionId: "prompt-occurrence-turn",
      generationId: "prompt-occurrence-generation",
      lifecycle: "WORK",
      status: "running",
      outcome: null,
      promptEvidence: [
        evidence("prompt-three", 3, "system", "SYSTEM OCCURRENCE", 1),
        evidence("prompt-seven", 7, "user", "USER OCCURRENCE", 2),
      ],
    }));
    expect(retained?.promptEvidence.map(({ promptOrder, role, content }) => ({ promptOrder, role, content }))).toEqual([
      { promptOrder: 3, role: "system", content: "SYSTEM OCCURRENCE" },
      { promptOrder: 7, role: "user", content: "USER OCCURRENCE" },
    ]);
    expect(getAgentRunInspection(OWNER, "prompt-occurrence-attempt", chat.id)?.promptEvidence).toEqual(
      retained?.promptEvidence,
    );

    const missing = evidence("prompt-missing", 2, "system", "MISSING ORDER PRIVATE", 1) as Record<string, unknown>;
    delete missing.promptOrder;
    const forged = evidence("prompt-forged", 7, "user", "FORGED ORDER PRIVATE", 2) as Record<string, unknown>;
    forged.promptOrder = "7";
    const missingProjection = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "prompt-missing-attempt",
      runId: "prompt-missing-run",
      turnSessionId: "prompt-missing-turn",
      generationId: "prompt-missing-generation",
      lifecycle: "WORK",
      status: "running",
      outcome: null,
      promptEvidence: [missing, forged],
    }));
    expect(missingProjection?.promptEvidence).toEqual([]);
    expect(missingProjection?.markers).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "prompt", kind: "unavailable" }),
    ]));
    expect(JSON.stringify(missingProjection)).not.toContain("MISSING ORDER PRIVATE");
    expect(JSON.stringify(missingProjection)).not.toContain("FORGED ORDER PRIVATE");

    const collisionProjection = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "prompt-collision-attempt",
      runId: "prompt-collision-run",
      turnSessionId: "prompt-collision-turn",
      generationId: "prompt-collision-generation",
      lifecycle: "WORK",
      status: "running",
      outcome: null,
      promptEvidence: [
        evidence("prompt-collision-system", 0, "system", "COLLISION SYSTEM PRIVATE", 1),
        evidence("prompt-collision-user", 0, "user", "COLLISION USER PRIVATE", 2),
      ],
    }));
    expect(collisionProjection?.promptEvidence).toEqual([]);
    expect(collisionProjection?.markers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: "prompt",
        kind: "unavailable",
        detail: "Prompt occurrence unavailable: conflicting retained evidence.",
      }),
    ]));
    expect(JSON.stringify(collisionProjection)).not.toContain("COLLISION SYSTEM PRIVATE");
    expect(JSON.stringify(collisionProjection)).not.toContain("COLLISION USER PRIVATE");

    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "prompt-truncation-attempt",
      runId: "prompt-truncation-run",
      turnSessionId: "prompt-truncation-turn",
      generationId: "prompt-truncation-generation",
      lifecycle: "WORK",
      status: "running",
      outcome: null,
      promptEvidence: [
        evidence("prompt-truncation-system", 3, "system", "RETAINED COLLISION PREFIX", 1),
        evidence("prompt-truncation-user", 3, "user", "OMITTED COLLISION COUNTERPART", 2),
      ],
    }))).not.toBeNull();
    const insertTranscript = getDb().query(
      `INSERT INTO agent_run_audit_records
        (record_id, user_id, chat_id, attempt_id, record_kind, event_id, causal_parent_id,
         host_sequence, occurred_at, late, payload_json, byte_size, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < AGENT_RUN_INSPECTION_MAX_RECORDS - 1; index += 1) {
      const hostSequence = index + 10;
      const id = `prompt-budget-transcript-${index}`;
      const payloadJson = JSON.stringify({
        version: 1,
        id,
        kind: "tool",
        actor: "agent",
        recipient: "tool",
        occurredAt: hostSequence,
        hostSequence,
        late: false,
        content: null,
        arguments: null,
        result: null,
        durationMs: null,
        provider: null,
        errorReason: null,
        correlation: {
          turnSessionId: "prompt-truncation-turn",
          runId: "prompt-truncation-run",
          attemptId: "prompt-truncation-attempt",
          chatId: chat.id,
          generationId: "prompt-truncation-generation",
          messageId: null,
          swipeId: null,
          actorId: "agent",
          recipientId: "tool",
          phase: "WORK",
          taskId: null,
          toolId: null,
          parentId: null,
          hostCorrelationId: "inspection-host:prompt-truncation-attempt",
          hostSequence,
        },
      });
      insertTranscript.run(
        id,
        OWNER,
        chat.id,
        "prompt-truncation-attempt",
        "transcript",
        id,
        null,
        hostSequence,
        hostSequence,
        0,
        payloadJson,
        Buffer.byteLength(payloadJson, "utf8"),
        id,
      );
    }
    const splitCollisionProjection = getAgentRunInspection(OWNER, "prompt-truncation-attempt", chat.id);
    expect(splitCollisionProjection?.promptEvidence).toEqual([
      expect.objectContaining({ promptOrder: 3, role: "system", content: "RETAINED COLLISION PREFIX" }),
    ]);
    expect(splitCollisionProjection?.markers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "truncated", scope: "prompt" }),
    ]));
    expect(splitCollisionProjection?.sectionAvailability).toEqual(expect.arrayContaining([
      expect.objectContaining({ section: "prompt", state: "unavailable" }),
    ]));
  });

  test("retains recovered and terminal lineage while late and reordered evidence cannot mutate terminal state", () => {
    const chat = createChat(OWNER, { name: "inspection-recovered" });
    const recovered = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "recovered-attempt",
      runId: "recovered-run",
      turnSessionId: "recovered-turn",
      generationId: "recovered-generation",
      lifecycle: "WORK",
      status: "running",
      outcome: null,
      reconciliation: "recovered",
      startedAt: 90,
      updatedAt: 100,
    }));
    expect(recovered).toMatchObject({
      lifecycle: "WORK",
      status: "running",
      outcome: null,
      activity: { reconciliation: "recovered" },
    });

    const terminal = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "recovered-attempt",
      runId: "recovered-run",
      turnSessionId: "recovered-turn",
      generationId: "recovered-generation",
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "stopped",
      reason: "reconciled",
      reconciliation: "recovered",
      updatedAt: 120,
      terminalAt: 120,
      markers: [{
        id: "recovery-marker",
        kind: "recovered_duplicate",
        scope: "run",
        firstSequence: 4,
        lastSequence: 4,
        recoverable: true,
        detail: "recovered duplicate boundary",
      }],
    }));
    expect(terminal).toMatchObject({
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "stopped",
      terminalAt: 120,
      activity: { reconciliation: "recovered" },
    });

    const late = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "recovered-attempt",
      runId: "recovered-run",
      turnSessionId: "recovered-turn",
      generationId: "recovered-generation",
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "stopped",
      reason: "reconciled",
      transcript: [{
        id: "late-reordered-record",
        kind: "tool",
        actor: "tool",
        recipient: "agent",
        occurredAt: 80,
        hostSequence: 1,
        late: true,
        content: "late evidence",
        arguments: null,
        result: null,
        durationMs: null,
        provider: null,
        errorReason: null,
        correlation: { parentId: "recovery-marker", hostSequence: 1 },
      }],
    }));
    expect(late).toMatchObject({
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "stopped",
      terminalAt: 120,
    });
    expect(late!.transcript[0]!.late).toBe(true);
    expect(late!.markers.map((marker) => marker.kind)).toEqual(expect.arrayContaining([
      "recovered_duplicate",
      "late_event",
      "reordered_event",
    ]));
  });

  test("fails closed across owners and for malformed or unavailable audit sections", () => {
    const chat = createChat(OWNER, { name: "inspection-ownership" });
    const stored = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "owner-scoped-attempt",
      runId: "owner-scoped-run",
      turnSessionId: "owner-scoped-turn",
      generationId: "owner-scoped-generation",
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "failed",
      reason: "provider_failure",
      terminalReceipt: {
        error: {
          code: "provider_request_error",
          category: "provider",
          summaryCode: "agentRun.errors.provider_request_error",
          causalCode: "provider_timeout",
          authority: "provider",
          source: "provider",
          scope: "provider",
          capGate: {
            id: "provider-round",
            limit: 3,
            observed: 4,
            exceeded: true,
            authority: "host",
            source: "execution",
          },
          recoveryEligible: true,
          recoveryAction: "retry",
          omissionCount: 2,
        },
      },
      councilReceipts: [{
        version: 99,
        id: "malformed-council",
        secret: "SHOULD-NOT-LEAK",
      }],
      cortexReceipts: [{
        version: 99,
        id: "malformed-cortex",
        secret: "SHOULD-NOT-LEAK",
      }],
      markers: [
        {
          id: "prompt-withheld",
          kind: "credentials_withheld",
          scope: "prompt",
          firstSequence: null,
          lastSequence: null,
          recoverable: false,
          detail: "credentials withheld",
        },
        {
          id: "transcript-unavailable",
          kind: "unavailable",
          scope: "transcript",
          firstSequence: null,
          lastSequence: null,
          recoverable: false,
          detail: "transcript unavailable",
        },
      ],
    }));
    expect(stored).not.toBeNull();
    expect(getAgentRunInspection(OTHER, "owner-scoped-attempt", chat.id)).toBeNull();
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      userId: OTHER,
      attemptId: "foreign-attempt",
      runId: "foreign-run",
      turnSessionId: "foreign-turn",
      generationId: "foreign-generation",
    }))).toBeNull();
    expect(stored!.councilReceipts).toHaveLength(0);
    expect(stored!.cortexReceipts).toHaveLength(0);
    expect(stored!.markers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "credentials_withheld", scope: "prompt", recoverable: false }),
      expect.objectContaining({ kind: "unavailable", scope: "transcript", recoverable: false }),
      expect.objectContaining({ kind: "unavailable", scope: "council", recoverable: false }),
      expect.objectContaining({ kind: "unavailable", scope: "cortex", recoverable: false }),
    ]));
    expect(stored!.error).toMatchObject({
      code: "provider_request_error",
      category: "provider",
      summaryCode: "agentRun.errors.provider_request_error",
      causalCode: null,
      authority: "provider",
      source: "provider",
      scope: "provider",
      capGate: { id: "provider-round", limit: 3, observed: 4, exceeded: true },
      recoveryEligible: true,
      recoveryAction: "retry",
      omissionCount: 2,
      workPhase: "TERMINAL",
      workStatus: "terminal",
      workOutcome: "failed",
    });
    expect(JSON.stringify(stored)).not.toContain("SHOULD-NOT-LEAK");
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "invalid-lifecycle",
      runId: "invalid-run",
      turnSessionId: "invalid-turn",
      generationId: "invalid-generation",
      lifecycle: "NOT_A_PHASE" as never,
    }))).toBeNull();
  });

  test("preserves child_required_failed and child_output_limit_exceeded instead of internal_error", () => {
    const chat = createChat(OWNER, { name: "inspection-child-codes" });
    const required = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "child-required-attempt",
      runId: "child-required-run",
      turnSessionId: "child-required-turn",
      generationId: "child-required-generation",
      hostCorrelationId: "child-required-host",
      outcome: "failed",
      reason: "required_work_failure",
      terminalReceipt: {
        error: {
          code: "child_required_failed",
        },
      },
    }));
    expect(required!.error).toMatchObject({
      code: "child_required_failed",
      category: "validation",
      summaryCode: "agentRun.errors.child_required_failed",
      reason: "required_work_failure",
      workOutcome: "failed",
    });

    const protocol = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "protocol-attempt",
      runId: "protocol-run",
      turnSessionId: "protocol-turn",
      generationId: "protocol-generation",
      hostCorrelationId: "protocol-host",
      outcome: "failed",
      reason: "invalid_input",
      terminalReceipt: {
        error: {
          code: "agentic_protocol_failure",
          category: "internal",
        },
      },
    }));
    expect(protocol!.error).toMatchObject({
      code: "agentic_protocol_failure",
      category: "validation",
      summaryCode: "agentRun.errors.agentic_protocol_failure",
      reason: "invalid_input",
    });

    const limit = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "child-limit-attempt",
      runId: "child-limit-run",
      turnSessionId: "child-limit-turn",
      generationId: "child-limit-generation",
      hostCorrelationId: "child-limit-host",
      outcome: "failed",
      reason: "budget_exhausted",
      terminalReceipt: {
        error: {
          code: "child_output_limit_exceeded",
        },
      },
    }));
    expect(limit!.error).toMatchObject({
      code: "child_output_limit_exceeded",
      category: "budget",
      summaryCode: "agentRun.errors.child_output_limit_exceeded",
      reason: "budget_exhausted",
    });

    const unknown = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "unknown-attempt",
      runId: "unknown-run",
      turnSessionId: "unknown-turn",
      generationId: "unknown-generation",
      hostCorrelationId: "unknown-host",
      outcome: "failed",
      reason: "unknown",
      terminalReceipt: {
        error: {
          code: "not_a_public_code",
        },
      },
    }));
    expect(unknown!.error).toMatchObject({
      code: "internal_error",
      category: "internal",
      summaryCode: "agentRun.errors.internal_error",
    });
  });

  test("marks malformed durable audit and activity projection payloads unavailable", () => {
    const chat = createChat(OWNER, { name: "inspection-corrupt-projections" });
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "corrupt-projection-attempt",
      runId: "corrupt-projection-run",
      turnSessionId: "corrupt-projection-turn",
      generationId: "corrupt-projection-generation",
    }))).not.toBeNull();
    const db = getDb();
    db.query(
      `INSERT INTO agent_run_audit_records
        (record_id, user_id, chat_id, attempt_id, record_kind, event_id, causal_parent_id,
         host_sequence, occurred_at, late, payload_json, byte_size, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "corrupt-transcript-record",
      OWNER,
      chat.id,
      "corrupt-projection-attempt",
      "transcript",
      "corrupt-transcript",
      null,
      1,
      1,
      0,
      "{malformed",
      11,
      "corrupt-transcript",
    );
    db.run("PRAGMA foreign_keys = OFF");
    db.query(
      `INSERT INTO agent_run_projections
        (user_id, chat_id, turn_id, generation_id, generation_type, status, phase,
         revision, sequence, started_at, updated_at, snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      OWNER,
      chat.id,
      "corrupt-projection-turn",
      "corrupt-projection-generation",
      "normal",
      "WORK",
      "WORK",
      1,
      1,
      1,
      1,
      "{malformed",
    );
    db.run("PRAGMA foreign_keys = ON");

    const detail = getAgentRunInspection(OWNER, "corrupt-projection-attempt", chat.id);
    expect(detail).not.toBeNull();
    expect(detail!.markers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "unavailable", scope: "transcript" }),
      expect.objectContaining({ kind: "unavailable", scope: "activity" }),
    ]));
    expect(detail!.sectionAvailability).toEqual(expect.arrayContaining([
      expect.objectContaining({ section: "transcript", state: "unavailable" }),
      expect.objectContaining({ section: "activity", state: "unavailable" }),
    ]));
  });

  test("bounds all persisted inspection groups under one total budget with a truncation marker", () => {
    const chat = createChat(OWNER, { name: "inspection-total-budget" });
    const detail = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "total-budget-attempt",
      runId: "total-budget-run",
      turnSessionId: "total-budget-turn",
      generationId: "total-budget-generation",
      transcript: Array.from({ length: AGENT_RUN_INSPECTION_MAX_RECORDS + 2 }, (_, index) => ({
        id: `total-budget-${index}`,
        kind: "tool",
        actor: "tool",
      })),
      activity: Array.from({ length: 2 }, (_, index) => ({
        id: `total-budget-activity-${index}`,
        kind: "tool",
        actor: "tool",
      })),
    }));
    expect(detail).not.toBeNull();
    const stored = getDb().query(
      `SELECT COUNT(*) AS count
         FROM agent_run_audit_records
        WHERE user_id = ? AND attempt_id = ?`,
    ).get(OWNER, "total-budget-attempt") as { count: number };
    expect(stored.count).toBeLessThanOrEqual(AGENT_RUN_INSPECTION_MAX_RECORDS);
    expect(detail!.markers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "truncated", scope: "run" }),
    ]));
  });

  test("keeps repeated late and reordered evidence within the durable per-attempt cap", () => {
    const chat = createChat(OWNER, { name: "inspection-marker-budget" });
    const baseCount = AGENT_RUN_INSPECTION_MAX_RECORDS - 4;
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "marker-budget-attempt",
      runId: "marker-budget-run",
      turnSessionId: "marker-budget-turn",
      generationId: "marker-budget-generation",
      updatedAt: 100,
      transcript: Array.from({ length: baseCount }, (_, index) => ({
        id: `marker-budget-base-${index}`,
        kind: "tool",
        actor: "tool",
      })),
    }))).not.toBeNull();

    const lateReordered = Array.from({ length: 4 }, (_, index) => ({
      id: `marker-budget-late-${index}`,
      kind: "tool",
      actor: "tool",
      recipient: "agent",
      occurredAt: 50 + index,
      hostSequence: 1,
      late: true,
      content: `late-${index}`,
      arguments: null,
      result: null,
      durationMs: null,
      provider: null,
      errorReason: null,
    }));
    const firstLate = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "marker-budget-attempt",
      runId: "marker-budget-run",
      turnSessionId: "marker-budget-turn",
      generationId: "marker-budget-generation",
      updatedAt: 200,
      transcript: lateReordered,
    }));
    const replayLate = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "marker-budget-attempt",
      runId: "marker-budget-run",
      turnSessionId: "marker-budget-turn",
      generationId: "marker-budget-generation",
      updatedAt: 300,
      transcript: lateReordered,
    }));
    expect(firstLate).not.toBeNull();
    expect(replayLate).not.toBeNull();
    expect(firstLate!.markers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "late_event", scope: "transcript" }),
      expect.objectContaining({ kind: "reordered_event", scope: "transcript" }),
      expect.objectContaining({ kind: "truncated", scope: "run" }),
    ]));
    expect(replayLate!.markers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "truncated", scope: "run" }),
    ]));

    const stored = getDb().query(
      `SELECT COUNT(*) AS count
         FROM agent_run_audit_records
        WHERE user_id = ? AND chat_id = ? AND attempt_id = ?`,
    ).get(OWNER, chat.id, "marker-budget-attempt") as { count: number };
    expect(stored.count).toBe(AGENT_RUN_INSPECTION_MAX_RECORDS);
  });

  test("rejects foreign, nonexistent, and ephemeral workspace identifiers before projection", () => {
    const chat = createChat(OWNER, { name: "inspection-workspace-boundary" });
    const foreignChat = createChat(OTHER, { name: "inspection-workspace-boundary-foreign" });
    const foreign = ensurePersistentWorkspaceForChat({
      userId: OTHER,
      chatId: foreignChat.id,
      workspaceId: "foreign-stable-workspace",
      objective: "Foreign workspace",
    });
    const association = (attemptId: string, workspaceId: string) => ({
      version: 1,
      id: `${attemptId}-association`,
      workspaceId,
      workspaceRevision: 1,
      relation: "linked" as const,
      objectKind: "objective" as const,
      objectId: null,
      sourceRevision: 1,
      sourceDeleted: false,
      provenanceDigest: null,
    });
    for (const [attemptId, workspaceId] of [
      ["foreign-attempt", foreign.id],
      ["missing-attempt", "missing-stable-workspace"],
      ["ephemeral-attempt", "workspace:ephemeral-run"],
    ] as const) {
      expect(persistAgentRunInspection(inspectionInput(chat.id, {
        attemptId,
        runId: `${attemptId}-run`,
        turnSessionId: `${attemptId}-turn`,
        generationId: `${attemptId}-generation`,
        workspaceAssociations: [association(attemptId, workspaceId)],
      }))).toBeNull();
    }
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_run_workspace_associations WHERE user_id = ?",
    ).get(OWNER)).toEqual({ count: 0 });
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_run_audit_records WHERE user_id = ? AND record_kind = 'workspace'",
    ).get(OWNER)).toEqual({ count: 0 });
  });

  test("requires the run chat and exact persistent workspace revision for new associations", () => {
    const chat = createChat(OWNER, { name: "inspection-workspace-chat-boundary" });
    const otherChat = createChat(OWNER, { name: "inspection-workspace-chat-boundary-other" });
    const persistent = ensurePersistentWorkspaceForChat({
      userId: OWNER,
      chatId: chat.id,
      workspaceId: "chat-boundary-workspace",
      objective: "Chat-boundary workspace",
    });
    const association = (attemptId: string, workspaceRevision: number) => ({
      version: 1,
      id: `${attemptId}-association`,
      workspaceId: persistent.id,
      workspaceRevision,
      relation: "linked" as const,
      objectKind: "objective" as const,
      objectId: null,
      sourceRevision: persistent.revision,
      sourceDeleted: false,
      provenanceDigest: null,
    });

    expect(persistAgentRunInspection(inspectionInput(otherChat.id, {
      attemptId: "cross-chat-workspace-attempt",
      runId: "cross-chat-workspace-run",
      turnSessionId: "cross-chat-workspace-turn",
      generationId: "cross-chat-workspace-generation",
      workspaceAssociations: [association("cross-chat-workspace", persistent.revision)],
    }))).toBeNull();
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "future-revision-workspace-attempt",
      runId: "future-revision-workspace-run",
      turnSessionId: "future-revision-workspace-turn",
      generationId: "future-revision-workspace-generation",
      workspaceAssociations: [association("future-revision-workspace", persistent.revision + 1)],
    }))).toBeNull();

    const valid = association("detached-replay-workspace", persistent.revision);
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "detached-replay-attempt",
      runId: "detached-replay-run",
      turnSessionId: "detached-replay-turn",
      generationId: "detached-replay-generation",
      workspaceAssociations: [valid],
    }))).not.toBeNull();
    getDb().query("UPDATE persistent_workspaces SET chat_id = NULL WHERE workspace_id = ?").run(persistent.id);
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "detached-new-attempt",
      runId: "detached-new-run",
      turnSessionId: "detached-new-turn",
      generationId: "detached-new-generation",
      workspaceAssociations: [association("detached-new", persistent.revision)],
    }))).toBeNull();
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "detached-replay-attempt",
      runId: "detached-replay-run",
      turnSessionId: "detached-replay-turn",
      generationId: "detached-replay-generation",
      workspaceAssociations: [valid],
    }))).not.toBeNull();
  });

  test("stores only the bounded normalized workspace payload", () => {
    const chat = createChat(OWNER, { name: "inspection-workspace-bounded" });
    const persistent = ensurePersistentWorkspaceForChat({
      userId: OWNER,
      chatId: chat.id,
      workspaceId: "bounded-stable-workspace",
      objective: "Bounded workspace",
    });
    const result = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "bounded-workspace-attempt",
      runId: "bounded-workspace-run",
      turnSessionId: "bounded-workspace-turn",
      generationId: "bounded-workspace-generation",
      workspaceAssociations: [{
        version: 1,
        id: "bounded-workspace-association",
        workspaceId: persistent.id,
        workspaceRevision: persistent.revision,
        relation: "linked",
        objectKind: "objective",
        objectId: null,
        sourceRevision: persistent.revision,
        sourceDeleted: false,
        provenanceDigest: null,
        unknownPayload: "x".repeat(AGENT_RUN_INSPECTION_MAX_PAYLOAD_BYTES * 4),
      }],
    }));
    expect(result).not.toBeNull();
    const stored = getDb().query(
      `SELECT payload_json, byte_size
         FROM agent_run_audit_records
        WHERE user_id = ? AND attempt_id = ? AND record_kind = 'workspace'`,
    ).get(OWNER, "bounded-workspace-attempt") as { payload_json: string; byte_size: number };
    expect(stored.byte_size).toBeLessThanOrEqual(AGENT_RUN_INSPECTION_MAX_RECORD_BYTES);
    expect(JSON.parse(stored.payload_json)).not.toHaveProperty("unknownPayload");
  });

  test("keeps same workspace replay idempotent, rejects changed payloads, and isolates attempt IDs", () => {
    const chat = createChat(OWNER, { name: "inspection-workspace-replay" });
    const persistent = ensurePersistentWorkspaceForChat({
      userId: OWNER,
      chatId: chat.id,
      workspaceId: "replay-stable-workspace",
      objective: "Replay workspace",
    });
    const secondChat = createChat(OWNER, { name: "inspection-workspace-replay-second" });
    const secondPersistent = ensurePersistentWorkspaceForChat({
      userId: OWNER,
      chatId: secondChat.id,
      workspaceId: "replay-stable-workspace-second",
      objective: "Replay workspace second",
    });
    const association = {
      version: 1 as const,
      id: "replay-association-a",
      workspaceId: persistent.id,
      workspaceRevision: persistent.revision,
      relation: "linked" as const,
      objectKind: "objective" as const,
      objectId: null,
      sourceRevision: persistent.revision,
      sourceDeleted: false,
      provenanceDigest: null,
    };
    const first = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "replay-attempt-a",
      runId: "replay-run-a",
      turnSessionId: "replay-turn-a",
      generationId: "replay-generation-a",
      workspaceAssociations: [association],
    }));
    const replay = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "replay-attempt-a",
      runId: "replay-run-a",
      turnSessionId: "replay-turn-a",
      generationId: "replay-generation-a",
      workspaceAssociations: [association],
    }));
    const conflict = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "replay-attempt-a",
      runId: "replay-run-a",
      turnSessionId: "replay-turn-a",
      generationId: "replay-generation-a",
      workspaceAssociations: [{ ...association, objectId: "changed-object" }],
    }));
    const secondWriter = createAgentInspectionWriter({
      userId: OWNER,
      chatId: secondChat.id,
      attemptId: "replay-attempt-b",
      runId: "replay-run-b",
      turnSessionId: "replay-turn-b",
      generationId: "replay-generation-b",
      generationType: "normal",
      hostCorrelationId: "inspection-host-second",
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "completed",
    });
    const secondAttempt = secondWriter.record("workspace", {
      ...association,
      id: "replay-association-b",
      workspaceId: secondPersistent.id,
      workspaceRevision: secondPersistent.revision,
      sourceRevision: secondPersistent.revision,
    });
    expect(first).not.toBeNull();
    expect(replay).not.toBeNull();
    expect(conflict).toBeNull();
    expect(secondAttempt).not.toBeNull();
    expect(getDb().query(
      "SELECT association_id, attempt_id FROM agent_run_workspace_associations WHERE user_id = ? ORDER BY association_id",
    ).all(OWNER)).toEqual([
      { association_id: "replay-association-a", attempt_id: "replay-attempt-a" },
      { association_id: "replay-association-b", attempt_id: "replay-attempt-b" },
    ]);
  });

  test("projects workspace associations durably and retains the stable workspace after chat deletion", () => {
    const chat = createChat(OWNER, { name: "inspection-workspace-association" });
    const persistent = ensurePersistentWorkspaceForChat({
      userId: OWNER,
      chatId: chat.id,
      workspaceId: "persistent-workspace-uuid",
      objective: "Durable workspace",
    });
    const writer = createAgentInspectionWriter({
      userId: OWNER,
      chatId: chat.id,
      attemptId: "workspace-association-attempt",
      runId: "workspace-association-run",
      turnSessionId: "workspace-association-turn",
      generationId: "workspace-association-generation",
      generationType: "normal",
      hostCorrelationId: "workspace-association-host",
      lifecycle: "ASSEMBLE",
      status: "running",
    });
    const association = {
      version: 1,
      id: "workspace-association",
      workspaceId: persistent.id,
      workspaceRevision: persistent.revision,
      relation: "linked",
      objectKind: "objective",
      objectId: null,
      sourceRevision: persistent.revision,
      sourceDeleted: false,
      provenanceDigest: null,
      correlation: { actorId: "host", recipientId: "owner" },
    };

    const first = writer.record("workspace", association);
    const replay = writer.record("workspace", association);
    expect(first).not.toBeNull();
    expect(replay).not.toBeNull();
    expect(first?.workspaceAssociations).toEqual([
      expect.objectContaining({
        id: association.id,
        workspaceId: persistent.id,
        workspaceRevision: persistent.revision,
        relation: "linked",
        objectKind: "objective",
        objectId: null,
        sourceRevision: persistent.revision,
        sourceDeleted: false,
        provenanceDigest: null,
        correlation: expect.objectContaining({
          hostSequence: 1,
          actorId: "host",
          recipientId: "owner",
        }),
      }),
    ]);
    expect(getDb().query(
      `SELECT association_id, user_id, chat_id, attempt_id, workspace_id, workspace_revision,
              relation, object_kind, object_id, source_revision, source_deleted,
              provenance_digest, host_sequence
         FROM agent_run_workspace_associations
        WHERE user_id = ? AND attempt_id = ?`,
    ).all(OWNER, "workspace-association-attempt")).toEqual([{
      association_id: association.id,
      user_id: OWNER,
      chat_id: chat.id,
      attempt_id: "workspace-association-attempt",
      workspace_id: persistent.id,
      workspace_revision: persistent.revision,
      relation: "linked",
      object_kind: "objective",
      object_id: null,
      source_revision: persistent.revision,
      source_deleted: 0,
      provenance_digest: null,
      host_sequence: 1,
    }]);
    expect(getDb().query(
      `SELECT COUNT(*) AS count
         FROM agent_run_audit_records
        WHERE user_id = ? AND attempt_id = ? AND record_kind = 'workspace'`,
    ).get(OWNER, "workspace-association-attempt")).toEqual({ count: 1 });

    const otherChat = createChat(OTHER, { name: "inspection-workspace-association-other" });
    const otherPersistent = ensurePersistentWorkspaceForChat({
      userId: OTHER,
      chatId: otherChat.id,
      workspaceId: "persistent-workspace-other",
      objective: "Other durable workspace",
    });
    const otherWriter = createAgentInspectionWriter({
      userId: OTHER,
      chatId: otherChat.id,
      attemptId: "workspace-association-other-attempt",
      runId: "workspace-association-other-run",
      turnSessionId: "workspace-association-other-turn",
      generationId: "workspace-association-other-generation",
      generationType: "normal",
      hostCorrelationId: "workspace-association-other-host",
      lifecycle: "ASSEMBLE",
      status: "running",
    });
    expect(otherWriter.record("workspace", {
      ...association,
      workspaceId: otherPersistent.id,
      workspaceRevision: otherPersistent.revision,
      sourceRevision: otherPersistent.revision,
    })).toBeNull();
    const otherAssociation = {
      ...association,
      id: "workspace-association-other",
      workspaceId: otherPersistent.id,
      workspaceRevision: otherPersistent.revision,
      sourceRevision: otherPersistent.revision,
    };
    expect(otherWriter.record("workspace", otherAssociation)).not.toBeNull();
    expect(getDb().query(
      `SELECT user_id, attempt_id, workspace_id, source_deleted, host_sequence
         FROM agent_run_workspace_associations
        ORDER BY user_id, attempt_id`,
    ).all()).toEqual([
      {
        user_id: OTHER,
        attempt_id: "workspace-association-other-attempt",
        workspace_id: otherPersistent.id,
        source_deleted: 0,
        host_sequence: 2,
      },
      {
        user_id: OWNER,
        attempt_id: "workspace-association-attempt",
        workspace_id: persistent.id,
        source_deleted: 0,
        host_sequence: 1,
      },
    ]);

    expect(deleteChat(OWNER, chat.id)).toBe(true);
    expect(getAgentRunInspection(OTHER, "workspace-association-attempt", chat.id)).toBeNull();
    const deleted = getAgentRunInspection(OWNER, "workspace-association-attempt", chat.id);
    expect(deleted?.workspaceAssociations).toEqual([
      expect.objectContaining({
        id: association.id,
        workspaceId: persistent.id,
        workspaceRevision: persistent.revision,
        relation: "linked",
        objectKind: "objective",
        objectId: null,
        sourceRevision: persistent.revision,
        sourceDeleted: true,
        provenanceDigest: null,
        correlation: expect.objectContaining({
          hostSequence: 1,
          attemptId: "workspace-association-attempt",
          chatId: chat.id,
        }),
      }),
    ]);
    expect(getDb().query(
      `SELECT association_id, workspace_id, workspace_revision, source_deleted, host_sequence
         FROM agent_run_source_deletion_workspace
        WHERE user_id = ? AND attempt_id = ?`,
    ).all(OWNER, "workspace-association-attempt")).toEqual([{
      association_id: association.id,
      workspace_id: persistent.id,
      workspace_revision: persistent.revision,
      source_deleted: 1,
      host_sequence: 1,
    }]);
    expect(getPersistentWorkspaceById({
      userId: OWNER,
      workspaceId: persistent.id,
    }).id).toBe(persistent.id);
    expect(getAgentRunInspection(OTHER, "workspace-association-other-attempt", otherChat.id)?.workspaceAssociations).toEqual([
      expect.objectContaining({
        id: otherAssociation.id,
        workspaceId: otherPersistent.id,
        sourceDeleted: false,
        correlation: expect.objectContaining({ hostSequence: 2 }),
      }),
    ]);
    expect(getPersistentWorkspaceById({
      userId: OTHER,
      workspaceId: otherPersistent.id,
    }).id).toBe(otherPersistent.id);
  });

  test("retains each linked, work, and published association once by ID after source deletion", () => {
    const chat = createChat(OWNER, { name: "inspection-workspace-retention-cardinality" });
    const persistent = ensurePersistentWorkspaceForChat({
      userId: OWNER,
      chatId: chat.id,
      workspaceId: "retention-cardinality-workspace",
      objective: "Retention cardinality workspace",
    });
    const associations = [
      {
        version: 1,
        id: "retained-linked-objective",
        workspaceId: persistent.id,
        workspaceRevision: persistent.revision,
        relation: "linked",
        objectKind: "objective",
        objectId: null,
        sourceRevision: persistent.revision,
        sourceDeleted: false,
        provenanceDigest: null,
      },
      {
        version: 1,
        id: "retained-work-task",
        workspaceId: persistent.id,
        workspaceRevision: persistent.revision,
        relation: "linked",
        objectKind: "task",
        objectId: "task-retained",
        sourceRevision: persistent.revision,
        sourceDeleted: false,
        provenanceDigest: null,
      },
      {
        version: 1,
        id: "retained-published-publication",
        workspaceId: persistent.id,
        workspaceRevision: persistent.revision,
        relation: "published",
        objectKind: "publication",
        objectId: "publication-retained",
        sourceRevision: persistent.revision,
        sourceDeleted: false,
        provenanceDigest: "b".repeat(64),
      },
    ];
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "retention-cardinality-attempt",
      runId: "retention-cardinality-run",
      turnSessionId: "retention-cardinality-turn",
      generationId: "retention-cardinality-generation",
      workspaceAssociations: associations,
    }))).not.toBeNull();
    expect(deleteChat(OWNER, chat.id)).toBe(true);
    const deleted = getAgentRunInspection(OWNER, "retention-cardinality-attempt", chat.id);
    const retainedRows = getDb().query(
      `SELECT association_id, relation, object_kind, source_deleted
         FROM agent_run_source_deletion_workspace
        WHERE user_id = ? AND attempt_id = ?
        ORDER BY association_id`,
    ).all(OWNER, "retention-cardinality-attempt");
    expect(retainedRows).toEqual([
      { association_id: "retained-linked-objective", relation: "linked", object_kind: "objective", source_deleted: 1 },
      { association_id: "retained-published-publication", relation: "published", object_kind: "publication", source_deleted: 1 },
      { association_id: "retained-work-task", relation: "linked", object_kind: "task", source_deleted: 1 },
    ]);
    expect(deleted?.workspaceAssociations.map(({ id }) => id).sort()).toEqual([
      "retained-linked-objective",
      "retained-published-publication",
      "retained-work-task",
    ]);
  });

  test("cleans task-scoped workspace artifacts through the canonical source_task_id column", () => {
    const db = getDb();
    const chat = createChat(OWNER, { name: "inspection-operational-artifact-cleanup" });
    const executionId = "inspection-cleanup-turn";
    const workspaceId = "inspection-cleanup-workspace";
    const taskId = "inspection-cleanup-task";
    const artifactId = "inspection-cleanup-artifact";
    createTurnExecution({
      id: executionId,
      userId: OWNER,
      chatId: chat.id,
      generationId: "inspection-cleanup-generation",
      targetKind: "normal",
      targetChatRevision: 0,
      attemptLineage: { attemptId: "inspection-cleanup-attempt" },
      mode: "agentic",
      deadlineAt: Date.now() + 60_000,
      workspaceId,
    }, db);
    db.query(
      `INSERT INTO agent_turn_workspaces
        (workspace_id, turn_id, execution_id, user_id, chat_id, objective,
         constraints_json, state, revision, operation_caps_json, field_caps_json,
         retention, expires_at, quota_tasks, quota_records, quota_submissions,
         quota_artifacts, quota_bytes)
       VALUES (?, ?, ?, ?, ?, 'cleanup objective', '[]', 'active', 0, '{}', '{}',
               'operational', ?, 1, 0, 0, 1, 1024)`,
    ).run(workspaceId, executionId, executionId, OWNER, chat.id, Date.now() + 60_000);
    db.query(
      `INSERT INTO agent_workspace_tasks
        (task_id, workspace_id, turn_id, user_id, chat_id, title, description,
         state, required, dependencies_json, progress, byte_count, revision,
         retention, expires_at)
       VALUES (?, ?, ?, ?, ?, 'cleanup task', '', 'active', 1, '[]', 0, 0, 0,
               'operational', ?)`,
    ).run(taskId, workspaceId, executionId, OWNER, chat.id, Date.now() + 60_000);
    db.query(
      `INSERT INTO agent_workspace_artifacts
        (artifact_id, workspace_id, turn_id, user_id, chat_id, blob_digest,
         mime_type, byte_count, provenance_json, source_frame_id, source_task_id,
         publication_state, retention, revision, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'text/plain', 7, '{}', 'cleanup-frame', ?,
               'attached', 'operational', 0, ?)`,
    ).run(
      artifactId,
      workspaceId,
      executionId,
      OWNER,
      chat.id,
      "a".repeat(64),
      taskId,
      Date.now() + 60_000,
    );

    const artifactColumns = db.query("PRAGMA table_info(agent_workspace_artifacts)")
      .all() as Array<{ name: string }>;
    expect(artifactColumns.map(({ name }) => name)).toContain("source_task_id");
    expect(artifactColumns.map(({ name }) => name)).not.toContain("task_id");

    expect(deleteChat(OWNER, chat.id)).toBe(true);
    for (const [table, idColumn, id] of [
      ["agent_workspace_artifacts", "artifact_id", artifactId],
      ["agent_workspace_tasks", "task_id", taskId],
      ["agent_turn_workspaces", "workspace_id", workspaceId],
      ["agent_turn_executions", "id", executionId],
    ] as const) {
      expect(
        db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${idColumn} = ?`).get(id),
      ).toEqual({ count: 0 });
    }
  });

  test("uses available legacy ownership columns and skips tables without an execution scope", () => {
    const db = getDb();
    db.run(`
      DROP TABLE agent_workspace_records;
      DROP TABLE agent_workspace_submissions;
      CREATE TABLE agent_workspace_records (
        record_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        turn_id TEXT,
        workspace_id TEXT
      );
      CREATE TABLE agent_workspace_submissions (
        submission_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
    const chat = createChat(OWNER, { name: "inspection-legacy-operational-cleanup" });
    const executionId = "inspection-legacy-cleanup-turn";
    createTurnExecution({
      id: executionId,
      userId: OWNER,
      chatId: chat.id,
      generationId: "inspection-legacy-cleanup-generation",
      targetKind: "normal",
      targetChatRevision: 0,
      attemptLineage: { attemptId: "inspection-legacy-cleanup-attempt" },
      mode: "agentic",
      deadlineAt: Date.now() + 60_000,
      workspaceId: "inspection-legacy-cleanup-workspace",
    }, db);
    db.query(
      "INSERT INTO agent_workspace_records (record_id, user_id, turn_id, workspace_id) VALUES (?, ?, ?, ?)",
    ).run("legacy-record", OWNER, executionId, "inspection-legacy-cleanup-workspace");
    db.query(
      "INSERT INTO agent_workspace_submissions (submission_id, user_id, payload) VALUES (?, ?, ?)",
    ).run("unscoped-submission", OWNER, "must remain");

    const legacyColumns = db.query("PRAGMA table_info(agent_workspace_records)")
      .all() as Array<{ name: string }>;
    expect(legacyColumns.map(({ name }) => name)).toEqual([
      "record_id",
      "user_id",
      "turn_id",
      "workspace_id",
    ]);
    const unscopedColumns = db.query("PRAGMA table_info(agent_workspace_submissions)")
      .all() as Array<{ name: string }>;
    expect(unscopedColumns.map(({ name }) => name)).toEqual([
      "submission_id",
      "user_id",
      "payload",
    ]);

    expect(deleteChat(OWNER, chat.id)).toBe(true);
    expect(db.query(
      "SELECT COUNT(*) AS count FROM agent_workspace_records WHERE record_id = ?",
    ).get("legacy-record")).toEqual({ count: 0 });
    expect(db.query(
      "SELECT payload FROM agent_workspace_submissions WHERE submission_id = ?",
    ).get("unscoped-submission")).toEqual({ payload: "must remain" });
  });

  test("scrubs source-private evidence through owner deletion while retaining durable publication copies", () => {
    const chat = createChat(OWNER, { name: "inspection-source-deleted" });
    const target = createMessage(
      chat.id,
      { is_user: false, name: "Assistant", content: "source message" },
      OWNER,
    );
    getDb().query(
      "INSERT INTO persistent_workspaces (workspace_id, user_id, chat_id, objective) VALUES (?, ?, ?, ?)",
    ).run("workspace-durable", OWNER, chat.id, "Durable publication workspace");
    getDb().query(
      `INSERT INTO persistent_workspace_publications
        (publication_id, workspace_id, user_id, chat_id, category, source_id, source_revision,
         source_provenance_json, source_created_at, source_updated_at, source_deleted_at,
         copy_json, copy_digest, byte_count, published_at, published_by, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "publication-durable",
      "workspace-durable",
      OWNER,
      chat.id,
      "finding",
      "source-finding",
      1,
      JSON.stringify({ sourceMessageId: target.id, sourceSwipeId: 0 }),
      10,
      20,
      null,
      JSON.stringify({ summary: "durable publication copy" }),
      "a".repeat(64),
      32,
      20,
      `owner:${OWNER}`,
      1,
    );
    const detail = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "source-deleted-attempt",
      runId: "source-deleted-run",
      turnSessionId: "source-deleted-turn",
      generationId: "source-deleted-generation",
      targetMessageId: target.id,
      targetSwipeId: 0,
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "completed",
      transcript: [{
        id: "private-transcript",
        kind: "tool",
        actor: "agent",
        recipient: "tool",
        occurredAt: 10,
        late: false,
        content: "PRIVATE-SOURCE-TRANSCRIPT",
        arguments: null,
        result: null,
        durationMs: null,
        errorReason: null,
        correlation: { hostSequence: 1 },
      }],
      turnSession: [{
        id: "private-turn-session",
        kind: "input",
        occurredAt: 11,
        detail: "PRIVATE-SOURCE-TURN-SESSION",
        transcriptRecordIds: ["private-transcript"],
        correlation: { hostSequence: 2 },
      }],
      promptEvidence: [{
        version: 1,
        id: "private-prompt",
        sourceId: "loom-source",
        sourceRevision: 1,
        promptOrder: 0,
        destination: "root_work",
        role: "system",
        correlation: { hostSequence: 3 },
        included: true,
        content: "PRIVATE-SOURCE-PROMPT",
        contentDigest: "b".repeat(64),
        omissionReason: null,
      }],
    }));
    expect(detail).not.toBeNull();
    expect(detail!.transcript[0]!.content).toBe("PRIVATE-SOURCE-TRANSCRIPT");
    expect(detail!.turnSession[0]!.detail).toBe("PRIVATE-SOURCE-TURN-SESSION");
    expect(detail!.promptEvidence[0]!.content).toBe("PRIVATE-SOURCE-PROMPT");

    expect(deleteMessage(OWNER, target.id)).toBe(true);
    const deleted = getAgentRunInspection(OWNER, "source-deleted-attempt", chat.id);
    expect(deleted).not.toBeNull();
    expect(deleted!.transcript).toEqual([]);
    expect(deleted!.turnSession).toEqual([]);
    expect(deleted!.promptEvidence).toEqual([]);
    expect(deleted!.retry.allowed).toBe(false);
    expect(deleted!.markers).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "transcript", kind: "unavailable", detail: "source_deleted" }),
      expect.objectContaining({ scope: "turn_session", kind: "unavailable", detail: "source_deleted" }),
      expect.objectContaining({ scope: "prompt", kind: "unavailable", detail: "source_deleted" }),
    ]));
    expect(deleted!.sectionAvailability).toEqual(expect.arrayContaining([
      expect.objectContaining({ section: "transcript", state: "source_deleted" }),
      expect.objectContaining({ section: "turn_session", state: "source_deleted" }),
      expect.objectContaining({ section: "prompt", state: "source_deleted" }),
    ]));
    expect(deleted!.error).toMatchObject({
      code: "agentRun.errors.source_deleted",
      recoveryEligible: false,
      recoveryAction: "none",
    });
    expect(JSON.stringify(deleted)).not.toContain("PRIVATE-SOURCE-");
    expect(getDb().query(
      "SELECT publication_id, source_deleted_at, copy_json FROM persistent_workspace_publications WHERE publication_id = ?",
    ).get("publication-durable")).toEqual({
      publication_id: "publication-durable",
      source_deleted_at: null,
      copy_json: JSON.stringify({ summary: "durable publication copy" }),
    });
    expect(deleteMessage(OWNER, target.id)).toBe(false);
  });
  test("scrubs inspection evidence for an exact deleted swipe without deleting its sibling", () => {
    const chat = createChat(OWNER, { name: "inspection-swipe-deleted" });
    const target = createMessage(
      chat.id,
      { is_user: false, name: "Assistant", content: "swipe zero" },
      OWNER,
    );
    getDb().query(
      "UPDATE messages SET content = ?, swipes = ?, swipe_dates = ?, swipe_id = 0 WHERE id = ?",
    ).run("swipe zero", JSON.stringify(["swipe zero", "swipe one"]), JSON.stringify([10, 11]), target.id);
    const detail = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "swipe-deleted-attempt",
      runId: "swipe-deleted-run",
      turnSessionId: "swipe-deleted-turn",
      generationId: "swipe-deleted-generation",
      targetMessageId: target.id,
      targetSwipeId: 0,
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "completed",
      transcript: [{
        id: "swipe-private-transcript",
        kind: "tool",
        actor: "agent",
        recipient: "tool",
        occurredAt: 10,
        late: false,
        content: "PRIVATE-SWIPE-TRANSCRIPT",
        arguments: null,
        result: null,
        durationMs: null,
        errorReason: null,
        correlation: { hostSequence: 1 },
      }],
    }));
    expect(detail).not.toBeNull();
    expect(deleteSwipe(OWNER, target.id, 0)).not.toBeNull();
    const deleted = getAgentRunInspection(OWNER, "swipe-deleted-attempt", chat.id);
    expect(deleted).not.toBeNull();
    expect(deleted!.transcript).toEqual([]);
    expect(deleted!.sectionAvailability).toEqual(expect.arrayContaining([
      expect.objectContaining({ section: "transcript", state: "source_deleted" }),
    ]));
    expect(JSON.stringify(deleted)).not.toContain("PRIVATE-SWIPE-");
    expect(getDb().query("SELECT swipes, swipe_id FROM messages WHERE id = ?").get(target.id)).toEqual({
      swipes: JSON.stringify(["swipe one"]),
      swipe_id: 0,
    });
  });
  test("projects layered usage without counting recovered duplicates or provisional evidence twice", () => {
    const chat = createChat(OWNER, { name: "inspection-usage" });
    const detail = persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "usage-attempt",
      runId: "usage-run",
      turnSessionId: "usage-turn",
      generationId: "usage-generation",
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "completed",
      usageEvidence: [
        {
          id: "root-provisional",
          source: "provisional",
          layer: "root",
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          toolCalls: 0,
          childInvocations: 0,
          canonical: false,
          correlation: { hostSequence: 1 },
        },
        {
          id: "root-final",
          source: "final",
          layer: "root",
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          toolCalls: 1,
          childInvocations: 1,
          canonical: true,
          correlation: { hostSequence: 2 },
        },
        {
          id: "root-recovered",
          source: "recovered_duplicate",
          layer: "root",
          inputTokens: 900,
          outputTokens: 900,
          totalTokens: 1800,
          toolCalls: 99,
          childInvocations: 99,
          canonical: false,
          correlation: { hostSequence: 3 },
        },
        {
          id: "tool-final",
          source: "final",
          layer: "tool",
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5,
          toolCalls: 4,
          childInvocations: 0,
          canonical: true,
          correlation: { hostSequence: 4 },
        },
      ],
    }));
    expect(detail).not.toBeNull();
    expect(detail!.usageEvidence).toHaveLength(4);
    expect(detail!.usage.totals).toMatchObject({
      inputTokens: 12,
      outputTokens: 23,
      totalTokens: 35,
      toolCalls: 5,
      childInvocations: 1,
    });
    expect(detail!.usage.evidenceCount).toBe(4);
    expect(detail!.usage.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        layer: "root",
        source: "final",
        evidenceIds: expect.arrayContaining(["root-final"]),
        canonical: true,
      }),
      expect.objectContaining({
        layer: "tool",
        source: "final",
        evidenceIds: ["tool-final"],
        canonical: true,
      }),
    ]));
    expect(JSON.stringify(detail!.usage)).not.toContain("root-recovered");
  });

  test("resolves exact attempt WORK inspection without a message target and does not attach to greeting", () => {
    const chat = createChat(OWNER, { name: "inspection-no-target-breakdown" });
    const greeting = createMessage(chat.id, { is_user: true, name: "User", content: "hello" }, OWNER);
    const correlation = {
      turnSessionId: "exhausted-turn",
      runId: "exhausted-run",
      attemptId: "exhausted-attempt",
      chatId: chat.id,
      generationId: "exhausted-generation",
      messageId: null,
      swipeId: null,
      actorId: "host",
      recipientId: "agent",
      phase: "WORK",
      taskId: null,
      toolId: null,
      parentId: null,
      hostCorrelationId: "inspection-host:exhausted-attempt",
      hostSequence: 1,
    };
    const loomInspection = {
      version: 1,
      surface: "WORK",
      checkpoint: "WORK",
      items: [],
      effectiveEntryIds: ["loom-root"],
    };
    persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "exhausted-attempt",
      runId: "exhausted-run",
      turnSessionId: "exhausted-turn",
      generationId: "exhausted-generation",
      targetMessageId: null,
      targetSwipeId: null,
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "exhausted",
      reason: "budget_exhausted",
      promptEvidence: [{
        version: 1,
        id: "prompt-root",
        sourceId: "loom-root",
        sourceRevision: 3,
        promptOrder: 0,
        destination: "root_work",
        role: "system",
        correlation,
        included: true,
        content: "ROOT_WORK_PROMPT",
        contentDigest: "a".repeat(64),
        omissionReason: null,
        nativeProvenance: null,
        loomInspection,
      }, {
        version: 1,
        id: "prompt-handoff",
        sourceId: "phase-continuation",
        sourceRevision: 3,
        promptOrder: 0,
        destination: "completion_handoff",
        role: "system",
        correlation: { ...correlation, hostSequence: 2 },
        included: true,
        content: "PHASE_CONTINUATION",
        contentDigest: "b".repeat(64),
        omissionReason: null,
        nativeProvenance: null,
        loomInspection: {
          version: 1,
          surface: "WORK",
          checkpoint: "PREPARE_COMMIT",
          items: [],
          effectiveEntryIds: ["phase-continuation"],
        },
      }, {
        version: 1,
        id: "prompt-cortex",
        sourceId: "cortex-private",
        sourceRevision: 1,
        promptOrder: 0,
        destination: "cortex",
        role: "system",
        correlation: { ...correlation, hostSequence: 3 },
        included: true,
        content: "PRIVATE_CORTEX",
        contentDigest: "c".repeat(64),
        omissionReason: null,
        nativeProvenance: null,
        loomInspection: null,
      }],
    }));
    expect(persistAgentRunInspection(inspectionInput(chat.id, {
      attemptId: "failed-attempt",
      runId: "failed-run",
      turnSessionId: "failed-turn",
      generationId: "failed-generation",
      hostCorrelationId: "failed-host",
      targetMessageId: null,
      targetSwipeId: null,
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "failed",
      reason: "required_work_failure",
      promptEvidence: [{
        version: 1,
        id: "prompt-failed",
        sourceId: "failed-root",
        sourceRevision: 1,
        promptOrder: 0,
        destination: "root_work",
        role: "system",
        correlation: {
          turnSessionId: "failed-turn",
          runId: "failed-run",
          attemptId: "failed-attempt",
          chatId: chat.id,
          generationId: "failed-generation",
          messageId: null,
          swipeId: null,
          actorId: "host",
          recipientId: "agent",
          phase: "WORK",
          taskId: null,
          toolId: null,
          parentId: null,
          hostCorrelationId: "failed-host",
          hostSequence: 1,
        },
        included: true,
        content: "FAILED_WORK_PROMPT",
        contentDigest: "d".repeat(64),
        omissionReason: null,
        nativeProvenance: null,
        loomInspection: {
          version: 1,
          surface: "WORK",
          checkpoint: "WORK",
          items: [],
          effectiveEntryIds: ["failed-root"],
        },
      }],
    }))).not.toBeNull();

    const exhausted = getBreakdownForAttempt(OWNER, "exhausted-attempt", chat.id);
    expect(exhausted).toMatchObject({
      assemblySurface: "WORK",
      inspectionAttemptId: "exhausted-attempt",
      target: null,
      loomPromptInspection: expect.objectContaining({ surface: "WORK", checkpoint: "WORK" }),
    });
    expect((exhausted?.entries as Array<{ content: string }>).map((entry) => entry.content)).toEqual([
      "ROOT_WORK_PROMPT",
      "PHASE_CONTINUATION",
    ]);
    expect((exhausted?.entries as Array<{ promptOrder: number }>).map((entry) => entry.promptOrder)).toEqual([0, 0]);
    expect(JSON.stringify(exhausted)).not.toContain("PRIVATE_CORTEX");
    expect(JSON.stringify(exhausted)).not.toContain("FAILED_WORK_PROMPT");
    expect(JSON.stringify(exhausted)).not.toContain("ordinary_response");

    const failed = getBreakdownForAttempt(OWNER, "failed-attempt", chat.id);
    expect(failed).toMatchObject({
      assemblySurface: "WORK",
      inspectionAttemptId: "failed-attempt",
    });
    expect((failed?.entries as Array<{ content: string }>)[0]?.content).toBe("FAILED_WORK_PROMPT");
    expect(getBreakdownForAttempt(OWNER, "missing-attempt", chat.id)).toBeNull();

    expect(getBreakdown(OWNER, greeting.id)).toBeNull();
    storeBreakdown(OWNER, greeting.id, chat.id, {
      assemblySurface: "RESPONSE",
      entries: [{ name: "greeting", type: "lumiverse", tokens: 1, role: "user", content: "hello" }],
      messages: [{ role: "user", content: "hello" }],
      totalTokens: 1,
      maxContext: 0,
      model: "response-model",
      provider: "response-provider",
      tokenizer_name: null,
    });
    expect(getBreakdown(OWNER, greeting.id)).toMatchObject({
      assemblySurface: "RESPONSE",
      model: "response-model",
    });
    expect(getBreakdownForAttempt(OWNER, "exhausted-attempt", chat.id)).toMatchObject({
      assemblySurface: "WORK",
      inspectionAttemptId: "exhausted-attempt",
    });
  });

});

describe("agent run inspection keyset pagination", () => {
  test("continues past the former offset clamp and emits strictly advancing terminal cursors", () => {
    const chat = createChat(OWNER, { name: "inspection-pagination-boundary" });
    getDb().query(`
      WITH digits(d) AS (
        VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
      ),
      numbers(value) AS (
        SELECT d0.d * 10000 + d1.d * 1000 + d2.d * 100 + d3.d * 10 + d4.d
          FROM digits AS d0
          CROSS JOIN digits AS d1
          CROSS JOIN digits AS d2
          CROSS JOIN digits AS d3
          CROSS JOIN digits AS d4
        UNION ALL SELECT 100000
        UNION ALL SELECT 100001
      )
      INSERT INTO agent_run_attempts (
        user_id, chat_id, attempt_id, run_id, turn_id, generation_id,
        generation_type, lifecycle, status, outcome, reason, terminal,
        started_at, updated_at, terminal_at, host_correlation_id,
        reconciliation_state, terminal_receipt_json, version
      )
      SELECT ?, ?, printf('boundary-%06d', value), printf('boundary-run-%06d', value),
        printf('boundary-turn-%06d', value), printf('boundary-generation-%06d', value),
        'normal', 'TERMINAL', 'terminal', 'completed', 'none', 1,
        1, 1, 1, printf('boundary-host-%06d', value),
        'authoritative', NULL, 1
      FROM numbers
    `).run(OWNER, chat.id);

    const beforeClamp = listAgentRunInspections(
      OWNER,
      chat.id,
      1,
      __test__mintAgentRunInspectionCursor(1, "boundary-000002"),
    );
    expect(beforeClamp?.runs.map((run) => run.attempt.attemptId)).toEqual(["boundary-000001"]);
    expect(beforeClamp?.nextCursor).not.toBeNull();
    expect(beforeClamp?.nextCursor).not.toBe(__test__mintAgentRunInspectionCursor(1, "boundary-000002"));

    const after = listAgentRunInspections(OWNER, chat.id, 1, beforeClamp!.nextCursor!);
    expect(after?.runs.map((run) => run.attempt.attemptId)).toEqual(["boundary-000000"]);
    expect(after?.nextCursor).toBeNull();

    const atClamp = listAgentRunInspections(
      OWNER,
      chat.id,
      1,
      __test__mintAgentRunInspectionCursor(1, "boundary-000001"),
    );
    expect(atClamp?.runs.map((run) => run.attempt.attemptId)).toEqual(["boundary-000000"]);
    expect(atClamp?.nextCursor).toBeNull();
    expect(listAgentRunInspections(OWNER, chat.id, 1, "100000")).toBeNull();
    expect(listAgentRunInspections(OWNER, chat.id, 1, "v1.invalid")).toBeNull();

    const oversized = `v1.${"a".repeat(AGENT_RUN_INSPECTION_MAX_CURSOR_BYTES)}`;
    expect(listAgentRunInspections(OWNER, chat.id, 1, oversized)).toBeNull();
  });
});

describe("agent activity serialization bounds", () => {
  test("always returns a bounded serialized DTO", () => {
    const result = __test__serializeAgentActivityRun({
      userId: OWNER,
      chatId: "chat",
      generationId: "generation",
      snapshot: snapshot("completed"),
    });
    expect(result).not.toBeNull();
    expect(result!.byteSize).toBeLessThanOrEqual(AGENT_ACTIVITY_RUN_MAX_BYTES);
  });
});
