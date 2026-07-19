import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { closeDatabase, initDatabase } from "../db/connection";
import * as charactersSvc from "./characters.service";
import * as chatsSvc from "./chats.service";
import * as worldBooksSvc from "./world-books.service";
import { collectWorldInfoSources } from "./world-info-sources.service";
import { prefetchAssemblyData } from "./prompt-assembly-prefetch";
import { setCharacterWorldBookIds } from "../utils/character-world-books";
import { getDb } from "../db/connection";

const USER_ID = "group-lorebooks-user";

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
}

function createCharacterWithBook(name: string, content: string) {
  const book = worldBooksSvc.createWorldBook(USER_ID, { name: `${name} Book` });
  const entry = worldBooksSvc.createEntry(USER_ID, book.id, {
    key: [name.toLowerCase()],
    content,
    comment: `${name} lore`,
  });
  if (!entry) throw new Error("Failed to create world-book entry");

  const character = charactersSvc.createCharacter(USER_ID, {
    name,
    extensions: setCharacterWorldBookIds({}, [book.id]),
  });

  return { character, book, entry };
}

describe("group chat world-info source selection", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
  });

  afterEach(() => {
    closeDatabase();
  });

  test("default follow-card mode includes unmuted inactive member lorebooks when cards merge unmuted", () => {
    const narrator = charactersSvc.createCharacter(USER_ID, { name: "Narrator" });
    const loreMember = createCharacterWithBook("Lorekeeper", "Inactive member lore");
    const mutedMember = createCharacterWithBook("Muted", "Muted member lore");
    const chat = chatsSvc.createGroupChat(USER_ID, {
      character_ids: [narrator.id, loreMember.character.id, mutedMember.character.id],
      name: "Group",
    });
    const updated = chatsSvc.updateChat(USER_ID, chat.id, {
      metadata: {
        ...chat.metadata,
        group_card_mode: "merge_ignore_muted",
        muted_character_ids: [mutedMember.character.id],
      },
    })!;

    const sources = collectWorldInfoSources(USER_ID, narrator, null, [], [], { chat: updated });

    expect(sources.worldBookIds).toEqual([loreMember.book.id]);
    expect(sources.entries.map((entry) => entry.content)).toEqual(["Inactive member lore"]);
    expect(sources.bookNameMap.get(loreMember.book.id)).toBe("Lorekeeper Book");
  });

  test("active-character lorebook mode overrides merged cards", () => {
    const narrator = charactersSvc.createCharacter(USER_ID, { name: "Narrator" });
    const loreMember = createCharacterWithBook("Lorekeeper", "Inactive member lore");
    const chat = chatsSvc.createGroupChat(USER_ID, {
      character_ids: [narrator.id, loreMember.character.id],
      name: "Group",
    });
    const updated = chatsSvc.updateChat(USER_ID, chat.id, {
      metadata: {
        ...chat.metadata,
        group_card_mode: "merge",
        group_lorebook_mode: "active_character",
      },
    })!;

    const sources = collectWorldInfoSources(USER_ID, narrator, null, [], [], { chat: updated });

    expect(sources.worldBookIds).toEqual([]);
    expect(sources.entries).toEqual([]);
  });

  test("all-members lorebook mode overrides swapped cards", () => {
    const narrator = charactersSvc.createCharacter(USER_ID, { name: "Narrator" });
    const loreMember = createCharacterWithBook("Lorekeeper", "Inactive member lore");
    const chat = chatsSvc.createGroupChat(USER_ID, {
      character_ids: [narrator.id, loreMember.character.id],
      name: "Group",
    });
    const updated = chatsSvc.updateChat(USER_ID, chat.id, {
      metadata: {
        ...chat.metadata,
        group_lorebook_mode: "all",
      },
    })!;

    const sources = collectWorldInfoSources(USER_ID, narrator, null, [], [], { chat: updated });

    expect(sources.worldBookIds).toEqual([loreMember.book.id]);
  });

  test("prefetch uses the same group member lorebook scope as prompt assembly", async () => {
    const narrator = charactersSvc.createCharacter(USER_ID, { name: "Narrator" });
    const loreMember = createCharacterWithBook("Lorekeeper", "Inactive member lore");
    const chat = chatsSvc.createGroupChat(USER_ID, {
      character_ids: [narrator.id, loreMember.character.id],
      name: "Group",
    });
    const updated = chatsSvc.updateChat(USER_ID, chat.id, {
      metadata: {
        ...chat.metadata,
        group_card_mode: "merge",
      },
    })!;

    const prefetched = await prefetchAssemblyData({
      userId: USER_ID,
      chatId: updated.id,
      generationType: "normal",
    });

    expect(prefetched.worldInfoSources.worldBookIds).toEqual([loreMember.book.id]);
    expect(prefetched.worldInfoSources.entries.map((entry) => entry.content)).toEqual(["Inactive member lore"]);
  });
});
