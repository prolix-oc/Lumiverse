import { describe, expect, test } from "bun:test";
import { buildEnv, initMacros } from "../macros";
import type { Character } from "../types/character";
import type { Chat } from "../types/chat";
import {
  DEFAULT_REGEN_FEEDBACK_FORMAT,
  resolveRegenFeedbackPrompt,
} from "./prompt-assembly.service";

const character: Character = {
  id: "character-1",
  name: "Lumia",
  avatar_path: null,
  image_id: null,
  description: "",
  personality: "",
  scenario: "",
  first_mes: "",
  mes_example: "",
  creator: "",
  creator_notes: "",
  system_prompt: "",
  post_history_instructions: "",
  folder: "",
  tags: [],
  alternate_greetings: [],
  extensions: {},
  created_at: 0,
  updated_at: 0,
};

const chat: Chat = {
  id: "chat-1",
  character_id: character.id,
  name: "Test",
  metadata: {},
  created_at: 0,
  updated_at: 0,
};

function makeEnv() {
  initMacros();
  return buildEnv({
    character,
    persona: null,
    chat,
    messages: [],
    generationType: "regenerate",
    connection: null,
  });
}

describe("regen feedback prompt format", () => {
  test("keeps the legacy OOC wrapper as the default", async () => {
    expect(
      await resolveRegenFeedbackPrompt(undefined, "make it warmer", makeEnv()),
    ).toBe("[OOC: make it warmer]");
    expect(DEFAULT_REGEN_FEEDBACK_FORMAT).toBe("[OOC: {{$regenInput}}]");
  });

  test("supports freeform multiline templates and regular macros", async () => {
    const format = "<system>\n\n{{char}} should follow these instructions:\n\n{{$regenInput}}";
    expect(
      await resolveRegenFeedbackPrompt(format, "Use shorter sentences.", makeEnv()),
    ).toBe(
      "<system>\n\nLumia should follow these instructions:\n\nUse shorter sentences.",
    );
  });

  test("does not evaluate macro syntax inside submitted feedback", async () => {
    expect(
      await resolveRegenFeedbackPrompt(
        "Before {{$regenInput}} After",
        "{{char}} stays literal",
        makeEnv(),
      ),
    ).toBe("Before {{char}} stays literal After");
  });

  test("replaces every guarded placeholder", async () => {
    expect(
      await resolveRegenFeedbackPrompt(
        "{{$regenInput}} / {{$regenInput}}",
        "again",
        makeEnv(),
      ),
    ).toBe("again / again");
  });
});
