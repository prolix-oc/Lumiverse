import { describe, expect, test } from "bun:test";
import {
  HOST_PREPARATION_LIMITS_V1,
  type PreparationFailureCode,
  type PreparationLimitsV1,
  type RenderPreparationInputV1,
} from "../types/agent-preprocessing";
import {
  calculateRenderUsage,
  prepareAgentRenderV1,
  type RenderPreparationOptions,
} from "./agentic-render-preparation.service";
import {
  aggregateRenderInputBytesV1,
  RenderPreparationValidationError,
  validateRenderPreparationInputV1,
} from "./agentic-render-preparation-validator";
import { healFormattingArtifacts } from "../utils/format-healing";

const revisions = {
  version: 1 as const,
  revisions: [],
  digest: "frozen-inputs",
};

function makeInput(overrides: Partial<RenderPreparationInputV1> = {}): RenderPreparationInputV1 {
  return {
    version: 1 as const,
    operation: "prepare_agent_render" as const,
    requestId: "request-1",
    limits: HOST_PREPARATION_LIMITS_V1,
    turnId: "turn-1",
    target: { kind: "normal" as const },
    content: { kind: "text" as const, text: "Hello" },
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
    ...overrides,
  };
}

function loweredLimits(overrides: Partial<PreparationLimitsV1>): PreparationLimitsV1 {
  return { ...HOST_PREPARATION_LIMITS_V1, ...overrides };
}

function expectPreparationFailure(run: () => unknown, code: PreparationFailureCode): void {
  let failure: unknown;
  try {
    run();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(RenderPreparationValidationError);
  expect((failure as RenderPreparationValidationError).code).toBe(code);
}

describe("prepareAgentRenderV1", () => {
  test("is deterministic, immutable, and keeps unknown provider macros literal", () => {
    const input = makeInput({
      content: { kind: "text", text: "{{char}}/{{unknownProviderMacro}}" },
      macroSnapshot: {
        local: [],
        global: [["char", "Ada"]],
        chat: [],
        promptVariables: [],
      },
    });
    const first = prepareAgentRenderV1(input);
    const second = prepareAgentRenderV1(input);

    expect(first).toEqual(second);
    expect(first.content).toEqual({ kind: "text", text: "Ada/{{unknownProviderMacro}}" });
    expect(first.reasoning).toBeUndefined();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.content)).toBe(true);
    expect(Object.isFrozen(first.usage)).toBe(true);
    expect(Object.isFrozen(first.macroVariableDeltas)).toBe(true);
    expect(Object.isFrozen(first.chatMetadataDeltas)).toBe(true);
    expect(Object.isFrozen(first.chatMetadataDeltas[0])).toBe(true);
    expect(Object.isFrozen(first.inputRevisions)).toBe(true);
    expect(Object.isFrozen(first.inputRevisions.revisions)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.content)).toBe(false);
  });

  test("uses the bounded byte estimate when provider usage is absent", () => {
    const input = makeInput();
    const prepared = prepareAgentRenderV1(input);
    const inputBytes = aggregateRenderInputBytesV1(input, HOST_PREPARATION_LIMITS_V1);
    const outputBytes = new TextEncoder().encode("Hello").byteLength;
    expect(prepared.usage).toEqual(calculateRenderUsage(inputBytes, outputBytes));
  });

  test("strips guided CoT tags without returning or retaining reasoning", () => {
    const result = prepareAgentRenderV1(makeInput({
      content: { kind: "text", text: "<think>private plan</think>Visible answer" },
    }));

    expect(result.content).toEqual({ kind: "text", text: "Visible answer" });
    expect(result).not.toHaveProperty("reasoning");
  });

  test("preserves response regex order and capture replacement semantics", () => {
    const result = prepareAgentRenderV1(makeInput({
      content: { kind: "text", text: "A-42" },
      regexScripts: [
        {
          scriptId: "first",
          revision: 1,
          pattern: "A",
          replacement: "B",
          flags: "g",
          stage: "response",
          enabled: true,
          order: 0,
        },
        {
          scriptId: "second",
          revision: 1,
          pattern: "(B)-(\\d+)",
          replacement: "$2:$1",
          flags: "g",
          stage: "response",
          enabled: true,
          order: 1,
        },
      ],
    }));

    expect(result.content).toEqual({ kind: "text", text: "42:B" });
  });

  test("resolves assistant and source macros from the frozen pure snapshot", () => {
    const result = prepareAgentRenderV1(makeInput({
      content: { kind: "text", text: "{{promptvar::tone}}" },
      sourceMessages: [{
        sourceMessageId: "source-1",
        revision: 4,
        role: "user",
        content: { kind: "text", text: "{{promptvar::tone}}" },
      }],
      macroSnapshot: {
        local: [],
        global: [],
        chat: [],
        promptVariables: [["tone", "warm"]],
      },
      deltas: [{
        kind: "source_message",
        sourceMessageId: "source-1",
        operation: "update",
        expectedRevision: 4,
      }],
    }));

    expect(result.content).toEqual({ kind: "text", text: "warm" });
    expect(result.sourceMessageDeltas).toEqual([{
      kind: "source_message",
      sourceMessageId: "source-1",
      operation: "update",
      role: "user",
      content: "warm",
      expectedRevision: 4,
    }]);
  });

  test("rejects non-pure macros before they can reach a host callback", () => {
    expectPreparationFailure(
      () => prepareAgentRenderV1(makeInput({ content: { kind: "text", text: "{{random}}" } })),
      "requires_response_mode",
    );
  });

  test("requires authorization for macro-variable deltas", () => {
    expectPreparationFailure(
      () => prepareAgentRenderV1(makeInput({ content: { kind: "text", text: "{{setvar::secret::value}}" } })),
      "requires_response_mode",
    );

    const result = prepareAgentRenderV1(makeInput({
      content: { kind: "text", text: "{{setvar::secret::value}}{{var::secret}}" },
      deltas: [{ kind: "macro_variable", scope: "local", key: "secret", operation: "set" }],
    }));
    expect(result.content).toEqual({ kind: "text", text: "valuevalue" });
    expect(result.macroVariableDeltas).toEqual([{
      kind: "macro_variable",
      scope: "local",
      key: "secret",
      operation: "set",
      value: "value",
    }]);
  });

  test("reconciles frozen regenerate/swipe targets with the selected swipe revision", () => {
    const result = prepareAgentRenderV1(makeInput({
      target: { kind: "regenerate", messageId: "message-1", swipeId: "swipe-2" },
      swipes: [{
        swipeId: "swipe-2",
        index: 1,
        revision: 9,
        content: { kind: "text", text: "old" },
      }],
      content: { kind: "text", text: "new" },
    }));

    expect(result.chatMetadataDeltas).toEqual([{
      kind: "chat_metadata",
      key: "message:message-1:swipe:swipe-2",
      operation: "set",
      value: "new",
      expectedRevision: 9,
    }]);
  });

  test("accounts exact UTF-8 limits and cancellation/deadline before transformation", () => {
    const tooSmall = loweredLimits({ maxInputBytes: 3 });
    expectPreparationFailure(
      () => prepareAgentRenderV1(makeInput({ limits: tooSmall, content: { kind: "text", text: "😀😀" } })),
      "limit_exceeded",
    );
    expectPreparationFailure(
      () => prepareAgentRenderV1(makeInput({
        limits: loweredLimits({ maxInputBytes: 8, maxOutputBytes: 3 }),
        content: { kind: "text", text: "😀" },
      })),
      "limit_exceeded",
    );

    const controller = new AbortController();
    controller.abort();
    expectPreparationFailure(
      () => prepareAgentRenderV1(makeInput(), { signal: controller.signal }),
      "cancelled",
    );

    let calls = 0;
    const options: RenderPreparationOptions = {
      now: () => (calls++ === 0 ? 0 : 61_000),
    };
    expectPreparationFailure(() => prepareAgentRenderV1(makeInput(), options), "worker_timed_out");
  });

  test("does not invoke provider/RPC callbacks in the strict operation", () => {
    let callbackCalls = 0;
    const callback = () => {
      callbackCalls += 1;
      throw new Error("host callback reached");
    };
    const result = prepareAgentRenderV1(makeInput({
      content: { kind: "text", text: "literal" },
      macroSnapshot: {
        local: [],
        global: [["providerCallback", String(callback)]],
        chat: [],
        promptVariables: [],
      },
    }));
    expect(result.content).toEqual({ kind: "text", text: "literal" });
    expect(callbackCalls).toBe(0);
  });
});

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function aggregateOf(input: RenderPreparationInputV1): number {
  return aggregateRenderInputBytesV1(input, HOST_PREPARATION_LIMITS_V1);
}

function expectInvalidField(overrides: Record<string, unknown>): void {
  expectPreparationFailure(
    () => prepareAgentRenderV1({ ...makeInput(), ...overrides } as unknown as RenderPreparationInputV1),
    "invalid_input",
  );
}

describe("strict render aggregate textual input accounting", () => {
  test("counts every textual field exactly once", () => {
    const base = aggregateOf(makeInput());

    expect(aggregateOf(makeInput({ reasoning: "reasoning" })) - base).toBe(bytes("reasoning"));
    expect(aggregateOf(makeInput({
      macroSnapshot: { local: [["key", "válue"]], global: [], chat: [], promptVariables: [] },
    })) - base).toBe(bytes("key") + bytes("válue"));
    expect(aggregateOf(makeInput({
      macroSnapshot: {
        local: [],
        global: [],
        chat: [],
        promptVariables: [],
        dependencies: [{ name: "char", purity: "pure", source: "preset" }],
      },
    })) - base).toBe(bytes("char") + bytes("pure") + bytes("preset"));
    expect(aggregateOf(makeInput({
      regexScripts: [{
        scriptId: "script",
        revision: 7,
        pattern: "pattern",
        replacement: "replacement",
        flags: "g",
        stage: "response",
        enabled: true,
        order: 0,
        trimStrings: ["trim"],
        actions: [{ id: "action", type: "send" }],
      }],
    })) - base).toBe(
      bytes("script") + bytes("7") + bytes("pattern") + bytes("replacement")
      + bytes("g") + bytes("response") + bytes("trim") + bytes("action") + bytes("send"),
    );
    expect(aggregateOf(makeInput({
      formatting: {
        stripGuidedReasoning: true,
        healFormatting: true,
        preserveProviderReasoning: true,
        reasoningDelimiters: { prefix: "<c>", suffix: "</c>" },
      },
    })) - base).toBe(bytes("<c>") + bytes("</c>"));
    expect(aggregateOf(makeInput({
      deltas: [{ kind: "macro_variable", scope: "local", key: "k", operation: "set", value: "v", expectedRevision: 3 }],
    })) - base).toBe(
      bytes("macro_variable") + bytes("set") + bytes("local") + bytes("k") + bytes("v") + bytes("3"),
    );
    expect(aggregateOf(makeInput({
      inputRevisions: {
        version: 1,
        revisions: [{ kind: "target", id: "t", revision: 2, digest: "d" }],
        digest: "frozen-inputs",
      },
    })) - base).toBe(bytes("target") + bytes("t") + bytes("2") + bytes("d"));
    expect(aggregateOf(makeInput({
      swipes: [{ swipeId: "s", index: 0, revision: 4, content: { kind: "text", text: "swipe" } }],
    })) - base).toBe(bytes("s") + bytes("4") + bytes("swipe"));
    expect(aggregateOf(makeInput({
      sourceMessages: [{
        sourceMessageId: "m",
        revision: 5,
        role: "user",
        content: { kind: "text", text: "text" },
        authorName: "Ada",
      }],
    })) - base).toBe(bytes("m") + bytes("5") + bytes("user") + bytes("text") + bytes("Ada"));
  });

  test("admits the combined aggregate at the cap and rejects cap plus one byte", () => {
    const input = makeInput({
      content: { kind: "text", text: "Hello 😀" },
      reasoning: "private",
      macroSnapshot: { local: [["tone", "warm"]], global: [], chat: [], promptVariables: [] },
      regexScripts: [{
        scriptId: "script",
        revision: 1,
        pattern: "zzz",
        replacement: "yyy",
        flags: "g",
        stage: "response",
        enabled: true,
        order: 0,
      }],
      formatting: {
        stripGuidedReasoning: false,
        healFormatting: false,
        preserveProviderReasoning: true,
      },
    });
    const exact = aggregateOf(input);

    expect(prepareAgentRenderV1({ ...input, limits: loweredLimits({ maxInputBytes: exact }) }).content)
      .toEqual({ kind: "text", text: "Hello 😀" });
    expectPreparationFailure(
      () => prepareAgentRenderV1({ ...input, limits: loweredLimits({ maxInputBytes: exact - 1 }) }),
      "limit_exceeded",
    );
  });

  test("bounds every regex field at the per-operation ceiling", () => {
    const script = {
      scriptId: "script",
      revision: 1,
      pattern: "a",
      replacement: "b",
      flags: "g",
      stage: "response" as const,
      enabled: true,
      order: 0,
    };
    expectPreparationFailure(
      () => prepareAgentRenderV1(makeInput({
        limits: loweredLimits({ maxOperationBytes: 4 }),
        regexScripts: [{ ...script, pattern: "aaaaa" }],
      })),
      "limit_exceeded",
    );
    expectPreparationFailure(
      () => prepareAgentRenderV1(makeInput({
        limits: loweredLimits({ maxOperationBytes: 4 }),
        regexScripts: [{ ...script, replacement: "bbbbb" }],
      })),
      "limit_exceeded",
    );
    expectPreparationFailure(
      () => prepareAgentRenderV1(makeInput({
        macroSnapshot: { local: [], global: [], chat: [], promptVariables: [] },
        limits: loweredLimits({ maxOperationBytes: 4 }),
        regexScripts: [{ ...script, trimStrings: ["a".repeat(513)] }],
      })),
      "limit_exceeded",
    );
  });
});

describe("strict render prospective output accounting", () => {
  const prefixScript = {
    scriptId: "prefix",
    revision: 1,
    pattern: "d",
    replacement: "$`",
    flags: "g",
    stage: "response" as const,
    enabled: true,
    order: 0,
  };

  test("admits a whole-prefix regex replacement exactly at the operation cap", () => {
    const result = prepareAgentRenderV1(makeInput({
      limits: loweredLimits({ maxOperationBytes: 3 }),
      content: { kind: "text", text: "abcd" },
      regexScripts: [prefixScript],
      formatting: { stripGuidedReasoning: false, healFormatting: false, preserveProviderReasoning: true },
    }));

    expect(result.content).toEqual({ kind: "text", text: "abcabc" });
  });

  test("rejects a whole-prefix replacement at cap plus one before it is built", () => {
    let failure: unknown;
    try {
      prepareAgentRenderV1(makeInput({
        limits: loweredLimits({ maxOperationBytes: 2 }),
        content: { kind: "text", text: "abcd" },
        regexScripts: [prefixScript],
        formatting: { stripGuidedReasoning: false, healFormatting: false, preserveProviderReasoning: true },
      }));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RenderPreparationValidationError);
    expect((failure as RenderPreparationValidationError).code).toBe("limit_exceeded");
    // The preflight path proves the replacement was measured, not allocated.
    expect((failure as RenderPreparationValidationError).path).toBe("regex.prefix.replacement");
  });

  test("refuses a large prefix expansion without allocating it", () => {
    let failure: unknown;
    try {
      prepareAgentRenderV1(makeInput({
        limits: loweredLimits({ maxOperationBytes: 1024 }),
        content: { kind: "text", text: `${"a".repeat(65_536)}d` },
        regexScripts: [prefixScript],
        formatting: { stripGuidedReasoning: false, healFormatting: false, preserveProviderReasoning: true },
      }));
    } catch (error) {
      failure = error;
    }

    expect((failure as RenderPreparationValidationError).code).toBe("limit_exceeded");
    expect((failure as RenderPreparationValidationError).path).toBe("regex.prefix.replacement");
  });

  test("applies formatting healing and bounds its exact growth", () => {
    const raw = '<font color="aaabbb>"Hey there." They said.';
    const healed = healFormattingArtifacts(raw);
    const healedBytes = bytes(healed);
    const tagCount = raw.match(/<font/gi)?.length ?? 0;
    expect(healedBytes).toBeLessThanOrEqual(bytes(raw) + 8 * tagCount);

    const result = prepareAgentRenderV1(makeInput({
      limits: loweredLimits({ maxOperationBytes: healedBytes }),
      content: { kind: "text", text: raw },
      formatting: { stripGuidedReasoning: false, healFormatting: true, preserveProviderReasoning: true },
    }));
    expect(result.content).toEqual({ kind: "text", text: healed });

    expectPreparationFailure(
      () => prepareAgentRenderV1(makeInput({
        limits: loweredLimits({ maxOperationBytes: healedBytes - 1 }),
        content: { kind: "text", text: raw },
        formatting: { stripGuidedReasoning: false, healFormatting: true, preserveProviderReasoning: true },
      })),
      "limit_exceeded",
    );
  });

  test("keeps the healing bound valid for adversarial font markup", () => {
    const raw = "<font>".repeat(64);
    const healed = healFormattingArtifacts(raw);

    expect(bytes(healed)).toBeLessThanOrEqual(bytes(raw) + 8 * 64);
  });
});

describe("strict render closed record validation", () => {
  test("rejects an unknown key in every nested record", () => {
    expectInvalidField({ target: { kind: "normal", forged: true } });
    expectInvalidField({ content: { kind: "text", text: "x", forged: true } });
    expectInvalidField({ content: { kind: "parts", parts: [{ kind: "text", text: "x", forged: true }] } });
    expectInvalidField({
      sourceMessages: [{
        sourceMessageId: "m",
        revision: 1,
        role: "user",
        content: { kind: "text", text: "x" },
        forged: true,
      }],
    });
    expectInvalidField({
      swipes: [{ swipeId: "s", index: 0, revision: 1, content: { kind: "text", text: "x" }, forged: true }],
    });
    expectInvalidField({
      macroSnapshot: { local: [], global: [], chat: [], promptVariables: [], forged: [] },
    });
    expectInvalidField({
      macroSnapshot: {
        local: [],
        global: [],
        chat: [],
        promptVariables: [],
        dependencies: [{ name: "n", purity: "pure", source: "host", forged: true }],
      },
    });
    expectInvalidField({
      regexScripts: [{
        scriptId: "s",
        revision: 1,
        pattern: "a",
        replacement: "b",
        flags: "g",
        stage: "response",
        enabled: true,
        order: 0,
        forged: true,
      }],
    });
    expectInvalidField({
      regexScripts: [{
        scriptId: "s",
        revision: 1,
        pattern: "a",
        replacement: "b",
        flags: "g",
        stage: "response",
        enabled: true,
        order: 0,
        actions: [{ id: "a", type: "send", forged: true }],
      }],
    });
    expectInvalidField({
      formatting: {
        stripGuidedReasoning: true,
        healFormatting: true,
        preserveProviderReasoning: true,
        reasoningDelimiters: { prefix: "<c>", suffix: "</c>", forged: "x" },
      },
    });
    expectInvalidField({
      inputRevisions: { version: 1, revisions: [], digest: "d", forged: true },
    });
    expectInvalidField({
      inputRevisions: {
        version: 1,
        revisions: [{ kind: "target", id: "t", revision: 1, digest: "d", forged: true }],
        digest: "d",
      },
    });
    expectInvalidField({
      deltas: [{ kind: "macro_variable", scope: "local", key: "k", operation: "set", forged: true }],
    });
    expectInvalidField({ forged: true });
  });

  test("rejects untyped reasoning delimiters instead of executing them", () => {
    expectInvalidField({
      formatting: {
        stripGuidedReasoning: true,
        healFormatting: false,
        preserveProviderReasoning: true,
        prefix: "<secret>",
        suffix: "</secret>",
      },
    });

    const result = prepareAgentRenderV1(makeInput({
      content: { kind: "text", text: "<secret>plan</secret>Visible" },
      formatting: {
        stripGuidedReasoning: true,
        healFormatting: false,
        preserveProviderReasoning: true,
        reasoningDelimiters: { prefix: "<secret>", suffix: "</secret>" },
      },
    }));
    expect(result.content).toEqual({ kind: "text", text: "Visible" });
  });

  test("rejects legacy dependency aliases and non-pure declared dependencies", () => {
    expectInvalidField({
      macroSnapshot: {
        local: [],
        global: [],
        chat: [],
        promptVariables: [],
        authoredDependencies: ["lore"],
      },
    });
    expectPreparationFailure(
      () => prepareAgentRenderV1(makeInput({
        macroSnapshot: {
          local: [],
          global: [],
          chat: [],
          promptVariables: [],
          dependencies: [{ name: "lore", purity: "non_pure", source: "extension" }],
        },
      })),
      "requires_response_mode",
    );
  });

  test("applies bounded trims and refuses executable regex actions", () => {
    const script = {
      scriptId: "script",
      revision: 1,
      pattern: "a",
      replacement: "b",
      flags: "g",
      stage: "response" as const,
      enabled: true,
      order: 0,
    };
    const trimmed = prepareAgentRenderV1(makeInput({
      content: { kind: "text", text: "aXX" },
      formatting: { stripGuidedReasoning: false, healFormatting: false, preserveProviderReasoning: true },
      regexScripts: [{ ...script, trimStrings: ["XX"] }],
    }));
    expect(trimmed.content).toEqual({ kind: "text", text: "b" });

    expectInvalidField({ regexScripts: [{ ...script, trimStrings: [""] }] });
    expectPreparationFailure(
      () => prepareAgentRenderV1(makeInput({
        content: { kind: "text", text: "a" },
        regexScripts: [{ ...script, actions: [{ id: "choose", type: "send" }] }],
      })),
      "requires_response_mode",
    );

    const disabled = prepareAgentRenderV1(makeInput({
      content: { kind: "text", text: "a" },
      formatting: { stripGuidedReasoning: false, healFormatting: false, preserveProviderReasoning: true },
      regexScripts: [{ ...script, enabled: false, actions: [{ id: "choose", type: "send" }] }],
    }));
    expect(disabled.content).toEqual({ kind: "text", text: "a" });
  });
});

describe("strict render request validation bounds", () => {
  test("validates a 132KB regenerate-shaped input without hanging", () => {
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
    const started = Date.now();
    const validated = validateRenderPreparationInputV1(makeInput({
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
    }));
    expect(validated.sourceMessages).toHaveLength(129);
    expect(Date.now() - started).toBeLessThan(2_000);
  });



  test("aborts a diamond DAG at the node cap instead of hanging", () => {
    let node: Record<string, unknown> = { v: 0 };
    for (let index = 1; index < 40; index += 1) node = { l: node, r: node };
    const started = Date.now();
    expectPreparationFailure(() => validateRenderPreparationInputV1(node as never), "limit_exceeded");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

