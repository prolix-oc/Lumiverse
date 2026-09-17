function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function getAttributeValue(attributes: string, name: string): string | undefined {
  const match = attributes.match(
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'),
  )
  return match?.slice(1).find((value) => value !== undefined)
}

function healLegacyColor(color: string): string {
  const trimmed = color.trim()
  const fiveDigitHex = trimmed.match(/^#?([0-9a-fA-F]{5})$/)

  // This is the one malformed length whose legacy HTML parsing result can be
  // represented by simply appending a zero. Leave every other value alone so
  // this compatibility repair does not invent a different color.
  if (fiveDigitHex) return `#${fiveDigitHex[1]}0`
  return trimmed === '#' ? '' : trimmed
}

/**
 * Converts deprecated HTML font tags to spans before rich HTML sanitization.
 * DOMPurify then applies the usual policy to the resulting style attribute.
 */
export function normalizeLegacyFontTags(html: string): string {
  return html
    .replace(/<font\b([^>]*)(>|$)/gi, (match, attributes: string, end: string) => {
      if (!end) return match
      const color = getAttributeValue(attributes, 'color')
      const style = getAttributeValue(attributes, 'style')
      const healedColor = color ? healLegacyColor(color) : null
      const safeColor = healedColor && /^[#\w\s(),.%+-]+$/.test(healedColor) ? healedColor : null
      const declarations = [
        safeColor ? `color:${safeColor}` : null,
        style?.trim() || null,
      ].filter((declaration): declaration is string => Boolean(declaration))

      return declarations.length > 0
        ? `<span style="${escapeHtmlAttribute(declarations.join(';'))}">`
        : '<span>'
    })
    .replace(/<\/font\s*>/gi, '</span>')
}
