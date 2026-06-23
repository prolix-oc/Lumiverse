import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE_URL = process.env.LUMIVERSE_URL;
const USERNAME = process.env.LUMIVERSE_USER;
const PASSWORD = process.env.LUMIVERSE_PASS;
const FORCED_CHAT_ID = process.env.LUMIVERSE_CHAT_ID || '';
const OUT_DIR = process.env.OUT_DIR || './out';

if (!BASE_URL || !USERNAME || !PASSWORD) {
  console.error('Set LUMIVERSE_URL, LUMIVERSE_USER, and LUMIVERSE_PASS env vars.');
  process.exit(1);
}
if (!FORCED_CHAT_ID) {
  console.error('Set LUMIVERSE_CHAT_ID env var to the chat to profile.');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function capture(page, name) {
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), full_page: false });
}

async function getMessageListStats(page) {
  return page.evaluate(() => {
    const list = document.querySelector('[data-component="MessageList"]');
    if (!list) return null;
    const rows = list.querySelectorAll('[data-item-type="message"]');
    const firstRow = rows[0];
    const lastRow = rows[rows.length - 1];
    return {
      scrollTop: list.scrollTop,
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
      rowCount: rows.length,
      firstRowIndex: firstRow ? Number(firstRow.getAttribute('data-virtual-index')) : null,
      lastRowIndex: lastRow ? Number(lastRow.getAttribute('data-virtual-index')) : null,
      firstMessageId: firstRow ? firstRow.getAttribute('data-message-id') : null,
      lastMessageId: lastRow ? lastRow.getAttribute('data-message-id') : null,
    };
  });
}

async function injectMonitor(page) {
  await page.evaluate(() => {
    const EVENT = 'lumiverse:message-content-layout';
    window.__lvDiag = {
      running: false,
      longTasks: [],
      layoutShifts: [],
      layoutEvents: 0,
      scrollEvents: 0,
      rafCount: 0,
      rafOriginal: window.requestAnimationFrame,
      observers: [],
      startTime: 0,
      endTime: 0,
      start() {
        this.running = true;
        this.startTime = performance.now();
        this.longTasks = [];
        this.layoutShifts = [];
        this.layoutEvents = 0;
        this.scrollEvents = 0;
        this.rafCount = 0;

        document.addEventListener(EVENT, this._layoutHandler, true);
        const list = document.querySelector('[data-component="MessageList"]');
        if (list) {
          list.addEventListener('scroll', this._scrollHandler, { passive: true });
        }

        window.requestAnimationFrame = (cb) => {
          if (this.running) this.rafCount++;
          return this.rafOriginal.call(window, cb);
        };

        try {
          const longObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              this.longTasks.push({
                startTime: entry.startTime,
                duration: entry.duration,
                name: entry.name,
                attribution: entry.attribution?.map((a) => a.name),
              });
            }
          });
          longObserver.observe({ entryTypes: ['longtask'] });
          this.observers.push(longObserver);
        } catch (e) {}

        try {
          const lsObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              this.layoutShifts.push({
                startTime: entry.startTime,
                value: entry.value,
                sources: entry.sources?.map((s) => ({
                  node: s.node?.nodeName,
                  cls: s.node?.className?.slice?.(0, 80),
                })),
              });
            }
          });
          lsObserver.observe({ entryTypes: ['layout-shift'] });
          this.observers.push(lsObserver);
        } catch (e) {}
      },
      stop() {
        this.running = false;
        this.endTime = performance.now();
        document.removeEventListener(EVENT, this._layoutHandler, true);
        const list = document.querySelector('[data-component="MessageList"]');
        if (list) list.removeEventListener('scroll', this._scrollHandler);
        window.requestAnimationFrame = this.rafOriginal;
        for (const ob of this.observers) ob.disconnect();
        this.observers = [];
      },
      _layoutHandler: () => { window.__lvDiag.layoutEvents++; },
      _scrollHandler: () => { window.__lvDiag.scrollEvents++; },
    };
  });
}

async function getReport(page) {
  const [stats, diag, nav] = await Promise.all([
    getMessageListStats(page),
    page.evaluate(() => window.__lvDiag),
    page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0];
      return n
        ? {
            domComplete: n.domComplete,
            loadEventEnd: n.loadEventEnd,
            domInteractive: n.domInteractive,
          }
        : null;
    }),
  ]);
  return { stats, diag, navigation: nav };
}

function summarizeTrace(events) {
  const inWindow = events;

  const byCategory = {};
  const byName = {};
  const byThread = {};

  for (const e of inWindow) {
    const dur = typeof e.dur === 'number' ? e.dur : 0;
    const cats = (e.cat || '').split(',').map((c) => c.trim()).filter(Boolean);
    for (const cat of cats) {
      const c = byCategory[cat] || { count: 0, dur: 0 };
      c.count += 1;
      c.dur += dur;
      byCategory[cat] = c;
    }
    const key = e.name || '<unnamed>';
    const n = byName[key] || { count: 0, dur: 0 };
    n.count += 1;
    n.dur += dur;
    byName[key] = n;

    const tkey = `${e.pid}:${e.tid}`;
    const t = byThread[tkey] || { count: 0, dur: 0 };
    t.count += 1;
    t.dur += dur;
    byThread[tkey] = t;
  }

  const sortedCategories = Object.entries(byCategory)
    .sort((a, b) => b[1].dur - a[1].dur)
    .map(([cat, { count, dur }]) => ({ category: cat, count, durMs: Math.round(dur / 1000) }));

  const sortedNames = Object.entries(byName)
    .sort((a, b) => b[1].dur - a[1].dur)
    .slice(0, 30)
    .map(([name, { count, dur }]) => ({ name, count, durMs: Math.round(dur / 1000) }));

  const sortedThreads = Object.entries(byThread)
    .sort((a, b) => b[1].dur - a[1].dur)
    .map(([tid, { count, dur }]) => ({ tid, count, durMs: Math.round(dur / 1000) }));

  return { totalEvents: inWindow.length, categories: sortedCategories, names: sortedNames, threads: sortedThreads };
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  page.on('console', (msg) => log('console', msg.type(), msg.text().slice(0, 200)));
  page.on('pageerror', (err) => log('pageerror', err.message));

  log('Login');
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
  await page.fill('#username', USERNAME);
  await page.fill('#password', PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('button[type="submit"]'),
  ]);
  log('Landing loaded');

  const chatId = FORCED_CHAT_ID;
  log('Profiling chat:', chatId);

  await page.goto(`${BASE_URL}/chat/${chatId}`, { waitUntil: 'networkidle' });

  const messageList = page.locator('[data-component="MessageList"]');
  await messageList.waitFor({ timeout: 15000 });
  await messageList.locator('[data-item-type="message"]').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(2000);
  log('Chat loaded');

  await capture(page, 'chat-loaded');
  const beforeStats = await getMessageListStats(page);
  log('Initial stats:', JSON.stringify(beforeStats));

  await injectMonitor(page);
  await page.evaluate(() => window.__lvDiag.start());

  const session = await page.context().newCDPSession(page);
  const traceEvents = [];
  session.on('Tracing.dataCollected', ({ value }) => {
    traceEvents.push(...value);
  });

  log('Starting CDP trace');
  await session.send('Tracing.start', {
    categories: '-*,cc,gpu,renderer,blink,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,toplevel',
    transferMode: 'ReportEvents',
  });

  // Scroll to top and bottom to exercise the virtualizer in both directions.
  await page.evaluate(() => {
    const list = document.querySelector('[data-component="MessageList"]');
    list?.scrollTo({ top: 0, behavior: 'smooth' });
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const list = document.querySelector('[data-component="MessageList"]');
    list?.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  });
  await page.waitForTimeout(1500);

  const tracingCompletePromise = new Promise((resolve) => session.once('Tracing.tracingComplete', resolve));
  log('Stopping CDP trace');
  await session.send('Tracing.end');
  await tracingCompletePromise;
  await session.detach();

  await page.evaluate(() => window.__lvDiag.stop());
  log('Scroll monitor stopped');

  const report = await getReport(page);
  report.chatId = chatId;
  report.traceSummary = summarizeTrace(traceEvents);

  const tracePath = path.join(OUT_DIR, 'trace-chat.json');
  fs.writeFileSync(tracePath, JSON.stringify(traceEvents, null, 2));
  log('Raw trace saved:', tracePath, `(${traceEvents.length.toLocaleString()} events)`);

  const reportPath = path.join(OUT_DIR, 'report-profile-chat.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log('Profile report saved:', reportPath);

  console.log('\n--- Compositor / render summary ---');
  console.log(`Total trace events: ${report.traceSummary.totalEvents.toLocaleString()}`);
  console.log('\nBy category (ms):');
  for (const c of report.traceSummary.categories.slice(0, 12)) {
    console.log(`  ${c.category}: ${c.durMs} ms  (${c.count.toLocaleString()} events)`);
  }
  console.log('\nTop event names (ms):');
  for (const n of report.traceSummary.names.slice(0, 15)) {
    console.log(`  ${n.name}: ${n.durMs} ms  (${n.count.toLocaleString()} events)`);
  }
  console.log('\nTop threads (ms):');
  for (const t of report.traceSummary.threads.slice(0, 8)) {
    console.log(`  ${t.tid}: ${t.durMs} ms  (${t.count.toLocaleString()} events)`);
  }

  await capture(page, 'chat-after-scroll');
  await browser.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
