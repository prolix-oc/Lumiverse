import type { RegexScript, RegexPlacement } from '@/types/regex'

export function compileRegex(pattern: string, flags: string): RegExp | null {
  try {
    return new RegExp(pattern, flags)
  } catch {
    return null
  }
}

export function applyDisplayRegex(
  content: string,
  scripts: RegexScript[],
  context: { isUser: boolean; depth: number },
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
      result = result.replace(regex, script.replace_string)

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
