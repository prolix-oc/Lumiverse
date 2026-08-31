import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { AgenticWorkMutatingWorkspaceOperationKindV1, AgenticWorkWorkspaceMutationReservationV1 } from "../types/agent-work-segment";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import type {
  LoomPolicyCheckpointV1,
  LoomPolicyDestinationV1,
  LoomPolicyEntryV1,
  LoomPolicySourceV1,
} from "../types/agent-cognition";
import { createAgentCognitionRuntime } from "./agent-cognition-runtime.service";
import { createTurnWorkspace } from "./turn-workspace.service";

const USER_ID = "cognition-freeze-user";
const CHAT_ID = "cognition-freeze-chat";
const TURN_ID = "cognition-freeze-turn";
const WORKSPACE_ID = "cognition-freeze-workspace";
const TASK_ID = "late-task";

async function applySchema(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = ON");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
}

function seed(): void {
  const db = getDb();
  db.query("INSERT INTO \"user\" (id, name, email) VALUES (?, ?, ?)")
    .run(USER_ID, "Cognition freeze user", "cognition-freeze@example.test");
  db.query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)")
    .run("cognition-freeze-character", USER_ID, "Cognition freeze character");
  db.query("INSERT INTO chats (id, user_id, character_id, name) VALUES (?, ?, ?, ?)")
    .run(CHAT_ID, USER_ID, "cognition-freeze-character", "Cognition freeze chat");
  db.query(`INSERT INTO agent_turn_executions
    (id, user_id, chat_id, generation_id, target_kind, target_chat_revision, mode,
     runtime_epoch, deadline_at, state, root_ledger_json, frame_capabilities_json,
     commit_key, expires_at)
    VALUES (?, ?, ?, ?, 'normal', 0, 'agentic', 1, 9999999999999, 'ASSEMBLE', '{}', '{}', ?, 9999999999999)`)
    .run(TURN_ID, USER_ID, CHAT_ID, "cognition-freeze-generation", "cognition-freeze-commit");
}

function workspaceContext(expectedRevision: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: USER_ID,
    chatId: CHAT_ID,
    turnId: TURN_ID,
    workspaceId: WORKSPACE_ID,
    actor: "root",
    frameId: TURN_ID,
    expectedRevision,
    ...extra,
  };
}

function receiptReservation(
  operationKey: string,
  operationKind: AgenticWorkMutatingWorkspaceOperationKindV1,
): AgenticWorkWorkspaceMutationReservationV1 {
  const segmentId = "cognition-freeze-segment";
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  try {
    db.query(`INSERT OR IGNORE INTO agent_work_segment_dispatches
      (dispatch_id, user_id, execution_id, attempt_id, segment_id, workspace_id,
       workspace_revision, execution_cas_revision, dispatch_ordinal, lifecycle,
       tool_mode, budget_class, reserved_output_tokens, ordinary_output_tokens_reserved,
       recovery_reserve_output_tokens_reserved, lease_owner, lease_expires_at,
       fence_generation, idempotency_key, payload_digest, created_at, updated_at)
      VALUES ('cognition-freeze-dispatch', ?, ?, 'cognition-freeze-attempt', ?, ?,
              0, 0, 0, 'reserved', 'ordinary', 'normal', 1, 1, 0,
              'cognition-freeze-owner', 9999999999999, 1, 'cognition-freeze-dispatch-key', ?, 1, 1)`)
      .run(USER_ID, TURN_ID, segmentId, WORKSPACE_ID, "0".repeat(64));
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
  return Object.freeze({
    version: 1,
    operationKey,
    operationKind,
    segmentId,
    logicalDispatch: 0,
    frameId: TURN_ID,
  });
}

function loomSource(blockId: string, promptOrder: number): LoomPolicySourceV1 {
  return {
    kind: "loom_block",
    blockId,
    presetRevision: 1,
    blockRevision: 1,
    promptOrder,
  };
}

function loomEntry(
  id: string,
  source: LoomPolicySourceV1,
  destination: LoomPolicyDestinationV1,
  checkpoint: LoomPolicyCheckpointV1,
  transition: "pending" | "completed" = "pending",
): LoomPolicyEntryV1 {
  return {
    version: 1,
    id,
    source,
    destination,
    checkpoint,
    required: false,
    visibility: "work_only",
    condition: { kind: "task_transition", taskId: TASK_ID, transition },
  };
}

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  await applySchema();
  seed();
});

afterEach(() => {
  closeDatabase();
});

describe("agent cognition Loom checkpoint evidence", () => {
  test("freezes reached outcomes while later checkpoints evaluate their own snapshot", async () => {
    const workspace = createTurnWorkspace({
      userId: USER_ID,
      chatId: CHAT_ID,
      turnId: TURN_ID,
      workspaceId: WORKSPACE_ID,
      objective: "Prove checkpoint outcome isolation",
      constraints: [],
      retention: "operational",
      ttlSeconds: 100,
      quota: { maxTasks: 8, maxRecords: 8, maxSubmissions: 8, maxArtifacts: 4, maxBytes: 2048 },
      capabilities: {
        revision: 1,
        allowed: ["read_section", "read_page", "create_task"],
        maxOperationBytes: 131_072,
        maxOperations: 128,
      },
    });
    const workSource = loomSource("work-block", 0);
    const completionSource = loomSource("completion-block", 1);
    const renderSource = loomSource("render-block", 2);
    const loomPolicy = {
      version: 1 as const,
      workPolicy: [loomEntry("work-entry", workSource, "root_work", "WORK")],
      workspaceUsage: [],
      completionCriteria: [loomEntry("completion-entry", completionSource, "completion_handoff", "PREPARE_COMMIT")],
      renderPolicy: [loomEntry("render-entry", renderSource, "render", "RENDER")],
    };
    const sourceBlocks = [workSource, completionSource, renderSource];
    const runtime = createAgentCognitionRuntime({
      source: {
        graph: {
          version: 1,
          policies: { workPolicy: [], workspaceUsage: [], completionCriteria: [], renderPolicy: [] },
          templates: [],
        },
        source: {
          presetRevision: 1,
          blocks: sourceBlocks.map((source) => ({
            blockId: source.blockId,
            revision: source.blockRevision,
            promptOrder: source.promptOrder,
          })),
        },
        loomPolicy,
        loomBlocks: sourceBlocks.map((source) => ({ source, content: `${source.blockId} content` })),
      },
      evaluation: {
        generationType: "normal",
        phase: "ASSEMBLE",
        presetVariables: {},
        participantFacts: {},
        availableTools: [],
        taskTransitions: {},
      },
      workspaceRevision: workspace.revision,
      workspace: workspaceContext(workspace.revision),
    });

    const work = runtime.enterPhase({
      phase: "WORK",
      workspace: workspaceContext(runtime.initialActivation.workspaceRevision),
    });
    const workInspection = work.policySurface?.promptInspection;
    const workItem = workInspection?.items.find((item) => item.entryId === "work-entry");
    expect(workInspection?.checkpoint).toBe("WORK");
    expect(workItem).toMatchObject({
      conditionResult: "false",
      outcome: { status: "skipped", reason: "condition_not_met" },
    });

    const mutation = await runtime.applyWorkspaceTransition({
      taskId: TASK_ID,
      transition: "pending",
      operation: "create_task",
      reservation: receiptReservation("create-after-work", "create_task"),
      workspace: workspaceContext(work.workspaceRevision, { title: "Created after WORK" }),
    });
    expect(mutation).toMatchObject({
      operationKey: "create-after-work",
      segmentId: "cognition-freeze-segment",
      logicalDispatch: 0,
      frameId: TURN_ID,
    });
    expect(getDb().query(
      "SELECT segment_id, logical_dispatch, frame_id FROM agent_work_workspace_receipts WHERE operation_key = ?",
    ).get("create-after-work")).toEqual({
      segment_id: "cognition-freeze-segment",
      logical_dispatch: 0,
      frame_id: TURN_ID,
    });
    const laterWorkInspection = mutation.cognition.policySurface?.promptInspection;
    expect(laterWorkInspection).toBe(workInspection);
    expect(laterWorkInspection?.items.find((item) => item.entryId === "work-entry")).toMatchObject({
      conditionResult: "false",
      outcome: { status: "skipped", reason: "condition_not_met" },
    });

    const prepareCommit = runtime.enterPhase({
      phase: "PREPARE_COMMIT",
      workspace: workspaceContext(mutation.workspaceRevision),
    });
    const prepareInspection = prepareCommit.policySurface?.promptInspection;
    const prepareWorkItem = prepareInspection?.items.find((item) => item.entryId === "work-entry");
    const prepareCompletionItem = prepareInspection?.items.find((item) => item.entryId === "completion-entry");
    expect(prepareInspection?.checkpoint).toBe("PREPARE_COMMIT");
    expect(prepareWorkItem).toEqual(workItem);
    expect(prepareWorkItem).toMatchObject({
      conditionResult: "false",
      outcome: { status: "skipped", reason: "condition_not_met" },
    });
    expect(prepareCompletionItem).toMatchObject({
      conditionResult: "true",
      outcome: { status: "included", reason: "selected" },
    });

    const render = runtime.enterPhase({
      phase: "RENDER",
      workspace: workspaceContext(prepareCommit.workspaceRevision),
    });
    const renderInspection = render.policySurface?.promptInspection;
    expect(renderInspection?.checkpoint).toBe("RENDER");
    expect(renderInspection?.items.find((item) => item.entryId === "work-entry")).toEqual(workItem);
    expect(renderInspection?.items.find((item) => item.entryId === "completion-entry")).toEqual(prepareCompletionItem);
    expect(renderInspection?.items.find((item) => item.entryId === "render-entry")).toMatchObject({
      conditionResult: "true",
      outcome: { status: "included", reason: "selected" },
    });
    expect(renderInspection?.effectiveEntryIds).toEqual(["completion-entry", "render-entry"]);
  });

  test("selects repeated block IDs independently by prompt-order occurrence", () => {
    const occurrenceZero = loomSource("shared-work-block", 0);
    const occurrenceOne = loomSource("shared-work-block", 1);
    const workPolicy = [
      { ...loomEntry("occurrence-zero", occurrenceZero, "root_work", "WORK"), condition: undefined },
      { ...loomEntry("occurrence-one", occurrenceOne, "root_work", "WORK"), condition: undefined },
    ].map(({ condition: _condition, ...entry }) => entry);
    const workspace = createTurnWorkspace({
      userId: USER_ID,
      chatId: CHAT_ID,
      turnId: TURN_ID,
      workspaceId: WORKSPACE_ID,
      objective: "Select exact Loom occurrences",
      constraints: [],
      retention: "operational",
      ttlSeconds: 100,
      quota: { maxTasks: 8, maxRecords: 8, maxSubmissions: 8, maxArtifacts: 4, maxBytes: 2048 },
      capabilities: {
        revision: 1,
        allowed: ["read_section", "read_page"],
        maxOperationBytes: 131_072,
        maxOperations: 128,
      },
    });
    const runtime = createAgentCognitionRuntime({
      source: {
        graph: {
          version: 1,
          policies: {
            workPolicy: [occurrenceZero, occurrenceOne].map((source) => ({
              blockId: source.blockId,
              expectedPresetRevision: source.presetRevision,
              expectedBlockRevision: source.blockRevision,
              promptOrder: source.promptOrder,
            })),
            workspaceUsage: [],
            completionCriteria: [],
            renderPolicy: [],
          },
          templates: [],
        },
        source: {
          presetRevision: 1,
          blocks: [
            { blockId: occurrenceZero.blockId, revision: 1, promptOrder: 0 },
            { blockId: occurrenceOne.blockId, revision: 1, promptOrder: 1 },
          ],
        },
        loomPolicy: { version: 1, workPolicy, workspaceUsage: [], completionCriteria: [], renderPolicy: [] },
        loomBlocks: [
          { source: occurrenceZero, content: "Occurrence zero runtime policy." },
          { source: occurrenceOne, content: "Occurrence one runtime policy." },
        ],
      },
      evaluation: {
        generationType: "normal",
        phase: "ASSEMBLE",
        presetVariables: {},
        participantFacts: {},
        availableTools: [],
        taskTransitions: {},
      },
      workspaceRevision: workspace.revision,
      workspace: workspaceContext(workspace.revision),
    });

    const work = runtime.enterPhase({ phase: "WORK", workspace: workspaceContext(runtime.initialActivation.workspaceRevision) });
    expect(work.promptBlocks.refs.map((ref) => [ref.blockId, ref.promptOrder])).toEqual([
      ["shared-work-block", 0],
      ["shared-work-block", 1],
    ]);
    expect(work.policySurface?.promptInspection?.effectiveEntryIds).toEqual(["occurrence-zero", "occurrence-one"]);
    expect(work.policySurface?.promptInspection?.items.map((item) => item.effectiveText)).toEqual([
      "Occurrence zero runtime policy.",
      "Occurrence one runtime policy.",
    ]);
  });

  test("discards later-checkpoint evidence from a blocked completion before task transition retry", async () => {
    const workspace = createTurnWorkspace({
      userId: USER_ID,
      chatId: CHAT_ID,
      turnId: TURN_ID,
      workspaceId: WORKSPACE_ID,
      objective: "Retry a blocked checkpoint from fresh task state",
      constraints: [],
      retention: "operational",
      ttlSeconds: 100,
      quota: { maxTasks: 8, maxRecords: 8, maxSubmissions: 8, maxArtifacts: 4, maxBytes: 2048 },
      capabilities: {
        revision: 1,
        allowed: ["read_section", "read_page", "submit_root_result"],
        maxOperationBytes: 131_072,
        maxOperations: 128,
      },
    });
    const workSource = loomSource("blocked-work-block", 0);
    const completionSource = loomSource("blocked-completion-block", 1);
    const renderSource = loomSource("blocked-render-block", 2);
    const sourceBlocks = [workSource, completionSource, renderSource];
    const runtime = createAgentCognitionRuntime({
      source: {
        graph: {
          version: 1,
          policies: { workPolicy: [], workspaceUsage: [], completionCriteria: [], renderPolicy: [] },
          templates: [{
            id: TASK_ID,
            label: "Required late task",
            description: "Must finish before completion can be accepted.",
            required: true,
            dependencies: [],
            activation: { kind: "phase", value: "WORK" },
          }],
        },
        source: {
          presetRevision: 1,
          blocks: sourceBlocks.map((source) => ({
            blockId: source.blockId,
            revision: source.blockRevision,
            promptOrder: source.promptOrder,
          })),
        },
        loomPolicy: {
          version: 1,
          workPolicy: [loomEntry("blocked-work-entry", workSource, "root_work", "WORK", "completed")],
          workspaceUsage: [],
          completionCriteria: [loomEntry("blocked-completion-entry", completionSource, "completion_handoff", "PREPARE_COMMIT", "completed")],
          renderPolicy: [loomEntry("blocked-render-entry", renderSource, "render", "RENDER", "completed")],
        },
        loomBlocks: sourceBlocks.map((source) => ({ source, content: source.blockId + " content" })),
      },
      evaluation: {
        generationType: "normal",
        phase: "ASSEMBLE",
        presetVariables: {},
        participantFacts: {},
        availableTools: [],
        taskTransitions: {},
      },
      workspaceRevision: workspace.revision,
      workspace: workspaceContext(workspace.revision),
    });

    const work = runtime.enterPhase({
      phase: "WORK",
      workspace: workspaceContext(runtime.initialActivation.workspaceRevision),
    });
    const workItem = work.policySurface?.promptInspection?.items.find((item) => item.entryId === "blocked-work-entry");
    expect(workItem).toMatchObject({
      conditionResult: "false",
      outcome: { status: "skipped", reason: "condition_not_met" },
    });

    const blocked = await runtime.acceptCompletionFixedPoint({
      workspace: workspaceContext(work.workspaceRevision),
    });
    expect(blocked.accepted).toBe(false);
    expect(blocked.policySurface?.promptInspection?.items.find((item) => item.entryId === "blocked-completion-entry")).toMatchObject({
      conditionResult: "false",
      outcome: { status: "skipped", reason: "condition_not_met" },
    });
    const blockedRender = blocked.preCommitActivations.find((activation) => activation.phase === "RENDER");
    expect(blockedRender?.policySurface?.promptInspection?.items.find((item) => item.entryId === "blocked-render-entry")).toMatchObject({
      conditionResult: "false",
      outcome: { status: "skipped", reason: "condition_not_met" },
    });

    const completedTask = await runtime.applyWorkspaceTransition({
      taskId: TASK_ID,
      transition: "completed",
      operation: "submit_root_result",
      reservation: receiptReservation("complete-required-task", "submit_root_result"),
      workspace: workspaceContext(blocked.workspaceRevision, {
        summary: "Required task completed after the blocked attempt",
        state: "completed",
      }),
    });
    expect(completedTask).toMatchObject({
      operationKey: "complete-required-task",
      segmentId: "cognition-freeze-segment",
      logicalDispatch: 0,
      frameId: TURN_ID,
    });
    expect(getDb().query(
      "SELECT segment_id, logical_dispatch, frame_id FROM agent_work_workspace_receipts WHERE operation_key = ?",
    ).get("complete-required-task")).toEqual({
      segment_id: "cognition-freeze-segment",
      logical_dispatch: 0,
      frame_id: TURN_ID,
    });
    expect(completedTask.cognition.policySurface?.promptInspection?.items.find((item) => item.entryId === "blocked-work-entry")).toEqual(workItem);

    const retry = await runtime.acceptCompletionFixedPoint({
      workspace: workspaceContext(completedTask.workspaceRevision),
    });
    expect(retry.accepted).toBe(true);
    expect(retry.policySurface?.promptInspection?.items.find((item) => item.entryId === "blocked-work-entry")).toEqual(workItem);
    expect(retry.policySurface?.promptInspection?.items.find((item) => item.entryId === "blocked-completion-entry")).toMatchObject({
      conditionResult: "true",
      outcome: { status: "included", reason: "selected" },
    });
    const retryRender = retry.preCommitActivations.find((activation) => activation.phase === "RENDER");
    expect(retryRender?.policySurface?.promptInspection?.items.find((item) => item.entryId === "blocked-render-entry")).toMatchObject({
      conditionResult: "true",
      outcome: { status: "included", reason: "selected" },
    });
  });
});
