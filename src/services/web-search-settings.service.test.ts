import { beforeEach, describe, expect, mock, test } from "bun:test";

const settings = new Map<string, unknown>();
const secrets = new Map<string, string>();
const settingWrites: Array<{ userId: string; key: string; value: unknown }> = [];

function scopedKey(userId: string, key: string): string {
  return `${userId}:${key}`;
}

mock.module("./settings.service", () => ({
  getSetting(userId: string, key: string) {
    const value = settings.get(scopedKey(userId, key));
    return value === undefined ? null : { key, value, updated_at: 0 };
  },
  putSetting(userId: string, key: string, value: unknown) {
    settings.set(scopedKey(userId, key), value);
    settingWrites.push({ userId, key, value });
    return { key, value, updated_at: 0 };
  },
}));

mock.module("./secrets.service", () => ({
  async putSecret(userId: string, key: string, value: string) {
    secrets.set(scopedKey(userId, key), value);
  },
  getSecret(userId: string, key: string) {
    return Promise.resolve(secrets.get(scopedKey(userId, key)) ?? null);
  },
  async validateSecret(userId: string, key: string) {
    return !!secrets.get(scopedKey(userId, key));
  },
  deleteSecret(userId: string, key: string) {
    return secrets.delete(scopedKey(userId, key));
  },
}));

const {
  EXA_WEB_SEARCH_API_KEY_SECRET,
  TAVILY_WEB_SEARCH_API_KEY_SECRET,
  WEB_SEARCH_API_KEY_SECRET,
  WEB_SEARCH_SETTINGS_KEY,
  getWebSearchApiKey,
  putWebSearchSettings,
} = await import("./web-search-settings.service");

beforeEach(() => {
  settings.clear();
  secrets.clear();
  settingWrites.length = 0;
});

describe("web-search settings credentials", () => {
  test.each([
    ["searxng", WEB_SEARCH_API_KEY_SECRET],
    ["exa", EXA_WEB_SEARCH_API_KEY_SECRET],
    ["tavily", TAVILY_WEB_SEARCH_API_KEY_SECRET],
  ] as const)("stores the %s credential as a user-scoped encrypted secret", async (provider, secretKey) => {
    const result = await putWebSearchSettings("user-a", {
      provider,
      enabled: true,
      apiKey: " provider-key ",
    });

    expect(result).toMatchObject({ provider, enabled: true, hasApiKey: true });
    expect(await getWebSearchApiKey("user-a", provider)).toBe("provider-key");
    expect(await getWebSearchApiKey("user-b", provider)).toBeNull();
    expect(secrets.get(scopedKey("user-a", secretKey))).toBe("provider-key");

    // The regular settings row retains only non-sensitive configuration.
    expect(settings.get(scopedKey("user-a", WEB_SEARCH_SETTINGS_KEY))).not.toHaveProperty("apiKey");
    expect(settingWrites).toHaveLength(1);
  });

  test("keeps each provider credential and clears only the selected provider", async () => {
    await putWebSearchSettings("user-a", { provider: "exa", apiKey: "exa-key" });
    await putWebSearchSettings("user-a", { provider: "tavily", apiKey: "tavily-key" });
    await putWebSearchSettings("user-a", { provider: "exa", apiKey: null });

    expect(await getWebSearchApiKey("user-a", "exa")).toBeNull();
    expect(await getWebSearchApiKey("user-a", "tavily")).toBe("tavily-key");
  });

  test("restores a provider's saved preferences when switching back", async () => {
    await putWebSearchSettings("user-a", {
      provider: "searxng",
      apiUrl: "https://search.example.test/",
      engines: ["google", "bing"],
      language: "en",
      safeSearch: 2,
      inlineToolEnabled: true,
      defaultResultCount: 7,
      maxResultCount: 9,
    });
    await putWebSearchSettings("user-a", {
      provider: "exa",
      defaultResultCount: 2,
      maxResultCount: 4,
      maxPagesToScrape: 1,
    });

    const restored = await putWebSearchSettings("user-a", { provider: "searxng" });

    expect(restored).toMatchObject({
      provider: "searxng",
      apiUrl: "https://search.example.test",
      engines: ["google", "bing"],
      language: "en",
      safeSearch: 2,
      inlineToolEnabled: true,
      defaultResultCount: 7,
      maxResultCount: 9,
    });
    expect(restored.providerProfiles).toMatchObject({
      exa: { defaultResultCount: 2, maxResultCount: 4, maxPagesToScrape: 1 },
      searxng: { engines: ["google", "bing"], safeSearch: 2 },
    });
  });
});
