import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { buildDeclaration } from "./declaration";
import { runBrowserLink, type BrowserLinkOutcome } from "./link-browser";
import type { IllarinFetch } from "./api";
import type { TokenPair } from "./types";

const TOKEN_PAIR: TokenPair = {
  accessToken: "ia1.access",
  accessTokenExpiresAt: "2026-08-22T18:30:00Z",
  refreshToken: "ir1.refresh",
  connectedApp: { id: "inst-1", permissions: ["work:receive"] },
};

interface MockIllarin {
  baseUrl: string;
  authBody: Promise<string>;
  tokenCalls: () => number;
  tokenBody: Promise<string>;
  testFetch: IllarinFetch;
  stop: () => void;
}

/** Local Illarin stand-in capturing the wire requests this flow must make. */
function startMockIllarin(tokenResponse: () => Response = () => Response.json(TOKEN_PAIR)): MockIllarin {
  let tokenCallCount = 0;
  const authCapture = Promise.withResolvers<string>();
  const tokenCapture = Promise.withResolvers<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/v1/connect/authorizations") {
        authCapture.resolve(await request.text());
        return Response.json({ authorizationUrl: "https://auth.test/authorize?req=one-use", userCode: "BCDF-2345", expiresAt: "2026-08-22T12:05:00Z" });
      }
      if (path === "/api/v1/connect/token") {
        tokenCallCount++;
        tokenCapture.resolve(await request.text());
        return tokenResponse();
      }
      return new Response("not found", { status: 404 });
    },
  });
  const testFetch = ((url: string, init?: RequestInit) => fetch(url, init)) as unknown as IllarinFetch;
  return {
    baseUrl: server.url.toString(),
    authBody: authCapture.promise,
    tokenCalls: () => tokenCallCount,
    tokenBody: tokenCapture.promise,
    testFetch,
    stop: () => server.stop(true),
  };
}

describe("illarin loopback browser link", () => {
  const mocks: MockIllarin[] = [];
  function mock(tokenResponse?: () => Response): MockIllarin {
    const instance = startMockIllarin(tokenResponse);
    mocks.push(instance);
    return instance;
  }
  afterEach(() => {
    while (mocks.length) mocks.pop()?.stop();
  });

  interface Driven {
    outcome: Promise<BrowserLinkOutcome>;
    redirectUri: Promise<string>;
    state: Promise<string>;
    authorization: Promise<{ authorizationUrl: string; userCode: string }>;
    illarin: MockIllarin;
  }

  function drive(overrides?: { timeoutMs?: number; tokenResponse?: () => Response }): Driven {
    const illarin = mock(overrides?.tokenResponse);
    const redirectCapture = Promise.withResolvers<string>();
    const authorizationCapture = Promise.withResolvers<{ authorizationUrl: string; userCode: string }>();
    const declaration = buildDeclaration({ instanceName: "test box", scopes: ["work:receive"] });
    const outcome = runBrowserLink({
      baseUrl: illarin.baseUrl,
      declaration,
      fetchImpl: illarin.testFetch,
      openAuthorization: authorizationCapture.resolve,
      onListening: redirectCapture.resolve,
      timeoutMs: overrides?.timeoutMs,
    });
    return {
      outcome,
      redirectUri: redirectCapture.promise,
      authorization: authorizationCapture.promise,
      state: illarin.authBody.then((body) => (JSON.parse(body) as { state: string }).state),
      illarin,
    };
  }

  test("links end-to-end: literal loopback redirect, S256 challenge, one exchange", async () => {
    const driven = drive();
    expect(await driven.authorization).toEqual({
      authorizationUrl: "https://auth.test/authorize?req=one-use",
      userCode: "BCDF-2345",
    });
    const redirectUri = await driven.redirectUri;
    // Byte-for-byte literal loopback form — no localhost, no query, no fragment.
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/illarin\/callback$/);

    const authRequest = JSON.parse(await driven.illarin.authBody) as {
      redirectUri: string;
      state: string;
      codeChallenge: string;
      codeChallengeMethod: string;
    };
    expect(authRequest.redirectUri).toBe(redirectUri);
    expect(authRequest.state.length).toBeGreaterThanOrEqual(32);
    expect(authRequest.codeChallengeMethod).toBe("S256");

    const response = await fetch(`${redirectUri}?code=one-use-code&state=${encodeURIComponent(authRequest.state)}`);
    expect(response.status).toBe(200);

    const outcome = await driven.outcome;
    expect(outcome).toEqual({ kind: "linked", tokens: TOKEN_PAIR });

    // The verifier sent back must hash to the challenge from step one.
    const exchange = JSON.parse(await driven.illarin.tokenBody) as {
      authorizationCode: string;
      codeVerifier: string;
      redirectUri: string;
    };
    expect(exchange.authorizationCode).toBe("one-use-code");
    expect(exchange.redirectUri).toBe(redirectUri);
    const digest = createHash("sha256").update(exchange.codeVerifier, "ascii").digest("base64url");
    expect(digest).toBe(authRequest.codeChallenge);
    expect(driven.illarin.tokenCalls()).toBe(1);

    // First terminal callback stops the listener — a replay finds it closed.
    await expect(fetch(`${redirectUri}?code=replay&state=${authRequest.state}`)).rejects.toThrow();
  });

  test("rejects a wrong state without attempting an exchange", async () => {
    const driven = drive();
    const redirectUri = await driven.redirectUri;
    await driven.state; // ensure the authorization was created

    await fetch(`${redirectUri}?code=stolen&state=${"a".repeat(32)}`);
    const outcome = await driven.outcome;

    expect(outcome).toEqual({ kind: "invalid_callback", reason: "state mismatch" });
    expect(driven.illarin.tokenCalls()).toBe(0);
  });

  test("rejects a callback with a missing code", async () => {
    const driven = drive();
    const redirectUri = await driven.redirectUri;
    const state = await driven.state;

    await fetch(`${redirectUri}?state=${state}`);
    expect(await driven.outcome).toEqual({ kind: "invalid_callback", reason: "missing code" });
    expect(driven.illarin.tokenCalls()).toBe(0);
  });

  test("rejects duplicated parameters", async () => {
    const driven = drive();
    const redirectUri = await driven.redirectUri;
    const state = await driven.state;

    await fetch(`${redirectUri}?code=a&code=b&state=${state}`);
    expect(await driven.outcome).toEqual({ kind: "invalid_callback", reason: 'repeated parameter "code"' });
  });

  test("rejects unexpected parameters", async () => {
    const driven = drive();
    const redirectUri = await driven.redirectUri;
    const state = await driven.state;

    await fetch(`${redirectUri}?code=a&state=${state}&extra=1`);
    expect(await driven.outcome).toEqual({ kind: "invalid_callback", reason: 'unexpected parameter "extra"' });
  });

  test("rejects non-GET callbacks and mixed code/error callbacks", async () => {
    const wrongMethod = drive();
    const wrongMethodUri = await wrongMethod.redirectUri;
    const wrongMethodState = await wrongMethod.state;
    await fetch(`${wrongMethodUri}?code=a&state=${wrongMethodState}`, { method: "POST" });
    expect(await wrongMethod.outcome).toEqual({ kind: "invalid_callback", reason: "wrong method" });

    const mixed = drive();
    const mixedUri = await mixed.redirectUri;
    const mixedState = await mixed.state;
    await fetch(`${mixedUri}?code=a&error=access_denied&state=${mixedState}`);
    expect(await mixed.outcome).toEqual({ kind: "invalid_callback", reason: "code and error cannot both be present" });
  });

  test("reports an owner denial", async () => {
    const driven = drive();
    const redirectUri = await driven.redirectUri;
    const state = await driven.state;

    await fetch(`${redirectUri}?error=access_denied&state=${state}`);
    expect(await driven.outcome).toEqual({ kind: "denied" });
    expect(driven.illarin.tokenCalls()).toBe(0);
  });

  test("times out when no callback arrives", async () => {
    const driven = drive({ timeoutMs: 60 });
    await driven.redirectUri;
    expect(await driven.outcome).toEqual({ kind: "timeout" });
    expect(driven.illarin.tokenCalls()).toBe(0);
  });
});
