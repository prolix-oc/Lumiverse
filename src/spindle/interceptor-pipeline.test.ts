import { describe, expect, test } from "bun:test";
import type { LlmMessageDTO } from "lumiverse-spindle-types";
import {
  FINAL_RESPONSE_CARRIER_FIELD,
  normalizeInterceptorFinalResponse,
  type NormalizeFinalResponseInput,
} from "./interceptor-final-response";
import {
  interceptorPipeline,
  type Interceptor,
  type InterceptorBreakdownEntry,
  type InterceptorResult,
} from "./interceptor-pipeline";

type NormalizeFixture = Omit<
  NormalizeFinalResponseInput,
  "result" | "inputMessages" | "outputMessages" | "breakdown"
>;

const NORMALIZE_IDS: NormalizeFixture = {
  extensionId: "pipeline-test",
  extensionName: "Pipeline test",
  workerId: "worker-pipeline-test",
  registrationId: "registration-pipeline-test",
  callbackUserId: "user-pipeline-test",
  hostGeneration: "generation-pipeline-test",
  permissionGranted: true,
  permissionGuard: () => true,
};

function pipelineBreakdown(
  entries: readonly { messageIndex: number; name?: string }[],
  messages: readonly LlmMessageDTO[],
  extensionId: string,
): InterceptorBreakdownEntry[] {
  return entries.map((entry) => {
    const message = messages[entry.messageIndex];
    if (!message) throw new Error("test breakdown points outside messages");
    if (typeof message.content !== "string") {
      throw new Error("test breakdown requires text content");
    }
    return {
      messageIndex: entry.messageIndex,
      name: entry.name ?? extensionId,
      role: message.role,
      content: message.content,
      extensionId,
      extensionName: extensionId,
    };
  });
}

function normalizedResult(input: {
  extensionId: string;
  inputMessages: readonly LlmMessageDTO[];
  outputMessages: readonly LlmMessageDTO[];
  breakdown?: readonly { messageIndex: number; name?: string }[];
  result?: unknown;
  permissionGranted?: boolean;
  permissionGuard?: () => boolean;
}): InterceptorResult {
  const normalized = normalizeInterceptorFinalResponse({
    ...NORMALIZE_IDS,
    extensionId: input.extensionId,
    extensionName: input.extensionId,
    workerId: `worker-${input.extensionId}`,
    registrationId: `registration-${input.extensionId}`,
    result: input.result,
    inputMessages: input.inputMessages,
    outputMessages: input.outputMessages,
    breakdown: input.breakdown ?? [],
    permissionGranted: input.permissionGranted ?? true,
    permissionGuard: input.permissionGuard ?? (() => true),
  });
  const breakdown = pipelineBreakdown(
    normalized.breakdown,
    normalized.messages,
    input.extensionId,
  );
  return {
    messages: normalized.messages,
    ...(breakdown.length > 0 ? { breakdown } : {}),
    ...(normalized.finalResponse ? { finalResponseState: normalized.finalResponse } : {}),
  };
}

function validCandidate(
  inputMessages: readonly LlmMessageDTO[],
  extensionId: string,
  answer: string,
  fallback: string,
): InterceptorResult {
  const outputMessages = [...inputMessages, { role: "system" as const, content: fallback }];
  return normalizedResult({
    extensionId,
    inputMessages,
    outputMessages,
    breakdown: [{ messageIndex: outputMessages.length - 1, name: `${extensionId} fallback` }],
    result: { content: answer, fallbackMessageIndex: outputMessages.length - 1 },
  });
}

function ordinaryEdit(
  inputMessages: readonly LlmMessageDTO[],
  extensionId: string,
  content: string,
  result: unknown = undefined,
  permissionGranted = true,
): InterceptorResult {
  const carrierIndex = inputMessages.findIndex(
    (message) =>
      (message as unknown as Record<string, unknown>)[FINAL_RESPONSE_CARRIER_FIELD] !== undefined,
  );
  const insertionIndex = carrierIndex >= 0 ? carrierIndex : inputMessages.length;
  const outputMessages = [
    ...inputMessages.slice(0, insertionIndex),
    { role: "system" as const, content },
    ...inputMessages.slice(insertionIndex),
  ];
  return normalizedResult({
    extensionId,
    inputMessages,
    outputMessages,
    breakdown: [{ messageIndex: insertionIndex, name: `${extensionId} ordinary` }],
    result,
    permissionGranted,
  });
}

async function runWith(interceptors: readonly Interceptor[]): Promise<InterceptorResult> {
  const disposers = interceptors.map((interceptor) => interceptorPipeline.register(interceptor));
  try {
    return await interceptorPipeline.run(
      [{ role: "user", content: "pipeline input" }],
      { chatId: "pipeline-chat" },
      "user-pipeline-test",
    );
  } finally {
    for (const dispose of disposers.reverse()) dispose();
  }
}

function carrierCount(messages: readonly LlmMessageDTO[]): number {
  return messages.filter(
    (message) =>
      (message as unknown as Record<string, unknown>)[FINAL_RESPONSE_CARRIER_FIELD] !== undefined,
  ).length;
}

describe("interceptor pipeline final-response folding", () => {
  test("accepts the first valid state and exposes exactly one protected carrier", async () => {
    const result = await runWith([
      {
        extensionId: "first-valid",
        extensionName: "First valid",
        priority: 1,
        handler: async (messages) => validCandidate(messages, "first-valid", "answer", "fallback"),
      },
    ]);

    expect(result.finalResponseState?.status).toBe("valid");
    expect(carrierCount(result.messages)).toBe(1);
    expect(result.messages.some((message) => message.content === "fallback")).toBe(true);
    expect("finalResponse" in result).toBe(false);
  });

  test("supersedes in registration order with one replacement and corrected breakdown", async () => {
    const result = await runWith([
      {
        extensionId: "first-winner",
        extensionName: "First winner",
        priority: 1,
        handler: async (messages) =>
          validCandidate(messages, "first-winner", "first answer", "first fallback"),
      },
      {
        extensionId: "second-winner",
        extensionName: "Second winner",
        priority: 2,
        handler: async (messages) =>
          validCandidate(messages, "second-winner", "second answer", "second fallback"),
      },
    ]);

    expect(result.finalResponseState?.status).toBe("valid");
    if (result.finalResponseState?.status === "valid") {
      expect(result.finalResponseState.extensionId).toBe("second-winner");
      expect(result.finalResponseState.supersededResponse?.extensionId).toBe("first-winner");
    }
    expect(carrierCount(result.messages)).toBe(1);
    expect(result.messages.some((message) => message.content === "first fallback")).toBe(false);
    expect(result.messages.some((message) => message.content === "second fallback")).toBe(true);
    expect(result.breakdown?.filter((entry) => entry.content === "second fallback")).toHaveLength(1);
    expect(result.breakdown?.some((entry) => entry.content === "first fallback")).toBe(false);
  });

  test("retains a valid winner across omitted, invalid, and unauthorized handlers", async () => {
    const result = await runWith([
      {
        extensionId: "retained-winner",
        extensionName: "Retained winner",
        priority: 1,
        handler: async (messages) =>
          validCandidate(messages, "retained-winner", "answer", "protected fallback"),
      },
      {
        extensionId: "omitted-edit",
        extensionName: "Omitted edit",
        priority: 2,
        handler: async (messages) => ordinaryEdit(messages, "omitted-edit", "omitted safe edit"),
      },
      {
        extensionId: "invalid-edit",
        extensionName: "Invalid edit",
        priority: 3,
        handler: async (messages) =>
          ordinaryEdit(messages, "invalid-edit", "invalid safe edit", { content: "", fallbackMessageIndex: -1 }),
      },
      {
        extensionId: "unauthorized-edit",
        extensionName: "Unauthorized edit",
        priority: 4,
        handler: async (messages) =>
          ordinaryEdit(
            messages,
            "unauthorized-edit",
            "unauthorized safe edit",
            { content: "answer", fallbackMessageIndex: messages.length },
            false,
          ),
      },
    ]);

    expect(result.finalResponseState?.status).toBe("valid");
    if (result.finalResponseState?.status === "valid") {
      expect(result.finalResponseState.extensionId).toBe("retained-winner");
    }
    expect(carrierCount(result.messages)).toBe(1);
    for (const content of ["omitted safe edit", "invalid safe edit", "unauthorized safe edit", "protected fallback"]) {
      expect(result.messages.some((message) => message.content === content)).toBe(true);
    }
  });

  test("discards modified or missing prior carriers instead of accepting unsafe output", async () => {
    let accepted: InterceptorResult | undefined;
    const modified = await runWith([
      {
        extensionId: "stable-before-modification",
        extensionName: "Stable before modification",
        priority: 1,
        handler: async (messages) => {
          accepted = validCandidate(messages, "stable-before-modification", "answer", "protected");
          return accepted;
        },
      },
      {
        extensionId: "modified-carrier",
        extensionName: "Modified carrier",
        priority: 2,
        handler: async (messages) => {
          const changed = messages.map((message) =>
            (message as unknown as Record<string, unknown>)[FINAL_RESPONSE_CARRIER_FIELD] === undefined
              ? message
              : { ...message, content: "tampered carrier" },
          );
          return { messages: [...changed, { role: "system", content: "unsafe edit" }] };
        },
      },
    ]);
    if (!accepted) throw new Error("first handler did not produce a result");
    expect(modified.messages).toEqual(accepted.messages);
    expect(modified.breakdown).toEqual(accepted.breakdown);
    expect(modified.finalResponseState).toBe(accepted.finalResponseState);
    expect(modified.messages.some((message) => message.content === "unsafe edit")).toBe(false);

    let acceptedMissing: InterceptorResult | undefined;
    const missing = await runWith([
      {
        extensionId: "stable-before-removal",
        extensionName: "Stable before removal",
        priority: 1,
        handler: async (messages) => {
          acceptedMissing = validCandidate(messages, "stable-before-removal", "answer", "protected");
          return acceptedMissing;
        },
      },
      {
        extensionId: "missing-carrier",
        extensionName: "Missing carrier",
        priority: 2,
        handler: async (messages) => ({
          messages: messages.filter(
            (message) =>
              (message as unknown as Record<string, unknown>)[FINAL_RESPONSE_CARRIER_FIELD] === undefined,
          ).concat({ role: "system", content: "unsafe missing-carrier edit" }),
        }),
      },
    ]);
    if (!acceptedMissing) throw new Error("first missing-carrier handler did not produce a result");
    expect(missing.messages).toEqual(acceptedMissing.messages);
    expect(missing.breakdown).toEqual(acceptedMissing.breakdown);
    expect(missing.finalResponseState).toBe(acceptedMissing.finalResponseState);
    expect(missing.messages.some((message) => message.content === "unsafe missing-carrier edit")).toBe(false);
  });

  test("retains the prior winner when a later valid supersession is structurally unsafe", async () => {
    let accepted: InterceptorResult | undefined;
    const result = await runWith([
      {
        extensionId: "structural-prior",
        extensionName: "Structural prior",
        priority: 1,
        handler: async (messages) => {
          accepted = validCandidate(messages, "structural-prior", "answer", "prior fallback");
          return accepted;
        },
      },
      {
        extensionId: "structural-next",
        extensionName: "Structural next",
        priority: 2,
        handler: async (messages) => {
          const changedInput = messages.map((message) =>
            (message as unknown as Record<string, unknown>)[FINAL_RESPONSE_CARRIER_FIELD] === undefined
              ? message
              : { ...message, content: "changed prior carrier" },
          );
          return normalizedResult({
            extensionId: "structural-next",
            inputMessages: changedInput,
            outputMessages: [...changedInput, { role: "system", content: "next fallback" }],
            breakdown: [{ messageIndex: changedInput.length, name: "next fallback" }],
            result: { content: "next answer", fallbackMessageIndex: changedInput.length },
          });
        },
      },
    ]);

    if (!accepted) throw new Error("structural prior handler did not produce a result");
    expect(result.messages).toEqual(accepted.messages);
    expect(result.breakdown).toEqual(accepted.breakdown);
    expect(result.finalResponseState).toBe(accepted.finalResponseState);
    expect(result.messages.some((message) => message.content === "next fallback")).toBe(false);
  });

  test("keeps rejected diagnostics until a later valid candidate appears", async () => {
    const result = await runWith([
      {
        extensionId: "invalid-first",
        extensionName: "Invalid first",
        priority: 1,
        handler: async (messages) =>
          normalizedResult({
            extensionId: "invalid-first",
            inputMessages: messages,
            outputMessages: messages,
            result: { content: "", fallbackMessageIndex: -1 },
          }),
      },
      {
        extensionId: "valid-later",
        extensionName: "Valid later",
        priority: 2,
        handler: async (messages) => validCandidate(messages, "valid-later", "answer", "later fallback"),
      },
    ]);

    expect(result.finalResponseState?.status).toBe("valid");
    if (result.finalResponseState?.status === "valid") {
      expect(result.finalResponseState.extensionId).toBe("valid-later");
    }
    expect(carrierCount(result.messages)).toBe(1);
  });

  test("leaves ordinary output unchanged when no handler returns a response state", async () => {
    const result = await runWith([
      {
        extensionId: "ordinary-only",
        extensionName: "Ordinary only",
        priority: 1,
        handler: async (messages) => ({
          messages: [...messages, { role: "system", content: "ordinary output" }],
        }),
      },
    ]);

    expect(result.messages).toEqual([
      { role: "user", content: "pipeline input" },
      { role: "system", content: "ordinary output" },
    ]);
    expect(result.finalResponseState).toBeUndefined();
  });
});
