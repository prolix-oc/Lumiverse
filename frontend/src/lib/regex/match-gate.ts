import type { RegexScript } from '@/types/regex'
import { getRequiredTerminalLiteral } from './search-window'

const MACRO_SYNTAX = /\{\{|<(?:user|bot|char)>/i
const guards = new Map<string, string | RegExp | null>()

// Common cleanup scripts use [⠀] or \u2800, which the terminal scanner
// deliberately doesn't interpret. Decode only a single required character;
// classes with ranges, alternatives or quantifiers still use isolated regex.
export function getSingleCharacterLiteral(pattern: string, flags: string): string | null {
  if (pattern.length > 12) return null
  const source = pattern.startsWith('[') && pattern.endsWith(']')
    ? pattern.slice(1, -1) : pattern
  if (/^\\u[\da-f]{4}$/i.test(source)) return String.fromCharCode(parseInt(source.slice(2), 16))
  if (/^\\x[\da-f]{2}$/i.test(source)) return String.fromCharCode(parseInt(source.slice(2), 16))
  if (flags.includes('u') && /^\\u\{[\da-f]{1,6}\}$/i.test(source)) {
    const codePoint = parseInt(source.slice(3, -1), 16)
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : null
  }
  return source.length === 1 && !/[\\^$.*+?()[\]{}|\-]/.test(source) ? source : null
}

/** Only a fixed, escaped literal runs here, never the user-authored regex. */
export function cannotMatchRegex(content: string, pattern: string, flags: string): boolean {
  // The terminal scanner does not parse Unicode-set class nesting.
  if (flags.includes('v')) return false
  const key = `${flags}\u0000${pattern}`
  let guard = guards.get(key)
  if (guard === undefined) {
    // Even a short literal can avoid an entire asynchronous display pass.
    const literal = getSingleCharacterLiteral(pattern, flags) ?? getRequiredTerminalLiteral(pattern, 1)
    guard = literal
    if (literal && flags.includes('i')) {
      guard = new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags.includes('u') ? 'iu' : 'i')
    }
    guards.set(key, guard)
    if (guards.size > 256) guards.delete(guards.keys().next().value!)
  }
  return guard !== null && (typeof guard === 'string' ? !content.includes(guard) : !guard.test(content))
}

/** Absence of a match only permits skipping scripts with no other work. */
export function canSkipDisplayRegex(
  content: string,
  script: RegexScript,
  resolvedFindPatterns?: ReadonlyMap<string, string>,
): boolean {
  // Activation inputs are server-owned even when ordinary macro substitution
  // is disabled for this script.
  if (script.preset_id && script.metadata?.prompt_activation && script.find_regex.includes('{{')) return false
  const matchActions = script.metadata?.match_actions
  if (Array.isArray(matchActions) && matchActions.includes('repeat_back')) return false
  if (script.trim_strings.some((trim) => trim !== '' && content.includes(trim))) return false
  if (script.substitute_macros === 'after' && MACRO_SYNTAX.test(content)) return false
  // Before-replacement macros may have effects even when nothing matches.
  if (
    !['none', 'find', 'raw', 'after'].includes(script.substitute_macros)
    && MACRO_SYNTAX.test(script.replace_string)
  ) return false

  let pattern = script.find_regex
  if (script.substitute_macros !== 'none' && MACRO_SYNTAX.test(pattern)) {
    const resolved = resolvedFindPatterns?.get(script.id)
    if (resolved === undefined) return false
    pattern = resolved
  }
  return cannotMatchRegex(content, pattern, script.flags)
}
