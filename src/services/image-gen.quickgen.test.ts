import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { getImageProvider, registerImageProvider } from "../image-gen/registry";
import type { ImageGenRequest } from "../image-gen/types";
import * as connections from "./image-gen-connections.service";
import * as characters from "./characters.service";
import * as settings from "./settings.service";
import * as llmConnections from "./connections.service";
import { getProvider, registerProvider } from "../llm/registry";
import type { GenerationRequest } from "../llm/types";
import { cancelExtensionImageGeneration, generateSceneBackground, getMainImagePromptPresets } from "./image-gen.service";
import { WorkerHostImageGenApi } from "../spindle/worker-host-image-gen-api";

const userId = "quick-gen-test";
let chatId: string;
let selectedConnection: string;
let captured: ImageGenRequest | undefined;
let pause = false;
const original = getImageProvider("comfyui");
const originalParser = getProvider("custom")!;
beforeEach(async () => {
  closeDatabase(); initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
  captured = undefined; pause = false;
  registerImageProvider({
    name: "comfyui", displayName: "Test ComfyUI", capabilities: { parameters: {}, apiKeyRequired: false, modelListStyle: "static", defaultUrl: "http://127.0.0.1:1" },
    async generate(_key, _url, request) {
      captured = request;
      if (pause) await new Promise<void>((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
      });
      return { imageDataUrl: "", provider: "comfyui", model: "test" };
    }, async validateKey() { return true; }, async listModels() { return []; },
  });
  const first = await connections.createConnection(userId, { provider: "comfyui", name: "Active", model: "", api_url: "http://127.0.0.1:1", is_default: true });
  const config = {
    workflow_api_json: { "1": { class_type: "CLIPTextEncode", inputs: { text: "original" } }, "2": { class_type: "Video", inputs: { length: 81 } } },
    workflow_json: {}, workflow_format: "api_prompt", field_mappings: [{ nodeId: "1", fieldName: "text", mappedAs: "positive_prompt" }, { nodeId: "2", fieldName: "length", mappedAs: "custom" }], imported_at: 1,
  };
  const second = await connections.createConnection(userId, { provider: "comfyui", name: "Chosen", model: "", api_url: "http://127.0.0.1:1", metadata: { comfyui_workflows: [{ id: "chosen", name: "Video", config }] } });
  selectedConnection = second.id;
  const character = characters.createCharacter(userId, { name: "QuickGen character" });
  chatId = crypto.randomUUID();
  getDb().query("INSERT INTO chats (id,user_id,character_id,name,metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(chatId, userId, character.id, "QuickGen", "{}", 1, 1);
  settings.putSetting(userId, "imageGeneration", {
    activeImageGenConnectionId: first.id, activePromptPresetId: "active", promptMode: "scene", addToGallery: false,
    promptPresets: [
      { id: "active", name: "Active", kind: "main", mode: "custom", prompt: "active prompt" },
      { id: "selected", name: "Selected", kind: "main", mode: "custom", prompt: "selected prompt" },
      { id: "caption", name: "Caption", kind: "captioning", mode: "custom", prompt: "caption" },
    ],
  });
});
afterEach(() => { if (original) registerImageProvider(original); registerProvider(originalParser); closeDatabase(); });
const options = () => ({ connectionId: selectedConnection, promptPresetId: "selected", parameters: { workflow_id: "chosen", comfyui_field_values: { custom: { "2:length": 121 } } }, forceGeneration: true, outputTarget: "preview" as const, addToGallery: false, ownerExtensionIdentifier: "quick_gen", clientJobId: "test-job" });

test("per-run connection, preset and custom fields preserve all saved ImgGen settings", async () => {
  const before = settings.getSetting(userId, "imageGeneration");
  const metadata = connections.getConnection(userId, selectedConnection)?.metadata;
  await generateSceneBackground(userId, chatId, { ...options(), outputMediaType: "video", outputNodeId: "9" });
  expect(captured?.prompt).toBe("selected prompt");
  expect(captured?.parameters.workflow["2"].inputs.length).toBe(121);
  expect(captured?.parameters.comfy_output_kind).toBe("video");
  expect(captured?.parameters.comfy_output_node).toBe("9");
  expect(settings.getSetting(userId, "imageGeneration")).toEqual(before);
  expect(connections.getConnection(userId, selectedConnection)?.metadata).toEqual(metadata);
});
test("missing selections and another user's chat are rejected", async () => {
  await expect(generateSceneBackground(userId, chatId, { ...options(), promptPresetId: "deleted" })).rejects.toThrow("preset not found");
  await expect(generateSceneBackground(userId, chatId, { ...options(), parameters: { workflow_id: "deleted" } })).rejects.toThrow("workflow not found");
  await expect(generateSceneBackground("other", chatId, options())).rejects.toThrow("connection not found");
});
test("preset discovery returns only Main Presets and requires permission", () => {
  expect(getMainImagePromptPresets(userId).presets.map((preset) => preset.id)).toEqual(["active", "selected"]);
  const messages: any[] = [];
  const api = new WorkerHostImageGenApi({ extensionIdentifier: "quick_gen", hasPermission: () => false, resolveEffectiveUserId: () => userId, enforceScopedUser: () => {}, post: (message) => messages.push(message) });
  api.handlePromptPresets("request", userId);
  expect(messages[0].error).toContain("image_gen");
});
test("discovery and explicit connection runs never repair ImgGen's active connection", async () => {
  const current = settings.getSetting(userId, "imageGeneration")!.value;
  settings.putSetting(userId, "imageGeneration", { ...current, activeImageGenConnectionId: "deleted" });
  const before = settings.getSetting(userId, "imageGeneration");
  expect(getMainImagePromptPresets(userId).activeConnectionId).toBe("deleted");
  await generateSceneBackground(userId, chatId, options());
  expect(settings.getSetting(userId, "imageGeneration")).toEqual(before);
});
test("cancellation is scoped to the job's account and extension", async () => {
  pause = true;
  const pending = generateSceneBackground(userId, chatId, options());
  while (!captured) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(cancelExtensionImageGeneration("other", "quick_gen", "test-job")).toBe(false);
  expect(cancelExtensionImageGeneration(userId, "other-extension", "test-job")).toBe(false);
  expect(cancelExtensionImageGeneration(userId, "quick_gen", "test-job")).toBe(true);
  await expect(pending).rejects.toThrow("cancelled");
});

test("explicit parsed Main Presets use their parser configuration, including sidecar defaults", async () => {
  let parserRequest: GenerationRequest | undefined;
  registerProvider({
    name: "custom", displayName: "Test parser", defaultUrl: originalParser.defaultUrl, capabilities: originalParser.capabilities,
    async generate(_key, _url, request) { parserRequest = request; return { content: '{"prompt":"parsed motion","negative_prompt":"blur"}', finish_reason: "stop" }; },
    generateStream: originalParser.generateStream.bind(originalParser), validateKey: originalParser.validateKey.bind(originalParser), listModels: originalParser.listModels.bind(originalParser),
  });
  const parserConnection = await llmConnections.createConnection(userId, { name: "Selected parser", provider: "custom", api_url: "http://127.0.0.1:1", model: "connection-model" });
  const current = settings.getSetting(userId, "imageGeneration")!.value;
  settings.putSetting(userId, "imageGeneration", { ...current, promptParserConnectionId: "deleted-global-parser", promptParserModel: "global-model", promptParserParameters: { temperature: 1.5 },
    promptPresets: [...current.promptPresets, { id: "parsed", name: "Parsed", kind: "main", mode: "parsed_custom", prompt: "camera pan", parserConnectionId: parserConnection.id, parserModel: "preset-model", parserParameters: { temperature: 0.2 } }],
  });
  const before = settings.getSetting(userId, "imageGeneration");
  await generateSceneBackground(userId, chatId, { ...options(), promptPresetId: "parsed" });
  expect(parserRequest?.model).toBe("preset-model");
  expect(parserRequest?.parameters?.temperature).toBe(0.2);
  expect(captured?.prompt).toBe("parsed motion");
  expect(captured?.negativePrompt).toBe("blur");
  expect(settings.getSetting(userId, "imageGeneration")).toEqual(before);

  settings.putSetting(userId, "sidecarSettings", { connectionProfileId: parserConnection.id, model: "sidecar-model", temperature: 0.7 });
  const configured = settings.getSetting(userId, "imageGeneration")!.value;
  settings.putSetting(userId, "imageGeneration", { ...configured, promptPresets: configured.promptPresets.map((preset: any) => preset.id === "parsed" ? { ...preset, parserConnectionId: null, parserModel: "", parserParameters: {} } : preset) });
  await generateSceneBackground(userId, chatId, { ...options(), promptPresetId: "parsed" });
  expect(parserRequest?.model).toBe("sidecar-model");
  expect(parserRequest?.parameters?.temperature).toBe(0.7);
});
