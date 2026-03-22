/**
 * Lightweight client-side macro resolver for chat message display.
 *
 * Handles the most common macros that appear in stored message content
 * (e.g. character greetings, user messages with persona references).
 * This avoids round-tripping to the backend macro engine for every message.
 */

const LEGACY_MAP: Record<string, string> = {
  '<USER>': '{{user}}',
  '<BOT>': '{{char}}',
  '<CHAR>': '{{char}}',
}

export interface DisplayMacroContext {
  charName: string
  userName: string
}

export function resolveDisplayMacros(text: string, ctx: DisplayMacroContext): string {
  if (!text || !text.includes('{{') && !text.includes('<USER>') && !text.includes('<BOT>') && !text.includes('<CHAR>')) {
    return text
  }

  // Legacy token replacement
  let result = text
  for (const [legacy, replacement] of Object.entries(LEGACY_MAP)) {
    if (result.includes(legacy)) {
      result = result.replaceAll(legacy, replacement)
    }
  }

  // Resolve known display macros
  const macros: Record<string, string> = {
    user: ctx.userName,
    char: ctx.charName,
    charName: ctx.charName,
    // notChar is typically the user in 1-on-1 chats
    notChar: ctx.userName,
    not_char: ctx.userName,
  }

  return result.replace(/\{\{([a-zA-Z_]+)\}\}/g, (match, name) => {
    if (name in macros) return macros[name]
    return match
  })
}
