// Leaf module: compiled-regex cache with no imports, so the worker bundle can
// reuse the exact same cache-safe compilation without dragging the compiler's
// store/i18n graph into the worker chunk.
const COMPILED_REGEX_CACHE_MAX = 256
const compiledRegexCache = new Map<string, RegExp | null>()

export function compileRegex(pattern: string, flags: string): RegExp | null {
  const key = `${flags}\u0000${pattern}`
  const cached = compiledRegexCache.get(key)
  if (cached !== undefined) return cached
  let regex: RegExp | null
  try {
    regex = new RegExp(pattern, flags)
  } catch {
    regex = null
  }
  compiledRegexCache.set(key, regex)
  while (compiledRegexCache.size > COMPILED_REGEX_CACHE_MAX) {
    const oldest = compiledRegexCache.keys().next().value
    if (oldest === undefined) break
    compiledRegexCache.delete(oldest)
  }
  return regex
}
