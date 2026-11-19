import { afterEach, describe, expect, test } from "bun:test";
import { buildGoogleAuth, GoogleProvider, normalizeGoogleApiKeyLocation } from "./google";
import { injectConnectionMetadataFlags } from "../../services/generation/connection-metadata";
import type { GenerationParameters } from "../types";

const KEY = "placeholder-key";
const GATEWAY = "https://gateway.example.test";

interface Captured { url: string; headers: Record<string, string>; body: any }
const originalFetch = globalThis.fetch;
let captured: Captured[] = [];

function stubFetch(respond: () => Response): void {
  captured = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return respond();
  }) as typeof fetch;
}

const textResponse = () => Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] });
const streamResponse = () => new Response(
  'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n',
  { headers: { "Content-Type": "text/event-stream" } },
);
const modelsResponse = () => Response.json({ models: [{ name: "models/gemini-2.5-flash" }] });

function request(location?: unknown) {
  return {
    model: "gemini-2.5-flash",
    messages: [{ role: "user" as const, content: "hi" }],
    parameters: location === undefined ? {} : { _google_api_key_location: location },
  };
}

afterEach(() => { globalThis.fetch = originalFetch; });

describe("normalizeGoogleApiKeyLocation", () => {
  test("accepts header and bearer and falls back to query for anything else", () => {
    expect(normalizeGoogleApiKeyLocation("header")).toBe("header");
    expect(normalizeGoogleApiKeyLocation("bearer")).toBe("bearer");
    for (const value of ["query", undefined, null, "", "Bearer", 1, {}]) {
      expect(normalizeGoogleApiKeyLocation(value)).toBe("query");
    }
  });
});

describe("buildGoogleAuth", () => {
  test("query appends key with the right separator and sends no auth header", () => {
    expect(buildGoogleAuth(`${GATEWAY}/v1beta/models`, KEY, "query"))
      .toEqual({ url: `${GATEWAY}/v1beta/models?key=${KEY}`, headers: {} });
    expect(buildGoogleAuth(`${GATEWAY}/x:streamGenerateContent?alt=sse`, KEY, "query"))
      .toEqual({ url: `${GATEWAY}/x:streamGenerateContent?alt=sse&key=${KEY}`, headers: {} });
  });

  test("header and bearer keep the key out of the URL", () => {
    expect(buildGoogleAuth(`${GATEWAY}/v1beta/models`, KEY, "header"))
      .toEqual({ url: `${GATEWAY}/v1beta/models`, headers: { "x-goog-api-key": KEY } });
    expect(buildGoogleAuth(`${GATEWAY}/v1beta/models`, KEY, "bearer"))
      .toEqual({ url: `${GATEWAY}/v1beta/models`, headers: { Authorization: `Bearer ${KEY}` } });
  });
});

describe("GoogleProvider API key location", () => {
  test("generate keeps the query key by default, matching the previous URL exactly", async () => {
    stubFetch(textResponse);
    await new GoogleProvider().generate(KEY, "", request());
    expect(captured[0].url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${KEY}`);
    expect(captured[0].headers["x-goog-api-key"]).toBeUndefined();
    expect(captured[0].headers.authorization).toBeUndefined();
  });

  test.each([
    ["header", "x-goog-api-key", KEY],
    ["bearer", "authorization", `Bearer ${KEY}`],
  ])("generate with %s sends the key only in the header", async (location, header, value) => {
    stubFetch(textResponse);
    await new GoogleProvider().generate(KEY, GATEWAY, request(location));
    expect(captured[0].url).toBe(`${GATEWAY}/v1beta/models/gemini-2.5-flash:generateContent`);
    expect(captured[0].headers[header]).toBe(value);
    expect(captured[0].headers["content-type"]).toBe("application/json");
  });

  test("generateStream keeps alt=sse and honors the location", async () => {
    stubFetch(streamResponse);
    for await (const _ of new GoogleProvider().generateStream(KEY, "", request())) { /* drain */ }
    expect(captured[0].url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${KEY}`);

    stubFetch(streamResponse);
    for await (const _ of new GoogleProvider().generateStream(KEY, GATEWAY, request("bearer"))) { /* drain */ }
    expect(captured[0].url).toBe(`${GATEWAY}/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`);
    expect(captured[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });

  test("the internal location parameter never reaches the request body", async () => {
    stubFetch(textResponse);
    await new GoogleProvider().generate(KEY, GATEWAY, request("bearer"));
    expect(captured[0].body).not.toHaveProperty("_google_api_key_location");
  });

  test("validateKey and listModels read the location from connection metadata", async () => {
    const provider = new GoogleProvider();

    stubFetch(modelsResponse);
    expect(await provider.validateKey(KEY, GATEWAY)).toBe(true);
    expect(captured[0].url).toBe(`${GATEWAY}/v1beta/models?key=${KEY}`);

    stubFetch(modelsResponse);
    expect(await provider.validateKey(KEY, GATEWAY, { metadata: { google_api_key_location: "header" } })).toBe(true);
    expect(captured[0].url).toBe(`${GATEWAY}/v1beta/models`);
    expect(captured[0].headers["x-goog-api-key"]).toBe(KEY);

    stubFetch(modelsResponse);
    expect(await provider.listModels(KEY, GATEWAY, { metadata: { google_api_key_location: "bearer" } })).toEqual(["gemini-2.5-flash"]);
    expect(captured[0].url).toBe(`${GATEWAY}/v1beta/models`);
    expect(captured[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });
});

describe("injectConnectionMetadataFlags google_api_key_location", () => {
  test("copies a normalized location for Google connections only", () => {
    const google: GenerationParameters = {};
    injectConnectionMetadataFlags({ provider: "google", metadata: { google_api_key_location: "bearer" } }, google);
    expect(google._google_api_key_location).toBe("bearer");

    const junk: GenerationParameters = {};
    injectConnectionMetadataFlags({ provider: "google", metadata: { google_api_key_location: "cookie" } }, junk);
    expect(junk._google_api_key_location).toBe("query");

    const unset: GenerationParameters = {};
    injectConnectionMetadataFlags({ provider: "google", metadata: {} }, unset);
    expect(unset).not.toHaveProperty("_google_api_key_location");

    const other: GenerationParameters = {};
    injectConnectionMetadataFlags({ provider: "openai", metadata: { google_api_key_location: "bearer" } }, other);
    expect(other).not.toHaveProperty("_google_api_key_location");
  });
});
