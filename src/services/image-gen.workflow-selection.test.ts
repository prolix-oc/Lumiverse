import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { getImageProvider, registerImageProvider } from "../image-gen/registry";
import type { ImageProvider } from "../image-gen/provider";
import type { ImageGenRequest, ImageGenResponse } from "../image-gen/types";
import * as charactersSvc from "./characters.service";
import * as imageGenConnSvc from "./image-gen-connections.service";
import { generateSceneBackground } from "./image-gen.service";
import * as settingsSvc from "./settings.service";

const USER_ID = "workflow-selection-user";
let capturedRequest: ImageGenRequest | null = null;
let originalComfyUI: ImageProvider | undefined;

const fakeComfyUI: ImageProvider = {
  name: "comfyui",
  displayName: "Fake ComfyUI workflow selection test",
  capabilities: {
    parameters: {},
    apiKeyRequired: false,
    modelListStyle: "dynamic",
    defaultUrl: "http://localhost:8188",
  },
  async generate(_apiKey: string, _apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse> {
    capturedRequest = request;
    return { imageDataUrl: "", model: request.model || "fake-model", provider: "comfyui" };
  },
  async validateKey(): Promise<boolean> {
    return true;
  },
  async listModels(): Promise<Array<{ id: string; label: string }>> {
    return [];
  },
};

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
}

beforeAll(() => {
  originalComfyUI = getImageProvider("comfyui");
  registerImageProvider(fakeComfyUI);
});

afterAll(() => {
  if (originalComfyUI) registerImageProvider(originalComfyUI);
});

describe("active ComfyUI workflow selection", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
    capturedRequest = null;
  });

  test("replaces a stale default-parameter workflow with the active workflow", async () => {
    const activeWorkflow = {
      "active-node": { class_type: "CLIPTextEncode", inputs: { text: "saved workflow prompt" } },
    };
    const connection = await imageGenConnSvc.createConnection(USER_ID, {
      name: "ComfyUI",
      provider: "comfyui",
      model: "",
      // The discovery request is allowed to fail; API-format workflows do
      // not need node metadata to be patched in this test.
      api_url: "http://127.0.0.1:1",
      is_default: true,
      default_parameters: {
        workflow: {
          "stale-node": { class_type: "CLIPTextEncode", inputs: { text: "old workflow prompt" } },
        },
      },
      metadata: {
        comfyui: {
          workflow_json: activeWorkflow,
          workflow_api_json: activeWorkflow,
          workflow_format: "api_prompt",
          field_mappings: [{ nodeId: "active-node", fieldName: "text", mappedAs: "positive_prompt" }],
          imported_at: Date.now(),
        },
      },
    });
    settingsSvc.putSetting(USER_ID, "imageGeneration", {
      enabled: true,
      activeImageGenConnectionId: connection.id,
      promptMode: "custom",
      outputTarget: "preview",
      forceGeneration: true,
      addToGallery: false,
    });

    const character = charactersSvc.createCharacter(USER_ID, { name: "Workflow test character" });
    const chatId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    getDb()
      .query("INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(chatId, USER_ID, character.id, "workflow selection", "{}", now, now);

    await generateSceneBackground(USER_ID, chatId, {
      promptMode: "custom",
      prompt: "new workflow prompt",
      skipParse: true,
      outputTarget: "preview",
      forceGeneration: true,
    });

    expect(capturedRequest?.parameters?.workflow).toEqual({
      "active-node": { class_type: "CLIPTextEncode", inputs: { text: "new workflow prompt" } },
    });
  });

  test("selects the active workflow from comfyui_workflows library over initial comfyui config", async () => {
    const defaultWf = { "node-default": { class_type: "CLIPTextEncode", inputs: { text: "default wf" } } };
    const activeWf = { "node-active": { class_type: "CLIPTextEncode", inputs: { text: "active wf" } } };
    const connection = await imageGenConnSvc.createConnection(USER_ID, {
      name: "ComfyUI Multi-Workflow",
      provider: "comfyui",
      model: "",
      api_url: "http://127.0.0.1:1",
      is_default: true,
      metadata: {
        comfyui: {
          workflow_json: defaultWf,
          workflow_api_json: defaultWf,
          workflow_format: "api_prompt",
          field_mappings: [{ nodeId: "node-default", fieldName: "text", mappedAs: "positive_prompt" }],
          imported_at: 1000,
        },
        comfyui_active_workflow_id: "wf-active-id",
        comfyui_workflows: [
          {
            id: "wf-default-id",
            name: "Initial Workflow",
            updated_at: 1000,
            config: {
              workflow_json: defaultWf,
              workflow_api_json: defaultWf,
              workflow_format: "api_prompt",
              field_mappings: [{ nodeId: "node-default", fieldName: "text", mappedAs: "positive_prompt" }],
              imported_at: 1000,
            },
          },
          {
            id: "wf-active-id",
            name: "Active Workflow",
            updated_at: 2000,
            config: {
              workflow_json: activeWf,
              workflow_api_json: activeWf,
              workflow_format: "api_prompt",
              field_mappings: [{ nodeId: "node-active", fieldName: "text", mappedAs: "positive_prompt" }],
              imported_at: 2000,
            },
          },
        ],
      },
    });
    settingsSvc.putSetting(USER_ID, "imageGeneration", {
      enabled: true,
      activeImageGenConnectionId: connection.id,
      promptMode: "custom",
      outputTarget: "preview",
      forceGeneration: true,
      addToGallery: false,
    });

    const character = charactersSvc.createCharacter(USER_ID, { name: "Character" });
    const chatId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    getDb()
      .query("INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(chatId, USER_ID, character.id, "workflow test", "{}", now, now);

    await generateSceneBackground(USER_ID, chatId, {
      promptMode: "custom",
      prompt: "my prompt",
      skipParse: true,
      outputTarget: "preview",
      forceGeneration: true,
    });

    expect(capturedRequest?.parameters?.workflow).toEqual({
      "node-active": { class_type: "CLIPTextEncode", inputs: { text: "my prompt" } },
    });
  });

});
