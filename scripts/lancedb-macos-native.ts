import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Updating the npm dependency requires rebuilding and testing this exact source.
export const INTEL_LANCEDB = {
  version: "0.41.0",
  sourceCommit: "3936a8b3bcce8f8e073f3ec6a47e4ca4d3381b92",
  target: "x86_64-apple-darwin",
  rustToolchain: "1.97.0",
  minimumMacOS: "13.0",
  cpu: "x86-64",
  binaryName: "lancedb.darwin-x64.node",
  // Bump only for compilation changes not represented by the policy below.
  buildRevision: 2,
} as const;

export const INTEL_LANCEDB_RELEASE_PROFILE = {
  lto: "thin", codegenUnits: 16, strip: "none", buildOverrideStrip: "none", buildOverrideDebug: 1, incremental: false,
} as const;

/** Stable across application, workflow, and validation-only changes. */
export function intelLanceDbBuildId(
  policy: { [K in keyof typeof INTEL_LANCEDB]: string | number } = INTEL_LANCEDB,
  profile: { [K in keyof typeof INTEL_LANCEDB_RELEASE_PROFILE]: string | number | boolean } = INTEL_LANCEDB_RELEASE_PROFILE,
): string {
  return createHash("sha256").update(JSON.stringify({ policy, profile })).digest("hex");
}

// The first verified CI build predates buildId in manifest.json. Accept it only
// for this exact original recipe, so changing build settings cannot adopt it.
const LEGACY_BUILD_ID = "437cd5aee067c3949e41f3f64eacae668b1e011fbeae1203f0050fe496528c12";

export interface IntelLanceDbManifest {
  format: 1;
  buildId?: string;
  version: string;
  sourceCommit: string;
  target: string;
  rustToolchain: string;
  minimumMacOS: string;
  cpu: string;
  sha256: string;
}

/** Reject ARM binaries, non-dylibs, and builds requiring newer macOS. */
export function validateIntelMachO(bytes: Uint8Array): void {
  const binary = Buffer.from(bytes);
  if (binary.length < 32 || binary.readUInt32LE(0) !== 0xfeedfacf
    || binary.readUInt32LE(4) !== 0x01000007 || (binary.readUInt32LE(8) & 0x00ffffff) !== 3
    || binary.readUInt32LE(12) !== 6) {
    throw new Error("LanceDB must be an x86_64 macOS dynamic library.");
  }
  let offset = 32;
  let minimum: number | undefined;
  for (let i = 0; i < binary.readUInt32LE(16); i++) {
    if (offset + 8 > binary.length) throw new Error("Truncated LanceDB Mach-O commands.");
    const command = binary.readUInt32LE(offset);
    const size = binary.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > binary.length) throw new Error("Invalid LanceDB Mach-O command.");
    if (command === 0x32 && size >= 24) {
      if (binary.readUInt32LE(offset + 8) !== 1) throw new Error("LanceDB is not a macOS library.");
      minimum = binary.readUInt32LE(offset + 12);
    } else if (command === 0x24 && size >= 16) minimum = binary.readUInt32LE(offset + 8);
    offset += size;
  }
  if (minimum === undefined || minimum > (13 << 16)) {
    throw new Error("Intel LanceDB must support macOS 13.0.");
  }
}

export function readIntelLanceDbArtifact(directory: string, packageVersion: string): IntelLanceDbManifest {
  if (packageVersion !== INTEL_LANCEDB.version) throw new Error("Update the Intel LanceDB source pin to match the npm dependency.");
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as IntelLanceDbManifest;
  if (manifest.format !== 1 || manifest.version !== packageVersion
    || manifest.sourceCommit !== INTEL_LANCEDB.sourceCommit || manifest.target !== INTEL_LANCEDB.target
    || manifest.rustToolchain !== INTEL_LANCEDB.rustToolchain || manifest.minimumMacOS !== INTEL_LANCEDB.minimumMacOS
    || manifest.cpu !== INTEL_LANCEDB.cpu
    || (manifest.buildId ?? LEGACY_BUILD_ID) !== intelLanceDbBuildId()) throw new Error("The Intel LanceDB artifact does not match the pinned build policy.");
  const bytes = readFileSync(join(directory, INTEL_LANCEDB.binaryName));
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) throw new Error("Intel LanceDB checksum mismatch.");
  validateIntelMachO(bytes);
  return manifest;
}

/** Install next to native.js so every server, worker, and subprocess uses its normal loader. */
export function stageIntelLanceDb(appDirectory: string, artifactDirectory: string): IntelLanceDbManifest {
  const packageDirectory = join(appDirectory, "node_modules/@lancedb/lancedb");
  const version = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")).version;
  const manifest = readIntelLanceDbArtifact(artifactDirectory, version);
  const destination = join(packageDirectory, "dist");
  mkdirSync(destination, { recursive: true });
  copyFileSync(join(artifactDirectory, INTEL_LANCEDB.binaryName), join(destination, INTEL_LANCEDB.binaryName));
  copyFileSync(join(artifactDirectory, "manifest.json"), join(destination, "lancedb.darwin-x64.build.json"));
  copyFileSync(join(artifactDirectory, "LICENSE"), join(destination, "lancedb.darwin-x64.LICENSE"));
  return manifest;
}
