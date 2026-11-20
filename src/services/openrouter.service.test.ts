import { afterEach, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import * as connSvc from "./connections.service";
import * as secretsSvc from "./secrets.service";
import { clearOpenRouterMetadataCache } from "../llm/providers/openrouter";
import { openrouterRoutes } from "../routes/openrouter.routes";

const spies: { mockRestore(): void }[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); clearOpenRouterMetadataCache(); });
function spy<T extends object, K extends keyof T>(target: T, key: K) {
  const result = spyOn(target, key);
  spies.push(result);
  return result;
}
function connection(provider = "openrouter") {
  spy(connSvc, "getConnection").mockImplementation(((userId: string, id: string) => userId === "alice" && id === "saved"
    ? { id, provider, api_url: "https://proxy.test/v1" } : null) as any);
  return spy(secretsSvc, "getSecret").mockResolvedValue("placeholder");
}
function routes(userId = "alice") {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", userId); await next(); });
  app.route("/openrouter", openrouterRoutes);
  return app;
}

test("endpoint discovery uses the saved connection URL and exact upstream tags", async () => {
  connection();
  const fetchSpy = spy(globalThis, "fetch").mockResolvedValue(Response.json({ data: { endpoints: [{ provider_name: "OpenAI", tag: "openai/flex" }] } }));
  const response = await routes().request("/openrouter/endpoints/saved?model=openai%2Fgpt-5.4%3Afloor");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ endpoints: [{ name: "OpenAI", slug: "openai/flex" }] });
  expect(String(fetchSpy.mock.calls[0][0])).toBe("https://proxy.test/v1/models/openai/gpt-5.4/endpoints");
});

test("another user's connection cannot access cached endpoints or credentials", async () => {
  const secretSpy = connection();
  const fetchSpy = spy(globalThis, "fetch").mockResolvedValue(Response.json({ data: { endpoints: [] } }));
  expect((await routes().request("/openrouter/endpoints/saved?model=openai/gpt-5.4")).status).toBe(200);
  expect((await routes("bob").request("/openrouter/endpoints/saved?model=openai/gpt-5.4")).status).toBe(502);
  expect(secretSpy).toHaveBeenCalledTimes(1);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test("invalid models and non-OpenRouter connections do not contact upstream", async () => {
  const secretSpy = connection("openai");
  const fetchSpy = spy(globalThis, "fetch");
  const app = routes();
  for (const model of ["", "model", "../model", "vendor/..", "vendor/model/extra"]) {
    expect((await app.request(`/openrouter/endpoints/saved?model=${encodeURIComponent(model)}`)).status).toBe(400);
  }
  expect((await app.request("/openrouter/endpoints/saved?model=openai/gpt-5.4")).status).toBe(502);
  expect(secretSpy).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("upstream failure returns a retryable discovery error", async () => {
  connection();
  spy(globalThis, "fetch").mockResolvedValue(Response.json({ error: "Unavailable" }, { status: 503 }));
  const response = await routes().request("/openrouter/endpoints/saved?model=openai/gpt-5.4");
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "Failed to fetch model endpoints" });
});
