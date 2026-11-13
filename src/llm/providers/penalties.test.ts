import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { getProviderList } from "../registry";
import type { GenerationParameters, GenerationRequest } from "../types";
import { stopVertexTokenSweep } from "./google-vertex";

const penaltyKeys = ["frequency_penalty", "presence_penalty", "repetition_penalty"] as const;
const disabledPenaltyCases = [
  ...[0, null, undefined].map((value) => Object.fromEntries(penaltyKeys.map((key) => [key, value]))),
  { frequency_penalty: 0, presence_penalty: 0, repetition_penalty: 1 },
];

let vertexKey: string;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 1024,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["sign", "verify"]);
  vertexKey = JSON.stringify({
    type: "service_account",
    project_id: "test",
    client_email: "penalties@example.test",
    private_key: Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64"),
  });
});
afterAll(() => stopVertexTokenSweep());

for (const provider of getProviderList()) {
  const variants = provider.name === "google_vertex"
    ? ["gemini-2.5-flash", "claude-sonnet-4-6", "meta/llama-4-maverick"]
    : ["test-model"];
  if (provider.name === "openai") variants.push("responses");

  for (const variant of variants) {
    for (const stream of [false, true]) {
      test(`${provider.name} ${variant} ${stream ? "stream" : "JSON"}: omits disabled penalties from the dispatched body`, async () => {
        const sent: Record<string, unknown>[] = [];
        const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url, init) => {
          if (String(url).includes("oauth2.googleapis.com")) {
            return Response.json({ access_token: "test-vertex-token", expires_in: 3600 });
          }
          sent.push(JSON.parse(String(init?.body)));
          return Response.json({ error: { message: "intentional test failure" } }, { status: 400 });
        }) as typeof fetch);

        try {
          for (const disabledPenalties of disabledPenaltyCases) {
            const parameters: GenerationParameters = { ...disabledPenalties };
            if (variant === "responses") parameters.use_responses_api = true;
            const request: GenerationRequest = {
              model: variant === "responses" ? "test-model" : variant,
              messages: [{ role: "user", content: "Hello" }],
              parameters,
            };
            const key = provider.name === "google_vertex" ? vertexKey : "test-key";
            const url = provider.name === "google_vertex" ? "" : "https://example.test";
            const call = stream
              ? provider.generateStream(key, url, request).next()
              : provider.generate(key, url, request);
            await expect(call).rejects.toThrow("intentional test failure");

            expect(sent).toHaveLength(1);
            const body = sent.pop()!;
            for (const penalty of penaltyKeys) expect(body).not.toHaveProperty(penalty);
            for (const penalty of penaltyKeys) expect(parameters[penalty]).toBe(disabledPenalties[penalty]);
          }
        } finally {
          fetchSpy.mockRestore();
        }
      });
    }
  }
}

for (const provider of getProviderList().filter((entry) => ["openrouter", "nanogpt", "custom", "infermatic"].includes(entry.name))) {
  test(`${provider.name}: preserves active penalties and unrelated zero parameters`, () => {
    for (const penalties of [
      { repetition_penalty: 1.15, frequency_penalty: -0.5, presence_penalty: 0.25 },
      { repetition_penalty: 0.75, frequency_penalty: 1, presence_penalty: 1 },
    ]) {
      const parameters = { ...penalties, temperature: 0, top_k: 0, seed: 0 };
      const body = (provider as any).buildBody({
        model: "test-model",
        messages: [{ role: "user", content: "Hello" }],
        parameters: Object.freeze(parameters),
      }, false);

      expect(body).toMatchObject(parameters);
    }
  });
}
