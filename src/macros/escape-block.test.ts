import { describe, expect, test, beforeAll } from "bun:test";
import {
  evaluate,
  initMacros,
  registry,
  restoreLiteralBraces,
  shieldLiteralBraces,
  type MacroEnv,
} from "./index";

// ---------------------------------------------------------------------------
// {{#escape}}...{{/escape}} — a Risu block that must reach the model literally.
//
// The macro emits literal-brace sentinels, not braces, so the macro passes that
// run after it cannot re-expand its body. `render()` is what prompt assembly
// produces for the model: the sentinel form plus the restore that
// `resolvePromptMacrosAfterRegexPass` performs once the passes are finished.
// ---------------------------------------------------------------------------

function makeEnv(): MacroEnv {
  return {
    commit: true,
    names: {
      user: "Alice",
      char: "Bob",
      group: "",
      groupNotMuted: "",
      notChar: "Alice",
      charGroupFocused: "Bob",
      groupOthers: "",
      groupMemberCount: "0",
      isGroupChat: "no",
      isNarrator: "no",
      groupLastSpeaker: "",
      groupCardMode: "solo",
    },
    character: {
      name: "Bob",
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
      messageCount: 1,
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
      model: "test",
      maxPrompt: 0,
      maxContext: 0,
      maxResponse: 0,
      lastGenerationType: "normal",
      isMobile: false,
    },
    variables: {
      local: new Map(Object.entries({ x: "XVALUE" })),
      global: new Map(),
      chat: new Map(),
    },
    dynamicMacros: {},
    extra: { messages: [] },
  };
}

async function ev(template: string, env: MacroEnv = makeEnv()): Promise<string> {
  return (
    await evaluate(template, env, registry, {
      deferLiteralBraceRestore: true,
    })
  ).text;
}

/** The text the model receives: the escaped body with its braces back. */
async function render(template: string, env: MacroEnv = makeEnv()): Promise<string> {
  return restoreLiteralBraces(await ev(template, env));
}

describe("{{#escape}} block", () => {
  beforeAll(() => {
    initMacros();
  });

  test("is registered as a built-in scoped macro that receives the raw body", () => {
    const def = registry.getMacro("escape");
    expect(def?.builtIn).toBe(true);
    // A body that is resolved before the handler sees it would defeat the block.
    expect(def?.delayArgResolution).toBe(true);
    expect(def?.terminal).toBe(true);
  });

  test("emits its body without evaluating macros inside it", async () => {
    const env = makeEnv();
    expect(await render("A{{#escape}}{{user}} + {{getvar::x}}{{/escape}}B", env)).toBe(
      "A{{user}} + {{getvar::x}}B",
    );
    // The same result for the LumiRealm-translated form, which is the one the
    // host receives: {{#escape}} with the named closer.
    expect(await render("{{#escape}}{{user}}{{/escape}}", env)).toBe("{{user}}");
  });

  test("shields the braces so a later macro pass cannot re-expand them", async () => {
    const shielded = await ev("{{#escape}}{{user}}{{/escape}}");
    expect(shielded).toBe(
      shieldLiteralBraces("{{user}}"),
    );
    expect(shielded).not.toContain("{");

    // Re-evaluating the shielded text leaves it inert...
    expect(await ev(shielded)).toBe(shielded);
    // ...even when real macros in the same text are still resolved.
    expect(await render(`{{user}} ${shielded}`)).toBe("Alice {{user}}");
  });

  test("restores literal braces for standalone evaluator consumers", async () => {
    expect(
      (await evaluate("{{#escape}}{{user}}{{/escape}}", makeEnv(), registry))
        .text,
    ).toBe("{{user}}");
  });

  test("does not run side-effect macros inside the body", async () => {
    const env = makeEnv();
    expect(await render("{{#escape}}{{setvar::x::pwned}}{{/escape}}", env)).toBe(
      "{{setvar::x::pwned}}",
    );
    expect(env.variables.local.get("x")).toBe("XVALUE");
  });

  test("keeps a macro-looking body inert inside a template that resolves elsewhere", async () => {
    const env = makeEnv();
    // The evaluator iterates until its output converges; the shielded body must
    // survive that second iteration.
    expect(await render("{{user}}|{{#escape}}{{user}}{{/escape}}|{{user}}", env)).toBe(
      "Alice|{{user}}|Alice",
    );
  });

  test("passes the real Risu token form through byte for byte", async () => {
    // The user's preset wraps a brace-delimited token; single braces are not
    // macro delimiters but must still come out exactly as written.
    expect(await render("A{{#escape}}{bkspc}{{/escape}}B")).toBe("A{bkspc}B");
  });

  test("preserves macro-looking source text byte for byte", async () => {
    expect(
      await render("A{{#escape}}{{ user }}|{{getvar:x}}{{/escape}}B"),
    ).toBe("A{{ user }}|{{getvar:x}}B");
    expect(
      await render(
        "{{#escape}}{{foo::{{bar}}x{{/bar}}}}{{/escape}}",
      ),
    ).toBe("{{foo::{{bar}}x{{/bar}}}}");
  });

  test("accepts the {{escape}} form and Risu's ::keep argument", async () => {
    expect(await render("A{{escape}}{{user}}{{/escape}}B")).toBe("A{{user}}B");
    expect(await render("A{{#escape::keep}}{{user}}{{/escape}}B")).toBe("A{{user}}B");
  });

  test("an empty body resolves to nothing", async () => {
    expect(await render("A{{#escape}}{{/escape}}B")).toBe("AB");
    expect(await render("A{{#escape}}\n\n{{/escape}}B")).toBe("A\n\nB");
  });

  test("a non-scoped {{escape}} is inert", async () => {
    expect(await render("A{{escape}}B")).toBe("AB");
  });

  test("nested escape markers inside a body stay literal text", async () => {
    // The body is opaque: nested openers/closers are never parsed, so they are
    // emitted as the characters the author wrote.
    expect(await render("A{{#escape}}x{{#escape}}y{{/escape}}z{{/escape}}B")).toBe(
      "Ax{{#escape}}y{{/escape}}zB",
    );
  });

  test("escaped braces in a body cannot smuggle a live macro", async () => {
    expect(await render("A{{#escape}}a\\{b\\}c{{/escape}}B")).toBe("Aa{b}cB");
    expect(await render("A{{#escape}}a\\{\\{user\\}\\}b{{/escape}}B")).toBe(
      "Aa{{user}}bB",
    );
  });

  test("restoreLiteralBraces is a no-op for unshielded text", () => {
    expect(restoreLiteralBraces("plain {braces} {{user}}")).toBe(
      "plain {braces} {{user}}",
    );
    expect(restoreLiteralBraces("A\x03B\x04C")).toBe("A\x03B\x04C");
    expect(restoreLiteralBraces(shieldLiteralBraces("{{a}} {{b}}"))).toBe(
      "{{a}} {{b}}",
    );
  });
});
