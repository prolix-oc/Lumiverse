import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";

import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import * as charactersSvc from "../src/services/characters.service";
import * as chatsSvc from "../src/services/chats.service";
import * as presetsSvc from "../src/services/presets.service";
import { prefetchAssemblyData } from "../src/services/prompt-assembly-prefetch";
import { assemblePrompt } from "../src/services/prompt-assembly.service";

const USER_ID = "prompt-tag-trigger-user";

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "src", "db", "baseline.sql")).text());
  db.run(
    await Bun.file(
      join(import.meta.dir, "..", "src", "db", "migrations", "078_chats_character_id_nullable.sql"),
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

describe("prompt block character tag triggers", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
  });

  test("activates on loose character tag matches and skips unmatched blocks", async () => {
    const character = charactersSvc.createCharacter(USER_ID, {
      name: "Nyra",
      tags: ["semi-anthro", "demi-human", "heroic_fox"],
    });
    const chat = chatsSvc.createChat(USER_ID, { character_id: character.id });
    chatsSvc.createMessage(chat.id, { is_user: true, name: "User", content: "Hello there" }, USER_ID);

    const preset = presetsSvc.createPreset(USER_ID, {
      name: "Tag Trigger Preset",
      provider: "openai",
      engine: "chat",
      parameters: {},
      prompts: {},
      metadata: {},
      prompt_order: [
        makeBlock({
          name: "Loose match",
          content: "ANTHRO_MATCH_BLOCK",
          characterTagTrigger: ["anthro", "demihuman", "furry"],
        }),
        makeBlock({
          name: "No match",
          content: "MECHA_ONLY_BLOCK",
          characterTagTrigger: ["mecha"],
        }),
        makeBlock({ name: "Chat History", marker: "chat_history" }),
      ],
    } as any);

    const ctx = {
      userId: USER_ID,
      chatId: chat.id,
      generationType: "normal" as const,
      presetId: preset.id,
    };

    const direct = await assemblePrompt(ctx as any);
    const prefetched = await assemblePrompt({
      ...ctx,
      prefetched: await prefetchAssemblyData(ctx as any),
    } as any);

    for (const result of [direct, prefetched]) {
      const serialized = JSON.stringify(result.messages);
      expect(serialized).toContain("ANTHRO_MATCH_BLOCK");
      expect(serialized).not.toContain("MECHA_ONLY_BLOCK");
      expect(serialized).toContain("Hello there");
    }
  });
});
