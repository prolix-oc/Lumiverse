import { describe, test, expect, beforeAll } from "bun:test";
import { evaluate } from "./MacroEvaluator";
import { parse } from "./MacroParser";
import { registry } from "./MacroRegistry";
import { initMacros } from "./index";
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
  worldInfoOutlets?: Record<string, string>;
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
      groupLastSpeaker: "Charlie",
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
    extra: {
      messages: opts.messages ?? [
        { content: "Hello, how are you?", name: "Alice", is_user: true },
        { content: "I'm fine, thanks!", name: "Bob", is_user: false },
        { content: "Let's go on an adventure.", name: "Alice", is_user: true },
        { content: "The forest is dark.", name: "Bob", is_user: false },
        { content: "I draw my sword.", name: "Alice", is_user: true },
      ],
      chatCreatedAt: opts.chatCreatedAt ?? Math.floor(Date.now() / 1000) - 3600,
      characterTags: opts.characterTags ?? ["fantasy", "warrior", "male"],
      worldInfoOutlets: opts.worldInfoOutlets ?? {},
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

// ===========================================================================
// EXISTING MACROS — Regression tests
// ===========================================================================

describe("Core primitives", () => {
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
});

describe("Persona pronoun macros", () => {
  test("JanitorAI persona pronouns resolve", async () => {
    expect(await ev("{{sub}}/{{obj}}/{{poss}}")).toBe("she/her/her");
  });

  test("explicit persona pronoun aliases resolve", async () => {
    expect(await ev("{{subjectivePronoun}} {{objectivePronoun}} {{possessivePronoun}}")).toBe("she her her");
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

  test("charTags", async () => {
    expect(await ev("{{charTags}}")).toBe("fantasy, warrior, male");
  });

  test("charTag exists", async () => {
    expect(await ev("{{charTag::fantasy}}")).toBe("true");
  });

  test("charTag case insensitive", async () => {
    expect(await ev("{{charTag::WARRIOR}}")).toBe("true");
  });

  test("charTag missing", async () => {
    expect(await ev("{{charTag::scifi}}")).toBe("false");
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
  test("lumiaCouncilInst matches the extension council prompt verbatim", async () => {
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
    expect(result).toContain("COUNCIL MODE ACTIVATED! We Lumias gather in the Loom's planning room to weave the next story beat TOGETHER.");
    expect(result).toContain("- Address each other BY NAME—no speaking into the void");
    expect(result).toContain("This is a conversation, not a list of separate opinions. Every voice responds to what came before.");
    expect(result).toContain("The current sitting members of the council are: **Mira**, **Kael**");
  });

  test("lumiaStateSynthesis matches the extension council sound-off prompt", async () => {
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
    expect(result).toContain("**Council Sound-Off**");
    expect(result).toContain("- Each member maintains their UNIQUE personality—do not blend or homogenize voices");
    expect(result).not.toContain("Members kick off in first person as named individuals");
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
    expect(result).toContain("2. Debate which suggestions have the most merit");
    expect(result).not.toContain("2. Debate which suggestions have the most merit in first person as named council members responding to each other");
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
