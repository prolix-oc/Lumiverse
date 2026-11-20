import { toast } from '@/lib/toast'
import i18n from '@/i18n'
import type { RegexScript } from '@/types/regex'
import {
  applyDisplayRegexOnBackend,
  applyDisplayRegexViaOwnedResolver,
  compileRegex,
  resolveReplacementMacros,
  resolveRegexStringMacros,
  type ApplyDisplayRegexContext,
  type DisplayRegexBackendResult,
} from './compiler'
import {
  getRegexExecTier,
  quarantineRegexScript,
  resetRegexSkipAnnouncementsForTests,
  shouldAnnounceRegexSkip,
} from './evidence'
import type { ApplyWorkerScript } from './apply.worker'
import {
  isSupported as workerSupported,
  RegexJobSupersededError,
  RegexWorkerCrashedError,
  RegexWorkerError,
  RegexWorkerTimeoutError,
  RegexWorkerUnsupportedError,
  runRegexJobInWorker,
} from './worker-client'
import { shouldPermanentlyQuarantineRegex } from './quarantine-policy'
import { canSkipDisplayRegex } from './match-gate'

// The once-per-script bookkeeping lives in evidence.ts so that clearing a
// quarantine can reset it without evidence.ts importing this module (which
// would close a cycle, since this module imports evidence.ts). Emitting the
// warning itself stays here — evidence.ts has no business owning toasts.
function announceSkippedOnce(script: RegexScript, kind: 'quarantined' | 'unavailable', reason: string): void {
  if (!shouldAnnounceRegexSkip(script.id, kind)) return
  console.warn(`[display] skipping display regex script (script=${script.id} "${script.name}", reason=${reason})`)
  toast.warning(
    i18n.t(`panels:regexPanel.${kind === 'quarantined' ? 'quarantinedDisplay' : 'unavailableDisplay'}`, { name: script.name }),
    { title: i18n.t(`panels:regexPanel.${kind === 'quarantined' ? 'slowDisplayTitle' : 'skippedDisplayTitle'}`), duration: 7000 },
  )
}

export function resetTieredPipelineForTests(): void {
  resetRegexSkipAnnouncementsForTests()
}

function placementEligible(script: RegexScript, context: ApplyDisplayRegexContext): boolean {
  const placement = context.isUser ? 'user_input' : 'ai_output'
  if (!script.placement.includes(placement)) return false
  if (script.min_depth !== null && context.depth < script.min_depth) return false
  if (script.max_depth !== null && context.depth > script.max_depth) return false
  return true
}

const DISPLAY_MACRO_SYNTAX_RE = /\{\{|<(?:user|bot|char)>/i

function hasDisplayMacroSyntax(value: string): boolean {
  return DISPLAY_MACRO_SYNTAX_RE.test(value)
}

function canTreatMacroSensitiveModesAsNativeReplace(
  content: string,
  scripts: readonly RegexScript[],
): boolean {
  // `raw` resolves macros after capture substitution and `after` resolves the
  // complete replaced body. When neither the input nor any replacement can
  // contain a macro, both modes are observably identical to native replace.
  // Looking at every replacement also guarantees an earlier worker script
  // cannot introduce syntax for a later `raw`/`after` script to consume.
  return scripts.some((script) => (
    script.substitute_macros === 'raw' || script.substitute_macros === 'after'
  ))
    && !hasDisplayMacroSyntax(content)
    && scripts.every((script) => !hasDisplayMacroSyntax(script.replace_string))
}

function isWorkerCapable(script: RegexScript, macroSensitiveModesAreSafe = false): boolean {
  // Bounded preset inputs must be resolved against owned server-side snapshots.
  if (script.preset_id && script.metadata?.prompt_activation && script.find_regex.includes('{{')) return false
  if (script.actions.length > 0) return false
  if (Array.isArray(script.metadata?.match_actions) && script.metadata.match_actions.length > 0) return false
  if (
    (script.substitute_macros === 'raw' || script.substitute_macros === 'after')
    && !macroSensitiveModesAreSafe
  ) return false
  return true
}

function resolveWorkerScript(
  script: RegexScript,
  context: ApplyDisplayRegexContext,
): ApplyWorkerScript | null {
  let pattern = script.find_regex
  if (script.substitute_macros !== 'none') {
    const preResolvedFind = context.resolvedFindPatterns?.get(script.id)
    if (preResolvedFind !== undefined) pattern = preResolvedFind
    else if (context.macroCtx) pattern = resolveRegexStringMacros(pattern, context.macroCtx)
  }
  if (!compileRegex(pattern, script.flags)) return null

  let replaceString = script.replace_string
  const mode = script.substitute_macros
  if (mode !== 'none' && mode !== 'find' && mode !== 'raw' && mode !== 'after') {
    const preResolved = context.resolvedReplacements?.get(script.id)
    if (preResolved !== undefined) {
      replaceString = mode === 'escaped' ? preResolved.replace(/\$/g, '$$$$') : preResolved
    } else if (context.macroCtx) {
      replaceString = resolveReplacementMacros(replaceString, mode, context.macroCtx)
    }
  }

  return {
    pattern,
    flags: script.flags,
    replaceString,
    trimStrings: script.trim_strings,
    scriptId: script.id,
    scriptName: script.name,
  }
}

interface WorkerBatchAttempt {
  ok: boolean
  outcome?: DisplayRegexBackendResult
}

interface RenderDedupe {
  dedupeKey: string
  dedupeGeneration: number
}

let nextRenderGeneration = 1

async function applyBatchInWorker(
  content: string,
  scripts: RegexScript[],
  context: ApplyDisplayRegexContext,
  dedupe: RenderDedupe | null,
): Promise<WorkerBatchAttempt> {
  let remaining = scripts
  let currentContent = content
  while (remaining.length > 0) {
    const resolved: Array<{ script: RegexScript; worker: ApplyWorkerScript }> = []
    for (const script of remaining) {
      const worker = resolveWorkerScript(script, context)
      if (worker) resolved.push({ script, worker })
    }
    if (resolved.length === 0) return { ok: true, outcome: { result: currentContent } }

    try {
      const outcome = await runRegexJobInWorker({
        op: 'apply',
        body: currentContent,
        scripts: resolved.map((entry) => entry.worker),
        ...(dedupe ?? {}),
      })
      return { ok: true, outcome: { result: outcome.result } }
    } catch (error) {
      // A newer render of this message is already queued (abandoning this shouldn't look like a worker failure)
      if (error instanceof RegexJobSupersededError) throw error
      if (error instanceof RegexWorkerTimeoutError) {
        const completedCount = Math.min(
          Math.max(error.completedScriptCount, 0),
          resolved.length,
        )
        const checkpoint = error.checkpointResult
        const unresolved = resolved.slice(completedCount)

        // A local wall-clock deadline cannot distinguish catastrophic
        // backtracking from an innocent worker starved by tab throttling or
        // machine load. Ask the independently scheduled backend sandbox to run
        // only the uncompleted suffix. Its response both resumes from the last
        // checkpoint and identifies regexes it independently had to stop.
        const confirmed = await applyDisplayRegexOnBackend(
          checkpoint,
          unresolved.map((entry) => entry.script),
          context,
        )
        if (confirmed !== null) {
          // Backend timing can only corroborate the script the browser worker
          // actually said it started. A dispatch timeout identifies no script,
          // and later scripts in the suffix were never observed running in the
          // browser. Neither is durable evidence against a pattern.
          const locallyStartedScriptId = error.phase === 'execution'
            ? error.scriptId
            : undefined
          for (const scriptId of confirmed.timedOutScriptIds ?? []) {
            const timedOut = unresolved.find((entry) => entry.script.id === scriptId)
            if (
              !locallyStartedScriptId
              || scriptId !== locallyStartedScriptId
              || !timedOut
              || !shouldPermanentlyQuarantineRegex(
                timedOut.worker.pattern,
                error.environmentCongested,
              )
            ) continue
            quarantineRegexScript(timedOut.script)
            announceSkippedOnce(timedOut.script, 'quarantined', 'worker and backend deadlines exceeded')
          }
          return { ok: true, outcome: confirmed }
        }

        // If confirmation itself is unavailable, preserve the completed prefix
        // and skip the locally active script for this render only. It must not
        // become durable evidence: the timeout may have been pure congestion.
        const localTimedOutIndex = unresolved.findIndex(({ script }) => script.id === error.scriptId)
        if (localTimedOutIndex < 0) return { ok: false }
        console.warn(
          '[display] regex worker deadline exceeded without backend confirmation; skipping once '
          + `(script=${error.scriptId}, phase=${error.phase}, wall=${Math.round(error.wallElapsedMs)}ms, `
          + `schedulerLag=${Number.isFinite(error.schedulerLagMs) ? `${Math.round(error.schedulerLagMs)}ms` : 'unknown'}, `
          + `visible=${error.pageVisible})`,
        )
        currentContent = checkpoint
        remaining = unresolved
          .filter((_, index) => index !== localTimedOutIndex)
          .map((entry) => entry.script)
        continue
      }
      if (
        error instanceof RegexWorkerCrashedError
        || error instanceof RegexWorkerUnsupportedError
        || !(error instanceof RegexWorkerError)
      ) return { ok: false }
      console.warn('[display] worker batch failed; escalating to backend', error)
      return { ok: false }
    }
  }
  return { ok: true, outcome: { result: currentContent } }
}

async function backendThenRaw(
  content: string,
  scripts: RegexScript[],
  context: ApplyDisplayRegexContext,
): Promise<DisplayRegexBackendResult> {
  const backendResult = await applyDisplayRegexOnBackend(content, scripts, context)
  if (backendResult !== null) return backendResult
  for (const script of scripts) announceSkippedOnce(script, 'unavailable', 'worker and backend unavailable')
  return { result: content, cacheable: false }
}

function mergeProvenance(
  target: { touchedVars?: ReadonlySet<string>; sawUncacheable: boolean },
  outcome: DisplayRegexBackendResult,
): void {
  if (outcome.touchedVars) {
    target.touchedVars = target.touchedVars
      ? new Set([...target.touchedVars, ...outcome.touchedVars])
      : new Set(outcome.touchedVars)
  }
  if (outcome.cacheable === false) target.sawUncacheable = true
}

/**
 * User-authored display regexes never execute on the host main thread. Plain
 * replacement scripts run in worker batches; feature-rich scripts use the
 * backend sandbox. A failed isolation boundary renders raw text instead of
 * attempting a synchronous fallback.
 */
export async function applyDisplayRegexTiered(
  content: string,
  scripts: RegexScript[],
  context: ApplyDisplayRegexContext,
): Promise<DisplayRegexBackendResult> {
  const owned = await applyDisplayRegexViaOwnedResolver(content, scripts, context)
  if (owned) return owned

  const eligible: RegexScript[] = []
  for (const script of scripts) {
    if (!placementEligible(script, context)) continue
    const decision = getRegexExecTier(script)
    if (decision.tier === 'quarantined') {
      announceSkippedOnce(script, 'quarantined', decision.reason)
      continue
    }
    eligible.push(script)
  }

  const macroSensitiveModesAreSafe = canTreatMacroSensitiveModesAsNativeReplace(content, eligible)

  let result = content
  const provenance: { touchedVars?: ReadonlySet<string>; sawUncacheable: boolean } = { sawUncacheable: false }
  let workerUsable = workerSupported()
  let index = 0
  const dedupe: RenderDedupe | null = context.messageId
    ? {
      dedupeKey: `${context.messageId}|${context.isUser ? 'user' : 'ai'}`,
      dedupeGeneration: nextRenderGeneration++,
    }
    : null

  while (index < eligible.length) {
    // Recheck against the output of earlier batches. Filtering the whole
    // original list would lose matches introduced by an earlier replacement.
    if (canSkipDisplayRegex(result, eligible[index]!, context.resolvedFindPatterns)) {
      index += 1
      continue
    }
    if (!isWorkerCapable(eligible[index]!, macroSensitiveModesAreSafe)) {
      let end = index + 1
      while (end < eligible.length && !isWorkerCapable(eligible[end]!, macroSensitiveModesAreSafe)) end += 1
      const applied = await backendThenRaw(result, eligible.slice(index, end), context)
      mergeProvenance(provenance, applied)
      result = applied.result
      index = end
      continue
    }

    let end = index + 1
    while (end < eligible.length && isWorkerCapable(eligible[end]!, macroSensitiveModesAreSafe)) end += 1
    const batch = eligible.slice(index, end)
    if (workerUsable) {
      const attempt = await applyBatchInWorker(result, batch, context, dedupe)
      if (attempt.ok) {
        if (attempt.outcome) {
          mergeProvenance(provenance, attempt.outcome)
          result = attempt.outcome.result
        }
        index = end
        continue
      }
      workerUsable = false
    }

    const suffix = eligible.slice(index)
    const applied = await backendThenRaw(result, suffix, context)
    mergeProvenance(provenance, applied)
    return finalize(applied.cacheable, provenance, applied.result)
  }

  return finalize(undefined, provenance, result)
}

function finalize(
  lastCacheable: boolean | undefined,
  provenance: { touchedVars?: ReadonlySet<string>; sawUncacheable: boolean },
  result: string,
): DisplayRegexBackendResult {
  return {
    result,
    ...(provenance.touchedVars ? { touchedVars: provenance.touchedVars } : {}),
    ...(provenance.sawUncacheable || lastCacheable === false ? { cacheable: false } : {}),
  }
}
