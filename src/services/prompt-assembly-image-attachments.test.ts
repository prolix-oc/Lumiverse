import { afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { closeDatabase, initDatabase } from "../db/connection";
import { env } from "../env";
import { OpenRouterProvider } from "../llm/providers/openrouter";
import { initMacros } from "../macros";
import { imagesRoutes } from "../routes/images.routes";
import type { PromptBlock } from "../types/preset";
import { createCharacter } from "./characters.service";
import { createChat, createMessage } from "./chats.service";
import { resetDeferredImageProcessingForTests, waitForDeferredImageProcessing } from "./images.service";
import { createPreset } from "./presets.service";
import { assemblePrompt } from "./prompt-assembly.service";

const userId = "image-attachment-user";
const originalDataDir = env.dataDir;
const fixtures: { mime: string; uploadMime: string; filename: string; bytes: Uint8Array<ArrayBuffer> }[] = [];
let directory: string;
let fetchSpy: ReturnType<typeof spyOn> | undefined;
const app = new Hono();
app.use("*", async (c, next) => { c.set("userId", userId); await next(); });
app.route("/images", imagesRoutes);

beforeAll(async () => {
  for (const format of ["png", "jpeg", "webp", "gif"] as const) {
    const bytes = await sharp({ create: { width: 4, height: 3, channels: 3, background: "#7461af" } }).toFormat(format).toBuffer();
    fixtures.push({ mime: `image/${format}`, uploadMime: format === "jpeg" ? "image/jpg" : `image/${format}`,
      filename: `image.${format}`, bytes: new Uint8Array(bytes) });
  }
});
beforeEach(async () => {
  resetDeferredImageProcessingForTests();
  closeDatabase();
  directory = await mkdtemp(join(tmpdir(), "lumiverse-image-attachments-"));
  env.dataDir = directory;
  const db = initDatabase(":memory:");
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text());
  initMacros();
});
afterEach(async () => {
  fetchSpy?.mockRestore();
  await waitForDeferredImageProcessing();
  resetDeferredImageProcessingForTests();
  closeDatabase();
  env.dataDir = originalDataDir;
  await rm(directory, { recursive: true, force: true });
});

for (const withPreset of [false, true]) {
  for (const stream of [false, true]) {
    test(`${withPreset ? "preset" : "legacy"} assembly sends uploaded PNG, JPEG, WebP, and GIF images through ${stream ? "streaming" : "JSON"} OpenRouter requests`, async () => {
      const attachments = [];
      for (const fixture of fixtures) {
        const form = new FormData();
        form.append("image", new File([fixture.bytes], fixture.filename, { type: fixture.uploadMime }));
        const uploaded = await app.request("http://localhost/images", { method: "POST", body: form });
        expect(uploaded.status).toBe(201);
        const stored = await uploaded.json() as { id: string; mime_type: string };
        attachments.push({ type: "image", image_id: stored.id, mime_type: stored.mime_type });
      }
      await waitForDeferredImageProcessing();

      const character = createCharacter(userId, { name: "Viewer" });
      const chat = createChat(userId, { character_id: character.id });
      createMessage(chat.id, { is_user: true, name: "User", content: "", extra: { attachments: attachments.slice(0, 1) } }, userId);
      createMessage(chat.id, { is_user: false, name: "Viewer", content: "Show me more." }, userId);
      createMessage(chat.id, { is_user: true, name: "User", content: "Compare these.", extra: { attachments: attachments.slice(1) } }, userId);
      const history: PromptBlock = { id: "history", name: "Chat history", content: "", marker: "chat_history", enabled: true,
        role: "system", position: "pre_history", depth: 0, isLocked: false, color: null, injectionTrigger: [], group: null };
      const preset = withPreset ? createPreset(userId, { name: "Images", provider: "openrouter", prompt_order: [history] }) : undefined;
      const assembled = await assemblePrompt({ userId, chatId: chat.id, generationType: "normal", presetOverride: preset,
        skipPromptRegex: true, macroCommit: false });

      let sent: any;
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return stream
          ? new Response('data: {"choices":[{"delta":{"content":"Purple images."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } })
          : Response.json({ choices: [{ message: { content: "Purple images." }, finish_reason: "stop" }] });
      }) as typeof fetch);
      const provider = new OpenRouterProvider();
      const request = { model: "google/gemini-2.5-flash", messages: assembled.messages };
      if (stream) {
        for await (const _chunk of provider.generateStream("placeholder", "", request)) { /* drain */ }
      } else {
        await provider.generate("placeholder", "", request);
      }

      const expectedImages = fixtures.map((fixture) => ({ type: "image_url", image_url: {
        url: `data:${fixture.mime};base64,${Buffer.from(fixture.bytes).toString("base64")}`,
      } }));
      const userMessages = sent.messages.filter((message: any) => message.role === "user");
      expect(userMessages).toEqual([
        { role: "user", content: expectedImages.slice(0, 1) },
        { role: "user", content: [{ type: "text", text: "Compare these." }, ...expectedImages.slice(1)] },
      ]);
      const sentImages = userMessages.flatMap((message: any) => message.content).filter((part: any) => part.type === "image_url");
      for (const [index, part] of sentImages.entries()) {
        const encoded = part.image_url.url.split(",")[1];
        expect(new Uint8Array(Buffer.from(encoded, "base64"))).toEqual(fixtures[index].bytes);
      }
      expect(sent.stream).toBe(stream);
    });
  }
}
