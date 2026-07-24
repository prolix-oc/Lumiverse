import { describe, expect, test } from 'bun:test'
import {
  SPINDLE_COMPATIBILITY_ERROR_CODE,
  SPINDLE_HOST_CAPABILITIES,
  SpindleCompatibilityError,
  assertManifestCompatibility,
  compareCanonicalSemver,
  createSpindleHostDescriptor,
  digestSpindleHostDescriptor,
  isSpindleCompatibilityError,
  parseCanonicalSemver,
  serializeSpindleHostDescriptor,
  validateSpindleHostDescriptor,
} from './host-compatibility'

const INSTALLATION_ID = '123e4567-e89b-42d3-a456-426614174000'
const LUMIVERSE_VERSION = '1.0.8'

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    descriptorVersion: 1,
    lumiverseVersion: LUMIVERSE_VERSION,
    capabilities: { ...SPINDLE_HOST_CAPABILITIES },
    extensionInstallationId: INSTALLATION_ID,
    ...overrides,
  }
}

describe('frontend Spindle host compatibility', () => {
  test('parses canonical SemVer and compares unbounded numeric identifiers', () => {
    const huge = '999999999999999999999999999999.0.0'
    expect(parseCanonicalSemver(huge, 'version').source).toBe(huge)
    expect(compareCanonicalSemver(huge, '2.0.0')).toBe(1)
    expect(compareCanonicalSemver('1.0.0-alpha.10', '1.0.0-alpha.2')).toBe(1)
    expect(compareCanonicalSemver('1.0.0-alpha', '1.0.0')).toBe(-1)
    expect(compareCanonicalSemver('1.0.0+one', '1.0.0+two')).toBe(0)
  })

  test('rejects malformed and noncanonical descriptor fields', () => {
    const missing = { ...SPINDLE_HOST_CAPABILITIES } as Record<string, number>
    delete missing['interceptor-final-response-v1']
    for (const value of [
      descriptor({ descriptorVersion: 2 }),
      descriptor({ lumiverseVersion: 'v1.0.8' }),
      descriptor({ extensionInstallationId: INSTALLATION_ID.toUpperCase() }),
      descriptor({ extensionInstallationId: '123e4567-e89b-02d3-a456-426614174000' }),
      descriptor({ capabilities: missing }),
      descriptor({ capabilities: { ...SPINDLE_HOST_CAPABILITIES, 'interceptor-final-response-v1': 2 } }),
      descriptor({ capabilities: { ...SPINDLE_HOST_CAPABILITIES, 'Bad Key': 1 } }),
      descriptor({ capabilities: { ...SPINDLE_HOST_CAPABILITIES, 'future-v1': 0 } }),
    ]) {
      expect(() => validateSpindleHostDescriptor(value)).toThrow(SpindleCompatibilityError)
    }
  })

  test('requires the loaded installation ID and permits valid unknown capabilities', () => {
    const value = validateSpindleHostDescriptor({
      ...descriptor(),
      capabilities: { ...SPINDLE_HOST_CAPABILITIES, 'future-capability-v2': 3 },
    }, INSTALLATION_ID)
    expect(value.capabilities['future-capability-v2']).toBe(3)
    expect(() => validateSpindleHostDescriptor(descriptor(), '123e4567-e89b-42d3-a456-426614174001')).toThrow(SpindleCompatibilityError)
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.capabilities)).toBe(true)
    expect(() => {
      ;(value.capabilities as Record<string, number>)['future-capability-v2'] = 4
    }).toThrow()
  })

  test('creates a deeply immutable descriptor from package constants', () => {
    const value = createSpindleHostDescriptor(INSTALLATION_ID, LUMIVERSE_VERSION)
    expect(value).toMatchObject({
      descriptorVersion: 1,
      lumiverseVersion: LUMIVERSE_VERSION,
      extensionInstallationId: INSTALLATION_ID,
    })
    expect(Object.keys(value.capabilities).sort()).toEqual(Object.keys(SPINDLE_HOST_CAPABILITIES).sort())
  })

  test('keeps omitted minimum backward compatible and rejects malformed or too-new minimums', () => {
    expect(() => assertManifestCompatibility({ identifier: 'compat_test' }, LUMIVERSE_VERSION)).not.toThrow()
    expect(() => assertManifestCompatibility({ identifier: 'compat_test', minimum_lumiverse_version: '1.0.8' }, LUMIVERSE_VERSION)).not.toThrow()
    expect(() => assertManifestCompatibility({ identifier: 'compat_test', minimum_lumiverse_version: '1.0.9' }, LUMIVERSE_VERSION)).toThrow(SpindleCompatibilityError)
    expect(() => assertManifestCompatibility({ identifier: 'compat_test', minimum_lumiverse_version: 'v1.0.8' }, LUMIVERSE_VERSION)).toThrow(SpindleCompatibilityError)
    expect(() => assertManifestCompatibility({ identifier: 'compat_test', minimum_lumiverse_version: null }, LUMIVERSE_VERSION)).toThrow(SpindleCompatibilityError)
  })

  test('serializes all capabilities in ASCII order and detects descriptor tampering', async () => {
    const value = validateSpindleHostDescriptor({
      ...descriptor(),
      capabilities: { 'z-future-v1': 2, ...SPINDLE_HOST_CAPABILITIES, 'a-future-v1': 3 },
    })
    expect(serializeSpindleHostDescriptor(value)).toContain('a-future-v1')
    expect(serializeSpindleHostDescriptor(value).indexOf('a-future-v1')).toBeLessThan(
      serializeSpindleHostDescriptor(value).indexOf('preset-editor-v1'),
    )
    expect(await digestSpindleHostDescriptor(value)).toBe(await digestSpindleHostDescriptor({ ...value }))
    const tamperedVersion = validateSpindleHostDescriptor({
      ...value,
      lumiverseVersion: '1.0.9',
    })
    const tamperedCapabilities = validateSpindleHostDescriptor({
      ...value,
      capabilities: { ...value.capabilities, 'mixed-host-v1': 1 },
    })
    expect(await digestSpindleHostDescriptor(value)).not.toBe(await digestSpindleHostDescriptor(tamperedVersion))
    expect(await digestSpindleHostDescriptor(value)).not.toBe(await digestSpindleHostDescriptor(tamperedCapabilities))
  })

  test('classifies structured compatibility failures without trusting message text', () => {
    expect(SPINDLE_COMPATIBILITY_ERROR_CODE).toBe('SPINDLE_COMPATIBILITY_ERROR')
    expect(isSpindleCompatibilityError(new SpindleCompatibilityError('local validation detail'))).toBe(true)
    expect(isSpindleCompatibilityError({ code: SPINDLE_COMPATIBILITY_ERROR_CODE })).toBe(true)
    expect(isSpindleCompatibilityError({ body: { code: SPINDLE_COMPATIBILITY_ERROR_CODE } })).toBe(true)
    expect(isSpindleCompatibilityError({ message: SPINDLE_COMPATIBILITY_ERROR_CODE })).toBe(false)
  })
})
