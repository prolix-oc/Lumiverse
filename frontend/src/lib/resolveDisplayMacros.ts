/**
 * Lightweight client-side macro resolver for chat message display.
 *
 * Handles the most common macros that appear in stored message content
 * (e.g. character greetings, user messages with persona references).
 * This avoids round-tripping to the backend macro engine for every message.
 */

import { mapOutsideJsonBlocks } from './jsonBlocks'
import { restoreLiteralBraces } from './literalBraces'

const LEGACY_MAP: Record<string, string> = {
  '<USER>': '{{user}}',
  '<BOT>': '{{char}}',
  '<CHAR>': '{{char}}',
}

const DISPLAY_SETTER_RE = /\{\{\s*(?:setvar|setgvar|setchatvar)\b(?:(?!\}\}).)*\}\}/gis

export interface DisplayMacroContext {
  charName: string
  userName: string
}

export function stripDisplaySetterMacros(text: string): string {
  if (!text || !text.includes('{{')) return text
  return mapOutsideJsonBlocks(text, (segment) => segment.replace(DISPLAY_SETTER_RE, ''))
}

export function resolveDisplayMacros(text: string, ctx: DisplayMacroContext): string {
  if (!text || !text.includes('{{') && !text.includes('<USER>') && !text.includes('<BOT>') && !text.includes('<CHAR>')) {
    return restoreLiteralBraces(text)
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

  // Valid <json> blocks are data the backend keeps verbatim, so only the text
  // around them is resolved.
  return restoreLiteralBraces(mapOutsideJsonBlocks(text, (segment) => {
    // Legacy token replacement
    let result = segment
    for (const [legacy, replacement] of Object.entries(LEGACY_MAP)) {
      if (result.includes(legacy)) {
        result = result.replaceAll(legacy, replacement)
      }
    }

    return result.replace(/\{\{([a-zA-Z_]+)\}\}/g, (match, name) => {
      if (name in macros) return macros[name]
      return match
    }).replace(DISPLAY_SETTER_RE, '')
  }))
}
