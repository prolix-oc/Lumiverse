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
 * Resolve macros in a regex string using the available display macros.
 * Mirrors the backend's macro resolution order, but only for the frontend's
 * lightweight display-macro set.
 */
function resolveRegexStringMacros(
  value: string,
  macroCtx: DisplayMacroContext,
): string {
  if (!value.includes('{{') && !value.includes('<USER>') && !value.includes('<BOT>') && !value.includes('<CHAR>')) {
    return value
  }

  // Replace legacy tokens
  let resolved = value
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

  return resolved
}

function resolveReplacementMacros(
  replaceString: string,
  mode: RegexMacroMode,
  macroCtx: DisplayMacroContext,
): string {
  if (mode === 'none') return replaceString

  const resolved = resolveRegexStringMacros(replaceString, macroCtx)

  if (mode === 'escaped') {
    // Escape $ so regex replacement doesn't interpret $1, $&, etc.
    return resolved.replace(/\$/g, '$$$$')
  }

  return resolved
}

function substituteRegexCaptures(
  template: string,
  fullMatch: string,
  groups: Array<string | undefined>,
  offset: number,
  input: string,
  namedGroups?: Record<string, string>,
): string {
  return template.replace(/\$(?:(\$)|(&)|(`)|(')|(\d{1,2})|<([^>]*)>)/g, (token, dollar, amp, backtick, quote, digits, name) => {
    if (dollar !== undefined) return '$'
    if (amp !== undefined) return fullMatch
    if (backtick !== undefined) return input.slice(0, offset)
    if (quote !== undefined) return input.slice(offset + fullMatch.length)
    if (digits !== undefined) {
      const idx = Number.parseInt(digits, 10)
      if (idx >= 1 && idx <= groups.length) return groups[idx - 1] ?? ''
      return token
    }
    if (name !== undefined && namedGroups) return namedGroups[name] ?? token
    return token
  })
}

export function applyDisplayRegex(
  content: string,
  scripts: RegexScript[],
  context: {
    isUser: boolean
    depth: number
    macroCtx?: DisplayMacroContext
    /** Pre-resolved find patterns keyed by script ID (from backend macro engine). */
    resolvedFindPatterns?: Map<string, string>
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

    let findRegex = script.find_regex
    if (script.substitute_macros !== 'none') {
      const preResolvedFind = context.resolvedFindPatterns?.get(script.id)
      if (preResolvedFind !== undefined) {
        findRegex = preResolvedFind
      } else if (context.macroCtx) {
        findRegex = resolveRegexStringMacros(findRegex, context.macroCtx)
      }
    }

    const regex = compileRegex(findRegex, script.flags)
    if (!regex) continue

    try {
      let replaceString = script.replace_string

      if (script.substitute_macros === 'raw') {
        result = result.replace(regex, (fullMatch, ...args) => {
          const hasNamedGroups = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null
          const namedGroups = hasNamedGroups ? args.pop() as Record<string, string> : undefined
          const input = args.pop() as string
          const offset = args.pop() as number
          const groups = args as Array<string | undefined>
          const withCaptures = substituteRegexCaptures(replaceString, fullMatch, groups, offset, input, namedGroups)
          return context.macroCtx
            ? resolveReplacementMacros(withCaptures, 'raw', context.macroCtx)
            : withCaptures
        })
      } else {
        // Prefer backend-resolved replacement string (full macro engine)
        if (script.substitute_macros !== 'none') {
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
      }

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
