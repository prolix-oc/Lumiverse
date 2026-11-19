import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, initDatabase } from "../db/connection";
import { env } from "../env";
import { OpenRouterProvider } from "../llm/providers/openrouter";
import { initMacros } from "../macros";
import { audioRoutes } from "../routes/audio.routes";
import type { PromptBlock } from "../types/preset";
import { createCharacter } from "./characters.service";
import { createChat, createMessage } from "./chats.service";
import { createPreset } from "./presets.service";
import { assemblePrompt } from "./prompt-assembly.service";

const userId = "audio-attachment-user";
const originalDataDir = env.dataDir;
let directory: string;
let fetchSpy: ReturnType<typeof spyOn> | undefined;
const app = new Hono();
app.use("*", async (c, next) => { c.set("userId", userId); await next(); });
app.route("/audio", audioRoutes);

beforeEach(async () => {
  closeDatabase();
  directory = await mkdtemp(join(tmpdir(), "lumiverse-audio-attachments-"));
  env.dataDir = directory;
  const db = initDatabase(":memory:");
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text());
  initMacros();
});
afterEach(async () => {
  fetchSpy?.mockRestore();
  closeDatabase();
  env.dataDir = originalDataDir;
  await rm(directory, { recursive: true, force: true });
});

/** A short, valid 8 kHz mono PCM WAV; no external encoder needed. */
function wavFixture(): Buffer<ArrayBuffer> {
  const pcmBytes = 160;
  const wav = Buffer.alloc(44 + pcmBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcmBytes, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcmBytes, 40);
  return wav;
}

for (const withPreset of [false, true]) {
  for (const stream of [false, true]) {
    test(`${withPreset ? "preset" : "legacy"} assembly sends uploaded audio through ${stream ? "streaming" : "JSON"} OpenRouter requests`, async () => {
      const wav = wavFixture();
      const form = new FormData();
      form.append("audio", new File([wav], "clip.wav", { type: "audio/x-wav" }));
      const uploaded = await app.request("http://localhost/audio", { method: "POST", body: form });
      expect(uploaded.status).toBe(201);
      const stored = await uploaded.json() as { id: string; mime_type: string };
      expect(stored.mime_type).toBe("audio/wav");

      const character = createCharacter(userId, { name: "Listener" });
      const chat = createChat(userId, { character_id: character.id });
      const attachment = { type: "audio", image_id: stored.id, mime_type: stored.mime_type };
      createMessage(chat.id, { is_user: true, name: "User", content: "", extra: { attachments: [attachment] } }, userId);
      // Saved assistant speech is for playback and must not be sent as model input.
      createMessage(chat.id, { is_user: false, name: "Listener", content: "What should I listen for?", extra: { attachments: [attachment] } }, userId);
      createMessage(chat.id, { is_user: true, name: "User", content: "Transcribe this.", extra: { attachments: [attachment] } }, userId);
      const history: PromptBlock = { id: "history", name: "Chat history", content: "", marker: "chat_history", enabled: true,
        role: "system", position: "pre_history", depth: 0, isLocked: false, color: null, injectionTrigger: [], group: null };
      const preset = withPreset ? createPreset(userId, { name: "Audio", provider: "openrouter", prompt_order: [history] }) : undefined;
      const assembled = await assemblePrompt({ userId, chatId: chat.id, generationType: "normal", presetOverride: preset,
        skipPromptRegex: true, macroCommit: false });

      let sent: any;
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return stream
          ? new Response('data: {"choices":[{"delta":{"content":"Silence."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } })
          : Response.json({ choices: [{ message: { content: "Silence." }, finish_reason: "stop" }] });
      }) as typeof fetch);
      const provider = new OpenRouterProvider();
      const request = { model: "google/gemini-2.5-flash", messages: assembled.messages };
      if (stream) {
        for await (const _chunk of provider.generateStream("placeholder", "", request)) { /* drain */ }
      } else {
        await provider.generate("placeholder", "", request);
      }

      const expectedAudio = { type: "input_audio", input_audio: { data: wav.toString("base64"), format: "wav" } };
      const userMessages = sent.messages.filter((message: any) => message.role === "user");
      expect(userMessages).toEqual([
        { role: "user", content: [expectedAudio] },
        { role: "user", content: [{ type: "text", text: "Transcribe this." }, expectedAudio] },
      ]);
      expect(sent.messages.filter((message: any) => message.role === "assistant")).toEqual([
        { role: "assistant", content: "What should I listen for?" },
      ]);
      expect(Buffer.from(userMessages[0].content[0].input_audio.data, "base64")).toEqual(wav);
      expect(sent.stream).toBe(stream);
    });
  }
}
