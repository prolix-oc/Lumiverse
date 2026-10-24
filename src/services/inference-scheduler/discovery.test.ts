import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { InvalidSettingError, MAX_SAVED_THEMES_VALUE_BYTES } from "../settings-validation";

const settingsStore = new Map<string, unknown>();

mock.module("../settings.service", () => ({
  InvalidSettingError,
  MAX_SAVED_THEMES_VALUE_BYTES,
  getSetting: (userId: string, key: string) => (
    settingsStore.has(`${userId}:${key}`) ? { key, value: settingsStore.get(`${userId}:${key}`) } : null
  ),
  putSetting: (userId: string, key: string, value: unknown) => {
    settingsStore.set(`${userId}:${key}`, value);
    return { key, value };
  },
}));

let embeddingProfiles: Array<Record<string, unknown>> = [];

mock.module("../embeddings.service", () => ({
  getEmbeddingConfig: async () => ({ connectionProfiles: embeddingProfiles, api_url: "", model: "" }),
}));

mock.module("../connections.service", () => ({
  listConnections: () => ({ data: [] }),
  getConnection: () => null,
  resolveEffectiveApiUrl: () => "",
}));

mock.module("../image-gen-connections.service", () => ({
  listConnections: () => ({ data: [] }),
}));

mock.module("../memory-cortex", () => ({
  getCortexConfig: () => ({ sidecar: { connectionProfileId: null } }),
  listCortexSidecarEndpoints: () => ({
    queryGeneration: { primary: { connectionProfileId: null, model: null }, secondary: null },
    memorySummarization: { primary: { connectionProfileId: null, model: null }, secondary: null },
  }),
}));

const configModule = await import("./config");
const { discoverLocalInferenceEndpoints } = await import("./discovery");

const USER = "discovery-user";

beforeEach(() => {
  settingsStore.clear();
  embeddingProfiles = [];
  configModule.resetInferenceSchedulerConfigForTests();
});

afterEach(() => {
  settingsStore.clear();
  configModule.resetInferenceSchedulerConfigForTests();
});

describe("inference endpoint discovery", () => {
  test("includes explicit extra and excluded origins so they stay manageable", async () => {
    configModule.putInferenceSchedulerConfig(USER, {
      enabled: true,
      extraOrigins: ["http://10.0.0.9:5555/v1"],
      excludedOrigins: ["http://10.0.0.10:6666/v1"],
    });

    const endpoints = await discoverLocalInferenceEndpoints(USER);
    const extra = endpoints.find((entry) => entry.origin === "http://10.0.0.9:5555");
    const excluded = endpoints.find((entry) => entry.origin === "http://10.0.0.10:6666");

    expect(extra).toMatchObject({
      label: "Manual — 10.0.0.9:5555",
      sources: ["manual"],
      scheduled: true,
      excluded: false,
    });
    expect(excluded).toMatchObject({
      sources: ["manual"],
      scheduled: false,
      excluded: true,
    });
  });

  test("does not duplicate an explicit origin that a feature profile already reports", async () => {
    embeddingProfiles = [{
      id: "profile-1",
      api_url: "http://127.0.0.1:8080/v1/embeddings",
      model: "nomic-embed",
    }];
    configModule.putInferenceSchedulerConfig(USER, {
      enabled: true,
      extraOrigins: ["http://127.0.0.1:8080"],
    });
    const endpoints = await discoverLocalInferenceEndpoints(USER);
    const matching = endpoints.filter((entry) => entry.origin === "http://127.0.0.1:8080");
    expect(matching).toHaveLength(1);
    expect(matching[0].sources).toContain("embeddings");
    expect(matching[0].sources).not.toContain("manual");
  });
});
