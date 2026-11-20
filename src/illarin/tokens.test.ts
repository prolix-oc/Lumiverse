import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { initIdentity } from "../crypto/init";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as svc from "../services/illarin-instance.service";
import {
  IllarinRateLimitError,
  IllarinUnavailableError,
  type IllarinFetch,
  type IllarinRequestOptions,
} from "./api";
import { getValidAccessToken, handleTerminalUnauthorized, refreshAccessToken } from "./tokens";
import type { TokenPair } from "./types";

const USER_A = "user-a";
const USER_B = "user-b";
const BASE_URL = "https://illarin.com";

interface LinkEventMessage {
  payload: { linked: boolean; reason?: string };
  userId?: string;
}

/** Await the real signal: the next ILLARIN_LINK_STATE_CHANGED dispatch. */
function nextLinkEvent(): Promise<LinkEventMessage> {
  const { promise, resolve } = Promise.withResolvers<LinkEventMessage>();
  const off = eventBus.on(EventType.ILLARIN_LINK_STATE_CHANGED, (message) => {
    off();
    resolve({ payload: message.payload, userId: message.userId });
  });
  return promise;
}

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
}

function futureExpiry(ms = 15 * 60_000): string {
  return new Date(Date.now() + ms).toISOString();
}

function pair(access: string, refresh: string, expiresAt = futureExpiry()): TokenPair {
  return {
    accessToken: access,
    accessTokenExpiresAt: expiresAt,
    refreshToken: refresh,
    connectedApp: { id: `inst-${refresh}`, permissions: ["work:receive"] },
  };
}

async function seedLinked(userId: string, p: TokenPair): Promise<void> {
  await svc.saveInstance({
    userId,
    illarinUrl: BASE_URL,
    pair: p,
    instanceName: `${userId}-box`,
    applicationName: "Lumiverse",
    declarationJson: JSON.stringify({ applicationVersion: "0.0.0-test" }),
  });
}

describe("illarin token lifecycle", () => {
  beforeAll(async () => {
    await initIdentity();
  });

  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
  });

  /** Test-seam cast on a named const: minimal counting stand-in for safeFetch. */
  function countingFetch(handler: () => Response | Promise<Response>): {
    fetch: IllarinFetch;
    calls: () => number;
    bodies: string[];
  } {
    let calls = 0;
    const bodies: string[] = [];
    const fetch = ((url: string, init?: { body?: string }) => {
      calls++;
      bodies.push(init?.body ?? "");
      return handler();
    }) as unknown as IllarinFetch;
    return { fetch, calls: () => calls, bodies };
  }

  const opts = (fetch: IllarinFetch): IllarinRequestOptions => ({ fetchImpl: fetch });

  test("returns the stored access token without touching the network while fresh", async () => {
    await seedLinked(USER_A, pair("ia1.fresh", "ir1.1"));
    const { fetch, calls } = countingFetch(() => Response.json({}));

    const token = await getValidAccessToken(USER_A, opts(fetch));

    expect(token).toBe("ia1.fresh");
    expect(calls()).toBe(0);
  });

  test("returns null when the user has never linked", async () => {
    await expect(getValidAccessToken(USER_A)).resolves.toBeNull();
  });

  test("refreshes inside the skew window and persists the replacement durably", async () => {
    // 30s left < 90s skew window.
    await seedLinked(USER_A, pair("ia1.old", "ir1.old", futureExpiry(30_000)));
    const { fetch, calls, bodies } = countingFetch(() => Response.json(pair("ia1.new", "ir1.new")));

    const token = await getValidAccessToken(USER_A, opts(fetch));

    expect(token).toBe("ia1.new");
    expect(bodies[0]).toBe(JSON.stringify({ refreshToken: "ir1.old" }));
    expect(calls()).toBe(1);

    const stored = await svc.getIllarinInstance(USER_A);
    expect(stored?.refreshToken).toBe("ir1.new");
    expect(stored?.accessToken).toBe("ia1.new");
    expect(stored?.lastRefreshAt).not.toBeNull();
  });

  test("forces one serialized refresh after an access-endpoint 401 even when the token is fresh", async () => {
    await seedLinked(USER_A, pair("ia1.rejected", "ir1.old"));
    const { fetch, calls } = countingFetch(() => Response.json(pair("ia1.retry", "ir1.next")));

    const tokens = await Promise.all([
      refreshAccessToken(USER_A, opts(fetch)),
      refreshAccessToken(USER_A, opts(fetch)),
    ]);

    expect(tokens).toEqual(["ia1.retry", "ia1.retry"]);
    expect(calls()).toBe(1);
    expect((await svc.getIllarinInstance(USER_A))?.refreshToken).toBe("ir1.next");
  });

  test("coalesces concurrent refreshes into a single HTTP call", async () => {
    await seedLinked(USER_A, pair("ia1.old", "ir1.old", futureExpiry(30_000)));
    const { fetch, calls } = countingFetch(() => Response.json(pair("ia1.new", "ir1.new")));

    const tokens = await Promise.all(
      Array.from({ length: 5 }, () => getValidAccessToken(USER_A, opts(fetch))),
    );

    expect(tokens).toEqual(["ia1.new", "ia1.new", "ia1.new", "ia1.new", "ia1.new"]);
    expect(calls()).toBe(1);
  });

  test("refresh replaces the last granted permissions, including an empty grant", async () => {
    await seedLinked(USER_A, pair("ia1.old", "ir1.old", futureExpiry(30_000)));
    const updated = { ...pair("ia1.new", "ir1.new"), connectedApp: { id: "inst-ir1.old", permissions: [] } };
    const { fetch } = countingFetch(() => Response.json(updated));

    expect(await getValidAccessToken(USER_A, opts(fetch))).toBe("ia1.new");
    expect((await svc.getIllarinInstance(USER_A))?.scopes).toEqual([]);
  });

  test("terminal 401 removes credentials and emits the link-state event", async () => {
    await seedLinked(USER_A, pair("ia1.old", "ir1.old", futureExpiry(30_000)));
    const { fetch } = countingFetch(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    const emitted = nextLinkEvent();

    await expect(getValidAccessToken(USER_A, opts(fetch))).resolves.toBeNull();

    await expect(svc.getIllarinInstance(USER_A)).resolves.toBeNull();
    await expect(emitted).resolves.toEqual({
      userId: USER_A,
      payload: { linked: false, reason: "unauthorized" },
    });
  });

  test("unknown refresh outcome stops the installation without replaying a spent token", async () => {
    await seedLinked(USER_A, pair("ia1.old", "ir1.old", futureExpiry(30_000)));
    const { fetch, calls } = countingFetch(() => {
      throw new TypeError("connection reset");
    });
    const emitted = nextLinkEvent();

    await expect(getValidAccessToken(USER_A, opts(fetch))).resolves.toBeNull();
    await expect(svc.getIllarinInstance(USER_A)).resolves.toBeNull();
    expect(calls()).toBe(1);
    expect(await emitted).toEqual({ userId: USER_A, payload: { linked: false, reason: "refresh_uncertain" } });
  });

  test("rate limits propagate without destroying credentials", async () => {
    await seedLinked(USER_A, pair("ia1.old", "ir1.old", futureExpiry(30_000)));
    const { fetch, calls } = countingFetch(
      () => Response.json({ error: "slow_down" }, { status: 429, headers: { "Retry-After": "7" } }),
    );

    try {
      await getValidAccessToken(USER_A, opts(fetch));
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(IllarinRateLimitError);
      expect((err as IllarinRateLimitError).retryAfterSeconds).toBe(7);
    }

    // No teardown happened: credentials survive for a Retry-After retry.
    const stored = await svc.getIllarinInstance(USER_A);
    expect(stored?.refreshToken).toBe("ir1.old");
    expect(calls()).toBe(1);
  });

  test("service unavailability propagates without destroying credentials", async () => {
    await seedLinked(USER_A, pair("ia1.old", "ir1.old", futureExpiry(30_000)));
    const { fetch } = countingFetch(
      () => Response.json({ error: "unavailable" }, { status: 503, headers: { "Retry-After": "11" } }),
    );

    try {
      await getValidAccessToken(USER_A, opts(fetch));
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(IllarinUnavailableError);
      expect((err as IllarinUnavailableError).retryAfterSeconds).toBe(11);
    }

    await expect(svc.getIllarinInstance(USER_A)).resolves.toMatchObject({
      accessToken: "ia1.old",
      refreshToken: "ir1.old",
    });
  });

  test("local refresh persistence failure discards a now-spent credential pair", async () => {
    await seedLinked(USER_A, pair("ia1.old", "ir1.old", futureExpiry(30_000)));
    getDb().run(`
      CREATE TRIGGER reject_illarin_token_update
      BEFORE UPDATE OF access_token_encrypted ON illarin_instance
      BEGIN
        SELECT RAISE(ABORT, 'simulated token write failure');
      END
    `);
    const { fetch } = countingFetch(() => Response.json(pair("ia1.new", "ir1.new")));

    await expect(getValidAccessToken(USER_A, opts(fetch))).rejects.toThrow("simulated token write failure");

    await expect(svc.getIllarinInstance(USER_A)).resolves.toBeNull();
    const synchronous = getDb().query("PRAGMA synchronous").get() as { synchronous: number };
    expect(synchronous.synchronous).toBe(1);
  });

  test("terminal teardown is isolated per installation", async () => {
    await seedLinked(USER_A, pair("ia1.a-old", "ir1.a", futureExpiry(30_000)));
    await seedLinked(USER_B, pair("ia1.b-fresh", "ir1.b"));
    const { fetch } = countingFetch(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    const emittedForA = nextLinkEvent();

    await expect(getValidAccessToken(USER_A, opts(fetch))).resolves.toBeNull();

    const event = await emittedForA;
    expect(event.userId).toBe(USER_A);

    await expect(svc.getIllarinInstance(USER_B)).resolves.toMatchObject({ accessToken: "ia1.b-fresh" });
    await expect(getValidAccessToken(USER_B)).resolves.toBe("ia1.b-fresh");
  });

  test("relink upserts one durable row and restores the normal sync setting", async () => {
    getDb().run("PRAGMA synchronous = NORMAL");
    await seedLinked(USER_A, pair("ia1.old", "ir1.old"));
    const original = getDb().query("SELECT id FROM illarin_instance WHERE user_id = ?").get(USER_A) as { id: string };

    await seedLinked(USER_A, pair("ia1.new", "ir1.new"));

    const current = getDb().query("SELECT id FROM illarin_instance WHERE user_id = ?").get(USER_A) as { id: string };
    const count = getDb().query("SELECT count(*) AS count FROM illarin_instance WHERE user_id = ?").get(USER_A) as { count: number };
    const synchronous = getDb().query("PRAGMA synchronous").get() as { synchronous: number };
    expect(current.id).toBe(original.id);
    expect(count.count).toBe(1);
    expect(synchronous.synchronous).toBe(1);
    await expect(svc.getIllarinInstance(USER_A)).resolves.toMatchObject({
      accessToken: "ia1.new",
      refreshToken: "ir1.new",
    });
  });

  test("handleTerminalUnauthorized deletes the row and reports the reason", async () => {
    await seedLinked(USER_A, pair("ia1.x", "ir1.x"));
    const emitted = nextLinkEvent();

    await handleTerminalUnauthorized(USER_A, "unlinked");

    await expect(svc.getIllarinInstance(USER_A)).resolves.toBeNull();
    await expect(emitted).resolves.toEqual({
      userId: USER_A,
      payload: { linked: false, reason: "unlinked" },
    });
  });
});
