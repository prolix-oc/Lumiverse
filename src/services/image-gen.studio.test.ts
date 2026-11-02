import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { env } from "../env";
import { getImageProvider, registerImageProvider } from "../image-gen/registry";
import * as imageConnections from "./image-gen-connections.service";
import * as imagesSvc from "./images.service";
import * as settings from "./settings.service";
import { generateStudioImage } from "./image-gen.service";

const USER_ID = "image-studio-user";
const REF_IMAGE_ID = "studio-reference";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const originalImageProvider = getImageProvider("swarmui");
const originalAltProvider = getImageProvider("recraft");
const originalDataDir = env.dataDir;

let testDataDir: string;
let connectionId: string;
let altConnectionId: string;
let requests: Array<{ prompt: string; model: string; parameters: Record<string, any> }> = [];
let generateCalls = 0;

beforeAll(() => {
  testDataDir = mkdtempSync(join(tmpdir(), "image-studio-"));
  env.dataDir = testDataDir;
  mkdirSync(join(testDataDir, "images"), { recursive: true });
});

afterAll(() => {
  env.dataDir = originalDataDir;
  rmSync(testDataDir, { recursive: true, force: true });
});

afterEach(async () => {
  // Thumbnail work runs in the background after a save; drain it while the
  // in-memory database is still open so it cannot race the next test.
  await imagesSvc.waitForDeferredImageProcessing().catch(() => {});
  if (originalImageProvider) registerImageProvider(originalImageProvider);
  else registerImageProvider({
    name: "swarmui", displayName: "SwarmUI", capabilities: { parameters: {}, apiKeyRequired: true, modelListStyle: "static", defaultUrl: "" },
    async generate() { throw new Error("unused"); }, async validateKey() { return false; }, async listModels() { return []; },
  });
  if (originalAltProvider) registerImageProvider(originalAltProvider);
  closeDatabase();
});

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
  requests = [];
  generateCalls = 0;

  registerImageProvider({
    name: "swarmui",
    displayName: "Studio test provider",
    capabilities: { parameters: {}, apiKeyRequired: false, modelListStyle: "static", defaultUrl: "" },
    async generate(_key, _url, request) {
      generateCalls += 1;
      requests.push({ prompt: request.prompt, model: request.model, parameters: request.parameters });
      return { imageDataUrl: `data:image/png;base64,${PNG}`, provider: "swarmui", model: request.model || "studio-model" };
    },
    async validateKey() { return true; },
    async listModels() { return []; },
  });
  // No entry in the image-input map, so references must be rejected up front.
  registerImageProvider({
    name: "recraft",
    displayName: "No image input provider",
    capabilities: { parameters: {}, apiKeyRequired: false, modelListStyle: "static", defaultUrl: "" },
    async generate(_key, _url, request) {
      generateCalls += 1;
      requests.push({ prompt: request.prompt, model: request.model, parameters: request.parameters });
      return { imageDataUrl: `data:image/png;base64,${PNG}`, provider: "recraft", model: request.model || "alt-model" };
    },
    async validateKey() { return true; },
    async listModels() { return []; },
  });

  const connection = await imageConnections.createConnection(USER_ID, {
    name: "Studio", provider: "swarmui", model: "studio-model", api_url: "http://127.0.0.1:1", is_default: true,
  });
  connectionId = connection.id;
  const alt = await imageConnections.createConnection(USER_ID, {
    name: "No refs", provider: "recraft", model: "alt-model", api_url: "http://127.0.0.1:1",
  });
  altConnectionId = alt.id;
  settings.putSetting(USER_ID, "imageGeneration", {
    activeImageGenConnectionId: connectionId,
    promptMode: "custom",
    customPrompt: "",
    generationTimeoutSeconds: 30,
    addToGallery: false,
  });

  getDb().query("INSERT INTO images (id, filename, mime_type, user_id) VALUES (?, ?, ?, ?)")
    .run(REF_IMAGE_ID, "reference.png", "image/png", USER_ID);
  await Bun.write(join(testDataDir, "images", "reference.png"), Buffer.from(PNG, "base64"));
});

test("studio generation resolves reference images into the provider request and stores the result", async () => {
  const result = await generateStudioImage(USER_ID, {
    prompt: "portrait of a knight, oil painting",
    negativePrompt: "blurry",
    referenceImageIds: [REF_IMAGE_ID],
  });

  expect(requests).toHaveLength(1);
  expect(requests[0].prompt).toBe("portrait of a knight, oil painting");
  expect(requests[0].model).toBe("studio-model");
  expect(requests[0].parameters.resolvedSourceImages).toEqual([{ data: PNG, mimeType: "image/png" }]);

  expect(result.imageId).toBeTruthy();
  expect(result.imageUrl).toBe(`/api/v1/images/${result.imageId}`);
  expect(result.provider).toBe("swarmui");
  expect(result.model).toBe("studio-model");
  expect(result.prompt).toBe("portrait of a knight, oil painting");
  // The generated bytes really landed in the image store.
  expect(await Bun.file(join(testDataDir, "images", `${result.imageId}.png`)).exists()).toBe(true);
});

test("studio generation without references sends no source images", async () => {
  const result = await generateStudioImage(USER_ID, { prompt: "a quiet street" });

  expect(generateCalls).toBe(1);
  expect(requests[0].parameters.resolvedSourceImages).toBeUndefined();
  expect(result.imageId).toBeTruthy();
});

test("studio generation refuses an empty prompt before touching the provider", async () => {
  await expect(generateStudioImage(USER_ID, { prompt: "   " })).rejects.toThrow("prompt is required");
  expect(generateCalls).toBe(0);
});

test("studio generation rejects reference images when the provider has no image input", async () => {
  await expect(generateStudioImage(USER_ID, {
    prompt: "portrait",
    connectionId: altConnectionId,
    referenceImageIds: [REF_IMAGE_ID],
  })).rejects.toThrow("cannot take reference images");
  expect(generateCalls).toBe(0);
});
