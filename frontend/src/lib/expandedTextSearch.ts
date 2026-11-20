export interface ExpandedTextMatch {
  start: number
  end: number
}

export function findExpandedTextMatches(value: string, query: string): ExpandedTextMatch[] {
  if (!query) return []
  const matches: ExpandedTextMatch[] = []
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(escaped, 'giu')
  let match: RegExpExecArray | null
  while ((match = regex.exec(value)) !== null) {
    matches.push({ start: match.index, end: match.index + match[0].length })
  }

  return matches
}

export function replaceExpandedTextMatch(
  value: string,
  match: ExpandedTextMatch,
  replacement: string,
): string {
  return value.slice(0, match.start) + replacement + value.slice(match.end)
}

export function replaceAllExpandedTextMatches(
  value: string,
  matches: ExpandedTextMatch[],
  replacement: string,
): string {
  if (matches.length === 0) return value
  const pieces: string[] = []
  let offset = 0
  for (const match of matches) {
    pieces.push(value.slice(offset, match.start), replacement)
    offset = match.end
  }
  pieces.push(value.slice(offset))
  return pieces.join('')
}
