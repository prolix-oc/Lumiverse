import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { registerImageProvider } from "../image-gen/registry";
import type { ImageProvider } from "../image-gen/provider";
import type { ImageGenRequest, ImageGenResponse } from "../image-gen/types";
import { eventBus } from "../ws/bus";
import * as charactersSvc from "./characters.service";
import * as chatsSvc from "./chats.service";
import * as imageGenConnSvc from "./image-gen-connections.service";
import { maybeAutoGenerateOnReply } from "./image-gen-auto.service";
import * as settingsSvc from "./settings.service";

const PROVIDER_NAME = "autogen_fallback_test";
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+Xn1mAAAAAElFTkSuQmCC";

interface CapturedCall {
  apiKey: string;
  apiUrl: string;
  request: ImageGenRequest;
}

let captured: CapturedCall[] = [];

const fakeProvider: ImageProvider = {
  name: PROVIDER_NAME,
  displayName: "Auto-gen fallback test provider",
  capabilities: {
    parameters: {},
    apiKeyRequired: false,
    modelListStyle: "dynamic",
    defaultUrl: "http://localhost:9999",
  },
  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    captured.push({ apiKey, apiUrl, request });
    return {
      imageDataUrl: TINY_PNG_DATA_URL,
      model: request.model || "fake-model",
      provider: PROVIDER_NAME,
    };
  },
  async validateKey(): Promise<boolean> {
    return true;
  },
  async listModels(): Promise<Array<{ id: string; label: string }>> {
    return [];
  },
};

async function applyBaseline(): Promise<void> {
  const baselinePath = join(import.meta.dir, "..", "db", "baseline.sql");
  const sql = await Bun.file(baselinePath).text();
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(sql);
  db.run("ALTER TABLE images ADD COLUMN owner_extension_identifier TEXT");
  db.run("ALTER TABLE images ADD COLUMN owner_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL");
  db.run("ALTER TABLE images ADD COLUMN owner_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL");
}

async function seedChatWithAssistantReply(userId: string) {
  const character = charactersSvc.createCharacter(userId, { name: "Aerith" });
  const connection = await imageGenConnSvc.createConnection(userId, {
    name: "Fallback test connection",
    provider: PROVIDER_NAME,
    model: "fake-model",
    api_url: "http://localhost:9999",
    is_default: true,
    default_parameters: {},
  });

  settingsSvc.putSetting(userId, "imageGeneration", {
    enabled: true,
    activeImageGenConnectionId: connection.id,
    promptMode: "custom",
    customPrompt: "soft watercolor portrait, sunset rim light",
    customNegativePrompt: "",
    outputTarget: "attach_to_message",
    autoGenerate: true,
    forceGeneration: true,
    addToGallery: false,
  });

  const chatId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .query(
      "INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(chatId, userId, character.id, "fallback", "{}", now, now);

  const message = chatsSvc.createMessage(
    chatId,
    {
      is_user: false,
      name: "Aerith",
      content: "The stars are finally out.",
    },
    userId,
  );

  return { chatId, messageId: message.id };
}

beforeAll(() => {
  registerImageProvider(fakeProvider);
});

describe("image-gen auto fallback", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
    captured = [];
  });

  test("runs auto-generate from the backend when no session is visible", async () => {
    const userId = "auto-hidden-user";
    const { chatId, messageId } = await seedChatWithAssistantReply(userId);

    const triggered = await maybeAutoGenerateOnReply(userId, { chatId, messageId });

    expect(triggered).toBe(true);
    expect(captured.length).toBe(1);

    const updated = chatsSvc.getMessage(userId, messageId);
    const attachments = Array.isArray(updated?.extra?.attachments)
      ? updated?.extra?.attachments
      : [];
    expect(attachments).toHaveLength(1);
    expect(updated?.extra?.image_gen?.provider).toBe(PROVIDER_NAME);
  });

  test("skips the backend fallback while a session is visible", async () => {
    const userId = "auto-visible-user";
    const sessionId = "visible-session";
    const { chatId, messageId } = await seedChatWithAssistantReply(userId);

    eventBus.setUserVisibility(userId, sessionId, true);
    try {
      const triggered = await maybeAutoGenerateOnReply(userId, { chatId, messageId });

      expect(triggered).toBe(false);
      expect(captured).toHaveLength(0);
    } finally {
      eventBus.removeSessionVisibility(userId, sessionId);
    }
  });
});

afterAll(() => {
  closeDatabase();
});
