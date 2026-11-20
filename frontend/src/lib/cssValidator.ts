/** Validate a CSS string using the browser's built-in parser. */
export function validateCSS(css: string): { valid: boolean; error?: string } {
  try {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(css)
    return { valid: true }
  } catch (e) {
    return { valid: false, error: (e as Error).message }
  }
}

/**
 * Sanitize user CSS by stripping dangerous patterns:
 * - @import rules (prevents external resource loading)
 * - url() with external origins (allow data: URIs only)
 * - javascript: url() payloads
 */
export function sanitizeCSS(css: string): string {
  // Strip @import statements
  let sanitized = css.replace(/@import\s+[^;]+;/gi, '/* @import stripped */')

  // Strip url() with external origins — keep data: and relative URLs
  sanitized = sanitized.replace(
    /url\(\s*(['"]?)(https?:\/\/[^)'"]+)\1\s*\)/gi,
    '/* external url() stripped */',
  )

  sanitized = sanitized.replace(
    /url\(\s*(['"]?)javascript:[^)'"]*\1\s*\)/gi,
    '/* javascript url() stripped */',
  )

  return sanitized
}
