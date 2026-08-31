import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  HOST_PREPARATION_LIMITS_V1,
  type RenderPreparationInputV1,
} from "../types/agent-preprocessing";
import {
  assertPairedAssemblyResultsV1,
  PairedAssemblyAdmissionV1,
  parseAgenticPreprocessingResponseV1,
} from "./agentic-preprocessing-worker-client";
import type { AssemblyPlanV1 as CompilerAssemblyPlanV1 } from "./agentic-assembly-compiler";
import { IsolatePoolError, type ActiveIsolateJob } from "./isolate-pool";

const revisions = {
  version: 1 as const,
  revisions: [],
  digest: "frozen-inputs",
};

function makeInput(maxOutputBytes: number): RenderPreparationInputV1 {
  return {
    version: 1,
    operation: "prepare_agent_render",
    requestId: "caller-request",
    limits: { ...HOST_PREPARATION_LIMITS_V1, maxOutputBytes },
    turnId: "turn-1",
    target: { kind: "normal" },
    content: { kind: "text", text: "input" },
    sourceMessages: [],
    swipes: [],
    macroSnapshot: {
      local: [],
      global: [],
      chat: [],
      promptVariables: [],
    },
    regexScripts: [],
    formatting: {
      stripGuidedReasoning: true,
      healFormatting: true,
      preserveProviderReasoning: true,
    },
    inputRevisions: revisions,
    deltas: [],
  };
}

function makeJob(input: RenderPreparationInputV1): ActiveIsolateJob<unknown, unknown> {
  return {
    userId: "user-1",
    operation: "prepare_agent_render",
    payload: input,
    requestId: "job-request",
    timeoutMs: 60_000,
    deadlineAt: Date.now() + 60_000,
    resolve: () => undefined,
    reject: () => undefined,
    settled: false,
  };
}

function makeResponse(input: RenderPreparationInputV1, requestId: string, content: string): Record<string, unknown> {
  return {
    version: 1,
    type: "result",
    requestId,
    result: {
      version: 1,
      operation: "prepare_agent_render",
      requestId,
      content: { kind: "text", text: content },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      macroVariableDeltas: [],
      sourceMessageDeltas: [],
      chatMetadataDeltas: [{
        kind: "chat_metadata",
        key: "generated_message",
        operation: "set",
        value: content,
      }],
      regexActionDeltas: [],
      worldInfoStateDeltas: [],
      inputRevisions: input.inputRevisions,
    },
  };
}

async function expectMalformed(run: () => unknown): Promise<void> {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(IsolatePoolError);
  expect((failure as IsolatePoolError).code).toBe("worker_malformed");
}

describe("agentic preprocessing worker render response validation", () => {
  test("accepts output exactly at the trusted UTF-8 cap", async () => {
    const input = makeInput(4);
    const job = makeJob(input);
    const response = makeResponse(input, job.requestId, "😀");

    expect(await parseAgenticPreprocessingResponseV1(response, job)).toEqual(response.result);
  });

  test("rejects forged output at cap plus one byte", async () => {
    const input = makeInput(4);
    const job = makeJob(input);
    await expectMalformed(() => parseAgenticPreprocessingResponseV1(makeResponse(input, job.requestId, "😀a"), job));
  });

  test("rejects unknown result fields before accepting expanded DTOs", async () => {
    const input = makeInput(4);
    const job = makeJob(input);
    const response = makeResponse(input, job.requestId, "😀");
    const result = response.result as Record<string, unknown>;
    result.forgedField = "unexpected";
    await expectMalformed(() => parseAgenticPreprocessingResponseV1(response, job));
  });
  test("rejects forged revision and target bindings", async () => {
    const input = makeInput(4);
    const job = makeJob(input);
    const revisionResponse = makeResponse(input, job.requestId, "😀");
    (revisionResponse.result as Record<string, unknown>).inputRevisions = {
      ...input.inputRevisions,
      digest: "forged",
    };
    await expectMalformed(() => parseAgenticPreprocessingResponseV1(revisionResponse, job));

    const targetResponse = makeResponse(input, job.requestId, "😀");
    const metadata = (targetResponse.result as Record<string, unknown>).chatMetadataDeltas as Array<Record<string, unknown>>;
    metadata[0]!.key = "message:forged:continue";
    await expectMalformed(() => parseAgenticPreprocessingResponseV1(targetResponse, job));
  });
  test("accepts a caller request id distinct from the wire id but rejects forged wire ids", async () => {
    const input = makeInput(4);
    const job = makeJob(input);
    expect(await parseAgenticPreprocessingResponseV1(makeResponse(input, job.requestId, "😀"), job)).toBeTruthy();
    await expectMalformed(() => parseAgenticPreprocessingResponseV1(makeResponse(input, "forged-wire-id", "😀"), job));
  });

  test("accepts an append-swipe target without an existing revision", async () => {
    const input: RenderPreparationInputV1 = {
      ...makeInput(HOST_PREPARATION_LIMITS_V1.maxOutputBytes),
      target: { kind: "swipe", messageId: "msg-1", swipeId: 1 },
      swipes: [{
        swipeId: "1",
        index: 1,
        revision: 1,
        slot: "append",
        content: { kind: "text", text: "" },
      }],
    };
    const job = makeJob(input);
    const response = makeResponse(input, job.requestId, "accepted");
    const metadata = (response.result as Record<string, unknown>).chatMetadataDeltas as Array<Record<string, unknown>>;
    metadata[0] = {
      kind: "chat_metadata",
      key: "message:msg-1:swipe:1",
      operation: "set",
      value: "accepted",
    };

    expect(await parseAgenticPreprocessingResponseV1(response, job)).toEqual(response.result);
  });

  test("revalidates a 132KB regenerate request after the worker returns", async () => {
    const sourceMessages = Array.from({ length: 129 }, (_value, index) => ({
      sourceMessageId: `msg-${index}`,
      revision: index + 1,
      role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: { kind: "text" as const, text: "n".repeat(1024) },
    }));
    const revisions = sourceMessages.map((message) => ({
      kind: "message" as const,
      id: message.sourceMessageId,
      revision: message.revision,
      digest: `digest-${message.sourceMessageId}`,
    }));
    const input: RenderPreparationInputV1 = {
      ...makeInput(HOST_PREPARATION_LIMITS_V1.maxOutputBytes),
      target: { kind: "regenerate", messageId: "msg-0", swipeId: 0 },
      sourceMessages,
      swipes: [{
        swipeId: "0",
        index: 0,
        revision: 1,
        content: { kind: "text", text: "prior" },
      }],
      inputRevisions: {
        version: 1,
        revisions,
        digest: "regenerate-inputs",
      },
    };
    const job = makeJob(input);
    const response = makeResponse(input, job.requestId, "ok");
    const metadata = (response.result as Record<string, unknown>).chatMetadataDeltas as Array<Record<string, unknown>>;
    metadata[0] = {
      kind: "chat_metadata",
      key: "message:msg-0:swipe:0",
      operation: "set",
      value: "ok",
      expectedRevision: 1,
    };
    const started = Date.now();
    expect(await parseAgenticPreprocessingResponseV1(response, job)).toEqual(response.result);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

test("prepares the captured render shape in a terminable smol process", async () => {
  const fixture = fileURLToPath(new URL(
    "./test-fixtures/prepare-agent-render-captured-shape.fixture.ts",
    import.meta.url,
  ));
  const child = Bun.spawn([process.execPath, "--smol", fixture], {
    stdout: "pipe",
    stderr: "pipe",
  });
  // This real deadline is the containment contract under test: fake timers
  // cannot terminate a separate OS process whose runtime event loop is wedged.
  const { promise: deadline, resolve: resolveDeadline } = Promise.withResolvers<"deadline">();
  const deadlineTimer = setTimeout(() => resolveDeadline("deadline"), 5_000);
  const outcome = await Promise.race([
    child.exited.then(() => "exit" as const),
    deadline,
  ]);
  clearTimeout(deadlineTimer);
  if (outcome === "deadline") child.kill("SIGKILL");
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(outcome).toBe("exit");
  expect(child.exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout.trim())).toEqual({
    ok: true,
    frameBytes: 74_499,
    revisionBytes: 61_515,
    regexScripts: 0,
    renderedBytes: 1_009,
  });
}, 10_000);

function pairedPlan(requestId: string): CompilerAssemblyPlanV1 {
  const messages = [
    {
      role: "user",
      contentKind: "segments",
      provenance: { kind: "history", sourceId: "message-1", sourceRevision: "1", sourceIndex: 0 },
      segments: [{ kind: "literal", text: "history", bytes: 7 }],
    },
    {
      role: "system",
      contentKind: "segments",
      provenance: { kind: "world_info", sourceId: "entry-1", sourceRevision: "2", sourceIndex: 0 },
      segments: [{ kind: "literal", text: "world", bytes: 5 }],
    },
    {
      role: "system",
      contentKind: "segments",
      provenance: { kind: "block", sourceId: "block-1", sourceRevision: "3", sourceIndex: 0 },
      segments: [{ kind: "literal", text: "block", bytes: 5 }],
    },
  ];
  return {
    version: 1,
    operation: "compile_agent_assembly",
    requestId,
    limits: HOST_PREPARATION_LIMITS_V1,
    messages,
    providerMessages: messages,
    children: [],
    childDescriptors: [],
    resultSlots: [],
    activationEvidence: [],
    tokenEvidence: [],
    inputRevisions: revisions,
    inputRevisionSet: revisions,
    workPolicyMessages: [],
    workspaceUsageMessages: [],
    completionCriteriaMessages: [],
    renderPolicyMessages: [],
    deltas: [],
    deferredDeltas: [],
    seals: [],
    privateEvidence: {
      activation: [],
      cognition: [],
      token: {},
      inputRevisionDigest: revisions.digest,
    },
    snapshotId: "snapshot-1",
  } as unknown as CompilerAssemblyPlanV1;
}

describe("paired Agentic assembly verification", () => {
  test("accepts only the isolate-specific request id difference", () => {
    expect(() => assertPairedAssemblyResultsV1(
      pairedPlan("primary-request"),
      pairedPlan("verifier-request"),
    )).not.toThrow();
  });

  test("rejects every semantic difference in the independently compiled plan", () => {
    const mutations: Array<(plan: Record<string, unknown>) => void> = [
      (plan) => { plan.limits = { ...HOST_PREPARATION_LIMITS_V1, maxPromptBlocks: HOST_PREPARATION_LIMITS_V1.maxPromptBlocks - 1 }; },
      (plan) => { plan.providerMessages = (plan.providerMessages as unknown[]).slice(1); },
      (plan) => { plan.providerMessages = [...(plan.providerMessages as unknown[])].reverse(); },
      (plan) => {
        const messages = structuredClone(plan.providerMessages as Array<Record<string, unknown>>);
        const segments = messages[0]!.segments as Array<Record<string, unknown>>;
        segments[0] = { ...segments[0], text: "forged", bytes: 6 };
        plan.providerMessages = messages;
      },
      (plan) => { plan.workPolicyMessages = [{ forged: true }]; },
      (plan) => { plan.privateEvidence = { forged: true }; },
      (plan) => { plan.deltas = [{ kind: "forged" }]; },
      (plan) => { plan.deferredDeltas = [{ kind: "forged" }]; },
      (plan) => { plan.inputRevisions = { ...revisions, digest: "forged" }; },
      (plan) => { plan.snapshotId = "forged"; },
    ];
    for (const mutate of mutations) {
      const primary = pairedPlan("primary-request");
      const verifier = structuredClone(pairedPlan("verifier-request"));
      mutate(verifier as unknown as Record<string, unknown>);
      expectMalformed(() => assertPairedAssemblyResultsV1(primary, verifier));
    }
  });

  test("admits one active pair plus two queued pairs per user", () => {
    const admission = new PairedAssemblyAdmissionV1();
    const pairCapacity = Math.floor(
      HOST_PREPARATION_LIMITS_V1.maxQueuedJobsPerUser / 2,
    ) + 1;
    const releases = Array.from(
      { length: pairCapacity },
      () => admission.acquire("user-1"),
    );
    expect(releases.every((release) => typeof release === "function")).toBe(true);
    expect(admission.acquire("user-1")).toBeNull();
    releases[0]!();
    const replacement = admission.acquire("user-1");
    expect(typeof replacement).toBe("function");
    expect(admission.acquire("user-1")).toBeNull();
    replacement!();
    for (const release of releases.slice(1)) release!();
    const recovered = admission.acquire("user-1");
    expect(typeof recovered).toBe("function");
    recovered!();
  });
});
