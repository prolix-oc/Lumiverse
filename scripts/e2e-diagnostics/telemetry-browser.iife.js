/* Paste into DevTools, then __LUMIVERSE_PERF__.start(); interact; await
 * __LUMIVERSE_PERF__.stop(); __LUMIVERSE_PERF__.download(). No app API needed. */
(() => {
  'use strict';
  window.__LUMIVERSE_PERF__?.dispose?.();
  let state = null;
  let observers = [];
  let frame = null;
  let timer = null;
  let deadline = null;
  let lastFrame = null;
  let hiddenSince = null;

  function boundedInteger(value, fallback, min, max) {
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  }

  function push(key, value) {
    if (state[key].length < state.maxEntries) state[key].push(value);
    else state.dropped[key] = (state.dropped[key] || 0) + 1;
  }

  function memorySample() {
    // This is a coarse, implementation-specific estimate, not total page RAM.
    if (!performance.memory) return;
    const used = performance.memory.usedJSHeapSize;
    state.memory.sampleCount++;
    state.memory.beforeBytes ??= used;
    state.memory.afterBytes = used;
    state.memory.sampledPeakBytes = Math.max(state.memory.sampledPeakBytes ?? 0, used);
  }

  function layout() { state.layoutEvents++; }
  function scroll(event) {
    if (event.target instanceof Element && event.target.matches('[data-component="MessageList"]')) state.scrollEvents++;
  }
  function visibility() {
    const now = performance.now();
    if (hiddenSince !== null) state.hiddenDurationMs += now - hiddenSince;
    hiddenSince = document.hidden ? now : null;
    lastFrame = null;
  }
  function tick(timestamp) {
    if (!state?.running) return;
    state.rafCount++;
    if (!document.hidden && lastFrame !== null) {
      const interval = timestamp - lastFrame;
      state.frameIntervalCount++;
      state.frameIntervalTotalMs += interval;
      state.frameIntervalMaxMs = Math.max(state.frameIntervalMaxMs, interval);
      push('frameIntervals', interval);
    }
    lastFrame = document.hidden ? null : timestamp;
    frame = requestAnimationFrame(tick);
  }

  function consume(type, entries) {
    for (const entry of entries) {
      if (entry.startTime < state.startTime || (state.endTime !== null && entry.startTime > state.endTime)) continue;
      if (type === 'longtask') {
        state.totals.longTasks++;
        state.totals.longTaskDurationMs += entry.duration;
        push('longTasks', { startTime: entry.startTime, duration: entry.duration, name: entry.name,
          attribution: entry.attribution?.map(a => ({ name: a.name, containerType: a.containerType })) });
      } else if (type === 'layout-shift') {
        state.totals.layoutShifts++;
        push('layoutShifts', { startTime: entry.startTime, value: entry.value, hadRecentInput: entry.hadRecentInput,
          sources: entry.sources?.map(s => ({ node: s.node?.nodeName, cls: String(s.node?.className || '').slice(0, 80) })) });
      } else {
        state.totals.longAnimationFrames++;
        state.totals.longAnimationFrameDurationMs += entry.duration;
        push('longAnimationFrames', { startTime: entry.startTime, duration: entry.duration, blockingDuration: entry.blockingDuration,
          scripts: Array.from(entry.scripts || []).slice(0, 20).map(s => ({ sourceURL: s.sourceURL,
            sourceFunctionName: s.sourceFunctionName, duration: s.duration, forcedStyleAndLayoutDuration: s.forcedStyleAndLayoutDuration })) });
      }
    }
  }

  function getReport() {
    if (!state) return null;
    const sorted = [...state.frameIntervals].sort((a, b) => a - b);
    const percentile = p => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
    const now = state.endTime ?? performance.now();
    // Return only values, never observers, callbacks, DOM nodes or the controller.
    return JSON.parse(JSON.stringify({ schemaVersion: 1, label: state.label, running: state.running,
      startTime: state.startTime, endTime: state.endTime, durationMs: now - state.startTime,
      timeOrigin: performance.timeOrigin, stopReason: state.stopReason,
      visibility: { start: state.initialVisibility, end: document.visibilityState,
        hiddenDurationMs: state.hiddenDurationMs + (hiddenSince === null ? 0 : now - hiddenSince) },
      capabilities: state.capabilities, totals: state.totals, dropped: state.dropped,
      longTasks: state.longTasks, layoutShifts: state.layoutShifts, longAnimationFrames: state.longAnimationFrames,
      layoutEvents: state.layoutEvents, scrollEvents: state.scrollEvents, rafCount: state.rafCount,
      frameCadence: { source: 'collector-owned requestAnimationFrame callbacks', unit: 'ms',
        interpretation: 'Callback scheduling intervals, not presented FPS or GPU utilization',
        count: state.frameIntervalCount, retainedCount: sorted.length, p50: percentile(0.5), p95: percentile(0.95),
        mean: state.frameIntervalCount ? state.frameIntervalTotalMs / state.frameIntervalCount : null,
        max: state.frameIntervalCount ? state.frameIntervalMaxMs : null },
      memory: state.memory, marks: state.marks }));
  }

  function stop(reason = 'manual') {
    if (!state?.running) return getReport();
    state.endTime = performance.now();
    state.stopReason = reason;
    for (const { observer, type } of observers) {
      consume(type, observer.takeRecords());
      observer.disconnect();
    }
    observers = [];
    state.running = false;
    cancelAnimationFrame(frame);
    clearInterval(timer);
    clearTimeout(deadline);
    document.removeEventListener('lumiverse:message-content-layout', layout, true);
    document.removeEventListener('scroll', scroll, true);
    document.removeEventListener('visibilitychange', visibility);
    if (hiddenSince !== null) state.hiddenDurationMs += state.endTime - hiddenSince;
    hiddenSince = null;
    memorySample();
    return getReport();
  }

  const controller = {
    start(options = {}) {
      if (state?.running) throw new Error('Telemetry is already running');
      const supported = typeof PerformanceObserver === 'function' ? PerformanceObserver.supportedEntryTypes || [] : [];
      state = { running: true, label: String(options.label || 'browser interaction').slice(0, 200),
        maxEntries: boundedInteger(options.maxEntries, 2000, 1, 10000),
        startTime: performance.now(), endTime: null, stopReason: null, initialVisibility: document.visibilityState,
        hiddenDurationMs: 0, longTasks: [], layoutShifts: [], longAnimationFrames: [], frameIntervals: [], marks: [],
        dropped: {}, capabilities: {}, layoutEvents: 0, scrollEvents: 0, rafCount: 0,
        frameIntervalCount: 0, frameIntervalTotalMs: 0, frameIntervalMaxMs: 0,
        totals: { longTasks: 0, longTaskDurationMs: 0, layoutShifts: 0, longAnimationFrames: 0, longAnimationFrameDurationMs: 0 },
        memory: { status: performance.memory ? 'ok' : 'unsupported', source: 'performance.memory', scope: 'implementation-specific heap estimate',
          unit: 'bytes', approximate: true, sampleCount: 0, beforeBytes: null, afterBytes: null, sampledPeakBytes: null } };
      for (const type of ['longtask', 'layout-shift', 'long-animation-frame']) {
        state.capabilities[type] = { status: supported.includes(type) ? 'ok' : 'unsupported' };
        if (!supported.includes(type)) continue;
        try {
          const observer = new PerformanceObserver(list => consume(type, list.getEntries()));
          observer.observe({ type });
          observers.push({ observer, type });
        } catch (error) { state.capabilities[type] = { status: 'error', reason: error.message }; }
      }
      lastFrame = null;
      hiddenSince = document.hidden ? state.startTime : null;
      document.addEventListener('lumiverse:message-content-layout', layout, true);
      document.addEventListener('scroll', scroll, { capture: true, passive: true });
      document.addEventListener('visibilitychange', visibility);
      memorySample();
      timer = setInterval(memorySample, boundedInteger(options.intervalMs, 500, 100, 10000));
      deadline = setTimeout(() => stop('duration-limit'), boundedInteger(options.maxDurationMs, 60000, 100, 300000));
      frame = requestAnimationFrame(tick);
      return getReport();
    },
    mark(label) {
      if (!state?.running) throw new Error('Telemetry is not running');
      push('marks', { label: String(label).slice(0, 200), atMs: performance.now() - state.startTime });
    },
    stop, getReport,
    download() {
      const report = getReport();
      if (!report) throw new Error('Start telemetry before exporting');
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'lumiverse-telemetry.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    dispose() {
      stop('disposed');
      if (window.__LUMIVERSE_PERF__ === controller) delete window.__LUMIVERSE_PERF__;
    },
  };
  window.__LUMIVERSE_PERF__ = controller;
})();
