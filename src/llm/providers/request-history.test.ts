import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { getProviderList } from "../registry";
import { stopVertexTokenSweep } from "./google-vertex";
import { RequestHistoryStore } from "../../services/request-history-store";
import type { GenerationRequest } from "../types";

let vertexKey: string;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  vertexKey = JSON.stringify({ type: "service_account", project_id: "test", client_email: "capture@example.test", private_key: Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64") });
});
afterAll(() => stopVertexTokenSweep());

for (const provider of getProviderList()) {
  const variants = provider.name === "google_vertex" ? ["gemini-2.5-flash", "claude-sonnet-4-6", "meta/llama-4-maverick"] : ["test-model"];
  if (provider.name === "openai") variants.push("responses");
  for (const variant of variants) {
    for (const stream of [false, true]) {
      test(`${provider.name} ${variant} ${stream ? "stream" : "JSON"}: captures the finalized dispatch body`, async () => {
        const store = new RequestHistoryStore();
        const sent: string[] = [];
        const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url, init) => {
          if (String(url).includes("oauth2.googleapis.com")) return Response.json({ access_token: "vertex-access-credential", expires_in: 3600 });
          sent.push(String(init?.body));
          return Response.json({ error: { message: "intentional test failure" }, api_key: "response-only-credential" }, { status: 400 });
        }) as typeof fetch);
        const request: GenerationRequest = {
          model: variant === "responses" ? "test-model" : variant,
          messages: [{ role: "system", content: "System prompt" }, { role: "user", content: "Hello" }],
          parameters: { max_tokens: 50, ...(variant === "responses" ? { use_responses_api: true } : {}), ...(provider.name === "openrouter" ? { _openrouter: { provider_routing: { order: ["Example"] } } } : {}) },
          onProviderRequest: (snapshot) => {
            const id = store.record("alice", { origin: { kind: "chat", name: "Chat" } }, snapshot)!;
            return {
              isActive: () => store.has("alice", id),
              headers: (status) => store.responseHeaders("alice", id, status),
              complete: (response) => store.completeResponse("alice", id, response, snapshot.credentials),
            };
          },
        };
        try {
          const key = provider.name === "google_vertex" ? vertexKey : "provider-credential-test";
          if (stream) await provider.generateStream(key, provider.name === "google_vertex" ? "" : "https://example.test", request).next().catch(() => {});
          else await provider.generate(key, provider.name === "google_vertex" ? "" : "https://example.test", request).catch(() => {});
          expect(sent).toHaveLength(1);
          const rows = store.list("alice");
          expect(rows).toHaveLength(1);
          const entry = store.get("alice", rows[0].id)!;
          expect(JSON.parse(entry.bodyJson!)).toEqual(JSON.parse(sent[0]));
          expect(entry.provider).toBe(provider.name);
          expect(entry.response).toMatchObject({ status: 400, state: "failed", format: "json", redacted: true });
          expect(JSON.parse(entry.responseBody!)).toEqual({ error: { message: "intentional test failure" }, api_key: "[REDACTED]" });
          expect(sent[0]).not.toContain("onProviderRequest");
          expect(JSON.stringify(entry)).not.toContain("credential");
          expect(JSON.stringify(entry)).not.toContain("https://");
        } finally { fetchSpy.mockRestore(); }
      });
    }
  }
}
