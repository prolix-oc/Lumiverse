import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { env } from "../env";
import { getProvider, registerProvider } from "../llm/registry";
import type { GenerationRequest } from "../llm/types";
import { getImageProvider, registerImageProvider } from "../image-gen/registry";
import * as characters from "./characters.service";
import * as connections from "./connections.service";
import * as imageConnections from "./image-gen-connections.service";
import * as settings from "./settings.service";
import * as captions from "./image-gen-avatar-caption.service";
import {
  buildContextMessages, cancelExtensionImageGeneration, captionImage,
  generateSceneBackground, getImageGenSettings,
} from "./image-gen.service";

const USER_ID = "avatar-caption-integration";
const IMAGE_ID = "avatar-image";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";
const originalParser = getProvider("custom")!;
const originalImageProvider = getImageProvider("swarmui");
const originalDataDir = env.dataDir;
let testDataDir: string;
let chatId: string;
let characterId: string;
let parserId: string;
let calls: GenerationRequest[];
let imageCalls: number;
let captionBehavior: ((request: GenerationRequest) => Promise<void>) | undefined;

beforeAll(async () => {
  testDataDir = mkdtempSync(join(tmpdir(), "lumiverse-avatar-caption-"));
  env.dataDir = testDataDir;
  mkdirSync(join(testDataDir, "images"));
  await Bun.write(join(testDataDir, "images", "avatar.png"), Buffer.from(PNG, "base64"));
});

afterAll(() => {
  env.dataDir = originalDataDir;
  rmSync(testDataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
  calls = [];
  imageCalls = 0;
  captionBehavior = undefined;
  registerProvider({
    name: "custom", displayName: "Test vision", capabilities: originalParser.capabilities,
    defaultUrl: originalParser.defaultUrl,
    async generate(_key, _url, request) {
      if (request.signal?.aborted) throw request.signal.reason;
      const isCaption = request.messages.some(message => Array.isArray(message.content)
        && message.content.some(part => part.type === "image"));
      if (isCaption) {
        calls.push(request);
        await captionBehavior?.(request);
        return { content: `appearance from ${request.model}`, finish_reason: "stop" };
      }
      return { content: '{"prompt":"current scene","negative_prompt":"blur"}', finish_reason: "stop" };
    },
    generateStream: originalParser.generateStream.bind(originalParser),
    validateKey: originalParser.validateKey.bind(originalParser),
    listModels: originalParser.listModels.bind(originalParser),
  });
  registerImageProvider({
    name: "swarmui", displayName: "Test image provider",
    capabilities: { parameters: {}, apiKeyRequired: false, modelListStyle: "static", defaultUrl: "http://127.0.0.1:1" },
    async generate(_key, _url, request) {
      imageCalls++;
      return { imageDataUrl: "", provider: "swarmui", model: request.model || "test" };
    },
    async validateKey() { return true; }, async listModels() { return []; },
  });
  parserId = (await connections.createConnection(USER_ID, {
    name: "Vision", provider: "custom", model: "vision-one", api_url: "http://127.0.0.1:1",
  })).id;
  const imageConnection = await imageConnections.createConnection(USER_ID, {
    name: "Images", provider: "swarmui", model: "test", api_url: "http://127.0.0.1:1", is_default: true,
  });
  characterId = characters.createCharacter(USER_ID, { name: "Silver" }).id;
  getDb().query("INSERT INTO images (id, filename, mime_type, user_id) VALUES (?, ?, ?, ?)")
    .run(IMAGE_ID, "avatar.png", "image/png", USER_ID);
  getDb().query("UPDATE characters SET image_id = ? WHERE id = ?").run(IMAGE_ID, characterId);
  chatId = crypto.randomUUID();
  getDb().query("INSERT INTO chats (id,user_id,character_id,name,metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(chatId, USER_ID, characterId, "Avatar test", "{}", 1, 1);
  settings.putSetting(USER_ID, "imageGeneration", {
    activeImageGenConnectionId: imageConnection.id, describeCharacterAvatar: true,
    includeCharacters: true, includePersona: false, promptMode: "parsed_custom",
    customPrompt: "describe the scene", promptParserConnectionId: parserId,
    promptParserModel: "", promptGenerationTimeoutSeconds: 0, addToGallery: false,
  });
});

afterEach(() => {
  registerProvider(originalParser);
  if (originalImageProvider) registerImageProvider(originalImageProvider);
  closeDatabase();
});

function patchSettings(patch: Record<string, unknown>) {
  settings.putSetting(USER_ID, "imageGeneration", {
    ...settings.getSetting(USER_ID, "imageGeneration")!.value, ...patch,
  });
}
const context = (signal?: AbortSignal) => buildContextMessages(USER_ID, chatId, getImageGenSettings(USER_ID), signal);
const cached = () => captions.getCachedCaption(USER_ID, "character", characterId);

function blockUntilAborted() {
  let started!: () => void;
  const captionStarted = new Promise<void>(resolve => { started = resolve; });
  captionBehavior = request => new Promise<void>((_resolve, reject) => {
    request.signal!.addEventListener("abort", () => reject(request.signal!.reason), { once: true });
    started();
  });
  return captionStarted;
}

describe("avatar captioning parser and cache", () => {
  test("reuses captions for unchanged effective settings and refreshes after the connection model changes", async () => {
    const first = await context();
    expect(await context()).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(calls[0].messages[1].content).toEqual([
      { type: "image", data: PNG, mime_type: "image/png" },
      { type: "text", text: expect.stringContaining("Describe this image") },
    ]);
    const fingerprint = cached()!.fingerprint;
    await connections.updateConnection(USER_ID, parserId, { model: "vision-two" });
    expect(JSON.stringify(await context())).toContain("appearance from vision-two");
    expect(calls).toHaveLength(2);
    expect(cached()!.fingerprint).not.toBe(fingerprint);
  });

  test("refreshes when the fallback sidecar model, parameters, or connection changes", async () => {
    patchSettings({ promptParserConnectionId: null });
    settings.putSetting(USER_ID, "sidecarSettings", { connectionProfileId: parserId, model: "sidecar-one", temperature: 0.1 });
    await context();
    settings.putSetting(USER_ID, "sidecarSettings", { connectionProfileId: parserId, model: "sidecar-two", temperature: 0.1 });
    expect(JSON.stringify(await context())).toContain("appearance from sidecar-two");
    settings.putSetting(USER_ID, "sidecarSettings", { connectionProfileId: parserId, model: "sidecar-two", temperature: 0.8 });
    await context();
    const nextParser = await connections.createConnection(USER_ID, {
      name: "Other vision", provider: "custom", model: "sidecar-two", api_url: "http://127.0.0.1:2",
    });
    settings.putSetting(USER_ID, "sidecarSettings", { connectionProfileId: nextParser.id, model: "sidecar-two", temperature: 0.8 });
    await context();
    expect(calls).toHaveLength(4);
    expect(calls.map(call => call.model)).toEqual(["sidecar-one", "sidecar-two", "sidecar-two", "sidecar-two"]);
    expect(calls[2].parameters?.temperature).toBe(0.8);
    await context();
    expect(calls).toHaveLength(4);
  });

  test("uses captioning preset overrides and refreshes after prompt or connection configuration changes", async () => {
    const preset = { id: "caption", name: "Caption", kind: "captioning", mode: "custom", prompt: "face tags", parserConnectionId: parserId, parserModel: "preset-model", parserParameters: { temperature: 0.3 } };
    patchSettings({ activeCaptioningPresetId: preset.id, promptPresets: [preset] });
    await context();
    expect(calls[0].model).toBe("preset-model");
    expect(calls[0].parameters?.temperature).toBe(0.3);
    expect(calls[0].messages[1].content).toEqual([
      { type: "image", data: PNG, mime_type: "image/png" }, { type: "text", text: "face tags" },
    ]);
    patchSettings({ promptPresets: [{ ...preset, prompt: "full appearance tags" }] });
    await context();
    await connections.updateConnection(USER_ID, parserId, { api_url: "http://127.0.0.1:2", metadata: { test: "new configuration" } });
    await context();
    expect(calls).toHaveLength(3);
  });

  test("ordinary caption failures remain optional and retry without storing a failed result", async () => {
    captionBehavior = async () => { throw new Error("Vision unavailable"); };
    const messages = await context();
    expect(messages.some(message => String(message.content).includes("Visual appearance reference"))).toBe(false);
    expect(cached()).toBeNull();
    captionBehavior = undefined;
    expect(JSON.stringify(await context())).toContain("appearance from vision-one");
    expect(calls).toHaveLength(2);
  });
});

describe("avatar captioning cancellation", () => {
  test("cancels the caption request with its image job and never starts image generation or caches the caption", async () => {
    const started = blockUntilAborted();
    const pending = generateSceneBackground(USER_ID, chatId, {
      ownerExtensionIdentifier: "caption-test", clientJobId: "cancel-caption", outputTarget: "preview", forceGeneration: true,
    });
    const result = pending.then(() => null, error => error);
    await started;
    expect(cancelExtensionImageGeneration(USER_ID, "caption-test", "cancel-caption")).toBe(true);
    expect(await result).toEqual(new Error("Generation cancelled"));
    expect(calls[0].signal?.aborted).toBe(true);
    expect(cached()).toBeNull();
    expect(imageCalls).toBe(0);
  });

  test("enforces the parent prompt deadline even when the caption timeout is disabled", async () => {
    blockUntilAborted();
    await expect(generateSceneBackground(USER_ID, chatId, {
      promptGenerationTimeoutSeconds: 1, outputTarget: "preview", forceGeneration: true,
    })).rejects.toThrow("Image prompt generation timed out after 1s");
    expect(calls[0].signal?.aborted).toBe(true);
    expect(cached()).toBeNull();
    expect(imageCalls).toBe(0);
  });

  test("omits an individually timed-out caption when the parent is still active", async () => {
    blockUntilAborted();
    patchSettings({ promptGenerationTimeoutSeconds: 1 });
    const controller = new AbortController();
    const messages = await context(controller.signal);
    expect(controller.signal.aborted).toBe(false);
    expect(calls[0].signal?.aborted).toBe(true);
    expect(cached()).toBeNull();
    expect(messages.some(message => String(message.content).includes("Visual appearance reference"))).toBe(false);
  });

  test("does not cache a late caption from a provider that completes after cancellation", async () => {
    let release!: () => void;
    let started!: () => void;
    const captionStarted = new Promise<void>(resolve => { started = resolve; });
    const captionReleased = new Promise<void>(resolve => { release = resolve; });
    captionBehavior = async () => { started(); await captionReleased; };
    const controller = new AbortController();
    const pending = context(controller.signal);
    const result = pending.then(() => null, error => error);
    await captionStarted;
    controller.abort(new Error("Cancelled"));
    release();
    expect(await result).toEqual(new Error("Cancelled"));
    expect(cached()).toBeNull();
  });

  test("a pre-cancelled caption request never calls the provider", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Already cancelled"));
    await expect(captionImage(USER_ID, {
      image: PNG, mimeType: "image/png", parserConnectionId: parserId, signal: controller.signal,
    })).rejects.toThrow("Already cancelled");
    expect(calls).toHaveLength(0);
  });
});
