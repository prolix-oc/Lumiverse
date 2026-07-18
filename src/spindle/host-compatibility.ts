import { readFileSync } from "fs";
import { join } from "path";
import type {
  SpindleHostDescriptorV1,
  SpindleManifest,
} from "lumiverse-spindle-types";
import {
  SPINDLE_COMPATIBILITY_ERROR_CODE,
  SPINDLE_HOST_CAPABILITIES,
} from "lumiverse-spindle-types";

export type ParsedCanonicalSemver = Readonly<{
  source: string;
  major: string;
  minor: string;
  patch: string;
  prerelease: readonly string[];
}>;

const CANONICAL_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAPABILITY_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

let backendVersion: Promise<string> | null = null;
let backendVersionSync: string | null = null;
let frontendVersion: Promise<string> | null = null;

export class SpindleCompatibilityError extends Error {
  readonly code: typeof SPINDLE_COMPATIBILITY_ERROR_CODE = SPINDLE_COMPATIBILITY_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "SpindleCompatibilityError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function parseCanonicalSemver(value: unknown, label: string): ParsedCanonicalSemver {
  if (typeof value !== "string") {
    throw new SpindleCompatibilityError(`${label} must be a canonical semantic version`);
  }

  const match = CANONICAL_SEMVER.exec(value);
  if (!match) {
    throw new SpindleCompatibilityError(`${label} must be a canonical semantic version`);
  }

  return Object.freeze({
    source: value,
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: Object.freeze(match[4] ? match[4].split(".") : []),
  });
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) {
      return a === b ? 0 : a === undefined ? -1 : 1;
    }
    if (a === b) continue;

    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const order = compareNumericIdentifier(a, b);
      if (order !== 0) return order;
      continue;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }

  return 0;
}

export function compareCanonicalSemver(left: string, right: string): number {
  const a = parseCanonicalSemver(left, "version");
  const b = parseCanonicalSemver(right, "version");

  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return compareNumericIdentifier(a[key], b[key]);
  }

  return comparePrerelease(a.prerelease, b.prerelease);
}

function assertCanonicalInstallationId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !CANONICAL_UUID.test(value)) {
    throw new SpindleCompatibilityError(
      "Extension installation ID must be a canonical lowercase UUID",
    );
  }
}

export function validateSpindleHostDescriptor(value: unknown): SpindleHostDescriptorV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SpindleCompatibilityError("Spindle host descriptor must be an object");
  }

  const descriptor = value as Record<string, unknown>;
  if (descriptor.descriptorVersion !== 1) {
    throw new SpindleCompatibilityError("Unsupported Spindle host descriptor version");
  }

  const lumiverseVersion = parseCanonicalSemver(
    descriptor.lumiverseVersion,
    "Lumiverse version",
  ).source;
  assertCanonicalInstallationId(descriptor.extensionInstallationId);

  const rawCapabilities = descriptor.capabilities;
  if (
    rawCapabilities === null ||
    typeof rawCapabilities !== "object" ||
    Array.isArray(rawCapabilities)
  ) {
    throw new SpindleCompatibilityError("Spindle host capabilities must be an object");
  }

  const capabilities: Record<string, number> = {};
  for (const [name, version] of Object.entries(rawCapabilities)) {
    if (!CAPABILITY_NAME.test(name)) {
      throw new SpindleCompatibilityError(`Invalid Spindle host capability name: ${name}`);
    }
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw new SpindleCompatibilityError(`Invalid Spindle host capability version: ${name}`);
    }
    capabilities[name] = version;
  }

  for (const [name, version] of Object.entries(SPINDLE_HOST_CAPABILITIES)) {
    if (capabilities[name] !== version) {
      throw new SpindleCompatibilityError(
        `Missing or incompatible Spindle host capability: ${name}`,
      );
    }
  }

  return Object.freeze({
    descriptorVersion: 1,
    lumiverseVersion,
    capabilities: Object.freeze(capabilities),
    extensionInstallationId: descriptor.extensionInstallationId,
  });
}

async function readPackageVersion(relativePath: string): Promise<string> {
  const raw = await Bun.file(join(import.meta.dir, relativePath)).text();
  const pkg = JSON.parse(raw) as { version?: unknown };
  return parseCanonicalSemver(pkg.version, `${relativePath} version`).source;
}

function readPackageVersionSync(relativePath: string): string {
  const raw = readFileSync(join(import.meta.dir, relativePath), "utf8");
  const pkg = JSON.parse(raw) as { version?: unknown };
  return parseCanonicalSemver(pkg.version, `${relativePath} version`).source;
}

export function getBackendLumiverseVersion(): Promise<string> {
  backendVersion ??= readPackageVersion("../../package.json");
  return backendVersion;
}

export function getBackendLumiverseVersionSync(): string {
  backendVersionSync ??= readPackageVersionSync("../../package.json");
  return backendVersionSync;
}

export function getFrontendLumiverseVersion(): Promise<string> {
  frontendVersion ??= readPackageVersion("../../frontend/package.json");
  return frontendVersion;
}

function readMinimumVersion(manifest: SpindleManifest): unknown {
  return (manifest as unknown as Record<string, unknown>).minimum_lumiverse_version;
}

export async function assertManifestCompatibility(manifest: SpindleManifest): Promise<void> {
  const minimum = readMinimumVersion(manifest);
  if (minimum === undefined) return;

  const required = parseCanonicalSemver(minimum, "minimum_lumiverse_version").source;
  const current = await getBackendLumiverseVersion();
  if (compareCanonicalSemver(current, required) < 0) {
    throw new SpindleCompatibilityError(
      `Extension ${manifest.identifier || "(unknown)"} requires Lumiverse ${required} or newer; this host is ${current}`,
    );
  }
}

export function assertManifestCompatibilitySync(manifest: SpindleManifest): void {
  const minimum = readMinimumVersion(manifest);
  if (minimum === undefined) return;

  const required = parseCanonicalSemver(minimum, "minimum_lumiverse_version").source;
  const current = getBackendLumiverseVersionSync();
  if (compareCanonicalSemver(current, required) < 0) {
    throw new SpindleCompatibilityError(
      `Extension ${manifest.identifier || "(unknown)"} requires Lumiverse ${required} or newer; this host is ${current}`,
    );
  }
}

export async function createSpindleHostDescriptor(
  extensionInstallationId: string,
): Promise<SpindleHostDescriptorV1> {
  assertCanonicalInstallationId(extensionInstallationId);

  const descriptor = {
    descriptorVersion: 1,
    lumiverseVersion: await getBackendLumiverseVersion(),
    capabilities: Object.freeze({ ...SPINDLE_HOST_CAPABILITIES }),
    extensionInstallationId,
  } satisfies SpindleHostDescriptorV1;

  return Object.freeze(descriptor);
}

export function serializeSpindleHostDescriptor(
  descriptor: SpindleHostDescriptorV1,
): string {
  const normalized = validateSpindleHostDescriptor(descriptor);
  const sortedCapabilities = Object.entries(normalized.capabilities)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, version]) => [name, version] as const);

  return JSON.stringify([
    normalized.descriptorVersion,
    normalized.lumiverseVersion,
    normalized.extensionInstallationId,
    sortedCapabilities,
  ]);
}

export async function digestSpindleHostDescriptor(
  descriptor: SpindleHostDescriptorV1,
): Promise<string> {
  const serialized = serializeSpindleHostDescriptor(descriptor);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serialized),
  );
  return Buffer.from(digest).toString("base64url");
}
