import {
  SPINDLE_COMPATIBILITY_ERROR_CODE,
  SPINDLE_HOST_CAPABILITIES,
  type SpindleHostDescriptorV1,
  type SpindleHostLocale,
  type SpindleHostLocaleAPI,
} from 'lumiverse-spindle-types'

export {
  SPINDLE_COMPATIBILITY_ERROR_CODE,
  SPINDLE_HOST_CAPABILITIES,
}
export type { SpindleHostDescriptorV1, SpindleHostLocale, SpindleHostLocaleAPI }

const CANONICAL_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CAPABILITY_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export interface ParsedCanonicalSemver {
  readonly source: string
  readonly major: string
  readonly minor: string
  readonly patch: string
  readonly prerelease: readonly string[]
}

export class SpindleCompatibilityError extends Error {
  readonly code = SPINDLE_COMPATIBILITY_ERROR_CODE

  constructor(message: string) {
    super(message)
    this.name = 'SpindleCompatibilityError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** Recognize local validation failures and API errors that preserve the compatibility code. */
export function isSpindleCompatibilityError(error: unknown): boolean {
  if (error instanceof SpindleCompatibilityError) return true
  if (error === null || typeof error !== 'object') return false
  if ('code' in error && error.code === SPINDLE_COMPATIBILITY_ERROR_CODE) return true
  if (!('body' in error)) return false
  const body = error.body
  return body !== null
    && typeof body === 'object'
    && 'code' in body
    && body.code === SPINDLE_COMPATIBILITY_ERROR_CODE
}

function fail(message: string): never {
  throw new SpindleCompatibilityError(message)
}

export function parseCanonicalSemver(value: unknown, label: string): ParsedCanonicalSemver {
  if (typeof value !== 'string') {
    return fail(`${label} must be a canonical semantic version`)
  }
  const match = CANONICAL_SEMVER.exec(value)
  if (!match) {
    return fail(`${label} must be a canonical semantic version`)
  }
  return Object.freeze({
    source: value,
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: Object.freeze(match[4] ? match[4].split('.') : []),
  })
}

function compareNumericStrings(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1
  }
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1
    if (a === b) continue
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      const numericComparison = compareNumericStrings(a, b)
      if (numericComparison !== 0) return numericComparison
      continue
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return a < b ? -1 : 1
  }
  return 0
}

export function compareCanonicalSemver(left: string, right: string): number {
  const a = parseCanonicalSemver(left, 'version')
  const b = parseCanonicalSemver(right, 'version')
  for (const key of ['major', 'minor', 'patch'] as const) {
    const comparison = compareNumericStrings(a[key], b[key])
    if (comparison !== 0) return comparison
  }
  return comparePrerelease(a.prerelease, b.prerelease)
}

function assertCanonicalInstallationId(value: unknown, label = 'Extension installation ID'): asserts value is string {
  if (typeof value !== 'string' || !CANONICAL_UUID.test(value)) {
    return fail(`${label} must be a canonical lowercase UUID`)
  }
}

/**
 * Validate and clone a host descriptor. The returned object is independent of
 * the response payload and deeply immutable, including unknown capabilities.
 */
export function validateSpindleHostDescriptor(
  value: unknown,
  expectedInstallationId?: string,
): SpindleHostDescriptorV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('Spindle host descriptor must be an object')
  }
  const descriptor = value as Record<string, unknown>
  if (descriptor.descriptorVersion !== 1) {
    return fail('Unsupported Spindle host descriptor version')
  }
  const lumiverseVersion = parseCanonicalSemver(descriptor.lumiverseVersion, 'Lumiverse version').source
  assertCanonicalInstallationId(descriptor.extensionInstallationId)
  if (expectedInstallationId !== undefined) {
    assertCanonicalInstallationId(expectedInstallationId, 'Expected extension installation ID')
    if (descriptor.extensionInstallationId !== expectedInstallationId) {
      return fail('Spindle host descriptor installation ID does not match the extension being loaded')
    }
  }

  const rawCapabilities = descriptor.capabilities
  if (rawCapabilities === null || typeof rawCapabilities !== 'object' || Array.isArray(rawCapabilities)) {
    return fail('Spindle host capabilities must be an object')
  }
  const capabilities: Record<string, number> = {}
  for (const [name, version] of Object.entries(rawCapabilities)) {
    if (!CAPABILITY_NAME.test(name)) {
      return fail(`Invalid Spindle host capability name: ${name}`)
    }
    if (!Number.isSafeInteger(version) || version <= 0) {
      return fail(`Invalid Spindle host capability version: ${name}`)
    }
    capabilities[name] = version
  }
  for (const [name, version] of Object.entries(SPINDLE_HOST_CAPABILITIES)) {
    if (capabilities[name] !== version) {
      return fail(`Missing or incompatible Spindle host capability: ${name}`)
    }
  }

  return Object.freeze({
    descriptorVersion: 1,
    lumiverseVersion,
    capabilities: Object.freeze(capabilities),
    extensionInstallationId: descriptor.extensionInstallationId,
  })
}

/** Construct the immutable descriptor used by local compatibility tests and hosts without a handshake. */
export function createSpindleHostDescriptor(
  extensionInstallationId: string,
  lumiverseVersion: unknown,
): SpindleHostDescriptorV1 {
  return validateSpindleHostDescriptor({
    descriptorVersion: 1,
    lumiverseVersion,
    capabilities: { ...SPINDLE_HOST_CAPABILITIES },
    extensionInstallationId,
  }, extensionInstallationId)
}

/** Validate an optional manifest minimum against a canonical host version. */
export function assertManifestCompatibility(
  manifest: unknown,
  lumiverseVersion: unknown,
): void {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return fail('Spindle manifest must be an object')
  }
  const minimum = (manifest as Record<string, unknown>).minimum_lumiverse_version
  if (minimum === undefined) return
  const current = parseCanonicalSemver(lumiverseVersion, 'Lumiverse version').source
  const required = parseCanonicalSemver(minimum, 'minimum_lumiverse_version').source
  if (compareCanonicalSemver(current, required) < 0) {
    const identifier = typeof (manifest as Record<string, unknown>).identifier === 'string'
      ? (manifest as Record<string, unknown>).identifier
      : '(unknown)'
    return fail(`Extension ${identifier} requires Lumiverse ${required} or newer; this host is ${current}`)
  }
}

/** Validate local load inputs before any extension source or host work begins. */
export function validateFrontendExtensionCompatibility(
  extensionInstallationId: string,
  manifest: unknown,
  lumiverseVersion: unknown,
): SpindleHostDescriptorV1 {
  const descriptor = createSpindleHostDescriptor(extensionInstallationId, lumiverseVersion)
  assertManifestCompatibility(manifest, descriptor.lumiverseVersion)
  return descriptor
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

/** Generate the bounded generic host handshake nonce (32 random bytes). */
export function generateSpindleCompatibilityNonce(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

/** Serialize all validated capabilities in deterministic ASCII-key order. */
export function serializeSpindleHostDescriptor(descriptor: SpindleHostDescriptorV1): string {
  const normalized = validateSpindleHostDescriptor(descriptor)
  const sortedCapabilities = Object.entries(normalized.capabilities)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, version]) => [name, version] as const)
  return JSON.stringify([
    normalized.descriptorVersion,
    normalized.lumiverseVersion,
    normalized.extensionInstallationId,
    sortedCapabilities,
  ])
}

/** SHA-256 digest used by the generic host-owned compatibility handshake. */
export async function digestSpindleHostDescriptor(descriptor: SpindleHostDescriptorV1): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(serializeSpindleHostDescriptor(descriptor)),
  )
  return base64UrlEncode(new Uint8Array(digest))
}
