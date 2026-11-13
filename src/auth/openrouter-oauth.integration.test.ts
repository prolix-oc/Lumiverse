import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const dataDir = mkdtempSync(join(tmpdir(), "lumiverse-openrouter-oauth-"));
process.env.DATA_DIR = dataDir;
process.env.TRUSTED_ORIGINS = "https://app.example.test";
delete process.env.AUTH_BASE_URL;

const { initIdentity } = await import("../crypto/init");
const { initDatabase, closeDatabase } = await import("../db/connection");
const { runMigrations } = await import("../db/migrate");
await initIdentity();
await runMigrations(initDatabase(":memory:"));
const { auth } = await import("./index");
await auth.$context;
const { default: app } = await import("../app");
const { initiateOAuthAsync } = await import("../services/openrouter.service");

afterAll(() => {
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

async function landingMessage(callbackUrl: URL) {
  const response = await app.request(callbackUrl.toString(), { headers: { host: callbackUrl.host } });
  expect(response.status).toBe(200);
  const dom = new JSDOM(await response.text(), { url: callbackUrl.toString() });
  const messages: Array<{ data: unknown; origin: string }> = [];
  Object.defineProperty(dom.window, "opener", { value: {
    postMessage: (data: unknown, origin: string) => messages.push({ data, origin }),
  } });
  const runLandingScript = new Function("window", "document", "setTimeout", dom.window.document.querySelector("script")!.textContent!);
  runLandingScript(dom.window, dom.window.document, () => 0);
  dom.window.close();
  return messages;
}

describe("OpenRouter OAuth state round trip", () => {
  test("returns the session token to the opener alongside the authorization code", async () => {
    const result = await initiateOAuthAsync(
      "https://app.example.test/api/v1/openrouter/oauth-landing?opener_origin=https%3A%2F%2Fapp.example.test&state=old-state",
      { connectionName: "OpenRouter" },
    );
    const authorizationUrl = new URL(result.auth_url);
    const callback = new URL(authorizationUrl.searchParams.get("callback_url")!);
    expect(callback.searchParams.get("state")).toBe(result.session_token);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    callback.searchParams.set("code", "valid-authorization-code");
    expect(await landingMessage(callback)).toEqual([{
      data: { type: "openrouter_oauth_code", code: "valid-authorization-code", state: result.session_token },
      origin: "https://app.example.test",
    }]);
  });

  test("does not relay callbacks with missing or unsafe state", async () => {
    for (const state of [null, '</script><script>alert(1)</script>']) {
      const callback = new URL("https://app.example.test/api/v1/openrouter/oauth-landing?code=valid-code");
      if (state !== null) callback.searchParams.set("state", state);
      expect(await landingMessage(callback)).toEqual([]);
    }
  });
});
