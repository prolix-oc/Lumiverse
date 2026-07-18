import { describe, expect, test } from "bun:test";
import type { SpindleManifest } from "lumiverse-spindle-types";
import {
  SPINDLE_COMPATIBILITY_ERROR_CODE,
  SPINDLE_HOST_CAPABILITIES,
} from "lumiverse-spindle-types";
import {
  SpindleCompatibilityError,
  assertManifestCompatibility,
  compareCanonicalSemver,
  createSpindleHostDescriptor,
  digestSpindleHostDescriptor,
  parseCanonicalSemver,
  serializeSpindleHostDescriptor,
  validateSpindleHostDescriptor,
} from "./host-compatibility";

const INSTALLATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const HOST_VERSION = "1.0.8";

function manifest(minimum?: unknown): SpindleManifest {
  return {
    identifier: "compat_test",
    name: "Compatibility test",
    version: "1.0.0",
    author: "Tester",
    permissions: [],
    ...(minimum === undefined ? {} : { minimum_lumiverse_version: minimum }),
  } as unknown as SpindleManifest;
}

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    descriptorVersion: 1,
    lumiverseVersion: HOST_VERSION,
    capabilities: { ...SPINDLE_HOST_CAPABILITIES },
    extensionInstallationId: INSTALLATION_ID,
    ...overrides,
  };
}

describe("Spindle host compatibility", () => {
  test("parses canonical SemVer and orders huge identifiers without overflow", () => {
    const huge = "999999999999999999999999999999.0.0";
    expect(parseCanonicalSemver(huge, "version").source).toBe(huge);
    expect(compareCanonicalSemver(huge, "2.0.0")).toBe(1);
    expect(compareCanonicalSemver("1.0.0-alpha.10", "1.0.0-alpha.2")).toBe(1);
    expect(compareCanonicalSemver("1.0.0-alpha", "1.0.0-alpha.0")).toBe(-1);
    expect(compareCanonicalSemver("1.0.0-alpha", "1.0.0")).toBe(-1);
    expect(compareCanonicalSemver("1.0.0+one", "1.0.0+two")).toBe(0);
  });

  test("rejects noncanonical semantic versions", () => {
    for (const value of ["v1.0.0", "1.0", "01.0.0", "1.0.0-alpha.01", "1.0.0+"]) {
      expect(() => parseCanonicalSemver(value, "version")).toThrow(SpindleCompatibilityError);
    }
  });

  test("validates required capabilities and accepts unknown valid extras", () => {
    const value = validateSpindleHostDescriptor(
      descriptor({
        capabilities: { ...SPINDLE_HOST_CAPABILITIES, "future-capability-v2": 3 },
      }),
    );
    expect(value.capabilities["future-capability-v2"]).toBe(3);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.capabilities)).toBe(true);
    expect(() => {
      (value.capabilities as Record<string, number>)["future-capability-v2"] = 4;
    }).toThrow();

    const missing = { ...SPINDLE_HOST_CAPABILITIES } as Record<string, number>;
    delete missing["interceptor-final-response-v1"];
    for (const invalid of [
      descriptor({ capabilities: missing }),
      descriptor({ capabilities: { ...SPINDLE_HOST_CAPABILITIES, "interceptor-final-response-v1": 2 } }),
      descriptor({ capabilities: { ...SPINDLE_HOST_CAPABILITIES, "Bad Key": 1 } }),
      descriptor({ capabilities: { ...SPINDLE_HOST_CAPABILITIES, "future-v1": 0 } }),
    ]) {
      expect(() => validateSpindleHostDescriptor(invalid)).toThrow(SpindleCompatibilityError);
    }
  });

  test("defensively clones descriptor data and requires a canonical lowercase UUID", () => {
    const raw = descriptor({ capabilities: { ...SPINDLE_HOST_CAPABILITIES } });
    const value = validateSpindleHostDescriptor(raw);
    (raw.capabilities as Record<string, number>)["future-v1"] = 2;
    expect(value.capabilities["future-v1"]).toBeUndefined();

    for (const invalid of [
      descriptor({ extensionInstallationId: INSTALLATION_ID.toUpperCase() }),
      descriptor({ extensionInstallationId: "123e4567-e89b-02d3-a456-426614174000" }),
      descriptor({ lumiverseVersion: "v1.0.8" }),
      descriptor({ descriptorVersion: 2 }),
    ]) {
      expect(() => validateSpindleHostDescriptor(invalid)).toThrow(SpindleCompatibilityError);
    }
  });

  test("creates the current immutable descriptor from backend package metadata", async () => {
    const value = await createSpindleHostDescriptor(INSTALLATION_ID);
    expect(value.descriptorVersion).toBe(1);
    expect(value.lumiverseVersion).toBe(HOST_VERSION);
    expect(value.extensionInstallationId).toBe(INSTALLATION_ID);
    expect(Object.keys(value.capabilities).sort()).toEqual(
      Object.keys(SPINDLE_HOST_CAPABILITIES).sort(),
    );
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.capabilities)).toBe(true);
  });

  test("serializes and digests all validated capabilities in ASCII order", async () => {
    const value = validateSpindleHostDescriptor(
      descriptor({ capabilities: { ...SPINDLE_HOST_CAPABILITIES, "future-capability-v2": 3 } }),
    );
    expect(serializeSpindleHostDescriptor(value)).toBe(
      JSON.stringify([
        1,
        HOST_VERSION,
        INSTALLATION_ID,
        [
          ["future-capability-v2", 3],
          ["generation-assembly-v1", 1],
          ["interceptor-context-v1", 1],
          ["interceptor-final-response-v1", 1],
          ["loom-block-editor-v1", 1],
          ["preset-editor-v1", 1],
          ["preset-extension-data-v1", 1],
        ],
      ]),
    );
    const digest = await digestSpindleHostDescriptor(value);
    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(digest).toBe(await digestSpindleHostDescriptor(value));
  });

  test("enforces missing, equal, older, newer, and prerelease manifest minimums", async () => {
    await expect(assertManifestCompatibility(manifest())).resolves.toBeUndefined();
    await expect(assertManifestCompatibility(manifest("1.0.8"))).resolves.toBeUndefined();
    await expect(assertManifestCompatibility(manifest("1.0.7"))).resolves.toBeUndefined();
    await expect(assertManifestCompatibility(manifest("1.0.8-0"))).resolves.toBeUndefined();
    await expect(assertManifestCompatibility(manifest("1.0.8+build.1"))).resolves.toBeUndefined();
    await expect(assertManifestCompatibility(manifest("1.0.9-0"))).rejects.toMatchObject({
      code: SPINDLE_COMPATIBILITY_ERROR_CODE,
    });
    await expect(assertManifestCompatibility(manifest("1.0.9"))).rejects.toBeInstanceOf(
      SpindleCompatibilityError,
    );
    await expect(assertManifestCompatibility(manifest("v1.0.8"))).rejects.toBeInstanceOf(
      SpindleCompatibilityError,
    );
  });
});
