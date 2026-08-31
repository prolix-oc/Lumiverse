import { describe, expect, test } from "bun:test";
import {
  fingerprintPrivateDataAndSecretInventory,
  inspectLegacyImageGenerationPrivateData,
  scrubLegacyImageGenerationSettingRow,
} from "./private-data";

function scrub(value: string): Record<string, unknown> {
  return scrubLegacyImageGenerationSettingRow({
    key: "imageGeneration",
    value,
    user_id: "privacy-test-user",
  });
}

function parsedValue(row: Record<string, unknown>): Record<string, any> {
  return JSON.parse(row.value as string) as Record<string, any>;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

describe("legacy image-generation private data", () => {
  test("keeps provider scope through deep objects, arrays, and wrapper-before-provider shapes", () => {
    const row = scrub(JSON.stringify({
      rootApiKey: "retain-root",
      unrelated: { apiKey: "retain-unrelated" },
      nanogpt: {
        apiKey: "drop-immediate",
        model: "hidream",
        credentials: { apiKey: "drop-deep", label: "primary" },
        variants: [
          { apiKey: "drop-array", model: "variant-a" },
          { nested: { apiKey: "drop-deep-array", steps: 28 } },
        ],
      },
      wrapper: {
        novelai: {
          sampler: "k_euler",
          credentials: [{ nested: { apiKey: "drop-after-wrapper", label: "legacy" } }],
        },
      },
    }));

    expect(parsedValue(row)).toEqual({
      rootApiKey: "retain-root",
      unrelated: { apiKey: "retain-unrelated" },
      nanogpt: {
        model: "hidream",
        credentials: { label: "primary" },
        variants: [
          { model: "variant-a" },
          { nested: { steps: 28 } },
        ],
      },
      wrapper: {
        novelai: {
          sampler: "k_euler",
          credentials: [{ nested: { label: "legacy" } }],
        },
      },
    });
  });

  test("inspects JSON-encoded provider containers without rewriting unrelated strings", () => {
    const encodedProvider = '{ "wrapper": { "nanogpt": { "apiKey": "drop-encoded", "model": "nano" } } }';
    const encodedWithinProvider = '[{"credentials":{"apiKey":"drop-encoded-deep","label":"keep"}}]';
    const unrelatedEncoded = '{ "apiKey": "retain-encoded", "kind": "custom" }';
    const unrelatedMalformed = "{ordinary template text";

    const result = parsedValue(scrub(JSON.stringify({
      encodedProvider,
      novelai: { encodedWithinProvider, sampler: "ddim" },
      unrelatedEncoded,
      unrelatedMalformed,
    })));

    expect(JSON.parse(result.encodedProvider)).toEqual({
      wrapper: { nanogpt: { model: "nano" } },
    });
    expect(JSON.parse(result.novelai.encodedWithinProvider)).toEqual([
      { credentials: { label: "keep" } },
    ]);
    expect(result.unrelatedEncoded).toBe(unrelatedEncoded);
    expect(result.unrelatedMalformed).toBe(unrelatedMalformed);
  });

  test("reports every discovered credential with its provider settings", () => {
    const inspection = inspectLegacyImageGenerationPrivateData({
      nanogpt: {
        model: "nano-model",
        credentials: { apiKey: "nano-secret" },
      },
      wrapper: {
        novelai: JSON.stringify([
          { apiKey: "novel-secret", model: "novel-model" },
        ]),
      },
    });

    expect(inspection.changed).toBe(true);
    expect(inspection.credentials.map(({ provider, apiKey }) => ({ provider, apiKey }))).toEqual([
      { provider: "nanogpt", apiKey: "nano-secret" },
      { provider: "novelai", apiKey: "novel-secret" },
    ]);
    expect(inspection.credentials[0].providerSettings.model).toBe("nano-model");
    expect(inspection.credentials[1].providerSettings.model).toBe("novel-model");
    expect(JSON.parse(JSON.stringify(inspection.scrubbedValue))).toEqual({
      nanogpt: {
        model: "nano-model",
        credentials: {},
      },
      wrapper: {
        novelai: JSON.stringify([{ model: "novel-model" }]),
      },
    });
  });
  test("returns an unrelated row byte-for-byte, including own __proto__ data", () => {
    const value = ' { "__proto__": { "retained": "exact" }, "custom": { "apiKey": "public" }, "template": "{ordinary text" } ';
    const row = Object.create(null) as Record<string, unknown>;
    row.key = "imageGeneration";
    row.value = value;
    row.user_id = "privacy-test-user";
    row.__proto__ = { rowMarker: "exact" };

    const result = scrubLegacyImageGenerationSettingRow(row);

    expect(result).toBe(row);
    expect(result.value).toBe(value);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(hasOwn(result, "__proto__")).toBe(true);
    expect(result.__proto__).toEqual({ rowMarker: "exact" });
  });

  test("uses safe own entries when a changed row contains exact __proto__ keys", () => {
    const row = Object.create(null) as Record<string, unknown>;
    row.key = "imageGeneration";
    row.value = '{"__proto__":{"rootMarker":"retain"},"nanogpt":{"apiKey":"drop","nested":{"__proto__":{"nestedMarker":"retain"},"model":"nano"}}}';
    row.__proto__ = { rowMarker: "retain" };

    const result = scrubLegacyImageGenerationSettingRow(row);
    const parsed = parsedValue(result);

    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(hasOwn(result, "__proto__")).toBe(true);
    expect(result.__proto__).toEqual({ rowMarker: "retain" });
    expect(hasOwn(parsed, "__proto__")).toBe(true);
    expect(parsed.__proto__).toEqual({ rootMarker: "retain" });
    expect(hasOwn(parsed.nanogpt.nested, "__proto__")).toBe(true);
    expect(parsed.nanogpt.nested.__proto__).toEqual({ nestedMarker: "retain" });
    expect(Object.keys(parsed.nanogpt)).toEqual(["nested"]);
    expect(Object.keys(parsed.nanogpt.nested)).toEqual(["__proto__", "model"]);
    expect(parsed.nanogpt.nested.model).toBe("nano");
  });

  test("fails closed for malformed root or JSON-encoded private containers", () => {
    expect(() => scrub('{"nanogpt":{"apiKey":"root-secret"}')).toThrow(
      "imageGeneration settings value is malformed JSON",
    );
    expect(() => scrub(JSON.stringify({
      nanogpt: '{"credentials":',
    }))).toThrow(
      "imageGeneration settings contain malformed JSON-encoded provider data",
    );
    expect(() => scrub(JSON.stringify({
      wrapper: '{"nanogpt":{"apiKey":"encoded-secret"}',
    }))).toThrow(
      "imageGeneration settings contain malformed JSON-encoded provider data",
    );
    const escapedPrivateData = String.raw`{"\u006e\u0061\u006e\u006f\u0067\u0070\u0074":{"\u0061\u0070\u0069\u004b\u0065\u0079":"escaped-secret"}`;
    expect(() => scrub(JSON.stringify({ wrapper: escapedPrivateData }))).toThrow(
      "imageGeneration settings contain malformed JSON-encoded provider data",
    );
  });

  test("decodes double and triple encoded provider data while preserving each encoding layer", () => {
    const providerPayload = JSON.stringify({ apiKey: "drop-repeated", model: "keep-model" });
    const doubleEncoded = JSON.stringify(providerPayload);
    const tripleEncoded = JSON.stringify(doubleEncoded);
    const unrelatedDoubleEncoded = JSON.stringify(JSON.stringify({ apiKey: "retain-unrelated" }));

    const result = parsedValue(scrub(JSON.stringify({
      novelai: { doubleEncoded, tripleEncoded },
      unrelatedDoubleEncoded,
    })));

    expect(JSON.parse(JSON.parse(result.novelai.doubleEncoded))).toEqual({ model: "keep-model" });
    expect(JSON.parse(JSON.parse(JSON.parse(result.novelai.tripleEncoded)))).toEqual({ model: "keep-model" });
    expect(result.unrelatedDoubleEncoded).toBe(unrelatedDoubleEncoded);
  });

  test("recognizes explicit provider fields and fails closed at an inner encoded layer", () => {
    const scoped = inspectLegacyImageGenerationPrivateData({
      provider: "nanogpt",
      metadata: { apiKey: "drop-explicit", label: "keep" },
    });
    expect(JSON.parse(JSON.stringify(scoped.scrubbedValue))).toEqual({
      provider: "nanogpt",
      metadata: { label: "keep" },
    });

    const malformedInnerLayer = JSON.stringify('{"apiKey":"hidden"');
    expect(() => inspectLegacyImageGenerationPrivateData({
      provider: "novelai",
      metadata: malformedInnerLayer,
    })).toThrow("imageGeneration settings contain malformed JSON-encoded provider data");
  });

  test("fails closed at the privacy depth boundary without touching unrelated JSON-ish strings", () => {
    let tooDeep: unknown = { apiKey: "drop-too-deep" };
    for (let depth = 0; depth < 130; depth++) tooDeep = { nested: tooDeep };
    expect(() => inspectLegacyImageGenerationPrivateData({ nanogpt: tooDeep })).toThrow(
      "imageGeneration settings exceed the portable privacy depth limit",
    );

    const unrelated = '{"apiKey":"ordinary","broken":';
    const exact = inspectLegacyImageGenerationPrivateData({ unrelated });
    expect(exact.changed).toBe(false);
    expect((exact.scrubbedValue as { unrelated: string }).unrelated).toBe(unrelated);
  });

  test("fingerprint is canonical and binds exact encrypted secret inventory", () => {
    const firstInventory = [
      { key: "b", encrypted_value: "cipher-b", iv: "iv-b", tag: "tag-b", updated_at: 2 },
      { key: "a", encrypted_value: "cipher-a", iv: "iv-a", tag: "tag-a", updated_at: 1 },
    ];
    const first = fingerprintPrivateDataAndSecretInventory(
      { provider: "novelai", nested: { beta: 2, alpha: 1 } },
      firstInventory,
    );
    const reordered = fingerprintPrivateDataAndSecretInventory(
      { nested: { alpha: 1, beta: 2 }, provider: "novelai" },
      [...firstInventory].reverse(),
    );
    const changedCiphertext = fingerprintPrivateDataAndSecretInventory(
      { nested: { alpha: 1, beta: 2 }, provider: "novelai" },
      [{ ...firstInventory[1], encrypted_value: "changed" }, firstInventory[0]],
    );

    expect(reordered).toBe(first);
    expect(changedCiphertext).not.toBe(first);
    expect(() => fingerprintPrivateDataAndSecretInventory(
      { novelai: { apiKey: "plaintext" } },
      [],
    )).toThrow("imageGeneration settings contain unmigrated private data");
  });
});
