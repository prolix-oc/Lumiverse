/**
 * Temporary character-less chat lifecycle: creation without a character or
 * greeting, exclusion from the landing-page recent lists, the
 * deleteTemporaryChats sweep, and the synthetic "Assistant" + persona-less
 * macro environment used during generation.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import * as charactersSvc from "../src/services/characters.service";
import * as chatsSvc from "../src/services/chats.service";
import * as personasSvc from "../src/services/personas.service";
import * as presetsSvc from "../src/services/presets.service";
import { assemblePrompt } from "../src/services/prompt-assembly.service";
import { prefetchAssemblyData } from "../src/services/prompt-assembly-prefetch";

const USER_ID = "temp-chat-user";
const PAGINATION = { limit: 50, offset: 0 };

async function applyBaseline(): Promise<void> {
  const db = getDb();
  // Baseline references the `user` table for FK constraints. We don't drive
  // auth here, so just disable FK enforcement for the in-memory test DB.
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "src", "db", "baseline.sql")).text());
  // Baseline is a 001-065 snapshot; apply the rebuild under test on top.
  db.run(
    await Bun.file(
      join(import.meta.dir, "..", "src", "db", "migrations", "078_chats_character_id_nullable.sql"),
    ).text(),
  );
}

function createTempChat() {
  return chatsSvc.createChat(USER_ID, {
    character_id: null,
    name: "Temporary Chat",
    metadata: { temporary: true },
  });
}

describe("temporary character-less chats", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
  });

  test("createChat accepts a null character_id and skips the greeting", () => {
    const chat = createTempChat();

    expect(chat.character_id).toBeNull();
    expect(chat.metadata.temporary).toBe(true);
    expect(chat.name).toBe("Temporary Chat");
    // No character → no greeting message
    expect(chatsSvc.getMessages(USER_ID, chat.id)).toHaveLength(0);
  });

  test("temporary chats are excluded from recent chat lists", () => {
    const character = charactersSvc.createCharacter(USER_ID, { name: "Aerith" });
    const normalChat = chatsSvc.createChat(USER_ID, { character_id: character.id });
    const tempChat = createTempChat();

    const recent = chatsSvc.listRecentChats(USER_ID, PAGINATION);
    expect(recent.total).toBe(1);
    expect(recent.data[0].id).toBe(normalChat.id);

    const grouped = chatsSvc.listRecentChatsGrouped(USER_ID, PAGINATION);
    expect(grouped.data.some((item) => item.latest_chat_id === tempChat.id)).toBe(false);
    expect(grouped.data.some((item) => item.character_id === character.id)).toBe(true);
  });

  test("deleteTemporaryChats sweeps only temporary chats", () => {
    const character = charactersSvc.createCharacter(USER_ID, { name: "Aerith" });
    const normalChat = chatsSvc.createChat(USER_ID, { character_id: character.id });
    const tempA = createTempChat();
    const tempB = createTempChat();
    // Character-less but not flagged temporary — must survive the sweep.
    const unflagged = chatsSvc.createChat(USER_ID, { character_id: null, name: "odd" });

    expect(chatsSvc.deleteTemporaryChats(USER_ID)).toBe(2);

    expect(chatsSvc.getChat(USER_ID, tempA.id)).toBeNull();
    expect(chatsSvc.getChat(USER_ID, tempB.id)).toBeNull();
    expect(chatsSvc.getChat(USER_ID, normalChat.id)).not.toBeNull();
    expect(chatsSvc.getChat(USER_ID, unflagged.id)).not.toBeNull();

    // Idempotent: nothing left to sweep.
    expect(chatsSvc.deleteTemporaryChats(USER_ID)).toBe(0);
  });

  test("deleteTemporaryChats only touches the requesting user's chats", () => {
    const mine = createTempChat();
    const theirs = chatsSvc.createChat("other-user", {
      character_id: null,
      name: "Temporary Chat",
      metadata: { temporary: true },
    });

    expect(chatsSvc.deleteTemporaryChats(USER_ID)).toBe(1);
    expect(chatsSvc.getChat(USER_ID, mine.id)).toBeNull();
    expect(chatsSvc.getChat("other-user", theirs.id)).not.toBeNull();
  });

  test("prompt assembly runs end-to-end without a character or persona", async () => {
    personasSvc.createPersona(USER_ID, { name: "Dax", is_default: true });
    const chat = createTempChat();
    chatsSvc.createMessage(chat.id, { is_user: true, name: "User", content: "Hello there" }, USER_ID);

    const ctx = {
      userId: USER_ID,
      chatId: chat.id,
      generationType: "normal" as const,
    };

    // Both the direct path and the prefetched path must survive a null
    // character_id (synthetic Assistant) and skip the default persona.
    const direct = await assemblePrompt(ctx as any);
    const prefetched = await assemblePrompt({ ...ctx, prefetched: await prefetchAssemblyData(ctx as any) } as any);

    for (const result of [direct, prefetched]) {
      const serialized = JSON.stringify(result.messages);
      expect(serialized).toContain("Hello there");
      // The default persona must not leak into the prompt.
      expect(serialized).not.toContain("Dax");
    }
  });

  test("preset blocks still apply to temporary chats", async () => {
    const chat = createTempChat();
    chatsSvc.createMessage(chat.id, { is_user: true, name: "User", content: "Hello there" }, USER_ID);

    const block = (overrides: Record<string, any>) => ({
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
    });
    const preset = presetsSvc.createPreset(USER_ID, {
      name: "Temp Test Preset",
      provider: "openai",
      engine: "chat",
      parameters: {},
      prompts: {},
      metadata: {},
      prompt_order: [
        block({ name: "Main", content: "PRESET_SYSTEM_MARKER: be concise." }),
        block({ name: "Chat History", marker: "chat_history" }),
      ],
    } as any);

    const result = await assemblePrompt({
      userId: USER_ID,
      chatId: chat.id,
      generationType: "normal",
      presetId: preset.id,
    } as any);

    const serialized = JSON.stringify(result.messages);
    expect(serialized).toContain("PRESET_SYSTEM_MARKER");
    expect(serialized).toContain("Hello there");
  });

  test("no_preset temp chats ignore presets even when one is requested", async () => {
    const chat = chatsSvc.createChat(USER_ID, {
      character_id: null,
      name: "Temporary Chat",
      metadata: { temporary: true, no_preset: true },
    });
    chatsSvc.createMessage(chat.id, { is_user: true, name: "User", content: "Hello there" }, USER_ID);

    const preset = presetsSvc.createPreset(USER_ID, {
      name: "Should Not Apply",
      provider: "openai",
      engine: "chat",
      parameters: { temperature: 0.123 },
      prompts: {},
      metadata: {},
      prompt_order: [
        {
          id: crypto.randomUUID(),
          name: "Main",
          content: "PRESET_SYSTEM_MARKER: be concise.",
          role: "system",
          enabled: true,
          position: "pre_history",
          depth: 0,
          marker: null,
          isLocked: false,
          color: null,
          injectionTrigger: [],
          group: null,
        },
      ],
    } as any);

    // Simulate the frontend still sending its active preset — both the direct
    // and prefetched assembly paths must drop it for a no_preset chat.
    const ctx = {
      userId: USER_ID,
      chatId: chat.id,
      generationType: "normal" as const,
      presetId: preset.id,
    };
    const direct = await assemblePrompt(ctx as any);
    const prefetched = await assemblePrompt({ ...ctx, prefetched: await prefetchAssemblyData(ctx as any) } as any);

    for (const result of [direct, prefetched]) {
      const serialized = JSON.stringify(result.messages);
      expect(serialized).not.toContain("PRESET_SYSTEM_MARKER");
      expect(serialized).toContain("Hello there");
      // Preset sampler parameters must not leak into the request either.
      expect(result.parameters.temperature).toBeUndefined();
    }
  });

  test("macro env uses the synthetic Assistant and skips the default persona", () => {
    personasSvc.createPersona(USER_ID, { name: "Dax", is_default: true });

    const tempChat = createTempChat();
    const tempEnv = chatsSvc.buildMacroEnvForChat(USER_ID, tempChat.id);
    expect(tempEnv).not.toBeNull();
    expect(tempEnv!.names.char).toBe("Assistant");
    expect(tempEnv!.names.user).toBe("User");

    // Sanity check the persona still applies to normal chats.
    const character = charactersSvc.createCharacter(USER_ID, { name: "Aerith" });
    const normalChat = chatsSvc.createChat(USER_ID, { character_id: character.id });
    const normalEnv = chatsSvc.buildMacroEnvForChat(USER_ID, normalChat.id);
    expect(normalEnv!.names.char).toBe("Aerith");
    expect(normalEnv!.names.user).toBe("Dax");
  });
});
