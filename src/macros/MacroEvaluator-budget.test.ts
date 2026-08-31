import { beforeAll, describe, expect, test } from "bun:test";
import { initMacros } from "./index";
import { evaluate } from "./MacroEvaluator";
import { registry } from "./MacroRegistry";
import type { MacroEnv } from "./types";
import { createExpansionBudget, utf8ByteLength } from "../types/agent-preprocessing";

beforeAll(() => {
  initMacros();
});

function makeEnv(dynamicMacros: MacroEnv["dynamicMacros"] = {}): MacroEnv {
  return {
    commit: true,
    names: {
      user: "User", char: "Character", group: "", groupNotMuted: "", notChar: "",
      charGroupFocused: "", groupOthers: "", groupMemberCount: "0", isGroupChat: "no",
      isNarrator: "no", groupLastSpeaker: "", groupCardMode: "solo",
    },
    character: {
      name: "Character", description: "", personality: "", scenario: "", persona: "",
      personaSubjectivePronoun: "", personaObjectivePronoun: "", personaPossessivePronoun: "",
      personaReflexivePronoun: "", personaPossessivePronounStandalone: "", mesExamples: "",
      mesExamplesRaw: "", systemPrompt: "", postHistoryInstructions: "", depthPrompt: "",
      creatorNotes: "", version: "", creator: "", firstMessage: "",
    },
    chat: {
      id: "chat", messageCount: 0, lastMessage: "", lastMessageName: "", lastUserMessage: "",
      lastCharMessage: "", lastMessageId: -1, firstIncludedMessageId: -1, lastSwipeId: 0,
      currentSwipeId: 0, rejectedSwipe: "",
    },
    system: { model: "test", maxPrompt: 0, maxContext: 0, maxResponse: 0, lastGenerationType: "normal", isMobile: false },
    variables: { local: new Map(), global: new Map(), chat: new Map() },
    dynamicMacros,
    extra: {},
  };
}

describe("macro preprocessing expansion budget", () => {
  test("counts exact UTF-8 bytes for ASCII and multibyte values", async () => {
    expect(utf8ByteLength("abcd")).toBe(4);
    expect(utf8ByteLength("é")).toBe(2);

    const ascii = await evaluate(
      "{{repeat::4::a}}",
      makeEnv(),
      registry,
      { budget: createExpansionBudget({ maxOutputBytes: 4, maxOperationBytes: 4 }) },
    );
    expect(ascii.text).toBe("aaaa");

    const multibyte = await evaluate(
      "{{repeat::2::é}}",
      makeEnv(),
      registry,
      { budget: createExpansionBudget({ maxOutputBytes: 4, maxOperationBytes: 4 }) },
    );
    expect(multibyte.text).toBe("éé");
  });

  test("rejects cap plus one without truncating the result", async () => {
    await expect(
      evaluate(
        "{{repeat::2::é}}",
        makeEnv(),
        registry,
        { budget: createExpansionBudget({ maxOutputBytes: 3, maxOperationBytes: 3 }) },
      ),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  test("keeps per-operation and cumulative expansion limits distinct", async () => {
    const perOperation = await evaluate(
      "{{repeat::2::ab}}{{repeat::2::cd}}",
      makeEnv(),
      registry,
      { budget: createExpansionBudget({ maxOutputBytes: 8, maxOperationBytes: 4, maxCumulativeExpansionBytes: 8 }) },
    );
    expect(perOperation.text).toBe("ababcdcd");

    await expect(
      evaluate(
        "{{repeat::2::ab}}{{repeat::2::cd}}",
        makeEnv(),
        registry,
        { budget: createExpansionBudget({ maxOutputBytes: 8, maxOperationBytes: 4, maxCumulativeExpansionBytes: 7 }) },
      ),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  test("enforces recursive macro resolution count", async () => {
    await expect(
      evaluate(
        "{{space}}{{space}}{{space}}",
        makeEnv(),
        registry,
        { budget: createExpansionBudget({ maxMacroResolutions: 2 }) },
      ),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  test("preflights repeat, join, wrap, replace, and regex expansion", async () => {
    const repeat = await evaluate(
      "{{repeat::3::ab}}",
      makeEnv(),
      registry,
      { budget: createExpansionBudget({ maxOperationBytes: 5 }) },
    );
    expect(repeat.text).toBe("");

    const joined = await evaluate(
      "{{join::,::é::é}}",
      makeEnv(),
      registry,
      { budget: createExpansionBudget({ maxOperationBytes: 5, maxOutputBytes: 5 }) },
    );
    expect(joined.text).toBe("é,é");

    const wrapped = await evaluate(
      "{{wrap::<::>::abc}}",
      makeEnv(),
      registry,
      { budget: createExpansionBudget({ maxOperationBytes: 4 }) },
    );
    expect(wrapped.text).toBe("");

    const replaced = await evaluate(
      "{{replace::a::bbbb::aa}}",
      makeEnv(),
      registry,
      { budget: createExpansionBudget({ maxOperationBytes: 8 }) },
    );
    expect(replaced.text).toBe("bbbbbbbb");

    const regex = await evaluate(
      "{{regex::a::bbbb::aa::g}}",
      makeEnv(),
      registry,
      { budget: createExpansionBudget({ maxOperationBytes: 8, maxOutputBytes: 8 }) },
    );
    expect(regex.text).toBe("bbbbbbbb");
  });

  test("accounts split-surrogate replacement chunks at the exact cap boundary", () => {
    const source = "😀".repeat(2);
    const expected = "\uDE00".repeat(2);

    const exact = createExpansionBudget({ maxOutputBytes: 6, maxOperationBytes: 6 });
    expect(exact.replaceAll(source, "\uD83D", "")).toBe(expected);
    expect(utf8ByteLength(expected)).toBe(6);
    expect(exact.snapshot().cumulativeExpansionBytes).toBe(0);

    const capPlusOne = createExpansionBudget({ maxOutputBytes: 5, maxOperationBytes: 6 });
    expect(() => capPlusOne.replaceAll(source, "\uD83D", "")).toThrow(
      "Preprocessing output_bytes limit exceeded (6 > 5)",
    );
  });

  test("accounts each handler result once after preflighting helper allocations", async () => {
    const result = await evaluate(
      "{{replace::a::bbbb::aa}}",
      makeEnv(),
      registry,
      { budget: createExpansionBudget({ maxOutputBytes: 8, maxOperationBytes: 8, maxCumulativeExpansionBytes: 8 }) },
    );
    expect(result.text).toBe("bbbbbbbb");
    expect(result.diagnostics).toEqual([]);

    const append = createExpansionBudget({ maxOutputBytes: 2, maxOperationBytes: 8 });
    expect(() => append.append(["abc"])).toThrow(
      "Preprocessing output_bytes limit exceeded (3 > 2)",
    );
  });

  test("returns stable failures for oversized literal and final output paths", async () => {
    const literal = await evaluate(
      "abc",
      makeEnv(),
      registry,
      { budget: createExpansionBudget({ maxOutputBytes: 2 }) },
    );
    expect(literal.text).toBe("");
    expect(literal.diagnostics).toContainEqual(expect.objectContaining({ code: "limit_exceeded" }));

    const final = await evaluate(
      "{{space}}",
      makeEnv(),
      registry,
      { budget: createExpansionBudget({ maxOutputBytes: 0 }) },
    );
    expect(final.text).toBe("");
    expect(final.diagnostics).toContainEqual(expect.objectContaining({ code: "limit_exceeded" }));
  });

  test("bounds split item materialization without changing empty-item positions", async () => {
    const preserved = await evaluate("{{split::a,,b::,::1}}", makeEnv(), registry);
    expect(preserved.text).toBe("");
    expect(preserved.diagnostics).toEqual([]);

    const oversized = await evaluate(
      `{{split::${Array.from({ length: 1_001 }, () => "a").join(",")}::,::-1}}`,
      makeEnv(),
      registry,
    );
    expect(oversized.text).toBe("");
    expect(oversized.diagnostics).toContainEqual(expect.objectContaining({
      level: "warn",
      message: "{{split}} capped at 1000 items",
    }));
  });

  test("charges nested handler outputs once at exact UTF-8 cumulative boundaries", async () => {
  const source = "{{if::true}}{{replace::aa::éé::aa}}{{/if}}";
    const expected = "éé";
    const bytesPerHandlerResult = utf8ByteLength(expected);

    const exactBudget = createExpansionBudget({
      maxOutputBytes: bytesPerHandlerResult,
      maxOperationBytes: bytesPerHandlerResult,
      maxCumulativeExpansionBytes: bytesPerHandlerResult * 2,
    });
    const exact = await evaluate(source, makeEnv(), registry, { budget: exactBudget });
    expect(exact.text).toBe(expected);
    expect(exact.diagnostics).toEqual([]);
    expect(exactBudget.snapshot().cumulativeExpansionBytes).toBe(bytesPerHandlerResult * 2);

    await expect(
      evaluate(
        source,
        makeEnv(),
        registry,
        {
          budget: createExpansionBudget({
            maxOutputBytes: bytesPerHandlerResult,
            maxOperationBytes: bytesPerHandlerResult,
            maxCumulativeExpansionBytes: bytesPerHandlerResult * 2 - 1,
          }),
        },
      ),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  test("preflights Unicode case expansion and rejects cumulative cap plus one", async () => {
    const upper = await evaluate(
      "{{upper::ß}}",
      makeEnv(),
      registry,
      { budget: createExpansionBudget({ maxOutputBytes: 2, maxOperationBytes: 2, maxCumulativeExpansionBytes: 2 }) },
    );
    expect(upper.text).toBe("SS");

    const lower = await evaluate(
      "{{lower::ΟΣ}}",
      makeEnv(),
      registry,
      { budget: createExpansionBudget({ maxOutputBytes: 4, maxOperationBytes: 4, maxCumulativeExpansionBytes: 4 }) },
    );
    expect(lower.text).toBe("ος");

    const replacement = await evaluate(
      "{{replace::a::bbbb::aa}}",
      makeEnv(),
      registry,
      { budget: createExpansionBudget({ maxOutputBytes: 8, maxOperationBytes: 8, maxCumulativeExpansionBytes: 7 }) },
    );
    expect(replacement.text).toBe("");
    expect(replacement.diagnostics).toContainEqual(expect.objectContaining({ code: "limit_exceeded" }));
  });

  test("preserves ordinary Response-mode macro output below ceilings", async () => {
    const result = await evaluate(
      "{{upper::hello}} {{join::,::a::b}} {{repeat::2::!}}",
      makeEnv(),
      registry,
      { budget: createExpansionBudget({ maxOutputBytes: 64, maxOperationBytes: 64 }) },
    );
    expect(result.text).toBe("HELLO a,b !!");
    expect(result.diagnostics).toEqual([]);
  });
});
