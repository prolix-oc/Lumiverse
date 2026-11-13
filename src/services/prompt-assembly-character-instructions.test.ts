import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, initDatabase } from "../db/connection";
import { initMacros } from "../macros";
import type { PromptBlock } from "../types/preset";
import { createCharacter } from "./characters.service";
import { createChat, createMessage } from "./chats.service";
import { createPreset } from "./presets.service";
import { assemblePrompt } from "./prompt-assembly.service";

const USER_ID = "character-instructions-user";
const SYSTEM = "System instructions for Nyra";
const PHI = "Post-history instructions for Nyra";
const fields = [
  { marker: "system_prompt", text: SYSTEM, aliases: ["system", "charPrompt", "charSystem"] },
  { marker: "post_history_instructions", text: PHI, aliases: ["charPostHistoryInstructions", "charInstruction", "jailbreak", "charJailbreak"] },
];

function block(overrides: Partial<PromptBlock> = {}): PromptBlock {
  return {
    id: crypto.randomUUID(), name: "Block", content: "", role: "system",
    enabled: true, position: "pre_history", depth: 0, marker: null,
    isLocked: false, color: null, injectionTrigger: [], group: null,
    ...overrides,
  };
}

async function assemble(blocks: PromptBlock[], emptyFields = false) {
  const character = createCharacter(USER_ID, {
    name: "Nyra",
    system_prompt: emptyFields ? " \n " : "System instructions for {{char}}",
    post_history_instructions: emptyFields ? "" : "Post-history instructions for {{char}}",
  });
  const chat = createChat(USER_ID, { character_id: character.id });
  for (let i = 0; i < 4; i++) {
    createMessage(chat.id, {
      is_user: i % 2 === 0, name: i % 2 === 0 ? "User" : "Nyra", content: `History ${i}`,
    }, USER_ID);
  }
  const preset = createPreset(USER_ID, {
    name: "Character instructions", provider: "openai", prompt_order: blocks,
    prompts: { promptBehavior: { emptySendNudge: "" } },
  });
  return assemblePrompt({
    userId: USER_ID, chatId: chat.id, generationType: "normal", presetOverride: preset,
    macroCommit: false, skipPromptRegex: true,
  });
}

describe("character instruction markers and fallbacks", () => {
  beforeEach(async () => {
    closeDatabase();
    const db = initDatabase(":memory:");
    db.run("PRAGMA foreign_keys = OFF");
    db.run(await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text());
    initMacros();
  });
  afterEach(() => closeDatabase());

  test("existing presets receive the card system prompt before blocks and PHI after history", async () => {
    const result = await assemble([
      block({ content: "Preamble" }), block({ marker: "chat_history" }),
      block({ content: "After history", position: "post_history" }),
    ]);
    expect(result.messages.map(row => row.content)).toEqual([
      SYSTEM, "Preamble", "History 0", "History 1", "History 2", "History 3", "After history", PHI,
    ]);
    for (const { marker, text } of fields) {
      expect(result.breakdown.filter(row => row.marker === marker)).toEqual([
        expect.objectContaining({ role: "system", content: text }),
      ]);
    }
  });

  for (const { marker, text, aliases } of fields) {
    test.each(["pre_history", "post_history", "in_history"] as const)(`${marker} respects %s placement and role without fallback duplication`, async position => {
      const instruction = block({ marker, name: "Card instructions", role: "user", position, depth: 2, content: "Ignored structural content" });
      const history = block({ marker: "chat_history" });
      const result = await assemble(position === "pre_history" ? [instruction, history] : [history, instruction]);
      const contents = result.messages.map(row => row.content);
      const index = contents.indexOf(text);
      expect(contents.filter(value => value === text)).toHaveLength(1);
      expect(contents).not.toContain("Ignored structural content");
      expect(result.messages[index].role).toBe("user");
      if (position === "pre_history") expect(index).toBeLessThan(contents.indexOf("History 0"));
      if (position === "post_history") expect(index).toBeGreaterThan(contents.indexOf("History 3"));
      if (position === "in_history") {
        expect(index).toBe(contents.indexOf("History 1") + 1);
        expect(index + 1).toBe(contents.indexOf("History 2"));
      }
      expect(result.breakdown.filter(row => row.marker === marker)).toEqual([
        expect.objectContaining({ blockId: instruction.id, content: text, role: "user" }),
      ]);
    });

    test.each(aliases)(`${marker} macro alias %s prevents fallback duplication`, async alias => {
      const result = await assemble([
        block({ marker: "main_prompt", content: `Before {{${alias}}} after` }),
        block({ marker: "chat_history" }),
      ]);
      expect(result.messages.map(row => row.content)).toContain(`Before ${text} after`);
      expect(result.messages.map(row => row.content)).not.toContain(text);
    });

    test.each([
      { enabled: false }, { injectionTrigger: ["continue"] }, { characterTagTrigger: ["missing-tag"] },
    ] satisfies Partial<PromptBlock>[])(`${marker} suppresses fallback when its explicit marker is inactive: %j`, async overrides => {
      const result = await assemble([block({ marker, ...overrides }), block({ marker: "chat_history" })]);
      expect(result.messages.map(row => row.content)).not.toContain(text);
    });

    test(`${marker} macros in disabled content do not prevent fallback`, async () => {
      const result = await assemble([
        block({ content: `{{${aliases[0]}}}`, enabled: false }), block({ marker: "chat_history" }),
      ]);
      expect(result.messages.map(row => row.content)).toContain(text);
    });
  }

  test("literal and commented macros do not suppress either fallback", async () => {
    const result = await assemble([
      block({ content: "{{#escape}}{{system}}{{/escape}}{{//::{{charPostHistoryInstructions}}}}" }),
      block({ marker: "chat_history" }),
    ]);
    const contents = result.messages.map(row => row.content);
    expect(contents).toContain(SYSTEM);
    expect(contents).toContain(PHI);
    expect(contents).toContain("{{system}}");
  });

  test("empty card fields emit no instruction messages", async () => {
    const result = await assemble([block({ marker: "chat_history" })], true);
    expect(result.messages.map(row => row.content)).toEqual(["History 0", "History 1", "History 2", "History 3"]);
  });
});
