const ESCAPABLE_LITERAL_CHARS = new Set("\\^$.*+?()[]{}|/")
const regexUtf8Encoder = new TextEncoder()
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_EXPANSION_BYTES = 16 * 1024 * 1024

/**
 * Return a literal run that every successful match must end with.
 *
 * This deliberately recognizes only a conservative regex subset. Returning
 * null merely disables the optimization; it must never invent a guard for a
 * pattern whose language does not require the literal.
 */
export function getRequiredTerminalLiteral(pattern: string): string | null {
  let suffix = ""
  let depth = 0
  let inCharacterClass = false

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]

    if (char === "\\") {
      const escaped = pattern[i + 1]
      if (escaped === undefined) return null
      i += 1
      if (inCharacterClass) continue
      if (ESCAPABLE_LITERAL_CHARS.has(escaped)) suffix += escaped
      else {
        suffix = ""
        // Skip the source characters belonging to multi-character escapes so
        // they cannot be mistaken for a literal suffix (for example, the
        // `<name>` in a named backreference).
        if ((escaped === "k" || escaped === "p" || escaped === "P") && pattern[i + 1] === "<") {
          const close = pattern.indexOf(">", i + 2)
          if (close >= 0) i = close
        } else if ((escaped === "p" || escaped === "P") && pattern[i + 1] === "{") {
          const close = pattern.indexOf("}", i + 2)
          if (close >= 0) i = close
        } else if (escaped === "u" && pattern[i + 1] === "{") {
          const close = pattern.indexOf("}", i + 2)
          if (close >= 0) i = close
        } else if (escaped === "u") {
          i = Math.min(pattern.length - 1, i + 4)
        } else if (escaped === "x") {
          i = Math.min(pattern.length - 1, i + 2)
        } else if (escaped === "c") {
          i = Math.min(pattern.length - 1, i + 1)
        } else if (/\d/.test(escaped)) {
          while (/\d/.test(pattern[i + 1] ?? "")) i += 1
        }
      }
      continue
    }

    if (inCharacterClass) {
      if (char === "]") inCharacterClass = false
      continue
    }

    if (char === "[") {
      inCharacterClass = true
      suffix = ""
      continue
    }

    if (char === "(") {
      depth += 1
      suffix = ""
      continue
    }

    if (char === ")") {
      depth = Math.max(0, depth - 1)
      suffix = ""
      continue
    }

    if (char === "|") {
      // A top-level alternative can bypass a suffix found in the final arm.
      if (depth === 0) return null
      suffix = ""
      continue
    }

    if (".*+?^${}".includes(char)) {
      suffix = ""
      continue
    }

    suffix += char
  }

  return suffix.length >= 4 ? suffix : null
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function lastLiteralIndex(input: string, literal: string, flags: string): number {
  if (!flags.includes("i")) return input.lastIndexOf(literal)

  // Delegate case folding to the regex engine so Unicode i/u/v behavior stays
  // identical to the user-authored expression.
  const unicodeFlag = flags.includes("v") ? "v" : flags.includes("u") ? "u" : ""
  const guard = new RegExp(escapeRegexLiteral(literal), `gi${unicodeFlag}`)
  let lastIndex = -1
  let match: RegExpExecArray | null
  while ((match = guard.exec(input)) !== null) lastIndex = match.index
  return lastIndex
}

/**
 * Limit matching to the last possible end position for patterns with a fixed
 * terminal literal. The omitted tail provably cannot contain a match.
 *
 * `$'` needs the complete original input during replacement, so templates
 * using it intentionally bypass the optimization.
 */
export function getRegexSearchEnd(
  input: string,
  pattern: string,
  flags: string,
  replacementTemplate: string,
): number {
  if (replacementTemplate.includes("$'")) return input.length
  const terminal = getRequiredTerminalLiteral(pattern)
  if (!terminal) return input.length
  const index = lastLiteralIndex(input, terminal, flags)
  return index < 0 ? 0 : index + terminal.length
}
function utf8ByteLength(value: string): number {
  return regexUtf8Encoder.encode(value).byteLength
}

function utf8ByteLengthRange(value: string, start: number, end: number): number {
  let bytes = 0
  for (let index = start; index < end; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < end) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

function nextRegexIndex(input: string, index: number, unicode: boolean): number {
  if (!unicode || index >= input.length) return index + 1
  const first = input.charCodeAt(index)
  const second = input.charCodeAt(index + 1)
  return first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff
    ? index + 2
    : index + 1
}

function nativeReplacementBytes(
  template: string,
  match: RegExpExecArray,
  input: string,
): number {
  let bytes = 0
  let cursor = 0
  const add = (value: string): void => { bytes += utf8ByteLength(value) }
  const addRange = (start: number, end: number): void => { bytes += utf8ByteLengthRange(input, start, end) }
  for (let index = 0; index < template.length; index += 1) {
    if (template[index] !== "$" || index + 1 >= template.length) continue
    if (index > cursor) add(template.slice(cursor, index))
    const next = template[index + 1]
    if (next === "$") {
      add("$")
      index += 1
    } else if (next === "&") {
      add(match[0] ?? "")
      index += 1
    } else if (next === "`") {
      addRange(0, match.index)
      index += 1
    } else if (next === "'") {
      addRange(match.index + match[0].length, input.length)
      index += 1
    } else if (/\d/.test(next)) {
      const first = Number(next)
      const second = index + 2 < template.length && /\d/.test(template[index + 2]!) ? Number(template[index + 2]) : null
      const twoDigit = second === null ? first : first * 10 + second
      if (second !== null && twoDigit > 0 && twoDigit < match.length) {
        add(match[twoDigit] ?? "")
        index += 2
      } else if (first > 0 && first < match.length) {
        add(match[first] ?? "")
        if (second !== null) add(String(second))
        index += second === null ? 1 : 2
      } else {
        add(template[index]!)
      }
    } else if (next === "<") {
      const close = template.indexOf(">", index + 2)
      if (close >= 0) {
        const name = template.slice(index + 2, close)
        if (match.groups && Object.prototype.hasOwnProperty.call(match.groups, name)) {
          add(match.groups[name] ?? "")
        } else {
          add(template.slice(index, close + 1))
        }
        index = close
      } else {
        add(template[index]!)
      }
    } else {
      add(template[index]!)
    }
    cursor = index + 1
  }
  if (cursor < template.length) add(template.slice(cursor))
  return bytes
}

function assertStringReplacementBudget(
  input: string,
  searchable: string,
  regex: RegExp,
  replacement: string,
  maxOutputBytes: number,
  maxExpansionBytes: number,
  maxMatches: number,
): void {
  let outputBytes = utf8ByteLength(input)
  let generatedBytes = 0
  let count = 0
  const probe = new RegExp(regex.source, regex.flags)
  let match: RegExpExecArray | null
  while ((match = probe.exec(searchable)) !== null) {
    if (count >= maxMatches) throw new Error("regex match limit exceeded")
    const replacementBytes = nativeReplacementBytes(replacement, match, searchable)
    if (replacementBytes > 128 * 1024) throw new Error("regex replacement operation limit exceeded")
    generatedBytes += replacementBytes
    if (generatedBytes > maxExpansionBytes) throw new Error("regex expansion limit exceeded")
    outputBytes += replacementBytes - utf8ByteLength(match[0])
    if (outputBytes > maxOutputBytes) throw new Error("regex output limit exceeded")
    count += 1
    if (match[0].length === 0) probe.lastIndex = nextRegexIndex(searchable, probe.lastIndex, probe.unicode)
  }
}
type RegexReplacementCallback = (substring: string, ...args: unknown[]) => string

function preflightCallbackReplacement(
  input: string,
  searchable: string,
  regex: RegExp,
  replacement: RegexReplacementCallback,
  maxOutputBytes: number,
  maxExpansionBytes: number,
  maxMatches: number,
): string[] {
  let outputBytes = utf8ByteLength(input)
  let generatedBytes = 0
  let count = 0
  const results: string[] = []
  const probe = new RegExp(regex.source, regex.flags)
  let match: RegExpExecArray | null
  while ((match = probe.exec(searchable)) !== null) {
    if (count >= maxMatches) throw new Error("regex match limit exceeded")
    const result = replacement(
      match[0]!,
      ...match.slice(1),
      match.index,
      searchable,
      match.groups,
    )
    if (typeof result !== "string") throw new Error("regex replacement callback must return a string")
    const replacementBytes = utf8ByteLength(result)
    if (replacementBytes > 128 * 1024) throw new Error("regex replacement operation limit exceeded")
    generatedBytes += replacementBytes
    if (generatedBytes > maxExpansionBytes) throw new Error("regex expansion limit exceeded")
    outputBytes += replacementBytes - utf8ByteLength(match[0]!)
    if (outputBytes > maxOutputBytes) throw new Error("regex output limit exceeded")
    results.push(result)
    count += 1
    if (match[0]!.length === 0) probe.lastIndex = nextRegexIndex(searchable, probe.lastIndex, probe.unicode)
  }
  return results
}

export function replaceWithinRegexSearchWindow(
  input: string,
  regex: RegExp,
  pattern: string,
  flags: string,
  replacementTemplate: string,
  replacement: string,
  maxOutputBytes?: number,
  maxExpansionBytes?: number,
): string
export function replaceWithinRegexSearchWindow(
  input: string,
  regex: RegExp,
  pattern: string,
  flags: string,
  replacementTemplate: string,
  replacement: RegexReplacementCallback,
  maxOutputBytes?: number,
  maxExpansionBytes?: number,
): string
export function replaceWithinRegexSearchWindow(
  input: string,
  regex: RegExp,
  pattern: string,
  flags: string,
  replacementTemplate: string,
  replacement: string | RegexReplacementCallback,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  maxExpansionBytes = DEFAULT_MAX_EXPANSION_BYTES,
): string {
  const searchEnd = getRegexSearchEnd(input, pattern, flags, replacementTemplate)
  const searchable = searchEnd === input.length ? input : input.slice(0, searchEnd)
  // Cached sticky RegExp instances retain lastIndex after a successful
  // non-global replacement. Reset around every use so cache hits are
  // observationally identical to a freshly compiled RegExp.
  regex.lastIndex = 0
  try {
    const outputLimit = Number.isSafeInteger(maxOutputBytes) && maxOutputBytes >= 0
      ? maxOutputBytes
      : DEFAULT_MAX_OUTPUT_BYTES
    const expansionLimit = Number.isSafeInteger(maxExpansionBytes) && maxExpansionBytes >= 0
      ? maxExpansionBytes
      : DEFAULT_MAX_EXPANSION_BYTES
    if (typeof replacement === "string") {
      assertStringReplacementBudget(
        input,
        searchable,
        regex,
        replacement,
        outputLimit,
        expansionLimit,
        1024,
      )
      const replaced = searchable.replace(regex, replacement)
      return searchEnd === input.length ? replaced : replaced + input.slice(searchEnd)
    }
    const callbackResults = preflightCallbackReplacement(
      input,
      searchable,
      regex,
      replacement,
      outputLimit,
      expansionLimit,
      1024,
    )
    let callbackIndex = 0
    const replaced = searchable.replace(regex, () => {
      const result = callbackResults[callbackIndex]
      if (result === undefined) throw new Error("regex replacement callback preflight mismatch")
      callbackIndex += 1
      return result
    })
    if (callbackIndex !== callbackResults.length) {
      throw new Error("regex replacement callback preflight mismatch")
    }
    return searchEnd === input.length ? replaced : replaced + input.slice(searchEnd)
  } finally {
    regex.lastIndex = 0
  }
}
