/**
 * Ranked, client-side search for the enhanced lorebook editor.
 *
 * The complete book is already loaded by `LorebookEditorWorkspace`, so the
 * useful performance boundary is "fold each unchanged entry once per object",
 * not a server round-trip or a debounce. The WeakMap below keeps that invariant:
 * changing the query only scans cached normalized strings. Immutable replacements
 * naturally create fresh records, and source-value checks also cover in-place
 * mutations. Dropped books and their folded content remain collectible.
 */

export interface SearchableEntry {
  comment: string
  content: string
  key: string[]
  keysecondary?: string[]
  group_name?: string
  outlet_name?: string | null
  wi_marker?: string | null
}

export type EntrySearchField =
  | 'comment'
  | 'primaryKey'
  | 'secondaryKey'
  | 'content'
  | 'group'
  | 'outlet'
  | 'marker'

export interface EntrySearchClause {
  value: string
  phrase: boolean
}

export interface EntrySearchMatch {
  field: EntrySearchField
  /** Index within `key` / `keysecondary`; zero for scalar fields. */
  valueIndex: number
  /** UTF-16 offsets into the original, un-normalized field value. */
  start: number
  end: number
  clauseIndex: number
  fuzzy: boolean
}

export interface EntrySearchTextRange {
  start: number
  end: number
  fuzzy: boolean
}

export interface EntrySearchSnippet {
  field: Exclude<EntrySearchField, 'comment' | 'primaryKey'>
  label: string
  text: string
  ranges: EntrySearchTextRange[]
  leadingEllipsis: boolean
  trailingEllipsis: boolean
}

export interface EntrySearchResult<T extends SearchableEntry = SearchableEntry> {
  entry: T
  score: number
  matches: EntrySearchMatch[]
  snippet: EntrySearchSnippet | null
}

interface FoldedText {
  raw: string
  normalized: string
  /** normalized UTF-16 index -> original UTF-16 index, plus an end sentinel. */
  offsets: Uint32Array
}

interface FoldedValue extends FoldedText {
  field: EntrySearchField
  valueIndex: number
  label: string
  weight: number
  visible: boolean
  fuzzy: boolean
}

interface EntrySearchRecord {
  values: FoldedValue[]
}

interface SourceValue {
  field: EntrySearchField
  value: string
  valueIndex: number
}

interface Candidate {
  value: FoldedValue
  normalizedStart: number
  normalizedEnd: number
  clauseIndex: number
  score: number
  fuzzy: boolean
}

interface EntryEvaluation {
  score: number
  candidates: Candidate[]
}

export interface EntrySearchIndex {
  evaluate(entry: SearchableEntry, clauses: EntrySearchClause[]): EntryEvaluation | null
  /** Full entry folds actually performed. Test seam; not used by the UI. */
  folds(): number
}

const COMBINING_MARKS = /\p{M}/gu
const WORDS = /[\p{L}\p{N}]+/gu
const WHITESPACE = /\s/u
const WORD_CHARACTER = /[\p{L}\p{N}]/u
const SNIPPET_BEFORE = 72
const SNIPPET_AFTER = 112
const EXACT_TITLE_KEY_TIER = 3_000
const METADATA_TIER = 2_000
const MAX_FUZZY_SCORE = METADATA_TIER + 695

const FIELD_CONFIG: Record<EntrySearchField, {
  label: string
  weight: number
  visible: boolean
  fuzzy: boolean
}> = {
  comment: { label: 'Title', weight: 1_000, visible: true, fuzzy: true },
  primaryKey: { label: 'Primary key', weight: 900, visible: true, fuzzy: true },
  secondaryKey: { label: 'Secondary key', weight: 700, visible: false, fuzzy: true },
  group: { label: 'Group', weight: 600, visible: false, fuzzy: true },
  outlet: { label: 'Outlet', weight: 580, visible: false, fuzzy: true },
  marker: { label: 'Marker', weight: 560, visible: false, fuzzy: true },
  content: { label: 'Content', weight: 300, visible: false, fuzzy: false },
}

function appendNormalized(
  chunks: string[],
  chunk: { value: string },
  offsets: number[],
  value: string,
  rawOffset: number,
): void {
  chunk.value += value
  for (let index = 0; index < value.length; index += 1) offsets.push(rawOffset)
  if (chunk.value.length >= 4_096) {
    chunks.push(chunk.value)
    chunk.value = ''
  }
}

/** Case/diacritic/whitespace normalization with compact source offsets. */
function foldText(raw: string): FoldedText {
  const chunks: string[] = []
  const chunk = { value: '' }
  const offsets: number[] = []
  let rawOffset = 0
  let pendingWhitespace: number | null = null
  let hasOutput = false

  while (rawOffset < raw.length) {
    const code = raw.charCodeAt(rawOffset)

    // Lorebook prose is overwhelmingly ASCII. Keeping that path free of regex,
    // NFKD, iterator and locale work makes the one-time fold cheap even for a
    // megabyte-scale book; non-ASCII text still receives the full normalization.
    if (code <= 0x7f) {
      const whitespace = code === 0x20 || (code >= 0x09 && code <= 0x0d)
      if (whitespace) {
        if (hasOutput && pendingWhitespace === null) pendingWhitespace = rawOffset
        rawOffset += 1
        continue
      }
      if (pendingWhitespace !== null) {
        appendNormalized(chunks, chunk, offsets, ' ', pendingWhitespace)
        pendingWhitespace = null
      }
      const character = code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : raw[rawOffset]
      appendNormalized(chunks, chunk, offsets, character, rawOffset)
      hasOutput = true
      rawOffset += 1
      continue
    }

    const point = raw.codePointAt(rawOffset)!
    const sourceCharacter = String.fromCodePoint(point)
    const sourceLength = sourceCharacter.length
    const normalizedCharacter = sourceCharacter.normalize('NFKD').replace(COMBINING_MARKS, '').toLowerCase()
    for (const character of normalizedCharacter) {
      if (WHITESPACE.test(character)) {
        if (hasOutput && pendingWhitespace === null) pendingWhitespace = rawOffset
      } else {
        if (pendingWhitespace !== null) {
          appendNormalized(chunks, chunk, offsets, ' ', pendingWhitespace)
          pendingWhitespace = null
        }
        appendNormalized(chunks, chunk, offsets, character, rawOffset)
        hasOutput = true
      }
    }
    rawOffset += sourceLength
  }

  if (chunk.value) chunks.push(chunk.value)
  offsets.push(raw.length)
  return { raw, normalized: chunks.join(''), offsets: Uint32Array.from(offsets) }
}

function scalar(entry: SearchableEntry, field: EntrySearchField): string {
  if (field === 'comment') return entry.comment ?? ''
  if (field === 'content') return entry.content ?? ''
  if (field === 'group') return entry.group_name ?? ''
  if (field === 'outlet') return entry.outlet_name ?? ''
  if (field === 'marker') return entry.wi_marker ?? ''
  return ''
}

function sourceValues(entry: SearchableEntry): SourceValue[] {
  return [
    { field: 'comment', value: scalar(entry, 'comment'), valueIndex: 0 },
    ...entry.key.map((value, valueIndex) => ({ field: 'primaryKey' as const, value, valueIndex })),
    ...(entry.keysecondary ?? []).map((value, valueIndex) => ({ field: 'secondaryKey' as const, value, valueIndex })),
    { field: 'group', value: scalar(entry, 'group'), valueIndex: 0 },
    { field: 'outlet', value: scalar(entry, 'outlet'), valueIndex: 0 },
    { field: 'marker', value: scalar(entry, 'marker'), valueIndex: 0 },
    { field: 'content', value: scalar(entry, 'content'), valueIndex: 0 },
  ]
}

function recordMatchesSources(record: EntrySearchRecord, sources: SourceValue[]): boolean {
  return record.values.length === sources.length && record.values.every((value, index) => (
    value.field === sources[index].field
    && value.valueIndex === sources[index].valueIndex
    && value.raw === sources[index].value
  ))
}

function foldEntry(sources: SourceValue[]): EntrySearchRecord {
  return {
    values: sources.map(({ field, value, valueIndex }) => ({
      ...foldText(value),
      field,
      valueIndex,
      ...FIELD_CONFIG[field],
    })),
  }
}

export function normalizeEntryQuery(query: string): string {
  return foldText(query).normalized
}

/**
 * Whitespace separates required clauses. A balanced pair of quotes creates one
 * exact phrase. An unmatched quote is intentionally forgiving: its contents are
 * treated as ordinary required terms instead of making every entry disappear.
 */
export function parseEntrySearchQuery(query: string): EntrySearchClause[] {
  const clauses: EntrySearchClause[] = []
  let current = ''
  let quoted = false

  const push = (raw: string, phrase: boolean) => {
    const value = normalizeEntryQuery(raw)
    if (!value) return
    if (!clauses.some((clause) => clause.value === value && clause.phrase === phrase)) {
      clauses.push({ value, phrase })
    }
  }

  for (const character of query) {
    if (character === '"') {
      if (quoted) {
        push(current, true)
        current = ''
        quoted = false
      } else {
        push(current, false)
        current = ''
        quoted = true
      }
      continue
    }
    if (!quoted && WHITESPACE.test(character)) {
      push(current, false)
      current = ''
      continue
    }
    current += character
  }

  if (quoted) {
    for (const term of current.split(/\s+/u)) push(term, false)
  } else {
    push(current, false)
  }
  return clauses
}

function fuzzyDistanceFor(term: string): number {
  if (term.length < 4) return 0
  return term.length < 8 ? 1 : 2
}

/** Bounded Levenshtein with an early row exit; metadata words are short. */
function editDistanceWithin(left: string, right: string, maximum: number): number | null {
  if (Math.abs(left.length - right.length) > maximum) return null
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex]
    let rowMinimum = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const value = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      )
      current.push(value)
      rowMinimum = Math.min(rowMinimum, value)
    }
    if (rowMinimum > maximum) return null
    previous = current
  }

  return previous[right.length] <= maximum ? previous[right.length] : null
}

function wordBoundaryBonus(text: string, start: number, end: number): number {
  const before = start === 0 || !WORD_CHARACTER.test(text[start - 1])
  const after = end === text.length || !WORD_CHARACTER.test(text[end])
  return before && after ? 80 : before ? 35 : 0
}

function exactCandidate(value: FoldedValue, clause: EntrySearchClause, clauseIndex: number): Candidate | null {
  const start = value.normalized.indexOf(clause.value)
  if (start < 0) return null
  const end = start + clause.value.length
  const equalityBonus = start === 0 && end === value.normalized.length ? 180 : 0
  const prefixBonus = start === 0 ? 90 : 0
  const phraseBonus = clause.phrase ? 50 : 0
  const tier = value.field === 'content'
    ? 0
    : value.field === 'comment' || value.field === 'primaryKey' || value.field === 'secondaryKey'
      ? EXACT_TITLE_KEY_TIER
      : METADATA_TIER
  return {
    value,
    normalizedStart: start,
    normalizedEnd: end,
    clauseIndex,
    score: tier + value.weight + equalityBonus + prefixBonus + phraseBonus + wordBoundaryBonus(value.normalized, start, end),
    fuzzy: false,
  }
}

function fuzzyCandidate(value: FoldedValue, clause: EntrySearchClause, clauseIndex: number): Candidate | null {
  if (!value.fuzzy || clause.phrase) return null
  const maximum = fuzzyDistanceFor(clause.value)
  if (maximum === 0) return null

  let best: Candidate | null = null
  for (const match of value.normalized.matchAll(WORDS)) {
    const word = match[0]
    const start = match.index
    const distance = editDistanceWithin(clause.value, word, maximum)
    if (distance === null || distance === 0) continue
    const candidate: Candidate = {
      value,
      normalizedStart: start,
      normalizedEnd: start + word.length,
      clauseIndex,
      score: METADATA_TIER + value.weight - 250 - distance * 55,
      fuzzy: true,
    }
    if (!best || candidate.score > best.score) best = candidate
  }
  return best
}

function rawRange(candidate: Candidate): EntrySearchMatch {
  const { offsets, raw } = candidate.value
  const start = offsets[Math.min(candidate.normalizedStart, offsets.length - 1)] ?? raw.length
  let endIndex = Math.min(candidate.normalizedEnd, offsets.length - 1)
  let end = offsets[endIndex] ?? raw.length
  while (end <= start && endIndex < offsets.length - 1) {
    endIndex += 1
    end = offsets[endIndex] ?? raw.length
  }
  return {
    field: candidate.value.field,
    valueIndex: candidate.value.valueIndex,
    start,
    end: Math.max(start, end),
    clauseIndex: candidate.clauseIndex,
    fuzzy: candidate.fuzzy,
  }
}

function mergeRanges(ranges: EntrySearchTextRange[]): EntrySearchTextRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: EntrySearchTextRange[] = []
  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end)
      previous.fuzzy = previous.fuzzy || range.fuzzy
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

function snippetBoundary(raw: string, proposed: number, direction: 'start' | 'end'): number {
  if (proposed <= 0) return 0
  if (proposed >= raw.length) return raw.length
  const limit = direction === 'start'
    ? Math.min(raw.length, proposed + 24)
    : Math.max(0, proposed - 24)
  if (direction === 'start') {
    for (let index = proposed; index < limit; index += 1) if (WHITESPACE.test(raw[index])) return index + 1
  } else {
    for (let index = proposed; index > limit; index -= 1) if (WHITESPACE.test(raw[index - 1])) return index - 1
  }
  return proposed
}

function buildSnippet(candidates: Candidate[], matches: EntrySearchMatch[], clauseCount: number): EntrySearchSnippet | null {
  const bestByClause = new Map<number, Candidate>()
  for (const candidate of candidates) {
    const current = bestByClause.get(candidate.clauseIndex)
    if (!current || candidate.score > current.score) bestByClause.set(candidate.clauseIndex, candidate)
  }
  const visibleClauses = new Set(
    [...bestByClause.values()].filter((candidate) => candidate.value.visible).map((candidate) => candidate.clauseIndex),
  )
  if (visibleClauses.size === clauseCount) return null

  const hidden = candidates
    .filter((candidate) => !candidate.value.visible && !visibleClauses.has(candidate.clauseIndex))
    .sort((left, right) => right.score - left.score)[0]
  if (!hidden) return null

  const selected = rawRange(hidden)
  const raw = hidden.value.raw
  const start = snippetBoundary(raw, Math.max(0, selected.start - SNIPPET_BEFORE), 'start')
  const end = snippetBoundary(raw, Math.min(raw.length, selected.end + SNIPPET_AFTER), 'end')
  const ranges = matches
    .filter((match) => (
      match.field === hidden.value.field
      && match.valueIndex === hidden.value.valueIndex
      && match.end > start
      && match.start < end
    ))
    .map((match) => ({
      start: Math.max(0, match.start - start),
      end: Math.min(end - start, match.end - start),
      fuzzy: match.fuzzy,
    }))

  return {
    field: hidden.value.field as EntrySearchSnippet['field'],
    label: hidden.value.label,
    text: raw.slice(start, end),
    ranges: mergeRanges(ranges),
    leadingEllipsis: start > 0,
    trailingEllipsis: end < raw.length,
  }
}

export function createEntrySearchIndex(): EntrySearchIndex {
  const records = new WeakMap<SearchableEntry, EntrySearchRecord>()
  let foldCount = 0

  const recordFor = (entry: SearchableEntry): EntrySearchRecord => {
    const sources = sourceValues(entry)
    let record = records.get(entry)
    if (!record || !recordMatchesSources(record, sources)) {
      foldCount += 1
      record = foldEntry(sources)
      records.set(entry, record)
    }
    return record
  }

  return {
    evaluate(entry, clauses) {
      const record = recordFor(entry)
      const candidates: Candidate[] = []
      let score = 0

      for (let clauseIndex = 0; clauseIndex < clauses.length; clauseIndex += 1) {
        const clause = clauses[clauseIndex]
        const clauseCandidates: Candidate[] = []
        for (const value of record.values) {
          const exact = exactCandidate(value, clause, clauseIndex)
          if (exact) clauseCandidates.push(exact)
        }
        // Once an exact match already outranks the best possible fuzzy title,
        // approximate scans cannot affect ordering, snippets, or acceptance.
        // Skipping them is the common path for title/key searches.
        const bestExact = clauseCandidates.reduce((best, candidate) => Math.max(best, candidate.score), 0)
        if (bestExact < MAX_FUZZY_SCORE) {
          for (const value of record.values) {
            const fuzzy = fuzzyCandidate(value, clause, clauseIndex)
            if (fuzzy) clauseCandidates.push(fuzzy)
          }
        }
        if (clauseCandidates.length === 0) return null
        clauseCandidates.sort((left, right) => right.score - left.score)
        score += clauseCandidates[0].score
        candidates.push(...clauseCandidates)
      }

      return { score, candidates }
    },
    folds() {
      return foldCount
    },
  }
}

/**
 * Returns `null` for an inactive/empty query so callers can reuse their original
 * entry array by reference and pay no row/result allocation cost.
 */
export function searchEntriesByQuery<T extends SearchableEntry>(
  entries: T[],
  query: string,
  index: EntrySearchIndex,
): EntrySearchResult<T>[] | null {
  const clauses = parseEntrySearchQuery(query)
  if (clauses.length === 0) return null

  const results: Array<EntrySearchResult<T> & { originalIndex: number }> = []
  entries.forEach((entry, originalIndex) => {
    const evaluation = index.evaluate(entry, clauses)
    if (!evaluation) return
    const matches = evaluation.candidates.map(rawRange)
    results.push({
      entry,
      score: evaluation.score,
      matches,
      snippet: buildSnippet(evaluation.candidates, matches, clauses.length),
      originalIndex,
    })
  })

  results.sort((left, right) => right.score - left.score || left.originalIndex - right.originalIndex)
  return results.map(({ originalIndex: _originalIndex, ...result }) => result)
}
