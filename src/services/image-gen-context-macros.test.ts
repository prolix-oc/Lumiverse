import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { initMacros } from "../macros";
import * as charactersSvc from "./characters.service";
import * as chatsSvc from "./chats.service";
import * as personasSvc from "./personas.service";
import * as settingsSvc from "./settings.service";
import { buildContextMessages, getImageGenSettings } from "./image-gen.service";

const USER_ID = "image-gen-context-macros-user";

async function applyBaseline(): Promise<void> {
  const baselinePath = join(import.meta.dir, "..", "db", "baseline.sql");
  const sql = await Bun.file(baselinePath).text();
  const db = getDb();
  // Baseline references the `user` table for FK constraints. We don't drive
  // auth here, so just disable FK enforcement for the in-memory test DB.
  db.run("PRAGMA foreign_keys = OFF");
  db.run(sql);
}

function insertChat(userId: string, characterId: string): string {
  const chatId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .query(
      "INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(chatId, userId, characterId, "macro context", "{}", now, now);
  return chatId;
}

// Seed a default persona so {{user}} resolves to a deterministic name rather
// than the "User" fallback, making the resolved-output assertions meaningful.
function seedDefaultPersona(
  userId: string,
  opts: { name?: string; title?: string; description?: string } = {},
): void {
  personasSvc.createPersona(userId, {
    name: opts.name ?? "Traveler",
    title: opts.title,
    description: opts.description,
    is_default: true,
  });
}

beforeAll(() => {
  initMacros();
});

afterAll(() => {
  closeDatabase();
});

describe("image-gen parser context macro resolution", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
  });

  test("resolves character card macros before building parser context", async () => {
    seedDefaultPersona(USER_ID);
    const char = charactersSvc.createCharacter(USER_ID, {
      name: "Elara",
      description: "A guardian who watches over {{user}}.",
      scenario: "{{char}} arrives at the gates at dawn.",
    });
    const chatId = insertChat(USER_ID, char.id);
    settingsSvc.putSetting(USER_ID, "imageGeneration", {
      includeCharacters: false,
      promptContextMessageLimit: 3,
    });

    const messages = await buildContextMessages(USER_ID, chatId, getImageGenSettings(USER_ID));
    const charInfo = messages.find(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith("## Character Information"),
    );

    // Exact resolved strings prove {{user}}→persona name and {{char}}→character
    // name specifically (not merely that some brace token disappeared).
    const content = charInfo?.content as string;
    expect(content).toContain("Description: A guardian who watches over Traveler.");
    expect(content).toContain("Scenario: Elara arrives at the gates at dawn.");
    expect(content).not.toContain("{{");
  });

  test("resolves raw greeting macros before building parser context", async () => {
    seedDefaultPersona(USER_ID);
    const char = charactersSvc.createCharacter(USER_ID, { name: "Elara" });
    const chatId = insertChat(USER_ID, char.id);
    // Greetings are stored verbatim from character.first_mes (chats.service.ts),
    // so macros only resolve at read time — mirroring this raw insert.
    chatsSvc.createMessage(
      chatId,
      {
        is_user: false,
        name: "Elara",
        content: "Welcome, {{user}}. I am {{char}}.",
        extra: { greeting: true },
      },
      USER_ID,
    );
    settingsSvc.putSetting(USER_ID, "imageGeneration", {
      includeCharacters: false,
      promptContextMessageLimit: 3,
    });

    const messages = await buildContextMessages(USER_ID, chatId, getImageGenSettings(USER_ID));
    const assistant = messages.find((message) => message.role === "assistant");

    expect(assistant?.content).toBe("Welcome, Traveler. I am Elara.");
  });

  test("resolves persona block macros when Include Characters is on", async () => {
    seedDefaultPersona(USER_ID, {
      name: "Traveler",
      title: "Traveler the Brave",
      description: "Wandering as {{user}} does.",
    });
    const char = charactersSvc.createCharacter(USER_ID, { name: "Elara" });
    const chatId = insertChat(USER_ID, char.id);
    settingsSvc.putSetting(USER_ID, "imageGeneration", {
      includeCharacters: true,
      promptContextMessageLimit: 3,
    });

    const messages = await buildContextMessages(USER_ID, chatId, getImageGenSettings(USER_ID));
    const persona = messages.find(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith("## User Persona"),
    );

    const content = persona?.content as string;
    expect(content).toContain("Description: Wandering as Traveler does.");
    expect(content).not.toContain("{{");
  });

  test("passes macro-free messages through verbatim", async () => {
    seedDefaultPersona(USER_ID);
    const char = charactersSvc.createCharacter(USER_ID, { name: "Elara" });
    const chatId = insertChat(USER_ID, char.id);
    chatsSvc.createMessage(
      chatId,
      {
        is_user: false,
        name: "Elara",
        content: "The wind blows.",
        extra: {},
      },
      USER_ID,
    );
    settingsSvc.putSetting(USER_ID, "imageGeneration", {
      includeCharacters: false,
      promptContextMessageLimit: 3,
    });

    const messages = await buildContextMessages(USER_ID, chatId, getImageGenSettings(USER_ID));
    const assistant = messages.find((message) => message.role === "assistant");

    expect(assistant?.content).toBe("The wind blows.");
  });
});
