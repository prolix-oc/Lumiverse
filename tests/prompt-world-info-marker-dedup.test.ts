import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";

import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import * as charactersSvc from "../src/services/characters.service";
import * as chatsSvc from "../src/services/chats.service";
import * as presetsSvc from "../src/services/presets.service";
import * as worldBooksSvc from "../src/services/world-books.service";
import { assemblePrompt } from "../src/services/prompt-assembly.service";

const USER_ID = "prompt-world-info-marker-dedup-user";
const LORE_CONTENT = "UNIQUE_LORE_CONTENT_FOR_DUPLICATE_MARKER_TEST";

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(
    await Bun.file(
      join(import.meta.dir, "..", "src", "db", "baseline.sql"),
    ).text(),
  );
}

function makeBlock(overrides: Record<string, any> = {}) {
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

describe("prompt world-info structural marker deduplication", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
  });

  test("a second World Info Before marker with a Databank display name does not repeat lore", async () => {
    const book = worldBooksSvc.createWorldBook(USER_ID, { name: "Lore" });
    worldBooksSvc.createEntry(USER_ID, book.id, {
      constant: true,
      position: 0,
      content: LORE_CONTENT,
    });

    const character = charactersSvc.createCharacter(USER_ID, {
      name: "Nyra",
      extensions: { world_book_ids: [book.id] },
    });
    const chat = chatsSvc.createChat(USER_ID, { character_id: character.id });
    chatsSvc.createMessage(
      chat.id,
      { is_user: true, name: "User", content: "Hello" },
      USER_ID,
    );

    const preset = presetsSvc.createPreset(USER_ID, {
      name: "Duplicate marker preset",
      provider: "openai",
      engine: "chat",
      parameters: {},
      prompts: {},
      metadata: {},
      prompt_order: [
        makeBlock({ name: "World Info Before", marker: "world_info_before" }),
        makeBlock({ name: "Databank", marker: "world_info_before" }),
        makeBlock({ name: "Chat History", marker: "chat_history" }),
      ],
    } as any);

    const result = await assemblePrompt({
      userId: USER_ID,
      chatId: chat.id,
      generationType: "normal",
      presetId: preset.id,
    } as any);

    const matchingMessages = result.messages.filter(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes(LORE_CONTENT),
    );
    const matchingBreakdown = result.breakdown.filter(
      (entry) => entry.type === "world_info" && entry.content?.includes(LORE_CONTENT),
    );

    expect(matchingMessages).toHaveLength(1);
    expect(matchingBreakdown).toHaveLength(1);
  });
});
