import type { GuideCatalogEntry } from './types'

function normalize(value: string) {
  return value.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

export function indexGuides(catalog: readonly GuideCatalogEntry[]) {
  return catalog.map((entry) => {
    const title = normalize(entry.title)
    const path = normalize(entry.path.replace(/(?:^|\/)index\.md$|\.md$/i, ''))
    const text = (entry.searchText ?? '').replace(/\s+/g, ' ').trim()
    return {
      entry,
      title,
      titleWords: title.split(' '),
      pathWords: path.split(' '),
      bodyWords: [...new Set(normalize(text).split(' '))],
      text,
      lowerText: text.toLowerCase(),
    }
  })
}

export function rankGuides(index: ReturnType<typeof indexGuides>, query: string) {
  const phrase = normalize(query)
  if (!phrase) return []
  const terms = [...new Set(phrase.split(' '))]

  return index.flatMap(({ entry, title, titleWords, pathWords, bodyWords, text, lowerText }) => {
    let score = title === phrase ? 160 : title.startsWith(phrase) ? 90 : title.includes(phrase) ? 55 : 0

    for (const term of terms) {
      if (titleWords.includes(term)) score += 35
      else if (titleWords.some((word) => word.startsWith(term))) score += 24
      else if (pathWords.some((word) => word.startsWith(term))) score += 14
      else if (bodyWords.includes(term)) score += 7
      else if (bodyWords.some((word) => word.startsWith(term))) score += 3
      else return []
    }

    const matchAt = lowerText.indexOf(phrase)
    const bodyAt = matchAt < 0 ? lowerText.indexOf(terms[0]) : matchAt
    const start = Math.max(0, bodyAt - 28)
    const end = Math.min(text.length, start + 105)
    const snippet = bodyAt < 0 ? undefined :
      (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '')
    return [{ ...entry, score, snippet }]
  }).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title) || a.path.localeCompare(b.path)).slice(0, 20)
}
