import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import {
  duplicateConnection,
  getConnection,
  getUsableConnection,
  getConnectionRouletteConfig,
  resolveConcreteConnectionV1,
  resolveEffectiveApiUrl,
  toPublicConnection,
  updateConnection,
} from "./connections.service";
import { getProvider } from "../llm/registry";

describe("resolveEffectiveApiUrl", () => {
  test("freezes the provider default for blank saved endpoints and preserves custom endpoints", () => {
    const openAiProvider = getProvider("openai");
    if (!openAiProvider?.defaultUrl) throw new Error("OpenAI provider default URL is not registered");
    const defaultUrl = openAiProvider.defaultUrl;
    expect(resolveEffectiveApiUrl({ provider: "openai", api_url: "   " })).toBe(defaultUrl);
    expect(resolveEffectiveApiUrl({ provider: "openai", api_url: "https://proxy.example/v1" }))
      .toBe("https://proxy.example/v1");
    expect(resolveEffectiveApiUrl({ provider: "provider-without-a-default", api_url: "" })).toBe("");
  });
  test("uses the current Z.AI general endpoint by default", () => {
    expect(resolveEffectiveApiUrl({ provider: "zai", api_url: "", metadata: {} })).toBe("https://api.z.ai/api/paas/v4");
  });

  test("switches Z.AI to the coding plan endpoint when enabled", () => {
    expect(resolveEffectiveApiUrl({
      provider: "zai",
      api_url: "https://api.z.ai/api/paas/v4",
      metadata: { use_coding_plan_endpoint: true },
    })).toBe("https://api.z.ai/api/coding/paas/v4");
  });

  test("normalizes legacy Z.AI v1 urls", () => {
    expect(resolveEffectiveApiUrl({
      provider: "zai",
      api_url: "https://api.z.ai/v1",
      metadata: {},
    })).toBe("https://api.z.ai/api/paas/v4");

    expect(resolveEffectiveApiUrl({
      provider: "zai",
      api_url: "https://api.z.ai/v1",
      metadata: { use_coding_plan_endpoint: true },
    })).toBe("https://api.z.ai/api/coding/paas/v4");
  });
});

describe("getConnectionRouletteConfig", () => {
  test("normalizes roulette target ids", () => {
    expect(getConnectionRouletteConfig({
      metadata: {
        connection_roulette: {
          connection_ids: [" a ", "", "b", "a", 42, "c"],
        },
      },
    })).toEqual({ connection_ids: ["a", "b", "c"] });
  });

  test("falls back to an empty roulette config", () => {
    expect(getConnectionRouletteConfig({ metadata: {} })).toEqual({ connection_ids: [] });
  });
});
describe("imported connection authority", () => {
  beforeAll(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await runMigrations(getDb());
    insertResolverUser(RESOLVER_USER_ID);
  });

  afterAll(() => {
    closeDatabase();
  });

  test("keeps imported rows inert through edits and strips markers from public projections", async () => {
    insertResolverProfile("imported-authority", {
      metadata: {
        label: "imported",
        __lumiverse_import_review_required: true,
        __lumiverse_import_review_code: "foreign_import",
      },
    });
    const imported = getConnection(RESOLVER_USER_ID, "imported-authority")!;
    expect(getUsableConnection(RESOLVER_USER_ID, imported.id)).toBeNull();
    expect(toPublicConnection(imported).metadata).toEqual({ label: "imported" });

    const edited = await updateConnection(RESOLVER_USER_ID, imported.id, {
      metadata: { label: "edited" },
    });
    expect(edited?.review_required).toBe(true);
    expect(edited?.review_code).toBe("foreign_import");
    expect(toPublicConnection(edited!).metadata).toEqual({ label: "edited" });
    expect(getUsableConnection(RESOLVER_USER_ID, imported.id)).toBeNull();

    const reviewed = await updateConnection(RESOLVER_USER_ID, imported.id, {
      metadata: { label: "reviewed" },
      reviewed: true,
    });
    expect(reviewed?.review_required).toBe(false);
    expect(reviewed?.review_code).toBeNull();
    expect(toPublicConnection(reviewed!).metadata).toEqual({ label: "reviewed" });
    expect(getUsableConnection(RESOLVER_USER_ID, imported.id)?.id).toBe(imported.id);
  });

  test("duplicates imported rows without copying executable authority", async () => {
    insertResolverProfile("imported-duplicate", {
      metadata: {
        __lumiverse_import_review_required: true,
        __lumiverse_import_review_code: "foreign_import",
      },
    });
    const duplicate = await duplicateConnection(RESOLVER_USER_ID, "imported-duplicate");
    expect(duplicate?.review_required).toBe(true);
    expect(getUsableConnection(RESOLVER_USER_ID, duplicate!.id)).toBeNull();
    expect(toPublicConnection(duplicate!).metadata).toEqual({});
  });
});

const RESOLVER_USER_ID = "concrete-resolver-user";
const OTHER_USER_ID = "concrete-resolver-other";
const FIXTURE_NOW = 1_800_000_000;

function insertResolverUser(id: string): void {
  getDb().query(
    'INSERT OR IGNORE INTO "user" (id, name, email, emailVerified) VALUES (?, ?, ?, 1)',
  ).run(id, id, `${id}@example.test`);
}

function insertResolverProfile(
  id: string,
  options: {
    userId?: string;
    name?: string;
    provider?: string;
    apiUrl?: string;
    model?: string;
    isDefault?: boolean;
    metadata?: Record<string, unknown>;
    updatedAt?: number;
  } = {},
): void {
  const userId = options.userId ?? RESOLVER_USER_ID;
  insertResolverUser(userId);
  getDb().query(
    `INSERT INTO connection_profiles
      (id, user_id, name, provider, api_url, model, preset_id, is_default,
       has_api_key, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?, ?)`,
  ).run(
    id,
    userId,
    options.name ?? id,
    options.provider ?? "openai",
    options.apiUrl ?? "https://api.example.test/v1",
    options.model ?? "test-model",
    options.isDefault ? 1 : 0,
    JSON.stringify(options.metadata ?? {}),
    FIXTURE_NOW,
    options.updatedAt ?? FIXTURE_NOW,
  );
}

function insertResolverSecret(
  connectionId: string,
  encryptedValue: string,
  updatedAt = FIXTURE_NOW,
  userId = RESOLVER_USER_ID,
): void {
  getDb().query(
    `INSERT INTO secrets (key, encrypted_value, iv, tag, user_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    `connection_${connectionId}_api_key`,
    encryptedValue,
    `iv-${encryptedValue}`,
    `tag-${encryptedValue}`,
    userId,
    updatedAt,
  );
}

describe("resolveConcreteConnectionV1", () => {
  beforeAll(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await runMigrations(getDb());
    insertResolverUser(RESOLVER_USER_ID);
    insertResolverUser(OTHER_USER_ID);
  });

  afterAll(() => {
    closeDatabase();
  });

  test("selects a roulette candidate exactly once and freezes its identity", () => {
    insertResolverProfile("roulette-candidate-a", { model: "model-a" });
    insertResolverProfile("roulette-candidate-b", { model: "model-b" });
    insertResolverProfile("roulette-logical", {
      provider: "model_roulette",
      metadata: {
        connection_roulette: {
          connection_ids: ["roulette-candidate-a", "roulette-candidate-b"],
        },
      },
    });

    const random = spyOn(Math, "random").mockReturnValue(0.99);
    try {
      const resolved = resolveConcreteConnectionV1(RESOLVER_USER_ID, "roulette-logical");
      expect(resolved?.logicalId).toBe("roulette-logical");
      expect(resolved?.concreteId).toBe("roulette-candidate-b");
      expect(resolved?.model).toBe("model-b");
      expect(random).toHaveBeenCalledTimes(1);
      expect(Object.isFrozen(resolved)).toBe(true);
      expect(Object.isFrozen(resolved?.capabilities)).toBe(true);
    } finally {
      random.mockRestore();
    }
  });

  test("normalizes endpoints and only endpoint-affecting metadata changes its revision", () => {
    insertResolverProfile("endpoint-profile", {
      provider: "zai",
      apiUrl: " HTTPS://API.Z.AI/v1/ ",
      metadata: { use_coding_plan_endpoint: false, unrelated: "one" },
    });
    const initial = resolveConcreteConnectionV1(RESOLVER_USER_ID, "endpoint-profile")!;
    expect(initial.endpoint).toBe("https://api.z.ai/api/paas/v4");

    getDb().query(
      "UPDATE connection_profiles SET metadata = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    ).run(
      JSON.stringify({ use_coding_plan_endpoint: false, unrelated: "two" }),
      FIXTURE_NOW + 1,
      "endpoint-profile",
      RESOLVER_USER_ID,
    );
    const unrelatedChange = resolveConcreteConnectionV1(RESOLVER_USER_ID, "endpoint-profile")!;
    expect(unrelatedChange.endpoint).toBe(initial.endpoint);
    expect(unrelatedChange.endpointRevision).toBe(initial.endpointRevision);

    getDb().query(
      "UPDATE connection_profiles SET metadata = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    ).run(
      JSON.stringify({ use_coding_plan_endpoint: true, unrelated: "two" }),
      FIXTURE_NOW + 2,
      "endpoint-profile",
      RESOLVER_USER_ID,
    );
    const endpointChange = resolveConcreteConnectionV1(RESOLVER_USER_ID, "endpoint-profile")!;
    expect(endpointChange.endpoint).toBe("https://api.z.ai/api/coding/paas/v4");
    expect(endpointChange.endpointRevision).not.toBe(initial.endpointRevision);
    expect(endpointChange.candidateRevision).not.toBe(initial.candidateRevision);
  });
  test("includes a provider default in frozen endpoint identity before hashing", () => {
    insertResolverProfile("default-endpoint-profile", {
      provider: "openai",
      apiUrl: "   ",
    });
    const resolved = resolveConcreteConnectionV1(RESOLVER_USER_ID, "default-endpoint-profile")!;
    const openAiProvider = getProvider("openai");
    if (!openAiProvider?.defaultUrl) throw new Error("OpenAI provider default URL is not registered");
    expect(resolved.endpoint).toBe(openAiProvider.defaultUrl);
    expect(resolved.effectiveEndpoint).toBe(resolved.endpoint);
    expect(resolved.endpointRevision).toBeTruthy();
    expect(resolved.fingerprint).toBeTruthy();
  });

  test("changes credential revision and trust fingerprint on credential rotation", () => {
    insertResolverProfile("credential-profile", { apiUrl: "https://same.example/v1" });
    insertResolverSecret("credential-profile", "cipher-one");
    const initial = resolveConcreteConnectionV1(RESOLVER_USER_ID, "credential-profile")!;

    getDb().query(
      "UPDATE secrets SET encrypted_value = ?, iv = ?, tag = ?, updated_at = ? WHERE key = ? AND user_id = ?",
    ).run(
      "cipher-two",
      "iv-two",
      "tag-two",
      FIXTURE_NOW,
      "connection_credential-profile_api_key",
      RESOLVER_USER_ID,
    );
    const rotated = resolveConcreteConnectionV1(RESOLVER_USER_ID, "credential-profile")!;
    expect(rotated.credentialRevision).not.toBe(initial.credentialRevision);
    expect(rotated.fingerprint).not.toBe(initial.fingerprint);
    expect(rotated.candidateRevision).not.toBe(initial.candidateRevision);
    expect(JSON.stringify(rotated)).not.toContain("cipher-two");
  });

  test("equates same trust domains while separating endpoint and credential domains", () => {
    insertResolverProfile("domain-a", {
      apiUrl: "https://EXAMPLE.TEST:443/v1/",
      name: "A",
    });
    insertResolverProfile("domain-b", {
      apiUrl: "https://example.test/v1",
      name: "B",
    });
    const domainA = resolveConcreteConnectionV1(RESOLVER_USER_ID, "domain-a")!;
    const domainB = resolveConcreteConnectionV1(RESOLVER_USER_ID, "domain-b")!;
    expect(domainA.endpoint).toBe("https://example.test/v1");
    expect(domainA.fingerprint).toBe(domainB.fingerprint);
    expect(domainA.candidateRevision).not.toBe(domainB.candidateRevision);

    insertResolverProfile("different-endpoint", { apiUrl: "https://other.example/v1" });
    const endpointDifferent = resolveConcreteConnectionV1(RESOLVER_USER_ID, "different-endpoint")!;
    expect(endpointDifferent.fingerprint).not.toBe(domainA.fingerprint);

    insertResolverSecret("domain-b", "cipher-domain-b");
    const credentialDifferent = resolveConcreteConnectionV1(RESOLVER_USER_ID, "domain-b")!;
    expect(credentialDifferent.fingerprint).not.toBe(domainA.fingerprint);
  });

  test("enforces user ownership and returns null for missing logical connections", () => {
    insertResolverProfile("other-user-profile", { userId: OTHER_USER_ID });
    expect(resolveConcreteConnectionV1(RESOLVER_USER_ID, "other-user-profile")).toBeNull();
    expect(resolveConcreteConnectionV1(RESOLVER_USER_ID, "missing-profile")).toBeNull();
  });
});
