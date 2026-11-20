import { afterEach, describe, expect, test } from "bun:test";
import { interceptorPipeline } from "./interceptor-pipeline";
import {
  INTERNAL_PRESET_METADATA_KEY,
  projectPresetMetadataContext,
} from "./preset-metadata-context";

// Minimal shared context as generate.service pins it: the resolved preset id
// plus the preset's full metadata under the internal key.
function sharedContext(): Record<string, unknown> {
  return {
    chatId: "chat",
    presetId: "preset-1",
    [INTERNAL_PRESET_METADATA_KEY]: {
      alpha_ext: { ranges: [{ start: -4, end: 0 }], mode: "risu" },
      beta_ext: { mode: "other", secret: "beta only" },
      source: "loom-owned",
      _lumiverse_lumihub_id: "hub-id",
    },
  };
}

afterEach(() => {
  interceptorPipeline.unregisterByExtension("alpha-row");
  interceptorPipeline.unregisterByExtension("beta-row");
  interceptorPipeline.unregisterByExtension("loom-row");
});

describe("preset metadata interceptor context", () => {
  test("projects only the extension's own namespace and drops the full metadata", () => {
    const shared = sharedContext();
    const alpha = projectPresetMetadataContext(shared, "alpha_ext");
    expect(alpha.presetId).toBe("preset-1");
    expect(alpha.presetMetadata).toEqual({ ranges: [{ start: -4, end: 0 }], mode: "risu" });
    expect(alpha).not.toHaveProperty(INTERNAL_PRESET_METADATA_KEY);
    expect(JSON.stringify(alpha)).not.toContain("beta only");
    expect(JSON.stringify(alpha)).not.toContain("hub-id");

    expect(projectPresetMetadataContext(shared, "beta_ext").presetMetadata).toEqual({
      mode: "other",
      secret: "beta only",
    });
    expect(projectPresetMetadataContext(shared, "gamma_ext").presetMetadata).toBeUndefined();
    // The shared context keeps its internal key for later extensions.
    expect(shared).toHaveProperty(INTERNAL_PRESET_METADATA_KEY);
  });

  test("returns a deep clone the extension cannot use to mutate host state", () => {
    const shared = sharedContext();
    const alpha = projectPresetMetadataContext(shared, "alpha_ext");
    (alpha.presetMetadata as { ranges: Array<{ start: number }> }).ranges[0].start = 99;
    expect(projectPresetMetadataContext(shared, "alpha_ext").presetMetadata).toEqual({
      ranges: [{ start: -4, end: 0 }],
      mode: "risu",
    });
  });

  test("Loom-owned keys and inherited properties are never an extension namespace", () => {
    const shared = sharedContext();
    expect(projectPresetMetadataContext(shared, "source").presetMetadata).toBeUndefined();
    expect(projectPresetMetadataContext(shared, "constructor").presetMetadata).toBeUndefined();
  });

  test("replaces a presetMetadata value placed on the shared context", () => {
    const spoofed = { chatId: "chat", presetId: null, presetMetadata: { mode: "risu" } };
    const projected = projectPresetMetadataContext(spoofed, "alpha_ext");
    expect(projected.presetMetadata).toBeUndefined();
    expect(projected.presetId).toBeNull();
  });

  test("presetField matches against each interceptor's own namespace only", async () => {
    const ran: string[] = [];
    const match = { presetField: { path: ["mode"], oneOf: ["risu"] } };
    interceptorPipeline.register({
      extensionId: "alpha-row", presetMetadataNamespace: "alpha_ext", priority: 1, match,
      handler: async (messages) => { ran.push("alpha"); return { messages }; },
    });
    interceptorPipeline.register({
      extensionId: "beta-row", presetMetadataNamespace: "beta_ext", priority: 2, match,
      handler: async (messages) => { ran.push("beta"); return { messages }; },
    });
    interceptorPipeline.register({
      extensionId: "loom-row", presetMetadataNamespace: "source", priority: 3,
      match: { presetField: { path: [], exists: true } },
      handler: async (messages) => { ran.push("loom"); return { messages }; },
    });

    await interceptorPipeline.run([], sharedContext());
    expect(ran).toEqual(["alpha"]);

    ran.length = 0;
    await interceptorPipeline.run([], { chatId: "chat", presetId: null, presetMetadata: { mode: "risu" } });
    expect(ran).toEqual([]);
  });
});
