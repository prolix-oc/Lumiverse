import { describe, expect, test } from "bun:test";
import { buildEnv } from "./MacroEnv";
import type { Character } from "../types/character";
import type { Chat } from "../types/chat";
import type { Message } from "../types/message";
import type { Persona } from "../types/persona";

const baseCharacter: Character = {
  id: "char-1",
  name: "Bob",
  avatar_path: null,
  image_id: null,
  description: "",
  personality: "",
  scenario: "",
  first_mes: "Original greeting",
  mes_example: "",
  creator: "",
  creator_notes: "",
  system_prompt: "",
  post_history_instructions: "",
  tags: [],
  alternate_greetings: [],
  extensions: {},
  created_at: 0,
  updated_at: 0,
};

const baseChat: Chat = {
  id: "chat-1",
  character_id: "char-1",
  name: "Test Chat",
  metadata: {},
  created_at: 0,
  updated_at: 0,
};

const basePersona: Persona = {
  id: "persona-1",
  name: "Alice",
  title: "",
  description: "",
  subjective_pronoun: "",
  objective_pronoun: "",
  possessive_pronoun: "",
  folder: "",
  avatar_path: null,
  image_id: null,
  is_default: true,
  is_narrator: false,
  attached_world_book_id: null,
  metadata: {},
  created_at: 0,
  updated_at: 0,
};

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: overrides.id || crypto.randomUUID(),
    chat_id: overrides.chat_id || "chat-1",
    index_in_chat: overrides.index_in_chat ?? 0,
    is_user: overrides.is_user ?? false,
    name: overrides.name || "Bob",
    content: overrides.content || "",
    send_date: overrides.send_date ?? 0,
    swipe_id: overrides.swipe_id ?? 0,
    swipes: overrides.swipes || [overrides.content || ""],
    swipe_dates: overrides.swipe_dates || [0],
    extra: overrides.extra || {},
    parent_message_id: overrides.parent_message_id ?? null,
    branch_id: overrides.branch_id ?? null,
    created_at: overrides.created_at ?? 0,
  };
}

describe("buildEnv firstMessage", () => {
  test("uses the chat opening assistant message for single chats", () => {
    const env = buildEnv({
      character: baseCharacter,
      persona: null,
      chat: baseChat,
      messages: [
        makeMessage({ content: "Edited chat greeting", extra: { greeting: true } }),
        makeMessage({ id: "msg-2", is_user: true, name: "User", content: "Hi", index_in_chat: 1 }),
      ],
      generationType: "normal",
      connection: null,
    });

    expect(env.character.firstMessage).toBe("Edited chat greeting");
  });

  test("falls back to the first assistant message for legacy single chats", () => {
    const env = buildEnv({
      character: baseCharacter,
      persona: null,
      chat: baseChat,
      messages: [
        makeMessage({ content: "Legacy edited greeting" }),
        makeMessage({ id: "msg-2", is_user: true, name: "User", content: "Hi", index_in_chat: 1 }),
      ],
      generationType: "normal",
      connection: null,
    });

    expect(env.character.firstMessage).toBe("Legacy edited greeting");
  });

  test("uses tagged group greeting for the active character", () => {
    const env = buildEnv({
      character: baseCharacter,
      persona: null,
      chat: { ...baseChat, metadata: { group: true, character_ids: ["char-1", "char-2"] } },
      messages: [
        makeMessage({ content: "Group greeting", extra: { greeting: true, greeting_character_id: "char-1" } }),
        makeMessage({ id: "msg-2", content: "Other greeting", extra: { greeting: true, greeting_character_id: "char-2" }, index_in_chat: 1 }),
      ],
      generationType: "normal",
      connection: null,
    });

    expect(env.character.firstMessage).toBe("Group greeting");
  });
});

describe("buildEnv persona pronouns", () => {
  test("defaults blank persona pronouns to neutral values", () => {
    const env = buildEnv({
      character: baseCharacter,
      persona: basePersona,
      chat: baseChat,
      messages: [],
      generationType: "normal",
      connection: null,
    });

    expect(env.character.personaSubjectivePronoun).toBe("they");
    expect(env.character.personaObjectivePronoun).toBe("them");
    expect(env.character.personaPossessivePronoun).toBe("their");
  });

  test("uses configured persona pronouns when present", () => {
    const env = buildEnv({
      character: baseCharacter,
      persona: {
        ...basePersona,
        subjective_pronoun: " she ",
        objective_pronoun: " her ",
        possessive_pronoun: " her ",
      },
      chat: baseChat,
      messages: [],
      generationType: "normal",
      connection: null,
    });

    expect(env.character.personaSubjectivePronoun).toBe("she");
    expect(env.character.personaObjectivePronoun).toBe("her");
    expect(env.character.personaPossessivePronoun).toBe("her");
  });
});

describe("buildEnv groupCardMode", () => {
  test("returns 'solo' for non-group chats regardless of metadata", () => {
    const env = buildEnv({
      character: baseCharacter,
      persona: null,
      chat: { ...baseChat, metadata: { group_card_mode: "merge" } },
      messages: [],
      generationType: "normal",
      connection: null,
    });
    expect(env.names.groupCardMode).toBe("solo");
    expect(env.names.isGroupChat).toBe("no");
  });

  test("returns the raw mode for group chats with merge / merge_ignore_muted", () => {
    for (const mode of ["merge", "merge_ignore_muted"]) {
      const env = buildEnv({
        character: baseCharacter,
        persona: null,
        chat: {
          ...baseChat,
          metadata: {
            group: true,
            character_ids: ["char-1", "char-2"],
            group_card_mode: mode,
          },
        },
        messages: [],
        generationType: "normal",
        connection: null,
      });
      expect(env.names.groupCardMode).toBe(mode);
    }
  });

  test("defaults to 'swap' for group chats with an unset or unrecognized mode", () => {
    for (const raw of [undefined, null, "", "garbage", 42]) {
      const env = buildEnv({
        character: baseCharacter,
        persona: null,
        chat: {
          ...baseChat,
          metadata: {
            group: true,
            character_ids: ["char-1", "char-2"],
            ...(raw !== undefined ? { group_card_mode: raw } : {}),
          },
        },
        messages: [],
        generationType: "normal",
        connection: null,
      });
      expect(env.names.groupCardMode).toBe("swap");
    }
  });
});
