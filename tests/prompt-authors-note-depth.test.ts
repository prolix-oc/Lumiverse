import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";

import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import * as charactersSvc from "../src/services/characters.service";
import * as chatsSvc from "../src/services/chats.service";
import * as presetsSvc from "../src/services/presets.service";
import * as worldBooksSvc from "../src/services/world-books.service";
import { assemblePrompt, isChatHistoryMessage } from "../src/services/prompt-assembly.service";
import type { PromptBlock } from "../src/types/preset";

const USER_ID = "prompt-authors-note-depth-user";
const NOTE = "Author's note for Nyra";

function makeBlock(overrides: Partial<PromptBlock>): PromptBlock {
  return {
    id: crypto.randomUUID(),
    name: "block",
    content: "",
    role: "system",
    enabled: true,
    position: "pre_history",
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    group: null,
    ...overrides,
  };
}

async function assembleWithNote(depth: number | undefined, messageCount = 6) {
  const book = worldBooksSvc.createWorldBook(USER_ID, { name: "Lore" });
  worldBooksSvc.createEntry(USER_ID, book.id, {
    constant: true,
    position: 4,
    depth: 3,
    content: "Interleaved lore",
  });
  const character = charactersSvc.createCharacter(USER_ID, {
    name: "Nyra",
    post_history_instructions: "Post-history instructions",
    extensions: { world_book_ids: [book.id] },
  });
  const chat = chatsSvc.createChat(USER_ID, {
    character_id: character.id,
    metadata: { authors_note: { content: "Author's note for {{char}}", depth, role: "system" } },
  });
  for (let i = 0; i < messageCount; i++) {
    chatsSvc.createMessage(chat.id, {
      is_user: i % 2 === 0,
      name: i % 2 === 0 ? "User" : "Nyra",
      content: `History ${i}`,
    }, USER_ID);
  }
  const preset = presetsSvc.createPreset(USER_ID, {
    name: "Author's note depth preset",
    provider: "openai",
    parameters: {},
    prompts: {},
    prompt_order: [
      makeBlock({ content: "Preamble" }),
      makeBlock({ name: "Chat History", marker: "chat_history" }),
      makeBlock({ content: "Post-history block", position: "post_history" }),
    ],
  });
  return assemblePrompt({
    userId: USER_ID,
    chatId: chat.id,
    generationType: "normal",
    presetId: preset.id,
  });
}

describe("author's note chat-history depth", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    const db = getDb();
    db.run("PRAGMA foreign_keys = OFF");
    db.run(await Bun.file(join(import.meta.dir, "..", "src", "db", "baseline.sql")).text());
  });

  afterEach(() => closeDatabase());

  test.each([
    { depth: 0, messagesAfter: 0 },
    { depth: 1, messagesAfter: 1 },
    { depth: 2, messagesAfter: 2 },
    { depth: 4, messagesAfter: 4 },
    { depth: 9999, messagesAfter: 6 },
    { depth: undefined, messagesAfter: 4 },
  ])("depth $depth counts back through chat messages only", async ({ depth, messagesAfter }) => {
    const result = await assembleWithNote(depth);
    const contents = result.messages.map((message) => message.content);
    const noteIndex = contents.indexOf(NOTE);

    expect(contents).toContain("Interleaved lore");
    expect(contents.filter((content) => content === NOTE)).toHaveLength(1);
    expect(noteIndex).toBeGreaterThan(contents.indexOf("Preamble"));
    expect(noteIndex).toBeLessThan(contents.indexOf("Post-history block"));
    expect(noteIndex).toBeLessThan(contents.indexOf("Post-history instructions"));
    expect(result.messages.slice(noteIndex + 1).filter(isChatHistoryMessage)).toHaveLength(messagesAfter);
    expect(result.messages[noteIndex].role).toBe("system");
    expect(result.breakdown.filter((entry) => entry.type === "authors_note")).toEqual([
      { type: "authors_note", name: "Author's Note", role: "system", content: NOTE },
    ]);
    if (depth === 0) {
      expect(noteIndex).toBe(contents.indexOf("History 5") + 1);
    }
  });

  test("appends safely when there is no chat history", async () => {
    const result = await assembleWithNote(4, 0);
    expect(result.messages.filter(isChatHistoryMessage)).toHaveLength(0);
    expect(result.messages.at(-1)?.content).toBe(NOTE);
  });
});
