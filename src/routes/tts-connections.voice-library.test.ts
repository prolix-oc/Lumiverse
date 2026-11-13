import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../db/connection";

const keys = new Map<string, string>();
mock.module("../services/secrets.service", () => ({
  SYSTEM_SECRET_PRINCIPAL: "__system__",
  SYSTEM_SECRET_PRINCIPAL_EMAIL: "system@lumiverse.local",
  getSecret: async (user: string, key: string) => keys.get(`${user}:${key}`) ?? null,
  getSecretForStatus: async (user: string, key: string) => keys.get(`${user}:${key}`) ?? null,
  putSecret: async (user: string, key: string, value: string) => { keys.set(`${user}:${key}`, value); },
  deleteSecret: (user: string, key: string) => keys.delete(`${user}:${key}`),
}));
const svc = await import("../services/tts-connections.service");
const { ttsConnectionsRoutes } = await import("./tts-connections.routes");
const requests: Request[] = [];
let upstream: ReturnType<typeof Bun.serve>;
let apiUrl = "";

beforeAll(() => {
  upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      requests.push(request.clone());
      const url = new URL(request.url);
      if (url.pathname === "/v1/voices") return Response.json({ voices: [{ voice_id: "saved", name: "Saved voice" }] });
      if (url.pathname === "/v1/text-to-speech/library-1") return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
      if (url.pathname !== "/v1/shared-voices") return new Response("Not modeled", { status: 501 });
      if (url.searchParams.get("search") === "rate-limit") {
        return Response.json({ detail: { status: "rate_limit_exceeded", message: "Try later test-key" } }, { status: 429 });
      }
      return Response.json({
        voices: [{ voice_id: "library-1", name: "Alita", language: "en", gender: "female", accent: "american", age: "young", description: "Calm narration", preview_url: "https://example.com/preview.mp3", use_case: "audiobook", rate: 2, notice_period: 30, live_moderation_enabled: true }],
        has_more: url.searchParams.get("page") === "0", total_count: 21,
      });
    },
  });
  apiUrl = upstream.url.origin;
});
beforeEach(() => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().exec(readFileSync(new URL("../db/migrations/051_tts_connections.sql", import.meta.url), "utf8"));
  keys.clear();
  requests.length = 0;
});
afterEach(() => closeDatabase());
afterAll(() => upstream?.stop(true));

function app(user = "alice") {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", user); await next(); });
  app.route("/", ttsConnectionsRoutes);
  return app;
}
function browse(input: Record<string, unknown>, user = "alice") {
  return app(user).request("/voices/library", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
}

test("draft credentials browse shared voices over HTTP with provider filters and pagination", async () => {
  const input = { provider: "elevenlabs", api_url: apiUrl, api_key: "test-key", search: " calm & warm ", language: "en", gender: "female", page_size: 20, page: 0, sort: "trending" };
  const response = await browse(input);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    provider: "elevenlabs", has_more: true, total_count: 21,
    voices: [{ id: "library-1", name: "Alita", language: "en", gender: "female", description: "Calm narration", previewUrl: "https://example.com/preview.mp3", accent: "american", useCase: "audiobook", rate: 2, noticePeriod: 30, liveModeration: true }],
  });
  expect(requests[0].headers.get("xi-api-key")).toBe("test-key");
  const url = new URL(requests[0].url);
  expect(url.searchParams.get("search")).toBe("calm & warm");
  for (const key of ["language", "gender", "page_size", "page", "sort"] as const) expect(url.searchParams.get(key)).toBe(String(input[key]));
  const next = await browse({ ...input, page: 1 });
  expect(await next.json()).toMatchObject({ has_more: false });
});

test("saved credentials stay scoped to their owner and endpoint", async () => {
  const profile = await svc.createConnection("alice", { name: "ElevenLabs", provider: "elevenlabs", api_url: apiUrl, api_key: "test-key" });
  expect(await (await browse({ connection_id: profile.id, provider: "elevenlabs" })).json()).toMatchObject({ has_more: true });
  expect(requests).toHaveLength(1);
  expect(await (await browse({ connection_id: profile.id, provider: "elevenlabs" }, "bob")).json()).toMatchObject({ error: "Connection not found" });
  expect(await (await browse({ connection_id: profile.id, provider: "elevenlabs", api_url: "https://other.example" })).json()).toMatchObject({ error: "Enter an API key to browse a different endpoint" });
  expect(requests).toHaveLength(1);
});

test("missing keys and unsupported libraries never call the upstream API", async () => {
  expect(await (await browse({ provider: "elevenlabs", api_url: apiUrl })).json()).toMatchObject({ error: "No API key", has_more: false });
  expect(await (await browse({ provider: "google_tts", api_url: apiUrl, api_key: "test-key" })).json()).toMatchObject({ error: "This provider does not have a voice library" });
  expect(requests).toHaveLength(0);
});

test.each([{ page: -1 }, { page: 0.5 }, { page_size: 101 }, { page_size: 0 }, { gender: "other" }, { sort: "random" }, { search: "x".repeat(201) }, { api_key: {} }, { connection_id: 3 }])("rejects invalid library input before dispatch: %j", async (invalid) => {
  expect((await browse({ provider: "elevenlabs", api_url: apiUrl, api_key: "test-key", ...invalid })).status).toBe(400);
  expect(requests).toHaveLength(0);
});

test("rate limits are actionable errors without exposing credentials", async () => {
  const response = await browse({ provider: "elevenlabs", api_url: apiUrl, api_key: "test-key", search: "rate-limit" });
  const body = await response.json() as { error: string; has_more: boolean };
  expect(body.has_more).toBe(false);
  expect(body.error).toContain("429");
  expect(body.error).toContain("Try later");
  expect(body.error).not.toContain("test-key");
});

test("saved voices still use their original endpoint and library IDs work with synthesis", async () => {
  const profile = await svc.createConnection("alice", { name: "ElevenLabs", provider: "elevenlabs", api_url: apiUrl, api_key: "test-key" });
  expect((await svc.listConnectionVoices("alice", profile.id)).voices).toMatchObject([{ id: "saved", name: "Saved voice" }]);
  const { ElevenLabsTtsProvider } = await import("../tts/providers/elevenlabs");
  const audio = await new ElevenLabsTtsProvider().synthesize("test-key", apiUrl, { voice: "library-1", model: "eleven_multilingual_v2", text: "Hello", parameters: {} });
  expect(audio.audioData.byteLength).toBe(3);
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual(["/v1/voices", "/v1/text-to-speech/library-1"]);
});
