import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { getImageProvider, registerImageProvider } from "../image-gen/registry";
import type { ImageProvider } from "../image-gen/provider";
import type { ImageGenRequest } from "../image-gen/types";
import { WorkerHostImageGenApi } from "../spindle/worker-host-image-gen-api";
import * as connections from "./image-gen-connections.service";
import * as characters from "./characters.service";
import * as settings from "./settings.service";
import { generateSceneBackground } from "./image-gen.service";
import { getWeaverVisualJob, startWeaverVisualJob } from "./weaver/visual/service";

let originalProvider: ImageProvider | undefined;
let requests: ImageGenRequest[];
let userId: string;

beforeAll(() => {
  originalProvider = getImageProvider("novelai");
  registerImageProvider({
    name: "novelai", displayName: "NovelAI test",
    capabilities: { parameters: {}, apiKeyRequired: false, modelListStyle: "static", defaultUrl: "https://image.novelai.net" },
    async generate(_key, _url, request) {
      requests.push(request);
      return { imageDataUrl: "", model: request.model, provider: "novelai" };
    },
    async validateKey() { return true; },
    async listModels() { return []; },
  });
});

afterAll(() => {
  if (originalProvider) registerImageProvider(originalProvider);
});

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
  requests = [];
  userId = crypto.randomUUID();
});

afterEach(() => closeDatabase());

for (const nonStreaming of [true, false]) {
  for (const entryPoint of ["chat", "weaver", "spindle"] as const) {
    test(`${entryPoint} uses the saved connection transport (${nonStreaming}) independently of image parameters`, async () => {
      const connection = await connections.createConnection(userId, {
        name: "NovelAI", provider: "novelai", model: "nai-diffusion-5-full", is_default: true,
        api_url: "https://proxy.example/root/",
        default_parameters: { nonStreaming: !nonStreaming },
        metadata: { novelai: { nonStreaming } },
      });

      if (entryPoint === "chat") {
        settings.putSetting(userId, "imageGeneration", {
          enabled: true, activeImageGenConnectionId: connection.id,
          promptMode: "custom", outputTarget: "preview", addToGallery: false,
        });
        const character = characters.createCharacter(userId, { name: "Transport test" });
        const chatId = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        getDb().query("INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(chatId, userId, character.id, "Transport test", "{}", now, now);
        await generateSceneBackground(userId, chatId, {
          promptMode: "custom", prompt: "a fox", skipParse: true,
          outputTarget: "preview", forceGeneration: true,
          parameters: { nonStreaming: !nonStreaming },
        });
      } else if (entryPoint === "weaver") {
        let settle!: () => void;
        const settled = new Promise<void>((resolve) => { settle = resolve; });
        const job = startWeaverVisualJob({
          userId, sessionId: "session", characterId: "character", connection, apiKey: "",
          input: { kind: "portrait", prompt: "a fox", connection_id: connection.id },
          persistResult: async ({ result }) => result,
          onSettled: settle,
        });
        await settled;
        expect(getWeaverVisualJob(userId, job.id)?.status).toBe("completed");
      } else {
        const messages: any[] = [];
        const api = new WorkerHostImageGenApi({
          extensionIdentifier: "transport_test", hasPermission: () => true,
          resolveEffectiveUserId: () => userId, enforceScopedUser: () => {},
          post: (message) => messages.push(message),
        });
        await api.handleGenerate("request", {
          connection_id: connection.id, prompt: "a fox",
          parameters: { nonStreaming: !nonStreaming },
        });
        expect(messages[0]?.error).toBeUndefined();
      }

      expect(requests).toHaveLength(1);
      expect(requests[0].connectionOptions?.novelai?.nonStreaming).toBe(nonStreaming);
      expect(connections.getConnection(userId, connection.id)?.api_url).toBe("https://proxy.example/root/");
    });
  }
}
