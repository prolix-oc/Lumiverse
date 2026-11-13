import { describe, expect, test } from "bun:test";
import {
  DEFAULT_APPLICATION_NAME,
  EXTENSION_INSTALL_CAPABILITY,
  ILLARIN_ACCEPTED_TARGETS,
  ILLARIN_CAPABILITIES,
  assertDeclarationWireLimits,
  buildDeclaration,
  buildDeclarationUpdate,
} from "./declaration";
import {
  DECLARATION_LIMITS,
  ILLARIN_CAPABILITY_NAMESPACE,
  ILLARIN_PROTOCOL_VERSION,
  type IllarinDeclaration,
} from "./types";

const VALID_INPUT = {
  instanceName: "studio workstation",
  scopes: ["work:receive", "library:sync"] as const,
};

describe("buildDeclaration", () => {
  test("stamps protocol version, namespaced capabilities, and ordered targets", () => {
    const declaration = buildDeclaration(VALID_INPUT);
    expect(declaration.appName).toBe(DEFAULT_APPLICATION_NAME);
    expect(declaration.protocolVersion).toBe(ILLARIN_PROTOCOL_VERSION);
    expect(declaration.capabilities).toEqual([
      "chat.lumiverse:character-import",
      "chat.lumiverse:worldbook-import",
      "chat.lumiverse:preset-install",
      "chat.lumiverse:theme-install",
    ]);
    expect(declaration.acceptedFormats).toEqual([
      "charx",
      "chara_card_v3",
      "chara_card_v2",
      "lorebook",
      "lorebook_sillytavern",
      "preset_lumiverse",
      "theme_lumiverse",
      "pack_lumiverse",
      "extension_spindle",
    ]);
  });

  test("declares extension installs only for an installation that can install them", () => {
    expect(buildDeclaration(VALID_INPUT).capabilities).not.toContain(EXTENSION_INSTALL_CAPABILITY);
    expect(buildDeclaration({ ...VALID_INPUT, installsExtensions: true }).capabilities)
      .toContain("chat.lumiverse:extension-install");
  });

  test("never declares SillyTavern themes — Lumiverse does not accept them", () => {
    expect(ILLARIN_ACCEPTED_TARGETS).not.toContain("theme_sillytavern");
    expect(buildDeclaration(VALID_INPUT).acceptedFormats).not.toContain("theme_sillytavern");
  });

  test("sends exactly the documented fields — Illarin rejects unknown fields", () => {
    const withoutVersion = Object.keys(buildDeclaration(VALID_INPUT)).sort();
    expect(withoutVersion).toEqual([
      "acceptedFormats",
      "appName",
      "capabilities",
      "name",
      "permissions",
      "protocolVersion",
    ]);

    const withVersion = Object.keys(
      buildDeclaration({ ...VALID_INPUT, applicationVersion: "1.0.0" }),
    ).sort();
    expect(withVersion).toEqual([
      "acceptedFormats",
      "appName",
      "appVersion",
      "capabilities",
      "name",
      "permissions",
      "protocolVersion",
    ]);
  });

  test("trims names and preserves a provided application name and version", () => {
    const declaration = buildDeclaration({
      applicationName: "  Lumiverse  ",
      instanceName: "  render box  ",
      applicationVersion: " 1.1.6 ",
      scopes: ["work:receive"],
    });
    expect(declaration.appName).toBe("Lumiverse");
    expect(declaration.name).toBe("render box");
    expect(declaration.appVersion).toBe("1.1.6");
  });

  test("rejects names that are empty, oversized, or non-printable", () => {
    expect(() => buildDeclaration({ instanceName: "   ", scopes: [] })).toThrow(RangeError);
    expect(() =>
      buildDeclaration({ instanceName: "x".repeat(DECLARATION_LIMITS.nameMaxChars + 1), scopes: [] }),
    ).toThrow(RangeError);
    expect(() =>
      buildDeclaration({ instanceName: "bad\u0007bell", scopes: [] }),
    ).toThrow(/printable/);
    expect(() =>
      buildDeclaration({ instanceName: "ok", applicationVersion: "v".repeat(DECLARATION_LIMITS.versionMaxChars + 1), scopes: [] }),
    ).toThrow(RangeError);
  });

  test("accepts names at the exact limit", () => {
    const declaration = buildDeclaration({
      instanceName: "y".repeat(DECLARATION_LIMITS.nameMaxChars),
      scopes: [],
    });
    expect(declaration.name).toHaveLength(DECLARATION_LIMITS.nameMaxChars);
  });

  test("rejects unknown scopes", () => {
    expect(() =>
      buildDeclaration({ instanceName: "ok", scopes: ["work:receive", "admin:everything"] as never }),
    ).toThrow(/permission/);
  });
});

describe("assertDeclarationWireLimits", () => {
  function oversizeDeclaration(): IllarinDeclaration {
    // Valid-format entries at near-maximum size: 32 capabilities and 32
    // targets of ~62-64 characters push the serialized body past 4 KiB
    // while passing every per-entry format check.
    const capability = (index: number) =>
      `${ILLARIN_CAPABILITY_NAMESPACE}:${"c".repeat(46)}${String(index).padStart(2, "0")}`;
    const target = (index: number) =>
      `target${"a".repeat(55)}${String(index).padStart(2, "0")}`;
    return {
      appName: "Lumiverse",
      name: "bulk",
      protocolVersion: 1,
      capabilities: Array.from({ length: DECLARATION_LIMITS.maxArrayEntries }, (_, i) => capability(i)),
      acceptedFormats: Array.from({ length: DECLARATION_LIMITS.maxArrayEntries }, (_, i) => target(i)),
      permissions: ["work:receive", "library:sync"],
    };
  }

  test("enforces the 4 KiB request-body bound", () => {
    expect(() => assertDeclarationWireLimits(oversizeDeclaration())).toThrow(/bytes/);
  });

  test("rejects more than 32 array entries", () => {
    const declaration = oversizeDeclaration();
    declaration.acceptedFormats = Array.from({ length: DECLARATION_LIMITS.maxArrayEntries + 1 }, (_, i) => `t${i}`);
    expect(() => assertDeclarationWireLimits(declaration)).toThrow(/32/);
  });

  test("rejects duplicate array entries", () => {
    const declaration = buildDeclaration(VALID_INPUT);
    declaration.acceptedFormats = [...declaration.acceptedFormats, "chara_card_v3"];
    expect(() => assertDeclarationWireLimits(declaration)).toThrow(/unique/);
  });

  test("rejects entries over 64 characters", () => {
    const declaration = buildDeclaration(VALID_INPUT);
    declaration.capabilities = [`chat.lumiverse:${"c".repeat(60)}`];
    expect(() => assertDeclarationWireLimits(declaration)).toThrow(RangeError);
  });

  test("rejects targets that are not lowercase module IDs", () => {
    const declaration = buildDeclaration(VALID_INPUT);
    declaration.acceptedFormats = ["Chara_Card_V3"];
    expect(() => assertDeclarationWireLimits(declaration)).toThrow(/lowercase module ID/);
  });

  test("rejects capabilities without a namespace:name split", () => {
    const declaration = buildDeclaration(VALID_INPUT);
    declaration.capabilities = ["no-namespace-here"];
    expect(() => assertDeclarationWireLimits(declaration)).toThrow(/namespace/);
  });

  test("rejects a protocol version other than 1", () => {
    const declaration = buildDeclaration(VALID_INPUT);
    declaration.protocolVersion = 2;
    expect(() => assertDeclarationWireLimits(declaration)).toThrow(/protocolVersion/);
  });
});

describe("buildDeclarationUpdate", () => {
  test("omits names and scopes — the update endpoint cannot change them", () => {
    const declaration = buildDeclaration({ ...VALID_INPUT, applicationVersion: "1.1.6" });
    const update = buildDeclarationUpdate(declaration);
    expect(Object.keys(update).sort()).toEqual([
      "acceptedFormats",
      "appVersion",
      "capabilities",
      "protocolVersion",
    ]);
    expect(update.appVersion).toBe("1.1.6");
  });

  test("returns copies — mutating the update cannot leak into the declaration", () => {
    const declaration = buildDeclaration(VALID_INPUT);
    const update = buildDeclarationUpdate(declaration);
    update.acceptedFormats.push("raw");
    update.capabilities.push("rogue:capability");
    expect(declaration.acceptedFormats).toEqual([...ILLARIN_ACCEPTED_TARGETS]);
    expect(declaration.capabilities).toEqual([...ILLARIN_CAPABILITIES]);
  });
});
