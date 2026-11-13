const LEET_MAP: Record<string, string> = {
  a: '4', A: '4',
  e: '3', E: '3',
  i: '1', I: '1',
  o: '0', O: '0',
  s: '5', S: '5',
  t: '7', T: '7',
  z: '2', Z: '2',
}

/**
 * Convert a name to an IRC-safe l33tspeak handle.
 * e.g. "Sarah Connor" -> "S4r4h_C0nn0r"
 */
export function toLeetSpeak(name: string): string {
  if (!name) return ''
  let handle = name.trim().replace(/\s+/g, '_')
  handle = handle
    .split('')
    .map((ch) => LEET_MAP[ch] ?? ch)
    .join('')
  // Sanitize to IRC-safe characters
  handle = handle.replace(/[^a-zA-Z0-9_\-|^]/g, '')
  return handle
}

/**
 * Reverse lookup: find the original name that would produce the given l33t handle.
 */
export function fromLeetSpeak(handle: string, candidateNames: string[]): string | null {
  if (!handle || !candidateNames) return null
  for (const name of candidateNames) {
    if (toLeetSpeak(name) === handle) return name
  }
  return null
}
