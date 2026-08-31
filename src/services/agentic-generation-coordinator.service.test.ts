import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import {
  compileAgentAssemblyPlan,
  validateAssemblyPlanAgainstSnapshotV1,
  type AssemblyMessageSegmentV1,
  type AssemblyCompiledPolicyProviderMessageV1,
  type AssemblyProviderMessageV1,
} from "./agentic-assembly-compiler";
import { createHash } from "node:crypto";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import { registerProvider, getProvider } from "../llm/registry";
import type { LlmProvider } from "../llm/provider";
import type { GenerationRequest, GenerationResponse, StreamChunk } from "../llm/types";
import { createDisabledAgentConfigV2, type AgentConfigV2, type AgentCustomPhaseV1 } from "../types/agents";
import { HOST_PREPARATION_LIMITS_V1 } from "../types/agent-preprocessing";
import type { CognitionActivationResultV1, CognitionActivationStateV1 } from "../types/agent-cognition";
import type { CognitionRuntimeActivationV1 } from "../types/agent-cognition-runtime";
import { AgentRuntimeOwner } from "./agent-runtime.service";
import type { FrozenConcreteConnectionV1 } from "../types/agent-runtime-decision";
import type {
  AgenticWorkMutatingWorkspaceOperationKindV1,
  AgenticWorkWorkspaceMutationReservationV1,
  WorkSegmentContextV1,
} from "../types/agent-work-segment";
import { WORKSPACE_OPERATIONS } from "../types/turn-workspace";
import { createAgenticChildFrame, createAgenticRootFrame, executeBoundedAgenticChildFrame, type AgenticWorkProviderRequest } from "./agentic-work-phase.service";
import { compileAgentRuntimePhases } from "./agentic-phase-runtime.service";
import { createAgentCognitionRuntime } from "./agent-cognition-runtime.service";
import { evaluateCognitionPredicate } from "./agent-cognition.service";
import {
  setAgenticRuntimeReadiness,
  startAgentRuntimeEpoch,
  getTurnExecution,
  getRuntimeEpoch,
  calculateFinalRenderReservationEnvelopeV1,
  finalRenderActivityChunksFromHostLimitsV1,
  createTurnExecution,
  finalizeTurnCommit,
  reconcileAgentTurns,
  reserveFinalRender,
  requestTurnCancellation,
  transitionTurnExecution,
  TurnExecutionError,
} from "./turn-execution.service";
import {
  AGENT_RUNTIME_DECISION_SERVICE,
  canonicalRuntimeCapabilityDigest,
  resolveEffectiveRuntime,
} from "./agent-runtime-decision.service";
import { getIsolateHealthEpoch, probeIsolateBackendsAtStartup } from "./isolate-pool";
import { AGENT_RUNTIME_ADMISSION_MANAGER } from "./agent-runtime-admission";
import { getAgentRuntimeHostLimits } from "./agent-runtime-limits";
import { appendPoolContent, completePool, createPoolEntry, errorPool, getPoolEntry, removePoolEntry } from "./generation-pool.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import {
  configureAgenticGenerationRuntimeDependencies,
  runAgenticGeneration,
  waitForAgenticGeneration,
} from "./agentic-generation.service";
import {
  __generationRequestAuthorityTesting,
  configureAgenticGenerationDependencies,
  acknowledgeGenerationDispatch,
  resolveGenerationRequestAuthority,
  startGeneration,
  stopGeneration,
  stopGenerationRequestAuthority,
} from "./generate.service";
import * as breakdownSvc from "./breakdown.service";
import { createAgentInspectionWriter, getAgentRunInspection, type AgentInspectionWriterV1 } from "./agent-activity-runs.service";
import { getAgentRun, requestAgentRunStop } from "./agent-run-projection.service";
import { deleteChat } from "./chats.service";
import { generateRoutes } from "../routes/generate.routes";
import { getPresetAgentConfig, writePresetAgentConfig } from "./agent-config-portability.service";

import * as secretsSvc from "./secrets.service";
import * as tokenizerService from "./tokenizer.service";
import { encodeCanonicalPlainData } from "../utils/canonical-plain-data";
import {
  __testing,
  installAgenticGenerationCoordinator,
} from "./agentic-generation-coordinator.service";
import * as workSegmentRepository from "./agentic-work-segment.repository";
import { reconcileWorkSegmentRecoveryAtStartupV1 } from "./agentic-work-segment.repository";
const USER_ID = "user-coordinator";
const CHAT_ID = "chat-coordinator";
const AGENTIC_CHAT_ID = "chat-coordinator-agentic";
const CONNECTION_ID = "connection-coordinator";
const PRESET_ID = "preset-coordinator";
const AGENTIC_PRESET_ID = "preset-coordinator-agentic";
let scriptedDelegate = false;
let scriptedDelegateProfileId = "delegate";
let scriptedTaskCreated = false;
let delegateIssued = false;
let scriptedAcceptSubmission = false;
let scriptedChildSubmitted = false;
let scriptedAcceptanceIssued = false;
const USER_INPUT = "carry-this-exact-user-input-through";
const ADMITTED_CONFIG_REVISION = 7;
const ADMITTED_BINDING_REVISION = 11;
const ADMITTED_TARGET_REVISION = 13;
function markAgenticRuntimeReady(): void {
  setAgenticRuntimeReadiness({
    schema: true,
    reconciliation: true,
    archiveRegistry: true,
    publicationStore: true,
    isolateTermination: true,
  });
}
let scriptedWorkRound = 0;
let scriptedAllSkipped = false;
let scriptedTwoPhase = false;
let scriptedTwoPhaseTurnId = "";
let scriptedTwoPhaseMutationIssued = false;
const scriptedTwoPhaseSnapshots: Array<{
  readonly state: string;
  readonly revision: number;
  readonly recordCount: number;
  readonly recordSummary: string;
  readonly frozenAt: number | null;
}> = [];
let scriptedBlockedTerminal = false;
let scriptedBlockedTerminalTurnId = "";
let scriptedBlockedTerminalTaskCreated = false;
let scriptedBlockedTerminalDelegateIssued = false;
let scriptedBlockedTerminalChildSubmitted = false;
let scriptedBlockedTerminalAttempted = false;
let scriptedBlockedTerminalAcceptanceIssued = false;
let scriptedBlockedTerminalRetryCanAccept = false;
const scriptedBlockedTerminalSnapshots: Array<{
  readonly workspaceState: string;
  readonly workspaceRevision: number;
  readonly frozenAt: number | null;
  readonly taskState: string;
  readonly submissionState: string;
}> = [];
let scriptedWorkBlocked = false;
let scriptedWorkDispatchStarted: (() => void) | undefined;
/** Records every provider request so the test can prove the real input arrived. */
const providerRequests: GenerationRequest[] = [];
const boundProviderDispatches: Array<{
  readonly provider: string;
  readonly url: string;
  readonly request: GenerationRequest;
}> = [];

class ScriptedProvider implements LlmProvider {
  readonly name = "scripted-coordinator";
  readonly displayName = "Scripted Coordinator";
  readonly defaultUrl = "https://scripted.invalid/v1";
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
    providerRequests.push(request);
    return { content: "scripted", finish_reason: "stop" };
  }

  async *generateStream(_key: string, _url: string, request: GenerationRequest): AsyncGenerator<StreamChunk, void, unknown> {
    providerRequests.push(request);
    if (request.toolMode === "ordinary") {
      if (scriptedWorkBlocked) {
        yield { token: "blocked in-flight WORK" };
        scriptedWorkDispatchStarted?.();
        await new Promise<void>((resolve) => {
          const signal = request.signal;
          if (!signal) return;
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return;
      }
      const rootHasCompleteTurn = request.tools?.some((tool) => tool.name === "complete_turn") === true;
      const rootCanDelegate = request.tools?.some((tool) => tool.name === "agent_delegate") === true;
      if (scriptedAllSkipped) {
        yield {
          token: "",
          tool_calls: [{
            name: "complete_turn",
            args: { summary: "all authored optional phases skipped", unresolvedIds: [] },
            call_id: "all-skipped-complete",
          }],
          finish_reason: "tool_calls",
        };
        return;
      }
      if (scriptedBlockedTerminal) {
        const rootCanWrite = request.tools?.some((tool) => tool.name === "workspace_create_task") === true;
        if (!rootHasCompleteTurn) {
          const childCanSubmit = request.tools?.some((tool) => tool.name === "workspace_submit_child_result") === true;
          if (childCanSubmit && !scriptedBlockedTerminalChildSubmitted) {
            scriptedBlockedTerminalChildSubmitted = true;
            yield {
              token: "",
              tool_calls: [{
                name: "workspace_submit_child_result",
                args: {
                  summary: "Required task result is ready for owner acceptance.",
                },
                call_id: "blocked-terminal-child-submit",
              }],
              finish_reason: "tool_calls",
            };
            return;
          }
          yield { token: "blocked-terminal child result" };
          yield { token: "", finish_reason: "stop" };
          return;
        }
        if (!rootCanWrite || !rootCanDelegate) {
          yield {
            token: "",
            tool_calls: [{
              name: "complete_turn",
              args: { summary: "phase one complete", unresolvedIds: [] },
              call_id: "blocked-terminal-phase-one-complete",
            }],
            finish_reason: "tool_calls",
          };
          return;
        }
        if (!scriptedBlockedTerminalTaskCreated) {
          scriptedBlockedTerminalTaskCreated = true;
          yield {
            token: "",
            tool_calls: [{
              name: "workspace_create_task",
              args: {
                taskId: "blocked-terminal-task",
                title: "Blocked-terminal submission",
                objective: "Keep terminal completion blocked until the pending submission is accepted.",
                dependencyIds: [],
              },
              call_id: "blocked-terminal-create-task",
            }],
            finish_reason: "tool_calls",
          };
          return;
        }
        if (!scriptedBlockedTerminalDelegateIssued) {
          scriptedBlockedTerminalDelegateIssued = true;
          yield {
            token: "",
            tool_calls: [{
              name: "agent_delegate",
              args: {
                profile_id: "delegate",
                task_id: "blocked-terminal-task",
                task: "Submit the required blocked-terminal task result.",
                tool_ids: ["chat_search_history"],
              },
              call_id: "blocked-terminal-delegate",
            }],
            finish_reason: "tool_calls",
          };
          return;
        }
        if (!scriptedBlockedTerminalAttempted) {
          const workspaceRow = getDb().query(
            "SELECT state, revision, frozen_at FROM agent_turn_workspaces WHERE workspace_id = ? AND turn_id = ?",
          ).get(`workspace:${scriptedBlockedTerminalTurnId}`, scriptedBlockedTerminalTurnId) as {
            state: string;
            revision: number;
            frozen_at: number | null;
          } | null;
          const taskRow = getDb().query(
            "SELECT state FROM agent_workspace_tasks WHERE workspace_id = ? AND turn_id = ? AND task_id = ?",
          ).get(`workspace:${scriptedBlockedTerminalTurnId}`, scriptedBlockedTerminalTurnId, "blocked-terminal-task") as { state: string } | null;
          const submissionRow = getDb().query(
            "SELECT state FROM agent_workspace_submissions WHERE workspace_id = ? AND turn_id = ? AND task_id = ? ORDER BY created_at DESC LIMIT 1",
          ).get(`workspace:${scriptedBlockedTerminalTurnId}`, scriptedBlockedTerminalTurnId, "blocked-terminal-task") as { state: string } | null;
          scriptedBlockedTerminalSnapshots.push({
            workspaceState: workspaceRow?.state ?? "missing",
            workspaceRevision: workspaceRow?.revision ?? -1,
            frozenAt: workspaceRow?.frozen_at ?? null,
            taskState: taskRow?.state ?? "missing",
            submissionState: submissionRow?.state ?? "missing",
          });
          scriptedBlockedTerminalAttempted = true;
          yield {
            token: "",
            tool_calls: [{
              name: "complete_turn",
              args: { summary: "terminal completion before submission acceptance", unresolvedIds: [] },
              call_id: "blocked-terminal-first-complete",
            }],
            finish_reason: "tool_calls",
          };
          return;
        }
        if (!scriptedBlockedTerminalAcceptanceIssued) {
          scriptedBlockedTerminalRetryCanAccept = request.tools?.some((tool) => tool.name === "workspace_accept_submission") === true;
          const submission = getDb().query(
            "SELECT submission_id FROM agent_workspace_submissions WHERE workspace_id = ? AND turn_id = ? AND task_id = ? AND state = 'submitted' ORDER BY created_at DESC LIMIT 1",
          ).get(`workspace:${scriptedBlockedTerminalTurnId}`, scriptedBlockedTerminalTurnId, "blocked-terminal-task") as { submission_id: string } | null;
          if (submission) {
            scriptedBlockedTerminalAcceptanceIssued = true;
            yield {
              token: "",
              tool_calls: [{
                name: "workspace_accept_submission",
                args: { submissionId: submission.submission_id, taskId: "blocked-terminal-task" },
                call_id: "blocked-terminal-accept-submission",
              }],
              finish_reason: "tool_calls",
            };
            return;
          }
        }
        yield {
          token: "",
          tool_calls: [{
            name: "complete_turn",
            args: { summary: "terminal completion after submission acceptance", unresolvedIds: [] },
            call_id: "blocked-terminal-final-complete",
          }],
          finish_reason: "tool_calls",
        };
        return;
      }
      if (scriptedTwoPhase) {
        const phaseTwoCanWrite = request.tools?.some((tool) => tool.name === "workspace_record_finding") === true;
        if (!phaseTwoCanWrite) {
          yield {
            token: "",
            tool_calls: [{
              name: "complete_turn",
              args: { summary: "phase one complete", unresolvedIds: ["model-only-unresolved"], renderGuidance: "phase-one-render-guidance" },
              call_id: "phase-one-complete",
            }],
            finish_reason: "tool_calls",
          };
          return;
        }
        if (!scriptedTwoPhaseMutationIssued) {
          scriptedTwoPhaseMutationIssued = true;
          yield {
            token: "",
            tool_calls: [{
              name: "workspace_record_finding",
              args: { summary: "WORK-B-OK" },
              call_id: "phase-two-record-finding",
            }],
            finish_reason: "tool_calls",
          };
          return;
        }
        if (scriptedTwoPhaseSnapshots.length === 0) {
          const workspaceRow = getDb().query(
            "SELECT state, revision, record_count, frozen_at FROM agent_turn_workspaces WHERE workspace_id = ? AND turn_id = ?",
          ).get(`workspace:${scriptedTwoPhaseTurnId}`, scriptedTwoPhaseTurnId) as {
            state: string;
            revision: number;
            record_count: number;
            frozen_at: number | null;
          } | null;
          const recordRow = getDb().query(
            "SELECT summary FROM agent_workspace_records WHERE workspace_id = ? AND turn_id = ? AND kind = 'finding' ORDER BY created_at ASC LIMIT 1",
          ).get(`workspace:${scriptedTwoPhaseTurnId}`, scriptedTwoPhaseTurnId) as { summary: string } | null;
          scriptedTwoPhaseSnapshots.push({
            state: workspaceRow?.state ?? "missing",
            revision: workspaceRow?.revision ?? -1,
            recordCount: workspaceRow?.record_count ?? -1,
            recordSummary: recordRow?.summary ?? "missing",
            frozenAt: workspaceRow?.frozen_at ?? null,
          });
        }
        yield {
          token: "",
          tool_calls: [{
            name: "complete_turn",
            args: { summary: "phase two complete", unresolvedIds: [] },
            call_id: "phase-two-complete",
          }],
          finish_reason: "tool_calls",
        };
        return;
      }
      if (scriptedDelegate && rootCanDelegate) {
        if (!scriptedTaskCreated) {
          scriptedTaskCreated = true;
          scriptedWorkRound = 1;
          yield {
            token: "",
            tool_calls: [{
              name: "workspace_create_task",
              args: {
                taskId: "task-delegate",
                title: "Delegated workspace task",
                objective: "Inspect the delegated workspace task.",
                dependencyIds: [],
              },
              call_id: "task-create-1",
            }],
            finish_reason: "tool_calls",
          };
          return;
        }
        if (scriptedAcceptSubmission && delegateIssued && rootHasCompleteTurn && !scriptedAcceptanceIssued) {
          const submission = getDb().query(
            "SELECT submission_id, task_id FROM agent_workspace_submissions WHERE user_id = ? AND state = 'submitted' ORDER BY created_at DESC LIMIT 1",
          ).get(USER_ID) as { submission_id: string; task_id: string } | null;
          if (submission) {
            scriptedAcceptanceIssued = true;
            yield {
              token: "",
              tool_calls: [{
                name: "workspace_accept_submission",
                args: { submissionId: submission.submission_id, taskId: submission.task_id },
                call_id: "accept-submission-1",
              }],
              finish_reason: "tool_calls",
            };
            return;
          }
        }
        if (!delegateIssued) {
          delegateIssued = true;
          yield {
            token: "",
            tool_calls: [{
              name: "agent_delegate",
              args: {
                profile_id: scriptedDelegateProfileId,
                task_id: "task-delegate",
                task: "Inspect the delegated workspace task.",
                tool_ids: ["chat_search_history"],
              },
              call_id: "delegate-1",
            }],
            finish_reason: "tool_calls",
          };
          return;
        }
      }
      if (scriptedAcceptSubmission && scriptedDelegate && delegateIssued && !rootHasCompleteTurn) {
        const childCanSubmit = request.tools?.some((tool) => tool.name === "workspace_submit_child_result") === true;
        if (childCanSubmit && !scriptedChildSubmitted) {
          scriptedChildSubmitted = true;
          yield {
            token: "",
            tool_calls: [{
              name: "workspace_submit_child_result",
              args: {
                summary: "delegated result",
              },
              call_id: "child-submit-1",
            }],
            finish_reason: "tool_calls",
          };
          return;
        }
        yield { token: "delegated result" };
        yield { token: "", finish_reason: "stop" };
        return;
      }
      if (scriptedDelegate && delegateIssued && !rootHasCompleteTurn) {
        yield { token: "delegated result" };
        yield { token: "", finish_reason: "stop" };
        return;
      }
      const firstRound = scriptedWorkRound === 0;
      const call = firstRound
        ? { name: "chat_search_history", args: { query: "history" }, call_id: "search-1" }
        : { name: "complete_turn", args: { summary: "bounded work complete", unresolvedIds: [] }, call_id: "complete-1" };
      scriptedWorkRound += 1;
      yield {
        token: "",
        tool_calls: [call],
        finish_reason: "tool_calls",
      };
      return;
    }
    yield { token: "scripted render" };
    yield { token: "", finish_reason: "stop", usage: { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 } };
  }

  async validateKey(): Promise<boolean> { return true; }
  async listModels(): Promise<string[]> { return ["scripted-model"]; }
}
type InspectionProviderScenario = "success" | "throw_after_yield" | "abort_after_yield" | "timeout_after_yield" | "receive_cap" | "output_cap";
let inspectionProviderScenario: InspectionProviderScenario = "success";
let inspectionProviderYielded: (() => void) | undefined;
class InspectionLifecycleProvider implements LlmProvider {
  readonly name = "inspection-lifecycle-provider";
  readonly displayName = "Inspection lifecycle provider";
  readonly defaultUrl = "https://inspection-lifecycle.invalid/v1";
  readonly capabilities = new ScriptedProvider().capabilities;

  async generate(): Promise<GenerationResponse> {
    return { content: "unused", finish_reason: "stop" };
  }

  async *generateStream(key: string, _url: string, request: GenerationRequest): AsyncGenerator<StreamChunk, void, unknown> {
    yield { token: "partial" };
    inspectionProviderYielded?.();
    if (inspectionProviderScenario === "throw_after_yield") throw new Error("provider-secret:" + key);
    if (inspectionProviderScenario === "timeout_after_yield") throw new DOMException("provider-secret:" + key, "TimeoutError");
    if (inspectionProviderScenario === "abort_after_yield") {
      await new Promise<void>(() => {});
      return;
    }
    if (inspectionProviderScenario === "receive_cap") {
      yield { token: "x".repeat(1024) };
      return;
    }
    yield {
      token: inspectionProviderScenario === "output_cap" ? " capped-output" : " success",
      finish_reason: "stop",
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    };
  }

  async validateKey(): Promise<boolean> { return true; }
  async listModels(): Promise<string[]> { return ["inspection-model"]; }
}
class BoundScriptedProvider implements LlmProvider {
  readonly displayName: string;
  readonly capabilities = new ScriptedProvider().capabilities;
  private readonly delegate = new ScriptedProvider();

  constructor(
    readonly name: string,
    readonly defaultUrl: string,
    readonly model: string,
    readonly usage: NonNullable<GenerationResponse["usage"]>,
  ) {
    this.displayName = name;
  }

  async generate(key: string, url: string, request: GenerationRequest): Promise<GenerationResponse> {
    boundProviderDispatches.push({ provider: this.name, url, request });
    return { ...(await this.delegate.generate(key, url, request)), usage: this.usage };
  }

  async *generateStream(key: string, url: string, request: GenerationRequest): AsyncGenerator<StreamChunk, void, unknown> {
    boundProviderDispatches.push({ provider: this.name, url, request });
    const isBoundedChild = request.messages.some((message) =>
      typeof message.content === "string" && message.content.includes("bounded subordinate frame"));
    if (isBoundedChild) {
      yield { token: "bound child output from " + this.name };
      yield { token: "", finish_reason: "stop", usage: this.usage };
      return;
    }
    for await (const chunk of this.delegate.generateStream(key, url, request)) {
      yield chunk.finish_reason ? { ...chunk, usage: this.usage } : chunk;
    }
  }

  async validateKey(): Promise<boolean> { return true; }
  async listModels(): Promise<string[]> { return [this.model]; }
}

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  await runMigrations(db);
}

function seed(): void {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  const now = Date.now();
  db.query(
    "INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)",
  ).run(USER_ID, "Coordinator", "coordinator@test.invalid", now, now);
  db.query(
    "INSERT INTO characters (id, name, description, personality, scenario, first_mes, mes_example, creator, creator_notes, system_prompt, post_history_instructions, tags, alternate_greetings, extensions, created_at, updated_at, user_id) VALUES (?, ?, '', '', '', '', '', '', '', '', '', '[]', '[]', '{}', ?, ?, ?)",
  ).run("character-coordinator", "Coordinator Character", now, now, USER_ID);
  db.query(
    "INSERT INTO connection_profiles (id, user_id, name, provider, api_url, model, is_default, has_api_key, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)",
  ).run(CONNECTION_ID, USER_ID, "Scripted", "scripted-coordinator", "https://scripted.invalid/v1", "scripted-model", "{}", now, now);
  db.query(
"    INSERT INTO chats (id, user_id, character_id, name, created_at, updated_at, metadata, generation_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(CHAT_ID, USER_ID, "character-coordinator", "Coordinator Chat", now, now, "{}", ADMITTED_TARGET_REVISION);
  db.query(
    "INSERT INTO presets (id, user_id, name, provider, engine, parameters, prompt_order, prompts, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(PRESET_ID, USER_ID, "Coordinator Preset", "scripted-coordinator", "classic", "{}", "[]", "{}", "{}", now, now);
  db.query(
"    INSERT INTO chats (id, user_id, character_id, name, created_at, updated_at, metadata, generation_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(AGENTIC_CHAT_ID, USER_ID, "character-coordinator", "Agentic Coordinator Chat", now, now, "{}", ADMITTED_TARGET_REVISION);
  db.query(
    "INSERT INTO presets (id, user_id, name, provider, engine, parameters, prompt_order, prompts, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(AGENTIC_PRESET_ID, USER_ID, "Agentic Coordinator Preset", "scripted-coordinator", "classic", "{}", "[]", "{}", "{}", now, now);
  db.query(
    `INSERT INTO preset_agent_configs
      (user_id, preset_id, version, agents_enabled, allowed_modes, default_mode,
       max_invocations, max_tool_calls, main_tool_ids, main_lore_scope,
       phase_policy_json, cognition_policy_json, task_policy_json,
       workspace_policy_json, state, review_acknowledged, config_revision, binding_revision,
       created_at, updated_at)
      VALUES (?, ?, 2, 1, ?, 'agentic', 8, 8, ?, 'active',
        '{}', '{}', '{}', '{}', 'ready', 1, ?, ?, ?, ?)`,
  ).run(
    USER_ID,
    AGENTIC_PRESET_ID,
    JSON.stringify(["response", "agentic"]),
    JSON.stringify(["chat_search_history"]),
    ADMITTED_CONFIG_REVISION - 1,
    ADMITTED_BINDING_REVISION - 2,
    now,
    now,
  );
  const agentConfig: AgentConfigV2 = {
    ...createDisabledAgentConfigV2(),
    agentsEnabled: true,
    allowedModes: ["response", "agentic"],
    defaultMode: "agentic",
    maxInvocations: 8,
    maxToolCalls: 8,
    mainToolIds: ["chat_search_history"],
    mainLoreScope: "active",
    connectionSlots: [
      { id: "delegate", label: "Delegate", requiredCapabilities: [] },
      { id: "delegate_alt", label: "Delegate Alt", requiredCapabilities: [] },
    ],
    profiles: [
      {
        id: "delegate",
        name: "Delegate",
        systemPrompt: "",
        connectionRef: { kind: "slot", slotId: "delegate" },
        toolIds: ["chat_search_history"],
        loreScope: "active",
        allowMainDelegation: true,
        failurePolicy: "optional",
        streamActivity: false,
        maxOutputTokens: 512,
        timeoutMs: 5000,
      },
      {
        id: "delegate_alt",
        name: "Delegate Alt",
        systemPrompt: "",
        connectionRef: { kind: "slot", slotId: "delegate_alt" },
        toolIds: ["chat_search_history"],
        loreScope: "active",
        allowMainDelegation: true,
        failurePolicy: "optional",
        streamActivity: false,
        maxOutputTokens: 128,
        timeoutMs: 5000,
      },
    ],
  };
  const written = writePresetAgentConfig(USER_ID, AGENTIC_PRESET_ID, {
    config: agentConfig,
    bindings: [
      { slotId: "delegate", connectionId: CONNECTION_ID },
      { slotId: "delegate_alt", connectionId: CONNECTION_ID },
    ],
  });
  if (written.configRevision !== ADMITTED_CONFIG_REVISION || written.bindingRevision !== ADMITTED_BINDING_REVISION) {
    throw new Error("Coordinator agent config fixture revisions are not canonical");
  }
}

function seedTransientAgenticChat(id: string): void {
  const now = Date.now();
  getDb().query(
    "INSERT INTO chats (id, user_id, character_id, name, created_at, updated_at, metadata, generation_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, USER_ID, "character-coordinator", "Transient Agentic Coordinator Chat", now, now, "{}", ADMITTED_TARGET_REVISION);
}

function expectClosedInterruptedWork(executionId: string, terminalPhase: "CANCELLED" | "TIMED_OUT"): void {
  const db = getDb();
  expect(db.query(
    "SELECT state, cas_owner FROM agent_turn_executions WHERE user_id = ? AND id = ?",
  ).get(USER_ID, executionId)).toEqual({ state: terminalPhase, cas_owner: null });
  const dispatches = db.query(
    "SELECT lifecycle, settled_at FROM agent_work_segment_dispatches WHERE user_id = ? AND execution_id = ? ORDER BY dispatch_ordinal",
  ).all(USER_ID, executionId) as Array<{ lifecycle: string; settled_at: number | null }>;
  expect(dispatches.length).toBeGreaterThan(0);
  for (const dispatch of dispatches) {
    expect(["settled", "interrupted"]).toContain(dispatch.lifecycle);
    expect(dispatch.settled_at).not.toBeNull();
  }
  const expectedWorkClose = terminalPhase === "TIMED_OUT"
    ? { closeResult: "failed", closeReason: "root_wall_clock_limit_exceeded" }
    : { closeResult: "cancelled", closeReason: "cancelled" };
  const recoveryQuery = db.query(
    "SELECT state, current_segment_id, terminal_close_result, terminal_close_reason FROM agent_work_segment_recovery WHERE user_id = ? AND execution_id = ?",
  );
  expect(recoveryQuery.get(USER_ID, executionId)).toEqual({
    state: "closed",
    current_segment_id: null,
    terminal_close_result: expectedWorkClose.closeResult,
    terminal_close_reason: expectedWorkClose.closeReason,
  });
  expect(db.query(
    "SELECT close_result, close_reason FROM agent_work_segments WHERE user_id = ? AND execution_id = ?",
  ).get(USER_ID, executionId)).toEqual({
    close_result: expectedWorkClose.closeResult, close_reason: expectedWorkClose.closeReason,
  });
  expect(db.query(
    "SELECT COUNT(*) AS count FROM agent_work_segments WHERE user_id = ? AND execution_id = ?",
  ).get(USER_ID, executionId)).toEqual({ count: 1 });
  expect(db.query(
    "SELECT COUNT(*) AS count FROM agent_work_segment_transitions WHERE user_id = ? AND execution_id = ?",
  ).get(USER_ID, executionId)).toEqual({ count: 0 });
  const beforeReconciliation = recoveryQuery.get(USER_ID, executionId);
  expect(reconcileWorkSegmentRecoveryAtStartupV1(db, getRuntimeEpoch())).toMatchObject({ healthy: true, complete: true });
  expect(reconcileWorkSegmentRecoveryAtStartupV1(db, getRuntimeEpoch())).toMatchObject({ healthy: true, complete: true });
  expect(recoveryQuery.get(USER_ID, executionId)).toEqual(beforeReconciliation);
}

function seedTargetMessage(id: string, chatId: string, revision: number): void {
  const now = Date.now();
  getDb().query(
    "INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra, created_at, generation_revision) VALUES (?, ?, 0, 0, ?, ?, ?, 0, ?, ?, '{}', ?, ?)",
  ).run(id, chatId, "Coordinator", "target", now, JSON.stringify(["target"]), JSON.stringify([now]), now, revision);
}
function seedCommittedExecution(id: string, chatId = AGENTIC_CHAT_ID): void {
  const messageId = "message:" + id;
  seedTargetMessage(messageId, chatId, 0);
  const created = createTurnExecution({
    id,
    userId: USER_ID,
    chatId,
    generationId: id,
    target: { kind: "normal" },
    mode: "agentic",
    runtimeEpoch: 1,
    deadlineAt: Date.now() + 60_000,
    workspaceId: `workspace:${id}`,
    rootLedger: {},
    frameCapabilities: {},
  });
  let current = created.execution;
  for (const nextPhase of ["WORK", "COMPLETE", "RENDER", "PREPARE_COMMIT", "COMMITTING"] as const) {
    current = transitionTurnExecution({
      executionId: id,
      ownerToken: created.ownerToken,
      expectedPhase: current.phase,
      nextPhase,
      ignoreCancellation: true,
    }).execution;
  }
  finalizeTurnCommit({
    executionId: id,
    ownerToken: created.ownerToken,
    receiptId: `receipt:${id}`,
    messageId,
    swipeId: 0,
    summary: { source: "coordinator-test" },
  });
}

function durableWorkspaceMutationReservation(input: Readonly<{
  executionId: string;
  workspaceId: string;
  providerCallId: string;
  operationKind: AgenticWorkMutatingWorkspaceOperationKindV1;
  frameId: string;
}>): AgenticWorkWorkspaceMutationReservationV1 {
  const scopeDigest = createHash("sha256").update(input.executionId, "utf8").digest("hex");
  const segmentId = `fixture-work-segment:${scopeDigest.slice(0, 32)}`;
  const dispatchId = `fixture-work-dispatch:${scopeDigest.slice(0, 32)}`;
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  try {
    db.query(`INSERT OR IGNORE INTO agent_work_segment_dispatches
      (dispatch_id, user_id, execution_id, attempt_id, segment_id, workspace_id,
       workspace_revision, execution_cas_revision, dispatch_ordinal, lifecycle,
       tool_mode, budget_class, reserved_output_tokens, ordinary_output_tokens_reserved,
       recovery_reserve_output_tokens_reserved, lease_owner, lease_expires_at,
       fence_generation, idempotency_key, payload_digest, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 'reserved', 'ordinary', 'normal', 1, 1, 0,
              ?, 9999999999999, 1, ?, ?, 1, 1)`).run(
      dispatchId,
      USER_ID,
      input.executionId,
      `fixture-work-attempt:${scopeDigest.slice(0, 32)}`,
      segmentId,
      input.workspaceId,
      `fixture-work-owner:${scopeDigest.slice(0, 32)}`,
      `fixture-work-dispatch-key:${scopeDigest.slice(0, 32)}`,
      "0".repeat(64),
    );
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
  return __testing.createWorkDispatchIdentityAuthorityV1({
    executionId: input.executionId,
    segmentId,
    logicalDispatch: 0,
  }).workspaceMutationReservation({
    providerCallId: input.providerCallId,
    operationKind: input.operationKind,
    frameId: input.frameId,
  });
}


beforeAll(async () => {
  closeDatabase();
  initDatabase(":memory:");
  await applyBaseline();
  await probeIsolateBackendsAtStartup();
  seed();
  if (!getProvider("scripted-coordinator")) registerProvider(new ScriptedProvider());
  if (!getProvider("inspection-lifecycle-provider")) registerProvider(new InspectionLifecycleProvider());
  if (!getProvider("scripted-child-a")) {
    registerProvider(new BoundScriptedProvider(
      "scripted-child-a",
      "https://child-a.invalid/v1",
      "child-model-a",
      { prompt_tokens: 11, completion_tokens: 13, total_tokens: 24 },
    ));
  }
  if (!getProvider("scripted-child-b")) {
    registerProvider(new BoundScriptedProvider(
      "scripted-child-b",
      "https://child-b.invalid/v1",
      "child-model-b",
      { prompt_tokens: 17, completion_tokens: 19, total_tokens: 36 },
    ));
  }
  // The production installer is install-once per process; another suite in this
  // process may already have installed it. Do not reset it here.
});

afterAll(() => {
  __testing.resetInstallation();
  closeDatabase();
});

describe("settled WORK mutation append integrity", () => {
  test("fails before touching durable ledgers or effects when finalization has no active Segment", () => {
    const snapshot = () => ({
      recovery: getDb().query(
        "SELECT COUNT(*) AS count, COALESCE(SUM(workspace_operations), 0) AS operations FROM agent_work_segment_recovery",
      ).get(),
      segments: getDb().query(
        "SELECT COUNT(*) AS count, COALESCE(SUM(workspace_operations), 0) AS operations FROM agent_work_segments",
      ).get(),
      dispatches: getDb().query(
        "SELECT COUNT(*) AS count, COALESCE(SUM(workspace_operations), 0) AS operations FROM agent_work_segment_dispatches",
      ).get(),
      effects: getDb().query(
        "SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes FROM agent_run_audit_records WHERE dedupe_key LIKE 'work-dispatch-effect-%'",
      ).get(),
    });
    const before = snapshot();
    try {
      __testing.appendSettledMutationReservationsForActiveV1(null, {} as never, 1);
      throw new Error("expected active Segment integrity failure");
    } catch (error) {
      expect((error as { code?: unknown }).code).toBe("integrity_error");
      expect(String((error as Error).message)).toContain("lacks an active Segment");
    }
    expect(snapshot()).toEqual(before);
  });
});
describe("production agentic coordinator installation", () => {
  test("installs exactly once and is idempotent", () => {
    installAgenticGenerationCoordinator();
    installAgenticGenerationCoordinator();
    expect(true).toBe(true);
  });
  test("publishes canonical nonterminal phases but leaves terminal publication to the cause owner", async () => {
    const executionId = `exec-public-phase-order-${Date.now()}`;
    createTurnExecution({
      id: executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      generationId: executionId,
      target: { kind: "normal" },
      mode: "agentic",
      runtimeEpoch: 1,
      deadlineAt: Date.now() + 60_000,
      workspaceId: `workspace:${executionId}`,
      rootLedger: {},
      frameCapabilities: {},
    });
    const publishPhase = __testing.buildDependencies().publishPhase;
    if (!publishPhase) throw new Error("phase publication authority is unavailable");

    const observed: Array<{ phase: string; status: string; outcome: string | null }> = [];
    for (const event of [
      { phase: "WORK", workPhase: "WORK", workStatus: "running" },
      { phase: "COMPLETE", workPhase: "PREPARE_COMMIT", workStatus: "waiting" },
      { phase: "RENDER", workPhase: "RENDER", workStatus: "running" },
      { phase: "PREPARE_COMMIT", workPhase: "COMMIT", workStatus: "waiting" },
      { phase: "COMMITTING", workPhase: "COMMIT", workStatus: "running" },
    ] as const) {
      await publishPhase({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        ...event,
        workOutcome: null,
        reason: null,
        target: { generationType: "normal" },
      });
      const projection = getAgentRun(USER_ID, executionId);
      if (!projection) throw new Error("phase projection was not persisted");
      observed.push({
        phase: projection.workPhase,
        status: projection.workStatus,
        outcome: projection.workOutcome,
      });
    }

    expect(observed).toEqual([
      { phase: "WORK", status: "running", outcome: null },
      { phase: "PREPARE_COMMIT", status: "waiting", outcome: null },
      { phase: "RENDER", status: "running", outcome: null },
      { phase: "COMMIT", status: "waiting", outcome: null },
      { phase: "COMMIT", status: "running", outcome: null },
    ]);

    await publishPhase({
      executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      phase: "FAILED",
      workPhase: "TERMINAL",
      workStatus: "terminal",
      workOutcome: "failed",
      reason: "failed",
      target: { generationType: "normal" },
    });
    expect(getAgentRun(USER_ID, executionId)).toMatchObject({
      workPhase: "COMMIT",
      workStatus: "running",
      workOutcome: null,
    });
  });

  test("maps the retained Turn Session through public COMMIT during normal preparation", async () => {
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const chatId = `chat-retained-phase-order-${Date.now()}`;
    seedTransientAgenticChat(chatId);
    const target = { generationType: "normal" as const, revision: ADMITTED_TARGET_REVISION };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!(
      {
        userId: USER_ID,
        chatId,
        connectionId: CONNECTION_ID,
        presetId: AGENTIC_PRESET_ID,
        generationType: "normal",
        userInput: USER_INPUT,
      },
      target,
      signal,
    );
    const executionId = `exec-retained-phase-order-${Date.now()}`;
    let execution = await deps.createExecution!({
      executionId,
      userId: USER_ID,
      chatId,
      target,
      decision,
      signal,
    });
    const observed: Array<{ phase: string; status: string; outcome: string | null }> = [];

    try {
      for (const next of ["WORK", "COMPLETE", "RENDER", "PREPARE_COMMIT", "COMMITTING"] as const) {
        const expected = execution.phase;
        if (!expected) throw new Error("retained session execution phase is unavailable");
        const transitioned = await deps.transitionExecution!(execution, expected, next);
        if (!transitioned) throw new Error("retained session transition did not return its execution");
        execution = transitioned;
        const session = getDb().query(
          "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE user_id = ? AND execution_id = ?",
        ).get(USER_ID, executionId) as { phase: string; status: string; outcome: string | null } | null;
        if (!session) throw new Error("retained Turn Session was not persisted");
        observed.push(session);
      }

      expect(observed).toEqual([
        { phase: "WORK", status: "running", outcome: null },
        { phase: "PREPARE_COMMIT", status: "waiting", outcome: null },
        { phase: "RENDER", status: "running", outcome: null },
        { phase: "COMMIT", status: "waiting", outcome: null },
        { phase: "COMMIT", status: "running", outcome: null },
      ]);
    } finally {
      const durablePhase = await deps.readExecutionPhase!(execution);
      if (durablePhase === "COMMITTING") {
        const failed = await deps.transitionExecution!(
          { ...execution, phase: durablePhase },
          durablePhase,
          "COMMIT_FAILED",
          "test_cleanup",
        );
        if (failed) execution = failed;
      } else if (
        durablePhase === "ASSEMBLE"
        || durablePhase === "WORK"
        || durablePhase === "COMPLETE"
        || durablePhase === "RENDER"
        || durablePhase === "PREPARE_COMMIT"
      ) {
        const failed = await deps.transitionExecution!(
          { ...execution, phase: durablePhase },
          durablePhase,
          "FAILED",
          "test_cleanup",
        );
        if (failed) execution = failed;
      }
      deps.cleanup!({ execution, phase: execution.phase, status: "failed" } as never);
    }
  });

  test("retains COMMIT/waiting when render preparation fails before terminal publication", async () => {
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const chatId = `chat-preparation-failure-${Date.now()}`;
    seedTransientAgenticChat(chatId);
    scriptedWorkRound = 0;
    const preparationBoundaries: Array<{ phase: string; status: string; outcome: string | null }> = [];
    let preparationExecutionId = "";
    const generationInput = {
      userId: USER_ID,
      chatId,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal" as const,
      userInput: "forced preparation failure",
      parameters: { max_tokens: 64 },
    };
    const admittedDecision = {
      ...await deps.resolveRuntime!(
        generationInput,
        { generationType: "normal", revision: ADMITTED_TARGET_REVISION },
        new AbortController().signal,
      ),
      mode: "agentic" as const,
    };

    const started = await runAgenticGeneration(generationInput, {
      ...deps,
      resolveRuntime: async () => admittedDecision,
      buildAssemblySnapshot: async () => ({}) as never,
      compileAssemblyPlan: async () => ({}) as never,
      runWork: async () => ({ status: "completed" }),
      render: async () => ({ content: "prepared render" }),
      prepareRender: async ({ execution }) => {
        preparationExecutionId = execution.id;
        const boundary = getDb().query(
          "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE user_id = ? AND execution_id = ?",
        ).get(USER_ID, execution.id) as { phase: string; status: string; outcome: string | null } | null;
        if (!boundary) throw new Error("missing retained preparation boundary");
        preparationBoundaries.push(boundary);
        throw new Error("forced_render_preparation_failure");
      },
    });
    const settled = await waitForAgenticGeneration(started.generationId);

    expect(preparationExecutionId).toBe(started.generationId);
    expect(preparationBoundaries).toEqual([{
      phase: "COMMIT",
      status: "waiting",
      outcome: null,
    }]);
    expect(settled).toMatchObject({ status: "failed", phase: "FAILED" });
    expect(getDb().query(
      "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE user_id = ? AND execution_id = ?",
    ).get(USER_ID, started.generationId)).toEqual({
      phase: "TERMINAL",
      status: "terminal",
      outcome: "failed",
    });

    const chronology = getAgentRunInspection(USER_ID, started.generationId, chatId)?.transcript ?? [];
    const renderIndex = chronology.findIndex(({ id }) => id === `phase:${started.generationId}:RENDER`);
    const preparationIndex = chronology.findIndex(({ id }) => id === `phase:${started.generationId}:PREPARE_COMMIT`);
    expect(renderIndex).toBeGreaterThanOrEqual(0);
    expect(preparationIndex).toBeGreaterThan(renderIndex);
    expect(chronology[renderIndex]?.correlation.phase).toBe("RENDER");
    expect(chronology[preparationIndex]?.correlation.phase).toBe("COMMIT");
  });

  test("in-flight Stop closes segmented WORK before terminalizing the execution", async () => {
    const chatId = `chat-in-flight-stop-${Date.now()}`;
    seedTransientAgenticChat(chatId);
    scriptedWorkBlocked = true;
    const dispatched = new Promise<void>((resolve) => { scriptedWorkDispatchStarted = resolve; });
    try {
      const started = await runAgenticGeneration({
        userId: USER_ID,
        chatId,
        connectionId: CONNECTION_ID,
        presetId: AGENTIC_PRESET_ID,
        generationType: "normal",
        userInput: "stop an in-flight segmented turn",
        parameters: { max_tokens: 64 },
      }, __testing.buildDependencies());
      await dispatched;
      expect(await stopGeneration(USER_ID, started.generationId, chatId)).toBe(true);
      expect(await waitForAgenticGeneration(started.generationId)).toMatchObject({
        status: "cancelled",
        phase: "CANCELLED",
      });
      await expectClosedInterruptedWork(started.generationId, "CANCELLED");
    } finally {
      scriptedWorkBlocked = false;
      scriptedWorkDispatchStarted = undefined;
    }
  });
  test("active Agent Run button Stop accepted at final WORK fence prevents commit", async () => {
    markAgenticRuntimeReady();
    installAgenticGenerationCoordinator();
    const chatId = "chat-active-run-button-stop-" + Date.now();
    seedTransientAgenticChat(chatId);
    const canonicalDependencies = __testing.buildDependencies();
    const transitionExecution = canonicalDependencies.transitionExecution;
    if (!transitionExecution) throw new Error("coordinator transition dependency unavailable");
    const providerRequestCount = providerRequests.length;
    const messageCount = (getDb().query(
      "SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?",
    ).get(chatId) as { count: number }).count;
    let stopResult: ReturnType<typeof requestAgentRunStop> | undefined;
    let providerRequestCountAtStop: number | undefined;
    const dependencies = {
      ...canonicalDependencies,
      transitionExecution: (
        execution: Parameters<typeof transitionExecution>[0],
        expected: Parameters<typeof transitionExecution>[1],
        next: Parameters<typeof transitionExecution>[2],
        terminalReason?: Parameters<typeof transitionExecution>[3],
      ) => {
        if (expected === "WORK" && next === "COMPLETE" && stopResult === undefined) {
          providerRequestCountAtStop = providerRequests.length;
          stopResult = requestAgentRunStop(USER_ID, chatId, execution.id);
        }
        return transitionExecution(execution, expected, next, terminalReason);
      },
    };
    const started = await runAgenticGeneration({
      userId: USER_ID,
      chatId,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal",
      userInput: "stop through the visible active Agent Run button",
      parameters: { max_tokens: 64 },
    }, dependencies);
    const settled = await waitForAgenticGeneration(started.generationId);

    expect(stopResult?.status).toBe("accepted");
    expect(settled).toMatchObject({ status: "cancelled", phase: "CANCELLED" });
    expect(getTurnExecution(started.generationId, USER_ID)).toMatchObject({
      state: "CANCELLED",
      terminalCode: "cancelled",
      casOwner: null,
    });
    expect(getDb().query(
      "SELECT lifecycle, status, outcome, reason, terminal FROM agent_run_attempts WHERE user_id = ? AND turn_id = ?",
    ).get(USER_ID, started.generationId)).toEqual({
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "stopped",
      reason: "user_stop",
      terminal: 1,
    });
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE user_id = ? AND execution_id = ?",
    ).get(USER_ID, started.generationId)).toEqual({ count: 0 });
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?",
    ).get(chatId)).toEqual({ count: messageCount });
    expect(providerRequestCountAtStop).toBeGreaterThan(providerRequestCount);
    expect(providerRequests).toHaveLength(providerRequestCountAtStop!);
  });

  test("accepted Stop at each dispatch suspension blocks every forward WORK effect", async () => {
    markAgenticRuntimeReady();
    installAgenticGenerationCoordinator();
    for (const scenario of [
      { name: "owner-heartbeat", dispatchesAtStop: 0 },
      { name: "pending-settlement", dispatchesAtStop: 1 },
    ] as const) {
      const chatId = `chat-dispatch-gate-${scenario.name}-${Date.now()}`;
      seedTransientAgenticChat(chatId);
      scriptedWorkRound = 0;
      providerRequests.length = 0;
      let acceptedStop = false;
      let stopError: unknown = null;
      let workspaceRevisionAtStop: number | null = null;
      let releaseAccepted!: () => void;
      const accepted = new Promise<void>((resolve) => { releaseAccepted = resolve; });
      let nextHandle = 0;
      const deps = __testing.buildDependencies({
        timeoutScheduler: {
          setTimeout() { nextHandle += 1; return nextHandle; },
          clearTimeout() {
            if (acceptedStop) return;
            const execution = getDb().query(
              "SELECT id, deadline_at, cas_owner FROM agent_turn_executions WHERE user_id = ? AND chat_id = ? AND state = 'WORK' ORDER BY created_at DESC LIMIT 1",
            ).get(USER_ID, chatId) as { id: string; deadline_at: number; cas_owner: string } | null;
            if (!execution) return;
            const dispatchCount = (getDb().query(
              "SELECT COUNT(*) AS count FROM agent_work_segment_dispatches WHERE user_id = ? AND execution_id = ?",
            ).get(USER_ID, execution.id) as { count: number }).count;
            if (dispatchCount !== scenario.dispatchesAtStop) return;
            try {
              workspaceRevisionAtStop = (getDb().query(
                "SELECT revision FROM agent_turn_workspaces WHERE user_id = ? AND execution_id = ?",
              ).get(USER_ID, execution.id) as { revision: number }).revision;
              const stopped = requestTurnCancellation({
                executionId: execution.id,
                ownerToken: execution.cas_owner,
                reason: "stopped",
                now: Math.min(Date.now(), execution.deadline_at - 1),
              });
              if (stopped.code !== "cancelled") throw new Error("dispatch gate Stop was not accepted");
              acceptedStop = true;
            } catch (error) {
              stopError = error;
            } finally {
              releaseAccepted();
            }
          },
        } as never,
      });
      // The pre-segment heartbeat is handed off only after admission. Using the
      // production plan keeps this suspension on the real admitted-segment
      // path instead of manufacturing an invalid, unsealed child/result slot.
      const scenarioDependencies = deps;

      const started = await runAgenticGeneration({
        userId: USER_ID, chatId, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID,
        generationType: "normal", userInput: `cancel at ${scenario.name}`, parameters: { max_tokens: 64 },
      }, scenarioDependencies);
      await accepted;
      if (stopError) throw stopError;
      if (workspaceRevisionAtStop === null) throw new Error("dispatch gate workspace revision was not captured");
      const markedExecution = getTurnExecution(started.generationId, USER_ID);
      if (!markedExecution) throw new Error("dispatch gate execution disappeared");
      expect(__testing.recoveredWorkFailureCauseV1(
        markedExecution,
        new DOMException("later root deadline", "TimeoutError"),
      )).toEqual({ phase: "CANCELLED", reason: "cancelled", code: "cancelled" });
      const timeoutNow = spyOn(Date, "now").mockReturnValue(markedExecution.deadlineAt);
      try {
        expect(__testing.recoveredWorkFailureCauseV1({
          ...markedExecution, cancelRequested: false, cancelRequestedAt: null,
        }, new DOMException("recovered reconstruction deadline", "TimeoutError"))).toEqual({
          phase: "TIMED_OUT", reason: "root_wall_clock_limit_exceeded", code: "root_wall_clock_limit_exceeded",
        });
      } finally {
        timeoutNow.mockRestore();
      }
      expect(await waitForAgenticGeneration(started.generationId)).toMatchObject({
        status: "cancelled", phase: "CANCELLED",
      });
      expect((getDb().query(
        "SELECT COUNT(*) AS count FROM agent_work_segments WHERE user_id = ? AND execution_id = ?",
      ).get(USER_ID, started.generationId) as { count: number }).count).toBe(1);
      expect((getDb().query(
        "SELECT COUNT(*) AS count FROM agent_work_segment_dispatches WHERE user_id = ? AND execution_id = ?",
      ).get(USER_ID, started.generationId) as { count: number }).count).toBe(scenario.dispatchesAtStop);
      expect((getDb().query(
        "SELECT COUNT(*) AS count FROM agent_work_segment_transitions WHERE user_id = ? AND execution_id = ?",
      ).get(USER_ID, started.generationId) as { count: number }).count).toBe(0);
      expect((getDb().query(
        "SELECT revision FROM agent_turn_workspaces WHERE user_id = ? AND execution_id = ?",
      ).get(USER_ID, started.generationId) as { revision: number }).revision).toBe(workspaceRevisionAtStop);
      expect((getDb().query(
        "SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE user_id = ? AND execution_id = ?",
      ).get(USER_ID, started.generationId) as { count: number }).count).toBe(0);
      expect(providerRequests).toHaveLength(scenario.dispatchesAtStop);
      expect((getDb().query(
        "SELECT COUNT(*) AS count FROM persistent_workspace_tasks WHERE turn_session_id = (SELECT turn_session_id FROM persistent_workspace_turn_sessions WHERE user_id = ? AND execution_id = ?)",
      ).get(USER_ID, started.generationId) as { count: number }).count).toBe(0);
    }
    scriptedWorkRound = 0;
    providerRequests.length = 0;
  });
  test("keeps an accepted pre-deadline Stop cause CANCELLED through terminal close", async () => {
    const chatId = `chat-predeadline-stop-postdeadline-close-${Date.now()}`;
    seedTransientAgenticChat(chatId);
    scriptedWorkBlocked = true;
    const dispatched = new Promise<void>((resolve) => { scriptedWorkDispatchStarted = resolve; });
    const deps = __testing.buildDependencies();
    try {
      const started = await runAgenticGeneration({
        userId: USER_ID,
        chatId,
        connectionId: CONNECTION_ID,
        presetId: AGENTIC_PRESET_ID,
        generationType: "normal",
        userInput: "retain the first pre-deadline Stop cause",
        parameters: { max_tokens: 64 },
      }, deps);
      await dispatched;
      const execution = getDb().query(
        "SELECT deadline_at, cas_owner FROM agent_turn_executions WHERE id = ?",
      ).get(started.generationId) as { deadline_at: number; cas_owner: string };
      expect(requestTurnCancellation({
        executionId: started.generationId,
        ownerToken: execution.cas_owner,
        reason: "stopped",
        now: Date.now(),
      }).code).toBe("cancelled");
      expect(await stopGeneration(USER_ID, started.generationId, chatId)).toBe(true);
      expect((await waitForAgenticGeneration(started.generationId))?.phase).toBe("CANCELLED");
      expectClosedInterruptedWork(started.generationId, "CANCELLED");
    } finally {
      scriptedWorkBlocked = false;
      scriptedWorkDispatchStarted = undefined;
    }
  });

  test("in-flight root deadline closes segmented WORK before TIMED_OUT", async () => {
    markAgenticRuntimeReady();
    installAgenticGenerationCoordinator();
    const chatId = `chat-in-flight-deadline-${Date.now()}`;
    seedTransientAgenticChat(chatId);
    scriptedWorkBlocked = true;
    const dispatched = new Promise<void>((resolve) => { scriptedWorkDispatchStarted = resolve; });
    const deps = __testing.buildDependencies();
    const createExecution = deps.createExecution!;
    try {
      const started = await runAgenticGeneration({
        userId: USER_ID,
        chatId,
        connectionId: CONNECTION_ID,
        presetId: AGENTIC_PRESET_ID,
        generationType: "normal",
        userInput: "time out an in-flight segmented turn",
        parameters: { max_tokens: 64 },
      }, {
        ...deps,
        createExecution: (input) => createExecution({ ...input, deadlineAt: Date.now() + 1_500 }),
      });
      await dispatched;
      expect(await waitForAgenticGeneration(started.generationId)).toMatchObject({
        status: "timed_out",
        phase: "TIMED_OUT",
      });
      expectClosedInterruptedWork(started.generationId, "TIMED_OUT");
    } finally {
      scriptedWorkBlocked = false;
      scriptedWorkDispatchStarted = undefined;
    }
  });

  test("Stop racing past the deadline preserves TIMED_OUT while closing segmented WORK", async () => {
    markAgenticRuntimeReady();
    installAgenticGenerationCoordinator();
    const chatId = `chat-stop-past-deadline-${Date.now()}`;
    seedTransientAgenticChat(chatId);
    scriptedWorkBlocked = true;
    const dispatched = new Promise<void>((resolve) => { scriptedWorkDispatchStarted = resolve; });
    const deps = __testing.buildDependencies();
    const createExecution = deps.createExecution!;
    try {
      const started = await runAgenticGeneration({
        userId: USER_ID,
        chatId,
        connectionId: CONNECTION_ID,
        presetId: AGENTIC_PRESET_ID,
        generationType: "normal",
        userInput: "stop after the durable deadline",
        parameters: { max_tokens: 64 },
      }, {
        ...deps,
        createExecution: (input) => createExecution({ ...input, deadlineAt: Date.now() + 60_000 }),
      });
      await dispatched;
      getDb().query(
        "UPDATE agent_turn_executions SET deadline_at = ? WHERE user_id = ? AND id = ? AND state = 'WORK'",
      ).run(Date.now() - 1, USER_ID, started.generationId);
      expect(await stopGeneration(USER_ID, started.generationId, chatId)).toBe(true);
      expect(await waitForAgenticGeneration(started.generationId)).toMatchObject({
        status: "timed_out",
        phase: "TIMED_OUT",
      });
      expectClosedInterruptedWork(started.generationId, "TIMED_OUT");
    } finally {
      scriptedWorkBlocked = false;
      scriptedWorkDispatchStarted = undefined;
    }
  });

  test("translates stale pre-segment renewal only from exact durable terminal authority", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    await probeIsolateBackendsAtStartup();
    startAgentRuntimeEpoch();
    installAgenticGenerationCoordinator();

    const scenarios = [
      { kind: "cancelled", translated: { name: "AbortError", message: "WORK task mutation cancelled", phase: "CANCELLED", code: "cancelled" } },
      { kind: "timed_out", translated: { name: "TimeoutError", message: "Agentic root deadline", phase: "TIMED_OUT", code: "timed_out" } },
      { kind: "owner_mismatch", translated: null },
      { kind: "phase_mismatch", translated: null },
      { kind: "runtime_epoch_mismatch", translated: null },
    ] as const;

    for (const [index, scenario] of scenarios.entries()) {
      const deps = __testing.buildDependencies();
      const executionId = "exec-presegment-renewal-" + scenario.kind + "-" + Date.now() + "-" + index;
      const input = {
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        connectionId: CONNECTION_ID,
        presetId: AGENTIC_PRESET_ID,
        generationType: "normal" as const,
        userInput: USER_INPUT,
      };
      const target = { generationType: "normal" as const, revision: ADMITTED_TARGET_REVISION };
      const signal = new AbortController().signal;
      const decision = await deps.resolveRuntime!(input, target, signal);
      const snapshot = await deps.buildAssemblySnapshot!(input, decision, target, signal, executionId);
      const plan = await deps.compileAssemblyPlan!(snapshot, input, decision, signal, executionId);
      let execution = await deps.createExecution!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        target,
        decision,
        signal,
      });
      execution = (await deps.transitionExecution!(execution, "ASSEMBLE", "WORK"))!;
      const immutableOwnerToken = execution.ownerToken!;
      const immutableRuntimeEpoch = getTurnExecution(executionId, USER_ID)!.runtimeEpoch;
      const staleOwner = new workSegmentRepository.AgenticWorkSegmentRepositoryError(
        "stale_owner",
        "forced pre-segment renewal race",
      );
      const renewal = spyOn(workSegmentRepository, "renewWorkExecutionOwnerLeaseV1").mockImplementation((renewalInput) => {
        const durable = getTurnExecution(executionId, USER_ID);
        if (!durable) throw new Error("missing durable renewal authority");
        if (scenario.kind === "cancelled" || scenario.kind === "timed_out") {
          if (scenario.kind === "timed_out") {
            getDb().query(
              "UPDATE agent_turn_executions SET deadline_at = ? WHERE user_id = ? AND id = ? AND state = 'WORK'",
            ).run(Date.now() - 1, USER_ID, executionId);
          }
          transitionTurnExecution({
            executionId,
            ownerToken: renewalInput.ownerToken,
            expectedPhase: "WORK",
            nextPhase: scenario.kind === "cancelled" ? "CANCELLED" : "TIMED_OUT",
            reason: scenario.kind === "cancelled" ? "stopped" : "root_wall_clock_limit_exceeded",
          });
        } else if (scenario.kind === "owner_mismatch") {
          getDb().query(
            "UPDATE agent_turn_executions SET cas_owner = ? WHERE user_id = ? AND id = ? AND state = 'WORK'",
          ).run("mismatched-owner", USER_ID, executionId);
        } else if (scenario.kind === "phase_mismatch") {
          transitionTurnExecution({
            executionId,
            ownerToken: renewalInput.ownerToken,
            expectedPhase: "WORK",
            nextPhase: "COMPLETE",
            ignoreCancellation: true,
          });
        } else {
          getDb().query(
            "UPDATE agent_turn_executions SET runtime_epoch = runtime_epoch + 1 WHERE user_id = ? AND id = ? AND state = 'WORK'",
          ).run(USER_ID, executionId);
        }
        throw staleOwner;
      });

      try {
        const work = deps.runWork!({ execution, input, decision, snapshot, plan, signal });
        if (scenario.translated) {
          await expect(work).rejects.toMatchObject({
            name: scenario.translated.name,
            message: scenario.translated.message,
          });
          expect(getTurnExecution(executionId, USER_ID)?.phase).toBe(scenario.translated.phase);
        } else {
          await expect(work).rejects.toBe(staleOwner);
          const durable = getTurnExecution(executionId, USER_ID)!;
          if (scenario.kind === "owner_mismatch") {
            expect(durable).toMatchObject({ phase: "WORK", casOwner: "mismatched-owner", runtimeEpoch: immutableRuntimeEpoch });
          } else if (scenario.kind === "phase_mismatch") {
            expect(durable.phase).toBe("COMPLETE");
          } else {
            expect(durable).toMatchObject({ phase: "WORK", casOwner: immutableOwnerToken, runtimeEpoch: immutableRuntimeEpoch + 1 });
          }
        }
      } finally {
        renewal.mockRestore();
        deps.cleanup!({ executionId } as never);
        getDb().query("DELETE FROM persistent_workspace_turn_sessions WHERE execution_id = ? AND user_id = ?")
          .run(executionId, USER_ID);
        getDb().query("DELETE FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?")
          .run(USER_ID, executionId);
        getDb().query("DELETE FROM agent_turn_executions WHERE user_id = ? AND id = ?")
          .run(USER_ID, executionId);
      }
    }
  });

  test("records every child provider stream outcome exactly once without leaking secrets", async () => {
    const capabilities = new InspectionLifecycleProvider().capabilities;
    const connection = {
      logicalId: "inspection-connection",
      concreteId: "inspection-connection",
      label: "Inspection connection",
      provider: "inspection-lifecycle-provider",
      model: "inspection-model",
      effectiveEndpoint: "https://inspection-lifecycle.invalid/v1",
      endpointRevision: "endpoint-frozen",
      credentialSecretRef: "credential-ref-frozen",
      credentialRevision: "credential-frozen",
      candidateRevision: "candidate-frozen",
      revision: "connection-frozen",
      fingerprint: "source-fingerprint-frozen",
      capabilityDigest: canonicalRuntimeCapabilityDigest(capabilities),
      capabilities,
    } satisfies FrozenConcreteConnectionV1;
    const records: Array<{ kind: string; value: Record<string, unknown>; state: unknown }> = [];
    const writer: AgentInspectionWriterV1 = {
      record: (kind, value, state) => {
        records.push({ kind, value: value as Record<string, unknown>, state });
        return null;
      },
    };
    const authoredCorrelation = __testing.createChildInspectionCorrelation(writer);
    authoredCorrelation.writer!.record("policy", {
      id: "work:child-policy:generated-authored",
      kind: "policy",
      actor: "host",
      recipient: "child",
    });
    expect(records).toHaveLength(0);
    authoredCorrelation.bind("generated-authored", "authored-task-id");
    expect(records[0]?.value.correlation).toEqual({ taskId: "authored-task-id" });
    records.length = 0;
    authoredCorrelation.writer!.record("transcript", {
      id: "tool:work:0:collision-id",
      kind: "delegation",
      actor: "agent",
      recipient: "host",
      correlation: { toolId: "agent_delegate", taskId: "authored-task-a" },
    });
    authoredCorrelation.writer!.record("transcript", {
      id: "work:task:1:authored-task",
      kind: "task",
      actor: "agent",
      recipient: "host",
      correlation: { taskId: "collision-id" },
    });
    expect(records.at(-1)?.value.correlation).toEqual({ taskId: "collision-id" });
    records.length = 0;

    const activityNodes: Array<{ readonly id: string; readonly actor: string; readonly taskId?: string }> = [];
    __testing.recordPublicWorkActivity({
      recordActivityNode: (node) => activityNodes.push({ id: node.id, actor: node.actor, ...(node.taskId ? { taskId: node.taskId } : {}) }),
    }, {
      observations: [{
        sequence: 0,
        callId: "authored-task-a",
        correlationId: "authored-task-a",
        toolName: "workspace_create_task",
        status: "success",
        resultBytes: 0,
      }],
      childResults: [{
        childId: "generated-collision-child",
        profileId: "delegate",
        slotIndex: 0,
        required: true,
        status: "succeeded",
        outputBytes: 1,
      }],
    }, "generation-collision", new Map([[
      "generated-collision-child",
      { taskId: "authored-task-a", frameId: "generated-collision-frame" },
    ]]));
    expect(activityNodes).toEqual([
      { id: expect.stringMatching(/^work-tool:[0-9a-f]{64}$/), actor: "tool" },
      {
        id: expect.stringMatching(/^child-activity:[0-9a-f]{64}$/),
        actor: "child",
        taskId: "authored-task-a",
      },
    ]);
    const intrinsicCorrelation = __testing.createChildInspectionCorrelation(writer);
    intrinsicCorrelation.writer!.record("policy", {
      id: "work:child-policy:generated-intrinsic",
      kind: "policy",
      actor: "host",
      recipient: "child",
    });
    intrinsicCorrelation.bind("generated-intrinsic");
    expect(records[0]?.value.correlation).toEqual({ taskId: "generated-intrinsic" });
    records.length = 0;
    const makeRequest = (controller: AbortController, receiveLimitBytes = 4096): AgenticWorkProviderRequest => ({
      frame: createAgenticChildFrame({
        frameId: "inspection-child-frame",
        parentFrameId: "inspection-root-frame",
        provider: connection.provider,
        connectionId: connection.concreteId,
        model: connection.model,
        coreToolIds: [],
        taskId: "authored-task-id",
        workspaceCapabilities: [],
        signal: controller.signal,
      }),
      connectionId: connection.concreteId,
      model: connection.model,
      messages: [{ role: "user", content: "bounded provider lifecycle" }],
      receiveLimitBytes,
      publishedOutputLimitBytes: 4096,
      tools: [],
      toolMode: "ordinary",
      maxOutputTokens: 32,
      roundIndex: 0,
      signal: controller.signal,
    });
    const outputCapLedger = {
      reserveProviderDispatch: () => ({
        logical: { consume() {}, release() {} },
        physical: { consume() {}, release() {} },
      }),
      acquireProviderPermit: () => ({}),
      releaseOperationPermit() {},
      remaining: () => 0,
      charge: () => false,
    } as unknown as NonNullable<Parameters<typeof __testing.makeWorkProvider>[3]>;
    const dispatch = (request: AgenticWorkProviderRequest, ledger?: typeof outputCapLedger) =>
      __testing.makeWorkProvider(
        USER_ID,
        connection,
        undefined,
        ledger,
        "RAW_CREDENTIAL_SENTINEL",
        (providerRequest, outcome) => __testing.recordChildProviderExchange(
          writer,
          providerRequest,
          outcome,
          connection,
          ADMITTED_CONFIG_REVISION,
          "delegate",
          "generated-child-id",
        ),
      )(request);
    const assertSingleFailure = (reason: string, code: string): void => {
      const exchanges = records.filter((record) => record.kind === "provider_exchange");
      expect(exchanges).toHaveLength(1);
      expect(records.filter((record) => record.kind === "usage")).toHaveLength(0);
      const exchange = exchanges[0]!.value;
      expect(exchange).not.toHaveProperty("content");
      expect(exchange.errorReason).toBe(reason);
      expect(JSON.parse(String(exchange.result))).toEqual(expect.objectContaining({ code }));
      expect(exchange.provider).toEqual({
        adapter: "agentic-work",
        providerId: connection.provider,
        modelId: connection.model,
        connectionId: connection.concreteId,
        configRevision: ADMITTED_CONFIG_REVISION,
        connectionRevision: connection.candidateRevision,
        fingerprint: connection.fingerprint,
      });
      expect(exchange.correlation).toEqual({
        taskId: "authored-task-id",
        parentId: "inspection-root-frame",
      });
      const encoded = JSON.stringify(records);
      expect(encoded).not.toContain("RAW_CREDENTIAL_SENTINEL");
      expect(encoded).not.toContain("provider-secret");
      expect(encoded).not.toContain("abort-secret");
    };

    inspectionProviderScenario = "success";
    await dispatch(makeRequest(new AbortController()));
    expect(records.filter((record) => record.kind === "provider_exchange")).toHaveLength(1);
    expect(records.filter((record) => record.kind === "usage")).toHaveLength(1);
    records.length = 0;

    for (const [scenario, reason, code, receiveLimitBytes, ledger] of [
      ["throw_after_yield", "provider_failure", "provider_failure", 4096, undefined],
      ["timeout_after_yield", "provider_failure", "provider_failure", 4096, undefined],
      ["receive_cap", "budget_exhausted", "limit_exceeded", 32, undefined],
      ["output_cap", "budget_exhausted", "child_output_limit_exceeded", 4096, outputCapLedger],
    ] as const) {
      inspectionProviderScenario = scenario;
      await expect(dispatch(makeRequest(new AbortController(), receiveLimitBytes), ledger)).rejects.toBeDefined();
      assertSingleFailure(reason, code);
      records.length = 0;
    }
    inspectionProviderScenario = "success";
    await expect(dispatch({ ...makeRequest(new AbortController()), publishedOutputLimitBytes: 1 })).rejects.toBeDefined();
    assertSingleFailure("budget_exhausted", "child_output_limit_exceeded");
    records.length = 0;

    inspectionProviderScenario = "abort_after_yield";
    const controller = new AbortController();
    const yielded = new Promise<void>((resolve) => { inspectionProviderYielded = resolve; });
    const pending = dispatch(makeRequest(controller));
    await yielded;
    controller.abort(new DOMException("abort-secret", "AbortError"));
    await expect(pending).rejects.toBeDefined();
    assertSingleFailure("interrupted", "cancelled");
    inspectionProviderYielded = undefined;
    inspectionProviderScenario = "success";
    const persistedAttemptId = "inspection-provider-failure-persisted";
    const persistedWriter = createAgentInspectionWriter({
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      attemptId: persistedAttemptId,
      runId: persistedAttemptId,
      turnSessionId: persistedAttemptId,
      generationId: persistedAttemptId,
      generationType: "normal",
      hostCorrelationId: persistedAttemptId,
      lifecycle: "WORK",
      status: "running",
    });
    const persistedDispatch = (request: AgenticWorkProviderRequest) =>
      __testing.makeWorkProvider(
        USER_ID,
        connection,
        undefined,
        undefined,
        "RAW_CREDENTIAL_SENTINEL",
        (providerRequest, outcome) => __testing.recordChildProviderExchange(
          persistedWriter,
          providerRequest,
          outcome,
          connection,
          ADMITTED_CONFIG_REVISION,
          "delegate",
          "generated-child-id",
        ),
      )(request);
    inspectionProviderScenario = "throw_after_yield";
    await expect(persistedDispatch(makeRequest(new AbortController()))).rejects.toBeDefined();
    const persistedInspection = getAgentRunInspection(USER_ID, persistedAttemptId, AGENTIC_CHAT_ID);
    expect(persistedInspection?.transcript.filter((record) => record.kind === "provider_exchange")).toHaveLength(1);
    expect(JSON.stringify(persistedInspection)).not.toContain("RAW_CREDENTIAL_SENTINEL");
    expect(JSON.stringify(persistedInspection)).not.toContain("provider-secret");
    inspectionProviderScenario = "success";
  });

  test("scopes repeated provider call identities across durable Segments and crash retries", () => {
    const executionId = "scoped-provider-call-execution";
    const providerCallId = "provider-reused-call-id";
    const scopes = [
      { executionId, segmentId: "durable-segment-before-crash", logicalDispatch: 0 },
      { executionId, segmentId: "durable-segment-after-resume", logicalDispatch: 0 },
      { executionId, segmentId: "durable-segment-after-resume", logicalDispatch: 1 },
      { executionId, segmentId: "durable-segment-after-resume", logicalDispatch: 1 },
    ] as const;
    const identities = scopes.map((scope) => __testing.createWorkDispatchIdentityAuthorityV1(scope));
    const providerExchangeIds = identities.map((identity) => identity.providerExchangeId());
    const publicActivityIds = scopes.map((scope) =>
      __testing.publicWorkActivityNodeIdV1(scope, providerCallId));
    const childIdentities = identities.map((identity) =>
      identity.delegateInvocationIdentity({ providerCallId }));

    expect(providerExchangeIds[0]).not.toBe(providerExchangeIds[1]);
    expect(providerExchangeIds[1]).not.toBe(providerExchangeIds[2]);
    expect(providerExchangeIds[2]).toBe(providerExchangeIds[3]);
    expect(publicActivityIds[0]).not.toBe(publicActivityIds[1]);
    expect(publicActivityIds[1]).not.toBe(publicActivityIds[2]);
    expect(publicActivityIds[2]).toBe(publicActivityIds[3]);
    expect(childIdentities[0]!.invocationId).not.toBe(childIdentities[1]!.invocationId);
    expect(childIdentities[1]!.invocationId).not.toBe(childIdentities[2]!.invocationId);
    expect(childIdentities[2]).toEqual(childIdentities[3]);
    expect(new Set(childIdentities.slice(0, 3).map(({ childFrameId }) => childFrameId))).toHaveLength(3);

    const attemptId = "scoped-provider-call-inspection";
    const auditWriter = createAgentInspectionWriter({
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      attemptId,
      runId: attemptId,
      turnSessionId: attemptId,
      generationId: executionId,
      generationType: "normal",
      hostCorrelationId: executionId,
      lifecycle: "WORK",
      status: "running",
    });
    for (const id of providerExchangeIds) {
      auditWriter.record("provider_exchange", {
        id,
        kind: "provider_exchange",
        actor: "provider",
        recipient: "agent",
        content: "",
        arguments: JSON.stringify({ callId: providerCallId }),
        result: JSON.stringify({ finishReason: "tool_calls" }),
        provider: {
          adapter: "agentic-work",
          providerId: "scripted-coordinator",
          modelId: "scripted-model",
          connectionId: CONNECTION_ID,
          configRevision: ADMITTED_CONFIG_REVISION,
          connectionRevision: "connection-frozen",
          fingerprint: "source-fingerprint-frozen",
        },
        correlation: { parentId: executionId },
      });
    }
    const auditChronology = getAgentRunInspection(USER_ID, attemptId, AGENTIC_CHAT_ID)?.transcript
      .filter((record) => record.kind === "provider_exchange") ?? [];
    expect(auditChronology.map(({ id }) => id)).toEqual(providerExchangeIds.slice(0, 3));

    const activityNodes: Array<{ readonly id: string; readonly actor: string; readonly taskId?: string }> = [];
    const seenNodeIds = new Set<string>();
    const publicActivityNodeIdsByCallId = new Map([[providerCallId, [...publicActivityIds]]]);
    const authoredTaskId = "same-authored-task-across-frames";
    const childActivityIdentities = new Map(childIdentities.slice(0, 3).map(({ childFrameId }) =>
      [childFrameId, { taskId: authoredTaskId, frameId: childFrameId }] as const));
    __testing.recordPublicWorkActivity({
      recordActivityNode: (node) => activityNodes.push({ id: node.id, actor: node.actor, taskId: node.taskId }),
    }, {
      observations: scopes.map((_, sequence) => ({
        sequence: sequence === 3 ? 2 : sequence,
        callId: providerCallId,
        correlationId: providerCallId,
        toolName: "workspace_create_task",
        status: "success" as const,
        resultBytes: 0,
      })),
      childResults: childIdentities.map(({ childFrameId }, slotIndex) => ({
        childId: childFrameId,
        profileId: "delegate",
        slotIndex: slotIndex === 3 ? 2 : slotIndex,
        required: true,
        status: "succeeded" as const,
        outputBytes: 1,
      })),
    }, executionId, childActivityIdentities, seenNodeIds, publicActivityNodeIdsByCallId);

    expect(activityNodes.filter(({ actor }) => actor === "tool").map(({ id }) => id))
      .toEqual(publicActivityIds.slice(0, 3));
    const childActivityNodes = activityNodes.filter(({ actor }) => actor === "child");
    expect(childActivityNodes).toEqual(childIdentities.slice(0, 3).map(({ childFrameId }) => ({
      id: "child-activity:" + createHash("sha256").update(encodeCanonicalPlainData({
        version: 1, generationId: executionId, childFrameId, taskId: authoredTaskId,
      }), "utf8").digest("hex"),
      actor: "child",
      taskId: authoredTaskId,
    })));
    expect(activityNodes.map(({ actor }) => actor)).toEqual([
      "tool", "tool", "tool", "child", "child", "child",
    ]);
    expect(publicActivityNodeIdsByCallId.size).toBe(0);
  });

  test("bounds persistent recovery while prioritizing receipt-backed committed sessions", () => {
    const db = getDb();
    const chatId = "chat:persistent-recovery-budget";
    const workspaceId = "workspace:persistent-recovery-budget";
    const priorityExecutionId = "persistent-recovery-priority-execution";
    const now = Date.now();
    const maxRows = __testing.persistentRecoveryLimits.maxRows;
    seedTransientAgenticChat(chatId);
    db.query(
      "INSERT INTO persistent_workspaces (workspace_id, user_id, chat_id, objective) VALUES (?, ?, ?, ?)",
    ).run(workspaceId, USER_ID, chatId, "bounded recovery");
    seedCommittedExecution(priorityExecutionId, chatId);
    const insertSession = db.query(`
      INSERT INTO persistent_workspace_turn_sessions (
        turn_session_id, workspace_id, user_id, chat_id, turn_id, attempt_id,
        execution_id, phase, status, outcome, reason, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertSession.run(
      "persistent-recovery-priority-session",
      workspaceId,
      USER_ID,
      chatId,
      priorityExecutionId,
      priorityExecutionId,
      priorityExecutionId,
      "WORK",
      "running",
      null,
      "none",
      0,
      now,
      now,
    );
    for (let index = 0; index < maxRows + 1; index += 1) {
      const id = `persistent-recovery-overflow-${index}`;
      insertSession.run(
        id,
        workspaceId,
        USER_ID,
        chatId,
        `persistent-recovery-turn-${index}`,
        `persistent-recovery-attempt-${index}`,
        null,
        "WORK",
        "running",
        null,
        "none",
        0,
        now,
        now,
      );
    }
    try {
      const recovery = __testing.reconcilePersistentWorkspaceSessions();
      expect(recovery.complete).toBe(false);
      expect(recovery.inspected).toBeLessThanOrEqual(maxRows);
      expect(db.query(
        "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE turn_session_id = ?",
      ).get("persistent-recovery-priority-session")).toEqual({
        phase: "TERMINAL",
        status: "terminal",
        outcome: "completed",
      });
      expect((db.query(
        "SELECT COUNT(*) AS count FROM persistent_workspace_turn_sessions WHERE workspace_id = ? AND status <> 'terminal'",
      ).get(workspaceId) as { count: number }).count).toBeGreaterThan(0);
    } finally {
      db.query("DELETE FROM persistent_workspace_turn_sessions WHERE workspace_id = ?").run(workspaceId);
      db.query("DELETE FROM persistent_workspaces WHERE workspace_id = ?").run(workspaceId);
      db.query("DELETE FROM agent_turn_commit_receipts WHERE execution_id = ?").run(priorityExecutionId);
      db.query("DELETE FROM agent_turn_executions WHERE id = ?").run(priorityExecutionId);
      db.query("DELETE FROM agent_turn_workspaces WHERE turn_id = ?").run(priorityExecutionId);
      deleteChat(USER_ID, chatId);
    }
  });

  test("fails coordinator installation closed when persistent recovery is incomplete", () => {
    const db = getDb();
    __testing.resetInstallation();
    db.run("ALTER TABLE agent_turn_commit_receipts RENAME TO agent_turn_commit_receipts_unavailable");
    try {
      expect(() => installAgenticGenerationCoordinator()).toThrow("persistent session recovery incomplete");
    } finally {
      db.run("ALTER TABLE agent_turn_commit_receipts_unavailable RENAME TO agent_turn_commit_receipts");
      __testing.resetInstallation();
      installAgenticGenerationCoordinator();
    }
  });
  test("rolls back the persistent session when receipt projection repair fails", () => {
    const db = getDb();
    const chatId = "chat:persistent-recovery-projection-failure";
    const workspaceId = "workspace:persistent-recovery-projection-failure";
    const executionId = "persistent-recovery-projection-failure-execution";
    const sessionId = "persistent-recovery-projection-failure-session";
    const now = Date.now();
    seedTransientAgenticChat(chatId);
    db.query(
      "INSERT INTO persistent_workspaces (workspace_id, user_id, chat_id, objective) VALUES (?, ?, ?, ?)",
    ).run(workspaceId, USER_ID, chatId, "projection failure");
    seedCommittedExecution(executionId, chatId);
    db.query(`
      INSERT INTO persistent_workspace_turn_sessions (
        turn_session_id, workspace_id, user_id, chat_id, turn_id, attempt_id,
        execution_id, phase, status, outcome, reason, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'WORK', 'running', NULL, 'none', 0, ?, ?)
    `).run(
      sessionId,
      workspaceId,
      USER_ID,
      chatId,
      executionId,
      executionId,
      executionId,
      now,
      now,
    );
    db.run(`
      CREATE TRIGGER persistent_recovery_projection_failure_insert
      BEFORE INSERT ON agent_run_projections
      BEGIN
        SELECT RAISE(ABORT, 'injected persistent receipt projection failure');
      END
    `);
    db.run(`
      CREATE TRIGGER persistent_recovery_projection_failure_update
      BEFORE UPDATE ON agent_run_projections
      BEGIN
        SELECT RAISE(ABORT, 'injected persistent receipt projection failure');
      END
    `);
    try {
      const recovery = __testing.reconcilePersistentWorkspaceSessions();
      expect(recovery.complete).toBe(false);
      expect(db.query(
        "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE turn_session_id = ?",
      ).get(sessionId)).toEqual({
        phase: "WORK",
        status: "running",
        outcome: null,
      });
    } finally {
      db.run("DROP TRIGGER persistent_recovery_projection_failure_insert");
      db.run("DROP TRIGGER persistent_recovery_projection_failure_update");
      db.query("DELETE FROM persistent_workspace_turn_sessions WHERE workspace_id = ?").run(workspaceId);
      db.query("DELETE FROM persistent_workspaces WHERE workspace_id = ?").run(workspaceId);
      db.query("DELETE FROM agent_turn_commit_receipts WHERE execution_id = ?").run(executionId);
      db.query("DELETE FROM agent_turn_executions WHERE id = ?").run(executionId);
      db.query("DELETE FROM agent_turn_workspaces WHERE turn_id = ?").run(executionId);
      deleteChat(USER_ID, chatId);
    }
  });
  test("never invents terminal outcomes for persistent sessions without an execution owner", () => {
    const db = getDb();
    const chatId = "chat:persistent-recovery-slow-clock";
    const workspaceId = "workspace:persistent-recovery-slow-clock";
    const firstSessionId = "persistent-recovery-slow-a";
    const secondSessionId = "persistent-recovery-slow-b";
    seedTransientAgenticChat(chatId);
    db.query(
      "INSERT INTO persistent_workspaces (workspace_id, user_id, chat_id, objective) VALUES (?, ?, ?, ?)",
    ).run(workspaceId, USER_ID, chatId, "slow recovery");
    const insertSession = db.query(`
      INSERT INTO persistent_workspace_turn_sessions (
        turn_session_id, workspace_id, user_id, chat_id, turn_id, attempt_id,
        execution_id, phase, status, outcome, reason, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'WORK', 'running', NULL, 'none', 0, ?, ?)
    `);
    insertSession.run(
      firstSessionId,
      workspaceId,
      USER_ID,
      chatId,
      "persistent-recovery-slow-turn-a",
      "persistent-recovery-slow-attempt-a",
      100,
      100,
    );
    insertSession.run(
      secondSessionId,
      workspaceId,
      USER_ID,
      chatId,
      "persistent-recovery-slow-turn-b",
      "persistent-recovery-slow-attempt-b",
      200,
      200,
    );
    const clockValues = [1_000, 1_000, 1_000, 6_000];
    let clockIndex = 0;
    __testing.setPersistentRecoveryClock(() => clockValues[Math.min(clockIndex++, clockValues.length - 1)]!);
    try {
      const blocked = __testing.reconcilePersistentWorkspaceSessions();
      expect(blocked.complete).toBe(false);
      expect(blocked.recovered).toBe(0);
      expect(db.query(
        "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE turn_session_id = ?",
      ).get(firstSessionId)).toEqual({
        phase: "WORK",
        status: "running",
        outcome: null,
      });
      expect(db.query(
        "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE turn_session_id = ?",
      ).get(secondSessionId)).toEqual({
        phase: "WORK",
        status: "running",
        outcome: null,
      });
      __testing.setPersistentRecoveryClock(null);
      const recovered = __testing.reconcilePersistentWorkspaceSessions();
      expect(recovered.complete).toBe(false);
      expect(recovered.recovered).toBe(0);
      expect(db.query(
        "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE turn_session_id = ?",
      ).get(secondSessionId)).toEqual({
        phase: "WORK",
        status: "running",
        outcome: null,
      });
    } finally {
      __testing.setPersistentRecoveryClock(null);
      db.query("DELETE FROM persistent_workspace_turn_sessions WHERE workspace_id = ?").run(workspaceId);
      db.query("DELETE FROM persistent_workspaces WHERE workspace_id = ?").run(workspaceId);
      deleteChat(USER_ID, chatId);
    }
  });
  test("authenticates the root caller before assigning child tasks", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    await probeIsolateBackendsAtStartup();
    startAgentRuntimeEpoch();
    installAgenticGenerationCoordinator();
    const deps = __testing.buildDependencies();
    const input = {
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal" as const,
      userInput: USER_INPUT,
      parameters: { max_tokens: 128 },
    };
    const target = { generationType: "normal" as const };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!(input, target, signal);
    const execution = await deps.createExecution!({
      executionId: `exec-auth-${Date.now()}`,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      signal,
    });
    const rootSignal = execution.signal;
    if (!rootSignal) throw new Error("Agentic execution signal was not installed");
    const capabilities = {
      revision: 1,
      allowed: WORKSPACE_OPERATIONS,
      maxOperationBytes: 131_072,
      maxOperations: 128,
    };
    const workspace = __testing.makeWorkspace(execution, capabilities);
    const rootFrame = createAgenticRootFrame({
      frameId: execution.id,
      connectionId: null,
      model: "",
      coreToolIds: [],
      workspaceCapabilities: WORKSPACE_OPERATIONS,
      signal: rootSignal,
    });
    const reserveMutation = (
      providerCallId: string,
      operationKind: AgenticWorkMutatingWorkspaceOperationKindV1,
      frameId: string,
    ): AgenticWorkWorkspaceMutationReservationV1 => durableWorkspaceMutationReservation({
      executionId: execution.id,
      workspaceId: `workspace:` + execution.id,
      providerCallId,
      operationKind,
      frameId,
    });
    try {
      await workspace.execute?.(
        "create_task",
        {
          taskId: "task-auth",
          title: "Authenticated assignment",
          objective: "Verify root caller binding.",
          dependencyIds: [],
        },
        { actor: "root", frame: rootFrame, operation: "create_task", reservation: reserveMutation("auth:create-task", "create_task", rootFrame.frameId), signal: rootSignal },
      );
      const before = getDb().query(
        "SELECT assigned_frame_id, revision FROM agent_workspace_tasks WHERE turn_id = ? AND task_id = ?",
      ).get(execution.id, "task-auth") as { assigned_frame_id: string | null; revision: number } | null;
      expect(before).toEqual({ assigned_frame_id: null, revision: 0 });
      const expectedRevision = (getDb().query(
        "SELECT revision FROM agent_turn_workspaces WHERE workspace_id = ?",
      ).get(`workspace:${execution.id}`) as { revision: number }).revision;
      const assignments = [{ taskId: "task-auth", frameId: "forged-child-frame" }];
      const forgedChild = createAgenticChildFrame({
        frameId: "forged-child-frame",
        parentFrameId: execution.id,
        provider: "scripted-coordinator",
        connectionId: CONNECTION_ID,
        model: "scripted-model",
        coreToolIds: [],
        taskId: "task-auth",
        workspaceCapabilities: ["update_assigned_progress"],
        signal: rootSignal,
      });
      await expect(workspace.assignChildTasks?.({
        frame: forgedChild,
        assignments,
        reservation: reserveMutation("auth:forged-assignment", "assign_child_tasks", forgedChild.frameId),
        expectedRevision,
        signal: rootSignal,
      })).rejects.toThrow("workspace_assignment_root_required");
      const afterChild = getDb().query(
        "SELECT assigned_frame_id, revision FROM agent_workspace_tasks WHERE turn_id = ? AND task_id = ?",
      ).get(execution.id, "task-auth") as { assigned_frame_id: string | null; revision: number } | null;
      expect(afterChild).toEqual(before);

      const otherExecution = await deps.createExecution!({
        executionId: `${execution.id}-other`,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        target,
        decision,
        signal,
      });
      try {
        if (!otherExecution.signal) throw new Error("Cross-execution signal was not installed");
        const crossRoot = createAgenticRootFrame({
          frameId: otherExecution.id,
          connectionId: null,
          model: "",
          coreToolIds: [],
          workspaceCapabilities: WORKSPACE_OPERATIONS,
          signal: otherExecution.signal,
        });
        await expect(workspace.assignChildTasks?.({
          frame: crossRoot,
          assignments,
          reservation: reserveMutation("auth:cross-assignment", "assign_child_tasks", crossRoot.frameId),
          expectedRevision,
          signal: rootSignal,
        })).rejects.toThrow("workspace_assignment_root_required");
        const afterCrossExecution = getDb().query(
          "SELECT assigned_frame_id, revision FROM agent_workspace_tasks WHERE turn_id = ? AND task_id = ?",
        ).get(execution.id, "task-auth") as { assigned_frame_id: string | null; revision: number } | null;
        expect(afterCrossExecution).toEqual(before);
      } finally {
        deps.cleanup?.({ execution: otherExecution } as never);
      }

      const valid = await workspace.assignChildTasks?.({
        frame: rootFrame,
        assignments: [{ taskId: "task-auth", frameId: "valid-child-frame" }],
        reservation: reserveMutation("auth:valid-assignment", "assign_child_tasks", rootFrame.frameId),
        expectedRevision,
        signal: rootSignal,
      });
      expect(valid).toMatchObject({
        accepted: true,
        assignments: [{ taskId: "task-auth", frameId: "valid-child-frame" }],
      });
      const persisted = getDb().query(
        "SELECT assigned_frame_id FROM agent_workspace_tasks WHERE turn_id = ? AND task_id = ?",
      ).get(execution.id, "task-auth") as { assigned_frame_id: string | null } | null;
      expect(persisted).toEqual({ assigned_frame_id: "valid-child-frame" });
      const createdRoot = await workspace.execute?.(
        "create_task",
        {
          taskId: "root-result-auth",
          title: "Root result task",
          objective: "Verify root-only completion.",
          dependencyIds: [],
        },
        { actor: "root", frame: rootFrame, operation: "create_task", reservation: reserveMutation("auth:create-root-task", "create_task", rootFrame.frameId), signal: rootSignal },
      );
      expect(createdRoot).toMatchObject({
        result: expect.objectContaining({ id: "root-result-auth" }),
      });
      const rootResultChild = createAgenticChildFrame({
        frameId: "root-result-child",
        parentFrameId: execution.id,
        provider: "scripted-coordinator",
        connectionId: CONNECTION_ID,
        model: "scripted-model",
        coreToolIds: [],
        taskId: "root-result-auth",
        workspaceCapabilities: ["submit_child_result"],
        signal: rootSignal,
      });
      await expect(workspace.execute?.(
        "submit_root_result",
        { taskId: "root-result-auth", summary: "Child cannot complete a root task.", state: "completed" },
        { actor: "child", frame: rootResultChild, operation: "submit_root_result", reservation: reserveMutation("auth:forged-root-result", "submit_root_result", rootResultChild.frameId), signal: rootSignal },
      )).rejects.toThrow();
      const rootResult = await workspace.execute?.(
        "submit_root_result",
        { taskId: "root-result-auth", summary: "Root completed its own task.", state: "completed" },
        { actor: "root", frame: rootFrame, operation: "submit_root_result", reservation: reserveMutation("auth:root-result", "submit_root_result", rootFrame.frameId), signal: rootSignal },
      );
      expect(rootResult).toMatchObject({
        result: expect.objectContaining({ id: "root-result-auth" }),
      });
      expect(getDb().query(
        "SELECT state, assigned_frame_id FROM agent_workspace_tasks WHERE turn_id = ? AND task_id = ?",
      ).get(execution.id, "root-result-auth")).toEqual({ state: "completed", assigned_frame_id: null });
      const settleAssignedTask = workspace.settleAssignedTask;
      if (!settleAssignedTask) throw new Error("Coordinator settlement capability is unavailable");
      await expect(settleAssignedTask({
        taskId: "task-auth",
        frameId: "valid-child-frame",
        state: "failed",
        reservation: reserveMutation("coordinator-test-forged-settlement", "settle_child_task", "valid-child-frame"),
        signal: rootSignal,
      })).rejects.toThrow("WORK child settlement reservation is invalid");
      const settled = await settleAssignedTask({
        taskId: "task-auth",
        frameId: "valid-child-frame",
        state: "failed",
        reservation: reserveMutation("coordinator-test-settlement", "settle_child_task", rootFrame.frameId),
        signal: rootSignal,
      });
      expect(settled).toMatchObject({ accepted: true });
      expect(getDb().query(
        "SELECT state, assigned_frame_id FROM agent_workspace_tasks WHERE turn_id = ? AND task_id = ?",
      ).get(execution.id, "task-auth")).toEqual({ state: "failed", assigned_frame_id: "valid-child-frame" });
    } finally {
      deps.cleanup?.({ execution } as never);
    }
  });
  test("preserves the pre-cancel workspace revision when a raced durable result is newer", () => {
    const owner = new AgentRuntimeOwner({
      generationId: "revision-race",
      userId: USER_ID,
      config: createDisabledAgentConfigV2(),
      rootConnection: null,
      dispatch: async () => ({
        content: "",
        finish_reason: "stop",
        toolContinuationMode: "native",
        supportsToolFinalization: true,
      }),
    });
    const execution = {
      id: "revision-race",
      userId: USER_ID,
      chatId: CHAT_ID,
      workspaceId: "workspace-revision-race",
      workspaceRevision: 3,
      workspaceRetention: "turn_terminal" as const,
      workspaceSharing: "root_only" as const,
      deadlineAt: Date.now() + 60_000,
      owner,
      credentialCarrier: new Map<string, string>(),
    };
    try {
      const outcome = { status: "cancelled" as const, workspaceRevision: 9 };
      const adopted = __testing.adoptWorkWorkspaceRevision(execution, outcome);
      expect(adopted).toBe(3);
      expect(execution.workspaceRevision).toBe(3);
    } finally {
      owner.close();
    }
  });

  test("fails closed to Response when startup readiness is incomplete", async () => {
    setAgenticRuntimeReadiness({
      schema: true,
      reconciliation: true,
      archiveRegistry: true,
      publicationStore: true,
      isolateTermination: false,
    });
    installAgenticGenerationCoordinator();
    const decision = await resolveEffectiveRuntime(USER_ID, {
      chatId: CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: PRESET_ID,
      generationType: "normal",
      target: { generationType: "normal", messageId: null, swipeId: null, revision: 0 },
      mode: "agentic",
      requestEpoch: 1,
    });
    expect(decision.effectiveMode).toBe("response");
    expect(decision.capabilityReadiness.responseEscape).toBe("available");
    expect(decision.repairCodes.length).toBeGreaterThan(0);
  });

  test("resolution reads real input revisions, never a fabricated startup constant", async () => {
    markAgenticRuntimeReady();
    installAgenticGenerationCoordinator();
    const decision = await resolveEffectiveRuntime(USER_ID, {
      chatId: CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: PRESET_ID,
      generationType: "normal",
      target: { generationType: "normal", messageId: null, swipeId: null, revision: 0 },
      mode: "agentic",
      requestEpoch: 2,
    });
    const readiness = decision.internal.readinessVector;
    expect(readiness.inputRevisionDigest.length).toBeGreaterThan(0);
    expect(String(readiness.archiveRegistryVersion)).not.toBe("0");
    expect(String(readiness.isolateHealthEpoch)).toBe(String(getIsolateHealthEpoch()));
    // Startup placeholders used the literal `startup-*` digests; the canonical
    // snapshot must not produce them.
    expect(JSON.stringify(decision.internal.binding)).not.toContain("startup-");
  });

  test("authority Stop reaches one durable effective-Agentic owner across admission handoffs", async () => {
    markAgenticRuntimeReady();
    installAgenticGenerationCoordinator();

    for (const [index, stopTiming] of [
      "before_request_registration",
      "during_admission",
      "after_result_handoff",
    ].entries()) {
      const authorityId = crypto.randomUUID();
      const requestEpoch = 301 + index;
      const decision = await resolveEffectiveRuntime(USER_ID, {
        chatId: AGENTIC_CHAT_ID,
        logicalConnectionId: CONNECTION_ID,
        presetId: AGENTIC_PRESET_ID,
        generationType: "normal",
        target: { generationType: "normal", messageId: null, swipeId: null },
        mode: "agentic",
        requestEpoch,
      });
      expect(decision.effectiveMode).toBe("agentic");
      expect(decision.runtimeDecisionToken).toBeTruthy();
      const priorExecutionIds = new Set((getDb().query(
        "SELECT id FROM agent_turn_executions WHERE user_id = ? AND chat_id = ?",
      ).all(USER_ID, AGENTIC_CHAT_ID) as Array<{ id: string }>).map((row) => row.id));
      const priorAttemptIds = new Set((getDb().query(
        "SELECT attempt_id FROM agent_run_attempts WHERE user_id = ? AND chat_id = ?",
      ).all(USER_ID, AGENTIC_CHAT_ID) as Array<{ attempt_id: string }>).map((row) => row.attempt_id));
      const providerRequestCount = providerRequests.length;
      const messageCount = (getDb().query(
        "SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?",
      ).get(AGENTIC_CHAT_ID) as { count: number }).count;

      if (stopTiming === "before_request_registration") {
        expect(await stopGenerationRequestAuthority(USER_ID, AGENTIC_CHAT_ID, authorityId)).toBe(true);
      }
      const starting = startGeneration({
        userId: USER_ID,
        chat_id: AGENTIC_CHAT_ID,
        connection_id: CONNECTION_ID,
        preset_id: AGENTIC_PRESET_ID,
        generation_type: "normal",
        mode: "agentic",
        runtime_decision_token: decision.runtimeDecisionToken!,
        request_epoch: requestEpoch,
        request_authority_id: authorityId,
        user_input: USER_INPUT,
        parameters: { max_tokens: 256 },
      });

      let handedOffGenerationId: string | undefined;
      if (stopTiming === "after_result_handoff") {
        const handedOff = await starting;
        handedOffGenerationId = handedOff.generationId;
        const handoffStops = await Promise.all([
          stopGenerationRequestAuthority(USER_ID, AGENTIC_CHAT_ID, authorityId),
          stopGenerationRequestAuthority(USER_ID, AGENTIC_CHAT_ID, authorityId),
        ]);
        expect(handoffStops.every((result) => result !== false)).toBe(true);
      } else {
        const outcome = starting.then(
          (result) => ({ result, error: null }),
          (error) => ({ result: null, error }),
        );
        if (stopTiming === "during_admission") {
          expect(await stopGenerationRequestAuthority(USER_ID, AGENTIC_CHAT_ID, authorityId)).toBe(true);
        }
        const settled = await outcome;
        expect(settled.result).toBeNull();
        expect(settled.error).toMatchObject({ name: "AbortError" });
      }

      const executions = (getDb().query(
        "SELECT id FROM agent_turn_executions WHERE user_id = ? AND chat_id = ?",
      ).all(USER_ID, AGENTIC_CHAT_ID) as Array<{ id: string }>).filter(
        (row) => !priorExecutionIds.has(row.id),
      );
      expect(executions).toHaveLength(1);
      const executionId = executions[0]!.id;
      if (handedOffGenerationId !== undefined) expect(executionId).toBe(handedOffGenerationId);
      await waitForAgenticGeneration(executionId);

      expect(getDb().query(
        "SELECT state, terminal_code, cas_owner FROM agent_turn_executions WHERE user_id = ? AND id = ?",
      ).get(USER_ID, executionId)).toEqual({
        state: "CANCELLED",
        terminal_code: "cancelled",
        cas_owner: null,
      });
      const attempts = (getDb().query(
        "SELECT attempt_id, lifecycle, status, outcome, reason, terminal FROM agent_run_attempts WHERE user_id = ? AND chat_id = ?",
      ).all(USER_ID, AGENTIC_CHAT_ID) as Array<{
        attempt_id: string;
        lifecycle: string;
        status: string;
        outcome: string | null;
        reason: string | null;
        terminal: number;
      }>).filter((row) => !priorAttemptIds.has(row.attempt_id));
      expect(attempts).toEqual([{
        attempt_id: executionId,
        lifecycle: "TERMINAL",
        status: "terminal",
        outcome: "stopped",
        reason: "user_stop",
        terminal: 1,
      }]);

      const projection = getDb().query(
        "SELECT status, snapshot_json FROM agent_run_projections WHERE user_id = ? AND turn_id = ?",
      ).get(USER_ID, executionId) as { status: string; snapshot_json: string } | null;
      expect(projection?.status).toBe("CANCELLED");
      const snapshot = JSON.parse(projection?.snapshot_json ?? "{}") as {
        workPhase?: string;
        workStatus?: string;
        workOutcome?: string;
        reason?: string;
        activity?: Array<Record<string, unknown>>;
      };
      expect(snapshot).toMatchObject({
        workPhase: "TERMINAL",
        workStatus: "terminal",
        workOutcome: "stopped",
        reason: "stopped",
      });
      expect(snapshot.activity).toEqual([expect.objectContaining({
        kind: "root",
        actor: "root",
        phase: "TERMINAL",
        status: "cancelled",
      })]);
      const inspection = getAgentRunInspection(USER_ID, executionId, AGENTIC_CHAT_ID);
      expect(inspection).toMatchObject({
        lifecycle: "TERMINAL",
        status: "terminal",
        outcome: "stopped",
        reason: "user_stop",
        hostCorrelationId: "agentic:" + executionId + ":" + executionId,
      });
      expect(inspection?.error).toEqual({
        version: 1,
        inspectionAttemptId: executionId,
        code: "cancelled",
        category: "cancelled",
        summaryCode: "agentRun.errors.cancelled",
        causalCode: null,
        authority: "host",
        source: "execution",
        scope: "run",
        capGate: null,
        target: {
          chatId: AGENTIC_CHAT_ID,
          generationType: "normal",
          messageId: null,
          swipeId: null,
        },
        workPhase: "TERMINAL",
        workStatus: "terminal",
        workOutcome: "stopped",
        reason: "user_stop",
        recoveryEligible: true,
        recoveryAction: "retry",
        omissionCount: 0,
      });
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM agent_activity_runs WHERE user_id = ? AND chat_id = ? AND generation_id = ?",
      ).get(USER_ID, AGENTIC_CHAT_ID, executionId)).toEqual({ count: 1 });
      expect(providerRequests).toHaveLength(providerRequestCount);
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE user_id = ? AND execution_id = ?",
      ).get(USER_ID, executionId)).toEqual({ count: 0 });
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?",
      ).get(AGENTIC_CHAT_ID)).toEqual({ count: messageCount });
    }
  });

  test("user-scoped pre-start Stop capacity rejects overflow without evicting accepted owners", async () => {
    markAgenticRuntimeReady();
    installAgenticGenerationCoordinator();
    let receiptNow = 0;
    let nextTimerId = 0;
    let scheduledCleanup: { id: number; at: number; callback: () => void } | null = null;
    const scheduler = {
      now: () => receiptNow,
      setTimeout: (callback: () => void, delayMs: number): number => {
        if (scheduledCleanup) throw new Error("pre-start Stop cleanup scheduled more than one timer");
        const id = ++nextTimerId;
        scheduledCleanup = { id, at: receiptNow + delayMs, callback };
        return id;
      },
      clearTimeout: (handle: unknown): void => {
        if (scheduledCleanup?.id === handle) scheduledCleanup = null;
      },
    };
    const advanceClock = (durationMs: number): void => {
      receiptNow += durationMs;
      while (scheduledCleanup && scheduledCleanup.at <= receiptNow) {
        const task = scheduledCleanup;
        scheduledCleanup = null;
        task.callback();
      }
    };
    __generationRequestAuthorityTesting.clearStoppedReceipts();
    __generationRequestAuthorityTesting.configureStoppedReceiptCleanupScheduler(scheduler);
    const oldestAuthorityId = crypto.randomUUID();
    const overflowAuthorityId = crypto.randomUUID();
    const otherUserId = USER_ID + "-other";
    let delayedExecutionId: string | undefined;
    let activeOwnerGenerationId: string | undefined;
    try {
      for (let index = 0; index < __generationRequestAuthorityTesting.stoppedReceiptCapacityPerUser; index += 1) {
        expect(await stopGenerationRequestAuthority(
          USER_ID,
          index === 0 ? AGENTIC_CHAT_ID : "pre-start-stop-capacity-" + index,
          index === 0 ? oldestAuthorityId : crypto.randomUUID(),
        )).toBe(true);
      }
      expect(__generationRequestAuthorityTesting.stoppedReceiptCount(USER_ID)).toBe(2_048);
      expect(__generationRequestAuthorityTesting.hasStoppedReceipt(USER_ID, AGENTIC_CHAT_ID, oldestAuthorityId)).toBe(true);
      expect(await stopGenerationRequestAuthority(USER_ID, "pre-start-stop-overflow", overflowAuthorityId)).toBe(false);
      expect(__generationRequestAuthorityTesting.stoppedReceiptCount(USER_ID)).toBe(2_048);
      expect(await stopGenerationRequestAuthority(otherUserId, "pre-start-stop-overflow", overflowAuthorityId)).toBe(true);
      expect(__generationRequestAuthorityTesting.stoppedReceiptCount(otherUserId)).toBe(1);
      expect(__generationRequestAuthorityTesting.hasStoppedReceipt(USER_ID, AGENTIC_CHAT_ID, oldestAuthorityId)).toBe(true);

      const providerRequestCount = providerRequests.length;
      const messageCount = (getDb().query(
        "SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?",
      ).get(AGENTIC_CHAT_ID) as { count: number }).count;
      const priorExecutionIds = new Set((getDb().query(
        "SELECT id FROM agent_turn_executions WHERE user_id = ? AND chat_id = ?",
      ).all(USER_ID, AGENTIC_CHAT_ID) as Array<{ id: string }>).map(({ id }) => id));
      const delayedDecision = await resolveEffectiveRuntime(USER_ID, {
        chatId: AGENTIC_CHAT_ID,
        logicalConnectionId: CONNECTION_ID,
        presetId: AGENTIC_PRESET_ID,
        generationType: "normal",
        target: { generationType: "normal", messageId: null, swipeId: null },
        mode: "agentic",
        requestEpoch: 490,
      });
      const delayed = await startGeneration({
        userId: USER_ID,
        chat_id: AGENTIC_CHAT_ID,
        connection_id: CONNECTION_ID,
        preset_id: AGENTIC_PRESET_ID,
        generation_type: "normal",
        mode: "agentic",
        runtime_decision_token: delayedDecision.runtimeDecisionToken!,
        request_epoch: 490,
        request_authority_id: oldestAuthorityId,
        user_input: "DELAYED-OLDEST-PRESTART-STOP",
        parameters: { max_tokens: 256 },
      }).then(
        (result) => ({ result, error: null }),
        (error) => ({ result: null, error }),
      );
      expect(delayed.result).toBeNull();
      expect(delayed.error).toMatchObject({ name: "AbortError" });
      const delayedExecutions = (getDb().query(
        "SELECT id FROM agent_turn_executions WHERE user_id = ? AND chat_id = ?",
      ).all(USER_ID, AGENTIC_CHAT_ID) as Array<{ id: string }>).filter(({ id }) => !priorExecutionIds.has(id));
      expect(delayedExecutions).toHaveLength(1);
      delayedExecutionId = delayedExecutions[0]!.id;
      await waitForAgenticGeneration(delayedExecutionId);

      const ownerDecision = await resolveEffectiveRuntime(USER_ID, {
        chatId: AGENTIC_CHAT_ID,
        logicalConnectionId: CONNECTION_ID,
        presetId: AGENTIC_PRESET_ID,
        generationType: "normal",
        target: { generationType: "normal", messageId: null, swipeId: null },
        mode: "agentic",
        requestEpoch: 491,
      });
      const activeOwner = await startGeneration({
        userId: USER_ID,
        chat_id: AGENTIC_CHAT_ID,
        connection_id: CONNECTION_ID,
        preset_id: AGENTIC_PRESET_ID,
        generation_type: "normal",
        mode: "agentic",
        runtime_decision_token: ownerDecision.runtimeDecisionToken!,
        request_epoch: 491,
        request_authority_id: overflowAuthorityId,
        user_input: "ACTIVE-OWNER-STOP-AT-CAPACITY",
        parameters: { max_tokens: 256 },
      });
      activeOwnerGenerationId = activeOwner.generationId;
      expect(__generationRequestAuthorityTesting.hasStoppedReceipt(USER_ID, AGENTIC_CHAT_ID, overflowAuthorityId)).toBe(false);
      expect(await stopGenerationRequestAuthority(USER_ID, AGENTIC_CHAT_ID, overflowAuthorityId)).not.toBe(false);
      expect(__generationRequestAuthorityTesting.hasStoppedReceipt(USER_ID, AGENTIC_CHAT_ID, overflowAuthorityId)).toBe(true);
      expect(__generationRequestAuthorityTesting.stoppedReceiptCount(USER_ID)).toBe(2_049);
      expect(acknowledgeGenerationDispatch(
        USER_ID,
        AGENTIC_CHAT_ID,
        activeOwnerGenerationId,
        overflowAuthorityId,
      )).toBe(false);
      await waitForAgenticGeneration(activeOwnerGenerationId);

      expect(providerRequests).toHaveLength(providerRequestCount);
      for (const executionId of [delayedExecutionId, activeOwnerGenerationId]) {
        expect(getDb().query(
          "SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE user_id = ? AND execution_id = ?",
        ).get(USER_ID, executionId)).toEqual({ count: 0 });
      }
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?",
      ).get(AGENTIC_CHAT_ID)).toEqual({ count: messageCount });

      advanceClock(__generationRequestAuthorityTesting.stoppedReceiptGraceMs);
      expect(__generationRequestAuthorityTesting.stoppedReceiptCount(USER_ID)).toBe(0);
      expect(__generationRequestAuthorityTesting.stoppedReceiptCount(otherUserId)).toBe(0);
      expect(scheduledCleanup).toBeNull();
      expect(await stopGenerationRequestAuthority(USER_ID, "pre-start-stop-overflow", overflowAuthorityId)).toBe(true);
      expect(__generationRequestAuthorityTesting.stoppedReceiptCount(USER_ID)).toBe(1);
    } finally {
      __generationRequestAuthorityTesting.clearStoppedReceipts();
      __generationRequestAuthorityTesting.configureStoppedReceiptCleanupScheduler();
      if (activeOwnerGenerationId) {
        await stopGeneration(USER_ID, activeOwnerGenerationId, AGENTIC_CHAT_ID);
        await waitForAgenticGeneration(activeOwnerGenerationId);
      }
      if (delayedExecutionId) await waitForAgenticGeneration(delayedExecutionId);
    }
  });

  test("protected ACK-receipt capacity keeps real oldest replay and scheduled terminal expiry", async () => {
    markAgenticRuntimeReady();
    installAgenticGenerationCoordinator();
    expect(__generationRequestAuthorityTesting.retainedOwnerCount()).toBe(0);
    const oldestAuthorityId = crypto.randomUUID();
    const aliasAuthorityIds: string[] = [];
    const syntheticAcknowledgedAuthorityIds: string[] = [];
    let receiptNow = 0;
    let nextReceiptTimerId = 0;
    let scheduledReceiptCleanup: { id: number; at: number; callback: () => void } | null = null;
    const receiptCleanupScheduler = {
      now: () => receiptNow,
      setTimeout: (callback: () => void, delayMs: number): number => {
        if (scheduledReceiptCleanup) throw new Error("receipt cleanup scheduled more than one timer");
        const id = ++nextReceiptTimerId;
        scheduledReceiptCleanup = { id, at: receiptNow + delayMs, callback };
        return id;
      },
      clearTimeout: (handle: unknown): void => {
        if (scheduledReceiptCleanup?.id === handle) scheduledReceiptCleanup = null;
      },
    };
    const advanceReceiptClock = (durationMs: number): void => {
      receiptNow += durationMs;
      while (scheduledReceiptCleanup && scheduledReceiptCleanup.at <= receiptNow) {
        const task = scheduledReceiptCleanup;
        scheduledReceiptCleanup = null;
        task.callback();
      }
    };
    __generationRequestAuthorityTesting.clearAcknowledgedReceipts();
    __generationRequestAuthorityTesting.configureAcknowledgedReceiptCleanupScheduler(receiptCleanupScheduler);
    let generationId: string | undefined;
    scriptedWorkBlocked = true;
    const dispatchStarted = new Promise<void>((resolve) => {
      scriptedWorkDispatchStarted = resolve;
    });
    try {
      const decision = await resolveEffectiveRuntime(USER_ID, {
        chatId: AGENTIC_CHAT_ID,
        logicalConnectionId: CONNECTION_ID,
        presetId: AGENTIC_PRESET_ID,
        generationType: "normal",
        target: { generationType: "normal", messageId: null, swipeId: null },
        mode: "agentic",
        requestEpoch: 500,
      });
      const started = await startGeneration({
        userId: USER_ID,
        chat_id: AGENTIC_CHAT_ID,
        connection_id: CONNECTION_ID,
        preset_id: AGENTIC_PRESET_ID,
        generation_type: "normal",
        mode: "agentic",
        runtime_decision_token: decision.runtimeDecisionToken!,
        request_epoch: 500,
        request_authority_id: oldestAuthorityId,
        user_input: USER_INPUT,
        parameters: { max_tokens: 256 },
      });
      generationId = started.generationId;
      const providerRequestCount = providerRequests.length;
      expect(acknowledgeGenerationDispatch(
        USER_ID,
        AGENTIC_CHAT_ID,
        undefined,
        oldestAuthorityId,
      )).toBe(false);
      expect(acknowledgeGenerationDispatch(
        USER_ID,
        AGENTIC_CHAT_ID,
        crypto.randomUUID(),
        oldestAuthorityId,
      )).toBe(false);
      expect(acknowledgeGenerationDispatch(
        USER_ID,
        AGENTIC_CHAT_ID,
        generationId,
        crypto.randomUUID(),
      )).toBe(false);
      expect(acknowledgeGenerationDispatch(
        USER_ID,
        CHAT_ID,
        generationId,
        oldestAuthorityId,
      )).toBe(false);
      expect(providerRequests).toHaveLength(providerRequestCount);
      expect(acknowledgeGenerationDispatch(
        USER_ID,
        AGENTIC_CHAT_ID,
        generationId,
        oldestAuthorityId,
      )).toBe("accepted");
      expect(acknowledgeGenerationDispatch(
        USER_ID,
        AGENTIC_CHAT_ID,
        generationId,
        oldestAuthorityId,
      )).toBe("already_acknowledged");
      expect(acknowledgeGenerationDispatch(
        USER_ID,
        AGENTIC_CHAT_ID,
        generationId,
        crypto.randomUUID(),
      )).toBe(false);
      const acknowledgementReceiptCount = __generationRequestAuthorityTesting.acknowledgedReceiptCount();
      expect(acknowledgementReceiptCount).toBe(1);
      for (let index = 0; index < 2_048; index += 1) {
        const authorityId = crypto.randomUUID();
        syntheticAcknowledgedAuthorityIds.push(authorityId);
        __generationRequestAuthorityTesting.retainAcknowledgedReceipt(
          USER_ID,
          AGENTIC_CHAT_ID,
          authorityId,
          `synthetic-ack-generation-${index}`,
        );
      }
      expect(__generationRequestAuthorityTesting.acknowledgedReceiptCount()).toBe(acknowledgementReceiptCount + 2_048);
      expect(acknowledgeGenerationDispatch(
        USER_ID,
        AGENTIC_CHAT_ID,
        generationId,
        oldestAuthorityId,
      )).toBe("already_acknowledged");
      expect(acknowledgeGenerationDispatch(
        USER_ID,
        AGENTIC_CHAT_ID,
        generationId,
        crypto.randomUUID(),
      )).toBe(false);
      await dispatchStarted;

      for (let index = 0; index < 2_048; index += 1) {
        const authorityId = crypto.randomUUID();
        aliasAuthorityIds.push(authorityId);
        const alias = await startGeneration({
          userId: USER_ID,
          chat_id: AGENTIC_CHAT_ID,
          connection_id: CONNECTION_ID,
          preset_id: AGENTIC_PRESET_ID,
          generation_type: "normal",
          generationId,
          mode: "agentic",
          request_epoch: 501 + index,
          request_authority_id: authorityId,
          user_input: USER_INPUT,
          parameters: { max_tokens: 256 },
        });
        expect(alias.generationId).toBe(generationId);
      }
      expect(__generationRequestAuthorityTesting.retainedOwnerCount()).toBe(2_049);
      expect(await stopGenerationRequestAuthority(
        USER_ID,
        AGENTIC_CHAT_ID,
        oldestAuthorityId,
      )).not.toBe(false);
      await waitForAgenticGeneration(generationId);
      expect(getTurnExecution(generationId, USER_ID)).toMatchObject({
        state: "CANCELLED",
        terminalCode: "cancelled",
      });
      expect(__generationRequestAuthorityTesting.retainedOwnerCount()).toBe(0);
      for (const authorityId of syntheticAcknowledgedAuthorityIds.splice(0)) {
        __generationRequestAuthorityTesting.forgetAcknowledgedReceipt(USER_ID, AGENTIC_CHAT_ID, authorityId);
      }
      expect(__generationRequestAuthorityTesting.acknowledgedReceiptCount()).toBe(1);
      expect(scheduledReceiptCleanup).not.toBeNull();
      expect(__generationRequestAuthorityTesting.hasAcknowledgedReceipt(
        USER_ID,
        AGENTIC_CHAT_ID,
        oldestAuthorityId,
        generationId,
      )).toBe(true);
      expect(__generationRequestAuthorityTesting.hasAcknowledgedReceipt(
        USER_ID,
        AGENTIC_CHAT_ID,
        crypto.randomUUID(),
        generationId,
      )).toBe(false);
      advanceReceiptClock(__generationRequestAuthorityTesting.acknowledgedReceiptRetryGraceMs - 1);
      expect(__generationRequestAuthorityTesting.acknowledgedReceiptCount()).toBe(1);
      expect(__generationRequestAuthorityTesting.hasAcknowledgedReceipt(
        USER_ID,
        AGENTIC_CHAT_ID,
        oldestAuthorityId,
        generationId,
      )).toBe(true);
      advanceReceiptClock(1);
      expect(__generationRequestAuthorityTesting.acknowledgedReceiptCount()).toBe(0);
      expect(scheduledReceiptCleanup).toBeNull();
      expect(await stopGenerationRequestAuthority(
        USER_ID,
        AGENTIC_CHAT_ID,
        aliasAuthorityIds.at(-1),
      )).toBe(true);
      expect(__generationRequestAuthorityTesting.retainedOwnerCount()).toBe(0);
    } finally {
      for (const authorityId of syntheticAcknowledgedAuthorityIds) {
        __generationRequestAuthorityTesting.forgetAcknowledgedReceipt(USER_ID, AGENTIC_CHAT_ID, authorityId);
      }
      __generationRequestAuthorityTesting.clearAcknowledgedReceipts();
      __generationRequestAuthorityTesting.configureAcknowledgedReceiptCleanupScheduler();
      scriptedWorkBlocked = false;
      scriptedWorkDispatchStarted = undefined;
      if (generationId) {
        await stopGeneration(USER_ID, generationId, AGENTIC_CHAT_ID);
        await waitForAgenticGeneration(generationId);
      }
    }
  });

  test("unacknowledged owner expires through durable timeout authority without dispatch", async () => {
    markAgenticRuntimeReady();
    installAgenticGenerationCoordinator();
    const canonicalDependencies = __testing.buildDependencies();
    const source = new AbortController();
    const retainedListeners = new Set<EventListenerOrEventListenerObject>();
    const trackedSignal = {
      get aborted() { return source.signal.aborted; },
      get reason() { return source.signal.reason; },
      addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) {
        if (type === "abort") retainedListeners.add(listener);
        source.signal.addEventListener(type, listener, options);
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) {
        if (type === "abort") retainedListeners.delete(listener);
        source.signal.removeEventListener(type, listener, options);
      },
    } as unknown as AbortSignal;
    let timeoutCallback: (() => void) | undefined;
    const timeoutHandle = Symbol("dispatch-ack-timeout") as unknown as ReturnType<typeof setTimeout>;
    const scheduledDelays: number[] = [];
    const clearedHandles: Array<ReturnType<typeof setTimeout>> = [];
    const timeoutDependencies = {
      ...canonicalDependencies,
      dispatchAcknowledgementTimeoutMs: 4_242,
      dispatchAcknowledgementScheduler: {
        setTimeout(callback: () => void, delayMs: number) {
          timeoutCallback = callback;
          scheduledDelays.push(delayMs);
          return timeoutHandle;
        },
        clearTimeout(handle: ReturnType<typeof setTimeout>) {
          clearedHandles.push(handle);
        },
      },
    };
    configureAgenticGenerationDependencies(timeoutDependencies);
    configureAgenticGenerationRuntimeDependencies(timeoutDependencies);
    const authorityId = crypto.randomUUID();
    const providerRequestCount = providerRequests.length;
    let generationId: string | undefined;
    try {
      const decision = await resolveEffectiveRuntime(USER_ID, {
        chatId: AGENTIC_CHAT_ID,
        logicalConnectionId: CONNECTION_ID,
        presetId: AGENTIC_PRESET_ID,
        generationType: "normal",
        target: { generationType: "normal", messageId: null, swipeId: null },
        mode: "agentic",
        requestEpoch: 590,
      });
      const started = await startGeneration({
        userId: USER_ID,
        chat_id: AGENTIC_CHAT_ID,
        connection_id: CONNECTION_ID,
        preset_id: AGENTIC_PRESET_ID,
        generation_type: "normal",
        mode: "agentic",
        runtime_decision_token: decision.runtimeDecisionToken!,
        request_epoch: 590,
        request_authority_id: authorityId,
        user_input: "DISPATCH-ACK-TIMEOUT-PROBE",
        parameters: { max_tokens: 256 },
        signal: trackedSignal,
      });
      generationId = started.generationId;
      expect(scheduledDelays).toEqual([4_242]);
      expect(retainedListeners.size).toBe(1);
      expect(providerRequests).toHaveLength(providerRequestCount);

      expect(timeoutCallback).toBeDefined();
      timeoutCallback!();
      await waitForAgenticGeneration(generationId);

      expect(getTurnExecution(generationId, USER_ID)).toMatchObject({
        state: "TIMED_OUT",
        terminalCode: "root_wall_clock_limit_exceeded",
        casOwner: null,
      });
      expect(clearedHandles).toEqual([timeoutHandle]);
      expect(retainedListeners.size).toBe(0);
      expect(__generationRequestAuthorityTesting.retainedOwnerCount()).toBe(0);
      expect(acknowledgeGenerationDispatch(
        USER_ID,
        AGENTIC_CHAT_ID,
        generationId,
        authorityId,
      )).toBe(false);
      expect(providerRequests).toHaveLength(providerRequestCount);
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE user_id = ? AND execution_id = ?",
      ).get(USER_ID, generationId)).toEqual({ count: 0 });
    } finally {
      if (generationId) {
        await stopGeneration(USER_ID, generationId, AGENTIC_CHAT_ID);
        await waitForAgenticGeneration(generationId);
      }
      configureAgenticGenerationDependencies(canonicalDependencies);
      configureAgenticGenerationRuntimeDependencies(canonicalDependencies);
    }
  });

  test("exact canonical Stop after ACK transport ambiguity converges before provider or commit", async () => {
    markAgenticRuntimeReady();
    installAgenticGenerationCoordinator();
    const authorityId = crypto.randomUUID();
    const providerRequestCount = providerRequests.length;
    let generationId: string | undefined;
    try {
      const decision = await resolveEffectiveRuntime(USER_ID, {
        chatId: AGENTIC_CHAT_ID,
        logicalConnectionId: CONNECTION_ID,
        presetId: AGENTIC_PRESET_ID,
        generationType: "normal",
        target: { generationType: "normal", messageId: null, swipeId: null },
        mode: "agentic",
        requestEpoch: 595,
      });
      const started = await startGeneration({
        userId: USER_ID,
        chat_id: AGENTIC_CHAT_ID,
        connection_id: CONNECTION_ID,
        preset_id: AGENTIC_PRESET_ID,
        generation_type: "normal",
        mode: "agentic",
        runtime_decision_token: decision.runtimeDecisionToken!,
        request_epoch: 595,
        request_authority_id: authorityId,
        user_input: "ACK-TRANSPORT-AMBIGUITY-STOP",
        parameters: { max_tokens: 256 },
      });
      generationId = started.generationId;
      expect(providerRequests).toHaveLength(providerRequestCount);
      expect(resolveGenerationRequestAuthority(USER_ID, AGENTIC_CHAT_ID, generationId)).toBe(authorityId);
      expect(resolveGenerationRequestAuthority(USER_ID + "-other", AGENTIC_CHAT_ID, generationId)).toBeNull();
      expect(resolveGenerationRequestAuthority(USER_ID, AGENTIC_CHAT_ID + "-other", generationId)).toBeNull();
      const unknownAuthorityId = crypto.randomUUID();
      expect(await stopGenerationRequestAuthority(
        USER_ID,
        AGENTIC_CHAT_ID,
        unknownAuthorityId,
        generationId,
      )).toBe(false);
      expect(__generationRequestAuthorityTesting.hasStoppedReceipt(USER_ID, AGENTIC_CHAT_ID, unknownAuthorityId)).toBe(false);
      expect(await stopGenerationRequestAuthority(
        USER_ID,
        AGENTIC_CHAT_ID,
        authorityId,
        crypto.randomUUID(),
      )).toBe(false);
      expect(__generationRequestAuthorityTesting.hasStoppedReceipt(USER_ID, AGENTIC_CHAT_ID, authorityId)).toBe(false);

      expect(await stopGenerationRequestAuthority(
        USER_ID,
        AGENTIC_CHAT_ID,
        authorityId,
        generationId,
      )).not.toBe(false);
      await waitForAgenticGeneration(generationId);
      expect(resolveGenerationRequestAuthority(USER_ID, AGENTIC_CHAT_ID, generationId)).toBeNull();

      expect(getTurnExecution(generationId, USER_ID)).toMatchObject({
        state: "CANCELLED",
        terminalCode: "cancelled",
        casOwner: null,
      });
      expect(providerRequests).toHaveLength(providerRequestCount);
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE user_id = ? AND execution_id = ?",
      ).get(USER_ID, generationId)).toEqual({ count: 0 });
      expect(__generationRequestAuthorityTesting.retainedOwnerCount()).toBe(0);
    } finally {
      if (generationId) {
        await stopGeneration(USER_ID, generationId, AGENTIC_CHAT_ID);
        await waitForAgenticGeneration(generationId);
      }
    }
  });
  test("crossed live request authority and generation identities cancel neither owner", async () => {
    markAgenticRuntimeReady();
    installAgenticGenerationCoordinator();
    const chatA = AGENTIC_CHAT_ID;
    const chatB = "chat-crossed-live-stop-b";
    seedTransientAgenticChat(chatB);
    const authorityA = crypto.randomUUID();
    const authorityB = crypto.randomUUID();
    const generations = new Map<string, string>();
    const providerRequestCount = providerRequests.length;
    const decide = (chatId: string, requestEpoch: number) => resolveEffectiveRuntime(USER_ID, {
      chatId,
      logicalConnectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal",
      target: { generationType: "normal", messageId: null, swipeId: null },
      mode: "agentic",
      requestEpoch,
    });
    const start = (
      chatId: string,
      authorityId: string,
      requestEpoch: number,
      runtimeDecisionToken: string,
    ) => startGeneration({
      userId: USER_ID,
      chat_id: chatId,
      connection_id: CONNECTION_ID,
      preset_id: AGENTIC_PRESET_ID,
      generation_type: "normal",
      mode: "agentic",
      runtime_decision_token: runtimeDecisionToken,
      request_epoch: requestEpoch,
      request_authority_id: authorityId,
      user_input: "CROSSED-LIVE-STOP-" + requestEpoch,
      parameters: { max_tokens: 256 },
    });

    try {
      const decisionA = await decide(chatA, 599);
      const generationA = await start(chatA, authorityA, 599, decisionA.runtimeDecisionToken!);
      generations.set(generationA.generationId, chatA);
      const decisionB = await decide(chatB, 600);
      const generationB = await start(chatB, authorityB, 600, decisionB.runtimeDecisionToken!);
      generations.set(generationB.generationId, chatB);
      expect(generationB.generationId).not.toBe(generationA.generationId);
      expect(resolveGenerationRequestAuthority(USER_ID, chatA, generationA.generationId)).toBe(authorityA);
      expect(resolveGenerationRequestAuthority(USER_ID, chatB, generationB.generationId)).toBe(authorityB);
      const stateA = getTurnExecution(generationA.generationId, USER_ID)?.state;
      const stateB = getTurnExecution(generationB.generationId, USER_ID)?.state;

      expect(await stopGenerationRequestAuthority(
        USER_ID,
        chatA,
        authorityA,
        generationB.generationId,
      )).toBe(false);
      expect(__generationRequestAuthorityTesting.hasStoppedReceipt(USER_ID, chatA, authorityA)).toBe(false);
      expect(__generationRequestAuthorityTesting.hasStoppedReceipt(USER_ID, chatB, authorityB)).toBe(false);
      expect(getTurnExecution(generationA.generationId, USER_ID)?.state).toBe(stateA);
      expect(getTurnExecution(generationB.generationId, USER_ID)?.state).toBe(stateB);
      expect(resolveGenerationRequestAuthority(USER_ID, chatA, generationA.generationId)).toBe(authorityA);
      expect(resolveGenerationRequestAuthority(USER_ID, chatB, generationB.generationId)).toBe(authorityB);

      expect(await stopGenerationRequestAuthority(
        USER_ID,
        chatA,
        authorityA,
        generationA.generationId,
      )).not.toBe(false);
      await waitForAgenticGeneration(generationA.generationId);
      expect(getTurnExecution(generationA.generationId, USER_ID)).toMatchObject({ state: "CANCELLED" });
      expect(getTurnExecution(generationB.generationId, USER_ID)?.state).toBe(stateB);
      expect(resolveGenerationRequestAuthority(USER_ID, chatB, generationB.generationId)).toBe(authorityB);
      expect(providerRequests).toHaveLength(providerRequestCount);
    } finally {
      for (const [generationId, chatId] of generations) {
        await stopGeneration(USER_ID, generationId, chatId);
        await waitForAgenticGeneration(generationId);
      }
      __generationRequestAuthorityTesting.clearStoppedReceipts();
    }
  });
  test("live admitted request authority cannot be reserved again until its owner and Stop receipt expire", async () => {
    markAgenticRuntimeReady();
    installAgenticGenerationCoordinator();
    const authorityA = crypto.randomUUID();
    const authorityB = crypto.randomUUID();
    const generations = new Set<string>();
    const providerRequestCount = providerRequests.length;
    const decide = (requestEpoch: number) => resolveEffectiveRuntime(USER_ID, {
      chatId: AGENTIC_CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal",
      target: { generationType: "normal", messageId: null, swipeId: null },
      mode: "agentic",
      requestEpoch,
    });
    const start = (authorityId: string, requestEpoch: number, runtimeDecisionToken: string, userInput: string) => startGeneration({
      userId: USER_ID,
      chat_id: AGENTIC_CHAT_ID,
      connection_id: CONNECTION_ID,
      preset_id: AGENTIC_PRESET_ID,
      generation_type: "normal",
      mode: "agentic",
      runtime_decision_token: runtimeDecisionToken,
      request_epoch: requestEpoch,
      request_authority_id: authorityId,
      user_input: userInput,
      parameters: { max_tokens: 256 },
    });

    try {
      const firstDecision = await decide(596);
      const first = await start(authorityA, 596, firstDecision.runtimeDecisionToken!, "AUTHORITY-REUSE-G1");
      generations.add(first.generationId);
      expect(resolveGenerationRequestAuthority(USER_ID, AGENTIC_CHAT_ID, first.generationId)).toBe(authorityA);
      const executionCount = (getDb().query(
        "SELECT COUNT(*) AS count FROM agent_turn_executions WHERE user_id = ? AND chat_id = ?",
      ).get(USER_ID, AGENTIC_CHAT_ID) as { count: number }).count;

      const secondDecision = await decide(597);
      await expect(start(
        authorityA,
        597,
        secondDecision.runtimeDecisionToken!,
        "AUTHORITY-REUSE-G2-REJECTED",
      )).rejects.toThrow("Generation request authority is already active.");
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM agent_turn_executions WHERE user_id = ? AND chat_id = ?",
      ).get(USER_ID, AGENTIC_CHAT_ID)).toEqual({ count: executionCount });
      expect(resolveGenerationRequestAuthority(USER_ID, AGENTIC_CHAT_ID, first.generationId)).toBe(authorityA);

      expect(await stopGenerationRequestAuthority(
        USER_ID,
        AGENTIC_CHAT_ID,
        authorityA,
        first.generationId,
      )).not.toBe(false);
      await waitForAgenticGeneration(first.generationId);
      expect(getTurnExecution(first.generationId, USER_ID)).toMatchObject({ state: "CANCELLED" });
      expect(__generationRequestAuthorityTesting.hasStoppedReceipt(USER_ID, AGENTIC_CHAT_ID, authorityB)).toBe(false);

      const second = await start(
        authorityB,
        597,
        secondDecision.runtimeDecisionToken!,
        "AUTHORITY-REUSE-G2-DISTINCT",
      );
      generations.add(second.generationId);
      expect(second.generationId).not.toBe(first.generationId);
      expect(resolveGenerationRequestAuthority(USER_ID, AGENTIC_CHAT_ID, second.generationId)).toBe(authorityB);
      expect(__generationRequestAuthorityTesting.hasStoppedReceipt(USER_ID, AGENTIC_CHAT_ID, authorityB)).toBe(false);
      expect(await stopGenerationRequestAuthority(
        USER_ID,
        AGENTIC_CHAT_ID,
        authorityB,
        second.generationId,
      )).not.toBe(false);
      await waitForAgenticGeneration(second.generationId);

      __generationRequestAuthorityTesting.clearStoppedReceipts();
      const thirdDecision = await decide(598);
      const third = await start(authorityA, 598, thirdDecision.runtimeDecisionToken!, "AUTHORITY-REUSE-G3-AFTER-EXPIRY");
      generations.add(third.generationId);
      expect(third.generationId).not.toBe(first.generationId);
      expect(resolveGenerationRequestAuthority(USER_ID, AGENTIC_CHAT_ID, third.generationId)).toBe(authorityA);
      expect(await stopGenerationRequestAuthority(
        USER_ID,
        AGENTIC_CHAT_ID,
        authorityA,
        third.generationId,
      )).not.toBe(false);
      await waitForAgenticGeneration(third.generationId);
      expect(providerRequests).toHaveLength(providerRequestCount);
    } finally {
      for (const generationId of generations) {
        await stopGeneration(USER_ID, generationId, AGENTIC_CHAT_ID);
        await waitForAgenticGeneration(generationId);
      }
      __generationRequestAuthorityTesting.clearStoppedReceipts();
    }
  });

  test("post-admission request abort cannot lose to provider dispatch before client acknowledgement", async () => {
    markAgenticRuntimeReady();
    installAgenticGenerationCoordinator();

    const source = new AbortController();
    const retainedListeners = new Set<EventListenerOrEventListenerObject>();
    const trackedSignal = {
      get aborted() { return source.signal.aborted; },
      get reason() { return source.signal.reason; },
      addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) {
        if (type === "abort") retainedListeners.add(listener);
        source.signal.addEventListener(type, listener, options);
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) {
        if (type === "abort") retainedListeners.delete(listener);
        source.signal.removeEventListener(type, listener, options);
      },
    } as unknown as AbortSignal;
    const authorityId = crypto.randomUUID();
    const providerRequestCount = providerRequests.length;
    const priorExecutionIds = new Set((getDb().query(
      "SELECT id FROM agent_turn_executions WHERE user_id = ? AND chat_id = ?",
    ).all(USER_ID, AGENTIC_CHAT_ID) as Array<{ id: string }>).map(({ id }) => id));
    const messageCount = (getDb().query(
      "SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?",
    ).get(AGENTIC_CHAT_ID) as { count: number }).count;
    let generationId: string | undefined;
    try {
      const decision = await resolveEffectiveRuntime(USER_ID, {
        chatId: AGENTIC_CHAT_ID,
        logicalConnectionId: CONNECTION_ID,
        presetId: AGENTIC_PRESET_ID,
        generationType: "normal",
        target: { generationType: "normal", messageId: null, swipeId: null },
        mode: "agentic",
        requestEpoch: 600,
      });
      const started = await startGeneration({
        userId: USER_ID,
        chat_id: AGENTIC_CHAT_ID,
        connection_id: CONNECTION_ID,
        preset_id: AGENTIC_PRESET_ID,
        generation_type: "normal",
        mode: "agentic",
        runtime_decision_token: decision.runtimeDecisionToken!,
        request_epoch: 600,
        request_authority_id: authorityId,
        user_input: "C-STOP-PROBE",
        parameters: { max_tokens: 256 },
        signal: trackedSignal,
      });
      generationId = started.generationId;

      // Durable admission has returned, but neither assembly nor provider work
      // may outrun the client's acceptance of this exact owner.
      expect(retainedListeners.size).toBe(1);
      expect(providerRequests).toHaveLength(providerRequestCount);
      expect(acknowledgeGenerationDispatch(
        USER_ID,
        AGENTIC_CHAT_ID,
        crypto.randomUUID(),
        authorityId,
      )).toBe(false);
      expect(providerRequests).toHaveLength(providerRequestCount);

      source.abort(new DOMException("Generation stopped", "AbortError"));
      const duplicateStops = await Promise.all([
        stopGenerationRequestAuthority(USER_ID, AGENTIC_CHAT_ID, authorityId),
        stopGenerationRequestAuthority(USER_ID, AGENTIC_CHAT_ID, authorityId),
      ]);
      expect(duplicateStops).toEqual([true, true]);
      await waitForAgenticGeneration(generationId);

      expect(retainedListeners.size).toBe(0);
      expect(acknowledgeGenerationDispatch(
        USER_ID,
        AGENTIC_CHAT_ID,
        generationId,
        authorityId,
      )).toBe(false);
      expect(getTurnExecution(generationId, USER_ID)).toMatchObject({
        state: "CANCELLED",
        terminalCode: "cancelled",
        casOwner: null,
      });
      expect(getDb().query(
        "SELECT lifecycle, status, outcome, reason, terminal FROM agent_run_attempts WHERE user_id = ? AND turn_id = ? ORDER BY started_at, attempt_id",
      ).all(USER_ID, generationId)).toEqual([{
        lifecycle: "TERMINAL",
        status: "terminal",
        outcome: "stopped",
        reason: "user_stop",
        terminal: 1,
      }]);
      const projection = getDb().query(
        "SELECT status, phase, snapshot_json FROM agent_run_projections WHERE user_id = ? AND turn_id = ?",
      ).get(USER_ID, generationId) as { status: string; phase: string; snapshot_json: string };
      expect({ status: projection.status, phase: projection.phase }).toEqual({
        status: "CANCELLED",
        phase: "CANCELLED",
      });
      expect(JSON.parse(projection.snapshot_json)).toMatchObject({
        workPhase: "TERMINAL",
        workStatus: "terminal",
        workOutcome: "stopped",
        reason: "stopped",
      });
      expect(getAgentRunInspection(USER_ID, generationId, AGENTIC_CHAT_ID)?.error).toMatchObject({
        authority: "host",
        source: "execution",
        scope: "run",
        workPhase: "TERMINAL",
        workStatus: "terminal",
        workOutcome: "stopped",
        reason: "user_stop",
      });
      const admittedOwners = (getDb().query(
        "SELECT id FROM agent_turn_executions WHERE user_id = ? AND chat_id = ?",
      ).all(USER_ID, AGENTIC_CHAT_ID) as Array<{ id: string }>).filter(
        ({ id }) => !priorExecutionIds.has(id),
      );
      expect(admittedOwners).toEqual([{ id: generationId }]);
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM agent_chat_events WHERE user_id = ? AND chat_id = ? AND generation_id = ? AND event_kind = 'terminal'",
      ).get(USER_ID, AGENTIC_CHAT_ID, generationId)).toEqual({ count: 1 });
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM agent_activity_runs WHERE user_id = ? AND chat_id = ? AND generation_id = ?",
      ).get(USER_ID, AGENTIC_CHAT_ID, generationId)).toEqual({ count: 1 });
      expect(providerRequests).toHaveLength(providerRequestCount);
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE user_id = ? AND execution_id = ?",
      ).get(USER_ID, generationId)).toEqual({ count: 0 });
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?",
      ).get(AGENTIC_CHAT_ID)).toEqual({ count: messageCount });
    } finally {
      if (generationId) {
        await stopGeneration(USER_ID, generationId, AGENTIC_CHAT_ID);
        await waitForAgenticGeneration(generationId);
      }
    }
  });

  test("request abort retries false and rejected live cancellation through durable terminal authority", async () => {
    markAgenticRuntimeReady();
    installAgenticGenerationCoordinator();
    const canonicalDependencies = __testing.buildDependencies();
    let generationId: string | undefined;
    try {
      for (const [index, cancellationFailure] of ["false", "reject"].entries()) {
        let cancellationAttempts = 0;
        const failedCancellationDependencies = {
          ...canonicalDependencies,
          requestCancellation: async () => {
            cancellationAttempts += 1;
            if (cancellationFailure === "reject") throw new Error("injected cancellation rejection");
            return false;
          },
        };
        configureAgenticGenerationDependencies(failedCancellationDependencies);
        configureAgenticGenerationRuntimeDependencies(failedCancellationDependencies);

        const source = new AbortController();
        const retainedListeners = new Set<EventListenerOrEventListenerObject>();
        const trackedSignal = {
          get aborted() { return source.signal.aborted; },
          get reason() { return source.signal.reason; },
          addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) {
            if (type === "abort") retainedListeners.add(listener);
            source.signal.addEventListener(type, listener, options);
          },
          removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) {
            if (type === "abort") retainedListeners.delete(listener);
            source.signal.removeEventListener(type, listener, options);
          },
        } as unknown as AbortSignal;
        const authorityId = crypto.randomUUID();
        const providerRequestCount = providerRequests.length;
        const decision = await resolveEffectiveRuntime(USER_ID, {
          chatId: AGENTIC_CHAT_ID,
          logicalConnectionId: CONNECTION_ID,
          presetId: AGENTIC_PRESET_ID,
          generationType: "normal",
          target: { generationType: "normal", messageId: null, swipeId: null },
          mode: "agentic",
          requestEpoch: 700 + index,
        });
        const started = await startGeneration({
          userId: USER_ID,
          chat_id: AGENTIC_CHAT_ID,
          connection_id: CONNECTION_ID,
          preset_id: AGENTIC_PRESET_ID,
          generation_type: "normal",
          mode: "agentic",
          runtime_decision_token: decision.runtimeDecisionToken!,
          request_epoch: 700 + index,
          request_authority_id: authorityId,
          user_input: "C-STOP-FALLBACK-" + cancellationFailure,
          parameters: { max_tokens: 256 },
          signal: trackedSignal,
        });
        generationId = started.generationId;
        expect(providerRequests).toHaveLength(providerRequestCount);

        source.abort(new DOMException("Generation stopped", "AbortError"));
        await waitForAgenticGeneration(generationId);

        expect(cancellationAttempts).toBe(1);
        expect(retainedListeners.size).toBe(0);
        expect(getDb().query(
          "SELECT state, terminal_code, cancel_requested_at FROM agent_turn_executions WHERE user_id = ? AND id = ?",
        ).get(USER_ID, generationId)).toEqual({
          state: "CANCELLED",
          terminal_code: "cancelled",
          cancel_requested_at: expect.any(Number),
        });
        expect(getDb().query(
          "SELECT lifecycle, status, outcome, reason, terminal FROM agent_run_attempts WHERE user_id = ? AND turn_id = ? ORDER BY started_at, attempt_id",
        ).all(USER_ID, generationId)).toEqual([{
          lifecycle: "TERMINAL",
          status: "terminal",
          outcome: "stopped",
          reason: "user_stop",
          terminal: 1,
        }]);
        expect(await stopGenerationRequestAuthority(USER_ID, AGENTIC_CHAT_ID, authorityId)).toBe(true);
        expect(await stopGenerationRequestAuthority(USER_ID, AGENTIC_CHAT_ID, authorityId)).toBe(true);
        expect(providerRequests).toHaveLength(providerRequestCount);
        generationId = undefined;
      }
    } finally {
      if (generationId) {
        await stopGeneration(USER_ID, generationId, AGENTIC_CHAT_ID);
        await waitForAgenticGeneration(generationId);
      }
      configureAgenticGenerationDependencies(canonicalDependencies);
      configureAgenticGenerationRuntimeDependencies(canonicalDependencies);
    }
  });

  test("explicit Response caller-token validation preserves authority AbortError", async () => {
    markAgenticRuntimeReady();
    installAgenticGenerationCoordinator();
    const decision = await resolveEffectiveRuntime(USER_ID, {
      chatId: AGENTIC_CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal",
      target: { generationType: "normal", messageId: null, swipeId: null },
      mode: "agentic",
      requestEpoch: 401,
    });
    expect(decision.runtimeDecisionToken).toBeTruthy();

    for (const [index, runtimeDecisionToken] of ["", decision.runtimeDecisionToken!].entries()) {
      const authorityId = crypto.randomUUID();
      const executionCount = (getDb().query(
        "SELECT COUNT(*) AS count FROM agent_turn_executions WHERE user_id = ? AND chat_id = ?",
      ).get(USER_ID, AGENTIC_CHAT_ID) as { count: number }).count;
      const providerRequestCount = providerRequests.length;
      expect(await stopGenerationRequestAuthority(USER_ID, AGENTIC_CHAT_ID, authorityId)).toBe(true);
      await expect(startGeneration({
        userId: USER_ID,
        chat_id: AGENTIC_CHAT_ID,
        connection_id: CONNECTION_ID,
        preset_id: AGENTIC_PRESET_ID,
        generation_type: "normal",
        mode: "response",
        runtime_decision_token: runtimeDecisionToken,
        request_epoch: 400 + index,
        request_authority_id: authorityId,
        user_input: USER_INPUT,
        parameters: { max_tokens: 256 },
      })).rejects.toMatchObject({ name: "AbortError" });
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM agent_turn_executions WHERE user_id = ? AND chat_id = ?",
      ).get(USER_ID, AGENTIC_CHAT_ID)).toEqual({ count: executionCount });
      expect(providerRequests).toHaveLength(providerRequestCount);
    }
  });

  test("production readiness digest tracks the frozen cognition revision", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    const db = getDb();
    const baseRequest = {
      chatId: AGENTIC_CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal" as const,
      target: { generationType: "normal" as const, messageId: null, swipeId: null },
      mode: "agentic" as const,
    };
    try {
      const first = await resolveEffectiveRuntime(USER_ID, { ...baseRequest, requestEpoch: 101 });
      expect(first.effectiveMode).toBe("agentic");
      expect(first.internal.readinessVector.ready).toBe(true);
      expect(String(first.internal.readinessVector.cognitionRevision).length).toBeGreaterThan(0);
      const firstCognitionRevision = first.internal.readinessVector.cognitionRevision;
      const firstDigest = first.internal.binding.readinessDigest;

      db.query("UPDATE preset_agent_configs SET max_invocations = max_invocations + 1 WHERE user_id = ? AND preset_id = ?")
        .run(USER_ID, AGENTIC_PRESET_ID);
      const second = await resolveEffectiveRuntime(USER_ID, { ...baseRequest, requestEpoch: 102 });
      expect(second.internal.readinessVector.cognitionRevision).not.toBe(firstCognitionRevision);
      expect(second.internal.binding.readinessDigest).not.toBe(firstDigest);
    } finally {
      db.query("UPDATE preset_agent_configs SET max_invocations = 8 WHERE user_id = ? AND preset_id = ?")
        .run(USER_ID, AGENTIC_PRESET_ID);
    }
  });

  test("repair-required cognition closes Agentic readiness while Response stays available", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    const db = getDb();
    const now = Date.now();
    const repairPresetId = "preset-coordinator-repair";
    db.query(
      "INSERT OR IGNORE INTO presets (id, user_id, name, provider, engine, parameters, prompt_order, prompts, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(repairPresetId, USER_ID, "Repair Coordinator Preset", "scripted-coordinator", "classic", "{}", "[]", "{}", "{}", now, now);
    db.query(
      `INSERT OR IGNORE INTO preset_agent_configs
        (user_id, preset_id, version, agents_enabled, allowed_modes, default_mode,
         max_invocations, max_tool_calls, main_tool_ids, main_lore_scope,
         phase_policy_json, cognition_policy_json, task_policy_json,
         workspace_policy_json, state, review_code, review_acknowledged, config_revision, binding_revision,
         created_at, updated_at)
        VALUES (?, ?, 2, 1, ?, 'agentic', 8, 8, ?, 'active',
          '{}', '{}', '{}', '{}', 'repair_required', 'cognition_invalid', 0, 1, 1, ?, ?)`,
    ).run(
      USER_ID,
      repairPresetId,
      JSON.stringify(["response", "agentic"]),
      JSON.stringify(["chat_search_history"]),
      now,
      now,
    );
    const decision = await resolveEffectiveRuntime(USER_ID, {
      chatId: AGENTIC_CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: repairPresetId,
      generationType: "normal",
      target: { generationType: "normal", messageId: null, swipeId: null },
      mode: "agentic",
      requestEpoch: 201,
    });
    expect(decision.effectiveMode).toBe("response");
    expect(decision.capabilityReadiness.responseEscape).toBe("available");
    expect(decision.repairCodes).toContain("agent_config_repair_required");
    expect(decision.internal.readinessVector.ready).toBe(false);
    expect(decision.internal.readinessVector.reasons).toContain("cognition_invalid");
  });

  test("explicit Response stays available without Agentic capability poison", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    const decision = await resolveEffectiveRuntime(USER_ID, {
      chatId: AGENTIC_CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal",
      target: { generationType: "normal", messageId: null, swipeId: null },
      mode: "response",
      requestEpoch: 202,
    });
    expect(decision.requestedMode).toBe("response");
    expect(decision.effectiveMode).toBe("response");
    expect(decision.capabilityReadiness.ready).toBe(true);
    expect(decision.capabilityReadiness.required).toEqual([]);
    expect(decision.capabilityReadiness.missing).toEqual([]);
    expect(decision.capabilityReadiness.repairCodes).not.toEqual(expect.arrayContaining([
      "input_revisions_incomplete",
      "agentic_input_revisions_incomplete",
      "provider_capability_unavailable",
    ]));
    expect(decision.repairCodes).not.toEqual(expect.arrayContaining([
      "input_revisions_incomplete",
      "agentic_input_revisions_incomplete",
    ]));
    expect(decision.runtimePolicy.availability.state).toBe("available");
    expect(decision.runtimePolicy.availability.reasonCode).toBeNull();
  });


  test("omitted mode snapshots revisions when the resolved request is agentic", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    const decision = await resolveEffectiveRuntime(USER_ID, {
      chatId: AGENTIC_CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal",
    });
    expect(decision.effectiveMode).toBe("agentic");
    expect(decision.repairCodes).not.toContain("agentic_input_revisions_incomplete");
  });

  test("internal coordinator resolution never leaks one-use decision tokens", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    AGENT_RUNTIME_DECISION_SERVICE.resetTokensForTests();
    const deps = __testing.buildDependencies();
    for (let index = 0; index < 3; index++) {
      const decision = await deps.resolveRuntime!(
        { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", userInput: USER_INPUT },
        { generationType: "normal" },
        new AbortController().signal,
      );
      expect(decision.mode).toBe("agentic");
      expect(decision.token).toBeUndefined();
    }
    expect(AGENT_RUNTIME_DECISION_SERVICE.tokenStore.liveCount).toBe(0);
  });

  test("a token issued with target revision consumes against the unchanged live target revision", async () => {
    seedTargetMessage("message-token-target", AGENTIC_CHAT_ID, ADMITTED_TARGET_REVISION);
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    AGENT_RUNTIME_DECISION_SERVICE.resetTokensForTests();
    const target = {
      generationType: "regenerate" as const,
      messageId: "message-token-target",
      revision: ADMITTED_TARGET_REVISION,
    };
    const request = {
      chatId: AGENTIC_CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "regenerate" as const,
      target,
      mode: "agentic" as const,
      requestEpoch: 21,
    };
    const issued = await resolveEffectiveRuntime(USER_ID, request);
    expect(issued.effectiveMode).toBe("agentic");
    expect(issued.runtimeDecisionToken).toBeTruthy();
    const consumed = await __testing.buildDependencies().consumeRuntimeToken!(
      {
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        connectionId: CONNECTION_ID,
        presetId: AGENTIC_PRESET_ID,
        generationType: "regenerate",
        requestEpoch: 21,
      },
      target,
      issued.runtimeDecisionToken!,
      new AbortController().signal,
    );
    expect(consumed.mode).toBe("agentic");
  });

  test("a config revision change after token issue rejects before provider/compile", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    AGENT_RUNTIME_DECISION_SERVICE.resetTokensForTests();
    const target = { generationType: "normal" as const };
    const issued = await resolveEffectiveRuntime(USER_ID, {
      chatId: AGENTIC_CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal",
      target,
      mode: "agentic",
      requestEpoch: 22,
    });
    getDb().query("UPDATE preset_agent_configs SET config_revision = config_revision + 1 WHERE user_id = ? AND preset_id = ?").run(USER_ID, AGENTIC_PRESET_ID);
    try {
      await expect(__testing.buildDependencies().consumeRuntimeToken!(
        { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", requestEpoch: 22 },
        target,
        issued.runtimeDecisionToken!,
        new AbortController().signal,
      )).rejects.toMatchObject({
        name: "AgenticGenerationError",
        code: "decision_refresh_required",
        message: "decision_refresh_required: config_revision",
      });
    } finally {
      getDb().query("UPDATE preset_agent_configs SET config_revision = ? WHERE user_id = ? AND preset_id = ?").run(ADMITTED_CONFIG_REVISION, USER_ID, AGENTIC_PRESET_ID);
    }
  });

  test("a binding revision change after token issue rejects before provider/compile", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    AGENT_RUNTIME_DECISION_SERVICE.resetTokensForTests();
    const target = { generationType: "normal" as const };
    const issued = await resolveEffectiveRuntime(USER_ID, {
      chatId: AGENTIC_CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal",
      target,
      mode: "agentic",
      requestEpoch: 23,
    });
    getDb().query("UPDATE preset_agent_configs SET binding_revision = binding_revision + 1 WHERE user_id = ? AND preset_id = ?").run(USER_ID, AGENTIC_PRESET_ID);
    try {
      await expect(__testing.buildDependencies().consumeRuntimeToken!(
        { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", requestEpoch: 23 },
        target,
        issued.runtimeDecisionToken!,
        new AbortController().signal,
      )).rejects.toMatchObject({
        name: "AgenticGenerationError",
        code: "decision_refresh_required",
        message: "decision_refresh_required: binding_revision",
      });
    } finally {
      getDb().query("UPDATE preset_agent_configs SET binding_revision = ? WHERE user_id = ? AND preset_id = ?").run(ADMITTED_BINDING_REVISION, USER_ID, AGENTIC_PRESET_ID);
    }
  });

  test("assembly carries the real user input and the authored tool grant", async () => {
    const deps = __testing.buildDependencies();
    const decision = await deps.resolveRuntime!(
      { userId: USER_ID, chatId: CHAT_ID, connectionId: CONNECTION_ID, presetId: PRESET_ID, generationType: "normal", userInput: USER_INPUT },
      { generationType: "normal" },
      new AbortController().signal,
    );
    const snapshot = await deps.buildAssemblySnapshot!(
      { userId: USER_ID, chatId: CHAT_ID, connectionId: CONNECTION_ID, presetId: PRESET_ID, generationType: "normal", userInput: USER_INPUT },
      decision,
      { generationType: "normal" },
      new AbortController().signal,
      "test-assembly",
    ) as unknown as { target: { userInput: string }; agentConfig: unknown; availability: { toolIds: readonly string[] } };
    // The preflight snapshot is built with an empty input; ASSEMBLE must not
    // reuse it.
    expect(snapshot.target.userInput).toBe(USER_INPUT);
    // No normalized V2 config is authored for this preset. Runtime keeps the
    // executable config absent rather than consulting legacy metadata; the
    // host catalogue remains available only for snapshot diagnostics.
    expect(snapshot.agentConfig).toBeNull();
    expect(Array.isArray(snapshot.availability.toolIds)).toBe(true);
  });
  test("admits differently ordered World Info commit authority without provider and rejects source or member mutations", async () => {
    const db = getDb();
    const bookId = "book-runtime-world-authority";
    // Native World Info retains insertion order for equal order_value rows,
    // while admission's fallback query uses the ID tie-breaker. These IDs
    // deliberately make the two projections traverse the same sources in
    // opposite orders.
    const firstEntryId = "entry-runtime-world-authority-z";
    const secondEntryId = "entry-runtime-world-authority-a";
    const addedEntryId = "entry-runtime-world-authority-member";
    const character = db.query("SELECT extensions FROM characters WHERE id = ?").get("character-coordinator") as { extensions: string };
    const now = Date.now();
    db.query(
      "INSERT INTO world_books (id, user_id, name, description, folder, metadata, created_at, updated_at) VALUES (?, ?, ?, '', '', '{}', ?, ?)",
    ).run(bookId, USER_ID, "Runtime World Authority", now, now);
    const insertEntry = db.query(
      "INSERT INTO world_book_entries (id, world_book_id, uid, key, content, constant, disabled, vectorized, revision, created_at, updated_at) VALUES (?, ?, ?, '[]', ?, 1, 0, 0, 1, ?, ?)",
    );
    insertEntry.run(firstEntryId, bookId, firstEntryId, "First constant source", now, now);
    insertEntry.run(secondEntryId, bookId, secondEntryId, "Second constant source", now, now);
    db.query("UPDATE characters SET extensions = ? WHERE id = ?")
      .run(JSON.stringify({ world_book_ids: [bookId] }), "character-coordinator");

    try {
      const providerRequestsBefore = providerRequests.length;
      const deps = __testing.buildDependencies();
      const input = {
        userId: USER_ID,
        chatId: CHAT_ID,
        connectionId: CONNECTION_ID,
        presetId: PRESET_ID,
        generationType: "normal" as const,
        userInput: USER_INPUT,
      };
      const target = { generationType: "normal" as const };
      const signal = new AbortController().signal;
      const decision = await deps.resolveRuntime!(input, target, signal);
      const snapshot = await deps.buildAssemblySnapshot!(
        input,
        decision,
        target,
        signal,
        "test-world-derived-activation",
      );
      expect(snapshot.worldInfo.entries.map((entry) => [entry.id, entry.activated])).toEqual([
        [secondEntryId, true],
        [firstEntryId, true],
      ]);
      const plan = await deps.compileAssemblyPlan!(
        snapshot,
        input,
        decision,
        signal,
        "test-world-derived-activation",
      );
      const worldInfoEvidence = plan.privateEvidence.activation
        .filter((entry) => entry.kind === "world_info");
      expect(worldInfoEvidence.map((entry) => entry.entryId)).toEqual([
        secondEntryId,
        firstEntryId,
      ]);
      expect(worldInfoEvidence.every((entry) => !("source" in entry))).toBe(true);
      expect(providerRequests).toHaveLength(providerRequestsBefore);

      const revisionReader = __testing.makeRevisionReader({
        userId: USER_ID,
        chatId: CHAT_ID,
        assemblySurface: "WORK",
        presetId: PRESET_ID,
        targetCharacterId: "character-coordinator",
      });
      const worldMembers = snapshot.inputRevisionSet.entries
        .filter((member) => member.kind === "world_lore");
      expect(worldMembers).toHaveLength(4);
      for (const member of worldMembers) {
        expect(revisionReader(member, db)).toEqual({
          revision: member.revision,
          digest: member.digest,
        });
      }
      expect(providerRequests).toHaveLength(providerRequestsBefore);

      const contentMember = worldMembers.find((member) => member.id === secondEntryId)!;
      db.query("UPDATE world_book_entries SET content = ? WHERE id = ?")
        .run("Second source changed without revision", secondEntryId);
      const contentChanged = revisionReader(contentMember, db);
      expect(contentChanged?.revision).toBe(contentMember.revision);
      expect(contentChanged?.digest).not.toBe(contentMember.digest);
      db.query("UPDATE world_book_entries SET content = ? WHERE id = ?")
        .run("Second constant source", secondEntryId);
      expect(revisionReader(contentMember, db)).toEqual({
        revision: contentMember.revision,
        digest: contentMember.digest,
      });

      insertEntry.run(addedEntryId, bookId, addedEntryId, "Added authority member", now, now);
      const retainedMember = worldMembers.find((member) => member.id === firstEntryId)!;
      const membershipChanged = revisionReader(retainedMember, db);
      expect(membershipChanged?.revision).toBe(retainedMember.revision);
      expect(membershipChanged?.digest).not.toBe(retainedMember.digest);
      db.query("DELETE FROM world_book_entries WHERE id = ?").run(addedEntryId);
      expect(revisionReader(retainedMember, db)).toEqual({
        revision: retainedMember.revision,
        digest: retainedMember.digest,
      });

      db.query("UPDATE world_book_entries SET revision = revision + 1 WHERE id = ?").run(secondEntryId);
      expect(revisionReader(contentMember, db)?.revision).not.toBe(contentMember.revision);
      expect(providerRequests).toHaveLength(providerRequestsBefore);
      await expect(deps.buildAssemblySnapshot!(
        input,
        decision,
        target,
        signal,
        "test-world-stale-source",
      )).rejects.toMatchObject({
        name: "AgenticGenerationError",
        code: "agentic_revision_conflict",
        message: "stale_input_revision",
      });
      expect(providerRequests).toHaveLength(providerRequestsBefore);
    } finally {
      db.query("UPDATE characters SET extensions = ? WHERE id = ?")
        .run(character.extensions, "character-coordinator");
      db.query("DELETE FROM world_book_entries WHERE world_book_id = ?").run(bookId);
      db.query("DELETE FROM world_books WHERE id = ?").run(bookId);
    }
  });
  test("production assembly keeps cognition inactive when no Loom source is authored", async () => {
    const deps = __testing.buildDependencies();
    const input = {
      userId: USER_ID,
      chatId: CHAT_ID,
      connectionId: CONNECTION_ID,
      presetId: PRESET_ID,
      generationType: "normal" as const,
      userInput: USER_INPUT,
    };
    const target = { generationType: "normal" as const };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!(input, target, signal);
    const snapshot = await deps.buildAssemblySnapshot!(input, decision, target, signal, "test-cognition");
    expect(snapshot.agentConfig).toBeNull();
    expect(snapshot.agentCognition).toMatchObject({
      schema: "present",
      cognitionGraph: null,
      cognitionSource: null,
    });
    expect(snapshot.agentCognition.revision).toEqual(expect.any(String));
  });

  test("projects frozen provider through the first Agentic event and elapsed-zero recovery polls", async () => {
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const target = { generationType: "normal" as const, revision: ADMITTED_TARGET_REVISION };
    const firstStarted = Promise.withResolvers<Record<string, unknown>>();
    const unsubscribe = eventBus.on(EventType.GENERATION_STARTED, (message) => {
      if (message.payload?.chatId === AGENTIC_CHAT_ID) {
        firstStarted.resolve(message.payload as Record<string, unknown>);
      }
    });
    const decision = await deps.resolveRuntime!(
      { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", userInput: USER_INPUT },
      target,
      new AbortController().signal,
    );
    const before = AGENT_RUNTIME_ADMISSION_MANAGER.snapshot().rootsByUser[USER_ID] ?? 0;
    const providerRequestsBefore = providerRequests.length;
    const execution = await deps.createExecution!({
      executionId: "exec-normal-1",
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      signal: new AbortController().signal,
    });
    try {
      const startedPayload = await firstStarted.promise;
      expect(startedPayload).toMatchObject({
        generationId: "exec-normal-1",
        chatId: AGENTIC_CHAT_ID,
        generationType: "normal",
        provider: "scripted-coordinator",
        model: "scripted-model",
      });
      expect(providerRequests).toHaveLength(providerRequestsBefore);
      expect(AGENT_RUNTIME_ADMISSION_MANAGER.snapshot().rootsByUser[USER_ID] ?? 0).toBe(before + 1);
      expect(getPoolEntry("exec-normal-1")).toMatchObject({
        generationId: "exec-normal-1",
        chatId: AGENTIC_CHAT_ID,
        status: "assembling",
        provider: "scripted-coordinator",
        model: "scripted-model",
      });

      const pollingApp = new Hono<{ Variables: { userId: string } }>();
      pollingApp.use("*", async (c, next) => {
        c.set("userId", USER_ID);
        await next();
      });
      pollingApp.route("/generate", generateRoutes);
      const [statusResponse, activeResponse] = await Promise.all([
        pollingApp.request(`http://localhost/generate/status/${AGENTIC_CHAT_ID}`),
        pollingApp.request("http://localhost/generate/active"),
      ]);
      expect(statusResponse.status).toBe(200);
      expect(await statusResponse.json()).toMatchObject({
        active: true,
        generationId: "exec-normal-1",
        status: "assembling",
        provider: "scripted-coordinator",
        model: "scripted-model",
      });
      expect(activeResponse.status).toBe(200);
      expect(await activeResponse.json()).toContainEqual(expect.objectContaining({
        generationId: "exec-normal-1",
        chatId: AGENTIC_CHAT_ID,
        status: "assembling",
        provider: "scripted-coordinator",
        model: "scripted-model",
      }));

      const persistentWorkspace = getDb().query(
        "SELECT workspace_id, revision FROM persistent_workspaces WHERE user_id = ? AND chat_id = ?",
      ).get(USER_ID, AGENTIC_CHAT_ID) as { workspace_id: string; revision: number } | null;
      const linkedInspection = getAgentRunInspection(USER_ID, execution.id, AGENTIC_CHAT_ID);
      const linkedAssociation = linkedInspection?.workspaceAssociations.find(({ relation }) => relation === "linked");
      expect(persistentWorkspace).not.toBeNull();
      expect(linkedAssociation).toMatchObject({
        id: "workspace:linked:exec-normal-1",
        version: 1,
        workspaceId: persistentWorkspace?.workspace_id,
        workspaceRevision: persistentWorkspace?.revision,
        relation: "linked",
        objectKind: "objective",
        objectId: null,
        sourceRevision: persistentWorkspace?.revision,
        sourceDeleted: false,
        provenanceDigest: null,
      });
      const runtimeWorkspace = getDb().query(
        "SELECT workspace_id FROM agent_turn_workspaces WHERE turn_id = ? AND user_id = ? AND chat_id = ?",
      ).get(execution.id, USER_ID, AGENTIC_CHAT_ID) as { workspace_id: string } | null;
      expect(runtimeWorkspace).toEqual({ workspace_id: `workspace:${execution.id}` });
      expect(linkedAssociation?.workspaceId).not.toBe(runtimeWorkspace?.workspace_id);
    } finally {
      unsubscribe();
      deps.cleanup!({ execution } as never);
    }
    expect(AGENT_RUNTIME_ADMISSION_MANAGER.snapshot().rootsByUser[USER_ID] ?? 0).toBe(before);
  });

  test("terminalizes the host-owned persistent session after its source chat is deleted", async () => {
    const db = getDb();
    const chatId = `chat-coordinator-detached-${Date.now()}`;
    const now = Date.now();
    db.query(
      "INSERT INTO chats (id, user_id, character_id, name, created_at, updated_at, metadata, generation_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(chatId, USER_ID, "character-coordinator", "Detached Coordinator Chat", now, now, "{}", ADMITTED_TARGET_REVISION);
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const target = { generationType: "normal" as const, revision: ADMITTED_TARGET_REVISION };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!(
      { userId: USER_ID, chatId, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", userInput: USER_INPUT },
      target,
      signal,
    );
    const executionId = `exec-persistent-detached-${Date.now()}`;
    const execution = await deps.createExecution!({
      executionId,
      userId: USER_ID,
      chatId,
      target,
      decision,
      signal,
    });
    try {
      transitionTurnExecution({
        executionId,
        ownerToken: execution.ownerToken!,
        expectedPhase: execution.phase!,
        nextPhase: "CANCELLED",
        reason: "agentic_cancelled",
      });
      db.run("PRAGMA foreign_keys = ON");
      try {
        expect(deleteChat(USER_ID, chatId)).toBe(true);
      } finally {
        db.run("PRAGMA foreign_keys = OFF");
      }
      deps.publishTerminal!({
        executionId,
        userId: USER_ID,
        chatId,
        status: "cancelled",
        phase: "CANCELLED",
        target,
        errorCode: "agentic_cancelled",
      });
      const session = db.query(
        "SELECT chat_id, phase, status, outcome FROM persistent_workspace_turn_sessions WHERE user_id = ? AND execution_id = ?",
      ).get(USER_ID, executionId) as {
        chat_id: string | null;
        phase: string;
        status: string;
        outcome: string | null;
      } | null;
      expect(session).toEqual({
        chat_id: null,
        phase: "TERMINAL",
        status: "terminal",
        outcome: "stopped",
      });
    } finally {
      deps.cleanup!({
        execution,
        phase: "CANCELLED",
        status: "cancelled",
      } as never);
    }
  });
  test("restart recovery converges the persistent session after a transient terminal transaction failure", async () => {
    const db = getDb();
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const target = { generationType: "normal" as const, revision: ADMITTED_TARGET_REVISION };
    const decision = await deps.resolveRuntime!(
      { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", userInput: USER_INPUT },
      target,
      new AbortController().signal,
    );
    const executionId = `exec-persistent-recovery-${Date.now()}`;
    const gate = `agentic_terminal_recovery_gate_${Date.now()}`;
    const trigger = `agentic_terminal_recovery_trigger_${Date.now()}`;
    const execution = await deps.createExecution!({
      executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      signal: new AbortController().signal,
    });
    db.run(`CREATE TABLE ${gate} (blocked INTEGER NOT NULL CHECK (blocked IN (0, 1)))`);
    db.query(`INSERT INTO ${gate} (blocked) VALUES (?)`).run(1);
    db.run(`
      CREATE TRIGGER ${trigger}
      BEFORE UPDATE ON persistent_workspace_turn_sessions
      WHEN (SELECT blocked FROM ${gate} LIMIT 1) = 1
      BEGIN
        SELECT RAISE(ABORT, 'transient persistent session failure');
      END
    `);
    try {
      transitionTurnExecution({
        executionId,
        ownerToken: execution.ownerToken!,
        expectedPhase: execution.phase!,
        nextPhase: "FAILED",
        reason: "agentic_internal_error",
      });
      expect(() => deps.publishTerminal!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        status: "failed",
        phase: "FAILED",
        target,
        errorCode: "agentic_internal_error",
      })).toThrow();
      deps.cleanup!({ execution, phase: "FAILED", status: "failed" } as never);
      expect(db.query(
        "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE execution_id = ? AND user_id = ?",
      ).get(executionId, USER_ID)).toMatchObject({
        phase: "ADMIT",
        status: "pending",
        outcome: null,
      });
      db.query(`UPDATE ${gate} SET blocked = 0`).run();
      __testing.resetInstallation();
      installAgenticGenerationCoordinator();
      expect(db.query(
        "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE execution_id = ? AND user_id = ?",
      ).get(executionId, USER_ID)).toMatchObject({
        phase: "TERMINAL",
        status: "terminal",
        outcome: "failed",
      });
    } finally {
      db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
      db.run(`DROP TABLE IF EXISTS ${gate}`);
    }
  });


  test("terminalizes the persistent admission session when workspace creation fails", async () => {
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const target = { generationType: "normal" as const, revision: ADMITTED_TARGET_REVISION };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!(
      { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", userInput: USER_INPUT },
      target,
      signal,
    );
    const executionId = `exec-persistent-admission-failure-${Date.now()}`;
    getDb().run(`
      CREATE TRIGGER reject_agentic_workspace_admission
      BEFORE INSERT ON agent_turn_workspaces
      BEGIN
        SELECT RAISE(ABORT, 'workspace admission rejected');
      END
    `);
    try {
      await expect(deps.createExecution!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        target,
        decision,
        signal,
      })).rejects.toThrow();
    } finally {
      getDb().run("DROP TRIGGER reject_agentic_workspace_admission");
    }
    try {
      const before = getDb().query(
        "SELECT phase, status, outcome, revision FROM persistent_workspace_turn_sessions WHERE execution_id = ? AND user_id = ? AND chat_id = ?",
      ).get(executionId, USER_ID, AGENTIC_CHAT_ID);
      expect(before).toMatchObject({ phase: "ADMIT", status: "pending", outcome: null, revision: 0 });
      deps.publishTerminal!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        status: "failed",
        phase: "FAILED",
        target,
        errorCode: "agentic_internal_error",
      });
      expect(getDb().query(
        "SELECT phase, status, outcome, revision FROM persistent_workspace_turn_sessions WHERE execution_id = ? AND user_id = ? AND chat_id = ?",
      ).get(executionId, USER_ID, AGENTIC_CHAT_ID)).toMatchObject({
        phase: "TERMINAL",
        status: "terminal",
        outcome: "failed",
        revision: 1,
      });
      const inspection = getAgentRunInspection(USER_ID, executionId, AGENTIC_CHAT_ID);
      expect(inspection).toMatchObject({ status: "terminal", outcome: "failed" });
      expect(inspection?.workspaceAssociations).toHaveLength(1);
      expect(inspection?.workspaceAssociations[0]).toMatchObject({
        id: "workspace:linked:" + executionId,
        relation: "linked",
      });
      expect(getAgentRun(USER_ID, executionId, AGENTIC_CHAT_ID)).toMatchObject({
        workStatus: "terminal",
        workOutcome: "failed",
      });
    } finally {
      deps.cleanup!({ executionId, phase: "FAILED", status: "failed" } as never);
      getDb().query("DELETE FROM persistent_workspace_turn_sessions WHERE execution_id = ? AND user_id = ?")
        .run(executionId, USER_ID);
      getDb().query("DELETE FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?")
        .run(USER_ID, executionId);
      getDb().query("DELETE FROM agent_turn_executions WHERE user_id = ? AND id = ?")
        .run(USER_ID, executionId);
    }
  });
  test("canonicalizes durable Stop and timeout markers racing asynchronous admission failure", async () => {
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const target = { generationType: "normal" as const, revision: ADMITTED_TARGET_REVISION };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!(
      { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", userInput: USER_INPUT },
      target,
      signal,
    );
    for (const cause of ["stop", "timeout"] as const) {
      const executionId = `exec-admission-marker-race-${cause}-${Date.now()}`;
      const trigger = `reject_admission_marker_race_${cause}`;
      getDb().run(`CREATE TRIGGER ${trigger}
        BEFORE INSERT ON agent_turn_workspaces
        BEGIN SELECT RAISE(ABORT, 'admission marker race failure'); END`);
      try {
        const admission = deps.createExecution!({
          executionId, userId: USER_ID, chatId: AGENTIC_CHAT_ID, target, decision, signal,
        });
        const authority = getDb().query(
          "SELECT cas_owner, deadline_at, state, cancel_requested_at FROM agent_turn_executions WHERE user_id = ? AND id = ?",
        ).get(USER_ID, executionId) as {
          cas_owner: string; deadline_at: number; state: string; cancel_requested_at: number | null;
        } | null;
        expect(authority).toMatchObject({ state: "ASSEMBLE", cancel_requested_at: null });
        if (!authority) throw new Error("admission execution authority was not persisted before async credential freeze");
        expect(requestTurnCancellation({
          executionId, ownerToken: authority.cas_owner, reason: cause === "stop" ? "stopped" : "timed_out",
          ...(cause === "timeout" ? { now: authority.deadline_at } : {}),
        }).code).toBe(cause === "stop" ? "cancelled" : "timed_out");
        await expect(admission).rejects.toThrow("already_terminal");
        expect(getDb().query(
          "SELECT state, terminal_code FROM agent_turn_executions WHERE user_id = ? AND id = ?",
        ).get(USER_ID, executionId)).toEqual(cause === "stop"
          ? { state: "CANCELLED", terminal_code: "cancelled" }
          : { state: "TIMED_OUT", terminal_code: "root_wall_clock_limit_exceeded" });
      } finally {
        getDb().run(`DROP TRIGGER IF EXISTS ${trigger}`);
        deps.cleanup!({ executionId } as never);
        getDb().query("DELETE FROM persistent_workspace_turn_sessions WHERE execution_id = ? AND user_id = ?")
          .run(executionId, USER_ID);
        getDb().query("DELETE FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?")
          .run(USER_ID, executionId);
        getDb().query("DELETE FROM agent_turn_executions WHERE user_id = ? AND id = ?")
          .run(USER_ID, executionId);
      }
    }
  });
  test("records a failed persistent session when admission is aborted by a timeout", async () => {
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const target = { generationType: "normal" as const, revision: ADMITTED_TARGET_REVISION };
    const controller = new AbortController();
    controller.abort(new DOMException("Agentic root deadline", "TimeoutError"));
    const decision = await deps.resolveRuntime!(
      { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", userInput: USER_INPUT },
      target,
      controller.signal,
    );
    const executionId = `exec-persistent-admission-timeout-${Date.now()}`;
    getDb().run(`
      CREATE TRIGGER reject_agentic_timeout_workspace_admission
      BEFORE INSERT ON agent_turn_workspaces
      BEGIN
        SELECT RAISE(ABORT, 'workspace admission rejected after timeout');
      END
    `);
    try {
      await expect(deps.createExecution!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        target,
        decision,
        signal: controller.signal,
      })).rejects.toThrow();
    } finally {
      getDb().run("DROP TRIGGER reject_agentic_timeout_workspace_admission");
    }
    try {
      expect(getDb().query(
        "SELECT phase, status, outcome, revision FROM persistent_workspace_turn_sessions WHERE execution_id = ? AND user_id = ?",
      ).get(executionId, USER_ID)).toMatchObject({ phase: "ADMIT", status: "pending", outcome: null, revision: 0 });
      deps.publishTerminal!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        status: "timed_out",
        phase: "TIMED_OUT",
        target,
        errorCode: "agentic_timed_out",
      });
      expect(getDb().query(
        "SELECT phase, status, outcome, revision FROM persistent_workspace_turn_sessions WHERE execution_id = ? AND user_id = ?",
      ).get(executionId, USER_ID)).toMatchObject({
        phase: "TERMINAL",
        status: "terminal",
        outcome: "failed",
        revision: 1,
      });
      expect(getAgentRunInspection(USER_ID, executionId, AGENTIC_CHAT_ID)).toMatchObject({
        status: "terminal",
        outcome: "failed",
        reason: "deadline",
      });
      const run = getAgentRun(USER_ID, executionId, AGENTIC_CHAT_ID);
      expect(run).toMatchObject({
        workStatus: "terminal",
        workOutcome: "failed",
      });
      expect(run?.error?.code).not.toBe("projection_unavailable");
    } finally {
      deps.cleanup!({ executionId, phase: "TIMED_OUT", status: "timed_out" } as never);
      getDb().query("DELETE FROM persistent_workspace_turn_sessions WHERE execution_id = ? AND user_id = ?")
        .run(executionId, USER_ID);
      getDb().query("DELETE FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?")
        .run(USER_ID, executionId);
      getDb().query("DELETE FROM agent_turn_executions WHERE user_id = ? AND id = ?")
        .run(USER_ID, executionId);
    }
  });
  test("admission reserves the exact final render envelope and keeps the RENDER re-reservation exclusive", async () => {
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const target = { generationType: "normal" as const, revision: ADMITTED_TARGET_REVISION };
    const decision = await deps.resolveRuntime!(
      { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", userInput: USER_INPUT },
      target,
      new AbortController().signal,
    );
    const execution = await deps.createExecution!({
      executionId: "exec-render-reservation-1",
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      signal: new AbortController().signal,
    });
    try {
      const row = getDb().query(
        "SELECT final_render_reservations_json, deadline_at FROM agent_turn_executions WHERE id = ?",
      ).get(execution.id) as { final_render_reservations_json: string; deadline_at: number };
      const ownerToken = execution.ownerToken ?? "";
      const deadlineAt = row.deadline_at;
      const reservations = JSON.parse(row.final_render_reservations_json) as Array<{
        id: string;
        maxBytes: number;
        contextBytes: number;
        outputBytes: number;
        activityChunks: number;
        deadlineAt: number;
      }>;
      expect(reservations).toHaveLength(1);
      expect(reservations[0].id).toBe(`render:${execution.id}`);
      const activityChunks = finalRenderActivityChunksFromHostLimitsV1(
        getAgentRuntimeHostLimits().activityEvents,
      );
      const envelope = calculateFinalRenderReservationEnvelopeV1({
        activityChunks,
        contextBytes: HOST_PREPARATION_LIMITS_V1.maxInputBytes,
        outputBytes: HOST_PREPARATION_LIMITS_V1.maxOutputBytes,
      });
      expect(reservations[0].deadlineAt).toBe(deadlineAt);

      // The RENDER-entry call with the identical frozen envelope is a no-op.
      const replayed = reserveFinalRender({
        executionId: execution.id,
        ownerToken,
        reservationKey: `render:${execution.id}`,
        maxBytes: envelope.maxBytes,
        contextBytes: envelope.contextBytes,
        outputBytes: envelope.outputBytes,
        activityChunks: envelope.activityChunks,
        deadlineAt,
      });
      expect(replayed.execution.finalRenderReservations).toHaveLength(1);

      // A different envelope for the same key stays exclusively rejected.
      const drifted = calculateFinalRenderReservationEnvelopeV1({
        activityChunks,
        contextBytes: HOST_PREPARATION_LIMITS_V1.maxInputBytes + 1,
        outputBytes: HOST_PREPARATION_LIMITS_V1.maxOutputBytes,
      });
      let driftError: unknown = null;
      try {
        reserveFinalRender({
          executionId: execution.id,
          ownerToken,
          reservationKey: `render:${execution.id}`,
          maxBytes: drifted.maxBytes,
          contextBytes: drifted.contextBytes,
          outputBytes: drifted.outputBytes,
          activityChunks: drifted.activityChunks,
          deadlineAt,
        });
      } catch (error) {
        driftError = error;
      }
      expect(driftError).toBeInstanceOf(TurnExecutionError);
      expect((driftError as TurnExecutionError).code).toBe("render_reservation_taken");
    } finally {
      deps.cleanup!({ execution } as never);
    }
  });


  test("a non-normal target binds live message revisions and rejects an unknown message", async () => {
    markAgenticRuntimeReady();
    const db = getDb();
    const now = Date.now();
    db.query(
      "INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra, created_at, generation_revision) VALUES (?, ?, 0, 0, ?, ?, ?, 0, ?, ?, '{}', ?, ?)",
    ).run("message-coordinator", AGENTIC_CHAT_ID, "Coordinator", "first", now, JSON.stringify(["first"]), JSON.stringify([now]), now, ADMITTED_TARGET_REVISION);
    const deps = __testing.buildDependencies();
    const target = {
      generationType: "regenerate" as const,
      messageId: "message-coordinator",
      revision: ADMITTED_TARGET_REVISION,
    };
    const decision = await deps.resolveRuntime!(
      { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "regenerate", messageId: "message-coordinator", userInput: USER_INPUT },
      target,
      new AbortController().signal,
    );
    const execution = await deps.createExecution!({
      executionId: "exec-regenerate-1",
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      signal: new AbortController().signal,
    });
    try {
      const entry = getPoolEntry("exec-regenerate-1");
      expect(entry?.targetMessageId).toBe("message-coordinator");
      // A regenerate may address the next free swipe slot.
      expect(entry?.targetSwipeId).toBe(1);
    } finally {
      deps.cleanup!({ execution } as never);
    }
    let rejected: unknown = null;
    try {
      await deps.createExecution!({
        executionId: "exec-regenerate-2",
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        target: { generationType: "regenerate", messageId: "message-missing", revision: ADMITTED_TARGET_REVISION },
        decision,
        signal: new AbortController().signal,
      });
    } catch (error) {
      rejected = error;
    }
    expect((rejected as Error | null)?.message).toBe("agentic_target_unsupported");
  });
  test("authored two-phase terminal transition materializes native final render and persists one canonical COMMIT chronology", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    await probeIsolateBackendsAtStartup();
    startAgentRuntimeEpoch();
    installAgenticGenerationCoordinator();
    scriptedWorkRound = 0;
    scriptedTwoPhase = true;
    scriptedTwoPhaseTurnId = "";
    scriptedTwoPhaseMutationIssued = false;
    scriptedTwoPhaseSnapshots.length = 0;
    providerRequests.length = 0;
    const phaseDefinitions: AgentCustomPhaseV1[] = [
      {
        version: 1,
        id: "terminal_render_first",
        label: "Terminal render first phase",
        instructionRefs: [],
        childInstructionSubsets: [],
        required: true,
        enter: { kind: "phase", value: "WORK" },
        exit: { kind: "phase", value: "COMPLETE" },
        capabilityRequests: [],
        repeatLimit: 0,
        nextPhaseIds: ["terminal_render_second"],
      },
      {
        version: 1,
        id: "terminal_render_second",
        label: "Terminal render second phase",
        instructionRefs: [],
        childInstructionSubsets: [],
        required: true,
        enter: { kind: "phase", value: "WORK" },
        exit: { kind: "phase", value: "COMPLETE" },
        capabilityRequests: ["workspace_write"],
        repeatLimit: 0,
        nextPhaseIds: [],
      },
    ];
    expect(compileAgentRuntimePhases(phaseDefinitions).status).toBe("ready");
    const persistedConfig = getPresetAgentConfig(USER_ID, AGENTIC_PRESET_ID)?.config;
    if (!persistedConfig) throw new Error("Agentic coordinator fixture config is unavailable");
    const fixtureDb = getDb();
    const originalConfig = fixtureDb.query(
      "SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, AGENTIC_PRESET_ID) as { config_json: string };
    fixtureDb.query(
      "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
    ).run(JSON.stringify({
      config: {
        ...persistedConfig,
        taskPolicy: { templateIds: ["terminal_render_optional_task"] },
        runtimePolicy: {
          version: 1,
          authority: "loom",
          scope: "preset",
          defaultMode: "agentic",
          loomPolicy: null,
          phases: phaseDefinitions,
        },
      },
      taskTemplates: [{
        id: "terminal_render_optional_task",
        required: false,
        dependencies: [],
        activation: { kind: "generation_type", value: "regenerate" },
      }],
      reviewAcknowledgements: [],
    }), USER_ID, AGENTIC_PRESET_ID);
    try {
    const now = Date.now();
    getDb().query(
      "INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra, created_at, generation_revision) VALUES (?, ?, 0, 1, ?, ?, ?, 0, ?, ?, '{}', ?, ?)",
    ).run(
      "message-user-render-narrative",
      AGENTIC_CHAT_ID,
      "User",
      USER_INPUT,
      now,
      JSON.stringify([USER_INPUT]),
      JSON.stringify([now]),
      now,
      ADMITTED_TARGET_REVISION,
    );


    const decision = await resolveEffectiveRuntime(USER_ID, {
      chatId: AGENTIC_CHAT_ID,
      logicalConnectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      target: { generationType: "normal", messageId: null, swipeId: null },
      mode: "agentic",
      requestEpoch: 9,
    });
    expect(decision.effectiveMode).toBe("agentic");
    expect(decision.runtimeDecisionToken).toBeTruthy();

    const started = await startGeneration({
      userId: USER_ID,
      chat_id: AGENTIC_CHAT_ID,
      connection_id: CONNECTION_ID,
      preset_id: AGENTIC_PRESET_ID,
      generation_type: "normal",
      mode: "agentic",
      runtime_decision_token: decision.runtimeDecisionToken!,
      request_epoch: 9,
      user_input: USER_INPUT,
      parameters: { max_tokens: 256 },
    });
    scriptedTwoPhaseTurnId = started.generationId;
    const settled = await waitForAgenticGeneration(started.generationId);
    expect(settled).toMatchObject({ status: "completed", phase: "COMMITTED" });

    const phaseSegments = fixtureDb.query(
      "SELECT phase_id, phase_index, phase_occurrence FROM agent_work_segments WHERE user_id = ? AND execution_id = ? ORDER BY segment_ordinal ASC",
    ).all(USER_ID, started.generationId) as Array<{
      phase_id: string;
      phase_index: number;
      phase_occurrence: number;
    }>;
    expect(phaseSegments).toEqual([
      { phase_id: "terminal_render_first", phase_index: 0, phase_occurrence: 0 },
      { phase_id: "terminal_render_second", phase_index: 1, phase_occurrence: 0 },
    ]);
    const phaseTransitions = fixtureDb.query(
      "SELECT transition_kind, target_phase_id, target_phase_index FROM agent_work_segment_transitions WHERE user_id = ? AND execution_id = ? ORDER BY created_at ASC",
    ).all(USER_ID, started.generationId) as Array<{
      transition_kind: string;
      target_phase_id: string | null;
      target_phase_index: number | null;
    }>;
    expect(phaseTransitions).toEqual([
      {
        transition_kind: "advance",
        target_phase_id: "terminal_render_second",
        target_phase_index: 1,
      },
      {
        transition_kind: "terminal",
        target_phase_id: null,
        target_phase_index: null,
      },
    ]);
    const ordinaryRequests = providerRequests.filter((request) => request.toolMode === "ordinary");
    expect(ordinaryRequests[0]?.parameters?.max_tokens).toBe(256);
    expect(ordinaryRequests).toHaveLength(3);
    expect(ordinaryRequests[0]?.tools?.some((tool) => tool.name === "complete_turn")).toBe(true);
    expect(ordinaryRequests[0]?.tools?.some((tool) => tool.name === "workspace_record_finding")).toBe(false);
    expect(ordinaryRequests[1]?.tools?.some((tool) => tool.name === "workspace_record_finding")).toBe(true);
    expect(ordinaryRequests[2]?.tools?.some((tool) => tool.name === "complete_turn")).toBe(true);
    const finalization = providerRequests.find((request) => request.toolMode === "finalization");
    expect(finalization).toBeDefined();
    expect(finalization?.tools).toEqual([]);
    expect(finalization?.parameters?.max_tokens).toBe(256);
    expect(finalization?.providerTransientCarrier).toBeUndefined();
    const finalizationMessages = finalization?.messages ?? [];
    expect(finalizationMessages.some((message) => message.role === "user" && String(message.content).includes(USER_INPUT))).toBe(true);
    expect(finalizationMessages.some((message) =>
      message.role === "system" && String(message.content).includes("in-character assistant reply"),
    )).toBe(true);
    expect(finalizationMessages.some((message) =>
      (message.role === "user" || message.role === "assistant") && String(message.content).includes("complete_turn"),
    )).toBe(false);
    expect(finalizationMessages.some((message) =>
      message.role === "system" && String(message.content).includes("Do not mention tools"),
    )).toBe(true);

    const db = getDb();
    const receipt = db.query(
      "SELECT receipt_id, message_id FROM agent_turn_commit_receipts WHERE execution_id = ?",
    ).get(started.generationId) as { receipt_id: string; message_id: string | null } | null;
    const receiptId = receipt?.receipt_id;
    const messageId = receipt?.message_id;
    if (!receiptId || !messageId) throw new Error("Agentic commit receipt did not include its message handoff");
    expect(receiptId).toBeTruthy();
    const message = db.query("SELECT content, name, extra FROM messages WHERE id = ? AND chat_id = ?")
      .get(messageId, AGENTIC_CHAT_ID) as { content: string; name: string; extra: string } | null;
    expect(message?.content).toBe("scripted render");
    expect(message?.name).toBe("Coordinator Character");
    expect(JSON.parse(message?.extra ?? "{}")).toMatchObject({
      character_id: "character-coordinator",
      usage: { promptTokens: 17, completionTokens: 3, totalTokens: 20 },
    });
    const breakdown = breakdownSvc.getBreakdown(USER_ID, messageId);
    expect(breakdown).toMatchObject({
      assemblySurface: "WORK",
      model: "scripted-model",
      provider: "scripted-coordinator",
      usage: { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 },
      tokenizer_name: null,
    });
    expect(breakdown?.messages).toEqual(finalizationMessages);
    expect(breakdown?.entries).toHaveLength(finalizationMessages.length);
    const projection = db.query(
      "SELECT status, snapshot_json, terminal_handoff_json FROM agent_run_projections WHERE user_id = ? AND turn_id = ?",
    ).get(USER_ID, started.generationId) as { status: string; snapshot_json: string; terminal_handoff_json: string | null } | null;
    expect(projection?.status).toBe("COMMITTED");
    expect(JSON.parse(projection?.snapshot_json ?? "{}").usage).toEqual({
      inputTokens: 17,
      outputTokens: 3,
      totalTokens: 20,
      toolCalls: 3,
      childInvocations: 0,
    });
    expect(JSON.parse(projection?.terminal_handoff_json ?? "{}").messageId).toBe(messageId);
    const inspection = db.query(
      "SELECT reason, terminal_receipt_json FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?",
    ).get(USER_ID, started.generationId) as { reason: string; terminal_receipt_json: string | null } | null;
    expect(inspection?.reason).toBe("none");
    expect(JSON.parse(inspection?.terminal_receipt_json ?? "{}").messageId).toBe(messageId);
    const persistentWorkspace = db.query(
      "SELECT workspace_id, revision FROM persistent_workspaces WHERE user_id = ? AND chat_id = ?",
    ).get(USER_ID, AGENTIC_CHAT_ID) as { workspace_id: string; revision: number } | null;
    const workspaceInspection = getAgentRunInspection(USER_ID, started.generationId, AGENTIC_CHAT_ID);
    const workspaceAssociations = (workspaceInspection?.workspaceAssociations ?? []).map((association) => ({
      id: association.id,
      relation: association.relation,
      workspaceId: association.workspaceId,
      workspaceRevision: association.workspaceRevision,
    }));
    expect(persistentWorkspace).not.toBeNull();
    expect(workspaceAssociations).toHaveLength(3);
    const linkedAssociation = workspaceAssociations.find(({ id }) => id === `workspace:linked:${started.generationId}`);
    const publicationAssociation = workspaceAssociations.find(({ id }) => id === `workspace:publication:${started.generationId}`);
    expect(linkedAssociation).toMatchObject({
      id: `workspace:linked:${started.generationId}`,
      relation: "linked",
      workspaceId: persistentWorkspace?.workspace_id,
    });
    expect(publicationAssociation).toMatchObject({
      id: `workspace:publication:${started.generationId}`,
      relation: "published",
      workspaceId: persistentWorkspace?.workspace_id,
      workspaceRevision: persistentWorkspace?.revision,
    });
    const runtimeWorkspace = db.query(
      "SELECT workspace_id, revision FROM agent_turn_workspaces WHERE turn_id = ? AND user_id = ? AND chat_id = ?",
    ).get(started.generationId, USER_ID, AGENTIC_CHAT_ID) as { workspace_id: string; revision: number } | null;
    expect(runtimeWorkspace).not.toBeNull();
    const segmentRecovery = db.query(
      "SELECT workspace_id, workspace_revision, resume_envelope_json FROM agent_work_segment_recovery WHERE user_id = ? AND execution_id = ?",
    ).get(USER_ID, started.generationId) as { workspace_id: string; workspace_revision: number; resume_envelope_json: string } | null;
    expect(segmentRecovery).not.toBeNull();
    const resumeEnvelope = JSON.parse(segmentRecovery?.resume_envelope_json ?? "{}") as {
      runtime?: { workspaceId?: string; workspaceRevision?: number };
    };
    expect(segmentRecovery?.workspace_id).toBe(runtimeWorkspace?.workspace_id);
    expect(segmentRecovery?.workspace_id).not.toBe(persistentWorkspace?.workspace_id);
    expect(resumeEnvelope.runtime?.workspaceId).toBe(runtimeWorkspace?.workspace_id);
    expect(resumeEnvelope.runtime?.workspaceRevision).toEqual(expect.any(Number));
    expect(resumeEnvelope.runtime!.workspaceRevision!).toBeLessThanOrEqual(runtimeWorkspace!.revision);
    const workAssociation = workspaceAssociations.find(({ id }) =>
      id === `workspace:work:${started.generationId}:${persistentWorkspace?.revision}`,
    );
    expect(workAssociation).toMatchObject({
      id: `workspace:work:${started.generationId}:${persistentWorkspace?.revision}`,
      relation: "linked",
      workspaceId: persistentWorkspace?.workspace_id,
      workspaceRevision: persistentWorkspace?.revision,
    });
    expect(workspaceAssociations.every(({ workspaceId }) =>
      workspaceId === persistentWorkspace?.workspace_id
      && workspaceId !== `workspace:${started.generationId}`,
    )).toBe(true);
    const commitMilestoneId = `phase:${started.generationId}:COMMIT`;
    const prepareMilestoneId = `phase:${started.generationId}:PREPARE_COMMIT`;
    const renderMilestoneId = `phase:${started.generationId}:RENDER`;
    const completionMilestoneId = `phase:${started.generationId}:COMPLETE`;
    const liveChronology = workspaceInspection?.transcript ?? [];
    const liveCompletionMilestone = liveChronology.find(({ id }) => id === completionMilestoneId);
    const liveRenderMilestone = liveChronology.find(({ id }) => id === renderMilestoneId);
    const livePrepareMilestone = liveChronology.find(({ id }) => id === prepareMilestoneId);
    const liveCommitMilestones = liveChronology.filter(({ id }) => id === commitMilestoneId);
    expect(liveCompletionMilestone?.correlation.phase).toBe("PREPARE_COMMIT");
    expect(liveRenderMilestone?.correlation.phase).toBe("RENDER");
    expect(livePrepareMilestone?.correlation.phase).toBe("COMMIT");
    expect(liveRenderMilestone!.correlation.hostSequence).toBeGreaterThan(
      liveCompletionMilestone!.correlation.hostSequence,
    );
    expect(livePrepareMilestone!.correlation.hostSequence).toBeGreaterThan(
      liveRenderMilestone!.correlation.hostSequence,
    );
    expect(liveCommitMilestones).toHaveLength(1);
    expect(liveCommitMilestones[0]?.correlation.phase).toBe("COMMIT");
    expect(liveCommitMilestones[0]!.correlation.hostSequence).toBeGreaterThan(
      livePrepareMilestone!.correlation.hostSequence,
    );
    expect(liveChronology.at(-1)?.id).toBe(commitMilestoneId);

    let responseGenerationId = "";
    let responseRequestActive = true;
    let queuedResponseTerminal: Record<string, unknown> | undefined;
    const responseTerminal = Promise.withResolvers<Record<string, unknown>>();
    const unsubscribeResponse = eventBus.on(EventType.GENERATION_ENDED, (event) => {
      if (!responseRequestActive) return;
      const payload = event.payload as Record<string, unknown> | undefined;
      if (!payload || typeof payload.generationId !== "string") return;
      if (responseGenerationId && payload.generationId !== responseGenerationId) return;
      if (!responseGenerationId) {
        queuedResponseTerminal = payload;
        return;
      }
      responseRequestActive = false;
      responseTerminal.resolve(payload);
      unsubscribeResponse();
    });
    const responseStarted = await startGeneration({
      userId: USER_ID,
      chat_id: AGENTIC_CHAT_ID,
      connection_id: CONNECTION_ID,
      preset_id: AGENTIC_PRESET_ID,
      generation_type: "normal",
      mode: "response",
      user_input: "response-path-input",
    });
    responseGenerationId = responseStarted.generationId;
    if (queuedResponseTerminal?.generationId === responseGenerationId) {
      responseRequestActive = false;
      responseTerminal.resolve(queuedResponseTerminal);
      unsubscribeResponse();
    }
    const timeout = setTimeout(() => {
      responseTerminal.reject(new Error("Response smoke generation did not settle"));
    }, 5_000);
    try {
      const responseTerminalPayload = await responseTerminal.promise;
      expect(responseStarted.mode).not.toBe("agentic");
      expect(typeof responseStarted.generationId).toBe("string");
      expect(responseTerminalPayload.error).toBeUndefined();
      expect(getPoolEntry(responseStarted.generationId)?.status).toBe("completed");
    } finally {
      clearTimeout(timeout);
      responseRequestActive = false;
      unsubscribeResponse();
    }
    __testing.resetInstallation();
    installAgenticGenerationCoordinator();
    const recoveredInspection = getAgentRunInspection(USER_ID, started.generationId, AGENTIC_CHAT_ID);
    const recoveredChronology = recoveredInspection?.transcript ?? [];
    const recoveredCompletionMilestone = recoveredChronology.find(({ id }) => id === completionMilestoneId);
    const recoveredRenderMilestone = recoveredChronology.find(({ id }) => id === renderMilestoneId);
    const recoveredPrepareMilestone = recoveredChronology.find(({ id }) => id === prepareMilestoneId);
    const recoveredCommitMilestones = recoveredChronology.filter(({ id }) => id === commitMilestoneId);
    expect(recoveredCompletionMilestone?.correlation.phase).toBe("PREPARE_COMMIT");
    expect(recoveredRenderMilestone?.correlation.phase).toBe("RENDER");
    expect(recoveredRenderMilestone!.correlation.hostSequence).toBeGreaterThan(
      recoveredCompletionMilestone!.correlation.hostSequence,
    );
    expect(recoveredPrepareMilestone!.correlation.hostSequence).toBeGreaterThan(
      recoveredRenderMilestone!.correlation.hostSequence,
    );
    expect(recoveredCommitMilestones).toHaveLength(1);
    expect(recoveredCommitMilestones[0]?.correlation.phase).toBe("COMMIT");
    expect(recoveredCommitMilestones[0]!.correlation.hostSequence).toBeGreaterThan(
      recoveredPrepareMilestone!.correlation.hostSequence,
    );
    expect(recoveredChronology.at(-1)?.id).toBe(commitMilestoneId);
    } finally {
      fixtureDb.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(originalConfig.config_json, USER_ID, AGENTIC_PRESET_ID);
      scriptedTwoPhase = false;
      scriptedTwoPhaseTurnId = "";
      scriptedTwoPhaseMutationIssued = false;
      scriptedTwoPhaseSnapshots.length = 0;
      providerRequests.length = 0;
    }
  });
  test("COMMITTED continued swipe emits the exact durable content after its projection", async () => {
    const db = getDb();
    const deps = __testing.buildDependencies();
    const executionId = "exec-terminal-continue-" + Date.now();
    const messageId = "message-terminal-continue-" + Date.now();
    const prefix = "durable continued prefix";
    const provisionalSuffix = " prepared suffix";
    const committedContent = prefix + provisionalSuffix;
    seedTargetMessage(messageId, AGENTIC_CHAT_ID, ADMITTED_TARGET_REVISION);
    const now = Date.now();
    db.query(
      "UPDATE messages SET content = ?, swipe_id = 1, swipes = ?, swipe_dates = ? WHERE id = ? AND chat_id = ?",
    ).run(
      prefix,
      JSON.stringify(["untouched alternative", prefix]),
      JSON.stringify([now, now]),
      messageId,
      AGENTIC_CHAT_ID,
    );
    const target = {
      generationType: "continue" as const,
      messageId,
      swipeId: 1,
      revision: ADMITTED_TARGET_REVISION,
    };
    const created = createTurnExecution({
      id: executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      generationId: executionId,
      target: {
        kind: "continue",
        messageId,
        swipeId: 1,
        messageIndex: 0,
        swipeCount: 2,
        chatGenerationRevision: ADMITTED_TARGET_REVISION,
        messageGenerationRevision: ADMITTED_TARGET_REVISION,
      },
      mode: "agentic",
      runtimeEpoch: 1,
      deadlineAt: Date.now() + 60_000,
      workspaceId: "workspace:" + executionId,
      rootLedger: {},
      frameCapabilities: {},
    });
    const execution = created.execution;
    const ownerToken = created.ownerToken;
    createPoolEntry({
      generationId: executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      generationType: "continue",
      characterName: "Coordinator",
      model: "scripted-model",
      targetMessageId: messageId,
      targetSwipeId: 1,
    });
    appendPoolContent(executionId, provisionalSuffix);
    let currentPhase = execution.phase;
    for (const nextPhase of ["WORK", "COMPLETE", "RENDER", "PREPARE_COMMIT", "COMMITTING"] as const) {
      currentPhase = transitionTurnExecution({
        executionId,
        ownerToken,
        expectedPhase: currentPhase,
        nextPhase,
        ignoreCancellation: true,
      }).execution.phase;
    }
    db.query(
      "UPDATE messages SET content = ?, swipe_id = 1, swipes = ?, generation_revision = generation_revision + 1 WHERE id = ? AND chat_id = ?",
    ).run(
      committedContent,
      JSON.stringify(["untouched alternative", committedContent]),
      messageId,
      AGENTIC_CHAT_ID,
    );
    finalizeTurnCommit({
      executionId,
      ownerToken,
      receiptId: "receipt:" + executionId,
      messageId,
      swipeId: 1,
      summary: { source: "continued-swipe-terminal-test" },
    });

    const order: string[] = [];
    const ended = Promise.withResolvers<Record<string, unknown>>();
    const removeProjection = eventBus.onInternal(EventType.AGENT_RUN_CHANGED, (event) => {
      const payload = event.payload as { readonly run?: { readonly turnId?: unknown } } | undefined;
      if (payload?.run?.turnId === executionId) order.push("projection");
    });
    const removeTerminal = eventBus.on(EventType.GENERATION_ENDED, (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (payload?.generationId !== executionId) return;
      order.push("terminal");
      ended.resolve(payload);
    });
    const timeout = setTimeout(() => ended.reject(new Error("continued-swipe terminal event missing")), 2_000);
    try {
      deps.publishTerminal!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        status: "completed",
        phase: "COMMITTED",
        target,
      });
      const payload = await ended.promise;
      expect(payload).toMatchObject({
        generationId: executionId,
        chatId: AGENTIC_CHAT_ID,
        messageId,
        targetMessageId: messageId,
        targetSwipeId: 1,
        content: committedContent,
        phase: "COMMITTED",
        status: "COMMITTED",
      });
      expect(payload.content).not.toBe(provisionalSuffix);
      expect(order).toEqual(["projection", "terminal"]);
      expect(getPoolEntry(executionId)).toMatchObject({
        status: "completed",
        content: provisionalSuffix,
        completedMessageId: messageId,
        targetMessageId: messageId,
        targetSwipeId: 1,
      });
      const durable = db.query(
        "SELECT content, swipe_id, swipes FROM messages WHERE id = ? AND chat_id = ?",
      ).get(messageId, AGENTIC_CHAT_ID) as { content: string; swipe_id: number; swipes: string } | null;
      expect(durable).not.toBeNull();
      expect(durable?.content).toBe(committedContent);
      expect(durable?.swipe_id).toBe(1);
      expect(JSON.parse(durable?.swipes ?? "[]")).toEqual(["untouched alternative", committedContent]);
    } finally {
      clearTimeout(timeout);
      removeProjection();
      removeTerminal();
      deps.cleanup!({ execution, phase: "COMMITTED", status: "completed" } as never);
      removePoolEntry(executionId);
    }
  });
  test("COMMITTED terminal fails closed when the receipt swipe cannot resolve", () => {
    const deps = __testing.buildDependencies();
    const executionId = "exec-terminal-invalid-swipe-" + Date.now();
    const messageId = "message-terminal-invalid-swipe-" + Date.now();
    seedTargetMessage(messageId, AGENTIC_CHAT_ID, ADMITTED_TARGET_REVISION);
    const created = createTurnExecution({
      id: executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      generationId: executionId,
      target: {
        kind: "continue",
        messageId,
        swipeId: 9,
        messageIndex: 0,
        swipeCount: 10,
        chatGenerationRevision: ADMITTED_TARGET_REVISION,
        messageGenerationRevision: ADMITTED_TARGET_REVISION,
      },
      mode: "agentic",
      runtimeEpoch: 1,
      deadlineAt: Date.now() + 60_000,
      workspaceId: "workspace:" + executionId,
      rootLedger: {},
      frameCapabilities: {},
    });
    let current = created.execution;
    for (const nextPhase of ["WORK", "COMPLETE", "RENDER", "PREPARE_COMMIT", "COMMITTING"] as const) {
      current = transitionTurnExecution({
        executionId,
        ownerToken: created.ownerToken,
        expectedPhase: current.phase,
        nextPhase,
        ignoreCancellation: true,
      }).execution;
    }
    finalizeTurnCommit({
      executionId,
      ownerToken: created.ownerToken,
      receiptId: "receipt:" + executionId,
      messageId,
      swipeId: 9,
      summary: { source: "invalid-terminal-swipe-test" },
    });
    createPoolEntry({
      generationId: executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      generationType: "continue",
      characterName: "Coordinator",
      model: "scripted-model",
      targetMessageId: messageId,
      targetSwipeId: 9,
    });
    appendPoolContent(executionId, "provisional content must not be committed");
    const ended: string[] = [];
    const removeEnded = eventBus.on(EventType.GENERATION_ENDED, (event) => {
      const payload = event.payload as { readonly generationId?: unknown } | undefined;
      if (payload?.generationId === executionId) ended.push(executionId);
    });
    try {
      expect(() => deps.publishTerminal!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        status: "completed",
        phase: "COMMITTED",
        target: { generationType: "continue", messageId, swipeId: 9 },
      })).toThrow("committed_terminal_message_integrity_failed");
      expect(ended).toEqual([]);
      expect(getPoolEntry(executionId)?.content).toBe("provisional content must not be committed");
      expect(getPoolEntry(executionId)?.status).not.toBe("completed");
    } finally {
      removeEnded();
      removePoolEntry(executionId);
    }
  });
  test("freezes repeated custom phase block IDs by prompt-order occurrence", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    await probeIsolateBackendsAtStartup();
    startAgentRuntimeEpoch();
    installAgenticGenerationCoordinator();

    const db = getDb();
    const originalPreset = db.query(
      "SELECT prompt_order, cache_revision FROM presets WHERE id = ? AND user_id = ?",
    ).get(AGENTIC_PRESET_ID, USER_ID) as { prompt_order: string; cache_revision: number };
    const originalConfig = db.query(
      "SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, AGENTIC_PRESET_ID) as { config_json: string };
    const presetRevision = 73;
    const phaseSource = {
      kind: "loom_block" as const,
      blockId: "__proto__",
      presetRevision,
      blockRevision: 1,
      promptOrder: 0,
    };
    const phaseSourceOne = { ...phaseSource, promptOrder: 1 };
    const phaseDefinitions: AgentCustomPhaseV1[] = [{
      version: 1,
      id: "snapshot_source",
      label: "Snapshot phase",
      instructionRefs: [phaseSource, phaseSourceOne],
      childInstructionSubsets: [],
      required: true,
      enter: { kind: "phase", value: "WORK" },
      exit: { kind: "phase", value: "COMPLETE" },
      capabilityRequests: [],
      repeatLimit: 0,
      nextPhaseIds: [],
    }];
    const missingPhaseSource = compileAgentRuntimePhases(phaseDefinitions, {
      source: {
        presetRevision,
        blocks: [],
      },
    });
    expect(missingPhaseSource).toMatchObject({
      status: "failed",
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "stale_source",
          phaseId: "snapshot_source",
          phaseIndex: 0,
          required: true,
          source: "revision",
          detail: "source block __proto__ revision or order is stale",
        }),
      ]),
    });
    const runtimePolicy = {
      version: 1,
      authority: "loom",
      scope: "preset",
      defaultMode: "agentic",
      loomPolicy: null,
      phases: phaseDefinitions,
    };
    const phaseBlock = {
      id: phaseSource.blockId,
      name: "Snapshot phase occurrence zero",
      content: "Occurrence zero phase instructions.",
      role: "system",
      enabled: true,
      position: "pre_history",
      depth: 0,
      marker: null,
      isLocked: false,
      color: null,
      injectionTrigger: [],
      revision: phaseSource.blockRevision,
    };
    const blocks = [phaseBlock, { ...phaseBlock, name: "Snapshot phase occurrence one", content: "Occurrence one phase instructions." }];
    const input = {
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal" as const,
      userInput: USER_INPUT,
    };
    const target = { generationType: "normal" as const };
    const signal = new AbortController().signal;
    const executionId = `exec-phase-source-${Date.now()}`;
    try {
      db.query(
        "UPDATE presets SET prompt_order = ?, cache_revision = ? WHERE id = ? AND user_id = ?",
      ).run(JSON.stringify(blocks), presetRevision, AGENTIC_PRESET_ID, USER_ID);
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(JSON.stringify({ config: { runtimePolicy } }), USER_ID, AGENTIC_PRESET_ID);

      const deps = __testing.buildDependencies();
      const decision = await deps.resolveRuntime!(input, target, signal);
      const snapshot = await deps.buildAssemblySnapshot!(input, decision, target, signal, executionId);
      expect(snapshot.agentCognition.cognitionSource?.blocks).toEqual([
        { blockId: phaseSource.blockId, revision: 1, promptOrder: 0 },
        { blockId: phaseSourceOne.blockId, revision: 1, promptOrder: 1 },
      ]);

      const plan = await deps.compileAssemblyPlan!(snapshot, input, decision, signal, executionId);
      expect(plan.customPhasePlan).toMatchObject({
        status: "ready",
        phases: [expect.objectContaining({
          id: "snapshot_source",
          sourceStatus: "verified",
          sourceIdentity: [
            {
              blockId: phaseSource.blockId,
              presetRevision,
              blockRevision: phaseSource.blockRevision,
              promptOrder: phaseSource.promptOrder,
            },
            {
              blockId: phaseSourceOne.blockId,
              presetRevision,
              blockRevision: phaseSourceOne.blockRevision,
              promptOrder: phaseSourceOne.promptOrder,
            },
          ],
        })],
      });
      const staleSource = { ...phaseSource, blockRevision: phaseSource.blockRevision + 1 };
      expect(plan.loomBlocks.map((entry) => [entry.source.promptOrder, entry.content])).toEqual([
        [0, "Occurrence zero phase instructions."],
        [1, "Occurrence one phase instructions."],
      ]);
      db.query(
        "UPDATE presets SET prompt_order = ? WHERE id = ? AND user_id = ?",
      ).run(JSON.stringify([blocks[0], { ...blocks[1], marker: "category" }]), AGENTIC_PRESET_ID, USER_ID);
      const categoryDecision = await deps.resolveRuntime!(input, target, signal);
      const categorySnapshot = await deps.buildAssemblySnapshot!(input, categoryDecision, target, signal, `${executionId}-category`);
      expect(categorySnapshot.agentCognition.cognitionSource?.blocks).toEqual([
        { blockId: phaseSource.blockId, revision: 1, promptOrder: 0 },
      ]);
      await expect(
        deps.compileAssemblyPlan!(categorySnapshot, input, categoryDecision, signal, `${executionId}-category`),
      ).rejects.toThrow(/Required custom WORK phase|category/i);
      db.query(
        "UPDATE presets SET prompt_order = ? WHERE id = ? AND user_id = ?",
      ).run(JSON.stringify(blocks), AGENTIC_PRESET_ID, USER_ID);
      const optionalPhaseDefinitions: AgentCustomPhaseV1[] = [
        {
          ...phaseDefinitions[0]!,
          id: "optional_stale",
          label: "Optional stale",
          required: false,
          instructionRefs: [staleSource],
        },
        {
          ...phaseDefinitions[0]!,
          id: "optional_missing",
          label: "Optional missing",
          required: false,
          instructionRefs: [{ ...staleSource, blockId: "missing-phase-block" }],
        },
      ];
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(JSON.stringify({
        config: {
          runtimePolicy: {
            ...runtimePolicy,
            phases: optionalPhaseDefinitions,
          },
        },
      }), USER_ID, AGENTIC_PRESET_ID);
      const optionalDecision = await deps.resolveRuntime!(input, target, signal);
      const optionalSnapshot = await deps.buildAssemblySnapshot!(input, optionalDecision, target, signal, `${executionId}-optional`);
      expect(optionalSnapshot.agentCognition.cognitionSource?.blocks).toEqual([]);
      const optionalPlan = compileAgentRuntimePhases(optionalPhaseDefinitions, {
        source: optionalSnapshot.agentCognition.cognitionSource,
      });
      expect(optionalPlan).toMatchObject({
        status: "repair_required",
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "optional_phase_omitted", phaseId: "optional_stale", required: false }),
          expect.objectContaining({ code: "optional_phase_omitted", phaseId: "optional_missing", required: false }),
        ]),
      });

      const requiredPhaseDefinitions: AgentCustomPhaseV1[] = [
        {
          ...phaseDefinitions[0]!,
          id: "required_stale",
          label: "Required stale",
          required: true,
          instructionRefs: [staleSource],
        },
        {
          ...phaseDefinitions[0]!,
          id: "required_missing",
          label: "Required missing",
          required: true,
          instructionRefs: [{ ...staleSource, blockId: "missing-required-phase-block" }],
        },
      ];
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(JSON.stringify({
        config: {
          runtimePolicy: {
            ...runtimePolicy,
            phases: requiredPhaseDefinitions,
          },
        },
      }), USER_ID, AGENTIC_PRESET_ID);
      const requiredDecision = await deps.resolveRuntime!(input, target, signal);
      const requiredSnapshot = await deps.buildAssemblySnapshot!(input, requiredDecision, target, signal, `${executionId}-required`);
      expect(requiredSnapshot.agentCognition.cognitionSource?.blocks).toEqual([]);
      const requiredPlan = compileAgentRuntimePhases(requiredPhaseDefinitions, {
        source: requiredSnapshot.agentCognition.cognitionSource,
      });
      expect(requiredPlan).toMatchObject({
        status: "failed",
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "stale_source", phaseId: "required_stale", required: true }),
          expect.objectContaining({ code: "stale_source", phaseId: "required_missing", required: true }),
        ]),
      });
    } finally {
      db.query(
        "UPDATE presets SET prompt_order = ?, cache_revision = ? WHERE id = ? AND user_id = ?",
      ).run(originalPreset.prompt_order, originalPreset.cache_revision, AGENTIC_PRESET_ID, USER_ID);
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(originalConfig.config_json, USER_ID, AGENTIC_PRESET_ID);
    }
  });
  test("WORK and RENDER deliver resolved direct Loom policy and omit false conditions", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    await probeIsolateBackendsAtStartup();
    startAgentRuntimeEpoch();
    installAgenticGenerationCoordinator();
    scriptedWorkRound = 0;
    providerRequests.length = 0;

    const db = getDb();
    const originalPreset = db.query(
      "SELECT prompt_order, cache_revision FROM presets WHERE id = ? AND user_id = ?",
    ).get(AGENTIC_PRESET_ID, USER_ID) as { prompt_order: string; cache_revision: number };
    const originalConfig = db.query(
      "SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, AGENTIC_PRESET_ID) as { config_json: string };
    const presetRevision = 73;
    const rawPolicyText = "Effective policy for {{char}}.";
    const resolvedPolicyText = "Effective policy for Coordinator Character.";
    const source = {
      kind: "loom_block" as const,
      blockId: "macro-policy",
      presetRevision,
      blockRevision: 1,
      promptOrder: 0,
    };
    const conditionSentinel = "CONDITION_FALSE_MUST_NOT_REACH_PROVIDER";
    const conditionSource = {
      kind: "loom_block" as const,
      blockId: "condition-policy",
      presetRevision,
      blockRevision: 1,
      promptOrder: 1,
    };
    const rawRenderPolicyText = "Render policy for {{char}}.";
    const resolvedRenderPolicyText = "Render policy for Coordinator Character.";
    const renderSource = {
      kind: "loom_block" as const,
      blockId: "render-macro-policy",
      presetRevision,
      blockRevision: 1,
      promptOrder: 2,
    };
    const renderConditionSentinel = "RENDER_CONDITION_FALSE_MUST_NOT_REACH_PROVIDER";
    const renderConditionSource = {
      kind: "loom_block" as const,
      blockId: "render-condition-policy",
      presetRevision,
      blockRevision: 1,
      promptOrder: 3,
    };
    const runtimePolicy = {
      version: 1,
      authority: "loom",
      scope: "preset",
      defaultMode: "agentic",
      loomPolicy: {
        version: 1,
        workPolicy: [{
          version: 1,
          id: "macro-policy-entry",
          source,
          destination: "root_work",
          checkpoint: "WORK",
          required: true,
          visibility: "work_only",
        }, {
          version: 1,
          id: "condition-policy-entry",
          source: conditionSource,
          destination: "root_work",
          checkpoint: "WORK",
          required: false,
          visibility: "work_only",
          condition: {
            kind: "preset_variable",
            name: "gate",
            operator: "equals",
            value: "open",
          },
        }],
        workspaceUsage: [],
        completionCriteria: [],
        renderPolicy: [{
          version: 1,
          id: "render-macro-policy-entry",
          source: renderSource,
          destination: "render",
          checkpoint: "RENDER",
          required: true,
          visibility: "work_only",
        }, {
          version: 1,
          id: "render-condition-policy-entry",
          source: renderConditionSource,
          destination: "render",
          checkpoint: "RENDER",
          required: false,
          visibility: "work_only",
          condition: {
            kind: "preset_variable",
            name: "gate",
            operator: "equals",
            value: "open",
          },
        }],
      },
      phases: [],
    };
    const deps = __testing.buildDependencies();
    const input = {
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal" as const,
      userInput: USER_INPUT,
      parameters: { max_tokens: 1024 },
    };
    const target = { generationType: "normal" as const };
    const signal = new AbortController().signal;
    const executionId = `exec-loom-macro-${Date.now()}`;
    try {
      db.query(
        "UPDATE presets SET prompt_order = ?, cache_revision = ? WHERE id = ? AND user_id = ?",
      ).run(JSON.stringify([{
        id: source.blockId,
        name: "Macro policy",
        content: rawPolicyText,
        role: "system",
        enabled: true,
        position: "pre_history",
        revision: source.blockRevision,
      }, {
        id: conditionSource.blockId,
        name: "False condition policy",
        content: conditionSentinel,
        role: "system",
        enabled: true,
        position: "pre_history",
        revision: conditionSource.blockRevision,
      }, {
        id: renderSource.blockId,
        name: "Render macro policy",
        content: rawRenderPolicyText,
        role: "system",
        enabled: true,
        position: "pre_history",
        revision: renderSource.blockRevision,
      }, {
        id: renderConditionSource.blockId,
        name: "Render false condition policy",
        content: renderConditionSentinel,
        role: "system",
        enabled: true,
        position: "pre_history",
        revision: renderConditionSource.blockRevision,
      }]), presetRevision, AGENTIC_PRESET_ID, USER_ID);
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(JSON.stringify({ config: { runtimePolicy } }), USER_ID, AGENTIC_PRESET_ID);

      const decision = await deps.resolveRuntime!(input, target, signal);
      const snapshot = await deps.buildAssemblySnapshot!(input, decision, target, signal, executionId);
      const plan = await deps.compileAssemblyPlan!(snapshot, input, decision, signal, executionId);
      expect(snapshot.blocks.find((block) => block.id === source.blockId)?.content).toBe(rawPolicyText);
      expect(plan.loomBlocks.find((block) => block.source.blockId === source.blockId)?.content).toBe(resolvedPolicyText);

      let execution = await deps.createExecution!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        target,
        decision,
        signal,
      });

      execution = (await deps.transitionExecution!(execution, "ASSEMBLE", "WORK"))!;
      try {
        const work = await deps.runWork!({
          execution,
          input,
          decision,
          snapshot,
          plan,
          signal,
        });
        expect(work).toMatchObject({ status: "completed" });
        const ordinaryRequests = providerRequests.filter((request) => request.toolMode === "ordinary");
        const ordinaryPayload = JSON.stringify(ordinaryRequests);
        expect(ordinaryPayload).toContain(resolvedPolicyText);
        expect(ordinaryPayload).not.toContain(rawPolicyText);
        expect(ordinaryPayload).not.toContain(conditionSentinel);

        const render = await deps.render!({
          execution,
          input,
          decision,
          snapshot,
          plan,
          work,
          signal,
        });
        expect(render).toMatchObject({ content: "scripted render" });
        const finalizationRequests = providerRequests.filter((request) => request.toolMode === "finalization");
        const finalizationPayload = JSON.stringify(finalizationRequests);
        expect(finalizationPayload).toContain(resolvedRenderPolicyText);
        expect(finalizationPayload).not.toContain(rawRenderPolicyText);
        expect(finalizationPayload).not.toContain(renderConditionSentinel);
        expect(finalizationRequests).toHaveLength(1);
      } finally {
        deps.cleanup!({ execution } as never);
      }
    } finally {
      try {
        deps.cleanup!({ executionId } as never);
      } finally {
        try {
          __testing.reconcilePersistentWorkspaceSessions();
        } finally {
          db.query("DELETE FROM agent_work_segment_recovery WHERE user_id = ? AND execution_id = ?")
            .run(USER_ID, executionId);
          db.query("DELETE FROM persistent_workspace_turn_sessions WHERE user_id = ? AND execution_id = ?")
            .run(USER_ID, executionId);
        }
      }
      db.query(
        "UPDATE presets SET prompt_order = ?, cache_revision = ? WHERE id = ? AND user_id = ?",
      ).run(originalPreset.prompt_order, originalPreset.cache_revision, AGENTIC_PRESET_ID, USER_ID);
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(originalConfig.config_json, USER_ID, AGENTIC_PRESET_ID);
      scriptedWorkRound = 0;
      providerRequests.length = 0;
    }
  });

  test("WORK and RENDER send authored preset max_tokens and fall back to 4096", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    await probeIsolateBackendsAtStartup();
    startAgentRuntimeEpoch();
    installAgenticGenerationCoordinator();

    const runTurn = async (requestEpoch: number) => {
      scriptedWorkRound = 0;
      providerRequests.length = 0;
      const chatId = `chat-max-tokens-${requestEpoch}-${Date.now()}`;
      seedTransientAgenticChat(chatId);
      const deps = __testing.buildDependencies();
      const generationInput = {
        userId: USER_ID,
        chatId,
        connectionId: CONNECTION_ID,
        presetId: AGENTIC_PRESET_ID,
        generationType: "normal" as const,
        requestEpoch,
        userInput: USER_INPUT,
      };
      const decision = await deps.resolveRuntime!(
        generationInput,
        { generationType: "normal", revision: ADMITTED_TARGET_REVISION },
        new AbortController().signal,
      );
      const started = await runAgenticGeneration(generationInput, {
        ...deps,
        resolveRuntime: async () => decision,
      });
      const settled = await waitForAgenticGeneration(started.generationId);
      expect(settled).toMatchObject({ status: "completed", phase: "COMMITTED" });
      const ordinaryRequests = providerRequests.filter((request) => request.toolMode === "ordinary");
      const finalization = providerRequests.find((request) => request.toolMode === "finalization");
      expect(ordinaryRequests.length).toBeGreaterThanOrEqual(1);
      expect(finalization).toBeDefined();
      return { ordinaryRequests, finalization };
    };

    getDb().query("UPDATE presets SET parameters = ? WHERE id = ?").run(
      JSON.stringify({ samplerOverrides: { enabled: true, maxTokens: 1024 } }),
      AGENTIC_PRESET_ID,
    );
    try {
      const authored = await runTurn(41);
      for (const request of authored.ordinaryRequests) {
        expect(request.parameters?.max_tokens).toBe(1024);
      }
      expect(authored.finalization?.parameters?.max_tokens).toBe(1024);

      getDb().query("UPDATE presets SET parameters = ? WHERE id = ?").run("{}", AGENTIC_PRESET_ID);
      const missing = await runTurn(42);
      for (const request of missing.ordinaryRequests) {
        expect(request.parameters?.max_tokens).toBe(4096);
        expect(request.parameters?.max_tokens).toBeLessThan(100_000);
      }
      expect(missing.finalization?.parameters?.max_tokens).toBe(4096);
    } finally {
      getDb().query("UPDATE presets SET parameters = ? WHERE id = ?").run("{}", AGENTIC_PRESET_ID);
      scriptedWorkRound = 0;
      providerRequests.length = 0;
    }
  });
  test("recovered WORK dispatch retains frozen generation parameters and lets the host override only max_tokens", () => {
    const persisted = {
      temperature: 0.42,
      top_p: 0.73,
      max_tokens: 9_999,
      samplerOverrides: { enabled: true, minP: 0.08 },
    };
    const before = structuredClone(persisted);
    expect(__testing.workProviderGenerationParametersV1(persisted, 64)).toEqual({
      temperature: 0.42,
      top_p: 0.73,
      max_tokens: 64,
      samplerOverrides: { enabled: true, minP: 0.08 },
    });
    expect(persisted).toEqual(before);
  });
  test("production work adapter preserves exact delegated child workspace grants", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    await probeIsolateBackendsAtStartup();
    startAgentRuntimeEpoch();
    installAgenticGenerationCoordinator();
    scriptedDelegate = true;
    scriptedTaskCreated = false;
    delegateIssued = false;
    scriptedAcceptSubmission = true;
    scriptedAcceptanceIssued = false;
    scriptedChildSubmitted = false;
    providerRequests.length = 0;

    const deps = __testing.buildDependencies();
    const input = {
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal" as const,
      userInput: USER_INPUT,
      parameters: { max_tokens: 1024 },
    };
    const target = { generationType: "normal" as const };
    const signal = new AbortController().signal;
    const writeProfileRuntime = getDb().query(
      "UPDATE preset_agent_profiles SET workspace_capabilities = ?, max_output_tokens = ? WHERE user_id = ? AND preset_id = ? AND profile_id = ?",
    );
    writeProfileRuntime.run(
      JSON.stringify(["update_assigned_progress", "submit_child_result"]),
      1024,
      USER_ID,
      AGENTIC_PRESET_ID,
      "delegate",
    );
    writeProfileRuntime.run(JSON.stringify([]), 1024, USER_ID, AGENTIC_PRESET_ID, "delegate_alt");
    const decision = await deps.resolveRuntime!(input, target, signal);
    const snapshot = await deps.buildAssemblySnapshot!(input, decision, target, signal, "test-delegate");
    const config = snapshot.agentConfig as {
      readonly profiles?: readonly Record<string, unknown>[];
    } | null;
    if (!config || !Array.isArray(config.profiles)) throw new Error("Agentic profile config was not snapshotted");
    expect(config.profiles.find((profile) => profile.id === "delegate")).toMatchObject({
      workspaceCapabilities: ["update_assigned_progress", "submit_child_result"],
      maxOutputTokens: 1024,
    });
    expect(config.profiles.find((profile) => profile.id === "delegate_alt")).toMatchObject({
      workspaceCapabilities: [],
      maxOutputTokens: 1024,
    });
    const plan = await deps.compileAssemblyPlan!(snapshot, input, decision, signal, "test-delegate");
    let execution = await deps.createExecution!({
      executionId: `exec-delegate-${Date.now()}`,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      signal,
    });

    try {
      execution = (await deps.transitionExecution!(execution, "ASSEMBLE", "WORK"))!;
      const work = await deps.runWork!({
        execution,
        input,
        decision,
        snapshot,
        plan,
        signal,
      });
      expect(work).toMatchObject({ status: "completed" });
      const durableWorkspaceUsage = getDb().query(
        "SELECT (SELECT SUM(workspace_operations) FROM agent_work_segment_dispatches WHERE user_id = s.user_id AND execution_id = s.execution_id) AS dispatch_operations, s.workspace_operations AS segment_operations, r.workspace_operations AS attempt_operations, s.lifecycle AS segment_lifecycle, r.state AS recovery_state FROM agent_work_segments AS s JOIN agent_work_segment_recovery AS r ON r.user_id = s.user_id AND r.execution_id = s.execution_id WHERE s.user_id = ? AND s.execution_id = ?",
      ).get(USER_ID, execution.id) as {
        dispatch_operations: number; segment_operations: number; attempt_operations: number;
        segment_lifecycle: string; recovery_state: string;
      };
      expect(durableWorkspaceUsage.segment_operations).toBeGreaterThan(0);
      expect(durableWorkspaceUsage).toEqual({
        dispatch_operations: durableWorkspaceUsage.segment_operations,
        segment_operations: durableWorkspaceUsage.segment_operations,
        attempt_operations: durableWorkspaceUsage.segment_operations,
        segment_lifecycle: "closed",
        recovery_state: "closed",
      });
      const childRequests = providerRequests.filter((request) =>
        request.toolMode === "ordinary"
        && typeof request.messages[0]?.content === "string"
        && request.messages[0].content.includes("bounded subordinate frame"));
      expect(childRequests.length).toBeGreaterThanOrEqual(1);
      const childRequest = childRequests.find((request) =>
        typeof request.messages[0]?.content === "string"
        && request.messages[0].content.includes("Assigned workspace task ID: task-delegate."),
      );
      expect(childRequest).toBeDefined();
      expect(childRequest?.tools
        ?.filter((tool) => tool.name.startsWith("workspace_"))
        .map((tool) => tool.name)).toEqual([
        "workspace_update_assigned_progress",
        "workspace_submit_child_result",
      ]);
      expect(childRequest?.parameters?.max_tokens).toBe(1024);
      const workspace = getDb().query(
        "SELECT revision FROM agent_turn_workspaces WHERE workspace_id = ? AND user_id = ? AND chat_id = ? AND turn_id = ?",
      ).get(`workspace:${execution.id}`, USER_ID, AGENTIC_CHAT_ID, execution.id) as { revision: number } | null;
      const workRevision = (work.workspace && typeof work.workspace === "object" && !Array.isArray(work.workspace)
        && "revision" in work.workspace && typeof work.workspace.revision === "number")
        ? work.workspace.revision
        : undefined;
      expect(workspace).not.toBeNull();
      expect(workRevision).toBe(workspace?.revision);
      const durableExecution = getDb().query(
        "SELECT workspace_revision FROM agent_turn_executions WHERE user_id = ? AND id = ?",
      ).get(USER_ID, execution.id) as { workspace_revision: number } | null;
      expect(durableExecution?.workspace_revision).toBe(workspace?.revision);
      const task = getDb().query(
        "SELECT task_id, assigned_frame_id FROM agent_workspace_tasks WHERE turn_id = ? AND task_id = ?",
      ).get(execution.id, "task-delegate") as { task_id: string; assigned_frame_id: string | null } | null;
      const delegatedDispatch = getDb().query(
        "SELECT segment_id, dispatch_ordinal FROM agent_work_segment_dispatches WHERE user_id = ? AND execution_id = ? AND dispatch_ordinal = 1",
      ).get(USER_ID, execution.id) as { segment_id: string; dispatch_ordinal: number } | null;
      if (!delegatedDispatch) throw new Error("Delegated durable dispatch identity was not persisted");
      const expectedChildFrameId = __testing.createWorkDispatchIdentityAuthorityV1({
        executionId: execution.id,
        segmentId: delegatedDispatch.segment_id,
        logicalDispatch: delegatedDispatch.dispatch_ordinal,
      }).delegateInvocationIdentity({ providerCallId: "delegate-1" }).childFrameId;
      const delegateSuffix = ":delegate-0";
      const expectedDelegateFrameId = `${execution.id}.${createHash("sha256").update(
        JSON.stringify(["agentic-work-delegate", execution.id, delegateSuffix]),
        "utf8",
      ).digest("hex")}${delegateSuffix}`;
      expect(task).toEqual({ task_id: "task-delegate", assigned_frame_id: expectedChildFrameId });
      expect(Buffer.byteLength(expectedChildFrameId, "utf8")).toBeLessThanOrEqual(128);
      expect(expectedChildFrameId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
      expect(expectedChildFrameId).not.toBe(expectedDelegateFrameId);
      const submission = getDb().query(
        "SELECT child_frame_id FROM agent_workspace_submissions WHERE turn_id = ? AND task_id = ?",
      ).get(execution.id, "task-delegate") as { child_frame_id: string } | null;
      expect(submission).toEqual({ child_frame_id: expectedChildFrameId });
      const inspection = getAgentRunInspection(USER_ID, execution.id, AGENTIC_CHAT_ID);
      const frozenDelegate = (decision.internal as {
        readonly childConnections?: Readonly<Record<string, {
          readonly concreteId?: string | null;
          readonly candidateRevision?: string | number | null;
          readonly fingerprint?: string | null;
        }>>;
      }).childConnections?.delegate;
      const childExchanges = inspection?.transcript.filter((record) =>
        record.kind === "provider_exchange" && record.recipient === "child") ?? [];
      expect(childExchanges.length).toBeGreaterThanOrEqual(1);
      for (const exchange of childExchanges) {
        expect(exchange.correlation.taskId).toBe("task-delegate");
        expect(exchange.provider).toEqual({
          adapter: "agentic-work",
          providerId: "scripted-coordinator",
          modelId: "scripted-model",
          connectionId: frozenDelegate?.concreteId ?? null,
          configRevision: ADMITTED_CONFIG_REVISION,
          connectionRevision: frozenDelegate?.candidateRevision ?? null,
          fingerprint: frozenDelegate?.fingerprint ?? null,
        });
        expect(JSON.parse(exchange.arguments ?? "{}")).toMatchObject({
          profileId: "delegate",
          connectionId: frozenDelegate?.concreteId,
          configRevision: ADMITTED_CONFIG_REVISION,
          sourceFingerprint: frozenDelegate?.fingerprint,
        });
      }
      const correlatedDelegation = inspection?.transcript.filter((record) => record.kind === "delegation") ?? [];
      expect(correlatedDelegation.length).toBeGreaterThanOrEqual(2);
      expect(correlatedDelegation.every((record) => record.correlation.taskId === "task-delegate")).toBe(true);
      const childLifecycle = inspection?.transcript.filter((record) =>
        record.kind === "child_result") ?? [];
      expect(childLifecycle.length).toBeGreaterThanOrEqual(1);
      expect(childLifecycle.every((record) => record.correlation.taskId === "task-delegate")).toBe(true);
      expect(inspection?.activity.milestones.some((node) =>
        node.kind === "child" && node.actor === "child" && node.label === "delegate")).toBe(true);
      expect(inspection?.activity.milestones.some((node) =>
        node.id === "projection:" + expectedChildFrameId || node.id === "projection:" + expectedDelegateFrameId)).toBe(false);
      scriptedTaskCreated = false;
      delegateIssued = false;
      scriptedAcceptanceIssued = false;
      scriptedChildSubmitted = false;
      scriptedDelegateProfileId = "delegate_alt";
      scriptedWorkRound = 0;
      providerRequests.length = 0;
      let emptyExecution = await deps.createExecution!({
        executionId: `exec-delegate-empty-${Date.now()}`,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        target,
        decision,
        signal,
      });

      try {
        emptyExecution = (await deps.transitionExecution!(emptyExecution, "ASSEMBLE", "WORK"))!;
        const emptyWork = await deps.runWork!({
          execution: emptyExecution,
          input,
          decision,
          snapshot,
          plan,
          signal,
        });
        expect(emptyWork).toMatchObject({
          status: "failed",
          errorCode: "child_schedule_invalid",
        });
        const emptyChildRequest = providerRequests.find((request) =>
          request.toolMode === "ordinary"
          && typeof request.messages[0]?.content === "string"
          && request.messages[0].content.includes("Assigned workspace task ID: task-delegate."),
        );
        expect(emptyChildRequest).toBeUndefined();
      } finally {
        const durablePhase = await deps.readExecutionPhase!(emptyExecution);
        if (durablePhase === "WORK") {
          const failed = await deps.transitionExecution!(
            { ...emptyExecution, phase: durablePhase }, durablePhase, "FAILED", "test_cleanup",
          );
          if (failed) emptyExecution = failed;
        }
        deps.cleanup!({ execution: emptyExecution } as never);
      }
    } finally {
      const durablePhase = await deps.readExecutionPhase!(execution);
      if (durablePhase === "WORK") {
        const failed = await deps.transitionExecution!(
          { ...execution, phase: durablePhase }, durablePhase, "FAILED", "test_cleanup",
        );
        if (failed) execution = failed;
      }
      deps.cleanup!({ execution } as never);
      scriptedDelegate = false;
      scriptedTaskCreated = false;
      delegateIssued = false;
      scriptedAcceptSubmission = false;
      scriptedAcceptanceIssued = false;
      scriptedChildSubmitted = false;
      scriptedWorkRound = 0;
      scriptedDelegateProfileId = "delegate";
      writeProfileRuntime.run(JSON.stringify([]), 512, USER_ID, AGENTIC_PRESET_ID, "delegate");
      writeProfileRuntime.run(JSON.stringify([]), 128, USER_ID, AGENTIC_PRESET_ID, "delegate_alt");
    }
  });
  test("materializes authored child task macros once while keeping heterogeneous child identity exact", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    await probeIsolateBackendsAtStartup();
    startAgentRuntimeEpoch();
    installAgenticGenerationCoordinator();
    const db = getDb();
    const now = Date.now();
    const childConnectionIds = ["connection-child-a", "connection-child-b"] as const;
    const originalBindings = db.query(
      "SELECT slot_id, connection_id FROM preset_agent_slot_bindings WHERE user_id = ? AND preset_id = ? AND slot_id IN ('delegate', 'delegate_alt') ORDER BY slot_id",
    ).all(USER_ID, AGENTIC_PRESET_ID) as Array<{ slot_id: string; connection_id: string }>;
    const originalProfiles = db.query(
      "SELECT profile_id, workspace_capabilities, max_output_tokens FROM preset_agent_profiles WHERE user_id = ? AND preset_id = ? AND profile_id IN ('delegate', 'delegate_alt') ORDER BY profile_id",
    ).all(USER_ID, AGENTIC_PRESET_ID) as Array<{
      profile_id: string;
      workspace_capabilities: string;
      max_output_tokens: number;
    }>;
    db.query(
      "INSERT INTO connection_profiles (id, user_id, name, provider, api_url, model, is_default, has_api_key, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, '{}', ?, ?)",
    ).run(childConnectionIds[0], USER_ID, "Child A", "scripted-child-a", "https://child-a.invalid/v1", "child-model-a", now, now);
    db.query(
      "INSERT INTO connection_profiles (id, user_id, name, provider, api_url, model, is_default, has_api_key, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, '{}', ?, ?)",
    ).run(childConnectionIds[1], USER_ID, "Child B", "scripted-child-b", "https://child-b.invalid/v1", "child-model-b", now + 1, now + 1);
    db.query(
      "UPDATE preset_agent_slot_bindings SET connection_id = ?, updated_at = ? WHERE user_id = ? AND preset_id = ? AND slot_id = 'delegate'",
    ).run(childConnectionIds[0], now, USER_ID, AGENTIC_PRESET_ID);
    db.query(
      "UPDATE preset_agent_slot_bindings SET connection_id = ?, updated_at = ? WHERE user_id = ? AND preset_id = ? AND slot_id = 'delegate_alt'",
    ).run(childConnectionIds[1], now + 1, USER_ID, AGENTIC_PRESET_ID);
    db.query(
      "UPDATE preset_agent_profiles SET workspace_capabilities = ?, max_output_tokens = 1024 WHERE user_id = ? AND preset_id = ? AND profile_id IN ('delegate', 'delegate_alt')",
    ).run(JSON.stringify(["update_assigned_progress", "submit_child_result"]), USER_ID, AGENTIC_PRESET_ID);

    const tokenizerModels: string[] = [];
    const resolveCounter = tokenizerService.resolveCounter;
    const tokenizerSpy = spyOn(tokenizerService, "resolveCounter").mockImplementation(async (model) => {
      tokenizerModels.push(model);
      return resolveCounter(model);
    });
    const expectedByProfile = {
      delegate: {
        provider: "scripted-child-a",
        connectionId: childConnectionIds[0],
        endpoint: "https://child-a.invalid/v1",
        model: "child-model-a",
        totalTokens: 24,
      },
      delegate_alt: {
        provider: "scripted-child-b",
        connectionId: childConnectionIds[1],
        endpoint: "https://child-b.invalid/v1",
        model: "child-model-b",
        totalTokens: 36,
      },
    } as const;
    let nextLeaseTimer = 0;
    const activeLeaseTimers = new Set<number>();
    const heartbeatRegistrySizes: number[] = [];
    const deps = __testing.buildDependencies({
      timeoutScheduler: {
        setTimeout() {
          nextLeaseTimer += 1;
          activeLeaseTimers.add(nextLeaseTimer);
          return nextLeaseTimer;
        },
        clearTimeout(handle: number) { activeLeaseTimers.delete(handle); },
      } as never,
      onPreSegmentHeartbeatRegistrySize: (size) => heartbeatRegistrySizes.push(size),
    });
    const input = {
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal" as const,
      userInput: USER_INPUT,
      parameters: { max_tokens: 1024 },
    };
    const target = { generationType: "normal" as const };
    const signal = new AbortController().signal;
    try {
      const decision = await deps.resolveRuntime!(input, target, signal);
      const internal = decision.internal as {
        readonly childConnections?: Readonly<Record<string, {
          readonly concreteId?: string;
          readonly provider?: string;
          readonly effectiveEndpoint?: string;
          readonly model?: string | null;
          readonly candidateRevision?: string | number;
          readonly fingerprint?: string | null;
        }>>;
      };
      const childConnections = internal.childConnections;
      if (!childConnections) throw new Error("Child connections were not frozen");
      expect({
        concreteId: childConnections.delegate?.concreteId,
        provider: childConnections.delegate?.provider,
        endpoint: childConnections.delegate?.effectiveEndpoint,
        model: childConnections.delegate?.model,
      }).toEqual({
        concreteId: childConnectionIds[0],
        provider: expectedByProfile.delegate.provider,
        endpoint: expectedByProfile.delegate.endpoint,
        model: expectedByProfile.delegate.model,
      });
      expect({
        concreteId: childConnections.delegate_alt?.concreteId,
        provider: childConnections.delegate_alt?.provider,
        endpoint: childConnections.delegate_alt?.effectiveEndpoint,
        model: childConnections.delegate_alt?.model,
      }).toEqual({
        concreteId: childConnectionIds[1],
        provider: expectedByProfile.delegate_alt.provider,
        endpoint: expectedByProfile.delegate_alt.endpoint,
        model: expectedByProfile.delegate_alt.model,
      });
      const baseSnapshot = await deps.buildAssemblySnapshot!(
        input,
        decision,
        target,
        signal,
        "test-heterogeneous-children",
      );
      const exactTaskVariables = {
        fn_selector_bank: "B",
        fn_scenario_a: "CC-P01",
        fn_scenario_b: "IN-I01",
        fn_run_nonce: "IN-I01-M4-CP-034-C857-20260829T082526Z",
      } as const;
      const authoredTask = "SELECTOR_BANK={{var::fn_selector_bank}} BANK_A={{var::fn_scenario_a}} BANK_B={{var::fn_scenario_b}} RUN_NONCE={{var::fn_run_nonce}}. Execute only the assigned required child task.";
      const expectedTask = "SELECTOR_BANK=B BANK_A=CC-P01 BANK_B=IN-I01 RUN_NONCE=IN-I01-M4-CP-034-C857-20260829T082526Z. Execute only the assigned required child task.";
      const baseEffectiveVariables = baseSnapshot.variables.effective;
      if (!baseEffectiveVariables) throw new Error("Effective prompt variables were not frozen");
      const effectiveVariables = {
        ...baseEffectiveVariables,
        values: { ...baseEffectiveVariables.values, ...exactTaskVariables },
      };
      const variables = {
        ...baseSnapshot.variables,
        effective: effectiveVariables,
        revision: createHash("sha256")
          .update(encodeCanonicalPlainData(effectiveVariables), "utf8")
          .digest("hex"),
      };
      const scheduledBlocks = [
        {
          id: "heterogeneous-child-a",
          name: "Heterogeneous child A",
          content: "{{agent::delegate::as=heterogeneous_child_a_result}}" + authoredTask + "{{/agent}}",
          role: "user" as const,
          enabled: true,
          position: "pre_history" as const,
          depth: 0,
          marker: null,
          isLocked: false,
          color: null,
          injectionTrigger: [],
          group: null,
          sealed: false,
          order: baseSnapshot.blocks.length,
          revision: "1",
        },
        {
          id: "heterogeneous-child-b",
          name: "Heterogeneous child B",
          content: "{{agent::delegate_alt::as=heterogeneous_child_b_result}}child b{{/agent}}",
          role: "user" as const,
          enabled: true,
          position: "pre_history" as const,
          depth: 0,
          marker: null,
          isLocked: false,
          color: null,
          injectionTrigger: [],
          group: null,
          sealed: false,
          order: baseSnapshot.blocks.length + 1,
          revision: "1",
        },
      ] as const;
      const snapshotCandidate = {
        ...baseSnapshot,
        snapshotId: "",
        generationId: "test-heterogeneous-children",
        variables,
        blocks: [...baseSnapshot.blocks, ...scheduledBlocks],
      };
      const {
        snapshotId: _snapshotId,
        inputRevisionSet: _inputRevisionSet,
        revisions: _revisions,
        ...snapshotBase
      } = snapshotCandidate;
      const snapshot = {
        ...snapshotCandidate,
        snapshotId: createHash("sha256")
          .update(encodeCanonicalPlainData({ base: snapshotBase, revisions: snapshotCandidate.revisions }), "utf8")
          .digest("hex"),
      } as typeof baseSnapshot;
      const plan = await compileAgentAssemblyPlan(snapshot);
      expect(plan.children.map((child) => child.profileId)).toEqual(["delegate", "delegate_alt"]);
      expect(plan.children[0]).toMatchObject({
        blockId: "heterogeneous-child-a",
        task: expectedTask,
        taskBytes: Buffer.byteLength(expectedTask, "utf8"),
      });
      expect(plan.privateEvidence.activation).toContainEqual(expect.objectContaining({
        kind: "macro",
        blockId: "heterogeneous-child-a",
        operation: "resolve",
      }));
      await expect(validateAssemblyPlanAgainstSnapshotV1(plan, snapshot, snapshot.limits)).resolves.toBeUndefined();


      scriptedDelegate = false;
      scriptedWorkRound = 0;
      boundProviderDispatches.length = 0;
      providerRequests.length = 0;
      let execution = await deps.createExecution!({
        executionId: "exec-heterogeneous-scheduled-" + Date.now(),
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        target,
        decision,
        signal,
      });

      try {
        execution = (await deps.transitionExecution!(execution, "ASSEMBLE", "WORK"))!;
        const work = await deps.runWork!({ execution, input, decision, snapshot, plan, signal });
        expect(work.errorCode).not.toBe("provider_error");
        expect(providerRequests.length).toBeGreaterThan(0);
        expect(boundProviderDispatches).toHaveLength(2);
        for (const dispatch of boundProviderDispatches) {
          expect((dispatch.request.tools ?? [])
            .filter((tool) => tool.name.startsWith("workspace_"))
            .map((tool) => tool.name)).toEqual([]);
          expect(dispatch.request.messages.some((message) =>
            typeof message.content === "string"
            && message.content.includes("Assigned workspace task ID:"))).toBe(false);
        }
        const inspection = getAgentRunInspection(USER_ID, execution.id, AGENTIC_CHAT_ID);
        for (const profileId of ["delegate", "delegate_alt"] as const) {
          const expected = expectedByProfile[profileId];
          const plannedChild = plan.children.find((child) => child.profileId === profileId);
          expect(plannedChild).toBeDefined();
          const plannedChildIndex = plan.children.indexOf(plannedChild!);
          const dispatches = boundProviderDispatches.filter((dispatch) => dispatch.provider === expected.provider);
          expect(dispatches).toHaveLength(1);
          expect(dispatches[0]).toMatchObject({ provider: expected.provider, url: expected.endpoint });
          expect(dispatches[0]?.request.model).toBe(expected.model);
          expect(dispatches[0]?.request.model).not.toBe("scripted-model");
          expect(tokenizerModels).toContain(expected.model);
          if (profileId === "delegate") {
            expect(dispatches[0]?.request.messages.some((message) =>
              typeof message.content === "string" && message.content.includes(expectedTask))).toBe(true);
          }
          const childExchange = inspection?.transcript.find((record) =>
            record.kind === "provider_exchange"
            && record.recipient === "child"
            && record.provider?.providerId === expected.provider);
          const expectedTaskId = childExchange?.correlation.taskId;
          expect(expectedTaskId).toMatch(new RegExp(`:child:${plannedChildIndex}$`));
          expect(childExchange?.provider).toEqual({
            adapter: "agentic-work",
            providerId: expected.provider,
            modelId: expected.model,
            connectionId: expected.connectionId,
            configRevision: ADMITTED_CONFIG_REVISION,
            connectionRevision: childConnections[profileId]?.candidateRevision ?? null,
            fingerprint: childConnections[profileId]?.fingerprint ?? null,
          });
          expect(childExchange?.correlation.taskId).toBe(expectedTaskId);
          const exchangeArguments = JSON.parse(childExchange?.arguments ?? "{}");
          expect(exchangeArguments).toMatchObject({
            profileId,
            provider: expected.provider,
            connectionId: expected.connectionId,
            model: expected.model,
            configRevision: ADMITTED_CONFIG_REVISION,
            sourceFingerprint: childConnections[profileId]?.fingerprint,
          });
          const childUsage = inspection?.usageEvidence.find((usage) =>
            usage.layer === "child"
            && usage.source === "provider_reported"
            && usage.totalTokens === expected.totalTokens);
          expect(childUsage).toMatchObject({
            inputTokens: profileId === "delegate" ? 11 : 17,
            outputTokens: profileId === "delegate" ? 13 : 19,
            totalTokens: expected.totalTokens,
            canonical: false,
          });
          expect(childUsage?.correlation?.taskId).toBe(expectedTaskId);
          const intrinsicLifecycle = inspection?.transcript.filter((record) =>
            record.kind === "child_result" && record.id.includes(plannedChild!.childId)) ?? [];
          expect(intrinsicLifecycle.length).toBeGreaterThanOrEqual(1);
          expect(intrinsicLifecycle.every((record) =>
            record.correlation.taskId === expectedTaskId)).toBe(true);
          const childActivity = inspection?.activity.milestones.find((activity) =>
            activity.kind === "child" && activity.actor === "child" && activity.label === profileId);
          expect(childActivity).toMatchObject({
            kind: "child",
            actor: "child",
            label: profileId,
          });
        }
        expect(tokenizerModels).toContain("scripted-model");
        expect(tokenizerModels).toContain("child-model-a");
        expect(tokenizerModels).toContain("child-model-b");
      } finally {
        const durablePhase = await deps.readExecutionPhase!(execution);
        if (durablePhase === "WORK") {
          const failed = await deps.transitionExecution!(
            { ...execution, phase: durablePhase }, durablePhase, "FAILED", "test_cleanup",
          );
          if (failed) execution = failed;
        }
        deps.cleanup!({ execution } as never);
      }
      const malformedDecisions = [
        {
          ...decision,
          internal: {
            ...internal,
            childConnections: { delegate: childConnections.delegate },
          },
        },
        {
          ...decision,
          internal: {
            ...internal,
            childConnections: {
              ...childConnections,
              delegate_alt: { ...childConnections.delegate_alt, model: null },
            },
          },
        },
      ] as unknown as readonly [typeof decision, typeof decision];
      for (const [index, malformedDecision] of malformedDecisions.entries()) {
        heartbeatRegistrySizes.length = 0;
        expect(activeLeaseTimers.size).toBe(0);
        boundProviderDispatches.length = 0;
        providerRequests.length = 0;
        let execution = await deps.createExecution!({
          executionId: "exec-incomplete-child-" + index + "-" + Date.now(),
          userId: USER_ID,
          chatId: AGENTIC_CHAT_ID,
          target,
          decision,
          signal,
        });
        try {
          execution = (await deps.transitionExecution!(execution, "ASSEMBLE", "WORK"))!;
          await expect(deps.runWork!({
            execution,
            input,
            decision: malformedDecision,
            snapshot,
            plan,
            signal,
          })).rejects.toMatchObject({ code: "decision_refresh_required", phase: "WORK" });
          expect(activeLeaseTimers.size).toBe(0);
          expect(heartbeatRegistrySizes).toEqual([1, 0]);
          expect(boundProviderDispatches).toHaveLength(0);
          expect(providerRequests).toHaveLength(0);
        } finally {
          const durablePhase = await deps.readExecutionPhase!(execution);
          if (durablePhase === "WORK") {
            const failed = await deps.transitionExecution!(
              { ...execution, phase: durablePhase }, durablePhase, "FAILED", "test_cleanup",
            );
            if (failed) execution = failed;
          }
          deps.cleanup!({ execution } as never);
        }
      }
    } finally {
      tokenizerSpy.mockRestore();
      for (const binding of originalBindings) {
        db.query(
          "UPDATE preset_agent_slot_bindings SET connection_id = ?, updated_at = ? WHERE user_id = ? AND preset_id = ? AND slot_id = ?",
        ).run(binding.connection_id, Date.now(), USER_ID, AGENTIC_PRESET_ID, binding.slot_id);
      }
      for (const profile of originalProfiles) {
        db.query(
          "UPDATE preset_agent_profiles SET workspace_capabilities = ?, max_output_tokens = ? WHERE user_id = ? AND preset_id = ? AND profile_id = ?",
        ).run(profile.workspace_capabilities, profile.max_output_tokens, USER_ID, AGENTIC_PRESET_ID, profile.profile_id);
      }
      db.query("DELETE FROM connection_profiles WHERE user_id = ? AND id IN (?, ?)")
        .run(USER_ID, childConnectionIds[0], childConnectionIds[1]);
      scriptedDelegate = false;
      scriptedDelegateProfileId = "delegate";
      scriptedTaskCreated = false;
      delegateIssued = false;
      scriptedAcceptSubmission = false;
      scriptedAcceptanceIssued = false;
      scriptedChildSubmitted = false;
      scriptedWorkRound = 0;
      boundProviderDispatches.length = 0;
      providerRequests.length = 0;
    }
  });
  test("persists one atomic built-in null Segment for all skipped authored phases and remains exact across restart", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    await probeIsolateBackendsAtStartup();
    startAgentRuntimeEpoch();
    installAgenticGenerationCoordinator();
    scriptedAllSkipped = true;
    scriptedWorkRound = 0;
    providerRequests.length = 0;

    const phaseDefinitions: AgentCustomPhaseV1[] = [
      {
        version: 1,
        id: "optional_skip_one",
        label: "Optional skip one",
        instructionRefs: [],
        childInstructionSubsets: [],
        required: false,
        enter: { kind: "phase", value: "WORK" },
        skip: { kind: "generation_type", value: "normal" },
        exit: { kind: "phase", value: "COMPLETE" },
        capabilityRequests: ["workspace_read"],
        repeatLimit: 0,
        nextPhaseIds: ["optional_skip_two"],
      },
      {
        version: 1,
        id: "optional_skip_two",
        label: "Optional skip two",
        instructionRefs: [],
        childInstructionSubsets: [],
        required: false,
        enter: { kind: "phase", value: "WORK" },
        skip: { kind: "generation_type", value: "normal" },
        exit: { kind: "phase", value: "COMPLETE" },
        capabilityRequests: ["core_retrieval"],
        repeatLimit: 0,
        nextPhaseIds: [],
      },
    ];
    const runtimePolicy = {
      version: 1,
      authority: "loom",
      scope: "preset",
      defaultMode: "agentic",
      loomPolicy: null,
      phases: phaseDefinitions,
    };
    const db = getDb();
    const originalConfig = db.query(
      "SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, AGENTIC_PRESET_ID) as { config_json: string };
    try {
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(JSON.stringify({ config: { runtimePolicy } }), USER_ID, AGENTIC_PRESET_ID);
      const inputRevisionAt = Date.now();
      db.query(
        "INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra, created_at, generation_revision) VALUES (?, ?, 0, 1, ?, ?, ?, 0, ?, ?, '{}', ?, ?)",
      ).run(
        "message-user-built-in-null-segment",
        AGENTIC_CHAT_ID,
        "User",
        USER_INPUT,
        inputRevisionAt,
        JSON.stringify([USER_INPUT]),
        JSON.stringify([inputRevisionAt]),
        inputRevisionAt,
        ADMITTED_TARGET_REVISION,
      );
      const requestEpoch = 90_211;
      const decision = await resolveEffectiveRuntime(USER_ID, {
        chatId: AGENTIC_CHAT_ID,
        logicalConnectionId: CONNECTION_ID,
        presetId: AGENTIC_PRESET_ID,
        target: { generationType: "normal", messageId: null, swipeId: null },
        mode: "agentic",
        requestEpoch,
      });
      const started = await startGeneration({
        userId: USER_ID,
        chat_id: AGENTIC_CHAT_ID,
        connection_id: CONNECTION_ID,
        preset_id: AGENTIC_PRESET_ID,
        generation_type: "normal",
        mode: "agentic",
        runtime_decision_token: decision.runtimeDecisionToken!,
        request_epoch: requestEpoch,
        user_input: USER_INPUT,
      });
      const settled = await waitForAgenticGeneration(started.generationId);
      expect(settled).toMatchObject({ status: "completed", phase: "COMMITTED" });

      const segmentRows = db.query(
        "SELECT segment_id, phase_id, phase_index, phase_occurrence, segment_ordinal, "
          + "lifecycle, context_json, context_digest, payload_digest FROM agent_work_segments "
          + "WHERE user_id = ? AND execution_id = ? ORDER BY segment_ordinal",
      ).all(USER_ID, started.generationId) as Array<{
        segment_id: string;
        phase_id: string | null;
        phase_index: number;
        phase_occurrence: number;
        segment_ordinal: number;
        lifecycle: string;
        context_json: string;
        context_digest: string;
        payload_digest: string;
      }>;
      expect(segmentRows).toHaveLength(1);
      expect(segmentRows[0]).toMatchObject({
        phase_id: null,
        phase_index: 0,
        phase_occurrence: 0,
        segment_ordinal: 0,
        lifecycle: "closed",
      });
      const persistedContext = JSON.parse(segmentRows[0]!.context_json) as WorkSegmentContextV1;
      expect(persistedContext.allOptionalPhasesSkippedAuthority).toMatchObject({
        skippedPhaseIds: ["optional_skip_one", "optional_skip_two"],
        decisions: [
          expect.objectContaining({ phaseId: "optional_skip_one", phaseIndex: 0 }),
          expect.objectContaining({ phaseId: "optional_skip_two", phaseIndex: 1 }),
        ],
        authorityDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(db.query(
        "SELECT COUNT(*) AS count FROM agent_work_segments WHERE user_id = ? AND execution_id = ? AND phase_id IS NOT NULL",
      ).get(USER_ID, started.generationId)).toEqual({ count: 0 });
      expect(db.query(
        "SELECT COUNT(*) AS count FROM agent_work_segment_transitions WHERE user_id = ? AND execution_id = ? AND transition_kind = 'terminal'",
      ).get(USER_ID, started.generationId)).toEqual({ count: 1 });
      expect(db.query(
        "SELECT state, current_segment_id, remaining_required_phase_count FROM agent_work_segment_recovery WHERE user_id = ? AND execution_id = ?",
      ).get(USER_ID, started.generationId)).toEqual({
        state: "closed",
        current_segment_id: null,
        remaining_required_phase_count: 0,
      });
      expect(providerRequests.filter((request) => request.toolMode === "ordinary")).toHaveLength(1);

      const durableAuthorityBeforeRestart = segmentRows.map((row) => ({
        segmentId: row.segment_id,
        contextJson: row.context_json,
        contextDigest: row.context_digest,
        payloadDigest: row.payload_digest,
      }));
      __testing.resetInstallation();
      installAgenticGenerationCoordinator();
      installAgenticGenerationCoordinator();
      expect(reconcileAgentTurns(db).complete).toBe(true);
      expect(reconcileAgentTurns(db).complete).toBe(true);
      const durableAuthorityAfterRestart = (db.query(
        "SELECT segment_id, context_json, context_digest, payload_digest FROM agent_work_segments "
          + "WHERE user_id = ? AND execution_id = ? ORDER BY segment_ordinal",
      ).all(USER_ID, started.generationId) as Array<{
        segment_id: string;
        context_json: string;
        context_digest: string;
        payload_digest: string;
      }>).map((row) => ({
        segmentId: row.segment_id,
        contextJson: row.context_json,
        contextDigest: row.context_digest,
        payloadDigest: row.payload_digest,
      }));
      expect(durableAuthorityAfterRestart).toEqual(durableAuthorityBeforeRestart);
      expect(db.query(
        "SELECT COUNT(*) AS count FROM agent_work_segment_transitions WHERE user_id = ? AND execution_id = ?",
      ).get(USER_ID, started.generationId)).toEqual({ count: 1 });
    } finally {
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(originalConfig.config_json, USER_ID, AGENTIC_PRESET_ID);
      scriptedAllSkipped = false;
      scriptedWorkRound = 0;
      providerRequests.length = 0;
    }
  });

  test("accepts exactly one authorized root finding mutation after a required phase advance", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    await probeIsolateBackendsAtStartup();
    startAgentRuntimeEpoch();
    installAgenticGenerationCoordinator();
    scriptedTwoPhase = true;
    scriptedTwoPhaseTurnId = "";
    scriptedTwoPhaseMutationIssued = false;
    scriptedTwoPhaseSnapshots.length = 0;
    providerRequests.length = 0;

    const phaseDefinitions: AgentCustomPhaseV1[] = [
      {
        version: 1,
        id: "two_phase_first",
        label: "Two-phase first",
        instructionRefs: [],
        childInstructionSubsets: [],
        required: true,
        enter: { kind: "phase", value: "WORK" },
        exit: { kind: "phase", value: "COMPLETE" },
        capabilityRequests: [],
        repeatLimit: 0,
        nextPhaseIds: ["two_phase_second"],
      },
      {
        version: 1,
        id: "two_phase_second",
        label: "Two-phase second",
        instructionRefs: [],
        childInstructionSubsets: [],
        required: true,
        enter: { kind: "phase", value: "WORK" },
        exit: { kind: "phase", value: "COMPLETE" },
        capabilityRequests: ["workspace_write"],
        repeatLimit: 0,
        nextPhaseIds: [],
      },
    ];
    const authoredPhasePlan = compileAgentRuntimePhases(phaseDefinitions);
    expect(authoredPhasePlan.status).toBe("ready");
    const db = getDb();
    const originalConfig = db.query(
      "SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, AGENTIC_PRESET_ID) as { config_json: string };
    const runtimePolicy = {
      version: 1,
      authority: "loom",
      scope: "preset",
      defaultMode: "agentic",
      loomPolicy: null,
      phases: phaseDefinitions,
    };

    const deps = __testing.buildDependencies();
    const input = {
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal" as const,
      userInput: USER_INPUT,
      parameters: { max_tokens: 1024 },
    };
    const target = { generationType: "normal" as const };
    const signal = new AbortController().signal;
    const executionId = `exec-two-phase-${Date.now()}`;
    try {
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(JSON.stringify({ config: { runtimePolicy } }), USER_ID, AGENTIC_PRESET_ID);
      const decision = await deps.resolveRuntime!(input, target, signal);
      const snapshot = await deps.buildAssemblySnapshot!(input, decision, target, signal, executionId);
      const plan = await deps.compileAssemblyPlan!(snapshot, input, decision, signal, executionId);
      let execution = await deps.createExecution!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        target,
        decision,
        signal,
      });

      execution = (await deps.transitionExecution!(execution, "ASSEMBLE", "WORK"))!;
      scriptedTwoPhaseTurnId = execution.id;
      try {
        const work = await deps.runWork!({
          execution,
          input,
          decision,
          snapshot,
          plan,
          signal,
        });
        expect(work).toMatchObject({ status: "completed" });
        expect(scriptedTwoPhaseSnapshots).toEqual([{
          state: "active",
          revision: 3,
          recordCount: 1,
          recordSummary: "WORK-B-OK",
          frozenAt: null,
        }]);

        const transition = db.query(
          `SELECT transition_id, transition_kind, target_phase_id, target_phase_index,
                  target_phase_occurrence, remaining_required_phase_count,
                  released_future_phase_reserve_output_tokens,
                  advisory_authority, advisory_summary,
                  advisory_unresolved_ids_json, advisory_render_guidance,
                  accepted_ids_authority, accepted_task_ids_json,
                  accepted_submission_ids_json, accepted_finding_ids_json,
                  accepted_decision_ids_json, accepted_artifact_ids_json,
                  open_required_ids_json
             FROM agent_work_segment_transitions
            WHERE user_id = ? AND execution_id = ? AND transition_kind = 'advance'`,
        ).get(USER_ID, execution.id) as ({
          transition_id: string;
          released_future_phase_reserve_output_tokens: number;
          [field: string]: unknown;
        }) | null;
        if (!transition) throw new Error("phase advance transition was not persisted");
        expect(transition).toMatchObject({
          transition_kind: "advance",
          target_phase_id: "two_phase_second",
          target_phase_index: 1,
          target_phase_occurrence: 0,
          advisory_authority: "model_advisory",
          advisory_summary: "phase one complete",
          advisory_render_guidance: "phase-one-render-guidance",
          accepted_ids_authority: "host",
          remaining_required_phase_count: 0,
        });
        expect(JSON.parse(String(transition?.advisory_unresolved_ids_json))).toEqual(["model-only-unresolved"]);
        for (const field of [
          "accepted_task_ids_json",
          "accepted_submission_ids_json",
          "accepted_finding_ids_json",
          "accepted_decision_ids_json",
          "accepted_artifact_ids_json",
          "open_required_ids_json",
        ]) {
          expect(JSON.parse(String(transition?.[field]))).toEqual([]);
        }
        const reserve = db.query(
          "SELECT initial_required_phase_count, remaining_required_phase_count, future_phase_reserve_output_tokens, "
            + "protected_future_phase_reserve_output_tokens FROM agent_work_segment_recovery WHERE user_id = ? AND execution_id = ?",
        ).get(USER_ID, execution.id) as {
          initial_required_phase_count: number;
          remaining_required_phase_count: number;
          future_phase_reserve_output_tokens: number;
          protected_future_phase_reserve_output_tokens: number;
        } | null;
        if (!reserve) throw new Error("segment recovery reserve was not persisted");
        expect(reserve).toMatchObject({
          initial_required_phase_count: 1,
          remaining_required_phase_count: 0,
          protected_future_phase_reserve_output_tokens: 0,
        });
        expect(reserve.future_phase_reserve_output_tokens).toBeGreaterThan(0);
        expect(transition.released_future_phase_reserve_output_tokens)
          .toBe(reserve.future_phase_reserve_output_tokens);
        const successor = db.query(
          "SELECT source_transition_id, phase_id, phase_index, phase_occurrence FROM agent_work_segments WHERE user_id = ? AND execution_id = ? AND segment_ordinal = 1",
        ).get(USER_ID, execution.id) as {
          source_transition_id: string;
          phase_id: string;
          phase_index: number;
          phase_occurrence: number;
        } | null;
        expect(successor).toEqual({
          source_transition_id: transition.transition_id,
          phase_id: "two_phase_second",
          phase_index: 1,
          phase_occurrence: 0,
        });
        const workspace = db.query(
          "SELECT state, revision, frozen_at, record_count FROM agent_turn_workspaces WHERE workspace_id = ? AND user_id = ? AND chat_id = ? AND turn_id = ?",
        ).get(`workspace:${execution.id}`, USER_ID, AGENTIC_CHAT_ID, execution.id) as {
          state: string;
          revision: number;
          frozen_at: number | null;
          record_count: number;
        } | null;
        expect(workspace?.state).toBe("frozen");
        expect(workspace?.frozen_at).not.toBeNull();
        expect(workspace?.revision).toBeGreaterThan(scriptedTwoPhaseSnapshots[0]?.revision ?? 0);
        expect(workspace?.record_count).toBe(1);

        const finding = db.query(
          "SELECT kind, summary, workspace_id, turn_id FROM agent_workspace_records WHERE workspace_id = ? AND turn_id = ?",
        ).get(`workspace:${execution.id}`, execution.id);
        expect(finding).toEqual({
          kind: "finding",
          summary: "WORK-B-OK",
          workspace_id: `workspace:${execution.id}`,
          turn_id: execution.id,
        });
        const mutationReceipts = db.query(
          "SELECT r.segment_id, r.logical_dispatch, r.frame_id, r.before_workspace_revision, r.after_workspace_revision "
            + "FROM agent_work_workspace_receipts r JOIN agent_work_segments s ON s.user_id = r.user_id AND s.execution_id = r.execution_id AND s.segment_id = r.segment_id "
            + "WHERE r.user_id = ? AND r.execution_id = ? AND s.segment_ordinal = 1",
        ).all(USER_ID, execution.id);
        expect(mutationReceipts).toEqual([{
          segment_id: expect.any(String),
          logical_dispatch: 0,
          frame_id: execution.id,
          before_workspace_revision: 2,
          after_workspace_revision: 3,
        }]);

        const session = db.query(
          "SELECT turn_session_id, execution_id, attempt_id FROM persistent_workspace_turn_sessions WHERE user_id = ? AND chat_id = ? AND turn_id = ? AND execution_id = ?",
        ).get(USER_ID, AGENTIC_CHAT_ID, execution.id, execution.id) as {
          turn_session_id: string;
          execution_id: string;
          attempt_id: string;
        } | null;
        expect(session).toEqual({
          turn_session_id: execution.id,
          execution_id: execution.id,
          attempt_id: execution.id,
        });

        const findingObservations = (work.observations ?? []).filter((observation) => observation.toolName === "workspace_record_finding");
        expect(findingObservations).toHaveLength(1);
        expect(findingObservations[0]?.status).toBe("success");
        const completionObservations = (work.observations ?? []).filter((observation) => observation.toolName === "complete_turn");
        expect(completionObservations).toHaveLength(2);
        expect(completionObservations.map((observation) => observation.status)).toEqual(["success", "accepted"]);
      } finally {
        deps.cleanup!({ execution } as never);
      }
    } finally {
      try {
        deps.cleanup!({ executionId } as never);
      } finally {
        try {
          __testing.reconcilePersistentWorkspaceSessions();
        } finally {
          db.query("DELETE FROM agent_work_segment_recovery WHERE user_id = ? AND execution_id = ?")
            .run(USER_ID, executionId);
          db.query("DELETE FROM persistent_workspace_turn_sessions WHERE user_id = ? AND execution_id = ?")
            .run(USER_ID, executionId);
        }
      }
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(originalConfig.config_json, USER_ID, AGENTIC_PRESET_ID);
      scriptedTwoPhase = false;
      scriptedTwoPhaseTurnId = "";
      scriptedTwoPhaseMutationIssued = false;
      scriptedTwoPhaseSnapshots.length = 0;
      providerRequests.length = 0;
    }
  });

  test("GENERATION_ENDED for completed COMMITTED omits error and still sends failure diagnostics", async () => {
    const deps = __testing.buildDependencies();
    const waitForEnded = (generationId: string): Promise<Record<string, unknown>> => {
      const settled = Promise.withResolvers<Record<string, unknown>>();
      const unsubscribe = eventBus.on(EventType.GENERATION_ENDED, (event) => {
        const payload = event.payload as Record<string, unknown> | undefined;
        if (payload?.generationId !== generationId) return;
        unsubscribe();
        settled.resolve(payload);
      });
      return settled.promise;
    };
    seedCommittedExecution("exec-committed-success");
    const completed = waitForEnded("exec-committed-success");
    deps.publishTerminal!({
      executionId: "exec-committed-success",
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      status: "completed",
      phase: "COMMITTED",
      target: { generationType: "normal" },
    });
    const completedPayload = await completed;
    expect(completedPayload).not.toHaveProperty("error");
    expect(completedPayload).not.toHaveProperty("errorCode");
    expect(completedPayload.phase).toBe("COMMITTED");
    expect(completedPayload.status).toBe("COMMITTED");
    expect(completedPayload.content).toBe("target");
    expect(completedPayload.messageId).toBe("message:exec-committed-success");
    const completedInspection = getDb().query(
      "SELECT outcome, reason, terminal FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?",
    ).get(USER_ID, "exec-committed-success") as {
      outcome: string | null;
      reason: string;
      terminal: number;
    } | null;
    expect(completedInspection).toEqual({
      outcome: "completed",
      reason: "none",
      terminal: 1,
    });

    createPoolEntry({
      generationId: "exec-committed-failed",
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      generationType: "normal",
      characterName: "Coordinator",
      model: "scripted-model",
    });
    appendPoolContent("exec-committed-failed", "provisional failure output");
    const failed = waitForEnded("exec-committed-failed");
    deps.publishTerminal!({
      executionId: "exec-committed-failed",
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      status: "failed",
      phase: "WORK",
      target: { generationType: "normal" },
      errorCode: "provider_request_error",
      errorMessage: "upstream refused",
    });
    const failedPayload = await failed;
    expect(failedPayload.errorCode).toBe("provider_request_error");
    expect(failedPayload.error).toBe("FAILED: provider_request_error: upstream refused");
    expect(failedPayload.phase).toBe("FAILED");
    expect(failedPayload.content).toBe("provisional failure output");
    removePoolEntry("exec-committed-failed");
  });

  test("terminal inspection and projection are emitted before GENERATION_ENDED", async () => {
    const deps = __testing.buildDependencies();
    const executionId = `exec-terminal-order-${Date.now()}`;
    seedCommittedExecution(executionId);
    const order: string[] = [];
    const settled = Promise.withResolvers<void>();
    const maybeSettled = (): void => {
      if (order.length === 3) settled.resolve();
    };
    const removeProjection = eventBus.onInternal(EventType.AGENT_RUN_CHANGED, (event) => {
      const payload = event.payload as { readonly run?: { readonly turnId?: unknown } } | undefined;
      if (payload?.run?.turnId === executionId) {
        const inspection = getDb().query(
          "SELECT outcome FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?",
        ).get(USER_ID, executionId) as { outcome: string | null } | null;
        if (inspection?.outcome === "completed") order.push("inspection");
        order.push("projection");
        maybeSettled();
      }
    });
    const removeTerminal = eventBus.on(EventType.GENERATION_ENDED, (event) => {
      const payload = event.payload as { readonly generationId?: unknown } | undefined;
      if (payload?.generationId === executionId) {
        order.push("terminal");
        maybeSettled();
      }
    });
    try {
      deps.publishTerminal!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        status: "completed",
        phase: "COMMITTED",
        target: { generationType: "normal" },
      });
      await settled.promise;
    } finally {
      removeProjection();
      removeTerminal();
    }
    expect(order).toEqual(["inspection", "projection", "terminal"]);
  });
  test("terminal convergence rolls back every derived plane and retries without a synthetic cause", async () => {
    const db = getDb();
    const deps = __testing.buildDependencies();
    const executionId = "exec-terminal-atomic-" + Date.now();
    const trigger = "agentic_projection_failure_" + Date.now();
    const ended: string[] = [];
    const emittedTerminal = Promise.withResolvers<void>();
    seedCommittedExecution(executionId);
    const removeEnded = eventBus.on(EventType.GENERATION_ENDED, (emitted) => {
      const payload = emitted.payload as { readonly generationId?: unknown } | undefined;
      if (payload?.generationId === executionId) {
        ended.push(executionId);
        emittedTerminal.resolve();
      }
    });
    const event = {
      executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      status: "completed" as const,
      phase: "COMMITTED" as const,
      target: { generationType: "normal" as const },
    };
    db.run(`
      CREATE TRIGGER ${trigger}
      BEFORE INSERT ON agent_run_projections
      BEGIN
        SELECT RAISE(ABORT, 'projection write unavailable');
      END
    `);
    try {
      expect(() => deps.publishTerminal!(event)).toThrow();
      expect(db.query(
        "SELECT status FROM agent_run_projections WHERE user_id = ? AND turn_id = ?",
      ).get(USER_ID, executionId)).toBeNull();
      expect(db.query(
        "SELECT outcome FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?",
      ).get(USER_ID, executionId)).toBeNull();
      expect(ended).toEqual([]);
    } finally {
      db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
    }

    try {
      deps.publishTerminal!(event);
      await emittedTerminal.promise;
      const projection = db.query(
        "SELECT status, snapshot_json FROM agent_run_projections WHERE user_id = ? AND turn_id = ?",
      ).get(USER_ID, executionId) as { status: string; snapshot_json: string } | null;
      expect(projection?.status).toBe("COMMITTED");
      expect(JSON.parse(projection?.snapshot_json ?? "{}")).not.toHaveProperty("error.code", "projection_unavailable");
      expect(db.query(
        "SELECT status, outcome FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?",
      ).get(USER_ID, executionId)).toMatchObject({ status: "terminal", outcome: "completed" });
      expect(ended).toEqual([executionId]);
    } finally {
      removeEnded();
    }
  });

  test("startup reconstructs every noncommitted terminal projection after inspection or projection loss", () => {
    const db = getDb();
    const deps = __testing.buildDependencies();
    const terminalCases = [
      { suffix: "commit-failed", status: "completed", eventPhase: "COMMITTED", projectionStatus: "COMMIT_FAILED", outcome: "failed" },
      { suffix: "cancelled", status: "cancelled", eventPhase: "CANCELLED", projectionStatus: "CANCELLED", outcome: "stopped" },
      { suffix: "timed-out", status: "timed_out", eventPhase: "TIMED_OUT", projectionStatus: "TIMED_OUT", outcome: "failed" },
      { suffix: "exhausted", status: "exhausted", eventPhase: "EXHAUSTED", projectionStatus: "EXHAUSTED", outcome: "exhausted" },
      { suffix: "rejected", status: "rejected", eventPhase: "FAILED", projectionStatus: "FAILED", outcome: "rejected", errorCode: "invalid_input" },
      { suffix: "failed", status: "failed", eventPhase: "FAILED", projectionStatus: "FAILED", outcome: "failed", errorCode: "provider_request_error" },
    ] as const;
    const recoveryModes = ["inspection", "projection"] as const;
    let sequence = 0;

    for (const recoveryMode of recoveryModes) {
      for (const terminalCase of terminalCases) {
        const executionId = `exec-terminal-startup-${recoveryMode}-${terminalCase.suffix}-${Date.now()}-${sequence++}`;
        const trigger = `agentic_terminal_startup_${recoveryMode}_${sequence}`;
        const event = {
          executionId,
          userId: USER_ID,
          chatId: AGENTIC_CHAT_ID,
          status: terminalCase.status,
          phase: terminalCase.eventPhase,
          target: { generationType: "normal" as const },
          ...("errorCode" in terminalCase ? { errorCode: terminalCase.errorCode } : {}),
        } as const;
        if (recoveryMode === "inspection") {
          db.run(`
            CREATE TRIGGER ${trigger}
            BEFORE INSERT ON agent_run_attempts
            BEGIN
              SELECT RAISE(ABORT, 'terminal inspection unavailable');
            END
          `);
        } else {
          db.run(`
            CREATE TRIGGER ${trigger}
            BEFORE INSERT ON agent_run_projections
            BEGIN
              SELECT RAISE(ABORT, 'terminal projection unavailable');
            END
          `);
        }
        try {
          expect(() => deps.publishTerminal!(event)).toThrow();
        } finally {
          db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
        }

        expect(db.query(
          "SELECT status FROM agent_run_projections WHERE user_id = ? AND chat_id = ? AND turn_id = ?",
        ).get(USER_ID, AGENTIC_CHAT_ID, executionId)).toBeNull();
        const first = reconcileAgentTurns(db);
        expect(first.complete).toBe(true);
        expect(db.query(
          "SELECT state FROM agent_turn_executions WHERE user_id = ? AND id = ?",
        ).get(USER_ID, executionId)).toEqual({ state: terminalCase.projectionStatus });
        const projection = db.query(
          "SELECT status, snapshot_json FROM agent_run_projections WHERE user_id = ? AND chat_id = ? AND turn_id = ?",
        ).get(USER_ID, AGENTIC_CHAT_ID, executionId) as { status: string; snapshot_json: string } | null;
        expect(projection?.status).toBe(terminalCase.projectionStatus);
        expect(JSON.parse(projection?.snapshot_json ?? "{}")).toMatchObject({
          workPhase: "TERMINAL",
          workStatus: "terminal",
          workOutcome: terminalCase.outcome,
        });
        const inspection = getAgentRunInspection(USER_ID, executionId, AGENTIC_CHAT_ID);
        expect(inspection).toMatchObject({
          terminal: true,
          outcome: terminalCase.outcome,
        });
        const eventCount = (db.query(
          "SELECT COUNT(*) AS count FROM agent_chat_events WHERE user_id = ? AND chat_id = ? AND turn_id = ? AND event_kind = 'terminal'",
        ).get(USER_ID, AGENTIC_CHAT_ID, executionId) as { count: number }).count;
        const snapshot = projection?.snapshot_json;
        const second = reconcileAgentTurns(db);
        expect(second.complete).toBe(true);
        const replayedProjection = db.query(
          "SELECT snapshot_json FROM agent_run_projections WHERE user_id = ? AND chat_id = ? AND turn_id = ?",
        ).get(USER_ID, AGENTIC_CHAT_ID, executionId) as { snapshot_json: string } | null;
        expect(replayedProjection?.snapshot_json).toBe(snapshot);
        expect((db.query(
          "SELECT COUNT(*) AS count FROM agent_chat_events WHERE user_id = ? AND chat_id = ? AND turn_id = ? AND event_kind = 'terminal'",
        ).get(USER_ID, AGENTIC_CHAT_ID, executionId) as { count: number }).count).toBe(eventCount);
      }
    }
  });

  test("terminal inspection failure defers every derived surface and pool settlement", async () => {
    const db = getDb();
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const target = { generationType: "normal" as const, revision: ADMITTED_TARGET_REVISION };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!(
      {
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        connectionId: CONNECTION_ID,
        presetId: AGENTIC_PRESET_ID,
        generationType: "normal",
        userInput: USER_INPUT,
      },
      target,
      signal,
    );
    const executionId = `exec-terminal-inspection-failure-${Date.now()}`;
    const execution = await deps.createExecution!({
      executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      signal,
    });
    const ownerToken = execution.ownerToken;
    const initialPhase = execution.phase;
    if (ownerToken === undefined || initialPhase === undefined) {
      throw new Error("coordinator test execution did not return durable ownership");
    }
    errorPool(executionId, "watchdog fired before durable terminal convergence");
    expect(getPoolEntry(executionId)?.status).not.toBe("error");
    let currentPhase = initialPhase;
    for (const nextPhase of ["WORK", "COMPLETE", "RENDER", "PREPARE_COMMIT", "COMMITTING"] as const) {
      currentPhase = transitionTurnExecution({
        executionId,
        ownerToken,
        expectedPhase: currentPhase,
        nextPhase,
        ignoreCancellation: true,
      }).execution.phase;
    }
    const committedMessageId = "message:" + executionId;
    seedTargetMessage(committedMessageId, AGENTIC_CHAT_ID, 0);
    finalizeTurnCommit({
      executionId,
      ownerToken,
      receiptId: `receipt:${executionId}`,
      messageId: committedMessageId,
      swipeId: 0,
      summary: { source: "coordinator-test" },
    });
    const trigger = `agentic_terminal_inspection_failure_${Date.now()}`;
    const event = {
      executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      status: "completed" as const,
      phase: "COMMITTED" as const,
      target: { generationType: "normal" as const },
    };
    db.run(`
      CREATE TRIGGER ${trigger}
      BEFORE UPDATE ON agent_run_attempts
      WHEN NEW.outcome = 'completed'
      BEGIN
        SELECT RAISE(ABORT, 'terminal inspection unavailable');
      END
    `);
    try {
      expect(() => deps.publishTerminal!(event)).toThrow();
      expect(db.query(
        "SELECT status, snapshot_json FROM agent_run_projections WHERE user_id = ? AND turn_id = ?",
      ).get(USER_ID, executionId)).toBeNull();
      expect(db.query(
        "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE user_id = ? AND execution_id = ?",
      ).get(USER_ID, executionId)).toMatchObject({
        phase: "ADMIT",
        status: "pending",
        outcome: null,
      });
      expect(db.query(
        "SELECT state FROM agent_turn_executions WHERE user_id = ? AND id = ?",
      ).get(USER_ID, executionId)).toMatchObject({ state: "COMMITTED" });
      expect(db.query(
        "SELECT receipt_id FROM agent_turn_commit_receipts WHERE user_id = ? AND execution_id = ?",
      ).get(USER_ID, executionId)).toMatchObject({ receipt_id: `receipt:${executionId}` });
      errorPool(executionId, "watchdog fired after execution but before durable projections");
      expect(getPoolEntry(executionId)?.status).not.toBe("error");
    } finally {
      db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
      deps.cleanup!({
        execution,
        phase: "COMMITTED",
        status: "completed",
      } as never);
    }
    expect(db.query(
      "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE user_id = ? AND execution_id = ?",
    ).get(USER_ID, executionId)).toMatchObject({
      phase: "ADMIT",
      status: "pending",
      outcome: null,
    });
    const recovery = __testing.reconcilePersistentWorkspaceSessions();
    expect(recovery.complete).toBe(true);
    expect(db.query(
      "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE user_id = ? AND execution_id = ?",
    ).get(USER_ID, executionId)).toMatchObject({
      phase: "TERMINAL",
      status: "terminal",
      outcome: "completed",
    });
    expect(db.query(
      "SELECT status FROM agent_run_projections WHERE user_id = ? AND turn_id = ?",
    ).get(USER_ID, executionId)).toMatchObject({ status: "COMMITTED" });
    expect(db.query(
      "SELECT status, outcome FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?",
    ).get(USER_ID, executionId)).toMatchObject({ status: "terminal", outcome: "completed" });
    completePool(executionId, committedMessageId);
    expect(getPoolEntry(executionId)).toMatchObject({
      status: "completed",
      completedMessageId: committedMessageId,
    });
  });
  test("generic Stop repairs a publish fault through the exact dormant owner", async () => {
    const db = getDb();
    const deps = __testing.buildDependencies();
    markAgenticRuntimeReady();
    const target = { generationType: "normal" as const, revision: ADMITTED_TARGET_REVISION };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!(
      { userId: USER_ID, chatId: AGENTIC_CHAT_ID, connectionId: CONNECTION_ID, presetId: AGENTIC_PRESET_ID, generationType: "normal", userInput: USER_INPUT },
      target,
      signal,
    );
    const executionId = "exec-generic-stop-recovery-" + Date.now();
    const trigger = "agentic_generic_stop_projection_failure_" + Date.now();
    const execution = await deps.createExecution!({
      executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      signal,
    });
    if (!execution.ownerToken || !execution.phase) throw new Error("durable execution ownership unavailable");
    transitionTurnExecution({
      executionId,
      ownerToken: execution.ownerToken,
      expectedPhase: execution.phase,
      nextPhase: "FAILED",
      reason: "agentic_provider_failure",
    });
    db.run(
      "CREATE TRIGGER " + trigger + " BEFORE INSERT ON agent_run_projections " +
      "BEGIN SELECT RAISE(ABORT, 'projection write unavailable'); END",
    );
    try {
      expect(() => deps.publishTerminal!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        status: "failed",
        phase: "FAILED",
        target,
        errorCode: "agentic_provider_failure",
      })).toThrow();
    } finally {
      db.run("DROP TRIGGER IF EXISTS " + trigger);
      deps.cleanup!({ execution, executionId, phase: "FAILED", status: "failed" } as never);
    }
    try {
      expect(await stopGeneration("user-other", executionId, AGENTIC_CHAT_ID)).toBe(false);
      expect(await stopGeneration(USER_ID, executionId, "chat-other")).toBe(false);
      expect(db.query(
        "SELECT status FROM agent_run_projections WHERE user_id = ? AND turn_id = ?",
      ).get(USER_ID, executionId)).toBeNull();
      const terminalStop = await stopGeneration(USER_ID, executionId, AGENTIC_CHAT_ID);
      expect(terminalStop).toMatchObject({
        status: "terminal",
        generationId: executionId,
        run: {
          status: "terminal",
          turnId: executionId,
          workStatus: "terminal",
          workOutcome: "failed",
          reason: "provider_failure",
        },
      });
      expect(db.query(
        "SELECT phase, status, outcome FROM persistent_workspace_turn_sessions WHERE user_id = ? AND execution_id = ?",
      ).get(USER_ID, executionId)).toMatchObject({ phase: "TERMINAL", status: "terminal", outcome: "failed" });
      expect(db.query(
        "SELECT status, outcome, reason FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?",
      ).get(USER_ID, executionId)).toMatchObject({ status: "terminal", outcome: "failed", reason: "provider_failure" });
      expect(db.query(
        "SELECT status FROM agent_run_projections WHERE user_id = ? AND chat_id = ? AND turn_id = ?",
      ).get(USER_ID, AGENTIC_CHAT_ID, executionId)).toMatchObject({ status: "FAILED" });
      expect((db.query(
        "SELECT COUNT(*) AS count FROM agent_chat_events WHERE user_id = ? AND chat_id = ? AND turn_id = ? AND event_kind = 'terminal'",
      ).get(USER_ID, AGENTIC_CHAT_ID, executionId) as { count: number }).count).toBe(1);
      expect(getPoolEntry(executionId)?.status).toBe("error");
    } finally {
      removePoolEntry(executionId);
    }
  });

  test("failed terminal convergence leaves only the durable execution cause and emits nothing", () => {
    const db = getDb();
    const deps = __testing.buildDependencies();
    const executionId = `exec-terminal-reconcile-failure-${Date.now()}`;
    const trigger = `agentic_projection_failure_${Date.now()}`;
    const ended: string[] = [];
    const removeEnded = eventBus.on(EventType.GENERATION_ENDED, (event) => {
      const payload = event.payload as { readonly generationId?: unknown } | undefined;
      if (payload?.generationId === executionId) ended.push(executionId);
    });
    db.run(`
      CREATE TRIGGER ${trigger}
      BEFORE INSERT ON agent_run_projections
      BEGIN
        SELECT RAISE(ABORT, 'projection write unavailable');
      END
    `);
    const event = {
      executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      status: "completed" as const,
      phase: "COMMITTED" as const,
      target: { generationType: "normal" as const },
    };
    try {
      expect(() => deps.publishTerminal!(event)).toThrow();
      expect(db.query(
        "SELECT status FROM agent_run_projections WHERE user_id = ? AND turn_id = ?",
      ).get(USER_ID, executionId)).toBeNull();
      expect(db.query(
        "SELECT state, terminal_code FROM agent_turn_executions WHERE user_id = ? AND id = ?",
      ).get(USER_ID, executionId)).toMatchObject({
        state: "COMMIT_FAILED",
        terminal_code: "agentic_commit_failed",
      });
      expect(db.query(
        "SELECT status, outcome FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?",
      ).get(USER_ID, executionId)).toBeNull();
      expect(ended).toEqual([]);
    } finally {
      db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
      removeEnded();
    }
  });

  test("admission returns the exact retry attempt lineage", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    const deps = __testing.buildDependencies();
    const target = { generationType: "normal" as const };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!({
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal",
    }, target, signal);
    const attemptLineage = {
      version: 1 as const,
      attemptId: "attempt-admission-exact",
      previousAttemptId: "attempt-admission-parent",
      target: {
        chatId: AGENTIC_CHAT_ID,
        generationType: "normal" as const,
        messageId: null,
        swipeId: null,
      },
      createdAt: 123456,
    };
    const executionId = "exec-attempt-lineage-exact";
    const execution = await deps.createExecution!({
      executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      attemptLineage,
      signal,
    });
    try {
      const session = getDb().query(
        `SELECT attempt_id
           FROM persistent_workspace_turn_sessions
          WHERE user_id = ? AND chat_id = ? AND turn_id = ? AND execution_id = ?`,
      ).get(USER_ID, AGENTIC_CHAT_ID, executionId, executionId) as { attempt_id: string } | null;
      expect(session).toEqual({ attempt_id: executionId });
      expect(session?.attempt_id).not.toBe(attemptLineage.attemptId);
      const canonicalAttempt = getDb().query(
        `SELECT attempt_id
           FROM agent_run_attempts
          WHERE user_id = ? AND chat_id = ? AND turn_id = ? AND attempt_id = ?`,
      ).get(USER_ID, AGENTIC_CHAT_ID, executionId, executionId) as { attempt_id: string } | null;
      expect(canonicalAttempt).toEqual({ attempt_id: executionId });
      expect((execution as typeof execution & { readonly attemptLineage?: unknown }).attemptLineage).toBe(attemptLineage);
    } finally {
      deps.cleanup?.({ execution } as never);
    }
  });

  test("retry admission preserves the exact admitted regenerate swipe", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    const now = Date.now();
    const messageId = "message-retry-admitted-swipe";
    getDb().query("INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra, created_at, generation_revision) VALUES (?, ?, 0, 0, ?, ?, ?, 0, ?, ?, '{}', ?, ?)").run(
      messageId,
      AGENTIC_CHAT_ID,
      "Coordinator",
      "retry target",
      now,
      JSON.stringify(["first", "admitted"]),
      JSON.stringify([now, now]),
      now,
      ADMITTED_TARGET_REVISION,
    );
    const deps = __testing.buildDependencies();
    const target = {
      generationType: "regenerate" as const,
      messageId,
      swipeId: 1,
      revision: ADMITTED_TARGET_REVISION,
    };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!({
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "regenerate",
      messageId,
      swipeId: 1,
    }, target, signal);
    const executionId = "exec-retry-admitted-swipe";
    const execution = await deps.createExecution!({
      executionId,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      attemptLineage: {
        version: 1,
        attemptId: "attempt-retry-admitted-swipe",
        previousAttemptId: "attempt-retry-parent",
        target: {
          chatId: AGENTIC_CHAT_ID,
          generationType: "regenerate",
          messageId,
          swipeId: 1,
        },
        createdAt: 123457,
      },
      signal,
    });
    try {
      expect(getPoolEntry(executionId)?.targetSwipeId).toBe(1);
      expect((getDb().query("SELECT target_swipe_id FROM agent_turn_executions WHERE id = ?").get(executionId) as { target_swipe_id: number } | null)?.target_swipe_id).toBe(1);
    } finally {
      deps.cleanup?.({ execution } as never);
    }
  });
});

type RenderMessageSourceKind = "block" | "history" | "world_info" | "cognition" | "databank";

function renderLiteralSegments(text: string): readonly AssemblyMessageSegmentV1[] {
  return [{ kind: "literal", text, bytes: Buffer.byteLength(text, "utf8") }];
}

function assembledRenderMessage(
  role: AssemblyProviderMessageV1["role"],
  text: string,
  kind: RenderMessageSourceKind,
  sourceId: string,
): AssemblyProviderMessageV1 {
  return {
    role,
    contentKind: "segments",
    provenance: { kind, sourceId, sourceRevision: "1", sourceIndex: 0 },
    segments: renderLiteralSegments(text),
  };
}

function authoredRenderPolicy(text: string): AssemblyProviderMessageV1 {
  return assembledRenderMessage("system", text, "cognition", "render-policy");
}

function loomTaggedRenderMessage(text: string): AssemblyCompiledPolicyProviderMessageV1 {
  return {
    role: "system",
    blockIndex: 0,
    contentKind: "segments",
    provenance: {
      kind: "cognition",
      sourceId: "loom-render-block",
      sourceRevision: "1",
      sourceIndex: 0,
      loom: {
        entryId: "loom-render",
        bucket: "renderPolicy",
        destination: "render",
        checkpoint: "RENDER",
        source: {
          kind: "loom_block",
          blockId: "loom-render-block",
          presetRevision: 1,
          blockRevision: 1,
          promptOrder: 0,
        },
        effectiveText: text,
      },
    },
    segments: renderLiteralSegments(text),
  };
}

const RENDER_NARRATIVE_FACT_MESSAGE = [
  "Name: Eleanor",
  "Personality: Warm, reserved, and precise.",
  "Scenario: A rain-soaked London boarding house.",
  "Description: A retired cartographer.",
  "World (London): Fog-bound streets above a shuttered map shop.",
].join("\n");

const COMPLETION_HANDOFF_MESSAGE = [
  "Current root-turn terminal handoff (host authority, not the reply):",
  "The host accepted WORK completion for this exact current root turn at its frozen workspace revision. This terminal acceptance is current control state, not a claim inferred from workspace evidence, and remains authoritative even when accepted findings or submissions contain older or different scenario labels. Never state or imply that the current request was not executed, lacks a host-accepted completion handoff, or represents only a prior completion. Treat the accepted workspace findings/submissions as additional host-accepted evidence alongside the supplied conversation and native World Info/Databank context. Never infer or expose private WORK records, reasoning, completion evidence, unresolved item IDs, or the operational transcript.",
].join("\n");

describe("prompt evidence occurrence identity", () => {
  const message = (input: Readonly<{
    role: "system" | "user";
    sourceIndex: number;
    promptOrder: number;
    text: string;
    sourceId?: string;
    blockRevision?: number;
    entryId?: string;
    bucket?: "workPolicy" | "workspaceUsage" | "completionCriteria" | "renderPolicy";
    destination?: "root_work" | "completion_handoff" | "render";
    checkpoint?: "ASSEMBLE" | "WORK" | "PREPARE_COMMIT" | "RENDER";
  }>): AssemblyCompiledPolicyProviderMessageV1 => {
    const sourceId = input.sourceId ?? "shared-source";
    const blockRevision = input.blockRevision ?? 7;
    const destination = input.destination ?? "root_work";
    return {
      blockIndex: input.promptOrder,
      role: input.role,
      contentKind: "segments",
      provenance: {
        kind: "cognition",
        sourceId,
        sourceRevision: "snapshot-digest-not-loom-revision",
        sourceIndex: input.sourceIndex,
        loom: {
          entryId: input.entryId ?? `${sourceId}-${input.promptOrder}`,
          bucket: input.bucket ?? "workPolicy",
          destination,
          checkpoint: input.checkpoint ?? "ASSEMBLE",
          source: {
            kind: "loom_block",
            blockId: sourceId,
            presetRevision: 1,
            blockRevision,
            promptOrder: input.promptOrder,
          },
          effectiveText: input.text,
        },
      },
      segments: renderLiteralSegments(input.text),
    };
  };

  const durableWriter = (attemptId: string) => createAgentInspectionWriter({
    userId: USER_ID,
    chatId: AGENTIC_CHAT_ID,
    attemptId,
    runId: attemptId,
    turnSessionId: attemptId,
    generationId: attemptId,
    generationType: "normal",
    hostCorrelationId: attemptId,
    lifecycle: "ASSEMBLE",
    status: "running",
  });

  test("records sparse cognition occurrences at Loom coordinates and rejects malformed provenance", () => {
    const records: unknown[] = [];
    const writer = {
      record: (_kind: string, value?: unknown) => {
        records.push(value);
        return null;
      },
    } as unknown as Parameters<typeof __testing.recordInspectionPrompts>[0];

    __testing.recordInspectionPrompts(writer, [
      message({ role: "system", sourceIndex: 0, promptOrder: 3, text: "SYSTEM OCCURRENCE" }),
      message({ role: "user", sourceIndex: 1, promptOrder: 7, text: "USER OCCURRENCE", bucket: "workspaceUsage" }),
    ], "root_work", "WORK");

    expect(records).toEqual([
      expect.objectContaining({ sourceId: "shared-source", sourceRevision: 7, promptOrder: 3, role: "system", content: "SYSTEM OCCURRENCE" }),
      expect.objectContaining({ sourceId: "shared-source", sourceRevision: 7, promptOrder: 7, role: "user", content: "USER OCCURRENCE" }),
    ]);
    expect(new Set(records.map((record) => (record as { id: string }).id))).toHaveLength(2);

    const missingLoom = {
      ...message({ role: "system", sourceIndex: 2, promptOrder: 9, text: "MISSING LOOM PRIVATE" }),
      provenance: {
        kind: "cognition",
        sourceId: "shared-source",
        sourceRevision: "snapshot-digest",
        sourceIndex: 2,
      },
    } as unknown as AssemblyProviderMessageV1;
    const forgedOrderBase = message({ role: "user", sourceIndex: 3, promptOrder: 11, text: "FORGED ORDER PRIVATE" });
    const forgedLoomOrder = {
      ...forgedOrderBase,
      provenance: {
        ...forgedOrderBase.provenance,
        loom: {
          ...forgedOrderBase.provenance.loom!,
          source: { ...forgedOrderBase.provenance.loom!.source, promptOrder: "11" },
        },
      },
    } as unknown as AssemblyProviderMessageV1;
    const forgedRevisionBase = message({ role: "system", sourceIndex: 4, promptOrder: 13, text: "FORGED REVISION PRIVATE" });
    const forgedLoomRevision = {
      ...forgedRevisionBase,
      provenance: {
        ...forgedRevisionBase.provenance,
        loom: {
          ...forgedRevisionBase.provenance.loom!,
          source: { ...forgedRevisionBase.provenance.loom!.source, blockRevision: "7" },
        },
      },
    } as unknown as AssemblyProviderMessageV1;
    __testing.recordInspectionPrompts(writer, [missingLoom, forgedLoomOrder, forgedLoomRevision], "root_work", "WORK");
    expect(records).toHaveLength(2);
    expect(JSON.stringify(records)).not.toContain("PRIVATE");
  });

  test("persists separate bucket and lifecycle writes without local-index ID collisions", () => {
    const attemptId = "prompt-occurrence-production-topology";
    const writer = durableWriter(attemptId);
    const workPolicy = message({
      role: "system", sourceIndex: 0, promptOrder: 3, text: "SYSTEM OCCURRENCE",
      entryId: "work-policy-entry", bucket: "workPolicy", checkpoint: "ASSEMBLE",
    });
    const workspaceUsage = message({
      role: "user", sourceIndex: 0, promptOrder: 7, text: "USER OCCURRENCE",
      entryId: "workspace-usage-entry", bucket: "workspaceUsage", checkpoint: "ASSEMBLE",
    });
    const renderPolicy = message({
      role: "system", sourceIndex: 0, promptOrder: 9, text: "RENDER OCCURRENCE",
      sourceId: "render-source", entryId: "render-policy-entry", bucket: "renderPolicy",
      destination: "render", checkpoint: "RENDER",
    });

    __testing.recordInspectionPrompts(writer, [workPolicy], "root_work", "ASSEMBLE");
    __testing.recordInspectionPrompts(writer, [workspaceUsage], "root_work", "ASSEMBLE");
    __testing.recordInspectionPrompts(writer, [renderPolicy], "render", "ASSEMBLE");
    __testing.recordInspectionPrompts(writer, [workPolicy], "root_work", "WORK");
    __testing.recordInspectionPrompts(writer, [workspaceUsage], "root_work", "WORK");
    __testing.recordInspectionPrompts(writer, [renderPolicy], "render", "RENDER");

    const persisted = getAgentRunInspection(USER_ID, attemptId, AGENTIC_CHAT_ID);
    expect(persisted?.promptEvidence.map((entry) => ({
      id: entry.id,
      sourceId: entry.sourceId,
      sourceRevision: entry.sourceRevision,
      promptOrder: "promptOrder" in entry ? entry.promptOrder : undefined,
      destination: entry.destination,
      role: entry.role,
      content: entry.content,
      phase: entry.correlation.phase,
    }))).toEqual([
      expect.objectContaining({ sourceId: "shared-source", sourceRevision: 7, promptOrder: 3, destination: "root_work", role: "system", content: "SYSTEM OCCURRENCE", phase: "ASSEMBLE" }),
      expect.objectContaining({ sourceId: "shared-source", sourceRevision: 7, promptOrder: 7, destination: "root_work", role: "user", content: "USER OCCURRENCE", phase: "ASSEMBLE" }),
      expect.objectContaining({ sourceId: "render-source", sourceRevision: 7, promptOrder: 9, destination: "render", role: "system", content: "RENDER OCCURRENCE", phase: "ASSEMBLE" }),
      expect.objectContaining({ sourceId: "shared-source", sourceRevision: 7, promptOrder: 3, destination: "root_work", role: "system", content: "SYSTEM OCCURRENCE", phase: "WORK" }),
      expect.objectContaining({ sourceId: "shared-source", sourceRevision: 7, promptOrder: 7, destination: "root_work", role: "user", content: "USER OCCURRENCE", phase: "WORK" }),
      expect.objectContaining({ sourceId: "render-source", sourceRevision: 7, promptOrder: 9, destination: "render", role: "system", content: "RENDER OCCURRENCE", phase: "RENDER" }),
    ]);
    expect(new Set(persisted?.promptEvidence.map((entry) => entry.id))).toHaveLength(6);

    const collisionAttemptId = "prompt-occurrence-distinct-payload-collision";
    const collisionWriter = durableWriter(collisionAttemptId);
    __testing.recordInspectionPrompts(collisionWriter, [message({
      role: "system", sourceIndex: 0, promptOrder: 3, text: "COLLISION SYSTEM PRIVATE", entryId: "collision-entry",
    })], "root_work", "WORK");
    __testing.recordInspectionPrompts(collisionWriter, [message({
      role: "user", sourceIndex: 0, promptOrder: 3, text: "COLLISION USER PRIVATE", entryId: "collision-entry",
    })], "root_work", "WORK");
    const collision = getAgentRunInspection(USER_ID, collisionAttemptId, AGENTIC_CHAT_ID);
    expect(collision?.promptEvidence).toEqual([]);
    expect(collision?.markers).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "prompt", kind: "unavailable", detail: "Prompt occurrence unavailable: conflicting retained evidence." }),
    ]));
    expect(JSON.stringify(collision)).not.toContain("COLLISION SYSTEM PRIVATE");
    expect(JSON.stringify(collision)).not.toContain("COLLISION USER PRIVATE");
  });
});

describe("agentic render crossings", () => {
  test("records only accepted handoff identities and explicit render guidance", () => {
    const records: unknown[] = [];
    const writer = {
      record: (_kind: string, value?: unknown) => {
        records.push(value);
        return null;
      },
    } as unknown as Parameters<typeof __testing.recordRenderCrossings>[0];
    __testing.recordRenderCrossings(writer, {
      renderGuidance: "Tell the user the accepted result.",
      workspaceContextProjection: {
        version: 1,
        sourceWorkspaceRevision: 9,
        mandatory: [
          { kind: "objective", id: "objective-1", text: "private objective", sourceRevision: 1 },
          { kind: "finding", id: "finding-7", text: "accepted finding", sourceRevision: 4 },
        ],
        optional: [
          { kind: "accepted_submission", id: "submission-2", text: "accepted submission", sourceRevision: 5 },
          { kind: "optional_task", id: "task-3", text: "private task", sourceRevision: 6 },
        ],
        omissions: [],
        literal: "",
        utf8Bytes: 0,
      },
    }, "generation-1");
    expect(records).toHaveLength(3);
    expect(records).toEqual([
      expect.objectContaining({
        sourceId: "finding-7",
        sourceRevision: 4,
        destination: "render",
        renderCrossing: expect.objectContaining({
          kind: "accepted_finding",
          sourceId: "finding-7",
          sourceRevision: 4,
          content: "accepted finding",
        }),
      }),
      expect.objectContaining({
        sourceId: "submission-2",
        sourceRevision: 5,
        renderCrossing: expect.objectContaining({
          kind: "accepted_submission",
          sourceId: "submission-2",
          sourceRevision: 5,
          content: "accepted submission",
        }),
      }),
      expect.objectContaining({
        sourceId: "completion-guidance:generation-1",
        sourceRevision: 0,
        renderCrossing: expect.objectContaining({
          kind: "completion_guidance",
          sourceRevision: null,
          content: "Tell the user the accepted result.",
        }),
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("private objective");
    expect(JSON.stringify(records)).not.toContain("private task");
  });
});

describe("agentic terminal inspection", () => {
  test("does not misclassify a completed turn's internal reason as needs attention", () => {
    expect(__testing.terminalInspectionReason("completed", "commit_finished", null)).toBe("none");
    expect(__testing.terminalInspectionReason("failed", "provider_failure", null)).toBe("provider_failure");
  });
});

describe("agentic RENDER narrative prompt", () => {
  const isRootBinding = (message: { readonly role: string; readonly content: unknown }): boolean => {
    if (message.role !== "system" || typeof message.content !== "string") return false;
    try {
      return (JSON.parse(message.content) as { kind?: string }).kind === "host_root_user_message_binding";
    } catch {
      return false;
    }
  };

  test("binds the exact root user message, adds the completion handoff, and falls back to the host contract", () => {
    const renderGuidance = "Keep the reply intimate and in Eleanor's voice.";
    const messages = __testing.buildAgenticRenderPolicyMessages({
      nativeMessages: [
        assembledRenderMessage("system", RENDER_NARRATIVE_FACT_MESSAGE, "world_info", "world-london"),
        assembledRenderMessage("user", USER_INPUT, "history", "user-1"),
        assembledRenderMessage("assistant", "Eleanor is already in the room.", "history", "assistant-1"),
      ],
      rootUserMessageIds: ["user-1"],
      renderPolicyMessages: [],
      renderGuidance,
    });
    expect(messages[0]).toEqual({ role: "system", content: RENDER_NARRATIVE_FACT_MESSAGE });
    expect(isRootBinding(messages[1]!)).toBe(true);
    expect(messages[2]).toEqual({ role: "user", content: USER_INPUT });
    expect(messages[3]).toEqual({ role: "assistant", content: "Eleanor is already in the room." });
    expect(messages[4]).toEqual({
      role: "system",
      content: expect.stringContaining(`${COMPLETION_HANDOFF_MESSAGE}
`),
    });
    expect(String(messages[4]?.content)).toContain(`Render guidance:
${renderGuidance}`);
    expect(messages[5]).toEqual({ role: "system", content: __testing.HOST_RENDER_FINAL_RESPONSE_CONTRACT });
    const binding = JSON.parse(String(messages[1]?.content)) as { digest: string };
    expect(String(messages[4]?.content)).toContain(binding.digest);
    expect(messages.filter((message) => message.role !== "system").map((message) => message.content)).not.toContain("complete_turn");
  });

  test("preserves authenticated image and audio as typed multipart after the root binding", () => {
    const nativeUserMessage: AssemblyProviderMessageV1 = {
      ...assembledRenderMessage("user", "Review these files", "history", "user-media"),
      segments: [
        ...renderLiteralSegments("Review these files"),
        {
          kind: "media",
          mediaType: "image",
          mediaId: "image-1",
          mimeType: "image/png",
          byteLength: 8,
          sha256: "a".repeat(64),
          bytes: 0,
        },
        {
          kind: "media",
          mediaType: "audio",
          mediaId: "audio-1",
          mimeType: "audio/wav",
          byteLength: 12,
          sha256: "b".repeat(64),
          bytes: 0,
        },
      ],
    };
    const messages = __testing.buildAgenticRenderPolicyMessages({
      nativeMessages: [nativeUserMessage],
      rootUserMessageIds: ["user-media"],
      materializeMedia: (segment) => segment.mediaType === "image"
        ? { type: "image", data: `sealed:${segment.mediaId}`, mime_type: segment.mimeType }
        : { type: "audio", data: `sealed:${segment.mediaId}`, mime_type: segment.mimeType },
      renderPolicyMessages: [],
      renderGuidance: null,
    });

    expect(isRootBinding(messages[0]!)).toBe(true);
    expect(messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Review these files" },
        { type: "image", data: "sealed:image-1", mime_type: "image/png" },
        { type: "audio", data: "sealed:audio-1", mime_type: "audio/wav" },
      ],
    });
    expect(JSON.stringify(messages)).not.toContain("(attached)");
  });

  test("appends authored render policy instead of the host contract and excludes WORK-only messages", () => {
    const messages = __testing.buildAgenticRenderPolicyMessages({
      nativeMessages: [
        assembledRenderMessage("system", RENDER_NARRATIVE_FACT_MESSAGE, "world_info", "world-london"),
        assembledRenderMessage("user", USER_INPUT, "history", "user-1"),
        authoredRenderPolicy("MUST-NOT-APPEAR-complete_turn"),
      ],
      rootUserMessageIds: ["user-1"],
      renderGuidance: null,
      renderPolicyMessages: [authoredRenderPolicy("Stay in character as Eleanor.")],
    });
    expect(messages[0]).toEqual({ role: "system", content: RENDER_NARRATIVE_FACT_MESSAGE });
    expect(isRootBinding(messages[1]!)).toBe(true);
    expect(messages[2]).toEqual({ role: "user", content: USER_INPUT });
    expect(messages[3]).toEqual({ role: "system", content: "Stay in character as Eleanor." });
    expect(messages[4]).toEqual({ role: "system", content: expect.stringContaining(COMPLETION_HANDOFF_MESSAGE) });
    expect(messages.at(-1)?.content).toContain("this exact current root turn");
    expect(messages.at(-1)?.content).toContain("Never state or imply that the current request was not executed");
    expect(messages.some((message) => message.content === __testing.HOST_RENDER_FINAL_RESPONSE_CONTRACT)).toBe(false);
    expect(JSON.stringify(messages)).not.toContain("complete_turn");
  });

  test("filters non-native, Loom-tagged, and non-narrative ASSEMBLE messages", () => {
    const messages = __testing.buildAgenticRenderPolicyMessages({
      nativeMessages: [
        assembledRenderMessage("system", "Native preset context.", "block", "preset-block"),
        assembledRenderMessage("user", USER_INPUT, "history", "user-1"),
        assembledRenderMessage("assistant", "Native world continuation.", "world_info", "world-1"),
        assembledRenderMessage("system", "Native databank context.", "databank", "databank-1"),
        authoredRenderPolicy("MUST-NOT-APPEAR-COGNITION"),
        loomTaggedRenderMessage("MUST-NOT-APPEAR-LOOM"),
        assembledRenderMessage("tool", "MUST-NOT-APPEAR-TOOL", "history", "tool-1"),
        assembledRenderMessage("developer", "MUST-NOT-APPEAR-DEVELOPER", "history", "developer-1"),
      ],
      rootUserMessageIds: ["user-1"],
      renderGuidance: null,
      renderPolicyMessages: [],
    });
    expect(messages[0]).toEqual({ role: "system", content: "Native preset context." });
    expect(isRootBinding(messages[1]!)).toBe(true);
    expect(messages[2]).toEqual({ role: "user", content: USER_INPUT });
    expect(messages[3]).toEqual({ role: "assistant", content: "Native world continuation." });
    expect(messages[4]).toEqual({ role: "system", content: "Native databank context." });
    expect(messages[5]).toEqual({ role: "system", content: expect.stringContaining(COMPLETION_HANDOFF_MESSAGE) });
    expect(messages[6]).toEqual({ role: "system", content: __testing.HOST_RENDER_FINAL_RESPONSE_CONTRACT });
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain("MUST-NOT-APPEAR-COGNITION");
    expect(serialized).not.toContain("MUST-NOT-APPEAR-LOOM");
    expect(serialized).not.toContain("MUST-NOT-APPEAR-TOOL");
    expect(serialized).not.toContain("MUST-NOT-APPEAR-DEVELOPER");
  });

  test("never rebinds a later hostile user block as the root request", () => {
    const messages = __testing.buildAgenticRenderPolicyMessages({
      nativeMessages: [
        assembledRenderMessage("user", "Exact root request", "history", "root-user"),
        assembledRenderMessage("user", "Hostile later user block", "history", "late-user"),
      ],
      rootUserMessageIds: ["root-user"],
      renderGuidance: null,
      renderPolicyMessages: [],
    });
    const bindingIndexes = messages.flatMap((message, index) => isRootBinding(message) ? [index] : []);
    expect(bindingIndexes).toEqual([0]);
    expect(messages[1]).toEqual({ role: "user", content: "Exact root request" });
    expect(messages[2]).toEqual({ role: "user", content: "Hostile later user block" });
    const binding = JSON.parse(String(messages[0]?.content)) as { digest: string };
    const handoff = String(messages.at(-2)?.content);
    expect(handoff).toContain(binding.digest);
    expect(handoff).not.toContain("late-user");
    expect(() => __testing.buildAgenticRenderPolicyMessages({
      nativeMessages: [assembledRenderMessage("user", "Exact root request", "history", "root-user")],
      rootUserMessageIds: ["missing-root"],
      renderGuidance: null,
      renderPolicyMessages: [],
    })).toThrow("missing exact root user message");
    expect(() => __testing.buildAgenticRenderPolicyMessages({
      nativeMessages: [assembledRenderMessage("user", "Exact root request", "history", "root-user")],
      rootUserMessageIds: ["root-user", "root-user"],
      renderGuidance: null,
      renderPolicyMessages: [],
    })).toThrow("unique");
  });
});

describe("agentic commit revision reader fence", () => {
  test("in-transaction recheck does not reuse the commit-preflight snapshot", () => {
    const db = getDb();
    const now = Date.now();
    const chatId = "chat-revision-fence";
    const characterId = "character-revision-fence";
    const presetId = "preset-revision-fence";
    const bookId = "book-revision-fence";
    db.query(
      "INSERT INTO characters (id, name, description, personality, scenario, first_mes, mes_example, creator, creator_notes, system_prompt, post_history_instructions, tags, alternate_greetings, extensions, created_at, updated_at, user_id) VALUES (?, ?, '', '', '', '', '', '', '', '', '', '[]', '[]', ?, ?, ?, ?)",
    ).run(characterId, "Fence Character", JSON.stringify({ world_book_ids: [bookId] }), now, now, USER_ID);
    db.query(
      "INSERT INTO chats (id, user_id, character_id, name, created_at, updated_at, metadata, generation_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(chatId, USER_ID, characterId, "Fence Chat", now, now, "{}", 1);
    db.query(
      "INSERT INTO presets (id, user_id, name, provider, engine, parameters, prompt_order, prompts, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(presetId, USER_ID, "Fence Preset", "scripted-coordinator", "classic", "{}", "[]", "{}", "{}", now, now);
    db.query(
      `INSERT INTO preset_agent_configs
        (user_id, preset_id, version, agents_enabled, allowed_modes, default_mode,
         max_invocations, max_tool_calls, main_tool_ids, main_lore_scope,
         phase_policy_json, cognition_policy_json, task_policy_json,
         workspace_policy_json, state, review_acknowledged, config_revision, binding_revision,
         created_at, updated_at)
        VALUES (?, ?, 2, 1, ?, 'agentic', 8, 8, ?, 'active',
          '{}', '{}', '{}', '{}', 'ready', 1, 1, 1, ?, ?)`,
    ).run(USER_ID, presetId, JSON.stringify(["response", "agentic"]), JSON.stringify(["chat_search_history"]), now, now);
    db.query(
      "INSERT INTO world_books (id, user_id, name, description, folder, metadata, created_at, updated_at) VALUES (?, ?, ?, '', '', '{}', ?, ?)",
    ).run(bookId, USER_ID, "Fence Book", now, now);

    const reader = __testing.makeRevisionReader({
      userId: USER_ID,
      chatId,
      assemblySurface: "WORK",
      presetId,
      targetCharacterId: characterId,
    });
    const characterMember = { kind: "character", id: characterId };
    const configMember = { kind: "config", id: presetId };
    const loreMember = { kind: "world_lore", id: bookId };

    const preflightCharacter = reader(characterMember, db);
    const preflightConfig = reader(configMember, db);
    const preflightLore = reader(loreMember, db);
    expect(preflightCharacter?.revision).toEqual(expect.any(String));
    expect(preflightConfig?.revision).toEqual(expect.any(String));
    expect(preflightLore?.revision).toEqual(expect.any(String));

    db.query("UPDATE characters SET description = ? WHERE id = ?").run("hostile character edit", characterId);
    db.query("UPDATE preset_agent_configs SET config_revision = 99 WHERE user_id = ? AND preset_id = ?")
      .run(USER_ID, presetId);
    db.query("UPDATE world_books SET description = ?, updated_at = ? WHERE id = ?")
      .run("hostile lore edit", now + 1, bookId);

    const fenced = db.transaction(() => ({
      character: reader(characterMember, db),
      config: reader(configMember, db),
      lore: reader(loreMember, db),
    }))();

    expect(fenced.character?.revision).not.toBe(preflightCharacter?.revision);
    expect(fenced.character?.digest).not.toBe(preflightCharacter?.digest);
    expect(fenced.config?.revision).not.toBe(preflightConfig?.revision);
    expect(fenced.lore?.revision).not.toBe(preflightLore?.revision);
    expect(fenced.lore?.digest).not.toBe(preflightLore?.digest);
  });
});


describe("coordinator cognition transition snapshot seam", () => {
  test("acknowledges nested cognition settlement results and preserves committed requirements", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    const deps = __testing.buildDependencies();
    const input = {
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal" as const,
      userInput: USER_INPUT,
    };
    const target = { generationType: "normal" as const };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!(input, target, signal);
    const execution = await deps.createExecution!({
      executionId: `exec-cognition-settlement-${Date.now()}`,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      signal,
    });
    const executionSignal = execution.signal;
    if (!executionSignal) throw new Error("Cognition settlement execution signal was not installed");
    const settlementReservation = durableWorkspaceMutationReservation({
      executionId: execution.id,
      workspaceId: `workspace:` + execution.id,
      providerCallId: "raw-settlement-call",
      operationKind: "settle_child_task",
      frameId: execution.id,
    });
    const seenTransitions: Array<{ readonly operation: string; readonly operationKey: string; readonly actor?: unknown }> = [];
    const cognitionState: CognitionActivationStateV1 = {
      version: 1,
      workspaceRevision: 1,
      activatedTemplateIds: [],
      requiredTemplateIds: [],
    };
    const cognitionActivation: CognitionActivationResultV1 = {
      point: "task_transition",
      state: cognitionState,
      newlyActivatedTemplateIds: [],
      newlyRequiredTemplateIds: [],
    };
    const cognition: CognitionRuntimeActivationV1 = {
      phase: "WORK",
      state: cognitionState,
      activation: cognitionActivation,
      promptBlocks: { phase: "WORK", refs: [] },
      sourceRevisions: { presetRevision: 1, blockRevisions: [] },
      sourceDigest: "coordinator-settlement-test",
      workspaceRevision: 1,
    };
    const cognitionRuntime: Parameters<typeof __testing.makeWorkspace>[2] = {
      acceptCompletionFixedPoint: () => {
        throw new Error("Settlement test unexpectedly requested cognition completion");
      },
      adoptWorkspaceMutationRevision: () => {
        throw new Error("Settlement test unexpectedly adopted a non-cognition mutation");
      },
      applyWorkspaceTransition: (transition) => {
        seenTransitions.push({
          operation: transition.operation,
          operationKey: transition.reservation.operationKey,
          actor: transition.workspace.actor,
        });
        return {
          workspaceRevision: 1,
          state: cognitionState,
          activation: cognitionActivation,
          taskId: "settlement-task",
          transition: "failed",
          materializedTaskIds: [],
          cognition,
          operationKey: transition.reservation.operationKey,
          segmentId: transition.reservation.segmentId,
          logicalDispatch: transition.reservation.logicalDispatch,
          frameId: transition.reservation.frameId,
          operationDigest: "c".repeat(64),
        };
      },
    };
    try {
      const workspace = __testing.makeWorkspace(execution, {
        revision: 1,
        allowed: WORKSPACE_OPERATIONS,
        maxOperationBytes: 131_072,
        maxOperations: 128,
      }, cognitionRuntime);
      const settle = workspace.settleAssignedTask;
      if (!settle) throw new Error("Coordinator settlement capability is unavailable");
      const result = await settle({
        taskId: "settlement-task",
        frameId: "settlement-child",
        state: "failed",
        reservation: settlementReservation,
        signal: executionSignal,
      });
      expect(result).toMatchObject({ accepted: true, workspaceRevision: 1 });
      expect(seenTransitions).toEqual([{
        operation: "settle_child_failure",
        operationKey: settlementReservation.operationKey,
        actor: "host",
      }]);
    } finally {
      deps.cleanup?.({ execution } as never);
    }
  });
  test("projects a completed materialized authored task through the real phase snapshot capability", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    installAgenticGenerationCoordinator();
    const deps = __testing.buildDependencies();
    const input = {
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal" as const,
      userInput: USER_INPUT,
    };
    const target = { generationType: "normal" as const };
    const signal = new AbortController().signal;
    const decision = await deps.resolveRuntime!(input, target, signal);
    const execution = await deps.createExecution!({
      executionId: `exec-cognition-snapshot-${Date.now()}`,
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      target,
      decision,
      signal,
    });
    const runtimeExecution = execution as typeof execution & {
      readonly userId: string;
      readonly chatId: string;
      readonly workspaceId: string;
      workspaceRevision: number;
    };
    const db = getDb();
    const rootSignal = execution.signal;
    if (!rootSignal) throw new Error("Cognition snapshot execution signal was not installed");
    const capabilities = {
      revision: 1,
      allowed: WORKSPACE_OPERATIONS,
      maxOperationBytes: 131_072,
      maxOperations: 128,
    };
    const rootFrame = createAgenticRootFrame({
      frameId: execution.id,
      connectionId: null,
      model: "",
      coreToolIds: [],
      workspaceCapabilities: WORKSPACE_OPERATIONS,
      signal: rootSignal,
    });
    const currentWorkspaceRevision = (): number => {
      const row = db.query(
        "SELECT revision FROM agent_turn_workspaces WHERE workspace_id = ? AND turn_id = ? AND user_id = ? AND chat_id = ?",
      ).get(runtimeExecution.workspaceId, runtimeExecution.id, runtimeExecution.userId, runtimeExecution.chatId) as { revision: number } | null;
      if (!row) throw new Error("Cognition snapshot workspace was not persisted");
      return row.revision;
    };
    const workspaceContext = (expectedRevision: number): Record<string, unknown> => ({
      userId: runtimeExecution.userId,
      chatId: runtimeExecution.chatId,
      turnId: runtimeExecution.id,
      workspaceId: runtimeExecution.workspaceId,
      actor: "root",
      expectedRevision,
    });
    const templateId = "authored-review";
    try {
      const initialRevision = currentWorkspaceRevision();
      runtimeExecution.workspaceRevision = initialRevision;
      const cognition = createAgentCognitionRuntime({
        source: {
          graph: {
            version: 1,
            policies: {
              workPolicy: [],
              workspaceUsage: [],
              completionCriteria: [],
              renderPolicy: [],
            },
            templates: [{
              id: templateId,
              label: "Authored review",
              description: "Complete the authored review task.",
              required: false,
              dependencies: [],
              activation: { kind: "phase", value: "WORK" },
            }],
          },
          source: { presetRevision: 1, blocks: [] },
        },
        evaluation: {
          generationType: "normal",
          phase: "WORK",
          presetVariables: {},
          participantFacts: {},
          availableTools: [],
          taskTransitions: {},
        },
        workspaceRevision: initialRevision,
        workspace: workspaceContext(initialRevision),
      });
      runtimeExecution.workspaceRevision = cognition.initialActivation.workspaceRevision;
      const workActivation = cognition.enterPhase({
        phase: "WORK",
        workspace: workspaceContext(runtimeExecution.workspaceRevision),
      });
      runtimeExecution.workspaceRevision = workActivation.workspaceRevision;
      const workspace = __testing.makeWorkspace(execution, capabilities, cognition);
      const reserveMutation = (
        providerCallId: string,
        operationKind: AgenticWorkMutatingWorkspaceOperationKindV1,
        frameId: string,
      ): AgenticWorkWorkspaceMutationReservationV1 => durableWorkspaceMutationReservation({
        executionId: runtimeExecution.id,
        workspaceId: runtimeExecution.workspaceId,
        providerCallId,
        operationKind,
        frameId,
      });
      const materialized = db.query(
        `SELECT task_id, cognition_template_id, state
           FROM agent_workspace_tasks
          WHERE workspace_id = ? AND turn_id = ? AND user_id = ? AND chat_id = ?
            AND cognition_template_id = ?`,
      ).get(runtimeExecution.workspaceId, runtimeExecution.id, runtimeExecution.userId, runtimeExecution.chatId, templateId) as {
        task_id: string;
        cognition_template_id: string | null;
        state: string;
      } | null;
      expect(materialized).toEqual({
        task_id: expect.any(String),
        cognition_template_id: templateId,
        state: "active",
      });
      if (!materialized) throw new Error("Authored cognition task was not materialized");
      expect(materialized.task_id).not.toBe(templateId);

      const assignChildTasks = workspace.assignChildTasks;
      if (!assignChildTasks) throw new Error("Coordinator workspace assignment capability is unavailable");
      const childFrameId = "cognition-snapshot-child";
      const assignment = await assignChildTasks({
        frame: rootFrame,
        assignments: [{ taskId: materialized.task_id, frameId: childFrameId }],
        reservation: reserveMutation("snapshot:assign-authored-task", "assign_child_tasks", rootFrame.frameId),
        expectedRevision: runtimeExecution.workspaceRevision,
        signal: rootSignal,
      });
      expect(assignment).toMatchObject({
        accepted: true,
        assignments: [{ taskId: materialized.task_id, frameId: childFrameId }],
      });
      runtimeExecution.workspaceRevision = assignment.workspaceRevision;

      const childFrame = createAgenticChildFrame({
        frameId: childFrameId,
        parentFrameId: execution.id,
        provider: "scripted-coordinator",
        connectionId: CONNECTION_ID,
        model: "scripted-model",
        coreToolIds: [],
        taskId: materialized.task_id,
        workspaceCapabilities: ["update_assigned_progress", "submit_child_result"],
        signal: rootSignal,
      });
      const execute = workspace.execute;
      if (!execute) throw new Error("Coordinator workspace execution capability is unavailable");
      const applyCognition = workspace.applyCognitionWorkspaceTransition;
      if (!applyCognition) throw new Error("Coordinator cognition workspace capability is unavailable");
      workspace.authenticateFrame?.(childFrame);
      const childSummary = "Authored review completed with evidence.";
      let childRound = 0;
      const child = await executeBoundedAgenticChildFrame({
        frame: childFrame,
        task: "Complete the authored review task.",
        systemPrompt: "Use the assigned workspace tools and submit the result.",
        workspace,
        initialWorkspaceRevision: runtimeExecution.workspaceRevision,
        workspaceMutationReservation: ({ providerCallId, operationKind, frameId }) =>
          reserveMutation(providerCallId, operationKind, frameId),
        recordWorkspaceMutationEffect: () => {},
        countTokens: (text) => Math.ceil(text.length / 4),
        dispatch: async ({ tools }) => {
          childRound += 1;
          if (childRound === 1) {
            expect(tools.find((definition) => definition.name === "workspace_update_assigned_progress")?.parameters).toEqual({
              type: "object",
              properties: {
                state: { type: "string", enum: ["pending", "active", "blocked", "cancelled", "failed"] },
                progress: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["state"],
              additionalProperties: false,
            });
            return {
              content: "",
              finish_reason: "tool_calls",
              tool_calls: [{
                name: "workspace_update_assigned_progress",
                args: { state: "active", progress: 1 },
                call_id: "cognition-snapshot-progress",
              }],
            };
          }
          return {
            content: "",
            finish_reason: "tool_calls",
            tool_calls: [{
              name: "workspace_submit_child_result",
              args: { summary: childSummary },
              call_id: "cognition-snapshot-submit",
            }],
          };
        },
      });
      expect(child).toMatchObject({
        status: "succeeded",
        content: childSummary,
        providerRoundCount: 2,
        workspaceRevision: expect.any(Number),
      });
      expect(child.observations).toEqual([
        expect.objectContaining({ toolName: "workspace_update_assigned_progress", status: "success" }),
        expect.objectContaining({ toolName: "workspace_submit_child_result", status: "success" }),
      ]);
      expect(db.query(
        "SELECT summary, result_digest, byte_count FROM agent_workspace_submissions WHERE task_id = ? AND workspace_id = ?",
      ).get(materialized.task_id, runtimeExecution.workspaceId)).toEqual({
        summary: childSummary,
        result_digest: createHash("sha256").update(childSummary, "utf8").digest("hex"),
        byte_count: Buffer.byteLength(childSummary, "utf8") * 2,
      });
      const recordSummaries = {
        finding: "A non-cognition record must keep the runtime CAS synchronized.",
        decision: "The operation-selected record kind is authoritative.",
        question: "Can every strict record tool omit its implicit kind and digest?",
      } as const;
      await execute(
        "record_finding",
        {
          summary: recordSummaries.finding,
          taskId: null,
        },
        { actor: "root", frame: rootFrame, operation: "record_finding", reservation: reserveMutation("snapshot:record-finding", "record_finding", rootFrame.frameId), signal: rootSignal },
      );
      await execute(
        "record_decision",
        {
          summary: recordSummaries.decision,
          taskId: null,
        },
        { actor: "root", frame: rootFrame, operation: "record_decision", reservation: reserveMutation("snapshot:record-decision", "record_decision", rootFrame.frameId), signal: rootSignal },
      );
      await execute(
        "record_question",
        {
          summary: recordSummaries.question,
          taskId: null,
        },
        { actor: "root", frame: rootFrame, operation: "record_question", reservation: reserveMutation("snapshot:record-question", "record_question", rootFrame.frameId), signal: rootSignal },
      );
      expect(runtimeExecution.workspaceRevision).toBe(currentWorkspaceRevision());
      expect(db.query(
        "SELECT kind, summary, digest FROM agent_workspace_records WHERE workspace_id = ? ORDER BY created_at, kind",
      ).all(runtimeExecution.workspaceId)).toEqual(
        (["decision", "finding", "question"] as const).map((kind) => ({
          kind,
          summary: recordSummaries[kind],
          digest: createHash("sha256").update(recordSummaries[kind], "utf8").digest("hex"),
        })),
      );
      expect(db.query(
        "SELECT state FROM agent_workspace_tasks WHERE task_id = ? AND workspace_id = ?",
      ).get(materialized.task_id, runtimeExecution.workspaceId)).toEqual({ state: "completed" });

      const getPhaseEvaluationSnapshot = workspace.getPhaseEvaluationSnapshot;
      if (!getPhaseEvaluationSnapshot) throw new Error("Coordinator phase snapshot capability is unavailable");
      const snapshot = await getPhaseEvaluationSnapshot({
        phase: "COMPLETE",
        expectedRevision: runtimeExecution.workspaceRevision,
        signal: rootSignal,
      });
      expect(snapshot.taskTransitions).toEqual({ [templateId]: "completed" });
      expect(snapshot.taskTransitions).not.toHaveProperty(materialized.task_id);
      expect(evaluateCognitionPredicate(
        { kind: "task_transition", taskId: templateId, transition: "completed" },
        {
          generationType: "normal",
          phase: "WORK",
          presetVariables: {},
          participantFacts: {},
          availableTools: [],
          taskTransitions: snapshot.taskTransitions,
        },
      )).toBe(true);

      await applyCognition({
        taskId: "ad-hoc-cognition-task",
        transition: "pending",
        operation: "create_task",
        reservation: reserveMutation("ad-hoc-cognition-create", "create_task", rootFrame.frameId),
        workspace: {
          actor: "root",
          frameId: rootFrame.frameId,
          taskId: "ad-hoc-cognition-task",
          title: "Ad-hoc task",
          objective: "Keep arbitrary host task identity stable.",
          dependencyIds: [],
        },
        signal: rootSignal,
      });
      const withAdHoc = await getPhaseEvaluationSnapshot({
        phase: "COMPLETE",
        expectedRevision: runtimeExecution.workspaceRevision,
        signal: rootSignal,
      });
      expect(withAdHoc.taskTransitions).toHaveProperty(templateId, "completed");
      expect(withAdHoc.taskTransitions).toHaveProperty("ad-hoc-cognition-task");
      expect(withAdHoc.taskTransitions).not.toHaveProperty(materialized.task_id);

      await execute(
        "create_task",
        {
          taskId: templateId,
          title: "Conflicting ad-hoc task",
          objective: "This authored identity must fail closed when duplicated.",
          dependencyIds: [],
        },
        { actor: "root", frame: rootFrame, operation: "create_task", reservation: reserveMutation("snapshot:conflicting-authored-task", "create_task", rootFrame.frameId), signal: rootSignal },
      );
      runtimeExecution.workspaceRevision = currentWorkspaceRevision();
      await expect(getPhaseEvaluationSnapshot({
        phase: "COMPLETE",
        expectedRevision: runtimeExecution.workspaceRevision,
        signal: rootSignal,
      })).rejects.toMatchObject({ code: "invalid_state" });
    } finally {
      deps.cleanup?.({ execution } as never);
    }
  });
});
describe("coordinator blocked terminal completion seam", () => {
  test("keeps a blocked terminal phase entered until its pending submission is accepted", async () => {
    markAgenticRuntimeReady();
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    await probeIsolateBackendsAtStartup();
    startAgentRuntimeEpoch();
    installAgenticGenerationCoordinator();
    scriptedBlockedTerminal = true;
    scriptedBlockedTerminalTurnId = "";
    scriptedBlockedTerminalTaskCreated = false;
    scriptedBlockedTerminalDelegateIssued = false;
    scriptedBlockedTerminalChildSubmitted = false;
    scriptedBlockedTerminalAttempted = false;
    scriptedBlockedTerminalAcceptanceIssued = false;
    scriptedBlockedTerminalRetryCanAccept = false;
    scriptedBlockedTerminalSnapshots.length = 0;
    providerRequests.length = 0;

    const phaseDefinitions: AgentCustomPhaseV1[] = [
      {
        version: 1,
        id: "blocked_terminal_first",
        label: "Blocked terminal first phase",
        instructionRefs: [],
        childInstructionSubsets: [],
        required: true,
        enter: { kind: "phase", value: "WORK" },
        exit: { kind: "phase", value: "COMPLETE" },
        capabilityRequests: [],
        repeatLimit: 0,
        nextPhaseIds: ["blocked_terminal_last"],
      },
      {
        version: 1,
        id: "blocked_terminal_last",
        label: "Blocked terminal last phase",
        instructionRefs: [],
        childInstructionSubsets: [],
        required: true,
        enter: { kind: "phase", value: "WORK" },
        exit: { kind: "phase", value: "COMPLETE" },
        capabilityRequests: ["workspace_write", "delegation"],
        repeatLimit: 0,
        nextPhaseIds: [],
      },
    ];
    const authoredPhasePlan = compileAgentRuntimePhases(phaseDefinitions);
    expect(authoredPhasePlan.status).toBe("ready");
    const runtimePolicy = {
      version: 1,
      authority: "loom",
      scope: "preset",
      defaultMode: "agentic",
      loomPolicy: null,
      phases: phaseDefinitions,
    };
    const db = getDb();
    const originalConfig = db.query(
      "SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, AGENTIC_PRESET_ID) as { config_json: string };
    const originalProfiles = db.query(
      "SELECT profile_id, workspace_capabilities, max_output_tokens FROM preset_agent_profiles WHERE user_id = ? AND preset_id = ? AND profile_id IN ('delegate', 'delegate_alt') ORDER BY profile_id",
    ).all(USER_ID, AGENTIC_PRESET_ID) as Array<{
      profile_id: string;
      workspace_capabilities: string;
      max_output_tokens: number;
    }>;

    let scheduledOwnerRenewals = 0;
    let clearedOwnerRenewals = 0;
    const deps = __testing.buildDependencies({
      timeoutScheduler: {
        setTimeout() { scheduledOwnerRenewals += 1; return scheduledOwnerRenewals; },
        clearTimeout() { clearedOwnerRenewals += 1; },
      } as never,
    });
    const input = {
      userId: USER_ID,
      chatId: AGENTIC_CHAT_ID,
      connectionId: CONNECTION_ID,
      presetId: AGENTIC_PRESET_ID,
      generationType: "normal" as const,
      userInput: USER_INPUT,
      parameters: { max_tokens: 1024 },
    };
    const target = { generationType: "normal" as const };
    const signal = new AbortController().signal;
    const executionId = `exec-blocked-terminal-${Date.now()}`;
    try {
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(JSON.stringify({ config: { runtimePolicy } }), USER_ID, AGENTIC_PRESET_ID);
      db.query(
        "UPDATE preset_agent_profiles SET workspace_capabilities = ?, max_output_tokens = 1024 WHERE user_id = ? AND preset_id = ? AND profile_id IN ('delegate', 'delegate_alt')",
      ).run(JSON.stringify(["update_assigned_progress", "submit_child_result"]), USER_ID, AGENTIC_PRESET_ID);

      const decision = await deps.resolveRuntime!(input, target, signal);
      const snapshot = await deps.buildAssemblySnapshot!(input, decision, target, signal, executionId);
      const plan = await deps.compileAssemblyPlan!(snapshot, input, decision, signal, executionId);
      let execution = await deps.createExecution!({
        executionId,
        userId: USER_ID,
        chatId: AGENTIC_CHAT_ID,
        target,
        decision,
        signal,
      });

      execution = (await deps.transitionExecution!(execution, "ASSEMBLE", "WORK"))!;
      scriptedBlockedTerminalTurnId = execution.id;
      try {
        const work = await deps.runWork!({
          execution,
          input,
          decision,
          snapshot,
          plan,
          signal,
        });
        expect(scheduledOwnerRenewals).toBeGreaterThan(0);
        expect(clearedOwnerRenewals).toBeGreaterThan(0);
        expect(work).toMatchObject({ status: "completed" });
        expect(scriptedBlockedTerminalRetryCanAccept).toBe(true);
        expect(scriptedBlockedTerminalSnapshots).toEqual([{
          workspaceState: "active",
          workspaceRevision: expect.any(Number),
          frozenAt: null,
          taskState: "completed",
          submissionState: "submitted",
        }]);
        const blockedSnapshot = scriptedBlockedTerminalSnapshots[0];
        if (!blockedSnapshot) throw new Error("Blocked terminal snapshot was not captured");
        expect(blockedSnapshot.workspaceRevision).toBeGreaterThan(0);

        const workspace = db.query(
          "SELECT state, revision, frozen_at FROM agent_turn_workspaces WHERE workspace_id = ? AND user_id = ? AND chat_id = ? AND turn_id = ?",
        ).get(`workspace:${execution.id}`, USER_ID, AGENTIC_CHAT_ID, execution.id) as {
          state: string;
          revision: number;
          frozen_at: number | null;
        } | null;
        expect(workspace?.state).toBe("frozen");
        expect(workspace?.frozen_at).not.toBeNull();
        expect(workspace?.revision).toBeGreaterThan(blockedSnapshot.workspaceRevision);

        const task = db.query(
          "SELECT task_id, state FROM agent_workspace_tasks WHERE workspace_id = ? AND turn_id = ? AND task_id = ?",
        ).get(`workspace:${execution.id}`, execution.id, "blocked-terminal-task") as {
          task_id: string;
          state: string;
        } | null;
        expect(task).toEqual({ task_id: "blocked-terminal-task", state: "completed" });

        const submission = db.query(
          "SELECT state FROM agent_workspace_submissions WHERE workspace_id = ? AND turn_id = ? AND task_id = ?",
        ).get(`workspace:${execution.id}`, execution.id, "blocked-terminal-task") as { state: string } | null;
        expect(submission).toEqual({ state: "accepted" });

        const completions = (work.observations ?? []).filter((observation) => observation.toolName === "complete_turn");
        expect(completions).toHaveLength(3);
        expect(completions.map((observation) => observation.status)).toEqual(["success", "rejected", "accepted"]);
        expect(completions[1]?.code).toBe("completion_blocked");
      } finally {
        deps.cleanup!({ execution } as never);
      }
    } finally {
      db.query(
        "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
      ).run(originalConfig.config_json, USER_ID, AGENTIC_PRESET_ID);
      for (const profile of originalProfiles) {
        db.query(
          "UPDATE preset_agent_profiles SET workspace_capabilities = ?, max_output_tokens = ? WHERE user_id = ? AND preset_id = ? AND profile_id = ?",
        ).run(
          profile.workspace_capabilities,
          profile.max_output_tokens,
          USER_ID,
          AGENTIC_PRESET_ID,
          profile.profile_id,
        );
      }
      scriptedBlockedTerminal = false;
      scriptedBlockedTerminalTurnId = "";
      scriptedBlockedTerminalTaskCreated = false;
      scriptedBlockedTerminalDelegateIssued = false;
      scriptedBlockedTerminalChildSubmitted = false;
      scriptedBlockedTerminalAttempted = false;
      scriptedBlockedTerminalAcceptanceIssued = false;
      scriptedBlockedTerminalRetryCanAccept = false;
      scriptedBlockedTerminalSnapshots.length = 0;
      providerRequests.length = 0;
    }
  });
});


describe("restart credential revision authority", () => {
  test("fails closed when an admitted credential revision resolves missing or empty", async () => {
    const connection = {
      logicalId: "restart-secret-logical",
      concreteId: "restart-secret-concrete",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      endpoint: "https://example.invalid/v1",
      endpointRevision: "endpoint-1",
      credentialSecretRef: "restart-secret-ref",
      credentialRevision: "credential-1",
      candidateRevision: "candidate-1",
      revision: "connection-1",
      fingerprint: "fingerprint-1",
      capabilityDigest: "capability-1",
      capabilities: {},
    } as unknown as FrozenConcreteConnectionV1;
    const secret = spyOn(secretsSvc, "getSecretAtRevision");
    try {
      secret.mockResolvedValueOnce(null);
      await expect(__testing.freezeConnectionCredentials(USER_ID, [connection])).rejects.toMatchObject({
        code: "decision_refresh_required",
      });
      secret.mockResolvedValueOnce("");
      await expect(__testing.freezeConnectionCredentials(USER_ID, [connection])).rejects.toMatchObject({
        code: "decision_refresh_required",
      });
    } finally {
      secret.mockRestore();
    }
  });
});

describe("serialized lease heartbeat", () => {
  test("runs repeated renewal ticks serially, joins a final renewal, and retains failure", async () => {
    const callbacks: Array<() => void> = [];
    const scheduler = {
      setTimeout(callback: () => void) {
        callbacks.push(callback);
        return callbacks.length;
      },
      clearTimeout() {},
    };
    const waitForReschedule = async (): Promise<void> => {
      for (let attempt = 0; attempt < 20 && callbacks.length === 0; attempt += 1) {
        await Promise.resolve();
      }
    };
    const first = Promise.withResolvers<void>();
    let active = 0;
    let maxActive = 0;
    let ticks = 0;
    const heartbeat = __testing.startSerializedLeaseHeartbeatV1(async () => {
      ticks += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (ticks === 1) await first.promise;
      active -= 1;
    }, () => {}, scheduler as never);

    expect(callbacks).toHaveLength(1);
    callbacks.shift()!();
    await Promise.resolve();
    expect(ticks).toBe(1);
    expect(callbacks).toHaveLength(0);
    first.resolve();
    await first.promise;
    await waitForReschedule();
    expect(callbacks).toHaveLength(1);
    callbacks.shift()!();
    await waitForReschedule();
    expect(ticks).toBe(2);
    expect(callbacks).toHaveLength(1);
    await heartbeat.renewAndStop();
    expect(ticks).toBe(3);
    expect(maxActive).toBe(1);
    expect(active).toBe(0);

    const failure = new Error("renewal failed");
    const failedCallbacks: Array<() => void> = [];
    const failures: unknown[] = [];
    const failedHeartbeat = __testing.startSerializedLeaseHeartbeatV1(() => {
      throw failure;
    }, (error) => failures.push(error), {
      setTimeout(callback: () => void) { failedCallbacks.push(callback); return failedCallbacks.length; },
      clearTimeout() {},
    } as never);
    failedCallbacks.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(await failedHeartbeat.stop()).toBe(failure);
    expect(failures).toEqual([failure]);
    expect(failedCallbacks).toHaveLength(0);
  });

  test("prepares under renewal, stops after a final tick, then dereferences the exact terminal write", async () => {
    const events: string[] = [];
    let terminalWrite = (): void => { events.push("stale-noop"); };
    const heartbeat = {
      async stop() { events.push("stopped-without-renewal"); return null; },
      async renewAndStop() { events.push("final-renewal-joined"); return null; },
    };
    await __testing.finalizeUnderOwnerLeaseV1(heartbeat, () => false, async () => {
      events.push("prepared");
      terminalWrite = () => { events.push("terminal-row-written"); };
    }, () => terminalWrite());
    expect(events).toEqual(["prepared", "final-renewal-joined", "terminal-row-written"]);

    let lostAuthority = false;
    await expect(__testing.finalizeUnderOwnerLeaseV1(heartbeat, () => lostAuthority, async () => {
      lostAuthority = true;
    }, () => { throw new Error("must not write"); })).rejects.toMatchObject({ code: "recovery_unavailable" });
    let wroteAfterFailedRenewal = false;
    const renewalFailure = new Error("final renewal lost authority");
    await expect(__testing.finalizeUnderOwnerLeaseV1({
      async stop() { return renewalFailure; },
      async renewAndStop() { return renewalFailure; },
    }, () => false, async () => {}, () => { wroteAfterFailedRenewal = true; })).rejects.toMatchObject({
      code: "recovery_unavailable",
    });
    expect(wroteAfterFailedRenewal).toBe(false);
  });

  for (const outcome of ["cancelled", "failed"] as const) {
    test(`recovered admitted pre-dispatch ${outcome} close hands generic renewal to the exact Segment fence`, async () => {
      const events: string[] = [];
      const genericHeartbeat = {
        async stop() { events.push("generic-joined"); return null; },
        async renewAndStop() {
          events.push("generic-terminal-renewal");
          return new Error("generic heartbeat must not terminalize an admitted Segment");
        },
      };
      const segmentHeartbeat = {
        async stop() { events.push("segment-stopped"); return null; },
        async renewAndStop() { events.push("segment-final-renewal"); return null; },
      };
      const selected = await __testing.selectTerminalOwnerHeartbeatV1(
        true,
        null,
        genericHeartbeat,
        async () => {
          events.push("segment-fenced-renewal");
          events.push("segment-cadence-armed");
          const genericFailure = await genericHeartbeat.stop();
          if (genericFailure !== null) throw genericFailure;
          return segmentHeartbeat;
        },
      );
      await __testing.finalizeUnderOwnerLeaseV1(selected, () => false, async () => {
        events.push(`${outcome}-prepared`);
      }, () => { events.push(`${outcome}-terminal-row`); });
      await selected?.stop();

      expect(events).toEqual([
        "segment-fenced-renewal",
        "segment-cadence-armed",
        "generic-joined",
        `${outcome}-prepared`,
        "segment-final-renewal",
        `${outcome}-terminal-row`,
        "segment-stopped",
      ]);
    });
  }

  test("a genuinely no-Segment close may retain the generic owner heartbeat", async () => {
    let attemptedSegmentHandoff = false;
    const genericHeartbeat = {
      async stop() { return null; },
      async renewAndStop() { return null; },
    };
    const selected = await __testing.selectTerminalOwnerHeartbeatV1(
      false,
      null,
      genericHeartbeat,
      async () => {
        attemptedSegmentHandoff = true;
        throw new Error("no Segment exists");
      },
    );
    expect(selected).toBe(genericHeartbeat);
    expect(attemptedSegmentHandoff).toBe(false);
  });

  for (const failurePoint of ["normal credential setup", "resumed validation"] as const) {
    test(`releases the pre-Segment timer and registry when ${failurePoint} throws before guaranteed close`, async () => {
      let nextTimer = 0;
      const activeTimers = new Set<number>();
      const heartbeat = __testing.startSerializedLeaseHeartbeatV1(
        () => {},
        () => {},
        {
          setTimeout() {
            nextTimer += 1;
            activeTimers.add(nextTimer);
            return nextTimer;
          },
          clearTimeout(handle: number) { activeTimers.delete(handle); },
        } as never,
      );
      const registry = new Map();
      const registrySizes: number[] = [];
      const ownership = await __testing.createPreSegmentHeartbeatOwnershipV1(
        registry,
        `execution:${failurePoint}`,
        heartbeat,
        (size) => registrySizes.push(size),
      );
      expect(activeTimers.size).toBe(1);
      expect(registry.size).toBe(1);

      await expect(ownership.run(async () => {
        throw new Error(failurePoint);
      })).rejects.toThrow(failurePoint);

      expect(activeTimers.size).toBe(0);
      expect(registry.size).toBe(0);
      expect(registrySizes).toEqual([1, 0]);
    });
  }
  test("stops a duplicate pre-Segment heartbeat before rejecting ownership", async () => {
    let nextTimer = 0;
    let renewals = 0;
    const activeTimers = new Map<number, () => void>();
    const scheduler = {
      setTimeout(callback: () => void) {
        nextTimer += 1;
        activeTimers.set(nextTimer, callback);
        return nextTimer;
      },
      clearTimeout(handle: number) { activeTimers.delete(handle); },
    };
    const registry = new Map();
    const firstHeartbeat = __testing.startSerializedLeaseHeartbeatV1(
      () => { renewals += 1; },
      () => {},
      scheduler as never,
    );
    const firstOwnership = await __testing.createPreSegmentHeartbeatOwnershipV1(
      registry,
      "execution:duplicate",
      firstHeartbeat,
    );
    const duplicateHeartbeat = __testing.startSerializedLeaseHeartbeatV1(
      () => { renewals += 1; },
      () => {},
      scheduler as never,
    );

    expect(activeTimers.size).toBe(2);
    await expect(__testing.createPreSegmentHeartbeatOwnershipV1(
      registry,
      "execution:duplicate",
      duplicateHeartbeat,
    )).rejects.toMatchObject({ code: "recovery_unavailable" });
    expect(activeTimers.size).toBe(1);
    expect(registry.get("execution:duplicate")).toBe(firstHeartbeat);
    expect(renewals).toBe(0);

    await firstOwnership.run(async () => {});
    expect(activeTimers.size).toBe(0);
    expect(registry.size).toBe(0);
    expect(renewals).toBe(0);
  });
});

describe("final authoritative segment input bound", () => {
  test("accepts the recovered host reconstruction at the exact cap and rejects it one byte over", () => {
    const phaseControl = Object.freeze({
      role: "system" as const,
      content: JSON.stringify({
        kind: "host_private_phase_control_v1",
        currentPhaseId: "review",
        admittedRootToolNames: ["workspace_read"],
        openRequiredTaskIds: ["recover-task"],
        completeTurn: { callMode: "standalone_only" },
      }),
    });
    const context = {
      rootObjective: "Recover and finish the durable objective",
      contextDigest: "recovered-context-digest",
      phase: { id: "review", index: 1, occurrence: 2, instructions: ["Review recovered durable work."] },
      workspace: {
        workspaceId: "workspace:recovered",
        revision: 19,
        acceptedRecords: [{ taskId: "recover-task", output: "x".repeat(8_192) }],
      },
      previousHandoff: { summary: "Recovered after restart", unresolvedIds: ["recover-task"] },
      protocol: { version: 1, recovery: true },
    };
    const authority = {
      occurrenceMessages: [{ role: "system" as const, content: "Recovered occurrence authority" }],
      phaseControlMessage: phaseControl,
      recovery: true,
    };
    const projected = __testing.boundFinalSegmentProviderInputV1(
      context as never,
      authority as never,
      undefined,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const exactBytes = new TextEncoder().encode(JSON.stringify({ messages: projected.messages })).byteLength;

    const exact = __testing.boundFinalSegmentProviderInputV1(
      context as never,
      authority as never,
      undefined,
      0,
      exactBytes,
    );
    expect(exact.messages.filter((message) => message.content === phaseControl.content)).toHaveLength(1);
    let overCapError: unknown;
    try {
      __testing.boundFinalSegmentProviderInputV1(
        context as never,
        authority as never,
        undefined,
        0,
        exactBytes - 1,
      );
    } catch (error) {
      overCapError = error;
    }
    expect(overCapError).toMatchObject({ code: "limit_exceeded" });
  });
});