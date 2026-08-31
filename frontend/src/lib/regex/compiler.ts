import type { RegexScript, RegexPlacement, RegexMacroMode, RegexPerformanceMetadata, RegexAction } from '@/types/regex'
import type { DisplayMacroContext } from '@/lib/resolveDisplayMacros'
import { isDisplayChatOwned, getDisplayResolverForChat } from '@/lib/spindle/display-resolver-registry'
import type { SpindleDisplayContext } from 'lumiverse-spindle-types'
import { getRegexSearchEnd, replaceWithinRegexSearchWindow } from './search-window'
export const REGEX_LIMITS_V1 = Object.freeze({
  maxScripts: 512,
  maxPatterns: 1024,
  maxPatternBytes: 64 * 1024,
  maxReplacementBytes: 128 * 1024,
  maxActionBytes: 16 * 1024,
  maxActionCount: 50,
  maxTrimStrings: 512,
  maxTrimStringBytes: 512,
  maxMatches: 1024,
  maxInputBytes: 8 * 1024 * 1024,
  maxOutputBytes: 8 * 1024 * 1024,
  maxExpansionBytes: 16 * 1024 * 1024,
})
const regexUtf8Encoder = new TextEncoder()

export type RegexValidationErrorCode =
  | 'invalid_input'
  | 'invalid_regex'
  | 'invalid_flags'
  | 'pattern_too_large'
  | 'replacement_too_large'
  | 'action_too_large'
  | 'action_count_exceeded'
  | 'trim_string_empty'
  | 'trim_string_too_large'
  | 'trim_string_count_exceeded'
  | 'script_count_exceeded'
  | 'pattern_count_exceeded'
  | 'match_limit_exceeded'
  | 'output_limit_exceeded'

export function regexUtf8ByteLength(value: string): number {
  return regexUtf8Encoder.encode(value).byteLength
}

export interface RegexValidationResult {
  code: RegexValidationErrorCode
  message: string
}

export function validateRegexScriptInput(
  input: Pick<RegexScript, 'find_regex' | 'replace_string' | 'flags' | 'trim_strings' | 'actions'>,
): RegexValidationResult | null {
  if (regexUtf8ByteLength(input.find_regex) > REGEX_LIMITS_V1.maxPatternBytes) {
    return { code: 'pattern_too_large', message: 'Regex pattern exceeds its UTF-8 byte limit' }
  }
  if (regexUtf8ByteLength(input.replace_string) > REGEX_LIMITS_V1.maxReplacementBytes) {
    return { code: 'replacement_too_large', message: 'Regex replacement exceeds its UTF-8 byte limit' }
  }
  if (input.actions.length > REGEX_LIMITS_V1.maxActionCount) {
    return { code: 'action_count_exceeded', message: 'Regex action count exceeds its limit' }
  }
  for (const action of input.actions) {
    for (const field of [action.id, action.cost, action.limit, action.title, action.subtitle, action.content]) {
      if (regexUtf8ByteLength(field) > REGEX_LIMITS_V1.maxActionBytes) {
        return { code: 'action_too_large', message: 'Regex action field exceeds its UTF-8 byte limit' }
      }
    }
  }
  if (input.trim_strings.length > REGEX_LIMITS_V1.maxTrimStrings) {
    return { code: 'trim_string_count_exceeded', message: 'Regex trim string count exceeds its limit' }
  }
  for (const trim of input.trim_strings) {
    if (trim.length === 0) return { code: 'trim_string_empty', message: 'Regex trim strings cannot be empty' }
    if (regexUtf8ByteLength(trim) > REGEX_LIMITS_V1.maxTrimStringBytes) {
      return { code: 'trim_string_too_large', message: 'Regex trim string exceeds its UTF-8 byte limit' }
    }
  }
  try {
    new RegExp(input.find_regex, input.flags)
  } catch {
    return { code: 'invalid_regex', message: 'Regex pattern is invalid' }
  }
  return null
}

interface DisplayRegexMatch {
  fullMatch: string
  groups: Array<string | undefined>
  offset: number
  namedGroups?: Record<string, string | undefined>
}

interface ResolvedRegexAction extends RegexAction {
  scriptId: string
  instanceId: string
}

function resolveActionCost(value: string, fallback: number): number {
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function resolveActionLimit(value: string): number | null {
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

const REGEX_ACTION_ATTR_RE = /\b(?:data-regex-action|id)\s*=\s*(["'])(.*?)\1/i
const REGEX_ACTION_OPEN_TAG_RE = /<([A-Za-z][\w:-]*)(\s[^<>]*?)?\s*\/?>/g

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function decorateRegexActionHtml(html: string, actions: ResolvedRegexAction[]): string {
  if (actions.length === 0 || !html.includes('<')) return html
  const byId = new Map(actions.map((action) => [action.id, action]))
  const limits = actions
    .filter((action) => action.multi_select)
    .map((action) => resolveActionLimit(action.limit))
    .filter((limit): limit is number => limit !== null)
  const blockLimit = limits.length > 0 ? Math.min(...limits) : 0
  return html.replace(REGEX_ACTION_OPEN_TAG_RE, (tag) => {
    if (/^<\//.test(tag) || /\bdata-lumiverse-regex-action\s*=/.test(tag)) return tag
    const association = tag.match(REGEX_ACTION_ATTR_RE)?.[2]
    const action = association ? byId.get(association) : undefined
    if (!action) return tag
    const encoded = encodeURIComponent(JSON.stringify({
      ...action,
      cost: resolveActionCost(action.cost, 1),
      limit: blockLimit,
    }))
    const label = [action.title, action.subtitle].filter(Boolean).join(' — ')
    const attrs = [
      `data-lumiverse-regex-action="${encoded}"`,
      action.multi_select ? 'data-lumiverse-regex-action-multi="true"' : '',
      'role="button"',
      'tabindex="0"',
      label ? `aria-label="${escapeHtmlAttribute(label)}"` : '',
      action.title ? `title="${escapeHtmlAttribute(action.title)}"` : '',
    ].filter(Boolean).join(' ')
    return tag.replace(/\s*\/>$/, ` ${attrs} />`).replace(/(?<!\/)\s*>$/, ` ${attrs}>`)
  })
}

function resolveRegexActions(script: RegexScript, match: DisplayRegexMatch, input: string): ResolvedRegexAction[] {
  return script.actions.map((action) => ({
    ...action,
    title: substituteRegexCaptures(action.title, match.fullMatch, match.groups, match.offset, input, match.namedGroups),
    subtitle: substituteRegexCaptures(action.subtitle, match.fullMatch, match.groups, match.offset, input, match.namedGroups),
    content: substituteRegexCaptures(action.content, match.fullMatch, match.groups, match.offset, input, match.namedGroups),
    cost: substituteRegexCaptures(action.cost, match.fullMatch, match.groups, match.offset, input, match.namedGroups),
    limit: substituteRegexCaptures(action.limit, match.fullMatch, match.groups, match.offset, input, match.namedGroups),
    ...(action.effects?.length ? {
      effects: action.effects.map((effect) => ({
        ...effect,
        ...(effect.type === 'set_state' ? {
          value: substituteRegexCaptures(effect.value, match.fullMatch, match.groups, match.offset, input, match.namedGroups),
        } : effect.type === 'draft' ? {
          content: substituteRegexCaptures(effect.content, match.fullMatch, match.groups, match.offset, input, match.namedGroups),
        } : {}),
      })),
    } : {}),
    scriptId: script.id,
    instanceId: `${script.id}:${match.offset}:${match.offset + match.fullMatch.length}`,
  }))
}

function decorateMatchReplacement(replacement: string, script: RegexScript, match: DisplayRegexMatch, input: string): string {
  return script.actions.length > 0
    ? decorateRegexActionHtml(replacement, resolveRegexActions(script, match, input))
    : replacement
}

// Compiled-regex cache: display transforms can evaluate every script on every
// streaming chunk. Keep validation at this public boundary, then share the
// import-free leaf cache with the worker bundle.
import { compileRegex as compileCachedRegex } from './compile-regex'

export function compileRegex(pattern: string, flags: string): RegExp | null {
  if (regexUtf8ByteLength(pattern) > REGEX_LIMITS_V1.maxPatternBytes) return null
  if (flags.length > 16 || new Set(flags).size !== flags.length) return null
  return compileCachedRegex(pattern, flags)
}

// trim_strings removal can rejoin new occurrences each pass (e.g. 'bbcc' with
// trim 'bc'), so the loop is bounded instead of a single replaceAll pass.
const MAX_DISPLAY_TRIM_ITERATIONS = 32
function hasMacroSyntax(value: string): boolean {
  return value.includes('{{') || value.includes('<USER>') || value.includes('<BOT>') || value.includes('<CHAR>')
}

function resolvesFindMacros(script: RegexScript): boolean {
  return script.substitute_macros !== 'none'
}

function resolvesReplacementMacros(mode: RegexMacroMode): boolean {
  return mode !== 'none' && mode !== 'find'
}

/**
 * Resolve macros in a regex string using the available display macros.
 * Mirrors the backend's macro resolution order, but only for the frontend's
 * lightweight display-macro set.
 */
export function resolveRegexStringMacros(
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

export function resolveReplacementMacros(
  replaceString: string,
  mode: RegexMacroMode,
  macroCtx: DisplayMacroContext,
): string {
  if (!resolvesReplacementMacros(mode)) return replaceString

  const resolved = resolveRegexStringMacros(replaceString, macroCtx)

  if (mode === 'escaped') {
    // Escape $ so regex replacement doesn't interpret $1, $&, etc.
    return resolved.replace(/\$/g, '$$$$')
  }

  return resolved
}

export function substituteRegexCaptures(
  template: string,
  fullMatch: string,
  groups: Array<string | undefined>,
  offset: number,
  input: string,
  namedGroups?: Record<string, string | undefined>,
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
    if (name !== undefined && namedGroups) {
      // Optional named groups remain keys on the groups object even when they
      // do not participate in this match. Those values substitute to empty;
      // only genuinely unknown capture names remain literal.
      if (Object.prototype.hasOwnProperty.call(namedGroups, name)) return namedGroups[name] ?? ''
      return token
    }
    return token
  })
}

export function collectRegexMatches(
  input: string,
  regex: RegExp,
  pattern: string,
  flags: string,
  replacementTemplate: string,
  maxMatches = REGEX_LIMITS_V1.maxMatches,
): DisplayRegexMatch[] {
  const matches: DisplayRegexMatch[] = []
  const searchEnd = getRegexSearchEnd(input, pattern, flags, replacementTemplate)
  const searchable = searchEnd === input.length ? input : input.slice(0, searchEnd)

  regex.lastIndex = 0
  try {
    searchable.replace(regex, (fullMatch, ...args) => {
      if (matches.length >= maxMatches) throw new Error('regex match limit exceeded')
      const hasNamedGroups = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null
      const namedGroups = hasNamedGroups ? args.pop() as Record<string, string | undefined> : undefined
      args.pop() as string
      const offset = args.pop() as number
      const groups = args as Array<string | undefined>
      matches.push({ fullMatch, groups, offset, namedGroups })
      return fullMatch
    })
  } finally {
    regex.lastIndex = 0
  }

  return matches
}

function rebuildFromMatches(
  input: string,
  matches: DisplayRegexMatch[],
  replacementFor: (match: DisplayRegexMatch, index: number) => string,
): string {
  let outputBytes = 0
  let generatedBytes = 0
  let lastIndex = 0
  const chunks: string[] = []

  const appendChunk = (chunk: string): void => {
    outputBytes += regexUtf8ByteLength(chunk)
    if (outputBytes > REGEX_LIMITS_V1.maxOutputBytes) {
      throw new Error("regex output limit exceeded")
    }
    chunks.push(chunk)
  }

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]
    const replacement = replacementFor(match, i)
    if (
      !Number.isSafeInteger(match.offset)
      || match.offset < lastIndex
      || match.offset < 0
      || match.offset + match.fullMatch.length > input.length
    ) throw new Error("regex replacement returned malformed match spans")
    const replacementBytes = regexUtf8ByteLength(replacement)
    if (replacementBytes > REGEX_LIMITS_V1.maxReplacementBytes) {
      throw new Error("regex replacement operation limit exceeded")
    }
    generatedBytes += replacementBytes
    if (generatedBytes > REGEX_LIMITS_V1.maxExpansionBytes) {
      throw new Error("regex expansion limit exceeded")
    }
    appendChunk(input.slice(lastIndex, match.offset))
    appendChunk(replacement)
    lastIndex = match.offset + match.fullMatch.length
  }

  appendChunk(input.slice(lastIndex))
  return chunks.join("")
}

type RegexRuntimeAction = 'move_top' | 'move_bottom' | 'repeat_back'

function readRegexActions(script: RegexScript): ReadonlySet<RegexRuntimeAction> {
  const raw = script.metadata?.match_actions
  if (!Array.isArray(raw)) return new Set()
  return new Set(raw.filter(
    (action): action is RegexRuntimeAction =>
      action === 'move_top'
      || action === 'move_bottom'
      || action === 'repeat_back',
  ))
}

function readRepeatPosition(script: RegexScript): string | undefined {
  const value = script.metadata?.repeat_position
  return typeof value === 'string' ? value : undefined
}

function readRepeatRawMatch(script: RegexScript): boolean {
  return script.metadata?.repeat_raw_match === true
}

function resolveRepeatedMatchReplacement(
  script: RegexScript,
  match: DisplayRegexMatch,
  input: string,
  context: ApplyDisplayRegexContext,
): string {
  let replacement = script.replace_string

  if (script.substitute_macros === 'raw' || script.substitute_macros === 'after') {
    replacement = substituteRegexCaptures(
      replacement,
      match.fullMatch,
      match.groups,
      match.offset,
      input,
      match.namedGroups,
    )
    if (context.macroCtx) {
      replacement = resolveReplacementMacros(
        replacement,
        script.substitute_macros,
        context.macroCtx,
      )
    }
  } else {
    const preResolved = context.resolvedReplacements?.get(script.id)
    if (preResolved !== undefined) {
      replacement = script.substitute_macros === 'escaped'
        ? preResolved.replace(/\$/g, '$$$$')
        : preResolved
    } else if (context.macroCtx) {
      replacement = resolveReplacementMacros(
        replacement,
        script.substitute_macros,
        context.macroCtx,
      )
    }
    replacement = substituteRegexCaptures(
      replacement,
      match.fullMatch,
      match.groups,
      match.offset,
      input,
      match.namedGroups,
    )
  }

  return decorateMatchReplacement(replacement, script, match, input)
}

function applyDisplayActions(
  content: string,
  regex: RegExp,
  pattern: string,
  script: RegexScript,
  context: ApplyDisplayRegexContext,
): { handled: boolean; content: string } {
  const actions = readRegexActions(script)
  if (actions.size === 0) return { handled: false, content }
  const movesTop = actions.has('move_top')
  const movesBottom = actions.has('move_bottom')
  const effectiveFlags = movesTop || movesBottom
    ? script.flags.replaceAll('g', '') || 'u'
    : script.flags
  const effectiveRegex = effectiveFlags === script.flags
    ? regex
    : compileRegex(pattern, effectiveFlags)
  if (!effectiveRegex) return { handled: true, content }
  const matches = collectRegexMatches(
    content,
    effectiveRegex,
    pattern,
    effectiveFlags,
    script.replace_string,
  )
  if (matches.length === 0) {
    if (
      !actions.has('repeat_back')
      || context.previousContent === undefined
    ) return { handled: true, content }
    const priorMatches = collectRegexMatches(
      context.previousContent,
      effectiveRegex,
      pattern,
      effectiveFlags,
      script.replace_string,
    )
    if (priorMatches.length === 0) return { handled: true, content }
    const piece = readRepeatRawMatch(script)
      ? priorMatches[0].fullMatch
      : resolveRepeatedMatchReplacement(
          script,
          priorMatches[0],
          context.previousContent,
          context,
        )
    const position = readRepeatPosition(script) ?? script.replace_string.split(' ', 2)[1]
    const pieceBytes = regexUtf8ByteLength(piece)
    const separatorBytes = position === 'start_nl' || position === 'end_nl' ? regexUtf8ByteLength('\n') : 0
    if (
      pieceBytes > REGEX_LIMITS_V1.maxReplacementBytes
      || regexUtf8ByteLength(content) + pieceBytes + separatorBytes > REGEX_LIMITS_V1.maxOutputBytes
    ) throw new Error('regex repeat output limit exceeded')
    if (position === 'start') return { handled: true, content: piece + content }
    if (position === 'start_nl') return { handled: true, content: `${piece}\n${content}` }
    if (position === 'end_nl') return { handled: true, content: `${content}\n${piece}` }
    if (!position || position === 'end') return { handled: true, content: content + piece }
    return { handled: true, content }
  }
  if (movesTop || movesBottom) {
    const match = matches[0]
    const moved = substituteRegexCaptures(
      script.replace_string,
      match.fullMatch,
      match.groups,
      match.offset,
      content,
      match.namedGroups,
    )
    const remainder = rebuildFromMatches(content, [match], () => '')
    const movedBytes = regexUtf8ByteLength(moved)
    if (
      movedBytes > REGEX_LIMITS_V1.maxReplacementBytes
      || movedBytes + regexUtf8ByteLength(remainder) + regexUtf8ByteLength('\n') > REGEX_LIMITS_V1.maxOutputBytes
    ) throw new Error('regex move output limit exceeded')
    return {
      handled: true,
      content: movesTop
        ? `${moved}\n${remainder}`
        : `${remainder}\n${moved}`,
    }
  }
  return { handled: false, content }
}

export interface ApplyDisplayRegexContext {
  isUser: boolean
  depth: number
  chatId?: string
  characterId?: string
  personaId?: string
  macroCtx?: DisplayMacroContext
  resolvedFindPatterns?: Map<string, string>
  resolvedReplacements?: Map<string, string>
  dynamicMacros?: Record<string, string>
  messageId?: string
  messageIndex?: number
  role?: 'user' | 'assistant' | 'system'
  previousContent?: string
}

interface SlowRegexReport {
  script: RegexScript
  elapsedMs: number
  timedOut: boolean
  thresholdMs: number
}

export const DISPLAY_SLOW_REGEX_WARNING_MS = 5_000
const REGEX_PERFORMANCE_ENGINE_VERSION = 2

function getRegexPerformanceMetadata(script: RegexScript): RegexPerformanceMetadata | null {
  const raw = script.metadata?.regex_performance
  if (!raw || typeof raw !== 'object') return null
  if (raw.slow !== true || typeof raw.version !== 'number') return null
  if (raw.engine_version !== REGEX_PERFORMANCE_ENGINE_VERSION) return null
  return raw as RegexPerformanceMetadata
}

function shouldReportSlowRegex(script: RegexScript, elapsedMs: number): boolean {
  if (elapsedMs < DISPLAY_SLOW_REGEX_WARNING_MS) return false
  const current = getRegexPerformanceMetadata(script)
  return !current || current.version !== script.updated_at
}

function recoveryThresholdForRegex(script: RegexScript, elapsedMs: number): number | null {
  const current = getRegexPerformanceMetadata(script)
  if (!current || current.version !== script.updated_at) return null
  if (current.source !== 'display_client' && current.source !== 'display_backend') return null
  return elapsedMs < current.threshold_ms ? current.threshold_ms : null
}

function mapToRecord(map?: Map<string, string>): Record<string, string> | undefined {
  if (!map || map.size === 0) return undefined
  return Object.fromEntries(map.entries())
}

export interface DisplayRegexBackendResult {
  result: string
  touchedVars?: ReadonlySet<string>
  cacheable?: boolean
  timedOutScriptIds?: ReadonlySet<string>
}

export async function applyDisplayRegexOnBackend(
  content: string,
  scripts: RegexScript[],
  context: ApplyDisplayRegexContext,
): Promise<DisplayRegexBackendResult | null> {
  try {
    const res = await fetch('/api/v1/regex-scripts/apply', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content,
        scripts,
        resolved_find_patterns: mapToRecord(context.resolvedFindPatterns),
        resolved_replacements: mapToRecord(context.resolvedReplacements),
        dynamic_macros: context.dynamicMacros,
        context: {
          chat_id: context.chatId,
          character_id: context.characterId,
          persona_id: context.personaId,
          is_user: context.isUser,
          depth: context.depth,
          ...(context.messageId ? { message_id: context.messageId } : {}),
          ...(typeof context.messageIndex === 'number' ? { message_index: context.messageIndex } : {}),
          ...(context.role ? { role: context.role } : {}),
        },
      }),
    })
    if (!res.ok) return null
    const body = await res.json() as {
      result?: string
      touched_vars?: string[]
      cacheable?: boolean
      timed_out_script_ids?: string[]
    }
    if (typeof body.result !== 'string') return null
    return {
      result: body.result,
      touchedVars: Array.isArray(body.touched_vars) ? new Set(body.touched_vars) : undefined,
      cacheable: typeof body.cacheable === 'boolean' ? body.cacheable : undefined,
      timedOutScriptIds: Array.isArray(body.timed_out_script_ids)
        ? new Set(body.timed_out_script_ids)
        : undefined,
    }
  } catch {
    return null
  }
}

export function applyDisplayRegex(
  content: string,
  scripts: RegexScript[],
  context: ApplyDisplayRegexContext,
  onSlowRegex?: (report: SlowRegexReport) => void,
  onRecoveredRegex?: (report: SlowRegexReport) => void,
): string {
  if (regexUtf8ByteLength(content) > REGEX_LIMITS_V1.maxInputBytes) return content
  let result = content
  let expansionBytes = 0
  let patternCount = 0
  for (const script of scripts.slice(0, REGEX_LIMITS_V1.maxScripts)) {
    if (script.disabled) continue
    if (script.actions.length > REGEX_LIMITS_V1.maxActionCount) continue
    // Determine placement from message role
    const placement: RegexPlacement = context.isUser ? 'user_input' : 'ai_output'
    if (!script.placement.includes(placement)) continue

    // Check depth bounds
    patternCount += 1
    if (patternCount > REGEX_LIMITS_V1.maxPatterns) continue
    if (regexUtf8ByteLength(script.replace_string) > REGEX_LIMITS_V1.maxReplacementBytes) continue
    if (script.min_depth !== null && context.depth < script.min_depth) continue
    if (script.max_depth !== null && context.depth > script.max_depth) continue

    let findRegex = script.find_regex
    if (resolvesFindMacros(script)) {
      const preResolvedFind = context.resolvedFindPatterns?.get(script.id)
      if (preResolvedFind !== undefined) {
        findRegex = preResolvedFind
      } else if (context.macroCtx) {
        findRegex = resolveRegexStringMacros(findRegex, context.macroCtx)
      }
    }
    const regex = compileRegex(findRegex, script.flags)
    if (!regex) continue
    const beforeScript = result
    const startedAt = performance.now()
    try {
      let replaceString = script.replace_string
      const behaviorResult = applyDisplayActions(
        result,
        regex,
        findRegex,
        script,
        context,
      )

      if (behaviorResult.handled) {
        result = behaviorResult.content
      } else if (script.substitute_macros === 'raw') {
        const input = result
        const matches = collectRegexMatches(input, regex, findRegex, script.flags, replaceString)
        result = rebuildFromMatches(input, matches, (match) => {
          const withCaptures = substituteRegexCaptures(
            replaceString,
            match.fullMatch,
            match.groups,
            match.offset,
            input,
            match.namedGroups,
          )
          const replacement = context.macroCtx
            ? resolveReplacementMacros(withCaptures, 'raw', context.macroCtx)
            : withCaptures
          return decorateMatchReplacement(replacement, script, match, input)
        })
      } else if (script.substitute_macros === 'after') {
        if (script.actions.length > 0) {
          const input = result
          const matches = collectRegexMatches(input, regex, findRegex, script.flags, replaceString)
          result = rebuildFromMatches(input, matches, (match) => decorateMatchReplacement(
            substituteRegexCaptures(replaceString, match.fullMatch, match.groups, match.offset, input, match.namedGroups),
            script,
            match,
            input,
          ))
        } else {
          result = replaceWithinRegexSearchWindow(result, regex, findRegex, script.flags, replaceString, replaceString)
        }
      } else {
        // Prefer backend-resolved replacement string (full macro engine)
        if (resolvesReplacementMacros(script.substitute_macros)) {
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

        if (script.actions.length > 0) {
          const input = result
          const matches = collectRegexMatches(input, regex, findRegex, script.flags, replaceString)
          result = rebuildFromMatches(input, matches, (match) => decorateMatchReplacement(
            substituteRegexCaptures(replaceString, match.fullMatch, match.groups, match.offset, input, match.namedGroups),
            script,
            match,
            input,
          ))
        } else {
          result = replaceWithinRegexSearchWindow(result, regex, findRegex, script.flags, replaceString, replaceString)
        }
      }

      // Apply trim_strings
      for (const trim of script.trim_strings.slice(0, REGEX_LIMITS_V1.maxTrimStrings)) {
        if (trim.length === 0 || regexUtf8ByteLength(trim) > REGEX_LIMITS_V1.maxTrimStringBytes) continue
        let iterations = 0
        while (result.includes(trim)) {
          result = result.replaceAll(trim, '')
          iterations += 1
          if (iterations >= MAX_DISPLAY_TRIM_ITERATIONS) {
            console.warn(`[display] trim loop hit ${MAX_DISPLAY_TRIM_ITERATIONS}-iteration cap, stopping early (script=${script.id} "${script.name}", trim=${JSON.stringify(trim)})`)
            break
          }
        }
      }
      const growth = regexUtf8ByteLength(result) - regexUtf8ByteLength(beforeScript)
      if (growth > 0) expansionBytes += growth
      if (expansionBytes > REGEX_LIMITS_V1.maxExpansionBytes) {
        result = beforeScript
        continue
      }
      if (regexUtf8ByteLength(result) > REGEX_LIMITS_V1.maxOutputBytes) {
        result = beforeScript
        continue
      }
      const elapsedMs = Math.round(performance.now() - startedAt)
      if (shouldReportSlowRegex(script, elapsedMs)) {
        onSlowRegex?.({
          script,
          elapsedMs,
          timedOut: false,
          thresholdMs: DISPLAY_SLOW_REGEX_WARNING_MS,
        })
      } else {
        const recoveryThresholdMs = recoveryThresholdForRegex(script, elapsedMs)
        if (recoveryThresholdMs === null) continue
        onRecoveredRegex?.({
          script,
          elapsedMs,
          timedOut: false,
          thresholdMs: recoveryThresholdMs,
        })
      }
    } catch (err) {
      console.warn(`[display] display regex script threw, skipping (script=${script.id} "${script.name}")`, err)
    }
  }

  return result
}

function toSpindleDisplayContext(context: ApplyDisplayRegexContext): SpindleDisplayContext {
  return {
    isUser: context.isUser,
    depth: context.depth,
    ...(context.chatId ? { chatId: context.chatId } : {}),
    ...(context.characterId ? { characterId: context.characterId } : {}),
    ...(context.personaId ? { personaId: context.personaId } : {}),
    ...(context.messageId ? { messageId: context.messageId } : {}),
    ...(typeof context.messageIndex === 'number' ? { messageIndex: context.messageIndex } : {}),
    ...(context.role ? { role: context.role } : {}),
    ...(context.dynamicMacros ? { dynamicMacros: context.dynamicMacros } : {}),
  }
}

// Spindle-owned chats bypass the regex pipeline entirely: when an extension
// owns the chat surface its resolver applies the scripts on the main thread
// and the worker/backend tiers must NEVER see that traffic (Task 3d).
// Returns null when the chat is not owned so callers can continue with their
// own pipeline.
export async function applyDisplayRegexViaOwnedResolver(
  content: string,
  scripts: RegexScript[],
  context: ApplyDisplayRegexContext,
): Promise<DisplayRegexBackendResult | null> {
  if (!context.chatId || !isDisplayChatOwned(context.chatId)) return null
  const resolver = getDisplayResolverForChat(context.chatId)
  if (resolver) {
    try {
      const local = await resolver.applyScripts({
        content,
        scripts,
        context: toSpindleDisplayContext(context),
        ...(context.resolvedFindPatterns ? { resolvedFindPatterns: mapToRecord(context.resolvedFindPatterns) } : {}),
        ...(context.resolvedReplacements ? { resolvedReplacements: mapToRecord(context.resolvedReplacements) } : {}),
      })
      if (local) {
        return {
          result: local.content,
          ...(local.touchedVars ? { touchedVars: new Set(local.touchedVars) } : {}),
          ...(typeof local.cacheable === 'boolean' ? { cacheable: local.cacheable } : {}),
        }
      }
      console.error(`[display] resolver.applyScripts returned null for owned chat=${context.chatId}; showing raw (no backend fallback)`)
    } catch (err) {
      console.error(`[display] resolver.applyScripts threw for owned chat=${context.chatId}; showing raw (no backend fallback)`, err)
    }
  }
  return { result: content, cacheable: false }
}

// Main-thread reference loop handling every script feature (raw/after capture
// substitution, match_actions, action decoration). Kept for deterministic
// reference tests; production display traffic must use the isolated pipeline.
export async function applyDisplayRegexLocalLoop(
  content: string,
  scripts: RegexScript[],
  context: ApplyDisplayRegexContext,
  resolveRawTemplates: (templates: Record<string, string>) => Promise<Record<string, string>>,
): Promise<DisplayRegexBackendResult> {
  if (context.chatId && isDisplayChatOwned(context.chatId)) {
    const resolver = getDisplayResolverForChat(context.chatId)
    if (resolver) {
      try {
        const local = await resolver.applyScripts({
          content,
          scripts,
          context: toSpindleDisplayContext(context),
          ...(context.resolvedFindPatterns ? { resolvedFindPatterns: mapToRecord(context.resolvedFindPatterns) } : {}),
          ...(context.resolvedReplacements ? { resolvedReplacements: mapToRecord(context.resolvedReplacements) } : {}),
        })
        if (local) {
          return {
            result: local.content,
            ...(local.touchedVars ? { touchedVars: new Set(local.touchedVars) } : {}),
            ...(typeof local.cacheable === 'boolean' ? { cacheable: local.cacheable } : {}),
          }
        }
        console.error(`[display] resolver.applyScripts returned null for owned chat=${context.chatId}; showing raw (no backend fallback)`)
      } catch (err) {
        console.error(`[display] resolver.applyScripts threw for owned chat=${context.chatId}; showing raw (no backend fallback)`, err)
      }
    }
    return { result: content, cacheable: false }
  }

  const backendResult = await applyDisplayRegexOnBackend(content, scripts, context)
  if (backendResult !== null) return backendResult

  if (regexUtf8ByteLength(content) > REGEX_LIMITS_V1.maxInputBytes) {
    return { result: content, cacheable: false }
  }
  let asyncExpansionBytes = 0
  let asyncPatternCount = 0
  let result = content
  for (const script of scripts.slice(0, REGEX_LIMITS_V1.maxScripts)) {
    if (script.disabled || script.actions.length > REGEX_LIMITS_V1.maxActionCount) continue
    asyncPatternCount += 1
    if (asyncPatternCount > REGEX_LIMITS_V1.maxPatterns) continue
    const beforeScript = result
    const placement: RegexPlacement = context.isUser ? 'user_input' : 'ai_output'
    if (!script.placement.includes(placement)) continue

    if (script.min_depth !== null && context.depth < script.min_depth) continue
    if (script.max_depth !== null && context.depth > script.max_depth) continue

    let findRegex = script.find_regex
    if (resolvesFindMacros(script)) {
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
      const behaviorResult = applyDisplayActions(
        result,
        regex,
        findRegex,
        script,
        context,
      )
      if (behaviorResult.handled) {
        result = behaviorResult.content
      } else if (script.substitute_macros === 'raw') {
        const input = result
        const matches = collectRegexMatches(
          input,
          regex,
          findRegex,
          script.flags,
          script.replace_string,
        )
        if (matches.length > 0) {
          const templates: Record<string, string> = {}
          const fallbackReplacements: string[] = []
          let fallbackBytes = 0
          for (let index = 0; index < matches.length; index += 1) {
            const match = matches[index]
            const withCaptures = substituteRegexCaptures(
              script.replace_string,
              match.fullMatch,
              match.groups,
              match.offset,
              input,
              match.namedGroups,
            )
            const replacementBytes = regexUtf8ByteLength(withCaptures)
            if (replacementBytes > REGEX_LIMITS_V1.maxReplacementBytes) {
              throw new Error('regex replacement operation limit exceeded')
            }
            fallbackBytes += replacementBytes
            if (fallbackBytes > REGEX_LIMITS_V1.maxExpansionBytes) {
              throw new Error('regex expansion limit exceeded')
            }
            if (hasMacroSyntax(withCaptures)) {
              templates[`${script.id}:${index}`] = withCaptures
            }
            fallbackReplacements.push(withCaptures)
          }

          const resolvedTemplates = Object.keys(templates).length > 0
            ? await resolveRawTemplates(templates)
            : {}
          result = rebuildFromMatches(input, matches, (match, index) => decorateMatchReplacement(
            resolvedTemplates[`${script.id}:${index}`] ?? fallbackReplacements[index],
            script,
            match,
            input,
          ))
        }
      } else if (script.substitute_macros === 'after') {
        const input = result
        const matches = collectRegexMatches(
          input,
          regex,
          findRegex,
          script.flags,
          script.replace_string,
        )
        const substituted = rebuildFromMatches(input, matches, (match) => decorateMatchReplacement(
          substituteRegexCaptures(
            script.replace_string,
            match.fullMatch,
            match.groups,
            match.offset,
            input,
            match.namedGroups,
          ),
          script,
          match,
          input,
        ))
        if (hasMacroSyntax(substituted)) {
          const key = `${script.id}:body`
          const resolved = await resolveRawTemplates({ [key]: substituted })
          const replacement = resolved[key] ?? substituted
          if (
            regexUtf8ByteLength(replacement) > REGEX_LIMITS_V1.maxOutputBytes
            || Math.max(0, regexUtf8ByteLength(replacement) - regexUtf8ByteLength(input))
              > REGEX_LIMITS_V1.maxExpansionBytes
          ) throw new Error('regex resolved output limit exceeded')
          result = replacement
        } else {
          result = substituted
        }
      } else {
        let replaceString = script.replace_string
        if (resolvesReplacementMacros(script.substitute_macros)) {
          const preResolved = context.resolvedReplacements?.get(script.id)
          if (preResolved !== undefined) {
            replaceString = script.substitute_macros === 'escaped'
              ? preResolved.replace(/\$/g, '$$$$')
              : preResolved
          } else if (context.macroCtx) {
            replaceString = resolveReplacementMacros(replaceString, script.substitute_macros, context.macroCtx)
          }
        }

        if (script.actions.length > 0) {
          const input = result
          const matches = collectRegexMatches(input, regex, findRegex, script.flags, replaceString)
          result = rebuildFromMatches(input, matches, (match) => decorateMatchReplacement(
            substituteRegexCaptures(
              replaceString,
              match.fullMatch,
              match.groups,
              match.offset,
              input,
              match.namedGroups,
            ),
            script,
            match,
            input,
          ))
        } else {
          result = replaceWithinRegexSearchWindow(
            result,
            regex,
            findRegex,
            script.flags,
            replaceString,
            replaceString,
          )
        }
      }

      for (const trim of script.trim_strings.slice(0, REGEX_LIMITS_V1.maxTrimStrings)) {
        if (trim.length === 0 || regexUtf8ByteLength(trim) > REGEX_LIMITS_V1.maxTrimStringBytes) continue
        let iterations = 0
        while (result.includes(trim)) {
          result = result.replaceAll(trim, '')
          iterations += 1
          if (iterations >= MAX_DISPLAY_TRIM_ITERATIONS) {
            console.warn(`[display] trim loop hit ${MAX_DISPLAY_TRIM_ITERATIONS}-iteration cap, stopping early (script=${script.id} "${script.name}", trim=${JSON.stringify(trim)})`)
            break
          }
        }
      }
      const growth = regexUtf8ByteLength(result) - regexUtf8ByteLength(beforeScript)
      if (growth > 0) asyncExpansionBytes += growth
      if (
        asyncExpansionBytes > REGEX_LIMITS_V1.maxExpansionBytes
        || regexUtf8ByteLength(result) > REGEX_LIMITS_V1.maxOutputBytes
      ) {
        result = beforeScript
      }
    } catch (err) {
      console.warn(`[display] display regex script threw, skipping (script=${script.id} "${script.name}")`, err)
    }
  }

  return { result, cacheable: false }
}

// Legacy direct-call path retained for compatibility. It no longer falls back
// to user-authored RegExp execution on the main thread when the backend fails.
export async function applyDisplayRegexAsync(
  content: string,
  scripts: RegexScript[],
  context: ApplyDisplayRegexContext,
  _resolveRawTemplates: (templates: Record<string, string>) => Promise<Record<string, string>>,
): Promise<DisplayRegexBackendResult> {
  const owned = await applyDisplayRegexViaOwnedResolver(content, scripts, context)
  if (owned) return owned

  const backendResult = await applyDisplayRegexOnBackend(content, scripts, context)
  if (backendResult !== null) return backendResult

  return { result: content, cacheable: false }
}
