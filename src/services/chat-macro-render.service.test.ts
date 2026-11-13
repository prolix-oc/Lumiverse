import { describe, expect, test } from "bun:test";
import type { MacroEnv } from "../macros";
import type { Message } from "../types/message";
import { resolveRenderedChatMessages, resolveRenderedMessageContent } from "./chat-macro-render.service";

function makeEnv(): MacroEnv {
  return {
    commit: true,
    names: {
      user: "User",
      char: "Assistant",
      group: "",
      groupNotMuted: "",
      notChar: "User",
      charGroupFocused: "",
      groupOthers: "",
      groupMemberCount: "0",
      isGroupChat: "no",
      isNarrator: "no",
      groupLastSpeaker: "",
      groupCardMode: "solo",
    },
    character: {
      name: "Assistant",
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
      lastMessageId: -1,
      firstIncludedMessageId: -1,
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

function makeMessage(id: string, content: string, isUser: boolean): Message {
  return {
    id,
    chat_id: "chat-1",
    index_in_chat: 0,
    is_user: isUser,
    name: isUser ? "User" : "Assistant",
    content,
    send_date: 0,
    swipe_id: 0,
    swipes: [content],
    swipe_dates: [0],
    extra: {},
    parent_message_id: null,
    branch_id: null,
    created_at: 0,
  };
}

describe("resolveRenderedChatMessages", () => {
  test("resolves user message getters after the reply finishes", async () => {
    const env = makeEnv();
    env.variables.local.set("topic", "starlight");

    const messages = [
      makeMessage("user-1", "Value: {{getvar::topic}}", true),
      makeMessage("assistant-1", "Plain reply", false),
    ];

    const result = await resolveRenderedChatMessages({
      messages,
      messageIds: ["user-1", "assistant-1"],
      macroEnvSeed: env,
    });

    expect(result.resolvedById.get("user-1")).toBe("Value: starlight");
    expect(result.resolvedById.get("assistant-1")).toBe("Plain reply");
  });

  test("strips setter macros while preserving chat-scoped side effects", async () => {
    const messages = [
      makeMessage("user-1", "{{setvar::stance::guard}}{{setgvar::theme::noir}}{{setchatvar::mood::calm}}", true),
      makeMessage("assistant-1", "Mood: {{getchatvar::mood}}, stance: {{getvar::stance}}, theme: {{getgvar::theme}}", false),
    ];

    const result = await resolveRenderedChatMessages({
      messages,
      messageIds: ["user-1", "assistant-1"],
      macroEnvSeed: makeEnv(),
    });

    expect(result.resolvedById.get("user-1")).toBe("");
    expect(result.resolvedById.get("assistant-1")).toBe("Mood: calm, stance: guard, theme: noir");
    expect("localVariables" in result).toBe(false);
    expect(result.globalVariables).toEqual({ theme: "noir" });
    expect(result.chatVariables).toEqual({ mood: "calm" });
  });
});


test("owned message sources survive reconciliation without executing native variables", async () => {
  const env = makeEnv(); env.extra.preserveMessageSource = true;
  const content = '{{setvar::weather::Clear}}|{{getvar::weather}}';
  expect(await resolveRenderedMessageContent(content, env)).toBe(content);
  expect(env.variables.local.size).toBe(0);
  const result = await resolveRenderedChatMessages({
    messages: [makeMessage('owned', content, false)], messageIds: ['owned'], macroEnvSeed: env,
  });
  expect(result.resolvedById.size).toBe(0);
  expect(result.chatVariables).toBeUndefined();
});

describe("<json> blocks in messages", () => {
  // Each string would change if a macro pass, `\{` unescaping, the legacy tag
  // rewrite, or quote healing reached inside the block.
  const block = [
    "<json>",
    "{",
    '  "scene": {',
    '    "note": "{{setvar::x::pwned}}",',
    '    "path": "C:\\\\{dir}",',
    '    "who": "<user>",',
    '    "quote": " padded "',
    "  }",
    "}",
    "</json>",
  ].join("\n");

  test("a valid block stays byte-identical while the rest of the message resolves", async () => {
    const env = makeEnv();

    const resolved = await resolveRenderedMessageContent(`{{user}} says " hi "\n${block}`, env);

    expect(resolved).toBe(`User says "hi"\n${block}`);
    expect(env.variables.local.has("x")).toBe(false);
  });

  test("a block that only becomes JSON once macros run still fills in", async () => {
    const env = makeEnv();
    env.variables.chat.set("state", '{"hp":3}');

    expect(await resolveRenderedMessageContent("<json>{{getchatvar::state}}</json>", env)).toBe(
      '<json>{"hp":3}</json>',
    );
  });

  test("a block between macros stays verbatim while they resolve", async () => {
    const block = '<json>{"who":"{{user}}"}</json>';

    expect(await resolveRenderedMessageContent(`{{user}}${block}{{char}}`, makeEnv())).toBe(`User${block}Assistant`);
  });

  test("a setter that captures a block stores it as inert JSON, numbers as written", async () => {
    const captured = '<json>{ "note": "{{setvar::x::pwned}} <user>", "big": 12345678901234567891, "inf": 1e999 }</json>';
    // Only the string contents change: braces and `<` become escapes.
    const inert = String.raw`<json>{ "note": "\u007b\u007bsetvar::x::pwned\u007d\u007d \u003cuser>", "big": 12345678901234567891, "inf": 1e999 }</json>`;
    const result = await resolveRenderedChatMessages({
      messages: [
        makeMessage("user-1", `{{setchatvar::state}}${captured}{{/setchatvar}}`, true),
        makeMessage("assistant-1", "{{getchatvar::state}}|x={{getvar::x}}", false),
      ],
      messageIds: ["user-1", "assistant-1"],
      macroEnvSeed: makeEnv(),
    });

    expect(result.resolvedById.get("user-1")).toBe("");
    expect(result.chatVariables).toEqual({ state: inert });
    // A plain getter returns it without running the macro text it holds.
    expect(result.resolvedById.get("assistant-1")).toBe(`${inert}|x=`);
  });

  test("a block inside a macro argument is the argument's text, so `}}` in it closes the macro", async () => {
    // As in presets. A JSON macro still reads an argument block that holds no `}}`.
    const content = '{{setchatvar::state::<json>{"b":{"c":1}}</json>}}a={{jsonGet::<json>{"a":2}</json>::a}}';
    const result = await resolveRenderedChatMessages({
      messages: [makeMessage("user-1", content, true)],
      messageIds: ["user-1"],
      macroEnvSeed: makeEnv(),
    });

    expect(result.resolvedById.get("user-1")).toBe("</json>}}a=2");
    expect(result.chatVariables).toEqual({ state: '<json>{"b":{"c":1' });
  });

  test("a block written as a variable name is the name exactly as written, across messages", async () => {
    const setter = '{{setchatvar::<json>"key"</json>::value}}';
    const getter = '{{getchatvar::<json>"key"</json>}}';
    const result = await resolveRenderedChatMessages({
      messages: [makeMessage("user-1", `${setter}${getter}`, true), makeMessage("assistant-1", getter, false)],
      messageIds: ["user-1", "assistant-1"],
      macroEnvSeed: makeEnv(),
    });

    expect(result.resolvedById.get("user-1")).toBe("value");
    expect(result.resolvedById.get("assistant-1")).toBe("value");
    expect(result.chatVariables).toEqual({ '<json>"key"</json>': "value" });
  });

  test("block spellings of a variable name stay distinct", async () => {
    const escaped = String.raw`<json>"\u0061"</json>`;
    const content =
      `{{setchatvar::<json>"a"</json>::1}}{{setchatvar::${escaped}::2}}` +
      `{{getchatvar::<json>"a"</json>}}|{{getchatvar::${escaped}}}`;
    const result = await resolveRenderedChatMessages({
      messages: [makeMessage("user-1", content, true)],
      messageIds: ["user-1"],
      macroEnvSeed: makeEnv(),
    });

    expect(result.resolvedById.get("user-1")).toBe("1|2");
    expect(result.chatVariables).toEqual({ '<json>"a"</json>': "1", [escaped]: "2" });
  });

  test("a variable name taken from a captured block is the block as written, never a placeholder", async () => {
    const content = '{{setchatvar::state}}<json>"{k}"</json>{{/setchatvar}}{{setchatvar::{{getchatvar::state}}::v}}';
    const result = await resolveRenderedChatMessages({
      messages: [makeMessage("user-1", content, true)],
      messageIds: ["user-1"],
      macroEnvSeed: makeEnv(),
    });

    expect(result.resolvedById.get("user-1")).toBe("");
    // The captured value is inert JSON; the name keeps the block's own spelling.
    expect(result.chatVariables).toEqual({ state: String.raw`<json>"\u007bk\u007d"</json>`, '<json>"{k}"</json>': "v" });
    expect(Object.keys(result.chatVariables!).some((name) => name.includes("\x00"))).toBe(false);
  });
});


describe("JSON blocks in scoped string operations", () => {
  test("a scoped regex sees and can hide the real block", async () => {
    expect(await resolveRenderedMessageContent(
      '{{regex::<json>.*</json>::HIDDEN}}<json>{"hp":1}</json>{{/regex}}', makeEnv(),
    )).toBe("HIDDEN");
  });

  test("scoped length measures the real block", async () => {
    const block = '<json>{"hp":1}</json>';
    expect(await resolveRenderedMessageContent(`{{len}}${block}{{/len}}`, makeEnv())).toBe(String(block.length));
  });

  test("regex captures and repeated blocks keep their own macros inert", async () => {
    const block = '<json>{"note":"{{setchatvar::owned::yes}}"}</json>';
    const env = makeEnv();
    expect(await resolveRenderedMessageContent(`{{regex::(<json>.*</json>)::$1$1}}${block}{{/regex}}`, env)).toBe(block + block);
    expect(env.variables.chat.has("owned")).toBe(false);
  });

  test.each(["{{.x ignored ", "{{@x++ ignored ", "{{$.x ignored "])("malformed shorthand %s fails closed", async (prefix) => {
    const block = '<json>{"note":"{{setchatvar::owned::yes}}"}</json>';
    const env = makeEnv();
    expect(await resolveRenderedMessageContent(prefix + block, env)).toBe(prefix + block);
    expect(env.variables.chat.has("owned")).toBe(false);
  });
});
