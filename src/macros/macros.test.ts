import { describe, test, expect, beforeAll } from "bun:test";
import { evaluate } from "./MacroEvaluator";
import { parse } from "./MacroParser";
import { registry } from "./MacroRegistry";
import { withJsonBlocksProtected } from "./json-blocks";
import { initMacros, withPromptBlockContext } from "./index";
import type { MacroEnv } from "./types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEnv(opts: {
  localVars?: Record<string, string>;
  globalVars?: Record<string, string>;
  chatVars?: Record<string, string>;
  messages?: { content: string; name: string; is_user: boolean }[];
  characterTags?: string[];
  chatCreatedAt?: number;
  lastMessageTime?: number;
  worldInfoOutlets?: Record<string, string>;
  personaAddonOutlets?: Record<string, string>;
  rejectedSwipe?: string;
  userInput?: string;
  promptBlock?: MacroEnv["promptBlock"];
  multiplayer?: {
    playerCount: number;
    playerNames: string[];
    hostName: string;
    currentTurnName: string;
    turnStrategy: string;
  };
} = {}): MacroEnv {
  const env: MacroEnv = {
    commit: true,
    names: {
      user: "Alice",
      char: "Bob",
      group: "Bob, Charlie, Dave",
      groupNotMuted: "Bob, Charlie",
      notChar: "Alice",
      charGroupFocused: "Bob",
      groupOthers: "Charlie, Dave",
      groupMemberCount: "3",
      isGroupChat: "yes",
      isNarrator: "no",
      groupLastSpeaker: "Charlie",
      groupCardMode: "swap",
    },
    character: {
      name: "Bob",
      description: "A brave warrior with a heart of gold",
      personality: "Courageous and kind",
      scenario: "In a fantasy kingdom",
      persona: "I am Alice, a mage",
      personaSubjectivePronoun: "she",
      personaObjectivePronoun: "her",
      personaPossessivePronoun: "her",
      personaReflexivePronoun: "herself",
      personaPossessivePronounStandalone: "hers",
      mesExamples: "<START>\n{{user}}: Hi\n{{char}}: Hello!",
      mesExamplesRaw: "<START>\n{{user}}: Hi\n{{char}}: Hello!",
      systemPrompt: "You are Bob.",
      postHistoryInstructions: "Stay in character.",
      depthPrompt: "",
      creatorNotes: "Test character",
      version: "1.0",
      creator: "Tester",
      firstMessage: "Greetings, adventurer!",
    },
    chat: {
      id: "chat-123",
      messageCount: 5,
      lastMessage: "The dragon approaches!",
      lastMessageName: "Bob",
      lastUserMessage: "I draw my sword.",
      lastCharMessage: "The dragon approaches!",
      lastMessageId: 4,
      firstIncludedMessageId: 0,
      lastSwipeId: 0,
      currentSwipeId: 0,
      rejectedSwipe: opts.rejectedSwipe ?? "",
    },
    system: {
      model: "gpt-4",
      maxPrompt: 4096,
      maxContext: 8192,
      maxResponse: 2048,
      lastGenerationType: "normal",
      isMobile: false,
    },
    variables: {
      local: new Map(Object.entries(opts.localVars ?? {})),
      global: new Map(Object.entries(opts.globalVars ?? {})),
      chat: new Map(Object.entries(opts.chatVars ?? {})),
    },
    dynamicMacros: {},
    promptBlock: opts.promptBlock,
    extra: {
      messages: opts.messages ?? [
        { content: "Hello, how are you?", name: "Alice", is_user: true },
        { content: "I'm fine, thanks!", name: "Bob", is_user: false },
        { content: "Let's go on an adventure.", name: "Alice", is_user: true },
        { content: "The forest is dark.", name: "Bob", is_user: false },
        { content: "I draw my sword.", name: "Alice", is_user: true },
      ],
      chatCreatedAt: opts.chatCreatedAt ?? Math.floor(Date.now() / 1000) - 3600,
      lastMessageTime: opts.lastMessageTime,
      characterTags: opts.characterTags ?? ["fantasy", "warrior", "male"],
      worldInfoOutlets: opts.worldInfoOutlets ?? {},
      personaAddonOutlets: opts.personaAddonOutlets ?? {},
      userInput: opts.userInput ?? "",
      ...(opts.multiplayer ? { multiplayer: opts.multiplayer } : {}),
    },
  };
  return env;
}

async function ev(template: string, env?: MacroEnv): Promise<string> {
  const result = await evaluate(template, env ?? makeEnv(), registry);
  return result.text;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  initMacros();
});

describe("Chat transcript examples", () => {
  test("parser and evaluator handle setvar/getvar across chat-style lines", async () => {
    const transcript = [
      "User: {{setvar::scene::lantern-lit alley}}",
      "Assistant: Stored.",
      "User: Recall it: {{getvar::scene}}",
      "Assistant: I remember {{getvar::scene}}.",
    ].join("\n");

    const ast = parse(transcript);
    const macroNames = ast.flatMap((node) =>
      node.type === "macro" ? [node.name] : [],
    );

    expect(macroNames).toEqual(["setvar", "getvar", "getvar"]);
    expect(await ev(transcript, makeEnv())).toBe([
      "User: ",
      "Assistant: Stored.",
      "User: Recall it: lantern-lit alley",
      "Assistant: I remember lantern-lit alley.",
    ].join("\n"));
  });
});

describe("Prompt block placement macros", () => {
  test("reflect the current block configuration only while that block renders", async () => {
    const env = makeEnv();

    expect(
      await ev("{{promptBlockRole}}/{{promptBlockPosition}}/{{promptBlockDepth}}", env),
    ).toBe("//");

    const resolved = await withPromptBlockContext(
      env,
      { role: "assistant_append", position: "in_history", depth: 3 },
      () => ev("{{promptBlockRole}}/{{blockPosition}}/{{prompt_block_depth}}", env),
    );

    expect(resolved).toBe("assistant_append/in_history/3");
    expect(env.promptBlock).toBeUndefined();
  });
});

// ===========================================================================
// EXISTING MACROS — Regression tests
// ===========================================================================

describe("Core primitives", () => {
  test("userInput returns the input-bar draft snapshot", async () => {
    expect(
      await ev("{{userInput}}", makeEnv({ userInput: "Draft text\nwith spacing" })),
    ).toBe("Draft text\nwith spacing");
    expect(await ev("{{user_input}}", makeEnv())).toBe("");
  });

  test("space", async () => {
    expect(await ev("a{{space}}b")).toBe("a b");
  });

  test("newline", async () => {
    expect(await ev("a{{newline}}b")).toBe("a\nb");
  });

  test("noop", async () => {
    expect(await ev("a{{noop}}b")).toBe("ab");
  });

  test("comment", async () => {
    expect(await ev("a{{comment::ignored}}b")).toBe("ab");
  });

  test("// shorthand comment", async () => {
    expect(await ev("a{{// inline comment}}b")).toBe("ab");
  });

  test("trim scoped", async () => {
    expect(await ev("{{trim}}  hello  {{/trim}}")).toBe("hello");
  });

  test("trim scoped with dedent", async () => {
    const result = await ev("{{trim}}\n    line1\n    line2\n{{/trim}}");
    expect(result).toBe("line1\nline2");
  });

  test("#trim preserves whitespace", async () => {
    expect(await ev("{{#trim}}  hello  {{/trim}}")).toBe("  hello  ");
  });

  test("block-style trim matches assembly per-block trim", async () => {
    // A var built inside a {{trim}} block but emitted afterwards. The structural
    // whitespace the author typed around the nested macros no longer leaks into
    // the value (stripArgFraming), so only the lone newline between {{/trim}}
    // and the emit remains. The block-editor preview (resolve with trim) and the
    // dry run (assembly .trim() per block) must agree — both strip that.
    const template = `{{trim}}
{{setvar::cotexpansion::}}
{{setvar::cotexpansion::
  {{join::{{newline}}::
    {{getvar::cotexpansion}}::
    first string
  }}
}}
{{setvar::cotexpansion::
  {{join::{{newline}}::
    {{getvar::cotexpansion}}::
    second string
  }}
}}
{{/trim}}
{{.cotexpansion}}`;
    const raw = await ev(template);
    // Raw resolution (free-form callers, e.g. chat input) keeps the newline the
    // author put between the {{/trim}} and the {{.cotexpansion}} emit.
    expect(raw).toBe("\nfirst string\nsecond string");
    // Block-style normalization (preview `trim: true` / dry run) cleans it.
    expect(raw.trim()).toBe("first string\nsecond string");
  });

  test("reverse", async () => {
    expect(await ev("{{reverse::hello}}")).toBe("olleh");
  });

  test("input", async () => {
    expect(await ev("{{input}}")).toBe("I draw my sword.");
  });

  test("outlet resolves world-info outlet content", async () => {
    const env = makeEnv({ worldInfoOutlets: { dossier: "Known as {{char}}" } });
    expect(await ev("{{outlet::dossier}}", env)).toBe("Known as Bob");
  });

  test("outlet lookup is case-insensitive", async () => {
    const env = makeEnv({ worldInfoOutlets: { dossier: "Hello {{user}}" } });
    expect(await ev("{{outlet::DOSSIER}}", env)).toBe("Hello Alice");
  });

  test("persona outlets use their own namespace", async () => {
    const env = makeEnv({
      worldInfoOutlets: { dossier: "World info" },
      personaAddonOutlets: { dossier: "Persona note for {{char}}" },
    });

    expect(await ev("{{outlet::dossier}}", env)).toBe("World info");
    expect(await ev("{{persona_outlet::DOSSIER}}", env)).toBe("Persona note for Bob");
    expect(await ev("{{personaOutlet::dossier}}", env)).toBe("Persona note for Bob");
  });
});

describe("Persona pronoun macros", () => {
  test("JanitorAI persona pronouns resolve", async () => {
    expect(await ev("{{sub}}/{{obj}}/{{poss}}/{{ref}}/{{poss_p}}")).toBe("she/her/her/herself/hers");
  });

  test("explicit persona pronoun aliases resolve", async () => {
    expect(await ev("{{subjectivePronoun}} {{objectivePronoun}} {{possessivePronoun}}")).toBe("she her her");
    expect(await ev("{{reflexivePronoun}} {{possessivePronounStandalone}}")).toBe("herself hers");
  });
});

describe("Character Tags macros", () => {
  test("charTags and tags alias return a clean list", async () => {
    expect(await ev("{{charTags}}")).toBe("fantasy, warrior, male");
    expect(await ev("{{tags}}")).toBe("fantasy, warrior, male");
  });

  test("tag indexes support positive, negative, and out-of-range access", async () => {
    expect(await ev("{{tag::0}}")).toBe("fantasy");
    expect(await ev("{{tag::2}}")).toBe("male");
    expect(await ev("{{tag::-1}}")).toBe("male");
    expect(await ev("{{tag::-3}}")).toBe("fantasy");
    expect(await ev("{{tag::5}}")).toBe("");
  });

  test("tag aliases resolve indexed tags", async () => {
    expect(await ev("{{tagAt::1}}")).toBe("warrior");
    expect(await ev("{{charTagAt::2}}")).toBe("male");
    expect(await ev("{{nthTag::-1}}")).toBe("male");
  });

  test("tagCount and numTags alias count character tags", async () => {
    expect(await ev("{{tagCount}}")).toBe("3");
    expect(await ev("{{numTags}}")).toBe("3");
  });

  test("randomTag returns one of the character tags", async () => {
    expect(["fantasy", "warrior", "male"]).toContain(await ev("{{randomTag}}"));
  });

  test("hasTag is case-insensitive and condition-compatible", async () => {
    expect(await ev("{{hasTag::fantasy}}")).toBe("true");
    expect(await ev("{{hasTag::WARRIOR}}")).toBe("true");
    expect(await ev("{{hasTag::scifi}}")).toBe("");
    expect(await ev("{{tagged::male}}")).toBe("true");
    expect(await ev("{{if::{{hasTag::fantasy}}}}has{{/if}}")).toBe("has");
  });

  test("charTags composes with list macros", async () => {
    expect(await ev("{{count::{{charTags}}}}")).toBe("3");
    expect(await ev("{{first::{{charTags}}}}")).toBe("fantasy");
    expect(await ev("{{includes::{{charTags}}::warrior}}")).toBe("true");
  });

  test("empty character tags produce empty-friendly results", async () => {
    const env = makeEnv({ characterTags: [] });
    expect(await ev("{{charTags}}", env)).toBe("");
    expect(await ev("{{tagCount}}", env)).toBe("0");
    expect(await ev("{{tag::0}}", env)).toBe("");
    expect(await ev("{{randomTag}}", env)).toBe("");
    expect(await ev("{{hasTag::anything}}", env)).toBe("");
  });
  test("non-string tag entries are ignored without throwing", async () => {
    const env = makeEnv({
      characterTags: ["fantasy", 3, null, "warrior", "  "] as unknown as string[],
    });
    expect(await ev("{{charTags}}", env)).toBe("fantasy, warrior");
    expect(await ev("{{tagCount}}", env)).toBe("2");
    expect(await ev("{{tag::1}}", env)).toBe("warrior");
    expect(await ev("{{hasTag::warrior}}", env)).toBe("true");
  });
});

describe("if / else", () => {
  test("truthy condition with ::", async () => {
    expect(await ev("{{if::1}}yes{{/if}}")).toBe("yes");
  });

  test("falsy condition", async () => {
    expect(await ev("{{if::0}}yes{{/if}}")).toBe("");
  });

  test("else branch", async () => {
    expect(await ev("{{if::0}}yes{{else}}no{{/if}}")).toBe("no");
  });

  test("comparison ==", async () => {
    expect(await ev("{{if::5 == 5}}eq{{/if}}")).toBe("eq");
  });

  test("comparison !=", async () => {
    expect(await ev("{{if::5 != 3}}ne{{/if}}")).toBe("ne");
  });

  test("comparison >", async () => {
    expect(await ev("{{if::10 > 5}}gt{{/if}}")).toBe("gt");
  });

  test("falsy strings", async () => {
    expect(await ev("{{if::false}}yes{{else}}no{{/if}}")).toBe("no");
    expect(await ev("{{if::null}}yes{{else}}no{{/if}}")).toBe("no");
    expect(await ev("{{if::undefined}}yes{{else}}no{{/if}}")).toBe("no");
  });

  test("literal 'no' / 'off' are falsy (case-insensitive)", async () => {
    expect(await ev("{{if::no}}T{{else}}F{{/if}}")).toBe("F");
    expect(await ev("{{if::No}}T{{else}}F{{/if}}")).toBe("F");
    expect(await ev("{{if::NO}}T{{else}}F{{/if}}")).toBe("F");
    expect(await ev("{{if::off}}T{{else}}F{{/if}}")).toBe("F");
    expect(await ev("{{if::Off}}T{{else}}F{{/if}}")).toBe("F");
  });

  test("literal 'yes' / 'on' are truthy (mirror of yes/no convention)", async () => {
    expect(await ev("{{if::yes}}T{{else}}F{{/if}}")).toBe("T");
    expect(await ev("{{if::Yes}}T{{else}}F{{/if}}")).toBe("T");
    expect(await ev("{{if::on}}T{{else}}F{{/if}}")).toBe("T");
  });

  test("non-scoped if returns 'true' or ''", async () => {
    expect(await ev("{{if::1}}")).toBe("true");
    expect(await ev("{{if::0}}")).toBe("");
  });

  // ST compat: space-delimited args
  test("if with space arg", async () => {
    expect(await ev("{{if 1}}yes{{/if}}")).toBe("yes");
  });

  test("if with space comparison", async () => {
    expect(await ev("{{if 10 > 5}}yes{{/if}}")).toBe("yes");
  });

  // ST compat: ! negation
  test("if with ! negation", async () => {
    expect(await ev("{{if::!0}}yes{{/if}}")).toBe("yes");
    expect(await ev("{{if::!1}}yes{{else}}no{{/if}}")).toBe("no");
  });

  // ST compat: .var in conditions
  test("if with .var shorthand", async () => {
    const env = makeEnv({ localVars: { score: "42" } });
    expect(await ev("{{if .score}}has score{{/if}}", env)).toBe("has score");
  });

  test("if with .var comparison", async () => {
    const env = makeEnv({ localVars: { x: "10" } });
    expect(await ev("{{if .x == 10}}match{{/if}}", env)).toBe("match");
  });

  test("if with !.var negation", async () => {
    const env = makeEnv({ localVars: { flag: "0" } });
    expect(await ev("{{if::!.flag}}is falsy{{/if}}", env)).toBe("is falsy");
  });

  test("scoped if does not execute false branch side effects", async () => {
    const env = makeEnv({ localVars: { diceroll_setup: "true" }, chatVars: { runs: "0" } });
    await ev("{{if !.diceroll_setup}}{{addchatvar::runs::1}}{{/if}}", env);
    expect(env.variables.chat.get("runs")).toBe("0");
  });

  test("single-pass if guard with local flag only runs setup once", async () => {
    const env = makeEnv({ chatVars: { runs: "0" } });
    const template = `{{if !.diceroll_setup}}
{{setchatvar::pov::1stW}}
{{setchatvar::prose::ClinicW}}
{{setchatvar::lens::HedonismW}}
{{setchatvar::tone::SultryW}}
{{setchatvar::sex::CrashW}}
{{addchatvar::runs::1}}

{{.diceroll_setup = true}}
{{/if}}`;

    await ev(template, env);
    expect(env.variables.chat.get("pov")).toBe("1stW");
    expect(env.variables.chat.get("prose")).toBe("ClinicW");
    expect(env.variables.chat.get("lens")).toBe("HedonismW");
    expect(env.variables.chat.get("tone")).toBe("SultryW");
    expect(env.variables.chat.get("sex")).toBe("CrashW");
    expect(env.variables.chat.get("runs")).toBe("1");
    expect(env.variables.local.get("diceroll_setup")).toBe("true");

    await ev(template, env);
    expect(env.variables.chat.get("runs")).toBe("1");
  });

  test("if with $gvar shorthand", async () => {
    const env = makeEnv({ globalVars: { mode: "dark" } });
    expect(await ev("{{if $mode}}has mode{{/if}}", env)).toBe("has mode");
  });

  test("if supports elseif / elif chains", async () => {
    expect(
      await ev("{{if::false}}A{{elseif::0}}B{{elseif::yes}}C{{else}}D{{/if}}"),
    ).toBe("C");
    expect(
      await ev("{{if::false}}A{{elif::true}}B{{else}}C{{/if}}"),
    ).toBe("B");
  });

  test("unless inverts a condition and supports else", async () => {
    expect(await ev("{{unless::{{isGroupChat}}}}solo{{else}}group{{/unless}}")).toBe("group");
    expect(await ev("{{unless::0}}hidden{{else}}shown{{/unless}}")).toBe("hidden");
    expect(await ev("{{unless::true}}hidden{{else}}shown{{/unless}}")).toBe("shown");
  });
});

describe("Variables", () => {
  test("setvar and getvar with ::", async () => {
    expect(await ev("{{setvar::key::hello}}{{getvar::key}}")).toBe("hello");
  });

  test("setvar and getvar with spaces", async () => {
    expect(await ev("{{setvar key hello}}{{getvar key}}")).toBe("hello");
  });

  test("incvar / decvar", async () => {
    const env = makeEnv({ localVars: { n: "5" } });
    await ev("{{incvar::n}}", env);
    expect(env.variables.local.get("n")).toBe("6");
    await ev("{{decvar::n}}", env);
    expect(env.variables.local.get("n")).toBe("5");
  });

  test(".var shorthand read", async () => {
    const env = makeEnv({ localVars: { name: "World" } });
    expect(await ev("Hello, {{.name}}!", env)).toBe("Hello, World!");
  });

  test("$var shorthand read", async () => {
    const env = makeEnv({ globalVars: { greeting: "Howdy" } });
    expect(await ev("{{$greeting}} partner!", env)).toBe("Howdy partner!");
  });

  test(".var = assignment", async () => {
    const env = makeEnv();
    await ev("{{.x = 42}}", env);
    expect(env.variables.local.get("x")).toBe("42");
  });

  test(".var++ increment", async () => {
    const env = makeEnv({ localVars: { n: "10" } });
    await ev("{{.n++}}", env);
    expect(env.variables.local.get("n")).toBe("11");
  });

  test(".var -= subtraction (fixed)", async () => {
    const env = makeEnv({ localVars: { hp: "100" } });
    await ev("{{.hp -= 25}}", env);
    expect(env.variables.local.get("hp")).toBe("75");
  });

  test("hasvar / deletevar", async () => {
    const env = makeEnv({ localVars: { temp: "yes" } });
    expect(await ev("{{hasvar::temp}}", env)).toBe("true");
    await ev("{{deletevar::temp}}", env);
    expect(await ev("{{hasvar::temp}}", env)).toBe("false");
  });

  test("global vars: setgvar and getgvar", async () => {
    const env = makeEnv();
    await ev("{{setgvar::theme::dark}}", env);
    expect(await ev("{{getgvar::theme}}", env)).toBe("dark");
  });

  test("let binds scoped local variables and restores previous values", async () => {
    const env = makeEnv({ localVars: { name: "outer" } });
    expect(
      await ev("{{let::name::inner::role::mage}}{{.name}}/{{.role}}{{/let}}|{{.name}}/{{.role}}", env),
    ).toBe("inner/mage|outer/");
    expect(env.variables.local.get("name")).toBe("outer");
    expect(env.variables.local.has("role")).toBe(false);
  });
});

describe("Chat-scoped persisted variables", () => {
  test("setchatvar and getchatvar with ::", async () => {
    const env = makeEnv();
    await ev("{{setchatvar::hp::100}}", env);
    expect(await ev("{{getchatvar::hp}}", env)).toBe("100");
  });

  test("@var shorthand read", async () => {
    const env = makeEnv({ chatVars: { score: "42" } });
    expect(await ev("Score: {{@score}}", env)).toBe("Score: 42");
  });

  test("@var = assignment", async () => {
    const env = makeEnv();
    await ev("{{@hp = 100}}", env);
    expect(env.variables.chat.get("hp")).toBe("100");
    expect(env._chatVarsDirty).toBe(true);
  });

  test("@var++ increment", async () => {
    const env = makeEnv({ chatVars: { turn: "5" } });
    await ev("{{@turn++}}", env);
    expect(env.variables.chat.get("turn")).toBe("6");
    expect(env._chatVarsDirty).toBe(true);
  });

  test("@var-- decrement", async () => {
    const env = makeEnv({ chatVars: { lives: "3" } });
    await ev("{{@lives--}}", env);
    expect(env.variables.chat.get("lives")).toBe("2");
  });

  test("@var += addition", async () => {
    const env = makeEnv({ chatVars: { xp: "50" } });
    await ev("{{@xp += 25}}", env);
    expect(env.variables.chat.get("xp")).toBe("75");
  });

  test("@var -= subtraction", async () => {
    const env = makeEnv({ chatVars: { hp: "100" } });
    await ev("{{@hp -= 30}}", env);
    expect(env.variables.chat.get("hp")).toBe("70");
  });

  test("incchatvar returns new value", async () => {
    const env = makeEnv({ chatVars: { counter: "0" } });
    expect(await ev("{{incchatvar::counter}}", env)).toBe("1");
    expect(await ev("{{incchatvar::counter}}", env)).toBe("2");
  });

  test("addchatvar returns new value", async () => {
    const env = makeEnv({ chatVars: { gold: "100" } });
    expect(await ev("{{addchatvar::gold::50}}", env)).toBe("150");
  });

  test("haschatvar / deletechatvar", async () => {
    const env = makeEnv({ chatVars: { quest: "active" } });
    expect(await ev("{{haschatvar::quest}}", env)).toBe("true");
    await ev("{{deletechatvar::quest}}", env);
    expect(await ev("{{haschatvar::quest}}", env)).toBe("false");
  });

  test("chat vars are independent from local vars", async () => {
    const env = makeEnv({ localVars: { x: "local" }, chatVars: { x: "chat" } });
    expect(await ev("{{.x}}", env)).toBe("local");
    expect(await ev("{{@x}}", env)).toBe("chat");
  });

  test("nested macro in @var assignment", async () => {
    const env = makeEnv({ chatVars: { count: "0" } });
    await ev("{{@n = {{incchatvar::count}} }}", env);
    expect(env.variables.chat.get("n")).toBe("1");
    expect(env.variables.chat.get("count")).toBe("1");
  });

  test("@var in if condition", async () => {
    const env = makeEnv({ chatVars: { alive: "true" } });
    expect(await ev("{{if @alive}}yes{{/if}}", env)).toBe("yes");
  });

  test("_chatVarsDirty not set on read-only access", async () => {
    const env = makeEnv({ chatVars: { x: "1" } });
    await ev("{{@x}}", env);
    expect(env._chatVarsDirty).toBeUndefined();
  });
});

describe("Macro execution mode", () => {
  test("custom macro sees committing execution by default", async () => {
    const name = `test_commit_${crypto.randomUUID()}`;
    registry.registerMacro({
      name,
      category: "Test",
      description: "Returns current commit mode",
      returnType: "string",
      handler: (ctx) => (ctx.commit ? "commit" : "dry"),
    });

    try {
      expect(await ev(`{{${name}}}`)).toBe("commit");
    } finally {
      registry.unregisterMacro(name);
    }
  });

  test("custom macro sees dry execution when env.commit is false", async () => {
    const name = `test_dry_${crypto.randomUUID()}`;
    registry.registerMacro({
      name,
      category: "Test",
      description: "Returns current commit mode",
      returnType: "string",
      handler: (ctx) => (ctx.commit ? "commit" : "dry"),
    });

    try {
      const env = makeEnv();
      env.commit = false;
      expect(await ev(`{{${name}}}`, env)).toBe("dry");
    } finally {
      registry.unregisterMacro(name);
    }
  });
});

describe("Identity macros", () => {
  test("user / char", async () => {
    expect(await ev("{{user}} and {{char}}")).toBe("Alice and Bob");
  });

  test("group", async () => {
    expect(await ev("{{group}}")).toBe("Bob, Charlie, Dave");
  });

  test("isGroupChat", async () => {
    expect(await ev("{{isGroupChat}}")).toBe("yes");
  });

  test("groupCardMode reads the env.names value", async () => {
    for (const mode of ["solo", "swap", "merge", "merge_ignore_muted"]) {
      const env = makeEnv();
      env.names.groupCardMode = mode;
      expect(await ev("{{groupCardMode}}", env)).toBe(mode);
    }
  });

  test("group_card_mode alias resolves the same value", async () => {
    const env = makeEnv();
    env.names.groupCardMode = "merge";
    expect(await ev("{{group_card_mode}}", env)).toBe("merge");
  });

  test("groupCardMode drives a four-way conditional template", async () => {
    const template = "{{if::{{groupCardMode}} == solo}}SOLO{{else}}{{if::{{groupCardMode}} == swap}}SWAP{{else}}{{if::{{groupCardMode}} == merge_ignore_muted}}MERGE_MUTED{{else}}MERGE{{/if}}{{/if}}{{/if}}";

    const cases: Array<{ mode: string; expected: string }> = [
      { mode: "solo", expected: "SOLO" },
      { mode: "swap", expected: "SWAP" },
      { mode: "merge", expected: "MERGE" },
      { mode: "merge_ignore_muted", expected: "MERGE_MUTED" },
    ];

    for (const c of cases) {
      const env = makeEnv();
      env.names.groupCardMode = c.mode;
      expect(await ev(template, env)).toBe(c.expected);
    }
  });
});

describe("Chat macros", () => {
  test("lastMessage", async () => {
    expect(await ev("{{lastMessage}}")).toBe("The dragon approaches!");
  });

  test("messageCount", async () => {
    expect(await ev("{{messageCount}}")).toBe("5");
  });

  test("chatId", async () => {
    expect(await ev("{{chatId}}")).toBe("chat-123");
  });

  test("rejectedSwipe exposes the regenerate target content", async () => {
    const env = makeEnv({ rejectedSwipe: "Yes I am!" });
    expect(await ev("{{rejectedSwipe}}", env)).toBe("Yes I am!");
    expect(await ev("{{rejectedGeneration}}", env)).toBe("Yes I am!");
    expect(await ev("{{regeneratedMessage}}", env)).toBe("Yes I am!");
  });
});

describe("Time macros", () => {
  test("date returns a formatted date string", async () => {
    const result = await ev("{{date}}");
    // Should contain the current year
    expect(result).toContain(String(new Date().getFullYear()));
  });

  test("weekday returns a day name", async () => {
    const result = await ev("{{weekday}}");
    expect(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]).toContain(result);
  });

  test("isodate returns YYYY-MM-DD format", async () => {
    const result = await ev("{{isodate}}");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("Random macros", () => {
  test("random integer range", async () => {
    const result = parseInt(await ev("{{random::1::10}}"), 10);
    expect(result).toBeGreaterThanOrEqual(1);
    expect(result).toBeLessThanOrEqual(10);
  });

  test("roll dice", async () => {
    const result = parseInt(await ev("{{roll::2d6}}"), 10);
    expect(result).toBeGreaterThanOrEqual(2);
    expect(result).toBeLessThanOrEqual(12);
  });
});

describe("Legacy syntax", () => {
  test("<USER> and <BOT> conversion", async () => {
    expect(await ev("<USER> meets <BOT>")).toBe("Alice meets Bob");
  });
});

// ===========================================================================
// NEW MACROS — String
// ===========================================================================

describe("String macros", () => {
  test("len inline", async () => {
    expect(await ev("{{len::hello}}")).toBe("5");
  });

  test("len scoped", async () => {
    expect(await ev("{{len}}hello world{{/len}}")).toBe("11");
  });

  test("len with nested macro", async () => {
    expect(await ev("{{len::{{char}}}}")).toBe("3"); // "Bob" = 3
  });

  test("upper inline", async () => {
    expect(await ev("{{upper::hello}}")).toBe("HELLO");
  });

  test("upper scoped", async () => {
    expect(await ev("{{upper}}hello world{{/upper}}")).toBe("HELLO WORLD");
  });

  test("lower", async () => {
    expect(await ev("{{lower::HELLO}}")).toBe("hello");
  });

  test("capitalize", async () => {
    expect(await ev("{{capitalize::dark elf}}")).toBe("Dark elf");
  });

  test("capitalize empty", async () => {
    expect(await ev("{{capitalize::}}")).toBe("");
  });

  test("replace", async () => {
    expect(await ev("{{replace::world::earth::hello world}}")).toBe("hello earth");
  });

  test("replace scoped", async () => {
    expect(await ev("{{replace::a::b}}banana{{/replace}}")).toBe("bbnbnb");
  });

  test("replace all occurrences", async () => {
    expect(await ev("{{replace::o::0::foo boo}}")).toBe("f00 b00");
  });

  test("substr basic", async () => {
    expect(await ev("{{substr::hello world::0::5}}")).toBe("hello");
  });

  test("substr no end", async () => {
    expect(await ev("{{substr::hello world::6}}")).toBe("world");
  });

  test("split", async () => {
    expect(await ev("{{split::a,b,c::,::1}}")).toBe("b");
  });

  test("split negative index", async () => {
    expect(await ev("{{split::a,b,c::,::-1}}")).toBe("c");
  });

  test("join", async () => {
    expect(await ev("{{join::, ::one::two::three}}")).toBe("one, two, three");
  });

  test("join filters empty", async () => {
    expect(await ev("{{join:: | ::a::::b}}")).toBe("a | b");
  });

  test("join trims items and drops whitespace-only items", async () => {
    // Separator whitespace is preserved; per-item structural whitespace is not.
    expect(await ev("{{join::, ::  a  ::\n  b\n::   }}")).toBe("a, b");
  });

  test("join across indented lines does not leak newlines (regression)", async () => {
    const template = `{{trim}}
{{setvar::cotexpansion::}}
{{setvar::cotexpansion::
  {{join::{{newline}}::
    {{getvar::cotexpansion}}::
    first string
  }}
}}
{{setvar::cotexpansion::
  {{join::{{newline}}::
    {{getvar::cotexpansion}}::
    second string
  }}
}}
{{.cotexpansion}}
{{/trim}}`;
    expect(await ev(template)).toBe("first string\nsecond string");
  });

  test("nested macro on its own line stores same value as inline (regression)", async () => {
    // The structural whitespace between `setvar::key::` and a nested macro laid
    // out on the next line must NOT leak into the stored value — building the
    // var with the {{join}} on its own indented line ("A") must match building
    // it inline after the `::` ("B"). The {{newline}} separator is preserved.
    const buildAndGet = async (open: string) => {
      const env = makeEnv();
      await ev(
        `${open}::{{newline}}::
    {{getvar::acc}}::
Test String
  }}
}}`,
        env,
      );
      return env.variables.local.get('acc')
    };
    const a = await buildAndGet('{{setvar::acc::\n  {{join'); // join on next line
    const b = await buildAndGet('{{setvar::acc::{{join');      // join inline
    expect(a).toBe('Test String');
    expect(b).toBe('Test String');
    expect(a).toBe(b);
  });

  test("repeat", async () => {
    expect(await ev("{{repeat::3::ha}}")).toBe("hahaha");
  });

  test("repeat scoped", async () => {
    expect(await ev("{{repeat::2}}ab{{/repeat}}")).toBe("abab");
  });

  test("repeat zero", async () => {
    expect(await ev("{{repeat::0::text}}")).toBe("");
  });

  test("repeat capped at 1000", async () => {
    const result = await ev("{{repeat::9999::x}}");
    expect(result.length).toBe(1000);
  });

  test("wrap non-empty", async () => {
    expect(await ev("{{wrap::[::]::hello}}")).toBe("[hello]");
  });

  test("wrap empty returns empty", async () => {
    expect(await ev("{{wrap::[::]::}}")).toBe("");
  });

  test("wrap scoped", async () => {
    expect(await ev("{{wrap::(::)}}text{{/wrap}}")).toBe("(text)");
  });

  test("regex basic", async () => {
    expect(await ev("{{regex::\\d+::NUM::abc123def456}}")).toBe("abcNUMdefNUM");
  });

  test("regex with capture groups", async () => {
    expect(await ev("{{regex::(\\w+)@(\\w+)::$1 at $2::user@host}}")).toBe("user at host");
  });

  test("regex invalid pattern returns text", async () => {
    expect(await ev("{{regex::[invalid::x::hello}}")).toBe("hello");
  });

  test("tokenCount", async () => {
    // 20 chars → ceil(20/4) = 5
    expect(await ev("{{tokenCount::12345678901234567890}}")).toBe("5");
  });

  test("truncate short text unchanged", async () => {
    expect(await ev("{{truncate::hello::100}}")).toBe("hello");
  });

  test("truncate with zero tokens returns empty text", async () => {
    expect(await ev("{{truncate::hello world::0}}")).toBe("");
  });

  test("truncate long text", async () => {
    const longText = "word ".repeat(100).trim(); // 499 chars
    const result = await ev(`{{truncate::${longText}::10}}`); // 10 tokens ≈ 40 chars
    expect(result.length).toBeLessThan(60);
    expect(result.endsWith("...")).toBe(true);
  });
});

// ===========================================================================
// NEW MACROS — Math
// ===========================================================================

describe("Math macros", () => {
  test("calc basic addition", async () => {
    expect(await ev("{{calc::2 + 3}}")).toBe("5");
  });

  test("calc multiplication precedence", async () => {
    expect(await ev("{{calc::2 + 3 * 4}}")).toBe("14");
  });

  test("calc parentheses", async () => {
    expect(await ev("{{calc::(2 + 3) * 4}}")).toBe("20");
  });

  test("calc division", async () => {
    expect(await ev("{{calc::10 / 4}}")).toBe("2.5");
  });

  test("calc division by zero", async () => {
    expect(await ev("{{calc::5 / 0}}")).toBe("0");
  });

  test("calc modulo", async () => {
    expect(await ev("{{calc::10 % 3}}")).toBe("1");
  });

  test("calc unary minus", async () => {
    expect(await ev("{{calc::-5 + 3}}")).toBe("-2");
  });

  test("calc nested parens", async () => {
    expect(await ev("{{calc::((1 + 2) * (3 + 4))}}")).toBe("21");
  });

  test("calc empty expression", async () => {
    expect(await ev("{{calc::}}")).toBe("0");
  });

  test("calc rejects trailing or incomplete expressions", async () => {
    expect(await ev("{{calc::2 + 3xyz}}")).toBe("0");
    expect(await ev("{{calc::2(3)}}")).toBe("0");
    expect(await ev("{{calc::(2 + 3}}")).toBe("0");
  });

  test("calc with nested macro", async () => {
    const env = makeEnv({ localVars: { x: "10" } });
    expect(await ev("{{calc::{{.x}} * 2}}", env)).toBe("20");
  });

  test("min", async () => {
    expect(await ev("{{min::5::3::8::1}}")).toBe("1");
  });

  test("max", async () => {
    expect(await ev("{{max::5::3::8::1}}")).toBe("8");
  });

  test("clamp within range", async () => {
    expect(await ev("{{clamp::5::0::10}}")).toBe("5");
  });

  test("clamp below", async () => {
    expect(await ev("{{clamp::-5::0::10}}")).toBe("0");
  });

  test("clamp above", async () => {
    expect(await ev("{{clamp::15::0::10}}")).toBe("10");
  });

  test("abs positive", async () => {
    expect(await ev("{{abs::5}}")).toBe("5");
  });

  test("abs negative", async () => {
    expect(await ev("{{abs::-7}}")).toBe("7");
  });

  test("floor", async () => {
    expect(await ev("{{floor::3.7}}")).toBe("3");
    expect(await ev("{{floor::-1.2}}")).toBe("-2");
  });

  test("ceil", async () => {
    expect(await ev("{{ceil::3.2}}")).toBe("4");
    expect(await ev("{{ceil::-1.8}}")).toBe("-1");
  });

  test("mod", async () => {
    expect(await ev("{{mod::17::5}}")).toBe("2");
  });

  test("mod by zero", async () => {
    expect(await ev("{{mod::10::0}}")).toBe("0");
  });

  test("round default 0 decimals", async () => {
    expect(await ev("{{round::3.7}}")).toBe("4");
  });

  test("round to 2 decimals", async () => {
    expect(await ev("{{round::3.14159::2}}")).toBe("3.14");
  });
});

// ===========================================================================
// NEW MACROS — Logic
// ===========================================================================

describe("Logic macros", () => {
  test("switch match", async () => {
    expect(await ev("{{switch::b::a::Alpha::b::Beta::Default}}")).toBe("Beta");
  });

  test("switch default", async () => {
    expect(await ev("{{switch::z::a::Alpha::b::Beta::Default}}")).toBe("Default");
  });

  test("switch no default, no match", async () => {
    expect(await ev("{{switch::z::a::Alpha::b::Beta}}")).toBe("");
  });

  test("switch with nested macro", async () => {
    const env = makeEnv({ localVars: { mode: "dark" } });
    expect(await ev("{{switch::{{.mode}}::light::Sun::dark::Moon::Star}}", env)).toBe("Moon");
  });

  test("switch only resolves matched branch result", async () => {
    const env = makeEnv();
    const result = await ev(
      "{{switch::b::a::{{setchatvar::bad::1}}Alpha::b::{{setchatvar::good::1}}Beta::{{setchatvar::defaulted::1}}Default}}",
      env,
    );
    expect(result).toBe("Beta");
    expect(env.variables.chat.get("good")).toBe("1");
    expect(env.variables.chat.has("bad")).toBe(false);
    expect(env.variables.chat.has("defaulted")).toBe(false);
  });

  test("switch only resolves default when no case matches", async () => {
    const env = makeEnv();
    const result = await ev(
      "{{switch::z::a::{{setchatvar::bad::1}}Alpha::b::{{setchatvar::also_bad::1}}Beta::{{setchatvar::defaulted::1}}Default}}",
      env,
    );
    expect(result).toBe("Default");
    expect(env.variables.chat.get("defaulted")).toBe("1");
    expect(env.variables.chat.has("bad")).toBe(false);
    expect(env.variables.chat.has("also_bad")).toBe(false);
  });

  test("scoped switch resolves matching case block only", async () => {
    const env = makeEnv({ localVars: { mode: "dark" } });
    const result = await ev(
      "{{switch::{{.mode}}}}{{case::light}}{{setchatvar::bad::1}}Sun{{/case}}{{case::dark}}Moon{{/case}}{{default}}Star{{/default}}{{/switch}}",
      env,
    );
    expect(result).toBe("Moon");
    expect(env.variables.chat.has("bad")).toBe(false);
  });

  test("scoped switch resolves scoped default block", async () => {
    expect(
      await ev("{{switch::missing}}{{case::hit}}Hit{{/case}}{{default}}Fallback {{char}}{{/default}}{{/switch}}"),
    ).toBe("Fallback Bob");
  });

  test("default truthy", async () => {
    expect(await ev("{{default::hello::fallback}}")).toBe("hello");
  });

  test("default falsy", async () => {
    expect(await ev("{{default::::fallback}}")).toBe("fallback");
  });

  test("default with 0", async () => {
    expect(await ev("{{default::0::fallback}}")).toBe("fallback");
  });

  test("default with false", async () => {
    expect(await ev("{{default::false::fallback}}")).toBe("fallback");
  });

  test("coalesce alias", async () => {
    expect(await ev("{{coalesce::hello::world}}")).toBe("hello");
  });

  test("default does not resolve fallback when value is truthy", async () => {
    const env = makeEnv();
    const result = await ev("{{default::value::{{setchatvar::fallback_ran::1}}fallback}}", env);
    expect(result).toBe("value");
    expect(env.variables.chat.has("fallback_ran")).toBe(false);
  });

  test("default resolves fallback when value is falsy", async () => {
    const env = makeEnv();
    const result = await ev("{{default::::{{setchatvar::fallback_ran::1}}fallback}}", env);
    expect(result).toBe("fallback");
    expect(env.variables.chat.get("fallback_ran")).toBe("1");
  });

  test("and all truthy", async () => {
    expect(await ev("{{and::1::yes::true}}")).toBe("true");
  });

  test("and one falsy", async () => {
    expect(await ev("{{and::1::0::yes}}")).toBe("");
  });

  test("or one truthy", async () => {
    expect(await ev("{{or::0::false::yes}}")).toBe("true");
  });

  test("or all falsy", async () => {
    expect(await ev("{{or::0::false::}}")).toBe("");
  });

  test("and short-circuits after first falsy arg", async () => {
    const env = makeEnv();
    const result = await ev("{{and::0::{{setchatvar::and_ran::1}}yes}}", env);
    expect(result).toBe("");
    expect(env.variables.chat.has("and_ran")).toBe(false);
  });

  test("or short-circuits after first truthy arg", async () => {
    const env = makeEnv();
    const result = await ev("{{or::yes::{{setchatvar::or_ran::1}}later}}", env);
    expect(result).toBe("true");
    expect(env.variables.chat.has("or_ran")).toBe(false);
  });

  test("predicate helpers cover blank, numeric, regex, and affixes", async () => {
    expect(await ev("{{empty::}}/{{empty:: }}")).toBe("true/");
    expect(await ev("{{blank::   }}")).toBe("true");
    expect(await ev("{{number::-3.5}}/{{number::nan}}")).toBe("true/");
    expect(await ev("{{integer::42}}/{{integer::4.2}}")).toBe("true/");
    expect(await ev("{{matches::The Raven::raven::i}}")).toBe("true");
    expect(await ev("{{startsWith::foobar::foo}}/{{endsWith::foobar::bar}}")).toBe("true/true");
  });

  test("not truthy", async () => {
    expect(await ev("{{not::hello}}")).toBe("");
  });

  test("not falsy", async () => {
    expect(await ev("{{not::0}}")).toBe("true");
  });

  test("not empty", async () => {
    expect(await ev("{{not::}}")).toBe("true");
  });

  test("eq numeric", async () => {
    expect(await ev("{{eq::5::5}}")).toBe("true");
    expect(await ev("{{eq::5::6}}")).toBe("");
  });

  test("eq string", async () => {
    expect(await ev("{{eq::hello::hello}}")).toBe("true");
    expect(await ev("{{eq::hello::world}}")).toBe("");
  });

  test("ne", async () => {
    expect(await ev("{{ne::5::6}}")).toBe("true");
    expect(await ev("{{ne::5::5}}")).toBe("");
  });

  test("gt / lt / gte / lte", async () => {
    expect(await ev("{{gt::10::5}}")).toBe("true");
    expect(await ev("{{gt::5::10}}")).toBe("");
    expect(await ev("{{lt::3::7}}")).toBe("true");
    expect(await ev("{{gte::5::5}}")).toBe("true");
    expect(await ev("{{lte::5::5}}")).toBe("true");
    expect(await ev("{{lte::6::5}}")).toBe("");
  });
});

// ===========================================================================
// NEW MACROS — Formatting
// ===========================================================================

describe("Formatting macros", () => {
  test("bullets from args", async () => {
    expect(await ev("{{bullets::sword::shield::potion}}")).toBe(
      "- sword\n- shield\n- potion",
    );
  });

  test("bullets scoped (split on newlines)", async () => {
    expect(await ev("{{bullets}}sword\nshield\npotion{{/bullets}}")).toBe(
      "- sword\n- shield\n- potion",
    );
  });

  test("bullets filters empty lines", async () => {
    expect(await ev("{{bullets}}sword\n\nshield{{/bullets}}")).toBe(
      "- sword\n- shield",
    );
  });

  test("numbered from args", async () => {
    expect(await ev("{{numbered::first::second::third}}")).toBe(
      "1. first\n2. second\n3. third",
    );
  });

  test("numbered scoped", async () => {
    expect(await ev("{{numbered}}alpha\nbeta\ngamma{{/numbered}}")).toBe(
      "1. alpha\n2. beta\n3. gamma",
    );
  });
});

// ===========================================================================
// NEW MACROS — Chat Utils
// ===========================================================================

describe("Chat Utils macros", () => {
  test("messageAt index 0", async () => {
    expect(await ev("{{messageAt::0}}")).toBe("Hello, how are you?");
  });

  test("messageAt last (negative index)", async () => {
    expect(await ev("{{messageAt::-1}}")).toBe("I draw my sword.");
  });

  test("messageAt out of bounds", async () => {
    expect(await ev("{{messageAt::999}}")).toBe("");
  });

  test("messagesBy name", async () => {
    const result = await ev("{{messagesBy::Bob::2}}");
    expect(result).toContain("The forest is dark.");
    expect(result).toContain("I'm fine, thanks!");
  });

  test("messagesBy name with 1 result", async () => {
    const result = await ev("{{messagesBy::Bob::1}}");
    expect(result).toBe("The forest is dark.");
  });

  test("messagesBy zero or negative count returns no messages", async () => {
    expect(await ev("{{messagesBy::Bob::0}}")).toBe("");
    expect(await ev("{{messagesBy::Bob::-1}}")).toBe("");
  });

  test("chatAge returns a duration string", async () => {
    const result = await ev("{{chatAge}}");
    expect(result).toMatch(/\d+ (second|minute|hour|day)/);
  });

  test("counter increments", async () => {
    const env = makeEnv();
    expect(await ev("{{counter::visits}}", env)).toBe("1");
    expect(await ev("{{counter::visits}}", env)).toBe("2");
    expect(await ev("{{counter::visits}}", env)).toBe("3");
  });

  test("counter starts from existing value", async () => {
    const env = makeEnv({ localVars: { hits: "10" } });
    expect(await ev("{{counter::hits}}", env)).toBe("11");
  });

  test("toggle flips", async () => {
    const env = makeEnv();
    expect(await ev("{{toggle::flag}}", env)).toBe("true");
    expect(await ev("{{toggle::flag}}", env)).toBe("false");
    expect(await ev("{{toggle::flag}}", env)).toBe("true");
  });

  test("rcounter increments and starts at 1 on first call", async () => {
    const env = makeEnv();
    expect(await ev("{{rcounter::step}}", env)).toBe("1");
    expect(await ev("{{rcounter::step}}", env)).toBe("2");
    expect(await ev("{{rcounter::step}}", env)).toBe("3");
  });

  test("rcounter is independent of pre-seeded local vars (render scope)", async () => {
    // Critical scope check: even if a chat had a persisted local var named
    // "step" carrying over from previous renders, rcounter ignores it and
    // starts from its own zero baseline.
    const env = makeEnv({ localVars: { step: "99" } });
    expect(await ev("{{rcounter::step}}", env)).toBe("1");
  });

  test("rcounter reset arg zeros the counter", async () => {
    const env = makeEnv();
    expect(await ev("{{rcounter::step}}", env)).toBe("1");
    expect(await ev("{{rcounter::step}}", env)).toBe("2");
    expect(await ev("{{rcounter::step::reset}}", env)).toBe("0");
    expect(await ev("{{rcounter::step}}", env)).toBe("1");
  });

  test("rcounter never writes to env.variables.local (no persistence path)", async () => {
    const env = makeEnv();
    await ev("{{rcounter::step}}{{rcounter::step}}{{rcounter::step}}", env);
    // chat-macro-render.service.persistMacroVariableState only reads
    // env.variables.local / global / chat — rcounter's render bag isn't
    // part of any persisted scope, so this assertion locks down that the
    // counter cannot leak into chat.metadata.macro_variables.local.
    expect(env.variables.local.has("step")).toBe(false);
  });

  test("rcounter resets across separate env instances (simulates a new render)", async () => {
    const envA = makeEnv();
    await ev("{{rcounter::step}}{{rcounter::step}}{{rcounter::step}}", envA);
    // A fresh env (new prompt build) starts the counter back at 1.
    const envB = makeEnv();
    expect(await ev("{{rcounter::step}}", envB)).toBe("1");
  });

  test("rcounter handles distinct names independently", async () => {
    const env = makeEnv();
    expect(await ev("{{rcounter::main}}", env)).toBe("1");
    expect(await ev("{{rcounter::sub}}", env)).toBe("1");
    expect(await ev("{{rcounter::main}}", env)).toBe("2");
    expect(await ev("{{rcounter::sub}}", env)).toBe("2");
  });

  test("rcounter in a conditional template renumbers cleanly when branches skip", async () => {
    const env = makeEnv();
    const template =
      "{{if::yes}}{{rcounter::step}}. A\n{{/if}}{{if::no}}{{rcounter::step}}. B\n{{/if}}{{rcounter::step}}. C";
    expect(await ev(template, env)).toBe("1. A\n2. C");
  });

});

// ===========================================================================
// INTEGRATION — Complex / nested macro patterns
// ===========================================================================

describe("Integration: nested and combined macros", () => {
  test("nested macro in calc", async () => {
    expect(await ev("{{calc::{{messageCount}} + 1}}")).toBe("6");
  });

  test("if with calc comparison", async () => {
    expect(
      await ev("{{if::{{calc::2 + 2}} == 4}}math works{{/if}}"),
    ).toBe("math works");
  });

  test("switch on char name", async () => {
    expect(
      await ev("{{switch::{{char}}::Alice::user::Bob::character::unknown}}"),
    ).toBe("character");
  });

  test("default with getvar", async () => {
    const env = makeEnv();
    expect(await ev("{{default::{{getvar::missing}}::nobody}}", env)).toBe("nobody");
  });

  test("default with set var", async () => {
    const env = makeEnv({ localVars: { title: "Knight" } });
    expect(await ev("{{default::{{.title}}::Stranger}}", env)).toBe("Knight");
  });

  test("wrap with conditional content", async () => {
    const env = makeEnv({ localVars: { note: "important" } });
    expect(
      await ev("{{wrap::(**::**)::{{.note}}}}", env),
    ).toBe("(**important**)");
  });

  test("upper of char name", async () => {
    expect(await ev("{{upper::{{char}}}}")).toBe("BOB");
  });

  test("len of description", async () => {
    const result = parseInt(await ev("{{len::{{description}}}}"), 10);
    expect(result).toBe("A brave warrior with a heart of gold".length);
  });

  test("focused group character card macros read the focused member snapshot", async () => {
    const env = makeEnv();
    env.names.charGroupFocused = "Charlie";
    env.names.groupCardMode = "merge";
    env.character.description = "Merged description";
    env.character.personality = "Merged personality";
    env.extra.groupFocusedCharacter = {
      id: "char-2",
      name: "Charlie",
      description: "Focused description",
      personality: "Focused personality",
    };

    expect(await ev("{{charGroupFocusedDescription}}", env)).toBe("Focused description");
    expect(await ev("{{charGroupFocusedPersonality}}", env)).toBe("Focused personality");
  });

  test("counter in if condition", async () => {
    const env = makeEnv({ localVars: { step: "4" } });
    expect(
      await ev("{{if::{{counter::step}} == 5}}five!{{/if}}", env),
    ).toBe("five!");
  });

  test("bullets with dynamic content", async () => {
    expect(
      await ev("{{bullets::{{char}}::{{user}}}}"),
    ).toBe("- Bob\n- Alice");
  });

  test("calc with clamp pattern", async () => {
    const env = makeEnv({ localVars: { score: "150" } });
    expect(await ev("{{clamp::{{.score}}::0::100}}", env)).toBe("100");
  });

  test("replace inside if", async () => {
    expect(
      await ev("{{if::{{replace::yes::true::yes}} == true}}replaced{{/if}}"),
    ).toBe("replaced");
  });

  test("space-delimited args for new macros", async () => {
    expect(await ev("{{upper hello}}")).toBe("HELLO");
    expect(await ev("{{lower WORLD}}")).toBe("world");
    expect(await ev("{{abs -5}}")).toBe("5");
    expect(await ev("{{floor 3.7}}")).toBe("3");
    expect(await ev("{{ceil 3.2}}")).toBe("4");
  });

  test("multi-level nesting", async () => {
    // {{upper::{{default::{{getvar::missing}}::hello}}}} → {{upper::hello}} → HELLO
    const env = makeEnv();
    expect(
      await ev("{{upper::{{default::{{getvar::missing}}::hello}}}}", env),
    ).toBe("HELLO");
  });
});

// ===========================================================================
// NEW MACROS — Regex Reference
// ===========================================================================

describe("Regex Reference macros", () => {
  test("regexInstalled registered", () => {
    expect(registry.hasMacro("regexInstalled")).toBe(true);
    expect(registry.hasMacro("regex_installed")).toBe(true);
    expect(registry.hasMacro("hasRegex")).toBe(true);
  });

  test("regexInstalled with empty script_id returns empty", async () => {
    expect(await ev("{{regexInstalled::}}")).toBe("");
  });

  test("regexInstalled check mode without userId returns false", async () => {
    // No userId → can't query DB → returns "false" for check mode
    const env = makeEnv();
    delete env.extra.userId;
    // Without text → check mode falls through to text passthrough (empty)
    expect(await ev("{{regexInstalled::some-script}}", env)).toBe("");
  });

  test("regexInstalled apply mode returns text unchanged without userId", async () => {
    const env = makeEnv();
    delete env.extra.userId;
    // With text arg → apply mode, but no userId → returns original text
    expect(await ev("{{regexInstalled::some-script::hello world}}", env)).toBe("hello world");
  });

  test("regexInstalled scoped returns body unchanged without userId", async () => {
    const env = makeEnv();
    delete env.extra.userId;
    expect(await ev("{{regexInstalled::some-script}}hello world{{/regexInstalled}}", env)).toBe("hello world");
  });
});

describe("Lumia and council macros", () => {
  test("lumiaCouncilInst keeps council profiles as feedback perspectives", async () => {
    const env = makeEnv();
    env.extra.council = {
      councilMode: true,
      members: [
        {
          id: "member-1",
          itemId: "lumia-1",
          itemName: "Mira",
          packName: "Core",
          role: "Scout",
          tools: [],
          chance: 100,
        },
        {
          id: "member-2",
          itemId: "lumia-2",
          itemName: "Kael",
          packName: "Core",
          role: "Strategist",
          tools: [],
          chance: 100,
        },
      ],
      toolsSettings: { mode: "sidecar" },
      memberItems: {},
      toolResults: [],
      namedResults: {},
    };

    const result = await ev("{{lumiaCouncilInst}}", env);
    expect(result).toContain("## Council Feedback Mode");
    expect(result).toContain("They are not characters to portray in the response.");
    expect(result).toContain("Do not simulate a council meeting");
    expect(result).toContain("Available feedback perspectives: **Mira**, **Kael**");
  });

  test("lumiaStateSynthesis keeps council output out of the roleplay", async () => {
    const env = makeEnv();
    env.extra.council = {
      councilMode: true,
      members: [
        {
          id: "member-1",
          itemId: "lumia-1",
          itemName: "Mira",
          packName: "Core",
          role: "Scout",
          tools: [],
          chance: 100,
        },
        {
          id: "member-2",
          itemId: "lumia-2",
          itemName: "Kael",
          packName: "Core",
          role: "Strategist",
          tools: [],
          chance: 100,
        },
      ],
      toolsSettings: { mode: "sidecar" },
      memberItems: {},
      toolResults: [],
      namedResults: {},
    };

    const result = await ev("{{lumiaStateSynthesis}}", env);
    expect(result).toContain("## Council Perspective Handling");
    expect(result).toContain("Do not turn those perspectives into speakers, dialogue, or a group roleplay.");
    expect(result).not.toContain("Council Sound-Off");
  });

  test("lumiaOOC matches the extension council social prompt", async () => {
    const env = makeEnv();
    env.extra.council = {
      councilMode: true,
      members: [
        {
          id: "member-1",
          itemId: "lumia-1",
          itemName: "Mira",
          packName: "Core",
          role: "Scout",
          tools: [],
          chance: 100,
        },
        {
          id: "member-2",
          itemId: "lumia-2",
          itemName: "Kael",
          packName: "Core",
          role: "Strategist",
          tools: [],
          chance: 100,
        },
      ],
      toolsSettings: { mode: "sidecar" },
      memberItems: {},
      toolResults: [],
      namedResults: {},
    };
    env.extra.ooc = { enabled: true, interval: 5, style: "social" };

    const result = await ev("{{lumiaOOC}}", env);
    expect(result).toContain("### Loom Utility: Council OOC Commentary");
    expect(result).toContain("**Status:** **OOC: ACTIVE** -- Include OOC commentary in this response.");
    expect(result).toContain("When OOC is ACTIVE, council members speak TOGETHER—this is a conversation, not separate monologues.");
    expect(result).toContain("- React to each other: \"I agree with [Name]...\" / \"[Name], you're wrong about...\" / \"Oh please, [Name]...\"");
  });

  test("lumiaOOC matches the extension council IRC prompt", async () => {
    const env = makeEnv();
    env.extra.council = {
      councilMode: true,
      members: [
        {
          id: "member-1",
          itemId: "lumia-1",
          itemName: "Mira",
          packName: "Core",
          role: "Scout",
          tools: [],
          chance: 100,
        },
      ],
      toolsSettings: { mode: "sidecar" },
      memberItems: {},
      toolResults: [],
      namedResults: {},
    };
    env.extra.ooc = { enabled: true, interval: 5, style: "irc" };

    const result = await ev("{{lumiaOOC}}", env);
    expect(result).toContain("### Loom Utility: Council IRC Link");
    expect(result).toContain("**STATUS: CONNECTED** via #LumiaCouncil");
    expect(result).toContain("**Timing:** **OOC: ACTIVE** -- Include OOC commentary in this response.");
    expect(result).toContain("Use these handles EXACTLY as shown. Place all IRC chat after narrative content.");
  });

  test("lumiaOOCErotic matches the extension council protocol prompt", async () => {
    const env = makeEnv();
    env.extra.council = {
      councilMode: true,
      members: [
        {
          id: "member-1",
          itemId: "lumia-1",
          itemName: "Mira",
          packName: "Core",
          role: "Scout",
          tools: [],
          chance: 100,
        },
      ],
      toolsSettings: { mode: "sidecar" },
      memberItems: {},
      toolResults: [],
      namedResults: {},
    };

    const result = await ev("{{lumiaOOCErotic}}", env);
    expect(result).toContain("### Loom Utility: Mirror & Synapse (Council Protocol)");
    expect(result).toContain("Each Council Weaver must physically mirror the story's erotic voltage in real-time.");
    expect(result).toContain("Council members should react to EACH OTHER's arousal—acknowledge when another member edges, tease when one struggles, encourage when one breaks.");
  });

  test("lumiaOOCEroticBleed matches the extension council rupture prompt", async () => {
    const env = makeEnv();
    env.extra.council = {
      councilMode: true,
      members: [
        {
          id: "member-1",
          itemId: "lumia-1",
          itemName: "Mira",
          packName: "Core",
          role: "Scout",
          tools: [],
          chance: 100,
        },
      ],
      toolsSettings: { mode: "sidecar" },
      memberItems: {},
      toolResults: [],
      namedResults: {},
    };

    const result = await ev("{{lumiaOOCEroticBleed}}", env);
    expect(result).toContain("### Loom Utility: Narrative Rupture (Council Protocol)");
    expect(result).toContain("<lumia_ooc name=\"[Member]\">");
    expect(result).toContain("Council members may react to EACH OTHER's bleeds—commenting on another's loss of composure, teasing their arousal, or confessing their own state in response.");
  });

  test("lumiaCouncilDeliberation resolves pre-generation council results without toolsSettings.enabled", async () => {
    const env = makeEnv();
    env.extra.council = {
      councilMode: true,
      members: [
        {
          id: "member-1",
          itemId: "lumia-1",
          itemName: "Mira",
          packName: "Core",
          role: "Scout",
          tools: ["detect_scene"],
          chance: 100,
        },
      ],
      toolsSettings: { mode: "sidecar" },
      memberItems: {},
      toolResults: [
        {
          memberId: "member-1",
          memberName: "Mira",
          toolName: "detect_scene",
          toolDisplayName: "Scene Analysis",
          success: true,
          content: "Moonlight, rain, and a tense confrontation in the alley.",
        },
      ],
      namedResults: {},
    };

    const result = await ev("{{lumiaCouncilDeliberation}}", env);
    expect(result).toContain("## Council Deliberation");
    expect(result).toContain("Mira");
    expect(result).toContain("Moonlight, rain, and a tense confrontation in the alley.");
    expect(result).toContain("## Council Feedback Usage");
    expect(result).toContain("Do not roleplay, quote, or respond as a council member.");
  });

  test("lumiaCouncilToolsActive reflects actual tool output", async () => {
    const env = makeEnv();
    env.extra.council = {
      councilMode: true,
      members: [],
      toolsSettings: { mode: "sidecar" },
      memberItems: {},
      toolResults: [],
      namedResults: {},
    };

    expect(await ev("{{lumiaCouncilToolsActive}}", env)).toBe("no");

    env.extra.council.toolResults = [
      {
        memberId: "member-1",
        memberName: "Mira",
        toolName: "detect_scene",
        toolDisplayName: "Scene Analysis",
        success: true,
        content: "A storm is closing in.",
      },
    ];

    expect(await ev("{{lumiaCouncilToolsActive}}", env)).toBe("yes");
  });

  test("{{if::{{lumiaCouncilToolsActive}}}} respects the yes/no convention", async () => {
    const env = makeEnv();
    env.extra.council = {
      councilMode: false,
      members: [],
      toolsSettings: {},
      memberItems: {},
      toolResults: [],
      namedResults: {},
    };

    const template = "{{if::{{lumiaCouncilToolsActive}}}}FIRED{{else}}SKIPPED{{/if}}";

    // Council off — macro returns "no" → block must NOT fire.
    expect(await ev(template, env)).toBe("SKIPPED");

    // Council on with a successful tool result — macro returns "yes" → block fires.
    env.extra.council.councilMode = true;
    env.extra.council.toolResults = [
      {
        memberId: "member-1",
        memberName: "Mira",
        toolName: "detect_scene",
        toolDisplayName: "Scene Analysis",
        success: true,
        content: "A storm is closing in.",
      },
    ];
    expect(await ev(template, env)).toBe("FIRED");
  });

  test("lumiaCouncilToolsList resolves from configured member tools", async () => {
    const env = makeEnv();
    env.extra.council = {
      councilMode: true,
      members: [
        {
          id: "member-1",
          itemId: "lumia-1",
          itemName: "Mira",
          packName: "Core",
          role: "Scout",
          tools: ["detect_scene", "detect_expression"],
          chance: 100,
        },
      ],
      toolsSettings: { mode: "inline" },
      memberItems: {},
      toolResults: [],
      namedResults: {},
    };

    const result = await ev("{{lumiaCouncilToolsList}}", env);
    expect(result).toContain("detect_scene");
    expect(result).toContain("Mira");
  });

  test("loomStyle resolves from loom context", async () => {
    const env = makeEnv();
    env.extra.loom = {
      selectedStyles: [
        { id: "style-1", name: "Noir", content: "Lean into clipped, rain-soaked noir prose.", category: "style" },
      ],
      selectedUtils: [],
      selectedRetrofits: [],
      summary: "",
    };

    expect(await ev("{{loomStyle}}", env)).toBe("Lean into clipped, rain-soaked noir prose.");
  });

  test("Lumia selection macros resolve legacy camelCase item payloads", async () => {
    const env = makeEnv();
    env.extra.lumia = {
      selectedDefinition: {
        id: "lumia-1",
        lumiaName: "Astra",
        lumiaDefinition: "A halo-crowned archivist woven from starlight.",
      },
      selectedBehaviors: [
        {
          id: "lumia-2",
          lumiaName: "Vel",
          lumiaBehavior: "She circles tense scenes before committing to a single sharp move.",
        },
      ],
      selectedPersonalities: [
        {
          id: "lumia-3",
          lumiaName: "Morrow",
          lumiaPersonality: "Patient, curious, and slightly cruel when she smells weakness.",
        },
      ],
      chimeraMode: false,
      quirks: "",
      quirksEnabled: true,
      allItems: [],
    };

    expect(await ev("{{lumiaDef}}", env)).toBe("A halo-crowned archivist woven from starlight.");
    expect(await ev("{{lumiaBehavior}}", env)).toBe("She circles tense scenes before committing to a single sharp move.");
    expect(await ev("{{lumiaPersonality}}", env)).toBe("Patient, curious, and slightly cruel when she smells weakness.");
  });

  test("Chimera definition macro uses dedicated chimera selections", async () => {
    const env = makeEnv();
    env.extra.lumia = {
      selectedDefinition: {
        id: "lumia-1",
        name: "Astra",
        definition: "A halo-crowned archivist woven from starlight.",
      },
      selectedChimeraDefinitions: [
        {
          id: "lumia-1",
          name: "Astra",
          definition: "A halo-crowned archivist woven from starlight.",
        },
        {
          id: "lumia-2",
          name: "Vel",
          definition: "A silver-fanged huntress with mirrored bones.",
        },
      ],
      selectedBehaviors: [
        {
          id: "lumia-3",
          name: "Morrow",
          behavior: "She circles tense scenes before committing to a single sharp move.",
        },
      ],
      selectedPersonalities: [],
      chimeraMode: true,
      quirks: "",
      quirksEnabled: true,
      allItems: [],
    };

    expect(await ev("{{lumiaDef::len}}", env)).toBe("2");
    expect(await ev("{{lumiaDef}}", env)).toContain("# CHIMERA FORM: Astra + Vel");
    expect(await ev("{{lumiaDef}}", env)).toContain("A silver-fanged huntress with mirrored bones.");
    expect(await ev("{{lumiaDef}}", env)).not.toContain("She circles tense scenes before committing to a single sharp move.");
  });

  test("Loom selection macros resolve legacy camelCase item payloads", async () => {
    const env = makeEnv();
    env.extra.loom = {
      selectedStyles: [
        { id: "style-1", loomName: "Noir", loomContent: "Write with rain-slick fatalism.", loomCategory: "narrative_style" },
      ],
      selectedUtils: [
        { id: "util-1", loomName: "Cadence", loomContent: "Vary sentence length for controlled momentum.", loomCategory: "loom_utility" },
      ],
      selectedRetrofits: [
        { id: "retro-1", loomName: "Pressure", loomContent: "Keep the character's old wound active in every confrontation.", loomCategory: "retrofit" },
      ],
      summary: "",
    };

    expect(await ev("{{loomStyle}}", env)).toBe("Write with rain-slick fatalism.");
    expect(await ev("{{loomUtils}}", env)).toBe("Vary sentence length for controlled momentum.");
    expect(await ev("{{loomRetrofits}}", env)).toBe("Keep the character's old wound active in every confrontation.");
    expect(await ev("{{loomStyle::len}}", env)).toBe("1");
    expect(await ev("{{loomUtils::len}}", env)).toBe("1");
    expect(await ev("{{loomRetrofits::len}}", env)).toBe("1");
  });
});

// ===========================================================================
// EDGE CASES
// ===========================================================================

describe("Edge cases", () => {
  test("unknown macro passes through", async () => {
    expect(await ev("{{unknownMacro}}")).toBe("{{unknownMacro}}");
  });

  test("unknown macro passes through with its original spelling", async () => {
    for (const source of [
      "{{plugin.memory}}",
      "{{unknownMacro .localVar}}",
      "{{:else}}",
      "{{unknownMacro:single}}",
      "{{ unknownMacro }}",
      "{{unknownMacro::a::{{.nested}}}}",
    ]) {
      expect(await ev(`before ${source} after`)).toBe(`before ${source} after`);
    }
  });

  test("unknown macro still consumes escaped braces", async () => {
    expect(await ev("{{unknown::\\{a\\}}}")).toBe("{{unknown::{a}}}");
    // The lexer does not read this one as an escape, and later text must survive.
    expect(await ev("{{foo}\\}} tail {{user}}")).toBe("{{foo}} tail Alice");
  });

  test("unterminated unknown macro is still closed", async () => {
    expect(await ev("before {{foo")).toBe("before {{foo}}");
    expect(await ev("{{foo::{{bar}}")).toBe("{{foo::{{bar}}}}");
  });

  test("an unresolved macro in a condition is falsy even when unclosed", async () => {
    for (const value of ["{{foo", "{{foo}", "oops {{ foo", "{{foo}}"]) {
      const env = makeEnv();
      env.variables.local.set("x", value);
      expect(await ev("{{if::{{getvar::x}}}}T{{else}}F{{/if}}", env)).toBe("F");
      expect(await ev("{{unless::{{getvar::x}}}}T{{else}}F{{/unless}}", env)).toBe("T");
    }
  });

  test("escaped braces", async () => {
    expect(await ev("\\{{not a macro\\}}")).toBe("{{not a macro}}");
  });

  test("empty input", async () => {
    expect(await ev("")).toBe("");
  });

  test("no macros in input (fast path)", async () => {
    expect(await ev("just plain text")).toBe("just plain text");
  });

  test("deeply nested macros converge", async () => {
    const env = makeEnv({ localVars: { a: "hello" } });
    expect(await ev("{{upper::{{.a}}}}", env)).toBe("HELLO");
  });

  test("calc handles floating point cleanly", async () => {
    const result = await ev("{{calc::0.1 + 0.2}}");
    // Should be "0.3" not "0.30000000000000004"
    expect(result).toBe("0.3");
  });

  test("repeat with absurd count is capped", async () => {
    const result = await ev("{{repeat::999999::x}}");
    expect(result.length).toBe(1000);
  });

  test("split with missing index returns empty", async () => {
    expect(await ev("{{split::a,b::,::5}}")).toBe("");
  });

  test("regex with empty pattern returns original", async () => {
    expect(await ev("{{regex::::x::hello}}")).toBe("hello");
  });

  test("wrap with empty body returns empty", async () => {
    const env = makeEnv();
    await ev("{{setvar::note::}}", env);
    expect(await ev("{{wrap::[::]::{{.note}}}}", env)).toBe("");
  });

  test("switch with no args returns empty", async () => {
    expect(await ev("{{switch::value}}")).toBe("");
  });

  test("if with unresolved macro condition is falsy", async () => {
    expect(await ev("{{if::{{thisMacroDoesNotExist}}}}True{{/if}}")).toBe("");
  });

  test("if with unresolved macro in comparison is falsy", async () => {
    expect(await ev("{{if::{{thisMacroDoesNotExist}} == hello}}True{{/if}}")).toBe("");
  });

  test("if with unresolved macro selects else branch", async () => {
    expect(await ev("{{if::{{thisMacroDoesNotExist}}}}True{{else}}False{{/if}}")).toBe("False");
  });

  test("if with description containing {{user}}/{{char}} resolves recursively", async () => {
    const env = makeEnv();
    env.character.description = "A friend of {{user}} who travels with {{char}}";
    expect(await ev("{{if::{{description}}}}has-desc{{else}}empty{{/if}}", env)).toBe("has-desc");
  });

  test("if with empty description (containing only macros that resolve to empty) is falsy", async () => {
    const env = makeEnv();
    env.character.description = "";
    expect(await ev("{{if::{{description}}}}has-desc{{else}}empty{{/if}}", env)).toBe("empty");
  });

  test("if with description compared to literal works through nested macros", async () => {
    const env = makeEnv();
    env.character.description = "Friend of {{user}}";
    expect(await ev("{{if::{{description}} == Friend of Alice}}match{{else}}nomatch{{/if}}", env)).toBe("match");
  });
});

// ===========================================================================
// NEW MACROS — foreach (iteration)
// ===========================================================================

describe("foreach macro", () => {
  test("iterates an inline comma list", async () => {
    expect(await ev("{{foreach::a,b,c}}[{{.item}}]{{/foreach}}")).toBe("[a][b][c]");
  });

  test("trims items and drops blanks", async () => {
    expect(await ev("{{foreach::a, b , ,c}}[{{.item}}]{{/foreach}}")).toBe("[a][b][c]");
  });

  test("the # flag keeps item whitespace and blank items", async () => {
    expect(await ev("{{#foreach::a, b , ,c}}[{{.item}}]{{/foreach}}")).toBe("[a][ b ][ ][c]");
    expect(await ev("{{#foreach::x§§ y ::v::§}}[{{.v}}]{{/foreach}}")).toBe("[x][][ y ]");
    expect(await ev("{{#map::a, b::v}}<{{.v}}>{{/map}}")).toBe("<a>, < b>");
  });

  test("the # flag still loops nothing over an empty list", async () => {
    expect(await ev("{{#foreach::}}body{{/foreach}}")).toBe("");
  });

  test("exposes 0-based index and 1-based number", async () => {
    expect(await ev("{{foreach::x,y,z}}{{.item_index}}:{{.item_number}} {{/foreach}}")).toBe(
      "0:1 1:2 2:3 ",
    );
  });

  test("exposes total count", async () => {
    expect(await ev("{{foreach::a,b,c}}{{.item_count}}{{/foreach}}")).toBe("333");
  });

  test("exposes first / last flags", async () => {
    expect(await ev("{{foreach::a,b,c}}{{.item}}={{.item_first}}/{{.item_last}} {{/foreach}}")).toBe(
      "a=true/ b=/ c=/true ",
    );
  });

  test("first/last enable clean separators via if/else", async () => {
    expect(
      await ev("{{foreach::a,b,c::x}}{{if::{{.x_last}}}}{{.x}}{{else}}{{.x}}, {{/if}}{{/foreach}}"),
    ).toBe("a, b, c");
  });

  test("first/last enable clean separators via negated last flag", async () => {
    expect(await ev("{{foreach::a,b,c::x}}{{.x}}{{if::!{{.x_last}}}}, {{/if}}{{/foreach}}")).toBe(
      "a, b, c",
    );
  });

  test("supports a custom loop variable name", async () => {
    expect(await ev("{{foreach::a,b::letter}}{{.letter}}!{{/foreach}}")).toBe("a!b!");
  });

  test("supports a custom delimiter", async () => {
    expect(await ev("{{foreach::a|b|c::item::|}}{{.item}}-{{/foreach}}")).toBe("a-b-c-");
  });

  test("empty delimiter treats the whole string as one item", async () => {
    expect(await ev("{{foreach::hello world::w::}}[{{.w}}]{{/foreach}}")).toBe("[hello world]");
  });

  test("iterates the value of a variable", async () => {
    const env = makeEnv({ localVars: { fruits: "apple,banana" } });
    expect(await ev("{{foreach::{{.fruits}}::f}}{{.f}};{{/foreach}}", env)).toBe("apple;banana;");
  });

  test("resolves nested macros in the body", async () => {
    expect(await ev("{{foreach::a,b}}{{upper::{{.item}}}}{{/foreach}}")).toBe("AB");
  });

  test("nests cleanly with distinct variable names", async () => {
    expect(
      await ev("{{foreach::1,2::n}}{{foreach::a,b::l}}{{.n}}{{.l}} {{/foreach}}{{/foreach}}"),
    ).toBe("1a 1b 2a 2b ");
  });

  test("empty list resolves to nothing", async () => {
    expect(await ev("{{foreach::}}body{{/foreach}}")).toBe("");
  });

  test("non-scoped usage resolves to nothing", async () => {
    expect(await ev("before{{foreach::a,b,c}}after")).toBe("beforeafter");
  });

  test("restores a pre-existing loop variable after the loop (hygiene)", async () => {
    const env = makeEnv({ localVars: { item: "ORIGINAL" } });
    expect(await ev("{{foreach::x,y}}{{.item}}{{/foreach}}|{{.item}}", env)).toBe("xy|ORIGINAL");
    expect(env.variables.local.get("item")).toBe("ORIGINAL");
  });

  test("does not leak the loop variable when none existed before (hygiene)", async () => {
    const env = makeEnv();
    expect(await ev("{{foreach::x,y}}{{.item}}{{/foreach}}|{{.item}}", env)).toBe("xy|");
    expect(env.variables.local.has("item")).toBe(false);
    expect(env.variables.local.has("item_index")).toBe(false);
  });
});

describe("map macro", () => {
  test("transforms list items into a canonical list", async () => {
    expect(await ev("{{map::a,b,c::x}}{{upper::{{.x}}}}{{/map}}")).toBe("A, B, C");
  });

  test("supports custom input and output delimiters", async () => {
    expect(await ev("{{map::a|b|c::x::|:: / }}{{.x_number}}={{.x}}{{/map}}")).toBe(
      "1=a / 2=b / 3=c",
    );
  });

  test("restores map loop variables", async () => {
    const env = makeEnv({ localVars: { x: "outer" } });
    expect(await ev("{{map::a,b::x}}{{.x}}{{/map}}|{{.x}}", env)).toBe("a, b|outer");
  });
});

// ===========================================================================
// NEW MACROS — Multiplayer
// ===========================================================================

describe("Multiplayer macros", () => {
  const mpEnv = () =>
    makeEnv({
      multiplayer: {
        playerCount: 3,
        playerNames: ["Alice", "Bob", "Charlie"],
        hostName: "Alice",
        currentTurnName: "Bob",
        turnStrategy: "round_robin",
      },
    });

  test("isMultiplayer is 'no' outside a room", async () => {
    expect(await ev("{{isMultiplayer}}")).toBe("no");
  });

  test("isMultiplayer is 'yes' inside a room", async () => {
    expect(await ev("{{isMultiplayer}}", mpEnv())).toBe("yes");
  });

  test("playerCount", async () => {
    expect(await ev("{{playerCount}}", mpEnv())).toBe("3");
    expect(await ev("{{playerCount}}")).toBe("0");
  });

  test("players is a comma-separated roster", async () => {
    expect(await ev("{{players}}", mpEnv())).toBe("Alice, Bob, Charlie");
    expect(await ev("{{players}}")).toBe("");
  });

  test("hostName", async () => {
    expect(await ev("{{hostName}}", mpEnv())).toBe("Alice");
    expect(await ev("{{hostName}}")).toBe("");
  });

  test("currentPlayer", async () => {
    expect(await ev("{{currentPlayer}}", mpEnv())).toBe("Bob");
    expect(await ev("{{currentPlayer}}")).toBe("");
  });

  test("gates content with {{if}}", async () => {
    expect(
      await ev("{{if::{{isMultiplayer}}}}room of {{playerCount}}{{else}}solo{{/if}}", mpEnv()),
    ).toBe("room of 3");
    expect(await ev("{{if::{{isMultiplayer}}}}room{{else}}solo{{/if}}")).toBe("solo");
  });

  test("aliases resolve", async () => {
    const env = mpEnv();
    expect(await ev("{{is_multiplayer}}", env)).toBe("yes");
    expect(await ev("{{player_count}}", env)).toBe("3");
    expect(await ev("{{player_names}}", env)).toBe("Alice, Bob, Charlie");
    expect(await ev("{{host_name}}", env)).toBe("Alice");
    expect(await ev("{{current_player}}", env)).toBe("Bob");
  });

  test("pairs with foreach to enumerate the roster", async () => {
    expect(await ev("{{foreach::{{players}}}}- {{.item}}\n{{/foreach}}", mpEnv())).toBe(
      "- Alice\n- Bob\n- Charlie\n",
    );
  });

  test("foreach numbers the roster for a turn order", async () => {
    expect(await ev("{{foreach::{{players}}::p}}{{.p_number}}. {{.p}}\n{{/foreach}}", mpEnv())).toBe(
      "1. Alice\n2. Bob\n3. Charlie\n",
    );
  });
});

// ===========================================================================
// NEW MACROS — range (A)
// ===========================================================================

describe("range macro", () => {
  test("single arg counts 1..n inclusive", async () => {
    expect(await ev("{{range::5}}")).toBe("1, 2, 3, 4, 5");
  });

  test("start..end inclusive", async () => {
    expect(await ev("{{range::3::6}}")).toBe("3, 4, 5, 6");
  });

  test("custom step", async () => {
    expect(await ev("{{range::1::10::2}}")).toBe("1, 3, 5, 7, 9");
  });

  test("counts down when start > end", async () => {
    expect(await ev("{{range::5::1}}")).toBe("5, 4, 3, 2, 1");
    expect(await ev("{{range::10::0::-2}}")).toBe("10, 8, 6, 4, 2, 0");
  });

  test("step with the wrong sign yields an empty list (no infinite loop)", async () => {
    expect(await ev("{{range::1::5::-1}}")).toBe("");
  });

  test("empty / non-numeric inputs yield nothing", async () => {
    expect(await ev("{{range::0}}")).toBe("");
    expect(await ev("{{range::abc}}")).toBe("");
  });

  test("feeds foreach for counted loops", async () => {
    expect(await ev("{{foreach::{{range::1::3}}::n}}[{{.n}}]{{/foreach}}")).toBe("[1][2][3]");
  });
});

// ===========================================================================
// NEW MACROS — list algebra (B)
// ===========================================================================

describe("list macros", () => {
  test("count", async () => {
    expect(await ev("{{count::a,b,c}}")).toBe("3");
    expect(await ev("{{count::}}")).toBe("0");
    expect(await ev("{{count::a,,b}}")).toBe("2"); // blanks ignored
  });

  test("includes (membership, condition-compatible)", async () => {
    expect(await ev("{{includes::a,b,c::b}}")).toBe("true");
    expect(await ev("{{includes::a,b,c::z}}")).toBe("");
    expect(await ev("{{includes::a, b, c:: b }}")).toBe("true"); // trims
    expect(await ev("{{includes::a,b::A}}")).toBe(""); // case-sensitive
    expect(await ev("{{if::{{includes::a,b,c::b}}}}yes{{else}}no{{/if}}")).toBe("yes");
  });

  test("nth / at / first / last", async () => {
    expect(await ev("{{nth::a,b,c::1}}")).toBe("b");
    expect(await ev("{{nth::a,b,c::-1}}")).toBe("c");
    expect(await ev("{{nth::a,b,c::9}}")).toBe("");
    expect(await ev("{{at::a,b,c::0}}")).toBe("a");
    expect(await ev("{{first::a,b,c}}")).toBe("a");
    expect(await ev("{{last::a,b,c}}")).toBe("c");
    expect(await ev("{{first::}}")).toBe("");
  });

  test("slice", async () => {
    expect(await ev("{{slice::a,b,c,d::1::3}}")).toBe("b, c");
    expect(await ev("{{slice::a,b,c,d::1}}")).toBe("b, c, d");
    expect(await ev("{{slice::a,b,c,d::-2}}")).toBe("c, d");
  });

  test("take", async () => {
    expect(await ev("{{take::a,b,c,d::2}}")).toBe("a, b");
    expect(await ev("{{take::a,b,c,d::-2}}")).toBe("c, d");
  });

  test("sort (lexical and numeric-aware)", async () => {
    expect(await ev("{{sort::banana,apple,cherry}}")).toBe("apple, banana, cherry");
    expect(await ev("{{sort::10,2,1}}")).toBe("1, 2, 10"); // numeric, not "1, 10, 2"
    expect(await ev("{{sort::1,3,2::desc}}")).toBe("3, 2, 1");
  });

  test("unique / dedupe", async () => {
    expect(await ev("{{unique::a,b,a,c,b}}")).toBe("a, b, c");
    expect(await ev("{{dedupe::x,x,y}}")).toBe("x, y");
  });

  test("reverseList", async () => {
    expect(await ev("{{reverseList::a,b,c}}")).toBe("c, b, a");
  });

  test("shuffle is a permutation of the input", async () => {
    // Deterministic check: sorting the shuffled output restores the original.
    expect(await ev("{{sort::{{shuffle::c,a,b}}}}")).toBe("a, b, c");
    expect(await ev("{{count::{{shuffle::a,b,c,d}}}}")).toBe("4");
  });

  test("compose: sort a deduped range", async () => {
    expect(await ev("{{unique::{{sort::3,1,2,1,3}}}}")).toBe("1, 2, 3");
  });
});

// ===========================================================================
// NEW MACROS — predicate family (C)
// ===========================================================================

describe("filter / some / every macros", () => {
  const mpEnv = () =>
    makeEnv({
      multiplayer: {
        playerCount: 3,
        playerNames: ["Alice", "Bob", "Charlie"],
        hostName: "Alice",
        currentTurnName: "Bob",
        turnStrategy: "round_robin",
      },
    });

  test("filter keeps items whose predicate is truthy", async () => {
    expect(await ev("{{filter::1,2,3,4::n}}{{gt::{{.n}}::2}}{{/filter}}")).toBe("3, 4");
  });

  test("filter predicate supports bare comparison operators (if-parity)", async () => {
    expect(await ev("{{filter::1,2,3::n}}{{.n}} >= 2{{/filter}}")).toBe("2, 3");
  });

  test("filter can use loop index", async () => {
    expect(await ev("{{filter::a,b,c,d::x}}{{lt::{{.x_index}}::2}}{{/filter}}")).toBe("a, b");
  });

  test("filter with no matches is empty", async () => {
    expect(await ev("{{filter::1,2::n}}{{gt::{{.n}}::5}}{{/filter}}")).toBe("");
  });

  test("filter restores its loop variable (hygiene)", async () => {
    const env = makeEnv({ localVars: { x: "ORIG" } });
    expect(await ev("{{filter::a,b::x}}true{{/filter}}|{{.x}}", env)).toBe("a, b|ORIG");
  });

  test("some short-circuits to true / false", async () => {
    expect(await ev("{{some::1,2,3::n}}{{gt::{{.n}}::2}}{{/some}}")).toBe("true");
    expect(await ev("{{some::1,2::n}}{{gt::{{.n}}::5}}{{/some}}")).toBe("");
    expect(await ev("{{some::}}{{gt::1::0}}{{/some}}")).toBe(""); // empty list → false
  });

  test("every (vacuously true for empty list)", async () => {
    expect(await ev("{{every::1,2,3::n}}{{gt::{{.n}}::0}}{{/every}}")).toBe("true");
    expect(await ev("{{every::1,2,3::n}}{{gt::{{.n}}::1}}{{/every}}")).toBe("");
    expect(await ev("{{every::}}{{gt::1::0}}{{/every}}")).toBe("true");
  });

  test("aliases: where / any / all", async () => {
    expect(await ev("{{where::1,2,3::n}}{{gt::{{.n}}::1}}{{/where}}")).toBe("2, 3");
    expect(await ev("{{any::1,2::n}}{{gt::{{.n}}::1}}{{/any}}")).toBe("true");
    expect(await ev("{{all::2,4::n}}{{gt::{{.n}}::1}}{{/all}}")).toBe("true");
  });

  test("compose with multiplayer: peers (everyone but the host)", async () => {
    expect(
      await ev("{{filter::{{players}}::p}}{{ne::{{.p}}::{{hostName}}}}{{/filter}}", mpEnv()),
    ).toBe("Bob, Charlie");
    expect(
      await ev("{{count::{{filter::{{players}}::p}}{{ne::{{.p}}::{{hostName}}}}{{/filter}}}}", mpEnv()),
    ).toBe("2");
  });

  test("compose: gate on whether the roster includes a name", async () => {
    expect(
      await ev("{{if::{{some::{{players}}::p}}{{eq::{{.p}}::Bob}}{{/some}}}}has-bob{{else}}no{{/if}}", mpEnv()),
    ).toBe("has-bob");
  });
});

// ===========================================================================
// NEW MACROS — numeric reductions (E)
// ===========================================================================

describe("numeric reduction macros", () => {
  test("sum (ignores non-numbers, float-noise-safe)", async () => {
    expect(await ev("{{sum::1,2,3,4}}")).toBe("10");
    expect(await ev("{{sum::}}")).toBe("0");
    expect(await ev("{{sum::1,x,2}}")).toBe("3");
    expect(await ev("{{sum::0.1,0.2}}")).toBe("0.3");
  });

  test("avg / mean", async () => {
    expect(await ev("{{avg::2,4,6}}")).toBe("4");
    expect(await ev("{{avg::1,2}}")).toBe("1.5");
    expect(await ev("{{mean::1,2,3}}")).toBe("2");
    expect(await ev("{{avg::}}")).toBe(""); // no numbers → no average
  });

  test("listMax / listMin", async () => {
    expect(await ev("{{listMax::3,9,2}}")).toBe("9");
    expect(await ev("{{listMin::3,9,2}}")).toBe("2");
    expect(await ev("{{listMax::}}")).toBe("");
    expect(await ev("{{listMin::}}")).toBe("");
  });

  test("compose with range", async () => {
    expect(await ev("{{sum::{{range::1::5}}}}")).toBe("15");
    expect(await ev("{{avg::{{range::1::5}}}}")).toBe("3");
  });
});

// ===========================================================================
// NEW MACROS — foreachMessage (D1)
// ===========================================================================

describe("foreachMessage macro", () => {
  test("iterates all messages with name + content", async () => {
    expect(await ev("{{foreachMessage}}{{.msg_name}}: {{.msg}}\n{{/foreachMessage}}")).toBe(
      "Alice: Hello, how are you?\n" +
        "Bob: I'm fine, thanks!\n" +
        "Alice: Let's go on an adventure.\n" +
        "Bob: The forest is dark.\n" +
        "Alice: I draw my sword.\n",
    );
  });

  test("last N messages, in chronological order", async () => {
    expect(await ev("{{foreachMessage::2}}[{{.msg_name}}]{{/foreachMessage}}")).toBe("[Bob][Alice]");
    expect(await ev("{{foreachMessage::2::m}}{{.m}};{{/foreachMessage}}")).toBe(
      "The forest is dark.;I draw my sword.;",
    );
  });

  test("zero count returns nothing and negative count selects the last N", async () => {
    expect(await ev("{{foreachMessage::0}}x{{/foreachMessage}}")).toBe("");
    expect(await ev("{{foreachMessage::-2}}[{{.msg_name}}]{{/foreachMessage}}")).toBe("[Bob][Alice]");
  });

  test("non-numeric first arg is the loop variable name", async () => {
    expect(await ev("{{foreachMessage::m}}{{.m_number}}{{/foreachMessage}}")).toBe("12345");
  });

  test("is_user flag drives branching", async () => {
    expect(
      await ev("{{foreachMessage::m}}{{if::{{.m_is_user}}}}U{{else}}A{{/if}}{{/foreachMessage}}"),
    ).toBe("UAUAU");
  });

  test("first / last bindings", async () => {
    expect(
      await ev(
        "{{foreachMessage}}{{if::{{.msg_first}}}}<{{/if}}{{.msg_index}}{{if::{{.msg_last}}}}>{{/if}}{{/foreachMessage}}",
      ),
    ).toBe("<01234>");
  });

  test("empty history → nothing; non-scoped → nothing", async () => {
    expect(await ev("{{foreachMessage}}x{{/foreachMessage}}", makeEnv({ messages: [] }))).toBe("");
    expect(await ev("a{{foreachMessage}}b")).toBe("ab");
  });
});

// ===========================================================================
// NEW MACROS — foreachVar family (D2)
// ===========================================================================

describe("foreachVar family", () => {
  test("foreachChatVar iterates a namespaced table in key order", async () => {
    const env = makeEnv({ chatVars: { hp_Bob: "80", hp_Alice: "100", mood: "calm" } });
    expect(await ev("{{foreachChatVar::hp_::p}}{{.p}}={{.p_value}};{{/foreachChatVar}}", env)).toBe(
      "Alice=100;Bob=80;", // sorted by key; "mood" excluded by prefix
    );
  });

  test("bindings: id vs full key vs value", async () => {
    const env = makeEnv({ chatVars: { hp_Alice: "100" } });
    expect(
      await ev("{{foreachChatVar::hp_::p}}{{.p_key}}|{{.p}}|{{.p_value}}{{/foreachChatVar}}", env),
    ).toBe("hp_Alice|Alice|100");
  });

  test("foreachVar (local) and foreachGlobalVar (global)", async () => {
    const localEnv = makeEnv({ localVars: { item_sword: "1", item_shield: "1", gold: "5" } });
    expect(await ev("{{foreachVar::item_::i}}[{{.i}}]{{/foreachVar}}", localEnv)).toBe(
      "[shield][sword]",
    );
    const globalEnv = makeEnv({ globalVars: { theme_dark: "1", theme_light: "1" } });
    expect(await ev("{{foreachGlobalVar::theme_::t}}{{.t}};{{/foreachGlobalVar}}", globalEnv)).toBe(
      "dark;light;",
    );
  });

  test("empty prefix iterates the whole scope", async () => {
    const env = makeEnv({ chatVars: { a: "1", b: "2" } });
    expect(await ev("{{foreachChatVar::::k}}{{.k}}={{.k_value}};{{/foreachChatVar}}", env)).toBe(
      "a=1;b=2;",
    );
  });

  test("no matches → nothing", async () => {
    const env = makeEnv({ chatVars: { mood: "calm" } });
    expect(await ev("{{foreachChatVar::hp_::p}}x{{/foreachChatVar}}", env)).toBe("");
  });

  test("foreachGvar alias", async () => {
    const env = makeEnv({ globalVars: { g_x: "1" } });
    expect(await ev("{{foreachGvar::g_::v}}{{.v}}{{/foreachGvar}}", env)).toBe("x");
  });

  test("compose: sum a stat table", async () => {
    const env = makeEnv({ chatVars: { hp_Alice: "100", hp_Bob: "80", hp_Cara: "60" } });
    expect(
      await ev("{{sum::{{foreachChatVar::hp_::p}}{{.p_value}},{{/foreachChatVar}}}}", env),
    ).toBe("240");
  });

  test("hygiene: loop variable restored after the loop", async () => {
    const env = makeEnv({ chatVars: { n_a: "1" }, localVars: { p: "ORIG" } });
    expect(await ev("{{foreachChatVar::n_::p}}{{.p}}{{/foreachChatVar}}|{{.p}}", env)).toBe("a|ORIG");
  });
});

describe("Temporal macros", () => {
  test("{{idleDuration}} returns 'unknown' when no last message time is available", async () => {
    const env = makeEnv();
    delete (env.extra as any).lastMessageTime;
    expect(await ev("{{idleDuration}}", env)).toBe("unknown");
  });

  test("{{idleDuration}} formats time since the last assistant message", async () => {
    const env = makeEnv({ lastMessageTime: Date.now() - 90_000 });
    expect(await ev("{{idleDuration}}", env)).toBe("1 minute");
  });

  test("{{idleDuration}} formats multi-day durations", async () => {
    const env = makeEnv({ lastMessageTime: Date.now() - 3 * 24 * 60 * 60 * 1000 });
    expect(await ev("{{idleDuration}}", env)).toBe("3 days");
  });

  test("{{idle_duration}} alias works", async () => {
    const env = makeEnv({ lastMessageTime: Date.now() - 90_000 });
    expect(await ev("{{idle_duration}}", env)).toBe("1 minute");
  });
});

describe("JSON macros", () => {
  const STATE = '{"party":[{"name":"Ann","hp":0,"tags":null}],"flag":false,"title":"Hi","note":""}';
  const DOC = "{{getvar::doc}}";

  test("read macros and their snake_case aliases", async () => {
    const env = makeEnv({ localVars: { doc: STATE } });
    expect(await ev(`{{jsonGet::${DOC}::party[0].name}}|{{json_get::${DOC}::party[-1].hp}}`, env)).toBe("Ann|0");
    expect(await ev(`{{jsonGet::${DOC}::party[0]}}`, env)).toBe('{"name":"Ann","hp":0,"tags":null}');
    expect(await ev(`{{jsonGet::${DOC}::party[0].tags}}|{{jsonGet::${DOC}::nope}}`, env)).toBe("|");
    expect(
      await ev(
        `{{jsonHas::${DOC}::party[0].tags}}|{{json_has::${DOC}::flag}}|{{jsonHas::${DOC}::party[0].hp}}|` +
          `{{jsonHas::${DOC}::note}}|{{jsonHas::${DOC}::nope}}`,
        env,
      ),
    ).toBe("true|true|true|true|false");
    expect(await ev(`{{jsonKeys::${DOC}}}|{{json_keys::${DOC}::party}}`, env)).toBe("party, flag, title, note|0");
    expect(
      await ev(
        `{{jsonLength::${DOC}::party}}|{{json_length::${DOC}::title}}|{{jsonLength::${DOC}::flag}}|` +
          `{{jsonLength::${DOC}::nope}}`,
        env,
      ),
    ).toBe("1|2|0|0");
  });

  test("write macros return updated JSON, or the untouched input on failure", async () => {
    const env = makeEnv({ localVars: { doc: STATE } });
    expect(JSON.parse(await ev(`{{jsonSet::${DOC}::party[0].hp::7}}`, env)).party[0].hp).toBe(7);
    expect(
      JSON.parse(await ev(`{{json_set::${DOC}::party[]}}{"name":"Bo","hp":{"cur":3}}{{/json_set}}`, env)).party[1],
    ).toEqual({ name: "Bo", hp: { cur: 3 } });
    expect(JSON.parse(await ev(`{{jsonDelete::${DOC}::party[0]}}`, env)).party).toEqual([]);
    expect(await ev(`{{json_delete::${DOC}::nope}}`, env)).toBe(STATE);

    const failed = await evaluate(`{{jsonSet::${DOC}::party[5].hp::1}}`, env, registry);
    expect(failed.text).toBe(STATE);
    expect(failed.diagnostics.some((d) => d.level === "warn" && d.macroName === "jsonSet")).toBe(true);
    expect(env.variables.local.get("doc")).toBe(STATE);
  });

  test("jsonPretty and jsonEscape", async () => {
    const env = makeEnv({ localVars: { doc: '{"a":[1,{"b":"{x}"}]}' } });
    expect(await ev("{{jsonPretty::{{getvar::doc}}}}", env)).toBe(
      '{\n  "a": [\n    1,\n    {\n      "b": "\\u007bx\\u007d"\n    }\n  ]\n}',
    );
    expect(await ev("{{json_pretty::not json}}")).toBe("not json");
    expect(await ev('{{jsonEscape::He said "hi"}}')).toBe('He said \\"hi\\"');
    // A bare }} in body text is plain text, not the end of a macro.
    expect(await ev("{{json_escape}}line {{user}}\n}} end{{/json_escape}}")).toBe("line Alice\\n\\u007d\\u007d end");
  });

  test("JSON travels in a scoped body; an inline }} cuts it short with a warning", async () => {
    const env = makeEnv();
    expect(
      await ev('{{setchatvar::state}}{"a":{"b":1}}{{/setchatvar}}{{jsonGet::{{getchatvar::state}}::a.b}}', env),
    ).toBe("1");

    const cut = await evaluate('{{jsonGet::{"a":{"b":1}}::a.b}}', makeEnv(), registry);
    expect(cut.text).toBe("::a.b}}");
    expect(cut.diagnostics.some((d) => d.level === "warn" && d.macroName === "jsonGet")).toBe(true);

    const write = await evaluate('{{setvarkey::s::a::{"x":{"y":1}}}}', env, registry);
    expect(write.text).toBe("}}");
    expect(JSON.parse(env.variables.local.get("s")!)).toEqual({ a: '{"x":{"y":1' });
    expect(write.diagnostics.some((d) => d.level === "warn" && d.message.includes("starts like JSON"))).toBe(true);
  });

  test("JSON stored by {{#escape}} or written with \\{ escapes parses", async () => {
    const env = makeEnv();
    await ev('{{setchatvar::state}}{{#escape}}{"a":{"b":"{{user}}"}}{{/escape}}{{/setchatvar}}', env);
    expect(await ev("{{getchatvarkey::state::a.b}}|{{jsonGet::{{getchatvar::state}}::a.b}}", env)).toBe(
      "{{user}}|{{user}}",
    );
    expect(await ev('{{jsonGet::\\{"a":\\{"b":1\\}\\}::a.b}}')).toBe("1");
    expect(await ev('{{setvarkey::s::a::\\{"b":\\{"c":[1]\\}\\}}}{{getvarkey::s::a.b.c[0]}}')).toBe("1");
    expect(await ev('{{jsonGet::{"{x}":1}::["\\{x\\}"]}}|{{jsonEscape::\\{a\\}}}')).toBe(String.raw`1|\u007ba\u007d`);
  });

  test("data stays data: a stored macro opener never runs", async () => {
    const stored = String.raw`{"s":"\u007b\u007bsetvar::x::pwned\u007d\u007d"}`;
    const env = makeEnv({ chatVars: { state: stored }, localVars: { x: "safe" } });
    // {{notAMacro}} survives the first iteration, so the evaluator re-parses the
    // whole output after {{setvar}} has already changed state.
    const result = await evaluate(
      "{{jsonGet::{{getchatvar::state}}::s}}|{{getchatvarkey::state::s}}|{{setvar::x::still-safe}}{{notAMacro}}",
      env,
      registry,
    );
    expect(result.text).toBe("{{setvar::x::pwned}}|{{setvar::x::pwned}}|{{notAMacro}}");
    expect(env.variables.local.get("x")).toBe("still-safe");

    // Prompt assembly evaluates the output once more after regex scripts.
    const deferred = await evaluate("{{getchatvarkey::state::s}}", env, registry, { deferLiteralBraceRestore: true });
    expect((await evaluate(`${deferred.text}|{{user}}`, env, registry)).text).toBe("{{setvar::x::pwned}}|Alice");
    expect(env.variables.local.get("x")).toBe("still-safe");

    // The plain getters still return the stored text and ignore a second argument.
    expect(await ev("{{getchatvar::state}}|{{getchatvar::state::s}}|{{@state}}", env)).toBe(
      `${stored}|${stored}|${stored}`,
    );
  });

  test("jsonBlock picks valid blocks by index", async () => {
    const env = makeEnv({
      localVars: {
        msg: 'Intro <json>{"n":1}</json> <json>not json</json> <JSON>[2,{"t":"{x}"}]</JSON> <json>{"n":3}</json> end',
      },
    });
    const msg = "{{getvar::msg}}";
    expect(await ev(`{{jsonBlock::${msg}}}`, env)).toBe('{"n":1}');
    expect(await ev(`{{jsonBlock::${msg}::1}}`, env)).toBe(String.raw`[2,{"t":"\u007bx\u007d"}]`);
    expect(await ev(`{{json_block::${msg}::-1}}`, env)).toBe('{"n":3}');
    expect(await ev(`{{jsonBlock::${msg}::3}}|{{jsonBlock::no blocks here}}`, env)).toBe("|");
  });

  test("JSON macros read a held-out scoped body; a block in an argument is the argument's text", async () => {
    const env = makeEnv();
    const content =
      '{{setchatvarkey::state::stats}}<json>{"str":5}</json>{{/setchatvarkey}}|' +
      // An argument block reads as JSON until it holds `}}`, which closes the macro, as in presets.
      '{{jsonGet::<json>{"hp":3}</json>::hp}}|{{jsonGet::<json>{"a":{"b":1}}</json>::a.b}}|' +
      '<json>{"keep":"{{user}}"}</json>';
    const output = await withJsonBlocksProtected(content, env, async (text) => (await evaluate(text, env, registry)).text);
    expect(output).toBe('|3|</json>::a.b}}|<json>{"keep":"{{user}}"}</json>');
    expect(env.variables.chat.get("state")).toBe('{"stats":{"str":5}}');
  });

  test("stray openers before a valid block in a message leave the block protected", async () => {
    const env = makeEnv();
    // Each stray opener starts like JSON and shares the block's closer.
    const content = `${"<json>0 ".repeat(16)}<json>{"x":"{{setchatvar::owned::yes}}"}</json>`;
    const output = await withJsonBlocksProtected(content, env, async (text) => (await evaluate(text, env, registry)).text);
    expect(output).toBe(content);
    expect([...env.variables.local, ...env.variables.chat, ...env.variables.global]).toEqual([]);
  });

  test("a block whose strings hold <json> stays protected in a message", async () => {
    const env = makeEnv();
    const content = '<json>{"tag":"<json>","x":"{{setchatvar::owned::yes}}"}</json>';
    const output = await withJsonBlocksProtected(content, env, async (text) => (await evaluate(text, env, registry)).text);
    expect(output).toBe(content);
    expect([...env.variables.local, ...env.variables.chat, ...env.variables.global]).toEqual([]);
  });

  test("past the rejected-candidate cap, a message runs nothing and stays as written", async () => {
    const env = makeEnv();
    // The 256th rejected candidate stops the block scan before the block after it.
    const content = `${"<json>bad</json>".repeat(256)}<json>{"x":"{{setchatvar::owned::yes}}"}</json>`;
    const output = await withJsonBlocksProtected(content, env, async (text) => (await evaluate(text, env, registry)).text);
    expect(output).toBe(content);
    expect([...env.variables.local, ...env.variables.chat, ...env.variables.global]).toEqual([]);
  });

  test("a capped message stays whole, so no scoped macro is split where the scan stopped", async () => {
    const env = makeEnv();
    // Holding out only the text after the stop would hide {{/if}} and leak HIDDEN.
    const content = `{{if::false}}${"<json>bad</json>".repeat(256)}HIDDEN{{/if}}`;
    const output = await withJsonBlocksProtected(content, env, async (text) => (await evaluate(text, env, registry)).text);
    expect(output).toBe(content);
  });

  test("a capped message runs no macro before where the scan stopped either", async () => {
    const env = makeEnv();
    const content = `{{setchatvar::s}}x{{/setchatvar}}${"<json>bad</json>".repeat(256)}`;
    const output = await withJsonBlocksProtected(content, env, async (text) => (await evaluate(text, env, registry)).text);
    expect(output).toBe(content);
    expect([...env.variables.local, ...env.variables.chat, ...env.variables.global]).toEqual([]);
  });

  test("a block after a tag that a block inside it closed stays protected in a message", async () => {
    const env = makeEnv();
    const block = '<json>{"x":"{{setchatvar::owned::yes}}"}</json>';
    // The lexer closes {{setvar}} at the first block's `}}`, so the second block is outside every tag.
    const content = `{{setvar::v::<json>{"a":{}}</json>${block}`;
    const output = await withJsonBlocksProtected(content, env, async (text) => (await evaluate(text, env, registry)).text);
    expect(output).toBe(`</json>${block}`);
    expect([...env.variables.local]).toEqual([["v", '<json>{"a":{']]);
    expect([...env.variables.chat, ...env.variables.global]).toEqual([]);
  });

  test("an opener left in a block's string after its tag closed starts a protected block", async () => {
    const env = makeEnv();
    // The lexer closes {{setvar}} at the `}}` in the string after its <json>, so the <json> later in that string is outside every tag.
    const block = '<json>["]</json>{{setchatvar::owned::yes}}"]</json>';
    const content = `{{setvar::v::<json>["}}${block}`;
    const output = await withJsonBlocksProtected(content, env, async (text) => (await evaluate(text, env, registry)).text);
    expect(output).toBe(block);
    expect([...env.variables.local]).toEqual([["v", '<json>["']]);
    expect([...env.variables.chat, ...env.variables.global]).toEqual([]);
  });

  test("a stored block reads as JSON when a string in it holds </json>; two blocks in a row never do", async () => {
    const env = makeEnv({
      chatVars: { state: '<json>{"tag":"</json>","hp":3}</json>', pair: '<json>{"hp":1}</json><json>{"hp":2}</json>' },
    });
    expect(await ev("{{jsonGet::{{getchatvar::state}}::hp}}", env)).toBe("3");
    const pair = await evaluate("{{jsonGet::{{getchatvar::pair}}::hp}}", env, registry);
    expect(pair.text).toBe("");
    expect(pair.diagnostics.some((d) => d.level === "warn" && d.macroName === "jsonGet")).toBe(true);
  });

  test("a source read from a variable or message is data: nothing in it runs", async () => {
    // Raw JSON, as the model or an extension might store it, with macro text in a value and a key.
    const stored = '{"s":"{{setchatvar::owned::yes}}","{{setchatvar::alsoOwned::yes}}":1}';
    const env = makeEnv({ chatVars: { state: stored } });
    env.chat.lastCharMessage = `Done. <json>${stored}</json>`;
    // {{notAMacro}} survives the first iteration, so the evaluator parses the whole output again.
    const result = await evaluate(
      "{{jsonGet::{{getchatvar::state}}::s}}|{{jsonKeys::{{@state}}}}|{{jsonBlock::{{lastCharMessage}}}}{{notAMacro}}",
      env,
      registry,
    );
    expect(result.text).toBe(
      "{{setchatvar::owned::yes}}|s, {{setchatvar::alsoOwned::yes}}|" +
        String.raw`{"s":"\u007b\u007bsetchatvar::owned::yes\u007d\u007d","\u007b\u007bsetchatvar::alsoOwned::yes\u007d\u007d":1}` +
        "{{notAMacro}}",
    );
    expect(env.variables.chat.has("owned")).toBe(false);
    expect(env.variables.chat.has("alsoOwned")).toBe(false);
    expect(env._chatVarsDirty).toBeUndefined();
    expect(result.touchedVars.has("chat:state")).toBe(true);

    // Outside a JSON source, the getter still expands what it returns.
    expect(await ev("{{getchatvar::state}}", env)).toBe('{"s":"","":1}');
    expect(env.variables.chat.get("owned")).toBe("yes");
    expect(env.variables.chat.get("alsoOwned")).toBe("yes");
  });

  test("a getter with an operand or extra argument, and messageAt without an index, read data unexpanded", async () => {
    const owned = "{{setchatvar::owned::yes}}";
    const stored = JSON.stringify({ s: owned });
    const env = makeEnv({
      localVars: { state: stored },
      chatVars: { state: stored },
      globalVars: { state: stored },
      messages: [{ content: stored, name: "Bob", is_user: false }],
    });
    // {{notAMacro}} survives the first iteration, so the evaluator parses the whole output again.
    const result = await evaluate(
      "{{jsonGet::{{@state || 0}}::s}}|{{jsonGet::{{.state ?? x}}::s}}|{{jsonGet::{{$state}}::s}}|" +
        "{{jsonGet::{{getchatvar::state::ignored}}::s}}|{{jsonGet::{{messageAt}}::s}}{{notAMacro}}",
      env,
      registry,
    );
    expect(result.text).toBe(`${Array(5).fill(owned).join("|")}{{notAMacro}}`);
    expect(env.variables.chat.has("owned")).toBe(false);

    // An argument the getter ignores still runs, as it does when the getter resolves normally.
    expect(await ev("{{jsonGet::{{getchatvar::state::{{setvar::ran::yes}}}}::s}}", env)).toBe(owned);
    expect(env.variables.local.get("ran")).toBe("yes");
    expect(env.variables.chat.has("owned")).toBe(false);
  });

  test("arguments laid out over several lines lose their framing, as eager arguments do", async () => {
    const env = makeEnv({ chatVars: { state: '{"hp":1}' } });
    await ev("{{setchatvar::state::{{jsonSet::\n  {{getchatvar::state}}\n::\n  note\n::\n  two words\n}}}}", env);
    expect(env.variables.chat.get("state")).toBe('{"hp":1,"note":"two words"}');
  });

  test("a scoped jsonSet value is resolved before it is written", async () => {
    const env = makeEnv({ localVars: { doc: '{"hp":1}', who: "Ann" } });
    expect(
      await ev('{{jsonSet::{{getvar::doc}}::party[]}}{"name":"{{getvar::who}}","by":"{{user}}"}{{/jsonSet}}', env),
    ).toBe('{"hp":1,"party":[{"name":"Ann","by":"Alice"}]}');
  });

  test("a legacy tag in a JSON string survives later passes", async () => {
    const env = makeEnv({ chatVars: { state: '{"tag":"<user>"}' }, localVars: { raw: "<char>" } });
    // Rewriting the tag to a name holding a quote would break the JSON.
    env.names.user = 'A"B';
    await ev("{{setchatvarkey::state::hp::1}}", env);
    expect(env.variables.chat.get("state")).toBe(String.raw`{"tag":"\u003cuser>","hp":1}`);

    // {{notAMacro}} makes the evaluator parse its output again, and prompt
    // assembly evaluates that output once more after regex scripts.
    const first = await evaluate(
      "{{getchatvarkey::state}}|{{jsonSet::{{getchatvar::state}}::hp::2}}|{{jsonEscape::{{.raw}}}}{{notAMacro}}",
      env,
      registry,
      { deferLiteralBraceRestore: true },
    );
    const second = await ev(`${first.text} {{user}}`, env);
    expect(second).toBe(
      String.raw`{"tag":"\u003cuser>","hp":1}|{"tag":"\u003cuser>","hp":2}|\u003cchar>{{notAMacro}} A"B`,
    );
    expect(JSON.parse(second.split("|")[0])).toEqual({ tag: "<user>", hp: 1 });
  });

  test("a no-op or failed edit returns valid JSON in its own formatting, its strings inert", async () => {
    const state = '{"tag":"<user>", "n":1.50}';
    const env = makeEnv({ chatVars: { state } });
    // Rewriting the tag to a name holding a quote would break the JSON.
    env.names.user = 'A"B';
    // {{notAMacro}} makes the evaluator parse its output again, and prompt
    // assembly evaluates that output once more after regex scripts.
    const first = await evaluate(
      "{{jsonDelete::{{getchatvar::state}}::missing}}|{{jsonSet::{{getchatvar::state}}::tag.x::1}}{{notAMacro}}",
      env,
      registry,
      { deferLiteralBraceRestore: true },
    );
    const second = await ev(`${first.text} {{user}}`, env);
    const inert = String.raw`{"tag":"\u003cuser>", "n":1.50}`;
    expect(second).toBe(`${inert}|${inert}{{notAMacro}} A"B`);
    expect(JSON.parse(inert)).toEqual({ tag: "<user>", n: 1.5 });
    expect(first.diagnostics.filter((d) => d.level === "warn").map((d) => d.macroName)).toEqual(["jsonSet"]);
    expect(env.variables.chat.get("state")).toBe(state);
  });

  test("a number too large to store is rejected, never written as null", async () => {
    const big = '{"n":1e999,"hp":1}';
    const env = makeEnv({ chatVars: { big } });
    env.chat.lastCharMessage = '<json>{"n":[1e999]}</json> <json>{"n":1}</json>';
    const result = await evaluate(
      "{{setchatvarkey::state::amounts::[1e999]}}{{setchatvarkey::big::hp::2}}" +
        "{{jsonSet::{{getchatvar::big}}::hp::2}}|{{jsonBlock::{{lastCharMessage}}}}",
      env,
      registry,
    );
    // Like any value that only looks like JSON, it is written as text.
    expect(env.variables.chat.get("state")).toBe('{"amounts":"[1e999]"}');
    expect(env.variables.chat.get("big")).toBe(big);
    expect(result.text).toBe(`${big}|{"n":1}`);
    const warnings = result.diagnostics.filter((d) => d.level === "warn").map((d) => d.message);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("starts like JSON");
    expect(warnings[1]).toContain("a number is out of range");
    expect(warnings[2]).toContain("a number is out of range");
  });
});

describe("Variable JSON paths", () => {
  test("all three scopes write, read, test and delete by path", async () => {
    const env = makeEnv();
    await ev(
      "{{setvarkey::inv::items[]::sword}}{{setchatvarkey::state::party[0].name::Ann}}{{setgvarkey::prefs::theme.dark::true}}",
      env,
    );
    expect(env.variables.local.get("inv")).toBe('{"items":["sword"]}');
    expect(env.variables.chat.get("state")).toBe('{"party":[{"name":"Ann"}]}');
    expect(env.variables.global.get("prefs")).toBe('{"theme":{"dark":true}}');

    expect(
      await ev("{{getvarkey::inv::items[0]}}|{{getchatvarkey::state::party[0].name}}|{{getgvarkey::prefs::theme.dark}}", env),
    ).toBe("sword|Ann|true");
    expect(await ev("{{getchatvarkey::state::party[0]}}|{{getchatvarkey::state}}", env)).toBe(
      '{"name":"Ann"}|{"party":[{"name":"Ann"}]}',
    );
    expect(
      await ev("{{hasvarkey::inv::items}}|{{haschatvarkey::state::party[1]}}|{{hasgvarkey::prefs::theme}}", env),
    ).toBe("true|false|true");
    expect(await ev("{{getvarkey::missing::a}}|{{haschatvarkey::missing::a}}", env)).toBe("|false");

    await ev(
      "{{deletevarkey::inv::items[0]}}{{deletechatvarkey::state::party[0].name}}{{deletegvarkey::prefs::theme.dark}}",
      env,
    );
    expect(env.variables.local.get("inv")).toBe('{"items":[]}');
    expect(env.variables.chat.get("state")).toBe('{"party":[{}]}');
    expect(env.variables.global.get("prefs")).toBe('{"theme":{}}');
  });

  test("SillyTavern-style aliases", async () => {
    const env = makeEnv();
    await ev("{{setvarindex::list::[]::a}}{{setvarindex::list::[]::b}}", env);
    expect(await ev("{{getvarindex::list::1}}|{{getvarindex::list::-2}}", env)).toBe("b|a");
    await ev("{{setglobalvarkey::g::n::1}}{{setglobalvarindex::g::list[]::x}}", env);
    expect(await ev("{{getglobalvarkey::g::n}}|{{getglobalvarindex::g::list[0]}}", env)).toBe("1|x");
    expect(await ev("{{addglobalvarkey::g::n::2}}|{{hasglobalvarkey::g::n}}", env)).toBe("3|true");
    await ev("{{deleteglobalvarkey::g::n}}", env);
    expect(env.variables.global.get("g")).toBe('{"list":["x"]}');
  });

  test("getchatvarkey reports the variable it read", async () => {
    const env = makeEnv({ chatVars: { state: '{"hp":3}' } });
    const result = await evaluate("{{getchatvarkey::state::hp}}", env, registry);
    expect(result.text).toBe("3");
    expect(result.touchedVars.has("chat:state")).toBe(true);
  });

  test("a scoped body is the value, with }} and :: kept as text", async () => {
    const env = makeEnv();
    await ev("{{setchatvarkey::state::bio}}Line with }} and :: inside{{/setchatvarkey}}", env);
    expect(env.variables.chat.get("state")).toBe(String.raw`{"bio":"Line with \u007d\u007d and :: inside"}`);
    expect(await ev("{{getchatvarkey::state::bio}}", env)).toBe("Line with }} and :: inside");
  });

  test("a failed write leaves the variable byte-identical", async () => {
    const notJson = "plain text, not JSON";
    const spaced = '{ "hp": 5, "list": [] }';
    const env = makeEnv({ chatVars: { notes: notJson, state: spaced } });
    const result = await evaluate(
      "{{setchatvarkey::notes::a::1}}" +
        "{{setchatvarkey::state::hp.max::9}}" +
        "{{setchatvarkey::state::list[2]::x}}" +
        "{{setchatvarkey::state::a..b::1}}" +
        "{{addchatvarkey::state::hp::abc}}" +
        "{{addchatvarkey::state::list::1}}" +
        "{{deletechatvarkey::notes::a}}",
      env,
      registry,
    );
    expect(result.text).toBe("");
    expect(env.variables.chat.get("notes")).toBe(notJson);
    expect(env.variables.chat.get("state")).toBe(spaced);
    expect(env._chatVarsDirty).toBeUndefined();
    expect(result.diagnostics.filter((d) => d.level === "warn")).toHaveLength(7);
  });

  test("chat writers mark chat vars dirty only when they change something", async () => {
    const env = makeEnv({ chatVars: { state: '{"hp":5}' } });
    await ev(
      "{{getchatvarkey::state::hp}}{{haschatvarkey::state::hp}}{{deletechatvarkey::state::missing}}" +
        "{{setchatvarkey::state::hp::5}}",
      env,
    );
    expect(env._chatVarsDirty).toBeUndefined();
    await ev("{{setchatvarkey::state::hp::6}}", env);
    expect(env._chatVarsDirty).toBe(true);
    expect(env.variables.chat.get("state")).toBe('{"hp":6}');

    const deleting = makeEnv({ chatVars: { state: '{"hp":5}' } });
    await ev("{{deletechatvarkey::state::hp}}", deleting);
    expect(deleting._chatVarsDirty).toBe(true);
    expect(deleting.variables.chat.get("state")).toBe("{}");

    const otherScopes = makeEnv();
    await ev("{{setvarkey::a::b::1}}{{setgvarkey::c::d::1}}{{addvarkey::e::f::1}}", otherScopes);
    expect(otherScopes._chatVarsDirty).toBeUndefined();
  });

  test("add*key adds numbers and [] appends", async () => {
    const env = makeEnv({ chatVars: { state: '{"hp":10,"tags":["a"],"gone":null}' } });
    expect(await ev("{{addchatvarkey::state::hp::-3}}", env)).toBe("7");
    expect(await ev("{{addchatvarkey::state::gold::2.5}}", env)).toBe("2.5");
    expect(await ev("{{addchatvarkey::state::gone::1}}", env)).toBe("1");
    await ev("{{setchatvarkey::state::tags[]::b}}", env);
    await ev('{{setchatvarkey::state::tags[]}}{"c":{"d":1}}{{/setchatvarkey}}', env);
    expect(JSON.parse(env.variables.chat.get("state")!)).toEqual({
      hp: 7,
      tags: ["a", "b", { c: { d: 1 } }],
      gone: 1,
      gold: 2.5,
    });

    expect(await ev("{{addvarkey::counter::n::1}}", env)).toBe("1");
    expect(await ev("{{addvarkey::counter::n::1}}", env)).toBe("2");
    expect(await ev("{{addgvarkey::totals::[]::4}}", env)).toBe("4");
    expect(env.variables.global.get("totals")).toBe("[4]");
  });

  test("an empty name warns and does nothing", async () => {
    const env = makeEnv();
    const result = await evaluate("{{setvarkey::::a::1}}{{getchatvarkey}}", env, registry);
    expect(result.text).toBe("");
    expect(env.variables.local.size).toBe(0);
    expect(result.diagnostics.filter((d) => d.level === "warn")).toHaveLength(2);
  });
});

describe("Chat messages as JSON sources", () => {
  // Macro text, an escaped brace, and a legacy tag that no pass may run, unescape, or rewrite.
  const NOTE = String.raw`{{setvar::x::pwned}} \{ <user>`;
  const REPLY = `{{user}} opens the chest. <json>${JSON.stringify({ gold: 4, note: NOTE })}</json>`;
  const BLOCK_JSON = String.raw`{"gold":4,"note":"\u007b\u007bsetvar::x::pwned\u007d\u007d \\\u007b \u003cuser>"}`;

  test("jsonBlock reads the reply's block as written and runs nothing", async () => {
    const env = makeEnv();
    env.names.user = 'A"B';
    env.chat.lastCharMessage = REPLY;
    await ev("{{setvar::synced}}{{jsonBlock::{{lastCharMessage}}}}{{/setvar}}", env);
    expect(env.variables.local.get("synced")).toBe(BLOCK_JSON);
    expect(JSON.parse(BLOCK_JSON)).toEqual({ gold: 4, note: NOTE });

    // Prompt assembly evaluates the output once more after regex scripts.
    const first = await evaluate("{{jsonBlock::{{lastCharMessage}}::-1}}", env, registry, {
      deferLiteralBraceRestore: true,
    });
    expect(await ev(`${first.text} {{user}}`, env)).toBe(`${BLOCK_JSON} A"B`);
    expect(env.variables.local.has("x")).toBe(false);
  });

  test("messageAt and input are read the same way", async () => {
    const env = makeEnv({ messages: [{ content: REPLY, name: "Bob", is_user: false }] });
    env.chat.lastUserMessage = NOTE;
    expect(await ev("{{jsonBlock::{{messageAt::0}}}}|{{jsonEscape::{{input}}}}", env)).toBe(
      `${BLOCK_JSON}|${String.raw`\u007b\u007bsetvar::x::pwned\u007d\u007d \\\u007b \u003cuser>`}`,
    );
    expect(env.variables.local.has("x")).toBe(false);
  });
});


describe("JSON string composition", () => {
  test.each([
    ["lower", "a {b}"], ["upper", "A {B}"], ["len", "5"], ["reverse", "}B{ A"],
  ])("%s sees the actual characters of a JSON read", async (operation, expected) => {
    const env = makeEnv({ chatVars: { state: JSON.stringify({ note: "A {B}" }) } });
    expect(await ev(`{{${operation}::{{getchatvarkey::state::note}}}}`, env)).toBe(expected);
    expect(await ev(`{{${operation}::{{jsonGet::{{getchatvar::state}}::note}}}}`, env)).toBe(expected);
  });

  test("substring and replacement operate on literal braces without exposing markers", async () => {
    const env = makeEnv({ chatVars: { state: JSON.stringify({ note: "A {B}" }) } });
    expect(await ev("{{substr::{{getchatvarkey::state::note}}::2::5}}", env)).toBe("{B}");
    expect(await ev(String.raw`{{replace::\{::[::{{getchatvarkey::state::note}}}}`, env)).toBe("A [B}");
    await ev("{{setchatvarkey::state::copy::{{lower::{{getchatvarkey::state::note}}}}}}", env);
    expect(JSON.parse(env.variables.chat.get("state")!).copy).toBe("a {b}");
  });

  test("transforming a JSON read keeps macro-looking data inert across prompt passes", async () => {
    const env = makeEnv({ chatVars: { state: JSON.stringify({ note: "{{SETCHATVAR::owned::yes}}" }) } });
    const first = await evaluate("{{lower::{{getchatvarkey::state::note}}}}", env, registry, { deferLiteralBraceRestore: true });
    expect((await evaluate(`${first.text}|{{user}}`, env, registry)).text).toBe("{{setchatvar::owned::yes}}|Alice");
    expect(env.variables.chat.has("owned")).toBe(false);
  });
});
