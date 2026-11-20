import { compileRegex } from './compile-regex'
import { replaceWithinRegexSearchWindow } from './search-window'
import { cannotMatchRegex } from './match-gate'

export interface ApplyWorkerScript {
  pattern: string
  flags: string
  replaceString: string
  trimStrings: string[]
  scriptId?: string
  scriptName?: string
}

export interface ApplyWorkerJob {
  jobId: number
  op: 'apply'
  body: string
  scripts: ApplyWorkerScript[]
}

export type ApplyWorkerResponse =
  | { type: 'ready' }
  | { type: 'progress'; jobId: number; scriptIndex: number; scriptId?: string; scriptName?: string }
  | { type: 'checkpoint'; jobId: number; scriptIndex: number; result: string; elapsedMs: number }
  | { type: 'result'; jobId: number; op: 'apply'; result: string; elapsedMs: number; scriptElapsedMs: number[] }
  | { type: 'error'; jobId: number; error: string; elapsedMs: number }

const TRIM_LOOP_MAX_ITERATIONS = 32

function scriptLabel(script: ApplyWorkerScript): string {
  const id = script.scriptId ?? 'unknown'
  return script.scriptName ? `${id} (${script.scriptName})` : id
}

function applyBoundedTrim(result: string, trimStrings: readonly string[], label: string): string {
  for (const trim of trimStrings) {
    if (trim === '') continue
    let iterations = 0
    while (result.includes(trim)) {
      result = result.replaceAll(trim, '')
      iterations += 1
      if (iterations >= TRIM_LOOP_MAX_ITERATIONS) {
        console.warn(`[regex-worker] trim loop capped after ${TRIM_LOOP_MAX_ITERATIONS} iterations for script ${label}`)
        break
      }
    }
  }
  return result
}

function applyOne(body: string, script: ApplyWorkerScript): string {
  const regex = compileRegex(script.pattern, script.flags)
  if (!regex) throw new Error(`invalid pattern for script ${scriptLabel(script)}`)
  const replaced = replaceWithinRegexSearchWindow(
    body,
    regex,
    script.pattern,
    script.flags,
    script.replaceString,
    script.replaceString,
  )
  return applyBoundedTrim(replaced, script.trimStrings, scriptLabel(script))
}

const workerSelf = self as unknown as {
  onmessage: ((event: { data: ApplyWorkerJob }) => void) | null
  postMessage(message: ApplyWorkerResponse): void
}

workerSelf.postMessage({ type: 'ready' })

workerSelf.onmessage = (event) => {
  const job = event.data
  const startedAt = performance.now()
  try {
    if (job.op !== 'apply') throw new Error(`unknown op ${(job as ApplyWorkerJob).op}`)
    let result = job.body
    const scriptElapsedMs: number[] = []
    for (let scriptIndex = 0; scriptIndex < job.scripts.length; scriptIndex += 1) {
      const script = job.scripts[scriptIndex]!
      if (
        cannotMatchRegex(result, script.pattern, script.flags)
        && !script.trimStrings.some((trim) => trim !== '' && result.includes(trim))
      ) {
        scriptElapsedMs.push(0)
        continue
      }
      // A checkpoint is needed only before work that could hang. Skipped
      // scripts produce no progress traffic or deadline resets.
      if (scriptIndex > 0) workerSelf.postMessage({
        type: 'checkpoint', jobId: job.jobId, scriptIndex: scriptIndex - 1,
        result, elapsedMs: scriptElapsedMs[scriptIndex - 1]!,
      })
      workerSelf.postMessage({
        type: 'progress',
        jobId: job.jobId,
        scriptIndex,
        ...(script.scriptId ? { scriptId: script.scriptId } : {}),
        ...(script.scriptName ? { scriptName: script.scriptName } : {}),
      })
      const scriptStartedAt = performance.now()
      result = applyOne(result, script)
      // Preserve the browser's available sub-millisecond resolution. Rounding
      // here made very fast regexes indistinguishable from one another at 0ms.
      const scriptElapsed = performance.now() - scriptStartedAt
      scriptElapsedMs.push(scriptElapsed)
    }
    workerSelf.postMessage({
      type: 'result',
      jobId: job.jobId,
      op: 'apply',
      result,
      elapsedMs: performance.now() - startedAt,
      scriptElapsedMs,
    })
  } catch (error) {
    workerSelf.postMessage({
      type: 'error',
      jobId: job?.jobId ?? -1,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: performance.now() - startedAt,
    })
  }
}
