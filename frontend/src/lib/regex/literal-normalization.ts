import type { RegexScript } from '@/types/regex'
import { isRegexScriptQuarantined } from './evidence'
import { canSkipDisplayRegex, getSingleCharacterLiteral } from './match-gate'

const MACRO_SYNTAX = /\{\{|<(?:user|bot|char)>/i

/**
 * A narrow string-operation equivalent for global character cleanup. No
 * user-authored RegExp executes here. Anything with matching logic, captures,
 * actions or macro effects must still use the isolated display pipeline.
 */
export function applyLiteralDisplayNormalization(content: string, scripts: readonly RegexScript[]): string | undefined {
  if (scripts.length === 0) return undefined
  const macroSensitive = scripts.some(script => script.substitute_macros !== 'none')
  let result = content
  for (const script of scripts) {
    // Other installed display scripts need not block cleanup when they cannot
    // match. Check in order: earlier normalization can introduce a later match.
    if (canSkipDisplayRegex(result, script)) continue
    if (
      !['g', 'gu', 'ug'].includes(script.flags)
      || script.actions.length > 0
      || script.trim_strings.some(trim => trim !== '')
      || (Array.isArray(script.metadata?.match_actions) && script.metadata.match_actions.length > 0)
      || script.replace_string.length > 4
      || script.replace_string.includes('$')
      || MACRO_SYNTAX.test(script.replace_string)
      || (script.substitute_macros !== 'none' && MACRO_SYNTAX.test(result))
    ) return undefined
    const find = getSingleCharacterLiteral(script.find_regex, script.flags)
    // Under Unicode matching a lone surrogate cannot match half of a pair,
    // whereas a string search can. Leave those patterns to the regex engine.
    if (find === null || (find.length === 1 && /[\ud800-\udfff]/.test(find)) || isRegexScriptQuarantined(script)) return undefined
    result = result.replaceAll(find, script.replace_string)
    // A replacement can join formerly separated macro delimiters. Let the
    // isolated pipeline handle any resulting macro work in script order.
    if (macroSensitive && MACRO_SYNTAX.test(result)) return undefined
  }
  return result
}
