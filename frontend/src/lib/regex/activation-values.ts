/** Commas/newlines delimit values; CSV quotes preserve literal commas, quotes, or newlines. */
export function parseActivationValues(text: string): string[] | null {
  const values: string[] = []
  let value = ''
  let quoted = false
  let closedQuote = false
  const flush = () => {
    if (value.trim()) values.push(value.trim())
    value = ''
    closedQuote = false
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { value += '"'; i++ }
        else { quoted = false; closedQuote = true }
      } else value += char
    } else if (char === ',' || char === '\n' || char === '\r') {
      flush()
    } else if (closedQuote) {
      if (!/\s/.test(char)) return null
    } else if (char === '"' && !value.trim()) {
      value = ''
      quoted = true
    } else {
      value += char
    }
  }
  if (quoted) return null
  flush()
  return values
}

export function formatActivationValues(value: string | string[]): string {
  return (Array.isArray(value) ? value : [value]).map((item) =>
    /[,"\r\n]/.test(item) ? `"${item.replaceAll('"', '""')}"` : item,
  ).join(', ')
}
