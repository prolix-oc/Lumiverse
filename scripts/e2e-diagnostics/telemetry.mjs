import { readFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { startMemoryTrace } from './telemetry-trace.mjs';

const browserSource = await readFile(new URL('./telemetry-browser.iife.js', import.meta.url), 'utf8');
const COUNTERS = ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration',
  'TaskDuration', 'TaskOtherDuration', 'V8CompileDuration'];
const GAUGES = ['JSHeapUsedSize', 'JSHeapTotalSize', 'Documents', 'Nodes', 'JSEventListeners', 'LayoutObjects'];

export function metricDeltas(before, after, valid = true) {
  const raw = {};
  const counters = {};
  for (const key of [...COUNTERS, ...GAUGES]) {
    if (!Number.isFinite(before?.[key]) || !Number.isFinite(after?.[key])) continue;
    const difference = after[key] - before[key];
    const usable = valid && (!COUNTERS.includes(key) || difference >= 0);
    raw[key] = usable ? difference : null;
    if (COUNTERS.includes(key)) counters[key] = { value: usable ? difference * (key.endsWith('Duration') ? 1000 : 1) : null,
      unit: key.endsWith('Duration') ? 'ms' : 'count', status: usable ? 'ok' : 'unavailable',
      ...(!usable ? { reason: 'Measurement context changed or cumulative counter reset' } : {}) };
  }
  return { raw, counters };
}

function gaugeSummary(samples, key, fields, source, scope, valid, aggregate) {
  const available = samples.filter(s => s[key]?.status === 'ok');
  const first = samples[0]?.[key];
  const last = samples.at(-1)?.[key];
  return { source, scope, unit: key === 'dom' ? 'count' : 'bytes',
    status: available.length ? 'ok' : first?.status || 'unavailable',
    ...(!available.length ? { reason: first?.reason || 'No samples collected' } : {}),
    sampleCount: aggregate.count, retainedSampleCount: available.length, interpretation: 'Sampled peaks can miss allocations between checkpoints',
    values: Object.fromEntries(fields.map(field => {
      const before = first?.status === 'ok' && Number.isFinite(first.value[field]) ? first.value[field] : null;
      const after = last?.status === 'ok' && Number.isFinite(last.value[field]) ? last.value[field] : null;
      return [field, { before, after, sampledPeak: aggregate.peaks[field] ?? null,
        delta: valid && before !== null && after !== null ? after - before : null }];
    })) };
}

/** One measurement window, one enabled Performance session. No app globals are patched. */
export async function createTelemetryCollector(page, { intervalMs = 500, maxSamples = 1000, maxDurationMs = 60000,
  tracePath = null, traceMaxBytes, commandTimeoutMs = 5000 } = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 10000) throw new Error('Telemetry interval must be 100–10000 ms');
  if (!Number.isInteger(maxSamples) || maxSamples < 2 || maxSamples > 10000) throw new Error('Telemetry maxSamples must be 2–10000');
  if (!Number.isInteger(maxDurationMs) || maxDurationMs < 100 || maxDurationMs > 300000) throw new Error('Telemetry duration must be 100–300000 ms');
  const browser = page.context().browser();
  let cdp = null;
  let root = null;
  let performanceEnabled = false;
  let running = false;
  let started = false;
  let closed = false;
  let stopping = null;
  let poll = null;
  let deadline = null;
  let pending = Promise.resolve();
  let trace = null;
  let traceReport = { status: 'disabled' };
  let browserReport = null;
  let valid = true;
  let identity = null;
  let startedAt = null;
  let skippedSamples = 0;
  const samples = [];
  const errors = [];
  const reasons = new Set();
  const aggregates = { heap: { count: 0, peaks: {} }, dom: { count: 0, peaks: {} } };
  const recordError = (operation, error) => {
    if (errors.length < 20) errors.push({ operation, reason: error.message });
  };
  const read = async (session, method) => {
    if (!session) return { status: 'unsupported', reason: 'CDP requires Chromium' };
    try { return { status: 'ok', value: await session.send(method, {}, { timeout: commandTimeoutMs }) }; }
    catch (error) { return { status: 'error', reason: error.message }; }
  };
  const environment = { browser: browser?.browserType().name() || 'unknown', version: browser?.version() || 'unknown',
    os: platform(), osRelease: release(), architecture: arch(), viewport: page.viewportSize(),
    coverage: 'Main target only; workers and out-of-process frames are not separately sampled' };

  try {
    await page.addInitScript({ content: browserSource });
    await page.evaluate(browserSource);
    if (environment.browser === 'chromium') {
      cdp = await page.context().newCDPSession(page);
      const enabled = await read(cdp, 'Performance.enable');
      performanceEnabled = enabled.status === 'ok';
      if (!performanceEnabled) recordError('Performance.enable', new Error(enabled.reason));
      try { root = await browser.newBrowserCDPSession(); }
      catch (error) { recordError('browser CDP session', error); }
    }
    const gpu = await read(root, 'SystemInfo.getInfo');
    environment.gpu = gpu.status === 'ok' ? { status: 'ok', source: 'SystemInfo.getInfo', scope: 'browser',
      devices: gpu.value.gpu.devices, featureStatus: gpu.value.gpu.featureStatus,
      renderer: gpu.value.gpu.auxAttributes?.glRenderer || null,
      displayType: gpu.value.gpu.auxAttributes?.displayType || null } : gpu;
  } catch (error) {
    await cdp?.detach().catch(() => {});
    await root?.detach().catch(() => {});
    throw error;
  }

  function invalidate(reason) { valid = false; reasons.add(reason); }

  async function sample(label) {
    const start = performance.now();
    const [metrics, heap, dom, isolate, document] = await Promise.all([
      performanceEnabled ? read(cdp, 'Performance.getMetrics') : Promise.resolve({ status: 'unavailable', reason: 'Performance domain not enabled' }),
      read(cdp, 'Runtime.getHeapUsage'), read(cdp, 'Memory.getDOMCounters'), read(cdp, 'Runtime.getIsolateId'),
      page.evaluate(() => ({ timeOrigin: performance.timeOrigin, devicePixelRatio, visibility: document.visibilityState }))
        .then(value => ({ status: 'ok', value }), error => ({ status: 'error', reason: error.message })),
    ]);
    if (metrics.status === 'ok') metrics.value = Object.fromEntries(metrics.value.metrics.map(m => [m.name, m.value]));
    for (const [key, reading] of Object.entries({ heap, dom })) {
      if (reading.status !== 'ok') continue;
      aggregates[key].count++;
      for (const [field, value] of Object.entries(reading.value)) {
        if (Number.isFinite(value)) aggregates[key].peaks[field] = Math.max(aggregates[key].peaks[field] ?? 0, value);
      }
    }
    const signature = document.status === 'ok' ? `${document.value.timeOrigin}:${isolate.value?.id || ''}` : null;
    if (signature === null) invalidate('Document unavailable during measurement');
    else if (identity === null) identity = signature;
    else if (signature !== identity) invalidate('Document navigation or V8 isolate changed');
    const previous = samples.at(-1)?.metrics.value;
    if (metrics.status === 'ok' && COUNTERS.some(key => Number.isFinite(previous?.[key]) && metrics.value[key] < previous[key])) {
      invalidate('Cumulative performance counters reset');
    }
    const entry = { label, atMs: start - startedAt, collectionDurationMs: performance.now() - start, metrics, heap, dom, document };
    // Keep the initial and latest endpoint; intermediate samples are bounded.
    if (samples.length < maxSamples) samples.push(entry);
    else { samples[samples.length - 1] = entry; skippedSamples++; }
    return entry;
  }

  function schedule() {
    if (!running || !valid) return;
    poll = setTimeout(() => {
      pending = sample('interval').catch(error => { recordError('sample', error); invalidate('Sampling failed'); });
      pending.then(schedule);
    }, intervalMs);
  }

  function getReport() {
    const before = samples[0]?.metrics.value || {};
    const after = samples.at(-1)?.metrics.value || {};
    const deltas = metricDeltas(before, after, valid);
    return { schemaVersion: 1, valid, invalidReasons: [...reasons], running, environment,
      settings: { intervalMs, maxSamples, maxDurationMs, traceEnabled: Boolean(tracePath) },
      samples: structuredClone(samples), skippedSamples, errors: structuredClone(errors), browser: browserReport,
      metricsBefore: before, metricsAfter: after, metricDelta: deltas.raw, counterDelta: deltas.counters,
      heap: gaugeSummary(samples, 'heap', ['usedSize', 'totalSize', 'embedderHeapUsedSize', 'backingStorageSize'],
        'Runtime.getHeapUsage', 'V8 isolate (can include shared contexts); components are not a total RAM measurement', valid, aggregates.heap),
      dom: gaugeSummary(samples, 'dom', ['documents', 'nodes', 'jsEventListeners'],
        'Memory.getDOMCounters', 'renderer DOM objects, including objects awaiting collection', valid, aggregates.dom),
      trace: traceReport };
  }

  async function stop(reason = 'manual') {
    if (!started) return getReport();
    if (stopping) return stopping;
    stopping = (async () => {
      running = false;
      clearTimeout(poll);
      clearTimeout(deadline);
      try {
        browserReport = await page.evaluate(stopReason => window.__LUMIVERSE_PERF__?.stop(stopReason), reason);
        if (!browserReport) invalidate('Browser collector lost during navigation');
      } catch (error) { recordError('browser stop', error); invalidate('Browser collector unavailable'); }
      await pending;
      await sample('after');
      if (trace) {
        await trace.checkpoint('after');
        traceReport = await trace.stop();
        trace = null;
      }
      return getReport();
    })();
    return stopping;
  }

  return {
    environment, getReport,
    async start(label = 'scroll') {
      if (closed || started) throw new Error('Create a new telemetry collector for each measurement window');
      started = true;
      if (tracePath) {
        if (!root) traceReport = { status: 'unsupported', reason: 'GPU traces require Chromium browser CDP' };
        else {
          try {
            trace = await startMemoryTrace(root, tracePath, { maxBytes: traceMaxBytes });
            await trace.checkpoint('before');
          } catch (error) { traceReport = { status: 'error', reason: error.message }; }
        }
      }
      startedAt = performance.now();
      await page.evaluate(options => window.__LUMIVERSE_PERF__.start(options), { label, intervalMs, maxDurationMs });
      running = true;
      await sample('before');
      schedule();
      deadline = setTimeout(() => { stop('duration-limit').catch(error => recordError('automatic stop', error)); }, maxDurationMs);
      return getReport();
    },
    stop,
    async close() {
      if (closed) return;
      closed = true;
      try { if (started) await stop('closed'); }
      finally {
        clearTimeout(poll);
        clearTimeout(deadline);
        await page.evaluate(() => window.__LUMIVERSE_PERF__?.dispose()).catch(() => {});
        await cdp?.detach().catch(() => {});
        await root?.detach().catch(() => {});
      }
    },
  };
}
