import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchTestBrowser } from './browser-runtime.mjs';
import { createTelemetryCollector, metricDeltas } from './telemetry.mjs';
import { extractGpuMemory, traceBytes, startMemoryTrace } from './telemetry-trace.mjs';
import { diagnosticConfig, runDiagnose } from './diagnose.mjs';

test('counter deltas reject resets and preserve negative heap deltas', () => {
  const delta = metricDeltas({ LayoutCount: 4, LayoutDuration: 0.004, JSHeapUsedSize: 100 },
    { LayoutCount: 6, LayoutDuration: 0.01, JSHeapUsedSize: 50 });
  assert.equal(delta.raw.LayoutCount, 2);
  assert.equal(delta.counters.LayoutDuration.value, 6);
  assert.equal(delta.counters.LayoutDuration.unit, 'ms');
  assert.equal(delta.raw.JSHeapUsedSize, -50);
  assert.equal(metricDeltas({ LayoutCount: 4 }, { LayoutCount: 0 }).raw.LayoutCount, null);
  assert.equal(metricDeltas({ LayoutCount: 4 }, { LayoutCount: 8 }, false).raw.LayoutCount, null);
  assert.deepEqual(metricDeltas({}, { LayoutCount: 8 }).raw, {});
});

test('GPU extraction correlates checkpoints without summing shared or nested allocations', () => {
  const bytes = value => ({ type: 'scalar', units: 'bytes', value });
  const events = [{ name: 'process_name', pid: 42, args: { name: 'GPU Process' } },
    { ph: 'v', id: '000a', pid: 42, args: { dumps: { allocators: {
      gpu: { attrs: { size: bytes('1000'), effective_size: bytes('800') } },
      'gpu/shared_images': { attrs: { size: bytes('1000') } },
    } } } },
    { ph: 'v', id: 'a', pid: 7, args: { dumps: { allocators: { gpu: { attrs: { size: bytes('999999') } } } } } }];
  const result = extractGpuMemory(events, [{ label: 'before', dumpGuid: '0xa', success: true }, { label: 'after', dumpGuid: 'b', success: false }]);
  assert.equal(result.checkpoints[0].bytes, 4096);
  assert.equal(result.checkpoints[0].status, 'ok');
  assert.equal(result.checkpoints[1].bytes, null);
  assert.equal(result.records.length, 1);
  assert.equal(traceBytes(bytes('not-a-number')), null);
  assert.equal(traceBytes(bytes('ffffffffffffffff')), null);
  assert.equal(traceBytes({ type: 'scalar', units: 'objects', value: '100' }), null);
  assert.equal(traceBytes(bytes('0')), 0);
});

test('diagnostic options reject invalid intervals before launching a browser', () => {
  const env = { LUMIVERSE_URL: 'http://localhost/', LUMIVERSE_USER: 'test', LUMIVERSE_PASS: 'test' };
  assert.equal(diagnosticConfig(env).channel, 'chromium');
  assert.equal(diagnosticConfig(env).baseUrl, 'http://localhost');
  assert.throws(() => diagnosticConfig({ ...env, DIAG_SAMPLE_MS: 'NaN' }), /DIAG_SAMPLE_MS/);
  assert.throws(() => diagnosticConfig({ ...env, DIAG_BROWSER_CHANNEL: 'random' }), /DIAG_BROWSER_CHANNEL/);
});

test('GPU checkpoints use clock windows when Perfetto rewrites dump GUIDs', () => {
  const size = value => ({ type: 'scalar', units: 'bytes', value });
  const events = [{ name: 'process_name', pid: 42, args: { name: 'GPU Process' } },
    { name: 'clock_sync', ts: 10, args: { sync_id: 'start' } },
    { ph: 'v', id: '0x0', ts: 15, pid: 42, args: { dumps: { allocators: { gpu: { attrs: { size: size('1000') } } } } } },
    { name: 'clock_sync', ts: 20, args: { sync_id: 'end' } },
    // This ID happens to match the CDP GUID but belongs to another request.
    { ph: 'v', id: '0xa', ts: 30, pid: 42, args: { dumps: { allocators: { gpu: { attrs: { size: size('2000') } } } } } }];
  const checkpoint = { label: 'before', dumpGuid: '0xa', success: true, clockSync: { start: 'start', end: 'end' } };
  const result = extractGpuMemory(events, [checkpoint]);
  assert.equal(result.checkpoints[0].bytes, 4096);
  assert.equal(result.checkpoints[0].correlation, 'trace-clock-window');
  assert.equal(extractGpuMemory(events.filter(e => e.name !== 'clock_sync'), [checkpoint]).checkpoints[0].status, 'unavailable');
  const ambiguous = [...events, { ...events[2], id: '0xb', ts: 16 }];
  assert.equal(extractGpuMemory(ambiguous, [checkpoint]).checkpoints[0].status, 'unavailable');
});

test('trace exporter bounds output and releases streams/listeners after errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lumiverse-trace-limit-'));
  try {
    const session = new EventEmitter();
    const commands = [];
    session.send = async method => {
      commands.push(method);
      if (method === 'Tracing.end') session.emit('Tracing.tracingComplete', { stream: 'fixture' });
      return method === 'IO.read' ? { data: 'x'.repeat(1024), eof: true } : {};
    };
    const trace = await startMemoryTrace(session, join(directory, 'bounded.json'), { maxBytes: 32 });
    const result = await trace.stop();
    assert.equal(result.status, 'error');
    assert.match(result.reason, /byte limit/);
    assert.ok(commands.includes('IO.close'));
    assert.equal(session.listenerCount('Tracing.tracingComplete'), 0);
    assert.equal(session.listenerCount('Tracing.bufferUsage'), 0);

    const stalled = new EventEmitter();
    stalled.send = async () => ({});
    const timeoutTrace = await startMemoryTrace(stalled, join(directory, 'timeout.json'), { timeoutMs: 20 });
    assert.match((await timeoutTrace.stop()).reason, /Timed out/);
    assert.equal(stalled.listenerCount('Tracing.tracingComplete'), 0);

    const busy = new EventEmitter();
    const busyCommands = [];
    busy.send = async method => { busyCommands.push(method); throw new Error('Tracing already started'); };
    await assert.rejects(() => startMemoryTrace(busy, join(directory, 'busy.json')), /already started/);
    assert.deepEqual(busyCommands, ['Tracing.start'], 'do not end another recorder');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Chromium samples persistent counters, backing storage and callbacks without patching rAF', async () => {
  const runtime = await launchTestBrowser('chromium', { channel: 'chromium' });
  let collector;
  try {
    const page = await runtime.browser.newPage();
    await page.setContent('<main></main>');
    await page.evaluate(() => { window.originalRAF = requestAnimationFrame; });
    collector = await createTelemetryCollector(page, { intervalMs: 100, maxSamples: 2 });
    assert.equal((await collector.stop()).running, false);
    await collector.start('known memory and layout work');
    await page.evaluate(() => {
      window.retained = new Uint8Array(4 * 1024 * 1024);
      window.retained.fill(7);
      document.querySelector('main').innerHTML = '<div>fixture</div>'.repeat(500);
      document.querySelector('main').addEventListener('click', () => {});
      void document.body.offsetHeight;
      requestAnimationFrame(() => {
        const end = performance.now() + 80;
        while (performance.now() < end) {}
      });
      document.dispatchEvent(new Event('lumiverse:message-content-layout'));
    });
    await page.waitForTimeout(350);
    await page.evaluate(() => { window.retained = null; });
    const gc = await page.context().newCDPSession(page);
    await gc.send('HeapProfiler.collectGarbage'); // Fixture-only: normal telemetry never forces GC.
    await gc.detach();
    await page.waitForTimeout(200);
    const report = await collector.stop();
    assert.equal(report.valid, true);
    assert.ok(report.metricDelta.LayoutCount >= 1, 'layout counters survive between snapshots');
    assert.ok(report.heap.values.backingStorageSize.sampledPeak - report.heap.values.backingStorageSize.before >= 4 * 1024 * 1024);
    assert.ok(report.heap.values.backingStorageSize.after < report.heap.values.backingStorageSize.sampledPeak);
    assert.ok(report.dom.values.nodes.delta >= 900); // GC can also reclaim the initial empty document.
    assert.ok(report.dom.values.jsEventListeners.delta >= 1);
    assert.ok(report.browser.rafCount > 1);
    assert.ok(report.browser.frameCadence.count > 0);
    assert.ok(report.browser.totals.longTasks >= 1);
    assert.equal(report.browser.layoutEvents, 1);
    assert.equal(report.samples.length, 2);
    assert.ok(report.skippedSamples > 0);
    assert.equal(report.samples.at(-1).label, 'after');
    assert.equal(await page.evaluate(() => requestAnimationFrame === window.originalRAF), true);
    assert.doesNotThrow(() => JSON.stringify(report));
    await collector.close();
    collector = null;
    assert.equal(await page.evaluate(() => typeof window.__LUMIVERSE_PERF__), 'undefined');
  } finally { await collector?.close(); await runtime.close(); }
});

for (const engine of ['firefox', 'webkit']) {
  test(`${engine} collects browser signals and explicitly skips CDP memory`, async () => {
    const runtime = await launchTestBrowser(engine);
    let collector;
    try {
      const page = await runtime.browser.newPage();
      collector = await createTelemetryCollector(page, { intervalMs: 100 });
      await collector.start('cross-browser signals');
      await page.waitForTimeout(150);
      const report = await collector.stop();
      assert.equal(report.valid, true);
      assert.equal(report.heap.status, 'unsupported');
      assert.equal(report.environment.gpu.status, 'unsupported');
      assert.ok(report.browser.rafCount > 0);
    } finally { await collector?.close(); await runtime.close(); }
  });
}

test('navigation invalidates deltas instead of comparing different documents', async () => {
  const runtime = await launchTestBrowser('chromium');
  let collector;
  try {
    const page = await runtime.browser.newPage();
    collector = await createTelemetryCollector(page, { intervalMs: 100 });
    await collector.start();
    await page.goto('data:text/html,<h1>new document</h1>');
    const report = await collector.stop();
    assert.equal(report.valid, false);
    assert.ok(report.invalidReasons.some(reason => /navigation|changed/i.test(reason)));
    assert.ok(Object.values(report.metricDelta).every(value => value === null));
  } finally { await collector?.close(); await runtime.close(); }
});

test('console collector reports missing observers, bounds events and stops automatically', async () => {
  const runtime = await launchTestBrowser('chromium');
  try {
    const page = await runtime.browser.newPage();
    await page.evaluate(() => { Object.defineProperty(PerformanceObserver, 'supportedEntryTypes', { value: [] }); });
    await page.evaluate(await readFile(new URL('./telemetry-browser.iife.js', import.meta.url), 'utf8'));
    await page.evaluate(() => {
      window.__LUMIVERSE_PERF__.start({ maxEntries: 2, maxDurationMs: 100 });
      for (let i = 0; i < 10; i++) window.__LUMIVERSE_PERF__.mark('bounded');
    });
    await page.waitForTimeout(180);
    const report = await page.evaluate(() => window.__LUMIVERSE_PERF__.getReport());
    assert.equal(report.running, false);
    assert.equal(report.stopReason, 'duration-limit');
    assert.equal(report.marks.length, 2);
    assert.equal(report.dropped.marks, 8);
    assert.equal(report.capabilities.longtask.status, 'unsupported');
  } finally { await runtime.close(); }
});

test('diagnose runs against mock login/chat APIs and emits a real streamed GPU trace', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'lumiverse-telemetry-test-'));
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('content-type', 'text/html');
    if (url.pathname === '/login') response.end(`<form><input id="username"><input id="password" type="password"><button type="submit">Login</button></form>
      <script>document.querySelector('form').onsubmit = event => { event.preventDefault(); history.pushState({}, '', '/'); }</script>`);
    else if (url.pathname === '/api/v1/chats/recent-grouped') response.end(JSON.stringify({ data: [{ latest_chat_id: 'fixture', character_name: 'Fixture' }] }));
    else if (url.pathname.endsWith('/messages')) response.end(JSON.stringify({ total: 100 }));
    else if (url.pathname === '/events') { response.setHeader('content-type', 'text/event-stream'); response.write('data: connected\n\n'); }
    else if (url.pathname === '/chat/fixture') response.end(`<style>[data-component] { height: 400px; overflow: auto } article { height: 80px }</style>
      <div data-component="MessageList">${Array.from({ length: 100 }, (_, i) => `<article data-item-type="message" data-virtual-index="${i}">Message ${i}</article>`).join('')}</div>
      <script>document.querySelector('[data-component]').scrollTop = 10000; new EventSource('/events');</script>`);
    else response.end('<h1>Landing</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = diagnosticConfig({ LUMIVERSE_URL: `http://127.0.0.1:${server.address().port}`, LUMIVERSE_USER: 'fixture',
      LUMIVERSE_PASS: 'test-secret-never-report', OUT_DIR: outDir, DIAG_SAMPLE_MS: '100', DIAG_GPU_TRACE: '1', DIAG_SETTLE_MS: '0', DIAG_SCROLL_WAIT_MS: '300' });
    const report = await runDiagnose(config);
    assert.equal(report.chatId, 'fixture');
    assert.equal(report.totalMessages, 100);
    assert.equal(report.telemetry.valid, true);
    assert.equal(report.diag.running, false);
    assert.ok(report.diag.rafCount > 0);
    assert.ok(['ok', 'incomplete'].includes(report.telemetry.trace.status), JSON.stringify(report.telemetry.trace));
    assert.equal(report.telemetry.trace.gpuMemory.checkpoints.length, 2);
    assert.ok(report.telemetry.trace.gpuMemory.checkpoints.every(checkpoint => checkpoint.success));
    if (report.telemetry.trace.gpuMemory.records.length) {
      assert.ok(report.telemetry.trace.gpuMemory.checkpoints.every(checkpoint => checkpoint.status === 'ok'),
        'actual GPU allocator records must correlate with requested checkpoints');
      assert.equal(typeof report.telemetry.trace.gpuMemory.deltaBytes, 'number');
    }
    const trace = JSON.parse(await readFile(join(outDir, 'performance-trace.json'), 'utf8'));
    assert.ok(trace.traceEvents.some(event => event.ph === 'v'), 'real memory dump records');
    const analyzed = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('./analyze-trace.mjs', import.meta.url)), join(outDir, 'performance-trace.json')]);
    assert.match(analyzed.stdout, /inclusive event durations/);
    assert.ok((await readdir(outDir)).includes('chat-after-scroll.png'));
    const saved = await readFile(join(outDir, 'report.json'), 'utf8');
    assert.ok(!saved.includes(config.password));
    assert.equal(JSON.parse(saved).schemaVersion, 2);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(outDir, { recursive: true, force: true });
  }
});
