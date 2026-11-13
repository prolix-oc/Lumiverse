import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";

import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import * as charactersSvc from "../src/services/characters.service";
import * as chatsSvc from "../src/services/chats.service";
import * as presetsSvc from "../src/services/presets.service";
import * as worldBooksSvc from "../src/services/world-books.service";
import {
  assemblePrompt,
  isChatHistoryMessage,
  isWorldInfoEntryMessage,
} from "../src/services/prompt-assembly.service";
import type { PromptBlock } from "../src/types/preset";

const USER_ID = "prompt-world-info-marker-depth-user";

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

async function assembleWithWorldInfoMarkers(
  before: Partial<PromptBlock>,
  after: Partial<PromptBlock>,
) {
  const book = worldBooksSvc.createWorldBook(USER_ID, { name: "Lore" });
  worldBooksSvc.createEntry(USER_ID, book.id, {
    constant: true,
    position: 0,
    comment: "Before",
    content: "Lore before",
  });
  worldBooksSvc.createEntry(USER_ID, book.id, {
    constant: true,
    position: 1,
    order_value: 10,
    comment: "After A",
    content: "Lore after A",
  });
  worldBooksSvc.createEntry(USER_ID, book.id, {
    constant: true,
    position: 1,
    order_value: 20,
    comment: "After B",
    content: "Lore after B",
  });
  const character = charactersSvc.createCharacter(USER_ID, {
    name: "Nyra",
    extensions: { world_book_ids: [book.id] },
  });
  const chat = chatsSvc.createChat(USER_ID, { character_id: character.id });
  for (let i = 0; i < 5; i++) {
    chatsSvc.createMessage(chat.id, {
      is_user: i % 2 === 0,
      name: i % 2 === 0 ? "User" : "Nyra",
      content: `History ${i}`,
    }, USER_ID);
  }
  const preset = presetsSvc.createPreset(USER_ID, {
    name: "World info marker depth preset",
    provider: "openai",
    parameters: {},
    prompts: {},
    prompt_order: [
      makeBlock({ content: "Preamble" }),
      makeBlock({ name: "Chat History", marker: "chat_history" }),
      makeBlock({ name: "World Info Before", marker: "world_info_before", ...before }),
      makeBlock({ content: "Depth note first", position: "in_history", depth: 0 }),
      makeBlock({ name: "World Info After", marker: "world_info_after", ...after }),
      makeBlock({ content: "Depth note last", position: "in_history", depth: 0 }),
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

const LORE = ["Lore before", "Lore after A", "Lore after B"];

function expectWorldInfoBookkeeping(
  result: Awaited<ReturnType<typeof assembleWithWorldInfoMarkers>>,
) {
  for (const lore of LORE) {
    const matches = result.messages.filter((message) => message.content === lore);
    expect(matches).toHaveLength(1);
    expect(isWorldInfoEntryMessage(matches[0])).toBe(true);
    expect(isChatHistoryMessage(matches[0])).toBe(false);
  }
  expect(
    result.breakdown
      .filter((entry) => LORE.includes(entry.content ?? ""))
      .map(({ type, name, role, content }) => ({ type, name, role, content })),
  ).toEqual([
    { type: "world_info", name: "World Info Before: Before", role: "system", content: "Lore before" },
    { type: "world_info", name: "World Info After: After A", role: "system", content: "Lore after A" },
    { type: "world_info", name: "World Info After: After B", role: "system", content: "Lore after B" },
  ]);
}

describe("prompt world-info marker chat-history depth", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    const db = getDb();
    db.run("PRAGMA foreign_keys = OFF");
    db.run(await Bun.file(join(import.meta.dir, "..", "src", "db", "baseline.sql")).text());
  });

  afterEach(() => closeDatabase());

  test("in-history markers insert their entries at the block depth", async () => {
    const result = await assembleWithWorldInfoMarkers(
      { position: "in_history", depth: 2 },
      { position: "in_history", depth: 0 },
    );

    expect(result.messages.map((message) => message.content)).toEqual([
      "Preamble",
      "History 0",
      "History 1",
      "History 2",
      "Lore before",
      "History 3",
      "History 4",
      "Depth note first",
      "Lore after A",
      "Lore after B",
      "Depth note last",
      "Post-history block",
    ]);
    expectWorldInfoBookkeeping(result);
  });

  test("pre- and post-history markers still emit at their prompt slot", async () => {
    const result = await assembleWithWorldInfoMarkers(
      { position: "pre_history", depth: 2 },
      { position: "post_history", depth: 0 },
    );

    expect(result.messages.map((message) => message.content)).toEqual([
      "Preamble",
      "History 0",
      "History 1",
      "History 2",
      "History 3",
      "History 4",
      "Depth note first",
      "Depth note last",
      "Lore before",
      "Lore after A",
      "Lore after B",
      "Post-history block",
    ]);
    expectWorldInfoBookkeeping(result);
  });
});
