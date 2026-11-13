import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { initMacros } from "../macros";
import type { MacroEnv } from "../macros";
import type { Message } from "../types/message";
import { resolveAndSanitizeForVectorization } from "./vectorization-content.service";
import {
  __worldInfoVectorQueryTest,
  buildWorldInfoVectorQuery,
  collectVectorActivatedWorldInfoDetailed,
} from "./prompt-assembly.service";

function message(
  index: number,
  content: string,
  extra: Record<string, unknown> = {},
): Message {
  return {
    id: `message-${index}`,
    chat_id: "chat-1",
    index_in_chat: index,
    is_user: index % 2 === 0,
    name: index % 2 === 0 ? "User" : "Character",
    content,
    send_date: index,
    swipe_id: 0,
    swipes: [content],
    swipe_dates: [index],
    extra,
    parent_message_id: null,
    branch_id: null,
    created_at: index,
  };
}

function macroEnv(): MacroEnv {
  return {
    commit: false,
    names: {
      user: "User",
      char: "Character",
      group: "",
      groupNotMuted: "",
      notChar: "",
      charGroupFocused: "",
      groupOthers: "",
      groupMemberCount: "0",
      isGroupChat: "no",
      isNarrator: "no",
      groupLastSpeaker: "",
      groupCardMode: "solo",
    },
    character: {
      name: "Character",
      description: "",
      personality: "",
      scenario: "",
      persona: "",
      personaSubjectivePronoun: "",
      personaObjectivePronoun: "",
      personaPossessivePronoun: "",
      personaReflexivePronoun: "",
      personaPossessivePronounStandalone: "",
      mesExamples: "",
      mesExamplesRaw: "",
      systemPrompt: "",
      postHistoryInstructions: "",
      depthPrompt: "",
      creatorNotes: "",
      version: "",
      creator: "",
      firstMessage: "",
    },
    chat: {
      id: "chat-1",
      messageCount: 0,
      lastMessage: "",
      lastMessageName: "",
      lastUserMessage: "",
      lastCharMessage: "",
      lastMessageId: 0,
      firstIncludedMessageId: 0,
      lastSwipeId: 0,
      currentSwipeId: 0,
      rejectedSwipe: "",
    },
    system: {
      model: "",
      maxPrompt: 0,
      maxContext: 0,
      maxResponse: 0,
      lastGenerationType: "normal",
      isMobile: false,
    },
    variables: {
      local: new Map(),
      global: new Map(),
      chat: new Map(),
    },
    dynamicMacros: {},
    extra: {},
  };
}

describe("world-book vector query scope", () => {
  test("uses Global Scan Depth instead of chat-memory context size", async () => {
    const result = await buildWorldInfoVectorQuery(
      [
        message(0, "oldest visible"),
        message(1, "hidden", { hidden: true }),
        message(2, "   "),
        message(3, "first selected"),
        message(4, "second selected"),
        message(5, "third selected"),
        message(6, "fourth selected"),
      ],
      4,
      null,
    );

    expect(result.queryPreview).not.toContain("oldest visible");
    expect(result.queryPreview).not.toContain("hidden");
    expect(result.queryPreview).toContain("first selected");
    expect(result.queryPreview).toContain("fourth selected");
    expect(result.queryScope).toEqual({
      configuredScanDepth: 4,
      visibleMessagesAvailable: 5,
      messagesSelected: 4,
      maxTokens: 8000,
      tokenTruncated: false,
    });
  });

  test("uses all visible messages for unlimited depth and reports token truncation", async () => {
    const result = await buildWorldInfoVectorQuery(
      [message(0, `old marker ${"a".repeat(25_000)}`), message(1, `new marker ${"b".repeat(10_000)}`)],
      null,
      null,
    );

    expect(result.queryScope.configuredScanDepth).toBeNull();
    expect(result.queryScope.visibleMessagesAvailable).toBe(2);
    expect(result.queryScope.messagesSelected).toBe(2);
    expect(result.queryScope.tokenTruncated).toBe(true);
    expect(result.queryPreview.length).toBe(24_000);
    expect(result.queryPreview).not.toContain("old marker");
    expect(result.queryPreview).toContain("new marker");
  });

  test("skips chat content when no vector entry is eligible", async () => {
    let reads = 0;
    const source = message(0, "unused");
    Object.defineProperty(source, "content", {
      enumerable: true,
      get: () => {
        reads++;
        return "unused";
      },
    });

    const result = await collectVectorActivatedWorldInfoDetailed(
      "user",
      "chat",
      ["book"],
      [{
        id: "entry",
        world_book_id: "book",
        disabled: false,
        vectorized: false,
        content: "memory",
        vector_index_status: "not_enabled",
      } as never],
      [source],
      undefined,
      {},
    );

    expect(result.entries).toEqual([]);
    expect(result.queryScope.messagesSelected).toBe(0);
    expect(reads).toBe(0);
  });

  test("bounded construction is byte-identical to the historical sanitizer pipeline", async () => {
    const cases: Array<{
      messages: Message[];
      depth: number | null;
      reasoning?: { reasoningPrefix: string; reasoningSuffix: string };
    }> = [
      {
        messages: [
          message(0, "<think>private</think>"),
          message(1, "visible"),
          message(2, "<reasoning>unfinished"),
        ],
        depth: null,
      },
      {
        messages: [
          message(0, `old ${"a".repeat(30_000)}`),
          message(1, "<think>private chain</think>kept"),
          message(2, "<details><summary>meta</summary>inside</details>tail"),
          message(3, "newest"),
        ],
        depth: null,
      },
      {
        messages: [
          message(0, "ignored by depth"),
          message(1, "   "),
          message(2, "hidden", { hidden: true }),
          message(3, "<reasoning>unfinished"),
          message(4, `${"b".repeat(24_001)}END`),
        ],
        depth: 2,
      },
      {
        messages: [
          message(0, `prefix ${"x".repeat(23_999)}`),
          message(1, "🙂 surrogate boundary"),
          message(2, "[[private]]remove me[[/private]] visible"),
        ],
        depth: null,
        reasoning: {
          reasoningPrefix: "[[private]]",
          reasoningSuffix: "[[/private]]",
        },
      },
      {
        messages: [
          message(
            0,
            `${"alpha\t beta\n\n\n".repeat(10_000)}${"tail ".repeat(10_000)}`,
          ),
        ],
        depth: null,
      },
    ];

    for (const fixture of cases) {
      const visible = fixture.messages.filter(
        (item) => !item.extra?.hidden && item.content.trim().length > 0,
      );
      const selected = fixture.depth === null
        ? visible
        : visible.slice(-fixture.depth);
      const reference = await __worldInfoVectorQueryTest.buildReference(
        selected,
        null,
        fixture.reasoning,
      );
      const actual = await buildWorldInfoVectorQuery(
        fixture.messages,
        fixture.depth,
        null,
        fixture.reasoning,
      );

      expect(actual.queryPreview).toBe(reference.text);
      expect(actual.queryScope.tokenTruncated).toBe(reference.truncated);
    }
  });

  test("macro-bearing queries retain oldest-to-newest shared-env evaluation", async () => {
    initMacros();
    const messages = [
      message(0, "{{counter::query-order}}"),
      message(1, "x".repeat(25_000)),
      message(2, "{{counter::query-order}}"),
    ];

    const reference = await __worldInfoVectorQueryTest.buildReference(
      messages,
      macroEnv(),
    );
    const actual = await buildWorldInfoVectorQuery(
      messages,
      null,
      macroEnv(),
    );

    expect(actual.queryPreview).toBe(reference.text);
    expect(actual.queryPreview.endsWith("[USER | User]: 2")).toBe(true);
    expect(actual.queryScope.tokenTruncated).toBe(reference.truncated);
  });

  test("reasoning stripping cannot hide a macro from bounded-path classification", async () => {
    initMacros();
    const splitMacro = "{<think>private</think>{counter::split-marker}}";
    const messages = [
      message(0, splitMacro),
      message(1, "x".repeat(25_000)),
      message(2, splitMacro),
    ];

    const reference = await __worldInfoVectorQueryTest.buildReference(
      messages,
      macroEnv(),
    );
    const actual = await buildWorldInfoVectorQuery(
      messages,
      null,
      macroEnv(),
    );

    expect(actual.queryPreview).toBe(reference.text);
    expect(actual.queryPreview.endsWith("[USER | User]: 2")).toBe(true);
  });

  test("oversized plain-message suffixes match the reference sanitizer", async () => {
    const contents = [
      "plain prose ".repeat(2_600),
      "alpha\t \t beta\n\n\n".repeat(1_800),
      `head${"\r\u00a0middle ".repeat(4_000)}tail`,
      "value < 3 and prose ".repeat(1_800),
      `${" ".repeat(30_000)}${"tail ".repeat(5_200)}`,
    ];

    for (const content of contents) {
      const messages = [message(0, content)];
      const reference = await __worldInfoVectorQueryTest.buildReference(
        messages,
        macroEnv(),
      );
      const actual = await buildWorldInfoVectorQuery(
        messages,
        null,
        macroEnv(),
      );

      expect(actual.queryPreview).toBe(reference.text);
      expect(actual.queryScope.tokenTruncated).toBe(reference.truncated);
    }
  });

  test("bounds an oversized older plain message behind recent text", async () => {
    const messages = [
      message(0, "older prose ".repeat(100_000)),
      message(1, "recent text"),
    ];
    const reference = await __worldInfoVectorQueryTest.buildReference(
      messages,
      macroEnv(),
    );
    const actual = await buildWorldInfoVectorQuery(
      messages,
      null,
      macroEnv(),
    );

    expect(actual.queryPreview).toBe(reference.text);
    expect(actual.queryScope.tokenTruncated).toBe(reference.truncated);
  });

  test("leaves scan-excluded text out of the vector query", async () => {
    const result = await buildWorldInfoVectorQuery(
      [
        message(0, "We ride north. <wi-exclude>Tracker: Zebulon</wi-exclude>"),
        message(1, '<div class="tracker" wi-exclude>Off-scene: Mordecai</div>'),
        message(2, "The gate opens."),
      ],
      null,
      null,
    );

    expect(result.queryPreview).toContain("We ride north.");
    expect(result.queryPreview).toContain("The gate opens.");
    expect(result.queryPreview).not.toMatch(/Zebulon|Mordecai|Tracker/);
    expect(result.queryScope.visibleMessagesAvailable).toBe(2);
    expect(result.queryScope.messagesSelected).toBe(2);
  });

  test("keeps canonical content and literal provenance together until formatting", () => {
    const content = "Literal: {{user}} <wi-exclude>Off-scene: Zebulon</wi-exclude>";
    const hash = createHash("sha256").update(content).digest("hex");
    const source = message(0, content, { macro_literal_braces: { [hash]: [9, 10, 15, 16] } });
    const { queryMessages } = __worldInfoVectorQueryTest.selectMessages([source], null);

    expect(queryMessages).toHaveLength(1);
    const selected = queryMessages[0];
    const selectedHash = createHash("sha256").update(selected.content).digest("hex");
    expect(selected.extra.macro_literal_braces[selectedHash]).toEqual([9, 10, 15, 16]);
    expect(selected.content).toBe(source.content);
    expect(source.swipes[0]).toBe(content);
  });

  for (const [kind, tracker] of [
    ["markers", "!--WI_EXCLUDE_START--!Off-scene: Zebulon!--WI_EXCLUDE_END--!"],
    ["inline element", "<span wi-exclude>Off-scene: Zebulon</span>"],
    ["tag", "<wi-exclude>Off-scene: Zebulon</wi-exclude>"],
  ] as const) {
    test(`excludes ${kind} emitted by macros before vector sanitization`, async () => {
      initMacros();
      const env = macroEnv();
      env.variables.chat.set("tracker", tracker);
      const source = message(0, "We ride north. {{getchatvar::tracker}} The gate opens.");
      const result = await buildWorldInfoVectorQuery([source], null, env);

      expect(result.queryPreview).toContain("We ride north.");
      expect(result.queryPreview).toContain("The gate opens.");
      expect(result.queryPreview).not.toMatch(/Zebulon|Off-scene|WI_EXCLUDE/);
      expect(source.content).toBe("We ride north. {{getchatvar::tracker}} The gate opens.");
    });
  }

  test("does not execute macros in excluded source or affect chat-memory sanitization", async () => {
    initMacros();
    const env = macroEnv();
    const source = message(0, "Road. <span wi-exclude>{{setchatvar::owned::yes}}Zebulon</span>");
    const result = await buildWorldInfoVectorQuery([source], null, env);
    expect(result.queryPreview).toContain("Road.");
    expect(result.queryPreview).not.toContain("Zebulon");
    expect(env.variables.chat.has("owned")).toBe(false);
    expect(await resolveAndSanitizeForVectorization("Road. <span wi-exclude>Zebulon</span>", null))
      .toContain("Zebulon");
  });

  test("does not build a query from wholly excluded macro output", async () => {
    initMacros();
    for (const tracker of [
      "!--WI_EXCLUDE_START--!Off-scene: Zebulon!--WI_EXCLUDE_END--!",
      "<span wi-exclude>Off-scene: Zebulon</span>",
    ]) {
      const env = macroEnv();
      env.variables.chat.set("tracker", tracker);
      const result = await buildWorldInfoVectorQuery([message(0, "{{getchatvar::tracker}}")], null, env);
      expect(result.queryPreview).toBe("");
    }
  });

  test("keeps marker-excluded text out of long plain-text messages", async () => {
    const result = await buildWorldInfoVectorQuery(
      [
        message(
          0,
          `${"The caravan rolls on. ".repeat(1_200)}!--WI_EXCLUDE_START--! Tracker: Zebulon !--WI_EXCLUDE_END--!`,
        ),
      ],
      null,
      null,
    );

    expect(result.queryScope.tokenTruncated).toBe(true);
    expect(result.queryPreview).toContain("The caravan rolls on.");
    expect(result.queryPreview).not.toContain("Zebulon");
  });
});
