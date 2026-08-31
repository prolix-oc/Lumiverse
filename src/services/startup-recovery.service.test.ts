import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import type { LlmProvider } from "../llm/provider";
import { getProvider, registerProvider } from "../llm/registry";
import type { GenerationRequest, GenerationResponse, StreamChunk } from "../llm/types";
import {
  reconcileStartupState,
  shutdownIsolatePools,
  summarizeIsolateHealth,
  type StartupRecoveryStage,
  type StartupRecoveryDependencies,
} from "./startup-recovery.service";
import type { AgenticReadinessVectorV1 } from "./turn-execution.service";
import {
  __testing as runtimeReadinessTesting,
  getAgenticReadiness,
  reconcileAgentTurns,
  registerAgentTurnReceiptRepair,
  setAgenticRuntimeReadiness,
  startAgentRuntimeEpoch,
} from "./turn-execution.service";
import { repairAgentRunProjectionFromReceipt } from "./agent-run-projection.service";
import {
  __testing as coordinatorTesting,
  installAgenticGenerationCoordinator,
  resumeQueuedWorkCompletionsAfterInstallV1,
  resumeQueuedWorkSegmentsAfterInstallV1,
} from "./agentic-generation-coordinator.service";
import {
  listQueuedWorkCompletionRecoveriesV1,
  reconcileWorkSegmentRecoveryAtStartupV1,
} from "./agentic-work-segment.repository";
import { removePoolEntry } from "./generation-pool.service";
import { probeIsolateBackendsAtStartup, type IsolateHealthSnapshotV1 } from "./isolate-pool";

const dbs: Database[] = [];
const STARTUP_COMPLETION_USER_ID = "startup-completion-user";
const STARTUP_COMPLETION_CHAT_ID = "startup-completion-chat";
const STARTUP_COMPLETION_CONNECTION_ID = "startup-completion-connection";
const STARTUP_COMPLETION_PRESET_ID = "startup-completion-preset";
const STARTUP_COMPLETION_PROVIDER_ID = "startup-completion-provider";
const startupCompletionProviderRequests: GenerationRequest[] = [];
let startupCompletionProviderBeforeStream: ((request: GenerationRequest) => void) | undefined;

class StartupCompletionProvider implements LlmProvider {
  readonly name = STARTUP_COMPLETION_PROVIDER_ID;
  readonly displayName = "Startup completion recovery provider";
  readonly defaultUrl = "https://startup-completion.invalid/v1";
  readonly capabilities = {
    parameters: {},
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: false,
    modelListStyle: "none" as const,
    toolCalling: true,
    requiredToolChoice: true,
    nativeToolContinuation: true,
    toolContinuationMode: "native" as const,
    toolsDisabledFinalization: true,
    supportsToolFinalization: true,
  };

  async generate(_key: string, _url: string, request: GenerationRequest): Promise<GenerationResponse> {
    startupCompletionProviderRequests.push(request);
    return { content: "startup recovered assistant", finish_reason: "stop" };
  }

  async *generateStream(
    _key: string,
    _url: string,
    request: GenerationRequest,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    startupCompletionProviderBeforeStream?.(request);
    if (request.signal?.aborted) throw request.signal.reason;
    startupCompletionProviderRequests.push(request);
    if (request.toolMode === "ordinary") {
      yield {
        token: "",
        tool_calls: [{
          name: "complete_turn",
          args: { summary: "durable work is complete", unresolvedIds: [] },
          call_id: "startup-completion-complete-turn",
        }],
        finish_reason: "tool_calls",
      };
      return;
    }
    yield { token: "startup recovered assistant" };
    yield {
      token: "",
      finish_reason: "stop",
      usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
    };
  }

  async validateKey(): Promise<boolean> { return true; }
  async listModels(): Promise<string[]> { return ["startup-completion-model"]; }
}

function seedStartupCompletionAuthorities(db: Database): void {
  const now = Date.now();
  db.query(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
  ).run(
    STARTUP_COMPLETION_USER_ID,
    "Startup Completion",
    "startup-completion@test.invalid",
    now,
    now,
  );
  db.query(
    "INSERT INTO characters (id, name, description, personality, scenario, first_mes, mes_example, creator, creator_notes, system_prompt, post_history_instructions, tags, alternate_greetings, extensions, created_at, updated_at, user_id) VALUES (?, ?, '', '', '', '', '', '', '', '', '', '[]', '[]', '{}', ?, ?, ?)",
  ).run("startup-completion-character", "Startup Completion Character", now, now, STARTUP_COMPLETION_USER_ID);
  db.query(
    "INSERT INTO connection_profiles (id, user_id, name, provider, api_url, model, is_default, has_api_key, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, '{}', ?, ?)",
  ).run(
    STARTUP_COMPLETION_CONNECTION_ID,
    STARTUP_COMPLETION_USER_ID,
    "Startup Completion",
    STARTUP_COMPLETION_PROVIDER_ID,
    "https://startup-completion.invalid/v1",
    "startup-completion-model",
    now,
    now,
  );
  db.query(
    "INSERT INTO chats (id, user_id, character_id, name, created_at, updated_at, metadata, generation_revision) VALUES (?, ?, ?, ?, ?, ?, '{}', 0)",
  ).run(
    STARTUP_COMPLETION_CHAT_ID,
    STARTUP_COMPLETION_USER_ID,
    "startup-completion-character",
    "Startup Completion Chat",
    now,
    now,
  );
  db.query(
    "INSERT INTO presets (id, user_id, name, provider, engine, parameters, prompt_order, prompts, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, 'classic', '{}', '[]', '{}', '{}', ?, ?)",
  ).run(
    STARTUP_COMPLETION_PRESET_ID,
    STARTUP_COMPLETION_USER_ID,
    "Startup Completion Preset",
    STARTUP_COMPLETION_PROVIDER_ID,
    now,
    now,
  );
  db.query(`
    INSERT INTO preset_agent_configs
      (user_id, preset_id, version, agents_enabled, allowed_modes, default_mode,
       max_invocations, max_tool_calls, main_tool_ids, main_lore_scope,
       phase_policy_json, cognition_policy_json, task_policy_json,
       workspace_policy_json, state, review_acknowledged, config_revision, binding_revision,
       created_at, updated_at)
    VALUES (?, ?, 2, 1, ?, 'agentic', 4, 4, '[]', 'active',
      '{}', '{}', '{}', '{}', 'ready', 1, 1, 1, ?, ?)
  `).run(
    STARTUP_COMPLETION_USER_ID,
    STARTUP_COMPLETION_PRESET_ID,
    JSON.stringify(["response", "agentic"]),
    now,
    now,
  );
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function readiness(overrides: Partial<AgenticReadinessVectorV1> = {}): AgenticReadinessVectorV1 {
  return {
    schema: true,
    reconciliation: true,
    archiveRegistry: true,
    isolateTermination: false,
    publicationStore: true,
    runtimeEpoch: 17,
    reason: "isolateTermination_unavailable",
    digest: "digest",
    ...overrides,
  };
}
function healthyImportRecovery() {
  return {
    inspected: 0,
    recovered: 0,
    deferred: 0,
    failed: 0,
    complete: true,
    healthy: true,
  };
}
function healthyWorkSegmentRecovery() {
  return {
    scanned: 0, active: 0, closed: 0, queued: 0, reclaimed: 0, fenced: 0, terminalized: 0,
    complete: true, healthy: true,
  };
}

function isolate(selected: IsolateHealthSnapshotV1["selected"]): IsolateHealthSnapshotV1 {
  return {
    epoch: 3,
    worker: selected === "worker" ? "healthy" : "unavailable",
    subprocess: selected === "subprocess" ? "healthy" : "unavailable",
    selected,
    workerReason: selected === "worker" ? null : "worker unavailable",
    subprocessReason: selected === "subprocess" ? null : "subprocess unavailable",
    checkedAt: Date.now(),
  };
}

async function captureConsoleErrors<T>(
  operation: () => Promise<T>,
): Promise<{ readonly result: T; readonly errors: readonly string[] }> {
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map((value) => String(value)).join(" "));
  };
  try {
    return { result: await operation(), errors };
  } finally {
    console.error = originalError;
  }
}
function healthyRecoveryDependencies(
  overrides: Partial<StartupRecoveryDependencies> = {},
): StartupRecoveryDependencies {
  return {
    startAgentRuntimeEpoch: () => 18,
    reconcileUserDataImports: () => healthyImportRecovery(),
    reconcileAgentArtifactBlobs: async () => ({
      inspected: 0,
      retained: 0,
      removed: 0,
      stale: 0,
      quarantined: 0,
      bytesRemoved: 0,
    }),
    reconcileAgentTurns: () => ({
      runtimeEpoch: 18,
      inspected: 0,
      claimed: 0,
      failedInterrupted: 0,
      committedFromReceipt: 0,
      commitFailedWithoutReceipt: 0,
      projectionRepairs: 0,
      alreadyTerminal: 0,
      releasedReservations: 0,
    }),
    reconcileWorkSegmentRecovery: () => ({
      scanned: 0,
      active: 0,
      closed: 0,
      queued: 0,
      reclaimed: 0,
      fenced: 0,
      terminalized: 0,
      complete: true,
      healthy: true,
    }),
    resumeQueuedWorkCompletions: async () => ({ resumed: 0, terminalized: 0, complete: true, healthy: true }),
    resumeQueuedWorkSegments: async () => ({ resumed: 0, terminalized: 0, complete: true, healthy: true }),
    reconcileAgentRunProjections: () => ({
      inspectedProjections: 0,
      removedProjections: 0,
      inspectedWorkspaces: 0,
      removedWorkspaces: 0,
      preservedChatLifetimeEntries: 0,
      failures: 0,
      healthy: true,
      complete: true,
    }),
    probeIsolateBackendsAtStartup: async () => isolate("worker"),
    setAgenticRuntimeReadiness: (patch) => readiness(patch),
    installAgenticGenerationCoordinator: () => {},
    ...overrides,
  };
}


describe("startup recovery sequencing", () => {
  test("settles every authority before probing isolate readiness", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const calls: string[] = [];
    const artifactResult = {
      inspected: 1,
      retained: 0,
      removed: 1,
      stale: 2,
      quarantined: 1,
      bytesRemoved: 8,
    } as const;
    const turnResult = {
      runtimeEpoch: 17,
      inspected: 1,
      claimed: 1,
      failedInterrupted: 1,
      committedFromReceipt: 0,
      commitFailedWithoutReceipt: 0,
      projectionRepairs: 0,
      alreadyTerminal: 0,
      releasedReservations: 1,
    } as const;
    const projectionResult = {
      inspectedProjections: 1,
      removedProjections: 0,
      inspectedWorkspaces: 1,
      removedWorkspaces: 0,
      preservedChatLifetimeEntries: 1,
      failures: 0,
      healthy: true,
      complete: true,
    } as const;
    const readinessPatches: Array<Partial<Record<"schema" | "reconciliation" | "archiveRegistry" | "isolateTermination" | "publicationStore", boolean>>> = [];
    const result = await reconcileStartupState(db, {
      startAgentRuntimeEpoch: () => {
        calls.push("epoch");
        return 17;
      },
      reconcileUserDataImports: () => {
        calls.push("imports");
        return healthyImportRecovery();
      },
      reconcilePurgeCleanupIntents: () => {
        calls.push("purge-intents");
      },
      reconcileAgentArtifactBlobs: async () => {
        calls.push("artifacts");
        return artifactResult;
      },
      reconcileWorkSegmentRecovery: () => healthyWorkSegmentRecovery(),
      reconcileAgentTurns: () => {
        calls.push("turns");
        return turnResult;
      },
      reconcileAgentRunProjections: () => {
        calls.push("projections");
        return projectionResult;
      },
      probeIsolateBackendsAtStartup: async () => {
        calls.push("probe");
        return isolate("unavailable");
      },
      setAgenticRuntimeReadiness: (patch) => {
        calls.push("readiness");
        readinessPatches.push(patch);
        return readiness({ isolateTermination: patch.isolateTermination === true });
      },
      installAgenticGenerationCoordinator: () => {
        calls.push("install");
      },
    });

    expect(calls).toEqual(["epoch", "imports", "purge-intents", "artifacts", "turns", "projections", "probe", "readiness", "install"]);
    expect(result.runtimeEpoch).toBe(17);
    expect(result.imports).toEqual(healthyImportRecovery());
    expect(result.artifacts).toEqual(artifactResult);
    expect(result.turns).toEqual(turnResult);
    expect(result.readiness).toMatchObject({
      archiveRegistry: true,
      reconciliation: true,
      publicationStore: true,
      isolateTermination: false,
    });
    expect(result.stages).toEqual({
      imports: { ok: true, status: "completed", errorCode: null },
      artifacts: { ok: true, status: "completed", errorCode: null },
      turns: { ok: true, status: "completed", errorCode: null },
      projections: { ok: true, status: "completed", errorCode: null },
      isolate: { ok: false, status: "failed", errorCode: "unhealthy" },
      readiness: { ok: true, status: "completed", errorCode: null },
      coordinator: { ok: true, status: "completed", errorCode: null },
    });
    const observedReadinessPatch = readinessPatches[0];
    if (!observedReadinessPatch) throw new Error("startup readiness callback was not invoked");
    expect(observedReadinessPatch).toEqual({
      schema: true,
      archiveRegistry: true,
      reconciliation: true,
      publicationStore: true,
      isolateTermination: false,
    });
    expect(summarizeIsolateHealth(result.isolate)).toBe("worker unavailable");
  });
  test("installs the coordinator before draining admitted undispatched WORK and only then reconciles turns", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const calls: string[] = [];
    await reconcileStartupState(db, healthyRecoveryDependencies({
      startAgentRuntimeEpoch: () => 23,
      reconcileWorkSegmentRecovery: () => ({
        scanned: 1,
        active: 1,
        closed: 0,
        queued: 1,
        reclaimed: 0,
        fenced: 0,
        terminalized: 0,
        complete: true,
        healthy: true,
      }),
      reconcileAgentTurns: () => {
        calls.push("turns");
        return {
          runtimeEpoch: 23,
          inspected: 1,
          claimed: 1,
          failedInterrupted: 0,
          committedFromReceipt: 0,
          commitFailedWithoutReceipt: 0,
          projectionRepairs: 0,
          alreadyTerminal: 1,
          releasedReservations: 0,
        };
      },
      installAgenticGenerationCoordinator: () => { calls.push("install"); },
      resumeQueuedWorkCompletions: async (runtimeEpoch) => {
        expect(runtimeEpoch).toBe(23);
        calls.push("completion");
        return { resumed: 1, terminalized: 0, complete: true, healthy: true };
      },
      resumeQueuedWorkSegments: async (runtimeEpoch) => {
        expect(runtimeEpoch).toBe(23);
        calls.push("resume");
        return { resumed: 1, terminalized: 0, complete: true, healthy: true };
      },
    }));
    expect(calls).toEqual(["install", "completion", "resume", "turns"]);
  });
  test("drains a real closed WORK completion exactly once before generic convergence", async () => {
    const previousRuntimeMode = process.env.LUMIVERSE_AGENTIC_RUNTIME;
    const executionId = "startup-closed-completion-execution";
    const activeTimeoutExecutionId = "startup-active-timeout-execution";
    let releaseSeedRuntime: (() => void) | undefined;

    closeDatabase();
    coordinatorTesting.resetInstallation();
    initDatabase(":memory:");
    const db = getDb();
    try {
      db.run("PRAGMA foreign_keys = OFF");
      await runMigrations(db);
      seedStartupCompletionAuthorities(db);
      if (!getProvider(STARTUP_COMPLETION_PROVIDER_ID)) {
        registerProvider(new StartupCompletionProvider());
      }
      process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
      await probeIsolateBackendsAtStartup();
      startAgentRuntimeEpoch();
      setAgenticRuntimeReadiness({
        schema: true,
        reconciliation: true,
        archiveRegistry: true,
        publicationStore: true,
        isolateTermination: true,
      });
      installAgenticGenerationCoordinator();

      const seedDependencies = coordinatorTesting.buildDependencies();
      const signal = new AbortController().signal;
      const input = {
        userId: STARTUP_COMPLETION_USER_ID,
        chatId: STARTUP_COMPLETION_CHAT_ID,
        connectionId: STARTUP_COMPLETION_CONNECTION_ID,
        presetId: STARTUP_COMPLETION_PRESET_ID,
        generationType: "normal" as const,
        userInput: "Persist this completion across restart.",
        parameters: { max_tokens: 128 },
      };
      const target = { generationType: "normal" as const };
      const decision = await seedDependencies.resolveRuntime!(input, target, signal);
      const snapshot = await seedDependencies.buildAssemblySnapshot!(
        input,
        decision,
        target,
        signal,
        executionId,
      );
      const plan = await seedDependencies.compileAssemblyPlan!(
        snapshot,
        input,
        decision,
        signal,
        executionId,
      );
      let execution = await seedDependencies.createExecution!({
        executionId,
        userId: STARTUP_COMPLETION_USER_ID,
        chatId: STARTUP_COMPLETION_CHAT_ID,
        target,
        decision,
        signal,
        deadlineAt: Date.now() + 120_000,
      });
      const workExecution = await seedDependencies.transitionExecution!(execution, "ASSEMBLE", "WORK");
      if (!workExecution) throw new Error("WORK execution was not persisted");
      execution = workExecution;
      releaseSeedRuntime = () => seedDependencies.cleanup?.({ execution } as never);
      const work = await seedDependencies.runWork!({
        execution,
        input,
        decision,
        snapshot,
        plan,
        signal,
      });
      expect(work.status).toBe("completed");

      const closedAuthority = db.query(`
        SELECT e.state AS execution_state,
               r.state AS recovery_state,
               r.current_segment_id,
               t.transition_kind,
               s.lifecycle AS segment_lifecycle,
               s.close_result AS segment_close_result,
               s.close_reason AS segment_close_reason
          FROM agent_turn_executions AS e
          JOIN agent_work_segment_recovery AS r
            ON r.user_id = e.user_id AND r.execution_id = e.id
          JOIN agent_work_segment_transitions AS t
            ON t.user_id = r.user_id AND t.execution_id = r.execution_id
          JOIN agent_work_segments AS s
            ON s.user_id = t.user_id AND s.execution_id = t.execution_id
           AND s.segment_id = t.source_segment_id
         WHERE e.user_id = ? AND e.id = ?
         ORDER BY t.created_at DESC, t.transition_id DESC
         LIMIT 1
      `).get(STARTUP_COMPLETION_USER_ID, executionId);
      expect(closedAuthority).toEqual({
        execution_state: "WORK",
        recovery_state: "closed",
        current_segment_id: null,
        transition_kind: "terminal",
        segment_lifecycle: "closed",
        segment_close_result: "work_complete",
        segment_close_reason: "transition:terminal",
      });
      const ownerBeforeReclaim = db.query(
        "SELECT runtime_epoch, cas_owner, cas_revision FROM agent_turn_executions WHERE user_id = ? AND id = ?",
      ).get(STARTUP_COMPLETION_USER_ID, executionId) as {
        runtime_epoch: number;
        cas_owner: string;
        cas_revision: number;
      };

      releaseSeedRuntime();
      releaseSeedRuntime = undefined;
      removePoolEntry(executionId);
      coordinatorTesting.resetInstallation();
      db.run(`
        CREATE TABLE startup_completion_phase_log (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          execution_id TEXT NOT NULL,
          old_state TEXT NOT NULL,
          new_state TEXT NOT NULL
        )
      `);
      db.run(`
        CREATE TRIGGER startup_completion_phase_transition
        AFTER UPDATE OF state ON agent_turn_executions
        WHEN OLD.state <> NEW.state
        BEGIN
          INSERT INTO startup_completion_phase_log (execution_id, old_state, new_state)
          VALUES (NEW.id, OLD.state, NEW.state);
        END
      `);

      const recoveryEpoch = startAgentRuntimeEpoch();
      expect(ownerBeforeReclaim.runtime_epoch).not.toBe(recoveryEpoch);
      const reclaimed = reconcileWorkSegmentRecoveryAtStartupV1(db, recoveryEpoch, 1);
      expect(reclaimed).toMatchObject({
        scanned: 1,
        queued: 1,
        terminalized: 0,
        complete: true,
        healthy: true,
      });
      const ownerAfterReclaim = db.query(
        "SELECT runtime_epoch, cas_owner, cas_revision FROM agent_turn_executions WHERE user_id = ? AND id = ?",
      ).get(STARTUP_COMPLETION_USER_ID, executionId) as {
        runtime_epoch: number;
        cas_owner: string;
        cas_revision: number;
      };
      expect(ownerAfterReclaim.runtime_epoch).toBe(recoveryEpoch);
      expect(ownerAfterReclaim.cas_owner).toStartWith("wso_");
      expect(ownerAfterReclaim.cas_owner).not.toBe(ownerBeforeReclaim.cas_owner);
      expect(ownerAfterReclaim.cas_revision).toBe(ownerBeforeReclaim.cas_revision + 1);
      expect(reconcileWorkSegmentRecoveryAtStartupV1(db, recoveryEpoch, 1)).toMatchObject({
        scanned: 0,
        queued: 0,
        terminalized: 0,
        complete: true,
        healthy: true,
      });
      expect(listQueuedWorkCompletionRecoveriesV1(recoveryEpoch, db, 1)).toHaveLength(1);

      startupCompletionProviderRequests.length = 0;
      installAgenticGenerationCoordinator();
      const firstDrain = await resumeQueuedWorkCompletionsAfterInstallV1(recoveryEpoch);
      expect(firstDrain).toEqual({
        resumed: 1,
        terminalized: 0,
        complete: true,
        healthy: true,
      });
      registerAgentTurnReceiptRepair((executionRecord, receipt, options) => {
        repairAgentRunProjectionFromReceipt(db, executionRecord, receipt, options);
      });
      const convergence = reconcileAgentTurns(db);
      expect(convergence).toMatchObject({
        inspected: 1,
        claimed: 0,
        failedInterrupted: 0,
        alreadyTerminal: 1,
        complete: true,
      });

      const phaseTransitions = db.query(
        "SELECT old_state, new_state FROM startup_completion_phase_log WHERE execution_id = ? ORDER BY sequence",
      ).all(executionId);
      expect(phaseTransitions).toEqual([
        { old_state: "WORK", new_state: "COMPLETE" },
        { old_state: "COMPLETE", new_state: "RENDER" },
        { old_state: "RENDER", new_state: "PREPARE_COMMIT" },
        { old_state: "PREPARE_COMMIT", new_state: "COMMITTING" },
        { old_state: "COMMITTING", new_state: "COMMITTED" },
      ]);
      expect(startupCompletionProviderRequests).toHaveLength(1);
      expect(startupCompletionProviderRequests[0]?.toolMode).toBe("finalization");

      const committed = db.query(
        "SELECT state, final_render_request_count, final_render_reservations_json FROM agent_turn_executions WHERE user_id = ? AND id = ?",
      ).get(STARTUP_COMPLETION_USER_ID, executionId) as {
        state: string;
        final_render_request_count: number;
        final_render_reservations_json: string;
      };
      expect(committed.state).toBe("COMMITTED");
      expect(committed.final_render_request_count).toBe(1);
      expect(JSON.parse(committed.final_render_reservations_json)).toEqual([]);
      expect((db.query(
        "SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE user_id = ? AND execution_id = ?",
      ).get(STARTUP_COMPLETION_USER_ID, executionId) as { count: number }).count).toBe(1);
      expect(db.query(
        "SELECT content FROM messages WHERE chat_id = ? AND is_user = 0 ORDER BY index_in_chat",
      ).all(STARTUP_COMPLETION_CHAT_ID)).toEqual([{ content: "startup recovered assistant" }]);
      expect((db.query(`
        SELECT COUNT(*) AS count
          FROM agent_work_segments
         WHERE user_id = ? AND execution_id = ? AND lifecycle IN ('admitted', 'running')
      `).get(STARTUP_COMPLETION_USER_ID, executionId) as { count: number }).count).toBe(0);
      expect(db.query(
        "SELECT state, current_segment_id FROM agent_work_segment_recovery WHERE user_id = ? AND execution_id = ?",
      ).get(STARTUP_COMPLETION_USER_ID, executionId)).toEqual({
        state: "closed",
        current_segment_id: null,
      });

      const secondDrain = await resumeQueuedWorkCompletionsAfterInstallV1(recoveryEpoch);
      expect(secondDrain).toEqual({
        resumed: 0,
        terminalized: 0,
        complete: true,
        healthy: true,
      });
      expect(startupCompletionProviderRequests).toHaveLength(1);
      expect(db.query(
        "SELECT old_state, new_state FROM startup_completion_phase_log WHERE execution_id = ? ORDER BY sequence",
      ).all(executionId)).toEqual(phaseTransitions);
      expect((db.query(
        "SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE user_id = ? AND execution_id = ?",
      ).get(STARTUP_COMPLETION_USER_ID, executionId) as { count: number }).count).toBe(1);
      expect((db.query(
        "SELECT COUNT(*) AS count FROM messages WHERE chat_id = ? AND is_user = 0",
      ).get(STARTUP_COMPLETION_CHAT_ID) as { count: number }).count).toBe(1);

      const timeoutExecutionId = "startup-closed-completion-timeout";
      const timeoutDeadlineAt = Date.now() + 120_000;
      const timeoutDecision = await seedDependencies.resolveRuntime!(input, target, signal);
      const timeoutSnapshot = await seedDependencies.buildAssemblySnapshot!(
        input, timeoutDecision, target, signal, timeoutExecutionId,
      );
      const timeoutPlan = await seedDependencies.compileAssemblyPlan!(
        timeoutSnapshot, input, timeoutDecision, signal, timeoutExecutionId,
      );
      let timeoutExecution = await seedDependencies.createExecution!({
        executionId: timeoutExecutionId,
        userId: STARTUP_COMPLETION_USER_ID,
        chatId: STARTUP_COMPLETION_CHAT_ID,
        target,
        decision: timeoutDecision,
        signal,
        deadlineAt: timeoutDeadlineAt,
      });
      const timeoutWorkExecution = await seedDependencies.transitionExecution!(
        timeoutExecution, "ASSEMBLE", "WORK",
      );
      if (!timeoutWorkExecution) throw new Error("timeout WORK execution was not persisted");
      timeoutExecution = timeoutWorkExecution;
      const timeoutWork = await seedDependencies.runWork!({
        execution: timeoutExecution,
        input,
        decision: timeoutDecision,
        snapshot: timeoutSnapshot,
        plan: timeoutPlan,
        signal,
      });
      expect(timeoutWork.status).toBe("completed");
      seedDependencies.cleanup?.({ execution: timeoutExecution } as never);
      removePoolEntry(timeoutExecutionId);
      coordinatorTesting.resetInstallation();

      startupCompletionProviderRequests.length = 0;
      const timeoutMarkerSnapshots: Array<{ cancel_requested_at: number | null; deadline_at: number }> = [];
      const timeoutScheduler = {
        setTimeout(callback: () => void) {
          queueMicrotask(() => {
            callback();
            timeoutMarkerSnapshots.push(db.query(
              "SELECT cancel_requested_at, deadline_at FROM agent_turn_executions WHERE user_id = ? AND id = ?",
            ).get(STARTUP_COMPLETION_USER_ID, timeoutExecutionId) as {
              cancel_requested_at: number | null;
              deadline_at: number;
            });
          });
          return 1;
        },
        clearTimeout() {},
      } as never;
      const timeoutRecoveryEpoch = startAgentRuntimeEpoch();
      expect(reconcileWorkSegmentRecoveryAtStartupV1(db, timeoutRecoveryEpoch, 1)).toMatchObject({
        scanned: 1, queued: 1, terminalized: 0, complete: true, healthy: true,
      });
      installAgenticGenerationCoordinator();
      expect(await resumeQueuedWorkCompletionsAfterInstallV1(timeoutRecoveryEpoch, { timeoutScheduler })).toEqual({
        resumed: 0, terminalized: 1, complete: true, healthy: true,
      });
      expect(timeoutMarkerSnapshots).toEqual([{
        cancel_requested_at: timeoutDeadlineAt, deadline_at: timeoutDeadlineAt,
      }]);
      expect(db.query(
        "SELECT state, terminal_code FROM agent_turn_executions WHERE user_id = ? AND id = ?",
      ).get(STARTUP_COMPLETION_USER_ID, timeoutExecutionId)).toEqual({
        state: "TIMED_OUT", terminal_code: "root_wall_clock_limit_exceeded",
      });
      expect(db.query(
        "SELECT old_state, new_state FROM startup_completion_phase_log WHERE execution_id = ? ORDER BY sequence",
      ).all(timeoutExecutionId)).toEqual([
        { old_state: "ASSEMBLE", new_state: "WORK" },
        { old_state: "WORK", new_state: "TIMED_OUT" },
      ]);
      expect(startupCompletionProviderRequests).toHaveLength(0);
      expect((db.query(
        "SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE user_id = ? AND execution_id = ?",
      ).get(STARTUP_COMPLETION_USER_ID, timeoutExecutionId) as { count: number }).count).toBe(0);
      expect(await resumeQueuedWorkCompletionsAfterInstallV1(timeoutRecoveryEpoch)).toEqual({
        resumed: 0, terminalized: 0, complete: true, healthy: true,
      });
      expect(reconcileAgentTurns(db)).toMatchObject({ claimed: 0, failedInterrupted: 0 });
      coordinatorTesting.resetInstallation();
      startAgentRuntimeEpoch();
      installAgenticGenerationCoordinator();
      const activeSeedDependencies = coordinatorTesting.buildDependencies();
      const activeSignal = new AbortController().signal;
      const activeDeadlineAt = Date.now() + 120_000;
      const activeDecision = await activeSeedDependencies.resolveRuntime!(input, target, activeSignal);
      const activeSnapshot = await activeSeedDependencies.buildAssemblySnapshot!(
        input, activeDecision, target, activeSignal, activeTimeoutExecutionId,
      );
      const activePlan = await activeSeedDependencies.compileAssemblyPlan!(
        activeSnapshot, input, activeDecision, activeSignal, activeTimeoutExecutionId,
      );
      let activeExecution = await activeSeedDependencies.createExecution!({
        executionId: activeTimeoutExecutionId,
        userId: STARTUP_COMPLETION_USER_ID,
        chatId: STARTUP_COMPLETION_CHAT_ID,
        target,
        decision: activeDecision,
        signal: activeSignal,
        deadlineAt: activeDeadlineAt,
      });
      const activeWorkExecution = await activeSeedDependencies.transitionExecution!(
        activeExecution, "ASSEMBLE", "WORK",
      );
      if (!activeWorkExecution) throw new Error("active timeout WORK execution was not persisted");
      activeExecution = activeWorkExecution;
      releaseSeedRuntime = () => activeSeedDependencies.cleanup?.({ execution: activeExecution } as never);
      expect((await activeSeedDependencies.runWork!({
        execution: activeExecution,
        input,
        decision: activeDecision,
        snapshot: activeSnapshot,
        plan: activePlan,
        signal: activeSignal,
      })).status).toBe("completed");

      const activeSegment = db.query(
        "SELECT segment_id, phase_id, phase_index, phase_occurrence, workspace_revision FROM agent_work_segments WHERE user_id = ? AND execution_id = ?",
      ).get(STARTUP_COMPLETION_USER_ID, activeTimeoutExecutionId) as {
        segment_id: string; phase_id: string; phase_index: number; phase_occurrence: number; workspace_revision: number;
      };
      const activeWorkspaceAuthority = db.query(
        "SELECT r.workspace_id AS turn_workspace_id, json_extract(r.resume_envelope_json, '$.runtime.workspaceRevision') AS admission_revision, s.workspace_id AS persistent_workspace_id, p.revision AS persistent_revision FROM agent_work_segment_recovery AS r JOIN persistent_workspace_turn_sessions AS s ON s.user_id = r.user_id AND s.execution_id = r.execution_id JOIN persistent_workspaces AS p ON p.user_id = s.user_id AND p.workspace_id = s.workspace_id WHERE r.user_id = ? AND r.execution_id = ?",
      ).get(STARTUP_COMPLETION_USER_ID, activeTimeoutExecutionId) as {
        turn_workspace_id: string; admission_revision: number; persistent_workspace_id: string; persistent_revision: number;
      };
      expect(activeWorkspaceAuthority.persistent_workspace_id).not.toBe(activeWorkspaceAuthority.turn_workspace_id);
      const advancedTurnWorkspaceRevision = activeWorkspaceAuthority.admission_revision + 1;
      db.transaction(() => {
        db.query("DELETE FROM agent_work_segment_dispatches WHERE user_id = ? AND execution_id = ?").run(
          STARTUP_COMPLETION_USER_ID, activeTimeoutExecutionId,
        );
        db.query("DELETE FROM agent_work_segment_transitions WHERE user_id = ? AND execution_id = ?").run(
          STARTUP_COMPLETION_USER_ID, activeTimeoutExecutionId,
        );
        db.query(
          "UPDATE agent_work_segments SET lifecycle = 'admitted', boundary_class = NULL, close_result = NULL, close_reason = NULL, closed_workspace_revision = NULL, closed_execution_cas_revision = NULL, closure_digest = NULL, closed_at = NULL, provider_dispatches = 0, provider_input_tokens = 0, provider_output_tokens = 0, provider_total_tokens = 0, billed_output_tokens = 0, tool_calls = 0, workspace_operations = 0, unsigned_boundaries = 0, receive_bytes = 0, published_output_bytes = 0 WHERE user_id = ? AND execution_id = ? AND segment_id = ?",
        ).run(STARTUP_COMPLETION_USER_ID, activeTimeoutExecutionId, activeSegment.segment_id);
        db.query(
          "UPDATE agent_work_segment_recovery SET state = 'active', phase_id = ?, phase_index = ?, phase_occurrence = ?, current_segment_id = ?, next_segment_ordinal = 0, terminal_close_result = NULL, terminal_close_reason = NULL, terminal_boundary_class = NULL, provider_dispatches = 0, provider_input_tokens = 0, provider_output_tokens = 0, provider_total_tokens = 0, billed_output_tokens = 0, tool_calls = 0, workspace_operations = 0, unsigned_boundaries = 0, receive_bytes = 0, published_output_bytes = 0 WHERE user_id = ? AND execution_id = ?",
        ).run(
          activeSegment.phase_id, activeSegment.phase_index, activeSegment.phase_occurrence,
          activeSegment.segment_id, STARTUP_COMPLETION_USER_ID, activeTimeoutExecutionId,
        );
        db.query("UPDATE agent_turn_workspaces SET revision = ? WHERE user_id = ? AND execution_id = ? AND workspace_id = ?").run(
          advancedTurnWorkspaceRevision, STARTUP_COMPLETION_USER_ID, activeTimeoutExecutionId,
          activeWorkspaceAuthority.turn_workspace_id,
        );
        db.query("UPDATE agent_turn_executions SET workspace_revision = ? WHERE user_id = ? AND id = ? AND state = 'WORK'").run(
          advancedTurnWorkspaceRevision, STARTUP_COMPLETION_USER_ID, activeTimeoutExecutionId,
        );
        db.query("UPDATE agent_work_segments SET workspace_revision = ? WHERE user_id = ? AND execution_id = ? AND segment_id = ?").run(
          advancedTurnWorkspaceRevision, STARTUP_COMPLETION_USER_ID, activeTimeoutExecutionId, activeSegment.segment_id,
        );
        db.query("UPDATE agent_work_segment_recovery SET workspace_revision = ? WHERE user_id = ? AND execution_id = ?").run(
          advancedTurnWorkspaceRevision, STARTUP_COMPLETION_USER_ID, activeTimeoutExecutionId,
        );

      })();
      releaseSeedRuntime();
      releaseSeedRuntime = undefined;
      removePoolEntry(activeTimeoutExecutionId);
      coordinatorTesting.resetInstallation();
      startupCompletionProviderRequests.length = 0;
      const activeMarkerSnapshots: Array<{ cancel_requested_at: number | null; deadline_at: number }> = [];
      let fireActiveTimeout: (() => void) | undefined;
      const activeTimeoutScheduler = {
        setTimeout(callback: () => void) { fireActiveTimeout = callback; return 1; },
        clearTimeout() {},
      } as never;
      startupCompletionProviderBeforeStream = () => {
        const callback = fireActiveTimeout;
        fireActiveTimeout = undefined;
        callback?.();
        activeMarkerSnapshots.push(db.query(
          "SELECT cancel_requested_at, deadline_at FROM agent_turn_executions WHERE user_id = ? AND id = ?",
        ).get(STARTUP_COMPLETION_USER_ID, activeTimeoutExecutionId) as {
          cancel_requested_at: number | null;
          deadline_at: number;
        });
      };
      const activeRecoveryEpoch = startAgentRuntimeEpoch();
      expect(reconcileWorkSegmentRecoveryAtStartupV1(db, activeRecoveryEpoch, 1)).toMatchObject({
        scanned: 1, queued: 1, terminalized: 0, complete: true, healthy: true,
      });
      installAgenticGenerationCoordinator();
      const reachedActiveDeadline = spyOn(Date, "now").mockReturnValue(activeDeadlineAt);
      try {
        expect(await resumeQueuedWorkSegmentsAfterInstallV1(activeRecoveryEpoch, {
          timeoutScheduler: activeTimeoutScheduler,
        })).toEqual({ resumed: 0, terminalized: 1, complete: true, healthy: true });
      } finally {
        reachedActiveDeadline.mockRestore();
      }
      expect(activeMarkerSnapshots).toEqual([]);
      expect(db.query(
        "SELECT state, terminal_code, cancel_requested_at, deadline_at FROM agent_turn_executions WHERE user_id = ? AND id = ?",
      ).get(STARTUP_COMPLETION_USER_ID, activeTimeoutExecutionId)).toEqual({
        state: "TIMED_OUT",
        terminal_code: "root_wall_clock_limit_exceeded",
        cancel_requested_at: activeDeadlineAt,
        deadline_at: activeDeadlineAt,
      });
      expect(db.query("SELECT revision FROM persistent_workspaces WHERE user_id = ? AND workspace_id = ?")
        .get(STARTUP_COMPLETION_USER_ID, activeWorkspaceAuthority.persistent_workspace_id)).toEqual({
          revision: activeWorkspaceAuthority.persistent_revision,
        });
      expect(db.query(
        "SELECT e.workspace_revision AS execution_revision, r.workspace_revision AS recovery_revision, w.revision AS workspace_revision FROM agent_turn_executions AS e JOIN agent_work_segment_recovery AS r ON r.user_id = e.user_id AND r.execution_id = e.id JOIN agent_turn_workspaces AS w ON w.user_id = e.user_id AND w.execution_id = e.id AND w.workspace_id = r.workspace_id WHERE e.user_id = ? AND e.id = ?",
      ).get(STARTUP_COMPLETION_USER_ID, activeTimeoutExecutionId)).toEqual({
        execution_revision: advancedTurnWorkspaceRevision,
        recovery_revision: advancedTurnWorkspaceRevision,
        workspace_revision: advancedTurnWorkspaceRevision,
      });
      const activeAttempt = db.query(
        "SELECT attempt_id FROM agent_run_attempts WHERE user_id = ? AND turn_id = ? ORDER BY created_at DESC, attempt_id DESC LIMIT 1",
      ).get(STARTUP_COMPLETION_USER_ID, activeExecution.id) as { attempt_id: string } | null;
      if (!activeAttempt) throw new Error("active timeout WORK attempt inspection was not persisted");
      const recoveredWorkspaceAssociations = db.query(
        "SELECT workspace_id, workspace_revision FROM agent_run_workspace_associations WHERE user_id = ? AND attempt_id = ? ORDER BY association_id",
      ).all(STARTUP_COMPLETION_USER_ID, activeAttempt.attempt_id) as Array<{
        workspace_id: string; workspace_revision: number;
      }>;
      expect(recoveredWorkspaceAssociations.length).toBeGreaterThan(0);
      expect(recoveredWorkspaceAssociations.every((association) =>
        association.workspace_id === activeWorkspaceAuthority.persistent_workspace_id
        && association.workspace_revision === activeWorkspaceAuthority.persistent_revision)).toBe(true);
      expect(db.query(
        "SELECT lifecycle, close_result, close_reason FROM agent_work_segments WHERE user_id = ? AND execution_id = ?",
      ).get(STARTUP_COMPLETION_USER_ID, activeTimeoutExecutionId)).toEqual({
        lifecycle: "failed", close_result: "failed", close_reason: "root_wall_clock_limit_exceeded",
      });
      expect(startupCompletionProviderRequests).toHaveLength(0);
      expect((db.query(
        "SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE user_id = ? AND execution_id = ?",
      ).get(STARTUP_COMPLETION_USER_ID, activeTimeoutExecutionId) as { count: number }).count).toBe(0);
      expect(await resumeQueuedWorkSegmentsAfterInstallV1(activeRecoveryEpoch)).toEqual({
        resumed: 0, terminalized: 0, complete: true, healthy: true,
      });
    } finally {
      releaseSeedRuntime?.();
      removePoolEntry(executionId);
      removePoolEntry(activeTimeoutExecutionId);
      startupCompletionProviderRequests.length = 0;
      startupCompletionProviderBeforeStream = undefined;
      registerAgentTurnReceiptRepair(null);
      coordinatorTesting.resetInstallation();
      runtimeReadinessTesting.resetReadiness();
      closeDatabase();
      if (previousRuntimeMode === undefined) delete process.env.LUMIVERSE_AGENTIC_RUNTIME;
      else process.env.LUMIVERSE_AGENTIC_RUNTIME = previousRuntimeMode;
    }
  });
  test("serially drains a 1025-row WORK backlog and keeps readiness closed until generic turn convergence", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const scheduled: Array<{ readonly task: () => Promise<void>; readonly delayMs: number }> = [];
    const readinessPatches: Array<Partial<AgenticReadinessVectorV1>> = [];
    const calls: string[] = [];
    let workRecoveryAttempt = 0;
    let resumeAttempt = 0;
    let turnAttempt = 0;
    let activeResumes = 0;
    let maxActiveResumes = 0;
    const turnResult = (complete: boolean) => ({
      runtimeEpoch: 31,
      inspected: 1,
      claimed: 1,
      failedInterrupted: 0,
      committedFromReceipt: 0,
      commitFailedWithoutReceipt: 0,
      projectionRepairs: 0,
      alreadyTerminal: 0,
      releasedReservations: 0,
      complete,
    });

    const result = await reconcileStartupState(db, healthyRecoveryDependencies({
      startAgentRuntimeEpoch: () => 31,
      reconcileWorkSegmentRecovery: () => {
        workRecoveryAttempt += 1;
        const queued = workRecoveryAttempt === 1 ? 1_025 : workRecoveryAttempt === 2 ? 1 : 0;
        calls.push(`work:${queued}`);
        return { ...healthyWorkSegmentRecovery(), scanned: queued, active: queued, queued };
      },
      resumeQueuedWorkSegments: async () => {
        resumeAttempt += 1;
        activeResumes += 1;
        maxActiveResumes = Math.max(maxActiveResumes, activeResumes);
        calls.push(`resume:${resumeAttempt}`);
        await Promise.resolve();
        activeResumes -= 1;
        return {
          resumed: resumeAttempt === 1 ? 1_024 : 1,
          terminalized: 0,
          healthy: true,
          complete: resumeAttempt > 1,
        };
      },
      reconcileAgentTurns: () => {
        turnAttempt += 1;
        calls.push(`turns:${turnAttempt}`);
        return turnResult(turnAttempt > 1);
      },
      setAgenticRuntimeReadiness: (patch) => {
        readinessPatches.push(patch);
        return readiness({ ...patch, runtimeEpoch: 31 });
      },
      scheduleReconciliationContinuation: (task, delayMs) => {
        scheduled.push({ task, delayMs });
        return { cancel: () => {} };
      },
    }));

    expect(result.readiness.reconciliation).toBe(false);
    expect(resumeAttempt).toBe(1);
    const first = scheduled.shift();
    if (first === undefined) throw new Error("first WORK continuation was not scheduled");
    expect(first.delayMs).toBe(25);
    await Promise.all([first.task(), first.task()]);
    expect(maxActiveResumes).toBe(1);
    expect(turnAttempt).toBe(1);
    expect(readinessPatches.at(-1)).toMatchObject({ reconciliation: false });

    const second = scheduled.shift();
    if (second === undefined) throw new Error("second WORK continuation was not scheduled");
    expect(second.delayMs).toBe(50);
    await second.task();
    expect(maxActiveResumes).toBe(1);
    expect(turnAttempt).toBe(2);
    expect(readinessPatches.at(-1)).toMatchObject({ reconciliation: true });
    expect(scheduled).toHaveLength(0);
    expect(calls).toEqual([
      "work:1025",
      "resume:1",
      "work:1",
      "resume:2",
      "turns:1",
      "work:0",
      "resume:3",
      "turns:2",
    ]);
  });
  test("keeps exactly 1024 healthy queued rows pending for the empty-page proof", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const scheduled: Array<() => Promise<void>> = [];
    let genericTurns = 0;
    const result = await reconcileStartupState(db, healthyRecoveryDependencies({
      startAgentRuntimeEpoch: () => 41,
      reconcileWorkSegmentRecovery: () => ({
        ...healthyWorkSegmentRecovery(),
        scanned: 1_024,
        active: 1_024,
        queued: 1_024,
      }),
      resumeQueuedWorkSegments: async () => ({
        resumed: 1_024,
        terminalized: 0,
        complete: false,
        healthy: true,
      }),
      reconcileAgentTurns: () => {
        genericTurns += 1;
        return { ...healthyRecoveryDependencies().reconcileAgentTurns!(db), runtimeEpoch: 41 };
      },
      scheduleReconciliationContinuation: (task) => {
        scheduled.push(task);
        return { cancel: () => {} };
      },
    }));
    expect(genericTurns).toBe(0);
    expect(scheduled).toHaveLength(1);
    expect(result.stages.turns).toEqual({ ok: false, status: "pending", errorCode: null });
    expect(result.readiness.reconciliation).toBe(false);
  });

  test("fails startup turns instead of treating an unhealthy completion drain as pagination", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    let activeDrainCalls = 0;
    const { result } = await captureConsoleErrors(() => reconcileStartupState(db, healthyRecoveryDependencies({
      startAgentRuntimeEpoch: () => 43,
      reconcileWorkSegmentRecovery: () => ({ ...healthyWorkSegmentRecovery(), closed: 1, queued: 1 }),
      resumeQueuedWorkCompletions: async () => ({
        resumed: 0,
        terminalized: 0,
        complete: false,
        healthy: false,
      }),
      resumeQueuedWorkSegments: async () => {
        activeDrainCalls += 1;
        return { resumed: 0, terminalized: 0, complete: true, healthy: true };
      },
    })));
    expect(activeDrainCalls).toBe(0);
    expect(result.stages.turns).toEqual({ ok: false, status: "failed", errorCode: "unhealthy" });
    expect(result.readiness.reconciliation).toBe(false);
  });

  test("recomputes static readiness after startup import recovery and preserves unresolved denial", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    runtimeReadinessTesting.resetReadiness();
    let importAttempts = 0;
    const dependencies = healthyRecoveryDependencies({
      reconcileUserDataImports: () => {
        importAttempts += 1;
        return importAttempts === 1
          ? { ...healthyImportRecovery(), complete: false, healthy: false }
          : healthyImportRecovery();
      },
      setAgenticRuntimeReadiness,
    });

    try {
      const denied = await reconcileStartupState(db, dependencies);
      expect(denied.readiness.archiveRegistry).toBe(false);
      expect(denied.readiness.reconciliation).toBe(false);
      expect(denied.readiness.reason).toBe("reconciliation_unavailable");

      const recovered = await reconcileStartupState(db, dependencies);
      expect(recovered.imports).toEqual(healthyImportRecovery());
      expect(recovered.readiness.archiveRegistry).toBe(true);
      expect(recovered.readiness.reconciliation).toBe(true);
      expect(recovered.readiness.reason).toBeNull();
      expect(getAgenticReadiness()).toMatchObject(recovered.readiness);

      const unresolved = await reconcileStartupState(db, {
        ...dependencies,
        reconcileUserDataImports: () => healthyImportRecovery(),
        reconcileAgentTurns: () => ({
          runtimeEpoch: 18,
          inspected: 0,
          claimed: 0,
          failedInterrupted: 0,
          committedFromReceipt: 0,
          commitFailedWithoutReceipt: 0,
          projectionRepairs: 0,
          alreadyTerminal: 0,
          releasedReservations: 0,
          complete: false,
        }),
      });
      expect(unresolved.readiness.archiveRegistry).toBe(true);
      expect(unresolved.readiness.reconciliation).toBe(false);
      expect(unresolved.readiness.reason).toBe("reconciliation_unavailable");
    } finally {
      runtimeReadinessTesting.resetReadiness();
    }
  });
  test("runs export staging reconciliation before imports and fails closed on scan errors", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const calls: string[] = [];
    let readinessPatch: Partial<Record<"schema" | "reconciliation" | "archiveRegistry" | "isolateTermination" | "publicationStore", boolean>> = {};
    const result = await reconcileStartupState(db, healthyRecoveryDependencies({
      reconcileExportStaging: () => {
        calls.push("export-staging");
        throw new Error("scan failed");
      },
      reconcileUserDataImports: () => {
        calls.push("imports");
        return healthyImportRecovery();
      },
      setAgenticRuntimeReadiness: (patch) => {
        readinessPatch = patch;
        return readiness(patch);
      },
    }));

    expect(calls).toEqual(["export-staging", "imports"]);
    expect(result.stages.imports).toEqual({ ok: false, status: "failed", errorCode: "stage_failed" });
    expect(readinessPatch.archiveRegistry).toBe(false);
    expect(readinessPatch.reconciliation).toBe(false);
  });

  test("keeps Agentic readiness closed when no terminable backend is available", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const result = await reconcileStartupState(db, {
      startAgentRuntimeEpoch: () => 18,
      reconcileUserDataImports: () => healthyImportRecovery(),
      reconcileAgentArtifactBlobs: async () => ({ inspected: 0, retained: 0, removed: 0, stale: 0, quarantined: 0, bytesRemoved: 0 }),
      reconcileAgentTurns: () => ({
        runtimeEpoch: 18,
        inspected: 0,
        claimed: 0,
        failedInterrupted: 0,
        committedFromReceipt: 0,
        commitFailedWithoutReceipt: 0,
        projectionRepairs: 0,
        alreadyTerminal: 0,
        releasedReservations: 0,
      }),
      reconcileAgentRunProjections: () => ({
        inspectedProjections: 0,
        removedProjections: 0,
        inspectedWorkspaces: 0,
        removedWorkspaces: 0,
        preservedChatLifetimeEntries: 0,
        failures: 0,
        healthy: true,
        complete: true,
      }),
      probeIsolateBackendsAtStartup: async () => isolate("unavailable"),
      installAgenticGenerationCoordinator: () => {},
      setAgenticRuntimeReadiness: (patch) => readiness({ isolateTermination: patch.isolateTermination === true }),
    });
    expect(result.isolate.selected).toBe("unavailable");
    expect(result.readiness.reason).toBe("isolateTermination_unavailable");
    expect(result.stages.projections).toEqual({ ok: true, status: "completed", errorCode: null });
    expect(result.stages.isolate).toEqual({ ok: false, status: "failed", errorCode: "unhealthy" });
  });
  test("marks required isolate startup unhealthy when preprocessing is disabled", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const previous = process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER;
    process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER = "false";
    try {
      const result = await reconcileStartupState(db, {
        startAgentRuntimeEpoch: () => 18,
        reconcileUserDataImports: () => healthyImportRecovery(),
        reconcileAgentArtifactBlobs: async () => ({
          inspected: 0,
          retained: 0,
          removed: 0,
          stale: 0,
          quarantined: 0,
          bytesRemoved: 0,
        }),
        reconcileAgentTurns: () => ({
          runtimeEpoch: 18,
          inspected: 0,
          claimed: 0,
          failedInterrupted: 0,
          committedFromReceipt: 0,
          commitFailedWithoutReceipt: 0,
          projectionRepairs: 0,
          alreadyTerminal: 0,
          releasedReservations: 0,
        }),
        reconcileAgentRunProjections: () => ({
          inspectedProjections: 0,
          removedProjections: 0,
          inspectedWorkspaces: 0,
          removedWorkspaces: 0,
          preservedChatLifetimeEntries: 0,
          failures: 0,
          healthy: true,
          complete: true,
        }),
        probeIsolateBackendsAtStartup: async () => isolate("worker"),
        setAgenticRuntimeReadiness: (patch) => readiness(patch),
        installAgenticGenerationCoordinator: () => {},
      });
      expect(result.isolate.selected).toBe("worker");
      expect(result.readiness.isolateTermination).toBe(false);
      expect(result.stages.isolate).toEqual({ ok: false, status: "failed", errorCode: "unhealthy" });
    } finally {
      if (previous === undefined) delete process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER;
      else process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER = previous;
    }
  });
  test("keeps publication readiness closed when artifact reconciliation leaves pending users", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const captured = await captureConsoleErrors(() => reconcileStartupState(db, healthyRecoveryDependencies({
      reconcileAgentArtifactBlobs: async () => ({
        inspected: 2,
        retained: 2,
        removed: 0,
        stale: 0,
        quarantined: 0,
        bytesRemoved: 0,
        pendingUsers: 1,
        pendingOverflow: false,
        healthy: false,
      }),
    })));
    expect(captured.errors).toContain("[startup] artifacts recovery failed (unhealthy)");
    expect(captured.result.stages.artifacts).toEqual({ ok: false, status: "failed", errorCode: "unhealthy" });
    expect(captured.result.readiness.publicationStore).toBe(false);
    expect(captured.result.readiness.reconciliation).toBe(false);
  });
  test("retries bounded global artifact continuation and reopens complete readiness", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    let attempts = 0;
    const scheduled: Array<{ readonly task: () => Promise<void>; readonly delayMs: number; canceled: boolean }> = [];
    const readinessPatches: Array<Partial<Record<"schema" | "reconciliation" | "archiveRegistry" | "isolateTermination" | "publicationStore", boolean>>> = [];
    const result = await reconcileStartupState(db, healthyRecoveryDependencies({
      reconcileAgentArtifactBlobs: async () => {
        attempts++;
        return attempts === 1
          ? { inspected: 128, retained: 128, removed: 0, stale: 0, quarantined: 0, bytesRemoved: 0, pendingGlobal: true, healthy: false }
          : { inspected: 1, retained: 0, removed: 1, stale: 0, quarantined: 0, bytesRemoved: 0, pendingGlobal: false, healthy: true };
      },
      setAgenticRuntimeReadiness: (patch) => {
        readinessPatches.push(patch);
        return readiness(patch);
      },
      scheduleReconciliationContinuation: (task, delayMs) => {
        const entry = { task, delayMs, canceled: false };
        scheduled.push(entry);
        return { cancel: () => { entry.canceled = true; } };
      },
    }));
    expect(result.readiness.publicationStore).toBe(false);
    expect(result.readiness.reconciliation).toBe(false);
    expect(attempts).toBe(1);
    const first = scheduled.shift();
    if (!first) throw new Error("artifact continuation was not scheduled");
    expect(first.delayMs).toBe(25);
    await first.task();
    expect(attempts).toBe(2);
    expect(scheduled).toHaveLength(0);
    expect(readinessPatches).toHaveLength(2);
    expect(readinessPatches[1]).toEqual({
      schema: true,
      archiveRegistry: true,
      reconciliation: true,
      publicationStore: true,
      isolateTermination: true,
    });
  });
  test("uses one continuation for simultaneous bounded artifact and projection backlog", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    let artifactAttempts = 0;
    let projectionAttempts = 0;
    const scheduled: Array<{ readonly task: () => Promise<void>; readonly delayMs: number }> = [];
    const readinessPatches: Array<Partial<Record<"schema" | "reconciliation" | "archiveRegistry" | "isolateTermination" | "publicationStore", boolean>>> = [];
    const result = await reconcileStartupState(db, healthyRecoveryDependencies({
      reconcileAgentArtifactBlobs: async () => {
        artifactAttempts++;
        return artifactAttempts === 1
          ? { inspected: 256, retained: 256, removed: 0, stale: 0, quarantined: 0, bytesRemoved: 0, pendingGlobal: true, healthy: false }
          : { inspected: 1, retained: 0, removed: 1, stale: 0, quarantined: 0, bytesRemoved: 0, pendingGlobal: false, healthy: true };
      },
      reconcileAgentRunProjections: () => {
        projectionAttempts++;
        const complete = projectionAttempts >= 3;
        return {
          inspectedProjections: complete ? 1 : 256,
          removedProjections: complete ? 1 : 256,
          inspectedWorkspaces: complete ? 1 : 256,
          removedWorkspaces: complete ? 1 : 256,
          preservedChatLifetimeEntries: 0,
          failures: 0,
          healthy: true,
          complete,
        };
      },
      setAgenticRuntimeReadiness: (patch) => {
        readinessPatches.push(patch);
        return readiness(patch);
      },
      scheduleReconciliationContinuation: (task, delayMs) => {
        scheduled.push({ task, delayMs });
        return { cancel: () => {} };
      },
    }));

    expect(result.stages.artifacts).toEqual({ ok: false, status: "pending", errorCode: null });
    expect(result.stages.projections).toEqual({ ok: false, status: "pending", errorCode: null });
    expect(scheduled).toHaveLength(1);
    const first = scheduled.shift();
    if (!first) throw new Error("shared continuation was not scheduled");
    expect(first.delayMs).toBe(25);
    await first.task();
    expect(readinessPatches[1]).toMatchObject({ publicationStore: true, reconciliation: false });
    expect(scheduled).toHaveLength(1);
    const second = scheduled.shift();
    if (!second) throw new Error("projection continuation was not rescheduled");
    expect(second.delayMs).toBe(50);
    await second.task();
    expect(readinessPatches.at(-1)).toMatchObject({ publicationStore: true, reconciliation: true });
    expect(scheduled).toHaveLength(0);
  });
  test("cancels artifact continuation on startup shutdown", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const scheduled: Array<{ readonly task: () => Promise<void>; canceled: boolean }> = [];
    let attempts = 0;
    await reconcileStartupState(db, healthyRecoveryDependencies({
      reconcileAgentArtifactBlobs: async () => {
        attempts++;
        return { inspected: 128, retained: 128, removed: 0, stale: 0, quarantined: 0, bytesRemoved: 0, pendingGlobal: true, healthy: false };
      },
      scheduleReconciliationContinuation: (task) => {
        const entry = { task, canceled: false };
        scheduled.push(entry);
        return { cancel: () => { entry.canceled = true; } };
      },
    }));
    const first = scheduled[0];
    if (!first) throw new Error("artifact continuation was not scheduled");
    await shutdownIsolatePools({
      shutdownPromptAssemblyWorkerPool: async () => {},
      shutdownAgenticPreprocessingPool: async () => {},
      shutdownRegexIsolatePool: async () => {},
    });
    expect(first.canceled).toBe(true);
    await first.task();
    expect(attempts).toBe(1);
  });
  test("keeps reconciliation readiness closed when turn recovery defers candidates", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const turnsResult = {
      runtimeEpoch: 18,
      inspected: 12,
      claimed: 5,
      failedInterrupted: 2,
      committedFromReceipt: 1,
      commitFailedWithoutReceipt: 0,
      projectionRepairs: 1,
      alreadyTerminal: 4,
      releasedReservations: 2,
      complete: false,
    } as const;
    const result = await reconcileStartupState(db, healthyRecoveryDependencies({
      reconcileAgentTurns: () => turnsResult,
    }));

    expect(result.turns).toEqual(turnsResult);
    expect(result.stages.turns).toEqual({ ok: false, status: "pending", errorCode: null });
    expect(result.readiness.reconciliation).toBe(false);
    expect(result.stages.coordinator).toEqual({ ok: true, status: "completed", errorCode: null });
  });


  test("marks isolate recovery unhealthy when readiness closes isolate termination", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const isolateReady = process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER !== "false";
    const captured = await captureConsoleErrors(() => reconcileStartupState(db, healthyRecoveryDependencies({
      setAgenticRuntimeReadiness: () => {
        throw new Error("private readiness failure");
      },
    })));
    expect(captured.errors).toEqual([
      ...(isolateReady ? [] : ["[startup] isolate recovery failed (unhealthy)"]),
      "[startup] readiness recovery failed (stage_failed)",
    ]);
    expect(captured.result.readiness.isolateTermination).toBe(false);
    expect(captured.result.stages.isolate).toEqual({ ok: false, status: "failed", errorCode: "unhealthy" });
    expect(captured.result.stages.readiness).toEqual({ ok: false, status: "failed", errorCode: "stage_failed" });
  });

  test("marks isolate recovery unhealthy when coordinator closes readiness", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const isolateReady = process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER !== "false";
    const captured = await captureConsoleErrors(() => reconcileStartupState(db, healthyRecoveryDependencies({
      installAgenticGenerationCoordinator: () => {
        throw new Error("private coordinator failure");
      },
    })));
    expect(captured.errors).toEqual([
      ...(isolateReady ? [] : ["[startup] isolate recovery failed (unhealthy)"]),
      "[startup] coordinator recovery failed (stage_failed)",
    ]);
    expect(captured.result.readiness.isolateTermination).toBe(false);
    expect(captured.result.stages.isolate).toEqual({ ok: false, status: "failed", errorCode: "unhealthy" });
    expect(captured.result.stages.readiness).toEqual({ ok: true, status: "completed", errorCode: null });
    expect(captured.result.stages.coordinator).toEqual({ ok: false, status: "failed", errorCode: "stage_failed" });
  });



  test("closes reconciliation and logs a stable outcome for unhealthy projections", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    const calls: string[] = [];
    const isolateReady = process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER !== "false";
    const captured = await captureConsoleErrors(() => reconcileStartupState(db, {
      startAgentRuntimeEpoch: () => {
        calls.push("epoch");
        return 18;
      },
      reconcileUserDataImports: () => {
        calls.push("imports");
        return healthyImportRecovery();
      },
      reconcileAgentArtifactBlobs: async () => {
        calls.push("artifacts");
        return { inspected: 3, retained: 1, removed: 1, stale: 1, quarantined: 1, bytesRemoved: 4 };
      },
      reconcileWorkSegmentRecovery: () => healthyWorkSegmentRecovery(),
      reconcileAgentTurns: () => {
        calls.push("turns");
        return {
          runtimeEpoch: 18,
          inspected: 1,
          claimed: 0,
          failedInterrupted: 0,
          committedFromReceipt: 0,
          commitFailedWithoutReceipt: 0,
          projectionRepairs: 0,
          alreadyTerminal: 1,
          releasedReservations: 0,
        };
      },
      reconcileAgentRunProjections: () => {
        calls.push("projections");
        return {
          inspectedProjections: 3,
          removedProjections: 1,
          inspectedWorkspaces: 2,
          removedWorkspaces: 0,
          preservedChatLifetimeEntries: 0,
          failures: 1,
          healthy: false,
          complete: false,
        };
      },
      probeIsolateBackendsAtStartup: async () => {
        calls.push("probe");
        return isolate("subprocess");
      },
      setAgenticRuntimeReadiness: (patch) => {
        calls.push("readiness");
        return readiness(patch);
      },
      installAgenticGenerationCoordinator: () => {
        calls.push("install");
      },
    }));
    const result = captured.result;

    expect(calls).toEqual(["epoch", "imports", "artifacts", "turns", "projections", "probe", "readiness", "install"]);
    expect(captured.errors).toEqual([
      "[startup] projections recovery failed (unhealthy)",
      ...(isolateReady ? [] : ["[startup] isolate recovery failed (unhealthy)"]),
    ]);
    expect(result.projections).toEqual({
      inspectedProjections: 3,
      removedProjections: 1,
      inspectedWorkspaces: 2,
      removedWorkspaces: 0,
      preservedChatLifetimeEntries: 0,
      failures: 1,
      healthy: false,
      complete: false,
    });
    expect(result.readiness).toMatchObject({
      archiveRegistry: true,
      publicationStore: true,
      reconciliation: false,
      isolateTermination: isolateReady,
    });
    expect(result.stages.projections).toEqual({ ok: false, status: "failed", errorCode: "unhealthy" });
    expect(result.stages.isolate).toEqual(
      isolateReady
        ? { ok: true, status: "completed", errorCode: null }
        : { ok: false, status: "failed", errorCode: "unhealthy" },
    );
    expect(result.stages.readiness).toEqual({ ok: true, status: "completed", errorCode: null });
    expect(result.stages.coordinator).toEqual({ ok: true, status: "completed", errorCode: null });
  });

  const recoveryStages: readonly StartupRecoveryStage[] = ["imports", "artifacts", "turns", "projections"];
  for (const failedStage of recoveryStages) {
    test(`continues after ${failedStage} failure and keeps readiness fail-closed`, async () => {
      const db = new Database(":memory:");
      dbs.push(db);
      const calls: string[] = [];
      const isolateReady = process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER !== "false";
      let readinessPatch: Partial<Record<"schema" | "reconciliation" | "archiveRegistry" | "isolateTermination" | "publicationStore", boolean>> | undefined;
      const fail = (stage: StartupRecoveryStage): void => {
        calls.push(stage);
        if (failedStage === stage) throw new Error(`private ${stage} failure`);
      };
      const captured = await captureConsoleErrors(
        () => reconcileStartupState(db, {
        startAgentRuntimeEpoch: () => {
          calls.push("epoch");
          return 19;
        },
        reconcileUserDataImports: () => {
          fail("imports");
          return healthyImportRecovery();
        },
        reconcileAgentArtifactBlobs: async () => {
          fail("artifacts");
          return { inspected: 2, retained: 2, removed: 0, stale: 0, quarantined: 0, bytesRemoved: 0 };
        },
        reconcileWorkSegmentRecovery: () => healthyWorkSegmentRecovery(),
        reconcileAgentTurns: () => {
          fail("turns");
          return {
            runtimeEpoch: 19,
            inspected: 2,
            claimed: 0,
            failedInterrupted: 0,
            committedFromReceipt: 0,
            commitFailedWithoutReceipt: 0,
            projectionRepairs: 0,
            alreadyTerminal: 2,
            releasedReservations: 0,
          };
        },
        reconcileAgentRunProjections: () => {
          fail("projections");
          return {
            inspectedProjections: 2,
            removedProjections: 0,
            inspectedWorkspaces: 2,
            removedWorkspaces: 0,
            preservedChatLifetimeEntries: 0,
            failures: 0,
            healthy: true,
            complete: true,
          };
        },
        probeIsolateBackendsAtStartup: async () => {
          calls.push("probe");
          return isolate("subprocess");
        },
        setAgenticRuntimeReadiness: (patch) => {
          calls.push("readiness");
          readinessPatch = patch;
          return readiness(patch);
        },
        installAgenticGenerationCoordinator: () => {
          calls.push("install");
        },
      }));
      const result = captured.result;
      expect(captured.errors).toEqual([
        `[startup] ${failedStage} recovery failed (stage_failed)`,
        ...(isolateReady ? [] : ["[startup] isolate recovery failed (unhealthy)"]),
      ]);
      expect(captured.errors.join(" ")).not.toContain("private");

      expect(calls).toEqual(["epoch", "imports", "artifacts", "turns", "projections", "probe", "readiness", "install"]);
      expect(readinessPatch).toEqual({
        schema: true,
        archiveRegistry: failedStage !== "imports",
        reconciliation: false,
        isolateTermination: isolateReady,
        publicationStore: failedStage !== "artifacts",
      });
      expect(result.readiness.archiveRegistry).toBe(failedStage !== "imports");
      expect(result.readiness.publicationStore).toBe(failedStage !== "artifacts");
      expect(result.readiness.reconciliation).toBe(false);
      expect(result.readiness.isolateTermination).toBe(isolateReady);
      expect(result.stages[failedStage]).toEqual({
        ok: false,
        status: "failed",
        errorCode: "stage_failed",
      });
      for (const stage of recoveryStages) {
        if (stage !== failedStage) expect(result.stages[stage]).toEqual({ ok: true, status: "completed", errorCode: null });
      }

      expect(result.stages.isolate).toEqual(
        isolateReady
          ? { ok: true, status: "completed", errorCode: null }
          : { ok: false, status: "failed", errorCode: "unhealthy" },
      );
      for (const stage of ["readiness", "coordinator"] as const) {
        expect(result.stages[stage]).toEqual({ ok: true, status: "completed", errorCode: null });
      }
      if (failedStage === "artifacts") {
        expect(result.artifacts).toEqual({
          inspected: 0,
          retained: 0,
          removed: 0,
          stale: 0,
          quarantined: 0,
          bytesRemoved: 0,
        });
      }
      if (failedStage === "turns") {
        expect(result.turns).toEqual({
          runtimeEpoch: 19,
          inspected: 0,
          claimed: 0,
          failedInterrupted: 0,
          committedFromReceipt: 0,
          commitFailedWithoutReceipt: 0,
          projectionRepairs: 0,
          alreadyTerminal: 0,
          releasedReservations: 0,
          complete: true,
        });
      }
      if (failedStage === "projections") {
        expect(result.projections).toEqual({
          inspectedProjections: 0,
          removedProjections: 0,
          inspectedWorkspaces: 0,
          removedWorkspaces: 0,
          preservedChatLifetimeEntries: 0,
          failures: 0,
          healthy: false,
          complete: false,
        });
      }
    });
  }
});

describe("startup isolate shutdown", () => {
  test("attempts every pool even when one termination rejects", async () => {
    const calls: string[] = [];
    await shutdownIsolatePools({
      shutdownPromptAssemblyWorkerPool: async () => {
        calls.push("prompt");
      },
      shutdownAgenticPreprocessingPool: async () => {
        calls.push("agentic");
        throw new Error("worker exit failed");
      },
      shutdownRegexIsolatePool: async () => {
        calls.push("regex");
      },
    });
    expect(calls.sort()).toEqual(["agentic", "prompt", "regex"]);
  });
});
