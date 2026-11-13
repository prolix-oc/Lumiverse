import type { RegexScript } from '@/types/regex'

const scriptVersions = new WeakMap<RegexScript, number>()
let nextScriptVersion = 1

/**
 * Store updates replace script objects. Share an identity per immutable
 * definition instead of copying its potentially large HTML/CSS into every
 * message and every cached streaming frame. Weak keys do not retain old
 * definitions; edits, reloads and reordered lists still invalidate results.
 */
export function getRegexScriptCacheKey(scripts: readonly RegexScript[]): number[] {
  return scripts.map((script) => {
    let version = scriptVersions.get(script)
    if (version === undefined) {
      version = nextScriptVersion++
      scriptVersions.set(script, version)
    }
    return version
  })
}
