import { afterEach, describe, expect, test } from "bun:test";
import {
  IllarinApiError,
  IllarinUnauthorizedError,
  IllarinUnavailableError,
  collectDeliveries,
  createBrowserAuthorization,
  createDeviceRequest,
  exchangeAuthorizationCode,
  fetchDeliveryArtifact,
  pollDeviceRequest,
  refreshTokens,
  syncLibrary,
  updateInstanceDeclaration,
  type IllarinFetch,
} from "./api";
import { buildDeclaration } from "./declaration";
import type { DevicePollResult, TokenPair } from "./types";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

interface MockServer {
  baseUrl: string;
  requests: CapturedRequest[];
  testFetch: IllarinFetch;
  stop: () => void;
}

/** Local stand-in for an Illarin host; injected as the fetch impl so the
 * SSRF guard does not block loopback in tests (production uses safeFetch). */
function startIllarinMock(
  handler: (request: CapturedRequest) => Response | Promise<Response>,
): MockServer {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text();
      const captured: CapturedRequest = {
        url: request.url,
        method: request.method,
        headers: request.headers,
        body,
      };
      requests.push(captured);
      return handler(captured);
    },
  });
  const testFetch = ((url: string, init?: RequestInit) => fetch(url, init)) as unknown as IllarinFetch;
  return {
    baseUrl: server.url.toString(),
    requests,
    testFetch,
    stop: () => server.stop(true),
  };
}

const TOKEN_PAIR: TokenPair = {
  accessToken: "ia1.test-access",
  accessTokenExpiresAt: "2026-08-22T18:30:00Z",
  refreshToken: "ir1.test-refresh",
  connectedApp: { id: "instance-1", permissions: ["work:receive", "library:sync"] },
};

const DECLARATION = buildDeclaration({ instanceName: "test box", scopes: ["work:receive"] });

describe("illarin api client", () => {
  const mocks: MockServer[] = [];
  function mock(handler: (request: CapturedRequest) => Response | Promise<Response>): MockServer {
    const instance = startIllarinMock(handler);
    mocks.push(instance);
    return instance;
  }
  afterEach(() => {
    while (mocks.length) mocks.pop()?.stop();
  });

  test("posts the exact browser authorization body and receives a user code", async () => {
    const illarin = mock(() => Response.json({ authorizationUrl: "https://illarin.com/connect/abc", userCode: "BCDF-2345", expiresAt: "2026-08-22T12:00:00Z" }));

    const response = await createBrowserAuthorization(`${illarin.baseUrl}/`, {
      ...DECLARATION,
      appVersion: "1.1.6",
      redirectUri: "http://127.0.0.1:49152/illarin/callback",
      state: "s".repeat(32),
      codeChallenge: "c".repeat(43),
      codeChallengeMethod: "S256",
    }, { fetchImpl: illarin.testFetch });

    expect(response.authorizationUrl).toContain("/connect/abc");
    expect(response.userCode).toBe("BCDF-2345");
    const sent = JSON.parse(illarin.requests[0].body!) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual([
      "acceptedFormats",
      "appName",
      "appVersion",
      "capabilities",
      "codeChallenge",
      "codeChallengeMethod",
      "name",
      "permissions",
      "protocolVersion",
      "redirectUri",
      "state",
    ]);
    expect(sent.codeChallengeMethod).toBe("S256");
    // Trailing slash on the base URL must not double up the path.
    expect(illarin.requests[0].url.endsWith("/api/v1/connect/authorizations")).toBe(true);
  });

  test("exchanges the callback code at /api/v1/connect/token", async () => {
    const illarin = mock(() => Response.json(TOKEN_PAIR));

    const pair = await exchangeAuthorizationCode(illarin.baseUrl, {
      authorizationCode: "one-use-code",
      codeVerifier: "v".repeat(43),
      redirectUri: "http://127.0.0.1:49152/illarin/callback",
    }, { fetchImpl: illarin.testFetch });

    expect(pair).toEqual(TOKEN_PAIR);
    const sent = JSON.parse(illarin.requests[0].body!) as Record<string, unknown>;
    expect(sent.authorizationCode).toBe("one-use-code");
    expect(sent.codeVerifier).toBe("v".repeat(43));
  });

  test("refreshes by posting the refresh token in the body, unauthenticated", async () => {
    const refreshed = { ...TOKEN_PAIR, accessToken: "ia1.next", refreshToken: "ir1.next" };
    const illarin = mock(() => Response.json(refreshed));

    const pair = await refreshTokens(illarin.baseUrl, "ir1.current", { fetchImpl: illarin.testFetch });

    expect(pair.accessToken).toBe("ia1.next");
    expect(illarin.requests[0].headers.get("authorization")).toBeNull();
    expect(JSON.parse(illarin.requests[0].body!)).toEqual({ refreshToken: "ir1.current" });
  });

  test("updates the declaration with a Bearer token and immutable fields only", async () => {
    const illarin = mock(() => Response.json({}, { status: 200 }));

    await updateInstanceDeclaration(illarin.baseUrl, "ia1.live", {
      appVersion: "1.2.0",
      protocolVersion: 1,
      capabilities: [...DECLARATION.capabilities],
      acceptedFormats: [...DECLARATION.acceptedFormats],
    }, { fetchImpl: illarin.testFetch });

    expect(illarin.requests[0].method).toBe("PUT");
    expect(illarin.requests[0].url.endsWith("/api/v1/connected-apps/me")).toBe(true);
    expect(illarin.requests[0].headers.get("authorization")).toBe("Bearer ia1.live");
    const sent = JSON.parse(illarin.requests[0].body!) as Record<string, unknown>;
    expect(sent).toEqual({ appVersion: "1.2.0", protocolVersion: 1, capabilities: DECLARATION.capabilities, acceptedFormats: DECLARATION.acceptedFormats });
    expect(Object.keys(sent)).not.toContain("applicationName");
    expect(Object.keys(sent)).not.toContain("instanceName");
    expect(Object.keys(sent)).not.toContain("scopes");
  });

  test("starts a device request and echoes the manual-code contract", async () => {
    const illarin = mock(() => Response.json({
      deviceCode: "private-device-code",
      userCode: "ABCD-1234",
      verificationUrl: "https://illarin.com/link",
      expiresAt: "2026-08-22T12:10:00Z",
      interval: 5,
    }));

    const request = await createDeviceRequest(illarin.baseUrl, DECLARATION, { fetchImpl: illarin.testFetch });

    expect(request.userCode).toBe("ABCD-1234");
    expect(request.interval).toBe(5);
    expect(illarin.requests[0].url.endsWith("/api/v1/connect/requests")).toBe(true);
    expect(JSON.parse(illarin.requests[0].body!)).toEqual(DECLARATION);
  });

  test("collects deliveries with required acknowledgements and maps 204 to an empty wait", async () => {
    const delivery = {
      id: "delivery-1",
      workId: "asset-1",
      versionNumber: 4,
      type: "character",
      name: "Aster",
      format: "chara_card_v3",
      label: "Character Card V3",
      queuedAt: "2026-08-23T18:30:00Z",
      leaseExpiresAt: "2026-08-23T18:45:00Z",
      files: [{ type: "export", url: "https://cdn.illarin.com/send/1" }],
    };
    const notice = { workId: "asset-2", name: "Quiet Toolbox", takenDownAt: "2026-09-14T06:00:00Z" };
    const illarin = mock(() => Response.json({ sends: [delivery], takedowns: [notice] }));

    expect(await collectDeliveries(illarin.baseUrl, "ia1.live", ["prior-delivery"], { fetchImpl: illarin.testFetch }))
      .toEqual({ sends: [delivery], takedowns: [notice] });
    expect(illarin.requests[0].url.endsWith("/api/v1/sends/collect")).toBe(true);
    expect(illarin.requests[0].headers.get("authorization")).toBe("Bearer ia1.live");
    expect(JSON.parse(illarin.requests[0].body!)).toEqual({ acknowledge: ["prior-delivery"] });

    const empty = mock(() => new Response(null, { status: 204 }));
    expect(await collectDeliveries(empty.baseUrl, "ia1.live", [], { fetchImpl: empty.testFetch }))
      .toEqual({ sends: [], takedowns: [] });
    expect(JSON.parse(empty.requests[0].body!)).toEqual({ acknowledge: [] });
  });

  test("allows Illarin's full delivery wait to finish", async () => {
    const longPoll: IllarinFetch = async (_url, options) => {
      expect(options?.timeoutMs).toBeGreaterThan(30_000);
      return new Response(null, { status: 204 });
    };

    expect(await collectDeliveries("http://127.0.0.1", "ia1.live", [], { fetchImpl: longPoll }))
      .toEqual({ sends: [], takedowns: [] });
  });

  test("fetches signed delivery artifacts without forwarding a bearer token", async () => {
    const artifact = mock(() => new Response("card bytes", { status: 200 }));
    const response = await fetchDeliveryArtifact(`${artifact.baseUrl}/signed-card`, { fetchImpl: artifact.testFetch });

    expect(await response.text()).toBe("card bytes");
    expect(artifact.requests[0].method).toBe("GET");
    expect(artifact.requests[0].headers.get("authorization")).toBeNull();
  });

  test("preserves Retry-After when Illarin has no delivery wait capacity", async () => {
    const illarin = mock(() => new Response(null, {
      status: 503,
      headers: { "Retry-After": "17" },
    }));

    try {
      await collectDeliveries(illarin.baseUrl, "ia1.live", [], { fetchImpl: illarin.testFetch });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(IllarinUnavailableError);
      expect((err as IllarinUnavailableError).retryAfterSeconds).toBe(17);
    }
  });

  test("syncs library reports and enforces snapshot and size bounds", async () => {
    const illarin = mock(() => Response.json({ accepted: 1, removed: 0, ignored: 0 }));
    const result = await syncLibrary(illarin.baseUrl, "ia1.live", {
      snapshot: false,
      appVersion: "1.2.0",
      entries: [{ workId: "asset-1", versionNumber: 4 }],
      removed: [],
    }, { fetchImpl: illarin.testFetch });

    expect(result).toEqual({ accepted: 1, removed: 0, ignored: 0, takedowns: [] });
    expect(illarin.requests[0].url.endsWith("/api/v1/library/sync")).toBe(true);
    expect(illarin.requests[0].headers.get("authorization")).toBe("Bearer ia1.live");
    expect(JSON.parse(illarin.requests[0].body!)).toEqual({
      snapshot: false,
      appVersion: "1.2.0",
      entries: [{ workId: "asset-1", versionNumber: 4 }],
      removed: [],
    });
    await expect(syncLibrary(illarin.baseUrl, "ia1.live", {
      snapshot: true,
      appVersion: "1.2.0",
      entries: [],
      removed: ["asset-1"],
    }, { fetchImpl: illarin.testFetch })).rejects.toThrow(/snapshot cannot include removals/);

    await syncLibrary(illarin.baseUrl, "ia1.live", {
      snapshot: true,
      appVersion: "1.2.0",
      entries: [{ workId: "legacy-work" }],
    }, { fetchImpl: illarin.testFetch });
    expect(JSON.parse(illarin.requests[1].body!)).toEqual({
      snapshot: true,
      appVersion: "1.2.0",
      entries: [{ workId: "legacy-work" }],
    });
  });

  test("maps every documented poll outcome", async () => {
    const outcomes: Array<{ respond: () => Response; expected: DevicePollResult }> = [
      { respond: () => Response.json({ status: "pending" }), expected: { kind: "pending" } },
      {
        respond: () => Response.json({ status: "connected", ...TOKEN_PAIR }),
        expected: { kind: "linked", tokens: TOKEN_PAIR },
      },
      { respond: () => Response.json({ error: "access_denied" }, { status: 400 }), expected: { kind: "denied" } },
      { respond: () => Response.json({ error: "expired_token" }, { status: 400 }), expected: { kind: "expired" } },
      { respond: () => new Response(null, { status: 404 }), expected: { kind: "unknown_code" } },
      {
        respond: () => Response.json({ error: "slow_down" }, { status: 429, headers: { "Retry-After": "9" } }),
        expected: { kind: "slow_down", retryAfterSeconds: 9 },
      },
      {
        respond: () => Response.json({}, { status: 429 }),
        expected: { kind: "rate_limited", retryAfterSeconds: null },
      },
    ];

    for (const outcome of outcomes) {
      const illarin = mock(outcome.respond);
      const result = await pollDeviceRequest(illarin.baseUrl, "device-code", { fetchImpl: illarin.testFetch });
      expect(result).toEqual(outcome.expected);
      illarin.stop();
    }
  });

  test("refuses an unknown poll state rather than waiting forever", async () => {
    const illarin = mock(() => Response.json({ status: "something_else" }));
    await expect(pollDeviceRequest(illarin.baseUrl, "device-code", { fetchImpl: illarin.testFetch }))
      .rejects.toThrow(/unknown connection status/);
  });

  test("surfaces terminal 401 as IllarinUnauthorizedError", async () => {
    const illarin = mock(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    await expect(
      refreshTokens(illarin.baseUrl, "ir1.dead", { fetchImpl: illarin.testFetch }),
    ).rejects.toThrow(IllarinUnauthorizedError);
  });

  test("error messages carry endpoint and status — never server body content", async () => {
    const illarin = mock(() => Response.json({ error: "leaked ir1.secret-token" }, { status: 500 }));

    try {
      await exchangeAuthorizationCode(illarin.baseUrl, {
        authorizationCode: "code",
        codeVerifier: "v".repeat(43),
        redirectUri: "http://127.0.0.1:49152/illarin/callback",
      }, { fetchImpl: illarin.testFetch });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(IllarinApiError);
      expect((err as IllarinApiError).message).toContain("/api/v1/connect/token");
      expect((err as IllarinApiError).message).toContain("500");
      expect((err as IllarinApiError).message).not.toContain("ir1.secret-token");
    }
  });

  test("rejects malformed token payloads", async () => {
    const illarin = mock(() => Response.json({ accessToken: "ia1.only" }));
    await expect(
      exchangeAuthorizationCode(illarin.baseUrl, {
        authorizationCode: "code",
        codeVerifier: "v".repeat(43),
        redirectUri: "http://127.0.0.1:49152/illarin/callback",
      }, { fetchImpl: illarin.testFetch }),
    ).rejects.toThrow(/malformed/);
  });

  test("rejects browser authorization without the manual matching code", async () => {
    const illarin = mock(() => Response.json({ authorizationUrl: "https://illarin.com/connect/one-use", expiresAt: "2026-08-22T12:00:00Z" }));
    await expect(createBrowserAuthorization(illarin.baseUrl, {
      ...DECLARATION,
      redirectUri: "http://127.0.0.1:49152/illarin/callback",
      state: "s".repeat(32),
      codeChallenge: "c".repeat(43),
      codeChallengeMethod: "S256",
    }, { fetchImpl: illarin.testFetch })).rejects.toThrow(/malformed authorization/);
  });

  test("normalizes base URLs and requires HTTPS outside injected test transports", async () => {
    const illarin = mock(() => Response.json({ authorizationUrl: "u", userCode: "CODE", expiresAt: "e" }));
    await createBrowserAuthorization(`${illarin.baseUrl}///`, {
      ...DECLARATION,
      appVersion: "1.1.6",
      redirectUri: "http://127.0.0.1:9/x",
      state: "s".repeat(32),
      codeChallenge: "c".repeat(43),
      codeChallengeMethod: "S256",
    }, { fetchImpl: illarin.testFetch });
    expect(illarin.requests.length).toBe(1);
    expect(illarin.requests[0].url.includes("/api/v1/connect/authorizations")).toBe(true);

    await expect(
      createBrowserAuthorization("ftp://illarin.com", { ...DECLARATION, redirectUri: "", state: "", codeChallenge: "", codeChallengeMethod: "S256" }),
    ).rejects.toThrow(/use https/);
    await expect(
      createBrowserAuthorization("http://illarin.com", { ...DECLARATION, redirectUri: "", state: "", codeChallenge: "", codeChallengeMethod: "S256" }),
    ).rejects.toThrow(/use https/);
  });

});
