/**
 * End-to-end smoke test: drive generateSceneBackground with a fake "swarmui"
 * provider that captures the outgoing request, and verify the character's
 * LoRA binding lands in the request parameters and the prepended base tags
 * land in the prompt.
 *
 * The provider registry is module-singleton, so we save/restore the original
 * swarmui provider around the test to avoid polluting unrelated tests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { registerImageProvider, getImageProvider } from "../image-gen/registry";
import type { ImageProvider } from "../image-gen/provider";
import type { ImageGenRequest, ImageGenResponse } from "../image-gen/types";
import * as charactersSvc from "./characters.service";
import * as characterLoraSvc from "./character-lora.service";
import * as imageGenConnSvc from "./image-gen-connections.service";
import * as settingsSvc from "./settings.service";
import { generateSceneBackground } from "./image-gen.service";

const USER_ID = "smoke-user";

interface CapturedCall {
  apiKey: string;
  apiUrl: string;
  request: ImageGenRequest;
}

let captured: CapturedCall[] = [];
let originalSwarmUI: ImageProvider | undefined;

const fakeSwarmUI: ImageProvider = {
  name: "swarmui",
  displayName: "Fake SwarmUI (smoke test)",
  capabilities: {
    parameters: {},
    apiKeyRequired: false,
    modelListStyle: "dynamic",
    defaultUrl: "http://localhost:9999",
  },
  async generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    captured.push({ apiKey, apiUrl, request });
    // Empty imageDataUrl makes the upstream skip image persistence/gallery —
    // we only care about the outbound parameters, not the response handling.
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
  // Baseline references the `user` table for FK constraints. We don't drive
  // auth here, so just disable FK enforcement for the in-memory test DB.
  db.run("PRAGMA foreign_keys = OFF");
  db.run(sql);
}

beforeAll(() => {
  originalSwarmUI = getImageProvider("swarmui");
  registerImageProvider(fakeSwarmUI);
});

afterAll(() => {
  if (originalSwarmUI) registerImageProvider(originalSwarmUI);
});

describe("character LoRA pipeline splice (SwarmUI)", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
    captured = [];
  });

  test("binds lora_name/weight/base_tags into the outgoing request", async () => {
    // 1. Create a character.
    const char = charactersSvc.createCharacter(USER_ID, {
      name: "Aerith",
      description: "test description",
    });

    // 2. Bind a LoRA to them with explicit weights + base tags.
    characterLoraSvc.setCharacterLora(USER_ID, char.id, {
      lora_name: "aerith_v3.safetensors",
      weight_model: 0.85,
      weight_clip: 0.6,
      base_tags: "1girl, long_brown_hair, pink_dress",
      source_url: "https://example.com/aerith",
    });

    // 3. Create a SwarmUI image-gen connection and set it as the active one.
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
      promptMode: "custom",
      customPrompt: "",
      customNegativePrompt: "",
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
    });

    // 4. Create a chat for that character. Inserted directly because the
    //    full createChat flow expects extra ambient state (personas, presets,
    //    settings rows) we don't need for this test.
    const chatId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    getDb()
      .query(
        "INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(chatId, USER_ID, char.id, "smoke", "{}", now, now);

    // 5. Trigger generation with a literal prompt; skipParse + custom mode
    //    bypass the LLM parser path entirely.
    const result = await generateSceneBackground(USER_ID, chatId, {
      promptMode: "custom",
      prompt: "a portrait at sunset",
      skipParse: true,
      outputTarget: "preview",
      forceGeneration: true,
    });

    expect(result.provider).toBe("swarmui");
    expect(captured.length).toBe(1);

    const sentRequest = captured[0].request;
    // base_tags must lead the assembled positive prompt.
    expect(sentRequest.prompt.startsWith("1girl, long_brown_hair, pink_dress")).toBe(true);
    expect(sentRequest.prompt).toContain("a portrait at sunset");

    // LoRA params must be set on the request's `parameters` bag.
    expect(sentRequest.parameters?.loras).toBe("aerith_v3.safetensors");
    // SwarmUI uses model strength only; we serialize as a string.
    expect(sentRequest.parameters?.loraWeights).toBe("0.85");
  });

  test("no binding → request goes out untouched", async () => {
    const char = charactersSvc.createCharacter(USER_ID, { name: "NoLora" });
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
      promptMode: "custom",
      promptPresets: [],
      outputTarget: "preview",
      forceGeneration: true,
      addToGallery: false,
    });

    const chatId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    getDb()
      .query(
        "INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(chatId, USER_ID, char.id, "smoke", "{}", now, now);

    await generateSceneBackground(USER_ID, chatId, {
      promptMode: "custom",
      prompt: "a portrait",
      skipParse: true,
      outputTarget: "preview",
      forceGeneration: true,
    });

    expect(captured.length).toBe(1);
    const sentRequest = captured[0].request;
    expect(sentRequest.prompt).toBe("a portrait");
    expect(sentRequest.parameters?.loras).toBeUndefined();
    expect(sentRequest.parameters?.loraWeights).toBeUndefined();
  });
});
