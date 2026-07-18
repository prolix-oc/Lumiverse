import { describe, expect, test } from "bun:test";
import type {
  InterceptorBreakdownEntryDTO,
  LlmMessageDTO,
} from "lumiverse-spindle-types";
import type { ParentGenerationSnapshot } from "./bound-generation-types";
import {
  ensureInterceptorFinalResponseFallback,
  normalizeInterceptorFinalResponse,
  selectInterceptorFinalResponse,
  supersedeInterceptorFinalResponse,
  retainInterceptorFinalResponse,
  type InterceptorFinalResponseDTO,
  type NormalizeFinalResponseInput,
} from "./interceptor-final-response";

const LIMIT = 1024 * 1024;
const IDS = {
  extensionId: "extension.test",
  extensionName: "Final response test",
  workerId: "worker-1",
  registrationId: "registration-1",
  callbackUserId: "user-1",
  hostGeneration: "generation-1",
};

type Fixture = Partial<Omit<NormalizeFinalResponseInput, "result" | "inputMessages" | "outputMessages" | "breakdown">> & {
  inputMessages?: readonly LlmMessageDTO[];
  outputMessages?: readonly LlmMessageDTO[];
  breakdown?: readonly InterceptorBreakdownEntryDTO[];
  result?: unknown;
};

function makeInput(options: Fixture = {}): NormalizeFinalResponseInput {
  const inputMessages = options.inputMessages ?? [{ role: "user", content: "ordinary" }];
  const fallback: LlmMessageDTO = { role: "system", content: "fallback" };
  const outputMessages = options.outputMessages ?? [...inputMessages, fallback];
  const fallbackMessageIndex = outputMessages.length - 1;
  const result = Object.prototype.hasOwnProperty.call(options, "result")
    ? options.result
    : ({ content: "chosen", fallbackMessageIndex } satisfies InterceptorFinalResponseDTO);
  return {
    ...IDS,
    ...options,
    result,
    inputMessages,
    outputMessages,
    breakdown: options.breakdown ?? [{ messageIndex: fallbackMessageIndex, name: "Fallback guidance" }],
    permissionGranted: options.permissionGranted ?? true,
    permissionGuard: options.permissionGuard ?? (() => true),
  };
}

function normalize(options: Fixture = {}) {
  return normalizeInterceptorFinalResponse(makeInput(options));
}

function parentWithCarrier(carrier: LlmMessageDTO): ParentGenerationSnapshot {
  return {
    kind: "parent-generation",
    hostGeneration: "host-1" as ParentGenerationSnapshot["hostGeneration"],
    generationId: "generation-1",
    userId: "user-1",
    chatId: "chat-1",
    main: {} as ParentGenerationSnapshot["main"],
    retrieval: {} as ParentGenerationSnapshot["retrieval"],
    parentIdentities: {},
    options: {},
    parentPrefill: { id: "prefill", state: "available" },
    parentPrefillCarrier: [carrier],
    parentPrefillCarrierIndex: 1,
    interceptorDeadlineAt: Date.now() + 30_000,
    boundWorkDeadlineAt: Date.now() + 30_000,
  };
}

describe("interceptor final-response normalization and selection", () => {
  test("omission, invalid, and unauthorized states retain an accepted winner", () => {
    const accepted = normalize();
    expect(accepted.finalResponse?.status).toBe("valid");
    if (!accepted.finalResponse || accepted.finalResponse.status !== "valid") throw new Error("fixture did not normalize");

    const omitted = normalize({ result: undefined });
    expect(omitted.finalResponse).toBeUndefined();
    expect(retainInterceptorFinalResponse(accepted.finalResponse, omitted.finalResponse)).toBe(accepted.finalResponse);

    const invalid = normalize({ result: { content: "", fallbackMessageIndex: 1 } });
    expect(invalid.finalResponse?.status).toBe("invalid");
    expect(retainInterceptorFinalResponse(accepted.finalResponse, invalid.finalResponse)).toBe(accepted.finalResponse);

    const unauthorized = normalize({ permissionGranted: false });
    expect(unauthorized.finalResponse?.status).toBe("unauthorized");
    expect(retainInterceptorFinalResponse(accepted.finalResponse, unauthorized.finalResponse)).toBe(accepted.finalResponse);
    expect(unauthorized.messages).toEqual([...(makeInput({ permissionGranted: false }).outputMessages ?? [])]);
  });

  test("a later valid candidate supersedes the prior candidate but never revives it after revoke", () => {
    let previousAllowed = true;
    let nextAllowed = true;
    const previous = normalize({
      extensionId: "prior",
      extensionName: "Prior",
      permissionGuard: () => previousAllowed,
    });
    const next = normalize({
      extensionId: "next",
      extensionName: "Next",
      permissionGuard: () => nextAllowed,
      inputMessages: previous.messages,
      outputMessages: [
        ...previous.messages,
        { role: "system", content: "next-fallback" },
      ],
      breakdown: [
        ...previous.breakdown,
        { messageIndex: 2, name: "Next fallback" },
      ],
      result: { content: "next-answer", fallbackMessageIndex: 2 },
    });
    expect(previous.finalResponse?.status).toBe("valid");
    expect(next.finalResponse?.status).toBe("valid");
    if (previous.finalResponse?.status !== "valid" || next.finalResponse?.status !== "valid") throw new Error("fixture did not normalize");

    const retained = retainInterceptorFinalResponse(previous.finalResponse, next.finalResponse);
    expect(retained?.status).toBe("valid");
    if (!retained || retained.status !== "valid") throw new Error("candidate was not retained");
    expect(retained.extensionId).toBe("next");
    expect(retained.supersededResponse).toBe(previous.finalResponse);

    const replacement = supersedeInterceptorFinalResponse({
      previous: previous.finalResponse,
      next: next.finalResponse,
      messages: next.messages,
      acceptedBreakdown: previous.breakdown,
      outputBreakdown: next.breakdown,
    });
    expect(replacement.finalResponse.supersededResponse).toBe(previous.finalResponse);
    expect(replacement.finalResponse.extensionId).toBe("next");

    const currentAllowed = selectInterceptorFinalResponse({
      response: replacement.finalResponse,
      messages: replacement.messages,
      generationType: "normal",
      hasTools: false,
      isDryRun: false,
    });
    expect(currentAllowed.kind).toBe("final-response");
    nextAllowed = false;
    const currentRevoked = selectInterceptorFinalResponse({
      response: replacement.finalResponse,
      messages: replacement.messages,
      generationType: "normal",
      hasTools: false,
      isDryRun: false,
    });
    expect(currentRevoked.kind).toBe("provider");
    if (currentRevoked.kind === "provider") {
      expect(currentRevoked.warning).toContain("permission is no longer granted");
      expect(currentRevoked.messages.find((message) => message.role === "system")?.content).toBe("next-fallback");
    }
  });

  test("bounds content and reasoning independently at the UTF-8 boundary", () => {
    const exact = `${"€".repeat(349_525)}a`;
    expect(new TextEncoder().encode(exact).byteLength).toBe(LIMIT);
    const accepted = normalize({ result: { content: exact, reasoning: exact, fallbackMessageIndex: 1 } });
    expect(accepted.finalResponse?.status).toBe("valid");

    const overContent = normalize({ result: { content: `${exact}a`, fallbackMessageIndex: 1 } });
    expect(overContent.finalResponse?.status).toBe("invalid");
    if (overContent.finalResponse?.status === "invalid") expect(overContent.finalResponse.reason).toContain("content exceeds");

    const overReasoning = normalize({ result: { content: "chosen", reasoning: `${exact}a`, fallbackMessageIndex: 1 } });
    expect(overReasoning.finalResponse?.status).toBe("invalid");
    if (overReasoning.finalResponse?.status === "invalid") expect(overReasoning.finalResponse.reason).toContain("reasoning exceeds");
  });

  test("requires exact fallback provenance and host-owned attribution", () => {
    const inherited = normalize({
      inputMessages: [{ role: "system", content: "inherited" }],
      outputMessages: [
        { role: "system", content: "inherited" },
        { role: "system", content: "fallback" },
      ],
      breakdown: [{ messageIndex: 1, name: "Final response" }],
      result: { content: "chosen", fallbackMessageIndex: 1 },
    });
    expect(inherited.finalResponse?.status).toBe("valid");
    if (inherited.finalResponse?.status === "valid") {
      expect(inherited.finalResponse.fallbackBreakdown.extensionId).toBe(IDS.extensionId);
      expect(inherited.finalResponse.fallbackBreakdown.extensionName).toBe(IDS.extensionName);
      expect(inherited.finalResponse.fallbackBreakdown.name).toBe(`${IDS.extensionName}: Final response`);
    }

    for (const breakdown of [
      [],
      [{ messageIndex: 1, name: "one" }, { messageIndex: 1, name: "two" }],
      [{ messageIndex: 0, name: "wrong" }],
    ]) {
      expect(normalize({ breakdown }).finalResponse?.status).toBe("invalid");
    }
    expect(normalize({
      outputMessages: [{ role: "user", content: "changed" }, { role: "system", content: "fallback" }],
    }).finalResponse?.status).toBe("invalid");
    expect(normalize({
      outputMessages: [{ role: "user", content: "ordinary" }, { role: "assistant", content: "fallback" }],
    }).finalResponse?.status).toBe("invalid");
  });

  test("requires one exact prefill carrier and immediate fallback placement", () => {
    const prefill: LlmMessageDTO = {
      role: "assistant",
      content: "Start reply",
      cache_control: { type: "ephemeral" },
    };
    const inputMessages: LlmMessageDTO[] = [{ role: "user", content: "ordinary" }, prefill];
    const valid = normalize({
      inputMessages,
      outputMessages: [inputMessages[0]!, { role: "system", content: "fallback" } satisfies LlmMessageDTO, prefill],
      breakdown: [{ messageIndex: 1, name: "Fallback" }],
      parent: parentWithCarrier(prefill),
      result: { content: "chosen", fallbackMessageIndex: 1 },
    });
    expect(valid.finalResponse?.status).toBe("valid");

    const wrongOrder = normalize({
      inputMessages,
      outputMessages: [inputMessages[0]!, prefill, { role: "system", content: "fallback" } satisfies LlmMessageDTO],
      breakdown: [{ messageIndex: 2, name: "Fallback" }],
      parent: parentWithCarrier(prefill),
      result: { content: "chosen", fallbackMessageIndex: 2 },
    });
    expect(wrongOrder.finalResponse?.status).toBe("invalid");

    const ambiguous = normalize({
      inputMessages: [inputMessages[0]!, prefill, prefill],
      outputMessages: [inputMessages[0]!, { role: "system", content: "fallback" } satisfies LlmMessageDTO, prefill, prefill],
      breakdown: [{ messageIndex: 1, name: "Fallback" }],
      parent: parentWithCarrier(prefill),
      result: { content: "chosen", fallbackMessageIndex: 1 },
    });
    expect(ambiguous.finalResponse?.status).toBe("invalid");
  });

  test("selects only eligible routes and restores the protected snapshot on revoke", () => {
    let permission = true;
    const normalized = normalize({ permissionGuard: () => permission });
    expect(normalized.finalResponse?.status).toBe("valid");
    if (normalized.finalResponse?.status !== "valid") throw new Error("fixture did not normalize");

    for (const generationType of ["normal", "continue"] as const) {
      const selected = selectInterceptorFinalResponse({
        response: normalized.finalResponse,
        messages: normalized.messages,
        generationType,
        hasTools: false,
        isDryRun: false,
      });
      expect(selected.kind).toBe("final-response");
    }
    for (const generationType of ["regenerate", "swipe", "impersonate", "quiet"]) {
      const selected = selectInterceptorFinalResponse({
        response: normalized.finalResponse,
        messages: normalized.messages,
        generationType,
        hasTools: false,
        isDryRun: false,
      });
      expect(selected.kind).toBe("provider");
      if (selected.kind === "provider") expect(selected.warning).toBeUndefined();
    }
    expect(selectInterceptorFinalResponse({
      response: normalized.finalResponse,
      messages: normalized.messages,
      generationType: "normal",
      hasTools: true,
      isDryRun: false,
    }).kind).toBe("provider");
    expect(selectInterceptorFinalResponse({
      response: normalized.finalResponse,
      messages: normalized.messages,
      generationType: "normal",
      hasTools: false,
      isDryRun: true,
    }).kind).toBe("provider");

    permission = false;
    const restored = selectInterceptorFinalResponse({
      response: normalized.finalResponse,
      messages: normalized.messages,
      generationType: "normal",
      hasTools: false,
      isDryRun: false,
    });
    expect(restored.kind).toBe("provider");
    if (restored.kind === "provider") {
      expect(restored.warning).toContain("permission is no longer granted");
      expect(restored.messages).toEqual([...(makeInput().outputMessages ?? [])]);
      expect(restored.messages.filter((message) => message.role === "system" && message.content === "fallback")).toHaveLength(1);
    }
  });

  test("restores before an exact prefill and fails on missing or ambiguous prefill", () => {
    const prefill: LlmMessageDTO = { role: "assistant", content: "Start" };
    const inputMessages: LlmMessageDTO[] = [{ role: "user", content: "ordinary" }, prefill];
    const normalized = normalize({
      inputMessages,
      outputMessages: [inputMessages[0]!, { role: "system", content: "fallback" } satisfies LlmMessageDTO, prefill],
      breakdown: [{ messageIndex: 1, name: "Fallback" }],
      parent: parentWithCarrier(prefill),
      result: { content: "chosen", fallbackMessageIndex: 1 },
    });
    const response = normalized.finalResponse;
    if (!response || response.status !== "valid") throw new Error("fixture did not normalize");
    const restored = ensureInterceptorFinalResponseFallback(
      normalized.messages,
      response,
    );
    expect(restored).toEqual(inputMessages.slice(0, 1).concat([{ role: "system", content: "fallback" } satisfies LlmMessageDTO, prefill]));
    expect(ensureInterceptorFinalResponseFallback(restored, response)).toEqual(restored);

    const modified = restored.map((message, index) => index === 2 ? { ...message, content: "modified" } : message);
    expect(() => ensureInterceptorFinalResponseFallback(modified, response)).toThrow("PREFILL_CARRIER_MISMATCH");
  });
});
