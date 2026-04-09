import type { RegexScript, RegexPlacement, RegexMacroMode } from '@/types/regex'
import type { DisplayMacroContext } from '@/lib/resolveDisplayMacros'

export function compileRegex(pattern: string, flags: string): RegExp | null {
  try {
    return new RegExp(pattern, flags)
  } catch {
    return null
  }
}

/**
 * Resolve macros in a regex replacement string using the available display macros.
 * Mirrors the backend's resolveReplacementMacros() but with the frontend's macro set.
 * - "none": return as-is
 * - "raw": resolve macros, regex back-references ($1, etc.) still work
 * - "escaped": resolve macros, then escape $ so no back-references are interpreted
 */
function resolveReplacementMacros(
  replaceString: string,
  mode: RegexMacroMode,
  macroCtx: DisplayMacroContext,
): string {
  if (mode === 'none') return replaceString
  if (!replaceString.includes('{{') && !replaceString.includes('<USER>') && !replaceString.includes('<BOT>') && !replaceString.includes('<CHAR>')) {
    return replaceString
  }

  // Replace legacy tokens
  let resolved = replaceString
  const legacyMap: Record<string, string> = { '<USER>': '{{user}}', '<BOT>': '{{char}}', '<CHAR>': '{{char}}' }
  for (const [legacy, replacement] of Object.entries(legacyMap)) {
    if (resolved.includes(legacy)) {
      resolved = resolved.replaceAll(legacy, replacement)
    }
  }

  // Resolve known macros
  const macros: Record<string, string> = {
    user: macroCtx.userName,
    char: macroCtx.charName,
    charName: macroCtx.charName,
    notChar: macroCtx.userName,
    not_char: macroCtx.userName,
  }

  resolved = resolved.replace(/\{\{([a-zA-Z_]+)\}\}/g, (match, name) => {
    if (name in macros) return macros[name]
    return match
  })

  if (mode === 'escaped') {
    // Escape $ so regex replacement doesn't interpret $1, $&, etc.
    return resolved.replace(/\$/g, '$$$$')
  }

  return resolved
}

export function applyDisplayRegex(
  content: string,
  scripts: RegexScript[],
  context: {
    isUser: boolean
    depth: number
    macroCtx?: DisplayMacroContext
    /** Pre-resolved replacement strings keyed by script ID (from backend macro engine). */
    resolvedReplacements?: Map<string, string>
  },
): string {
  let result = content

  for (const script of scripts) {
    // Determine placement from message role
    const placement: RegexPlacement = context.isUser ? 'user_input' : 'ai_output'
    if (!script.placement.includes(placement)) continue

    // Check depth bounds
    if (script.min_depth !== null && context.depth < script.min_depth) continue
    if (script.max_depth !== null && context.depth > script.max_depth) continue

    const regex = compileRegex(script.find_regex, script.flags)
    if (!regex) continue

    try {
      let replaceString = script.replace_string

      if (script.substitute_macros !== 'none') {
        // Prefer backend-resolved replacement string (full macro engine)
        const preResolved = context.resolvedReplacements?.get(script.id)
        if (preResolved !== undefined) {
          replaceString = script.substitute_macros === 'escaped'
            ? preResolved.replace(/\$/g, '$$$$')
            : preResolved
        } else if (context.macroCtx) {
          // Fall back to client-side resolution for simple macros
          replaceString = resolveReplacementMacros(replaceString, script.substitute_macros, context.macroCtx)
        }
      }

      result = result.replace(regex, replaceString)

      // Apply trim_strings
      for (const trim of script.trim_strings) {
        while (result.includes(trim)) {
          result = result.replaceAll(trim, '')
        }
      }
    } catch {
      // Skip invalid regex silently
    }
  }

  return result
}
