import { describe, expect, test } from "bun:test";
import { DeviceLinkSession, runDeviceLinkUntilTerminal } from "./link-device";
import type { IllarinFetch } from "./api";
import type { DeviceRequestResponse, TokenPair } from "./types";

const BASE_URL = "https://illarin.com";
const TOKENS: TokenPair = {
  accessToken: "ia1.a",
  accessTokenExpiresAt: "2026-08-22T18:30:00Z",
  refreshToken: "ir1.a",
  connectedApp: { id: "inst-1", permissions: ["work:receive"] },
};

function deviceRequest(interval: number): DeviceRequestResponse {
  return {
    deviceCode: "private-dc",
    userCode: "ABCD-1234",
    verificationUrl: `${BASE_URL}/link`,
    expiresAt: new Date(1_000_000 + 10 * 60_000).toISOString(),
    interval,
  };
}

interface Harness {
  session: DeviceLinkSession;
  calls: () => number;
  advance: (ms: number) => void;
  linked: TokenPair[];
}

/** Scripted /api/v1/link/poll responses; an empty queue behaves like a network failure. */
function makeSession(
  responses: Array<() => Response>,
  options?: { interval?: number },
): Harness {
  const clock = { value: 1_000_000 };
  let calls = 0;
  const linked: TokenPair[] = [];
  const fetch = ((_url: string) => {
    const next = responses.shift();
    calls++;
    if (!next) throw new TypeError("connection reset");
    return next();
  }) as unknown as IllarinFetch;
  const session = new DeviceLinkSession(deviceRequest(options?.interval ?? 5), BASE_URL, {
    fetchImpl: fetch,
    now: () => clock.value,
    onLinked: (tokens) => {
      linked.push(tokens);
    },
  });
  return {
    session,
    calls: () => calls,
    advance: (ms: number) => {
      clock.value += ms;
    },
    linked,
  };
}

describe("illarin device link state machine", () => {
  test("does not poll before the interval elapses", async () => {
    const harness = makeSession([]);

    const result = await harness.session.pollIfDue();

    expect(result).toEqual({ status: "pending", retryInMs: 5_000 });
    expect(harness.calls()).toBe(0);
  });

  test("polls when due and schedules the configured interval", async () => {
    const harness = makeSession([() => Response.json({ status: "pending" })]);
    harness.advance(5_000);

    const result = await harness.session.pollIfDue();

    expect(result).toEqual({ status: "pending", retryInMs: 5_000 });
    expect(harness.calls()).toBe(1);
  });

  test("reports a link and persists through onLinked", async () => {
    const harness = makeSession([() => Response.json({ status: "connected", ...TOKENS })]);
    harness.advance(5_000);

    const result = await harness.session.pollIfDue();

    expect(result.status).toBe("linked");
    expect(harness.linked).toEqual([TOKENS]);
  });

  test("maps denial, expiry, and unknown codes to terminal states", async () => {
    const denied = makeSession([() => Response.json({ error: "access_denied" }, { status: 400 })]);
    denied.advance(5_000);
    expect((await denied.session.pollIfDue()).status).toBe("denied");

    const expired = makeSession([() => Response.json({ error: "expired_token" }, { status: 400 })]);
    expired.advance(5_000);
    expect((await expired.session.pollIfDue()).status).toBe("expired");

    const unknownCode = makeSession([() => new Response(null, { status: 404 })]);
    unknownCode.advance(5_000);
    expect((await unknownCode.session.pollIfDue()).status).toBe("unknown_code");
  });

  test("slow_down raises the interval persistently", async () => {
    const harness = makeSession([
      () => Response.json({ error: "slow_down" }, { status: 429, headers: { "Retry-After": "9" } }),
      () => Response.json({ status: "pending" }),
    ]);
    harness.advance(5_000);

    const slowed = await harness.session.pollIfDue();
    expect(slowed).toEqual({ status: "pending", retryInMs: 9_000 });

    // Next due poll returns plain pending but keeps the raised interval.
    harness.advance(9_000);
    const after = await harness.session.pollIfDue();
    expect(after).toEqual({ status: "pending", retryInMs: 9_000 });
  });

  test("rate limits never schedule before the persistent polling interval", async () => {
    const harness = makeSession([
      () => Response.json({}, { status: 429, headers: { "Retry-After": "3" } }),
      () => Response.json({ status: "pending" }),
    ]);
    harness.advance(5_000);

    const limited = await harness.session.pollIfDue();
    expect(limited).toEqual({ status: "pending", retryInMs: 5_000 });

    harness.advance(5_000);
    const after = await harness.session.pollIfDue();
    expect(after).toEqual({ status: "pending", retryInMs: 5_000 });
  });

  test("network failures back off exponentially and recover", async () => {
    const harness = makeSession([
      () => {
        throw new TypeError("reset");
      },
      () => {
        throw new TypeError("reset");
      },
      () => Response.json({ status: "connected", ...TOKENS }),
    ]);

    harness.advance(5_000);
    const firstFailure = await harness.session.pollIfDue();
    expect(firstFailure).toEqual({ status: "pending", retryInMs: 10_000 }); // 2×

    harness.advance(10_000);
    const secondFailure = await harness.session.pollIfDue();
    expect(secondFailure).toEqual({ status: "pending", retryInMs: 20_000 }); // 4×

    harness.advance(20_000);
    const recovered = await harness.session.pollIfDue();
    expect(recovered.status).toBe("linked");
  });

  test("backend pickup continues without browser-driven status requests", async () => {
    const harness = makeSession([
      () => Response.json({ status: "pending" }),
      () => Response.json({ status: "connected", ...TOKENS }),
    ]);

    const result = await runDeviceLinkUntilTerminal(harness.session, {
      sleep: async (delayMs) => {
        harness.advance(delayMs);
      },
    });

    expect(result?.status).toBe("linked");
    expect(harness.calls()).toBe(2);
    expect(harness.linked).toEqual([TOKENS]);
  });

  test("backend pickup stops when its link attempt is cancelled", async () => {
    const harness = makeSession([() => Response.json({ status: "pending" })]);
    const controller = new AbortController();

    const result = await runDeviceLinkUntilTerminal(harness.session, {
      signal: controller.signal,
      sleep: async (delayMs) => {
        harness.advance(delayMs);
        controller.abort();
      },
    });

    expect(result).toBeNull();
    expect(harness.calls()).toBe(0);
  });
});
