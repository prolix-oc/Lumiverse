import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTEL_LANCEDB, INTEL_LANCEDB_RELEASE_PROFILE, intelLanceDbBuildId, readIntelLanceDbArtifact, stageIntelLanceDb, validateIntelMachO, type IntelLanceDbManifest } from "../scripts/lancedb-macos-native";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function artifact() {
  const directory = mkdtempSync(join(tmpdir(), "lumiverse-native-artifact-"));
  temporary.push(directory);
  const binary = Buffer.alloc(56);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(0x01000007, 4);
  binary.writeUInt32LE(3, 8);
  binary.writeUInt32LE(6, 12);
  binary.writeUInt32LE(1, 16);
  binary.writeUInt32LE(24, 20);
  binary.writeUInt32LE(0x32, 32);
  binary.writeUInt32LE(24, 36);
  binary.writeUInt32LE(1, 40);
  binary.writeUInt32LE(13 << 16, 44);
  const manifest: IntelLanceDbManifest = {
    format: 1, buildId: intelLanceDbBuildId(), version: INTEL_LANCEDB.version, sourceCommit: INTEL_LANCEDB.sourceCommit,
    target: INTEL_LANCEDB.target, rustToolchain: INTEL_LANCEDB.rustToolchain,
    minimumMacOS: INTEL_LANCEDB.minimumMacOS, cpu: INTEL_LANCEDB.cpu,
    sha256: createHash("sha256").update(binary).digest("hex"),
  };
  writeFileSync(join(directory, INTEL_LANCEDB.binaryName), binary);
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(directory, "LICENSE"), "license fixture");
  return { directory, binary, manifest };
}

test("stages the version-matched Intel addon at the normal native loader path", () => {
  const fixture = artifact();
  const app = join(fixture.directory, "app");
  const pkg = join(app, "node_modules/@lancedb/lancedb");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: INTEL_LANCEDB.version }));
  expect(stageIntelLanceDb(app, fixture.directory)).toEqual(fixture.manifest);
  expect(readFileSync(join(pkg, "dist", INTEL_LANCEDB.binaryName))).toEqual(fixture.binary);
  expect(JSON.parse(readFileSync(join(pkg, "dist/lancedb.darwin-x64.build.json"), "utf8"))).toEqual(fixture.manifest);
  expect(readFileSync(join(pkg, "dist/lancedb.darwin-x64.LICENSE"), "utf8")).toBe("license fixture");
});

test("rejects stale npm versions, source revisions, and modified native binaries", () => {
  const fixture = artifact();
  expect(() => readIntelLanceDbArtifact(fixture.directory, "0.36.0")).toThrow("source pin");
  writeFileSync(join(fixture.directory, "manifest.json"), JSON.stringify({ ...fixture.manifest, sourceCommit: "wrong" }));
  expect(() => readIntelLanceDbArtifact(fixture.directory, INTEL_LANCEDB.version)).toThrow("build policy");
  writeFileSync(join(fixture.directory, "manifest.json"), JSON.stringify({ ...fixture.manifest, buildId: "wrong-recipe" }));
  expect(() => readIntelLanceDbArtifact(fixture.directory, INTEL_LANCEDB.version)).toThrow("build policy");
  writeFileSync(join(fixture.directory, "manifest.json"), JSON.stringify(fixture.manifest));
  writeFileSync(join(fixture.directory, INTEL_LANCEDB.binaryName), Buffer.concat([fixture.binary, Buffer.from("modified")]));
  expect(() => readIntelLanceDbArtifact(fixture.directory, INTEL_LANCEDB.version)).toThrow("checksum");
});

test("dependency identity follows source and compilation policy without hashing application or test files", () => {
  const original = intelLanceDbBuildId();
  expect(intelLanceDbBuildId({ ...INTEL_LANCEDB }, { ...INTEL_LANCEDB_RELEASE_PROFILE })).toBe(original);
  for (const key of ["version", "sourceCommit", "rustToolchain", "minimumMacOS", "cpu", "buildRevision"] as const) {
    expect(intelLanceDbBuildId({ ...INTEL_LANCEDB, [key]: `${INTEL_LANCEDB[key]}-changed` })).not.toBe(original);
  }
  expect(intelLanceDbBuildId(INTEL_LANCEDB, { ...INTEL_LANCEDB_RELEASE_PROFILE, lto: "off" })).not.toBe(original);
  expect(intelLanceDbBuildId(INTEL_LANCEDB, { ...INTEL_LANCEDB_RELEASE_PROFILE, codegenUnits: 32 })).not.toBe(original);
  // Only the original 0.37.1 recipe may adopt artifacts without a build ID.
  expect(original).not.toBe("437cd5aee067c3949e41f3f64eacae668b1e011fbeae1203f0050fe496528c12");
});

test("rejects a new dependency artifact without its exact build identity", () => {
  const fixture = artifact();
  const { buildId, ...withoutIdentity } = fixture.manifest;
  writeFileSync(join(fixture.directory, "manifest.json"), JSON.stringify(withoutIdentity));
  expect(() => readIntelLanceDbArtifact(fixture.directory, INTEL_LANCEDB.version)).toThrow("build policy");
});

test("rejects the wrong architecture, newer macOS requirements, and truncated Mach-O files", () => {
  const { binary } = artifact();
  const arm = Buffer.from(binary);
  arm.writeUInt32LE(0x0100000c, 4);
  expect(() => validateIntelMachO(arm)).toThrow("x86_64");
  const haswellOnly = Buffer.from(binary);
  haswellOnly.writeUInt32LE(8, 8);
  expect(() => validateIntelMachO(haswellOnly)).toThrow("x86_64");
  const newer = Buffer.from(binary);
  newer.writeUInt32LE(14 << 16, 44);
  expect(() => validateIntelMachO(newer)).toThrow("macOS 13.0");
  expect(() => validateIntelMachO(binary.subarray(0, 40))).toThrow("command");
  expect(() => validateIntelMachO(Buffer.from("ELF binary"))).toThrow("x86_64");
});

test("a mismatched staged npm dependency cannot receive the addon", () => {
  const fixture = artifact();
  const app = join(fixture.directory, "app");
  const pkg = join(app, "node_modules/@lancedb/lancedb");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "0.38.0" }));
  expect(() => stageIntelLanceDb(app, fixture.directory)).toThrow("source pin");
  expect(existsSync(join(pkg, "dist", INTEL_LANCEDB.binaryName))).toBe(false);
});
