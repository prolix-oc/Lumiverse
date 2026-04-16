/**
 * Lumiverse UUID Library
 *
 * Generates RFC 9562-compliant UUID v4 and v7 without relying on
 * crypto.randomUUID() (unavailable in insecure contexts on Chrome).
 * Uses crypto.getRandomValues() which IS available in all contexts.
 *
 * Bit layouts per RFC 9562:
 *
 * UUID v4 (128 bits):
 *   octets 0-5  (48 bits)  random_a
 *   octet  6    (4  bits)  version = 0100
 *   octets 6-7  (12 bits)  random_b
 *   octet  8    (2  bits)  variant = 10
 *   octets 8-15 (62 bits)  random_c
 *
 * UUID v7 (128 bits):
 *   octets 0-5  (48 bits)  unix_ts_ms
 *   octet  6    (4  bits)  version = 0111
 *   octets 6-7  (12 bits)  rand_a (monotonic counter)
 *   octet  8    (2  bits)  variant = 10
 *   octets 8-15 (62 bits)  rand_b
 */

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

function formatUUID(bytes: Uint8Array): string {
  return (
    HEX[bytes[0]] + HEX[bytes[1]] + HEX[bytes[2]] + HEX[bytes[3]] + '-' +
    HEX[bytes[4]] + HEX[bytes[5]] + '-' +
    HEX[bytes[6]] + HEX[bytes[7]] + '-' +
    HEX[bytes[8]] + HEX[bytes[9]] + '-' +
    HEX[bytes[10]] + HEX[bytes[11]] + HEX[bytes[12]] + HEX[bytes[13]] + HEX[bytes[14]] + HEX[bytes[15]]
  )
}

/**
 * Generate a UUID v4 (random).
 * 122 random bits + 4 version bits + 2 variant bits.
 */
export function uuidv4(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)

  // Version 4: octet 6 high nibble = 0100
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  // Variant 10: octet 8 high 2 bits = 10
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  return formatUUID(bytes)
}

/**
 * Generate a UUID v7 (timestamp-ordered).
 * 48-bit ms timestamp + 12-bit monotonic counter + 62 random bits.
 * Monotonically increasing within the same millisecond.
 */
let _lastTimestamp = 0
let _counter = 0

export function uuidv7(): string {
  let now = Date.now()

  if (now === _lastTimestamp) {
    _counter++
    // Counter overflow (12 bits = 4095): advance to next ms
    if (_counter > 0xfff) {
      now = _lastTimestamp + 1
      _counter = 0
    }
  } else {
    _counter = 0
  }
  _lastTimestamp = now

  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)

  // Octets 0-5: 48-bit unix timestamp in ms (big-endian)
  bytes[0] = (now / 2 ** 40) & 0xff
  bytes[1] = (now / 2 ** 32) & 0xff
  bytes[2] = (now / 2 ** 24) & 0xff
  bytes[3] = (now / 2 ** 16) & 0xff
  bytes[4] = (now / 2 ** 8) & 0xff
  bytes[5] = now & 0xff

  // Octet 6: version 7 (high nibble) + counter high 4 bits (low nibble)
  bytes[6] = 0x70 | ((_counter >> 8) & 0x0f)
  // Octet 7: counter low 8 bits
  bytes[7] = _counter & 0xff

  // Octet 8: variant 10 (high 2 bits), keep random low 6 bits
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  return formatUUID(bytes)
}

/**
 * Drop-in replacement for crypto.randomUUID().
 * Defaults to v7 for chronological sortability; existing v4 IDs remain valid
 * since both are standard 8-4-4-4-12 hex strings and fully interchangeable.
 */
export const generateUUID = uuidv7
