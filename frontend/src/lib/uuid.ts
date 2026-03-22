/**
 * Generate a UUID v4 string.
 * Uses crypto.randomUUID() when available (HTTPS contexts),
 * falls back to a Math.random()-based implementation for HTTP.
 */
export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try { return crypto.randomUUID() } catch { /* fall through */ }
  }
  const hex = '0123456789abcdef'
  let id = ''
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) id += '-'
    else if (i === 14) id += '4'
    else if (i === 19) id += hex[(Math.random() * 4) | 8]
    else id += hex[(Math.random() * 16) | 0]
  }
  return id
}
