import type { ImageGenRequest } from "../types"

/** Bounded, per-request telemetry at the actual WebSocket receive boundary.
 * Swarm's overall fraction is workflow-node weighted, not elapsed time.
 * Do not log raw frames: previews, metadata and output paths can be private.
 */
export function createSwarmStreamTrace(
  sink: ImageGenRequest["onProviderTrace"],
  clock = () => performance.now(),
) {
  if (!sink) return undefined
  const start = clock()
  const elapsed = () => Math.max(0, Math.round(clock() - start))
  const event = (action: string, details?: Record<string, unknown>) => {
    try { sink({ action, atMs: Date.now(), elapsedMs: elapsed(), details }) } catch { /* diagnostics cannot fail a render */ }
  }
  // Keep the first sample and the most recent 63, with at most one ordinary
  // sample per two seconds. Raw fractions are retained (not rounded percentages).
  type Sample = [number, number | null, number | null, boolean]
  const samples: Sample[] = []
  let lastSampleAt = -Infinity
  let firstProgressMs: number | undefined
  let lastProgressMs: number | undefined
  let nearEndMs: number | undefined
  let previousOverall: number | null = null
  let previousCurrent: number | null = null
  let progressCount = 0, previewCount = 0, overallRegressions = 0, currentRegressions = 0, droppedSamples = 0
  let plateauStep: number | undefined, plateauStart = 0, longestRoundedPlateauMs = 0
  let highWaterStep: number | undefined, highWaterStart = 0, longestHighWaterPlateauMs = 0
  let maxOverall: number | null = null
  let lastOverall: number | null = null, lastCurrent: number | null = null
  const fraction = (value: number | null) => typeof value === "number" && Number.isFinite(value) ? value : null
  function progress(rawOverall: number | null, rawCurrent: number | null, hasPreview: boolean) {
    const overall = fraction(rawOverall), current = fraction(rawCurrent)
    if (overall === null && current === null) return
    const now = elapsed()
    progressCount++
    if (hasPreview) previewCount++
    if (firstProgressMs === undefined) {
      firstProgressMs = now
      event("first-progress-frame", { overall, current })
    }
    lastProgressMs = now
    lastOverall = overall; lastCurrent = current
    const overallBack = overall !== null && previousOverall !== null && overall < previousOverall - 0.000001
    const currentBack = current !== null && previousCurrent !== null && current < previousCurrent - 0.000001
    if (overallBack) overallRegressions++
    if (currentBack) currentRegressions++
    if (overall !== null) { previousOverall = overall; maxOverall = Math.max(maxOverall ?? overall, overall) }
    if (current !== null) previousCurrent = current
    const displayed = Math.round((overall ?? current!) * 100)
    if (plateauStep !== displayed) { plateauStep = displayed; plateauStart = now }
    longestRoundedPlateauMs = Math.max(longestRoundedPlateauMs, now - plateauStart)
    if (highWaterStep === undefined || displayed > highWaterStep) { highWaterStep = displayed; highWaterStart = now }
    longestHighWaterPlateauMs = Math.max(longestHighWaterPlateauMs, now - highWaterStart)
    const nearEnd = nearEndMs === undefined && displayed >= 90
    if (nearEnd) { nearEndMs = now; event("near-end-frame", { overall, current }) }
    if (now - lastSampleAt >= 2_000 || nearEnd || overallBack || currentBack) {
      if (samples.length >= 64) { samples.splice(1, 1); droppedSamples++ }
      samples.push([now, overall, current, hasPreview]); lastSampleAt = now
    }
  }
  function summary() {
    event("raw-progress-summary", { firstProgressMs, lastProgressMs, nearEndMs, progressCount, previewCount,
      maxOverall, lastOverall, lastCurrent, overallRegressions, currentRegressions, longestRoundedPlateauMs,
      longestHighWaterPlateauMs, droppedSamples, sampleFields: ["elapsedMs", "overall", "current", "preview"], samples: samples.map(sample => [...sample]) })
  }
  return { event, progress, summary }
}

export type SwarmStreamTrace = NonNullable<ReturnType<typeof createSwarmStreamTrace>>
