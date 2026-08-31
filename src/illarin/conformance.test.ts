import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { initIdentity } from "../crypto/init";
import * as svc from "../services/illarin-instance.service";
import { getArchiveTableSpec } from "../services/user-data/table-registry";
import { buildDeclaration, buildDeclarationUpdate } from "./declaration";
import { getValidAccessToken, handleTerminalUnauthorized } from "./tokens";
import { refreshTokens, updateInstanceDeclaration, type IllarinFetch, type IllarinRequestOptions } from "./api";
import { DECLARATION_LIMITS, ILLARIN_SCOPES, type TokenPair } from "./types";

const USER_A = "conformance-a";
const USER_B = "conformance-b";

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
}

function futureExpiry(ms = 15 * 60_000): string {
  return new Date(Date.now() + ms).toISOString();
}

function pair(access: string, refresh: string): TokenPair {
  return {
    accessToken: access,
    accessTokenExpiresAt: futureExpiry(),
    refreshToken: refresh,
    instance: { id: `inst-${refresh}`, scopes: ["asset:receive"] },
  };
}

function expiringPair(access: string, refresh: string): TokenPair {
  return { ...pair(access, refresh), accessTokenExpiresAt: futureExpiry(30_000) };
}

async function seed(userId: string, illarinUrl: string, p: TokenPair): Promise<void> {
  await svc.saveInstance({
    userId,
    illarinUrl,
    pair: p,
    instanceName: `${userId}-box`,
    applicationName: "Lumiverse",
    declarationJson: JSON.stringify({ applicationVersion: "0.0.0" }),
  });
}

function recordingFetch(response: () => Response): {
  fetch: IllarinFetch;
  urls: () => string[];
} {
  const urls: string[] = [];
  const fetch = ((url: string) => {
    urls.push(String(url));
    return response();
  }) as unknown as IllarinFetch;
  return { fetch, urls: () => urls };
}

describe("illarin protocol conformance checklist", () => {
  beforeAll(async () => {
    await initIdentity();
  });

  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
  });

  test("declarations carry required arrays and stay inside every bound", () => {
    const declaration = buildDeclaration({ instanceName: "check", applicationVersion: "1.0.0", scopes: [] });
    expect(Array.isArray(declaration.capabilities)).toBe(true);
    expect(Array.isArray(declaration.acceptedTargets)).toBe(true);
    expect(declaration.capabilities.length).toBeLessThanOrEqual(DECLARATION_LIMITS.maxArrayEntries);
    expect(declaration.acceptedTargets.length).toBeLessThanOrEqual(DECLARATION_LIMITS.maxArrayEntries);
    expect(new TextEncoder().encode(JSON.stringify(declaration)).length).toBeLessThanOrEqual(
      DECLARATION_LIMITS.maxBodyBytes,
    );
  });

  test("only documented scopes are ever requested", () => {
    const decision = ["asset:receive"] as const;
    for (const scope of decision) expect(ILLARIN_SCOPES).toContain(scope);
    const declaration = buildDeclaration({ instanceName: "check", scopes: [...decision] });
    expect(declaration.scopes).toEqual([...decision]);
  });

  test("declaration updates omit names and scopes", () => {
    const update = buildDeclarationUpdate(
      buildDeclaration({ instanceName: "check", applicationVersion: "2.0.0", scopes: ["asset:receive"] }),
    );
    const keys = Object.keys(update);
    expect(keys).not.toContain("applicationName");
    expect(keys).not.toContain("instanceName");
    expect(keys).not.toContain("scopes");
  });

  test("credential-bearing requests never place secrets in URLs", async () => {
    const { fetch, urls } = recordingFetch(() => Response.json(pair("ia1.next", "ir1.next")));
    const options: IllarinRequestOptions = { fetchImpl: fetch };

    await refreshTokens("https://illarin.xyz", "ir1.secret-refresh", options);
    await updateInstanceDeclaration("https://illarin.xyz", "ia1.secret-access", {
      protocolVersion: 1,
      capabilities: [],
      acceptedTargets: [],
    }, options);

    for (const url of urls()) {
      expect(url).not.toContain("ia1.");
      expect(url).not.toContain("ir1.");
      expect(url).not.toContain("secret");
    }
  });

  test("illarin credentials are forbidden from export/import", () => {
    expect(getArchiveTableSpec("illarin_instance")?.kind).toBe("forbidden");
    expect(getArchiveTableSpec("illarin_delivery_receipt")?.kind).toBe("forbidden");
  });

  test("delivery receipts remain pending until a successful acknowledgement", () => {
    svc.recordDeliveryInstalled(USER_A, "instance-a", "delivery-1", "asset-1", 4);
    expect(svc.pendingDeliveryAcknowledgements(USER_A, "instance-a")).toEqual(["delivery-1"]);
    expect(svc.pendingDeliveryAcknowledgements(USER_A, "instance-b")).toEqual([]);

    svc.markDeliveriesAcknowledged(USER_A, "instance-a", ["delivery-1"]);
    expect(svc.pendingDeliveryAcknowledgements(USER_A, "instance-a")).toEqual([]);

    svc.queueDeliveryAcknowledgement(USER_A, "instance-a", "delivery-1");
    expect(svc.pendingDeliveryAcknowledgements(USER_A, "instance-a")).toEqual(["delivery-1"]);
  });

  test("two installations link, refresh, and tear down without sharing state", async () => {
    await seed(USER_A, "https://hub-a.example", expiringPair("ia1.a-old", "ir1.a-live"));
    await seed(USER_B, "https://hub-b.example", pair("ia1.b0", "ir1.b0"));

    // Refreshing A rotates only A.
    const { fetch: fetchA } = recordingFetch(() => Response.json(pair("ia1.a-new", "ir1.a-next")));
    const tokenA = await getValidAccessToken(USER_A, { fetchImpl: fetchA });
    expect(tokenA).toBe("ia1.a-new");
    expect((await svc.getIllarinInstance(USER_B))?.refreshToken).toBe("ir1.b0");

    // Tearing down A leaves B fully usable without any network call.
    await handleTerminalUnauthorized(USER_A, "unlinked");
    await expect(svc.getIllarinInstance(USER_A)).resolves.toBeNull();
    await expect(getValidAccessToken(USER_B)).resolves.toBe("ia1.b0");

    // Relinking A overwrites only A's row.
    await seed(USER_A, "https://hub-c.example", pair("ia1.a2", "ir1.a2"));
    const rows = getDb()
      .query("SELECT user_id FROM illarin_instance ORDER BY user_id")
      .all() as Array<{ user_id: string }>;
    expect(rows).toEqual([{ user_id: USER_A }, { user_id: USER_B }]);
  });
});
