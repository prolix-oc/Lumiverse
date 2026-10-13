import { afterEach, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import * as connSvc from "./connections.service";
import * as secretsSvc from "./secrets.service";
import { discoverModelProviders, fetchAccountUsage, fetchPaygoBalance, fetchPaygoUsage, resolveNanoGptApiEndpoint } from "./nanogpt.service";
import { nanogptRoutes } from "../routes/nanogpt.routes";

const spies: { mockRestore(): void }[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
function spy<T extends object, K extends keyof T>(target: T, key: K) {
  const result = spyOn(target, key);
  spies.push(result);
  return result;
}
function mockConnection(provider = "nanogpt") {
  spy(connSvc, "getConnection").mockImplementation(((userId: string, id: string) => userId === "alice" && id === "connection" ? { id, provider, api_url: "https://proxy.example/api/subscription/v1" } : null) as any);
  spy(secretsSvc, "getSecret").mockResolvedValue("placeholder");
}

test("account and discovery paths retain the configured host and remove the inference prefix", () => {
  expect(resolveNanoGptApiEndpoint("https://api.nano-gpt.com/api/subscription/v1?ignored=yes#fragment", "/api/models/moonshotai%2Fkimi-k2.6/providers").toString()).toBe("https://api.nano-gpt.com/api/models/moonshotai%2Fkimi-k2.6/providers");
  expect(resolveNanoGptApiEndpoint(undefined, "/api/check-balance").toString()).toBe("https://nano-gpt.com/api/check-balance");
});

test("provider discovery encodes IDs once and preserves public prices and availability", async () => {
  mockConnection();
  const fetchSpy = spy(globalThis, "fetch").mockResolvedValue(Response.json({ canonicalId: "moonshotai/kimi-k2.6", displayName: "Kimi", supportsProviderSelection: true, defaultPrice: { inputPer1kTokens: 0.0005 }, providers: [
    { provider: "novita", available: true, pricing: { inputPer1kTokens: 0.001 }, effectivePricing: { effective_price: { inputPer1kTokens: 0.0008 } }, quantization: "fp8" },
    { provider: "moonshot", available: false },
  ] }));
  const result = await discoverModelProviders("alice", { connection_id: "connection", model: "moonshotai/kimi-k2.6" });
  expect(String(fetchSpy.mock.calls[0][0])).toBe("https://proxy.example/api/models/moonshotai%2Fkimi-k2.6/providers");
  expect(fetchSpy.mock.calls[0][1]?.headers).toHaveProperty("Authorization");
  expect(fetchSpy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  expect(result.providers.map((p) => [p.provider, p.available])).toEqual([["novita", true], ["moonshot", false]]);
  expect(result.providers[0].effectivePricing?.effective_price?.inputPer1kTokens).toBe(0.0008);
});

test("provider discovery accepts a new unsaved connection and reports unsupported models", async () => {
  const fetchSpy = spy(globalThis, "fetch").mockResolvedValue(Response.json({ supportsProviderSelection: false, providers: [] }));
  expect((await discoverModelProviders("alice", { model: "closed-model", api_key: "placeholder" })).supportsProviderSelection).toBe(false);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test("balance uses the documented POST endpoint and parses string balances", async () => {
  const fetchSpy = spy(globalThis, "fetch").mockResolvedValue(Response.json({ usd_balance: "12.1234", nano_balance: "0.5", nanoDepositAddress: "private-account-address" }));
  expect(await fetchPaygoBalance("placeholder")).toEqual({ usd_balance: 12.1234, nano_balance: 0.5 });
  expect(String(fetchSpy.mock.calls[0][0])).toBe("https://nano-gpt.com/api/check-balance");
  expect(fetchSpy.mock.calls[0][1]?.method).toBe("POST");
  expect(fetchSpy.mock.calls[0][1]?.headers).toHaveProperty("x-api-key");
});

test("spend uses UTC month boundaries and net totals after refunds", async () => {
  const fetchSpy = spy(globalThis, "fetch").mockResolvedValue(Response.json({ asOf: "2026-10-01T00:30:00Z", totals: { costUsd: 10, refundedUsd: 2, netCostUsd: 8, requests: 3, inputTokens: 40, outputTokens: 20 }, byDay: [{ date: "2026-10-01", netCostUsd: 1.25 }] }));
  const usage = await fetchPaygoUsage("placeholder", "https://proxy.example/api/subscription/v1", new Date("2026-09-30T20:30:00-04:00"));
  const url = new URL(String(fetchSpy.mock.calls[0][0]));
  expect(url.pathname).toBe("/api/v1/usage");
  expect(Object.fromEntries(url.searchParams)).toEqual({ from: "2026-10-01", to: "2026-10-01", group_by: "day", scope: "current_key" });
  expect(usage).toMatchObject({ usage_daily: 1.25, usage_monthly: 8, requests: 3, inputTokens: 40, outputTokens: 20 });
});

test("a day with no usage is zero while malformed totals remain unavailable", async () => {
  const fetchSpy = spy(globalThis, "fetch").mockResolvedValueOnce(Response.json({ totals: { netCostUsd: 3 }, byDay: [] })).mockResolvedValueOnce(Response.json({ totals: {}, byDay: [] }));
  expect((await fetchPaygoUsage("placeholder")).usage_daily).toBe(0);
  await expect(fetchPaygoUsage("placeholder")).rejects.toThrow("invalid usage totals");
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

test("an unavailable subscription and failed spend endpoint do not hide a PAYG balance", async () => {
  mockConnection();
  spy(connSvc, "fetchNanoGptSubscriptionUsage").mockResolvedValue(null);
  spy(globalThis, "fetch").mockImplementation((async (url) => String(url).includes("check-balance")
    ? Response.json({ usd_balance: "5", nano_balance: "0" })
    : Response.json({ error: { message: "Usage is not ready", type: "usage_not_ready" } }, { status: 503 })) as typeof fetch);
  const result = await fetchAccountUsage("alice", "connection");
  expect(result.balance?.usd_balance).toBe(5);
  expect(result.paygo).toBeNull();
  expect(result.subscription).toBeNull();
  expect(result.errors.paygo).toContain("Usage is not ready");
});

function routes(userId = "alice") {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("userId", userId); await next(); });
  app.route("/nanogpt", nanogptRoutes);
  return app;
}

test("routes reject another user's connection before accessing credentials or upstream", async () => {
  mockConnection();
  const fetchSpy = spy(globalThis, "fetch");
  const app = routes("bob");
  expect((await app.request("/nanogpt/account?connection_id=connection")).status).toBe(404);
  expect((await app.request("/nanogpt/providers/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connection_id: "connection", model: "model", api_key: "placeholder" }) })).status).toBe(404);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("routes validate required inputs and NanoGPT profile type", async () => {
  mockConnection("openrouter");
  const fetchSpy = spy(globalThis, "fetch");
  const app = routes();
  expect((await app.request("/nanogpt/account")).status).toBe(400);
  expect((await app.request("/nanogpt/account?connection_id=connection")).status).toBe(400);
  for (const input of [{}, { model: " " }, { model: "model", api_key: 123 }, { model: "model", connection_id: "connection" }]) {
    expect((await app.request("/nanogpt/providers/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })).status).toBe(400);
  }
  expect(fetchSpy).not.toHaveBeenCalled();
});
