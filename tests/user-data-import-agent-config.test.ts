import { describe, expect, test } from "bun:test";
import {
  stripImportedLegacyPresetMetadataV1,
} from "../src/services/user-data/import.service";

const agentConfig = {
  version: 1,
  enabled: true,
  maxInvocations: 64,
  mainToolIds: ["chat_search_history"],
  mainLoreScope: "active",
  profiles: [{
    id: "writer",
    name: "Writer",
    systemPrompt: "literal",
    connectionProfileId: null,
    toolIds: ["lore_search_entries"],
    loreScope: "active",
    allowMainDelegation: false,
    failurePolicy: "optional",
    streamActivity: false,
    maxOutputTokens: 64,
    timeoutMs: 5_000,
  }],
};

describe("user-data preset import agent config", () => {
  test("validates authored config while stripping reserved runtime authority from metadata", () => {
    const raw = JSON.stringify({
      agentConfig,
      agentConfigReviewRequired: true,
      extensionData: { keep: true },
    });
    const result = stripImportedLegacyPresetMetadataV1(raw);
    expect(typeof result).toBe("string");
    const metadata = JSON.parse(result as string);
    expect(metadata).toEqual({ extensionData: { keep: true } });
  });

  test("accepts normalized legacy tool-call limits without restoring metadata authority", () => {
    expect(() => stripImportedLegacyPresetMetadataV1(JSON.stringify({ agentConfig }))).not.toThrow();

    for (const maxToolCalls of [1, 64, Number.MAX_SAFE_INTEGER]) {
      const result = JSON.parse(stripImportedLegacyPresetMetadataV1(JSON.stringify({
        agentConfig: { ...agentConfig, maxToolCalls },
      })) as string);
      expect(result).toEqual({});
    }
  });

  test("strips an authored config that was already disabled", () => {
    const raw = JSON.stringify({
      agentConfig: { ...agentConfig, enabled: false },
      extensionData: { keep: true },
    });
    const metadata = JSON.parse(stripImportedLegacyPresetMetadataV1(raw));
    expect(metadata.agentConfig).toBeUndefined();
    expect(metadata.agentConfigReviewRequired).toBeUndefined();
    expect(metadata.extensionData).toEqual({ keep: true });
  });

  test("rejects invalid imported config instead of preserving it", () => {
    expect(() => stripImportedLegacyPresetMetadataV1(JSON.stringify({
      agentConfig: { ...agentConfig, mainToolIds: ["not_a_tool"] },
    }))).toThrow("agentConfig.mainToolIds[0]: unknown tool id");
  });

  test("keeps absent-config metadata byte-equivalent", () => {
    const raw = '{"extensionData":{"keep":true}}';
    expect(stripImportedLegacyPresetMetadataV1(raw)).toBe(raw);
  });
});
