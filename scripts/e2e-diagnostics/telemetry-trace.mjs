import { open, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export function traceBytes(scalar) {
  if (scalar?.units !== 'bytes' || scalar.type !== 'scalar') return null;
  const value = scalar.value;
  if (typeof value !== 'string' || !/^(?:0x)?[0-9a-f]+$/i.test(value)) return null;
  const number = Number.parseInt(value.replace(/^0x/i, ''), 16);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

const guid = value => String(value ?? '').toLowerCase().replace(/^0x/, '').replace(/^0+(?=.)/, '');

/** GPU root sizes only: descendants and cross-process shared resources overlap. */
export function extractGpuMemory(events, checkpoints = []) {
  const gpuPids = new Set(events.filter(e => e.name === 'process_name' && /gpu process/i.test(e.args?.name || '')).map(e => e.pid));
  const records = events.filter(e => e.ph === 'v' && gpuPids.has(e.pid) && e.args?.dumps?.allocators?.gpu).map(e => ({
    dumpGuid: guid(e.id), pid: e.pid, timestampUs: e.ts,
    bytes: traceBytes(e.args.dumps.allocators.gpu.attrs?.size),
  }));
  const measurements = checkpoints.map(checkpoint => {
    // Perfetto's JSON exporter replaces dump GUIDs with snapshot row IDs.
    // Clock markers survive that conversion and bound one explicit request.
    const clock = checkpoint.clockSync;
    const markerTime = id => events.filter(e => e.name === 'clock_sync' && e.args?.sync_id === id && Number.isFinite(e.ts));
    const start = clock ? markerTime(clock.start) : [];
    const end = clock ? markerTime(clock.end) : [];
    const bounded = start.length === 1 && end.length === 1 && start[0].ts <= end[0].ts;
    const matching = clock
      ? bounded ? records.filter(record => record.timestampUs >= start[0].ts && record.timestampUs <= end[0].ts) : []
      : records.filter(record => record.dumpGuid === guid(checkpoint.dumpGuid));
    const valid = checkpoint.success !== false && matching.length === 1 && matching[0].bytes !== null;
    return { ...checkpoint, status: valid ? 'ok' : 'unavailable', bytes: valid ? matching[0].bytes : null,
      ...(valid ? { pid: matching[0].pid, correlation: clock ? 'trace-clock-window' : 'dump-guid' }
        : { reason: checkpoint.reason || 'Missing, ambiguous or unsupported GPU allocator record' }) };
  });
  const before = measurements.find(m => m.label === 'before');
  const after = measurements.find(m => m.label === 'after');
  return { source: 'Chromium memory-infra GPU process gpu allocator size', scope: 'browser-wide GPU allocations', unit: 'bytes',
    interpretation: 'Chromium allocation accounting, not physical VRAM residency or extension-owned memory',
    deltaBytes: before?.status === 'ok' && after?.status === 'ok' && before.pid === after.pid ? after.bytes - before.bytes : null,
    checkpoints: measurements, records };
}

/** A trace is separate from lightweight sampling and never owns another recorder. */
export async function startMemoryTrace(session, filePath, { maxBytes = 128 * 1024 * 1024, timeoutMs = 10000,
  categories = ['devtools.timeline', 'blink.user_timing', 'disabled-by-default-memory-infra'] } = {}) {
  const send = (method, params = {}) => session.send(method, params, { timeout: timeoutMs });
  await send('Tracing.start', { transferMode: 'ReturnAsStream', bufferUsageReportingInterval: 1000,
    // Detailed allocator dumps for a real application can exceed 16 MiB even
    // without timeline events. Keep the recorder bounded, with space for both.
    traceConfig: { recordMode: 'recordUntilFull', traceBufferSizeInKb: 65536,
      // Broad cc/viz/gpu categories fill this bounded buffer within seconds on
      // real chats. GPU allocator dumps only need memory-infra.
      includedCategories: categories,
      excludedCategories: ['*'], memoryDumpConfig: { triggers: [] } } });
  const checkpoints = [];
  let ended = false;
  let bufferFull = false;
  const onBuffer = event => { if (event.percentFull >= 1) bufferFull = true; };
  session.on('Tracing.bufferUsage', onBuffer);
  return {
    async checkpoint(label) {
      const start = performance.now();
      const marker = `lumiverse-memory-${randomUUID()}`;
      const clockSync = { start: `${marker}-start`, end: `${marker}-end` };
      try {
        await send('Tracing.recordClockSyncMarker', { syncId: clockSync.start });
        const dump = await send('Tracing.requestMemoryDump', { deterministic: false, levelOfDetail: 'detailed' });
        await send('Tracing.recordClockSyncMarker', { syncId: clockSync.end });
        checkpoints.push({ label, dumpGuid: dump.dumpGuid, clockSync, success: dump.success, collectionDurationMs: performance.now() - start,
          ...(!dump.success ? { reason: 'Chromium memory dump failed' } : {}) });
      } catch (error) { checkpoints.push({ label, success: false, reason: error.message, collectionDurationMs: performance.now() - start }); }
    },
    async stop() {
      if (ended) return { status: 'unavailable', reason: 'Trace already stopped' };
      ended = true;
      let handle;
      let output;
      let timeout;
      let onComplete;
      const partialPath = `${filePath}.partial`;
      try {
        // Install the listener before ending: tracingComplete can arrive immediately.
        const complete = new Promise((resolve, reject) => {
          onComplete = resolve;
          session.once('Tracing.tracingComplete', onComplete);
          timeout = setTimeout(() => reject(new Error('Timed out waiting for Chromium trace')), timeoutMs);
        });
        // Attach a rejection handler while Tracing.end itself is in flight.
        complete.catch(() => {});
        await send('Tracing.end');
        const event = await complete;
        handle = event.stream;
        if (!handle) throw new Error('Chromium returned no trace stream');
        output = await open(partialPath, 'w');
        let bytes = 0;
        while (true) {
          const chunk = await send('IO.read', { handle, size: 1024 * 1024 });
          const data = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
          bytes += data.length;
          if (bytes > maxBytes) throw new Error(`Trace exceeded ${maxBytes} byte limit`);
          await output.writeFile(data);
          if (chunk.eof) break;
        }
        await output.close();
        output = null;
        const trace = JSON.parse(await readFile(partialPath, 'utf8'));
        if (!Array.isArray(trace.traceEvents)) throw new Error('Unsupported Chromium trace format');
        await rename(partialPath, filePath);
        return { status: bufferFull || event.dataLossOccurred ? 'incomplete' : 'ok', path: filePath, bytes,
          dataLossOccurred: Boolean(event.dataLossOccurred || bufferFull), gpuMemory: extractGpuMemory(trace.traceEvents, checkpoints) };
      } catch (error) { return { status: 'error', reason: error.message, partialPath, checkpoints }; }
      finally {
        clearTimeout(timeout);
        if (onComplete) session.off('Tracing.tracingComplete', onComplete);
        session.off('Tracing.bufferUsage', onBuffer);
        await output?.close().catch(() => {});
        if (handle) await send('IO.close', { handle }).catch(() => {});
      }
    },
  };
}
