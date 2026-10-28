import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ObscurifyProvider } from "./obscurify";
import { getProvider } from "../registry";
import type { GenerationRequest } from "../types";

const provider = new ObscurifyProvider();
const sent: { url: string; init?: RequestInit; body?: any }[] = [];
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => { fetchSpy?.mockRestore(); sent.length = 0; });

function mockFetch(respond: (url: string, body: any) => Response) {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ url: String(url), init, body });
    return respond(String(url), body);
  }) as typeof fetch);
}

describe("Obscurify.ai provider", () => {
  test("is registered under its canonical id", () => {
    expect(getProvider("obscurify")).toBeInstanceOf(ObscurifyProvider);
    expect(provider.defaultUrl).toBe("https://obscurify.ai/v1");
    expect(provider.capabilities.apiKeyRequired).toBe(true);
    expect(provider.capabilities.modelListStyle).toBe("openai");
  });

  for (const stream of [false, true]) {
    test(`${stream ? "streaming" : "JSON"} chat goes to /v1/chat/completions with a bearer key`, async () => {
      mockFetch((_url, body) => body.stream
        ? new Response('data: {"choices":[{"delta":{"content":"pong"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } })
        : Response.json({ choices: [{ message: { content: "pong" }, finish_reason: "stop" }] }));
      const request: GenerationRequest = { model: "z-ai/glm-5.3", messages: [{ role: "user", content: "ping" }], parameters: { temperature: 0.5, max_tokens: 64 } };
      let text = "";
      if (stream) { for await (const chunk of provider.generateStream("sk-obs1_test", "", request)) text += chunk.token; }
      else text = (await provider.generate("sk-obs1_test", "", request)).content;
      expect(text).toBe("pong");
      expect(sent[0].url).toBe("https://obscurify.ai/v1/chat/completions");
      expect((sent[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-obs1_test");
      expect(sent[0].body).toMatchObject({ model: "z-ai/glm-5.3", temperature: 0.5, max_tokens: 64, stream });
    });
  }

  test("lists models from the public /v1/models", async () => {
    mockFetch(() => Response.json({ object: "list", data: [{ id: "z-ai/glm-5.3" }, { id: "deepseek/deepseek-v4-flash" }] }));
    expect(await provider.listModels("", "")).toEqual(["deepseek/deepseek-v4-flash", "z-ai/glm-5.3"]);
    expect(sent[0].url).toBe("https://obscurify.ai/v1/models");
  });

  // A good key passes auth and only the empty probe body is rejected
  // (production answers 404 model_not_found for `model: ""`).
  for (const status of [400, 404, 422]) {
    test(`key validation accepts a ${status} for the empty probe and does not use the public model list`, async () => {
      mockFetch(() => Response.json({ error: { code: "model_not_found", message: "The model  does not exist." } }, { status }));
      expect(await provider.validateKey("sk-obs1_good", "")).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0].url).toBe("https://obscurify.ai/v1/chat/completions");
      expect(sent[0].init?.method).toBe("POST");
      expect((sent[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-obs1_good");
      expect(sent[0].body).toEqual({ model: "", messages: [] });
    });
  }

  for (const [status, message] of [[401, "Invalid token."], [403, "Forbidden"], [402, "Insufficient balance"], [429, "Rate limited"], [503, "Upstream unavailable"]] as const) {
    test(`key validation rejects a ${status} with the provider's message`, async () => {
      mockFetch(() => Response.json({ error: { message } }, { status }));
      await expect(provider.validateKey("sk-obs1_key", "")).rejects.toThrow(message);
    });
  }
});
