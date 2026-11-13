import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { registerImageProvider, getImageProvider } from "../image-gen/registry";
import type { ImageProvider } from "../image-gen/provider";
import type { ImageGenRequest, ImageGenResponse } from "../image-gen/types";
import * as charactersSvc from "./characters.service";
import * as connectionsSvc from "./connections.service";
import * as imageGenConnSvc from "./image-gen-connections.service";
import * as settingsSvc from "./settings.service";
import * as avatarCaptionSvc from "./image-gen-avatar-caption.service";
import { buildContextMessages, generateSceneBackground, getImageGenSettings, previewImagePrompt } from "./image-gen.service";

const USER_ID = "avatar-caption-smoke-user";

interface CapturedCall {
  request: ImageGenRequest;
}

let captured: CapturedCall[] = [];
let originalSwarmUI: ImageProvider | undefined;
let parserConnectionId: string;

const fakeSwarmUI: ImageProvider = {
  name: "swarmui",
  displayName: "Fake SwarmUI (avatar caption smoke)",
  capabilities: {
    parameters: {},
    apiKeyRequired: false,
    modelListStyle: "dynamic",
    defaultUrl: "http://localhost:9999",
  },
  async generate(_apiKey: string, _apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    captured.push({ request });
    return {
      imageDataUrl: "",
      model: request.model || "fake-model",
      provider: "swarmui",
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
}

function seedCaptionedCharacter(imageId: string, caption: string) {
  const char = charactersSvc.createCharacter(USER_ID, {
    name: "Silver",
    description: "thin card text",
  });
  getDb()
    .query("UPDATE characters SET image_id = ? WHERE id = ? AND user_id = ?")
    .run(imageId, char.id, USER_ID);

  const fingerprint = avatarCaptionSvc.buildCaptionFingerprint({
    presetId: null,
    prompt: "Describe the avatar.",
    parserConnectionId,
    parserProvider: "custom",
    parserApiUrl: "http://127.0.0.1:1",
    parserModel: "vision-model",
    parserParameters: {},
  });
  avatarCaptionSvc.setCachedCaption(USER_ID, "character", char.id, {
    image_id: imageId,
    caption,
    fingerprint,
  });
  return char;
}

async function seedConnectionAndSettings(extra: Record<string, unknown> = {}) {
  const connection = await imageGenConnSvc.createConnection(USER_ID, {
    name: "Fake SwarmUI",
    provider: "swarmui",
    model: "fake-model",
    api_url: "http://localhost:9999",
    is_default: true,
    default_parameters: {},
  });
  settingsSvc.putSetting(USER_ID, "imageGeneration", {
    enabled: true,
    activeImageGenConnectionId: connection.id,
    includeCharacters: false,
    describeCharacterAvatar: true,
    describePersonaAvatar: false,
    activeCaptioningPresetId: null,
    captionPrompt: "Describe the avatar.",
    promptParserConnectionId: parserConnectionId,
    promptMode: "custom",
    customPrompt: "",
    promptPresets: [],
    outputTarget: "preview",
    sceneChangeThreshold: 2,
    autoGenerate: true,
    forceGeneration: true,
    recycleGeneratedImages: false,
    recycledImageLimit: 1,
    addToGallery: false,
    backgroundOpacity: 0.35,
    fadeTransitionMs: 800,
    promptGenerationTimeoutSeconds: 60,
    generationTimeoutSeconds: 300,
    ...extra,
  });
  return connection;
}

function insertChat(characterId: string): string {
  const chatId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .query(
      "INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(chatId, USER_ID, characterId, "smoke", "{}", now, now);
  return chatId;
}

beforeAll(() => {
  originalSwarmUI = getImageProvider("swarmui");
  registerImageProvider(fakeSwarmUI);
});

afterAll(() => {
  if (originalSwarmUI) registerImageProvider(originalSwarmUI);
  closeDatabase();
});

describe("avatar caption prompt injection", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
    parserConnectionId = (await connectionsSvc.createConnection(USER_ID, {
      name: "Vision parser", provider: "custom", model: "vision-model", api_url: "http://127.0.0.1:1",
    })).id;
    captured = [];
  });

  test("does not prepend avatar captions onto a custom-mode image prompt", async () => {
    const char = seedCaptionedCharacter("img-silver", "1girl, silver_hair, green_eyes, school_uniform");
    await seedConnectionAndSettings();
    const chatId = insertChat(char.id);

    const result = await generateSceneBackground(USER_ID, chatId, {
      promptMode: "custom",
      prompt: "standing in a garden",
      skipParse: true,
      outputTarget: "preview",
      forceGeneration: true,
    });

    expect(result.provider).toBe("swarmui");
    expect(captured.length).toBe(1);
    expect(captured[0].request.prompt).toBe("standing in a garden");
    expect(captured[0].request.prompt).not.toContain("silver_hair");
  });

  test("previewImagePrompt also leaves custom prompts unstacked", async () => {
    const char = seedCaptionedCharacter("img-preview", "1girl, red_hair");
    await seedConnectionAndSettings({ autoGenerate: false, forceGeneration: false });
    const chatId = insertChat(char.id);

    const preview = await previewImagePrompt(USER_ID, chatId, {
      promptMode: "custom",
      prompt: "at a cafe",
    });

    expect(preview.prompt).toBe("at a cafe");
    expect(preview.prompt).not.toContain("red_hair");
  });

  test("buildContextMessages includes avatar appearance as parser reference", async () => {
    const char = seedCaptionedCharacter("img-ctx", "1girl, silver_hair, green_eyes");
    await seedConnectionAndSettings();
    const chatId = insertChat(char.id);

    const msgs = await buildContextMessages(USER_ID, chatId, getImageGenSettings(USER_ID));

    const appearance = msgs.find(
      (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("Visual appearance reference"),
    );
    expect(appearance).toBeTruthy();
    expect(String(appearance!.content)).toContain("Character avatar appearance");
    expect(String(appearance!.content)).toContain("1girl, silver_hair, green_eyes");
    expect(String(appearance!.content)).toContain("scene-aware clothing wins");
    expect(String(appearance!.content)).toContain("stable identity lock");
  });

  test("buildContextMessages omits appearance when describe toggles are off", async () => {
    const char = seedCaptionedCharacter("img-off", "SHOULD_NOT_APPEAR");
    await seedConnectionAndSettings({ describeCharacterAvatar: false });
    const chatId = insertChat(char.id);

    const msgs = await buildContextMessages(USER_ID, chatId, getImageGenSettings(USER_ID));

    expect(msgs.some((m) => typeof m.content === "string" && m.content.includes("SHOULD_NOT_APPEAR"))).toBe(false);
  });
});
