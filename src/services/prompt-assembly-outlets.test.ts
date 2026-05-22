import { describe, expect, test, beforeAll } from "bun:test";
import { resolveWorldInfoOutlets } from "./prompt-assembly.service";
import { initMacros, registry } from "../macros";
import type { MacroEnv } from "../macros";
import type { WorldBookEntry } from "../types/world-book";

function makeMinimalEnv(): MacroEnv {
  return {
    commit: false,
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
      groupLastSpeaker: "",
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
    },
    system: {
      model: "test",
      maxPrompt: 4096,
      maxContext: 8192,
      maxResponse: 512,
      lastGenerationType: "normal",
      isMobile: false,
    },
    variables: {
      local: new Map(),
      global: new Map(),
      chat: new Map(),
    },
    dynamicMacros: {},
    extra: {
      messages: [],
      worldInfoOutlets: {},
    },
  };
}

function makeEntry(partial: Partial<WorldBookEntry>): WorldBookEntry {
  return {
    id: "entry-1",
    world_book_id: "wb-1",
    uid: "uid-1",
    outlet_name: null,
    key: [],
    keysecondary: [],
    content: "",
    comment: "",
    position: 0,
    depth: 0,
    role: null,
    order_value: 0,
    selective: false,
    constant: false,
    disabled: false,
    group_name: "",
    group_override: false,
    group_weight: 0,
    probability: 100,
    scan_depth: null,
    case_sensitive: false,
    match_whole_words: false,
    automation_id: null,
    use_regex: false,
    prevent_recursion: false,
    exclude_recursion: false,
    delay_until_recursion: false,
    priority: 0,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    selective_logic: 0,
    use_probability: false,
    vectorized: false,
    vector_index_status: "not_enabled",
    vector_indexed_at: null,
    vector_index_error: null,
    extensions: {},
    created_at: 0,
    updated_at: 0,
    ...partial,
  };
}

describe("resolveWorldInfoOutlets", () => {
  beforeAll(() => {
    initMacros();
  });

  test("single outlet resolves to its content", async () => {
    const env = makeMinimalEnv();
    const entries = [makeEntry({ outlet_name: "dossier", content: "Known as Bob" })];
    const result = await resolveWorldInfoOutlets(entries, env);
    expect(result.dossier).toBe("Known as Bob");
  });

  test("duplicate outlets are concatenated with double newline", async () => {
    const env = makeMinimalEnv();
    const entries = [
      makeEntry({ outlet_name: "dossier", content: "Known as Bob" }),
      makeEntry({ outlet_name: "dossier", content: "Lives in NYC" }),
    ];
    const result = await resolveWorldInfoOutlets(entries, env);
    expect(result.dossier).toBe("Known as Bob\n\nLives in NYC");
  });

  test("three duplicate outlets concatenate in order", async () => {
    const env = makeMinimalEnv();
    const entries = [
      makeEntry({ outlet_name: "notes", content: "First" }),
      makeEntry({ outlet_name: "notes", content: "Second" }),
      makeEntry({ outlet_name: "notes", content: "Third" }),
    ];
    const result = await resolveWorldInfoOutlets(entries, env);
    expect(result.notes).toBe("First\n\nSecond\n\nThird");
  });

  test("outlets with no content are skipped", async () => {
    const env = makeMinimalEnv();
    const entries = [
      makeEntry({ outlet_name: "dossier", content: "Known as Bob" }),
      makeEntry({ outlet_name: "dossier", content: "   " }),
      makeEntry({ outlet_name: "dossier", content: "Lives in NYC" }),
    ];
    const result = await resolveWorldInfoOutlets(entries, env);
    expect(result.dossier).toBe("Known as Bob\n\nLives in NYC");
  });

  test("outlet names are normalized to lowercase", async () => {
    const env = makeMinimalEnv();
    const entries = [
      makeEntry({ outlet_name: "Dossier", content: "First" }),
      makeEntry({ outlet_name: "DOSSIER", content: "Second" }),
    ];
    const result = await resolveWorldInfoOutlets(entries, env);
    expect(result.dossier).toBe("First\n\nSecond");
    expect(result.Dossier).toBeUndefined();
    expect(result.DOSSIER).toBeUndefined();
  });

  test("outlet macros inside concatenated content are resolved", async () => {
    const env = makeMinimalEnv();
    const entries = [
      makeEntry({ outlet_name: "base", content: "Base info" }),
      makeEntry({ outlet_name: "dossier", content: "{{outlet::base}} and more" }),
      makeEntry({ outlet_name: "dossier", content: "Even more" }),
    ];
    const result = await resolveWorldInfoOutlets(entries, env);
    expect(result.dossier).toBe("Base info and more\n\nEven more");
  });
});
