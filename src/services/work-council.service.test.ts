import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { CouncilSettings, SidecarConfig } from "lumiverse-spindle-types";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import type { LlmMessage } from "../llm/types";
import * as generateService from "./generate.service";
import { createConnection } from "./connections.service";
import {
  executeCouncilForWork,
  WorkCouncilAdmissionError,
  type WorkCouncilExecutionInput,
} from "./council/council-execution.service";
import type { RuntimeCouncilToolDefinition } from "./council/tool-runtime";
import {
  createWorkCouncilCapability,
  executeWorkCouncil,
  type WorkCouncilAdmission,
} from "./work-council.service";
import type { AgentInspectionCorrelationV1 } from "../types/agent-run-projection";

const USER_ID = "work-council-owner";
const CHAT_ID = "work-council-chat";
const CORRELATION: AgentInspectionCorrelationV1 = {
  turnSessionId: "turn-1",
  runId: "run-1",
  attemptId: "attempt-1",
  chatId: CHAT_ID,
  generationId: "generation-1",
  messageId: null,
  swipeId: null,
  actorId: null,
  recipientId: null,
  phase: "WORK",
  taskId: null,
  toolId: null,
  parentId: null,
  hostCorrelationId: "host-1",
  hostSequence: 1,
};

interface RestorableSpy {
  mockRestore(): void;
}

interface CapturedCouncilRequest {
  readonly messages: readonly LlmMessage[];
  readonly tools?: unknown;
  readonly tool_choice?: unknown;
}

let rawGenerateSpy: RestorableSpy | null = null;

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  await runMigrations(getDb());
  getDb().query(
    'INSERT INTO "user" (id, name, email, emailVerified) VALUES (?, ?, ?, 1)',
  ).run(USER_ID, "WORK Council Owner", `${USER_ID}@example.test`);
});

afterEach(() => {
  rawGenerateSpy?.mockRestore();
  rawGenerateSpy = null;
  closeDatabase();
});

function settings(toolNames: readonly string[] = ["advice"]): CouncilSettings {
  return {
    councilMode: true,
    members: [{
      id: "member-1",
      packId: "pack-1",
      packName: "Reviewed Pack",
      itemId: "item-1",
      itemName: "Analyst",
      tools: [...toolNames],
      role: "quality analyst",
      chance: 100,
    }],
    toolsSettings: {
      mode: "sidecar",
      timeoutMs: 30_000,
      sidecarContextWindow: 8,
      excludeLatestUserMessage: false,
      includeUserPersona: false,
      includeCharacterInfo: false,
      includeWorldInfo: false,
      allowUserControl: false,
      maxWordsPerTool: 128,
    },
  };
}

function sidecarSettings(connectionProfileId = "missing-council-profile"): SidecarConfig {
  return {
    connectionProfileId,
    model: "council-model",
    temperature: 0.2,
    topP: 0.9,
    maxTokens: 128,
  };
}

function tool(name = "advice"): RuntimeCouncilToolDefinition {
  return {
    name,
    displayName: "Advisory note",
    description: "Review the bounded WORK context.",
    category: "context",
    execution: "llm",
    prompt: "Return one concise advisory note.",
  };
}

function admission(overrides: Partial<WorkCouncilAdmission> = {}): WorkCouncilAdmission {
  return {
    userId: USER_ID,
    chatId: CHAT_ID,
    requestId: "council-request-1",
    required: false,
    settings: settings(),
    sidecarSettings: sidecarSettings(),
    toolDefinitions: [tool()],
    correlation: CORRELATION,
    ...overrides,
  };
}

function invocation(signal = new AbortController().signal, messages: readonly LlmMessage[] = [
  { role: "user", content: "Use this bounded context only." },
]): { parentFrameId: string; messages: readonly LlmMessage[]; signal: AbortSignal } {
  return { parentFrameId: "root-work-frame", messages, signal };
}

async function createConnectionFixture(): Promise<string> {
  const connection = await createConnection(USER_ID, {
    name: "WORK Council provider",
    provider: "work-council-test-provider",
    model: "council-model",
    is_default: false,
  });
  return connection.id;
}

function directInput(
  connectionProfileId: string,
  definitions: readonly RuntimeCouncilToolDefinition[] = [tool()],
  contextMessages: readonly LlmMessage[] = [{ role: "user", content: "Bounded context" }],
): WorkCouncilExecutionInput {
  return {
    userId: USER_ID,
    chatId: CHAT_ID,
    settings: settings(definitions.map((definition) => definition.name)),
    sidecarSettings: sidecarSettings(connectionProfileId),
    toolDefinitions: definitions,
    contextMessages,
    connectionRevision: 7,
    signal: new AbortController().signal,
  };
}

describe("WORK Council adapter boundaries", () => {
  test("executes one bounded prompt-only advisory without inherited tool authority", async () => {
    const connectionId = await createConnectionFixture();
    const calls: CapturedCouncilRequest[] = [];
    rawGenerateSpy = spyOn(generateService, "rawGenerate").mockImplementation(async (_userId, input) => {
      calls.push(input as CapturedCouncilRequest);
      return {
        content: "Keep the root response focused.",
        finish_reason: "stop",
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      };
    });

    const contextMessages: LlmMessage[] = [{ role: "user", content: "Do not publish or commit anything." }];
    const result = await executeCouncilForWork(directInput(connectionId, [tool()], contextMessages));

    expect(result).not.toBeNull();
    if (!result) throw new Error("expected WORK Council advice");
    expect(result).toMatchObject({
      memberCount: 1,
      provider: {
        provider: "work-council-test-provider",
        model: "council-model",
        connectionId,
        connectionRevision: 7,
      },
      usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7, requests: 1 },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tools).toBeUndefined();
    expect(calls[0]?.tool_choice).toBeUndefined();
    expect(calls[0]?.messages[0]?.role).toBe("system");
    expect(calls[0]?.messages[0]?.content).toContain("Do not answer the user, continue the story, use tools, delegate, write, publish, commit");
    expect(result.deliberationBlock).toContain("WORK Council Advisory");
  });

  test("rejects reviewed definitions that could render, write, delegate, publish, or commit", async () => {
    const connectionId = await createConnectionFixture();
    const forbidden = [
      "complete_turn",
      "agent_delegate",
      "agent_execute",
      "workspace_write",
      "render",
      "render_turn",
      "prepare_commit",
      "commit",
      "commit_turn",
      "publish",
      "publication",
    ];

    for (const name of forbidden) {
      const candidate = tool(name);
      try {
        await executeCouncilForWork(directInput(connectionId, [candidate]));
        throw new Error(`expected WORK Council tool ${name} to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(WorkCouncilAdmissionError);
        expect(error).toMatchObject({ code: "unauthorized" });
      }
    }
  });

  test("rejects non-LLM reviewed definitions before any provider request", async () => {
    const connectionId = await createConnectionFixture();
    const candidate = { ...tool("host-note"), execution: "host" as const };
    await expect(executeCouncilForWork(directInput(connectionId, [candidate]))).rejects.toMatchObject({
      name: "WorkCouncilAdmissionError",
      code: "unauthorized",
    });
  });
});

describe("WORK Council terminal receipts", () => {
  test("returns accepted advice and provider usage through the reviewed capability", async () => {
    const connectionId = await createConnectionFixture();
    rawGenerateSpy = spyOn(generateService, "rawGenerate").mockImplementation(async (_userId, _input) => ({
      content: "Capability advice",
      finish_reason: "stop",
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    }));

    const result = await createWorkCouncilCapability(admission({
      sidecarSettings: sidecarSettings(connectionId),
    })).invoke(invocation());

    expect(result).toMatchObject({
      advice: expect.stringContaining("Capability advice"),
      receipt: {
        state: "accepted",
        reason: "none",
        required: false,
        memberCount: 1,
        canonical: false,
      },
      usageEvidence: [{
        source: "provider_reported",
        layer: "council",
        totalTokens: 7,
      }],
      markers: [],
    });
    expect(result.receipt.resultDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.transcript.some((record) => record.kind === "provider_exchange" && record.recipient === "provider")).toBe(true);
  });

  test("cascades parent cancellation and emits a typed non-canonical terminal receipt", async () => {
    const controller = new AbortController();
    controller.abort("parent cancelled");
    const startedAt = Date.now();
    const capability = createWorkCouncilCapability(admission());
    expect(Object.keys(capability)).toEqual([
      "required",
      "provider",
      "connectionLabel",
      "model",
      "invoke",
    ]);
    expect(capability).toMatchObject({
      required: false,
      provider: null,
      connectionLabel: null,
      model: null,
    });
    expect(typeof capability.invoke).toBe("function");
    expect(Object.keys(capability)).not.toEqual(expect.arrayContaining([
      "tools",
      "write",
      "publish",
      "commit",
      "delegate",
    ]));
    const result = await capability.invoke(invocation(controller.signal));

    expect(result.advice).toBeNull();
    expect(result.receipt).toMatchObject({
      version: 1,
      requestId: "council-request-1",
      checkpoint: "WORK",
      required: false,
      state: "cancelled",
      memberCount: 0,
      resultDigest: null,
      reason: "user_stop",
      canonical: false,
      correlation: { phase: "WORK", parentId: "root-work-frame" },
    });
    expect(result.receipt.startedAt).toBeGreaterThanOrEqual(startedAt);
    expect(result.receipt.completedAt).toBeGreaterThanOrEqual(result.receipt.startedAt);
    expect(result.transcript.at(-1)).toMatchObject({
      kind: "terminal",
      actor: "council",
      recipient: "host",
      correlation: { parentId: "root-work-frame", phase: "WORK" },
    });
    expect(result.markers[0]).toMatchObject({ kind: "unavailable", scope: "council", recoverable: true });
  });

  test("distinguishes optional omission from required failure when the provider is unavailable", async () => {
    const optional = await executeWorkCouncil(admission({ required: false }), invocation());
    expect(optional.receipt).toMatchObject({ state: "omitted", required: false, reason: "unavailable", canonical: false });
    expect(optional.markers[0]).toMatchObject({ kind: "unavailable", scope: "council", recoverable: true });
    expect(optional.advice).toBeNull();

    const required = await executeWorkCouncil(admission({ required: true }), invocation());
    expect(required.receipt).toMatchObject({ state: "failed", required: true, reason: "unavailable", canonical: false });
    expect(required.markers[0]).toMatchObject({ kind: "unavailable", scope: "council", recoverable: false });
    expect(required.advice).toBeNull();
  });
});
