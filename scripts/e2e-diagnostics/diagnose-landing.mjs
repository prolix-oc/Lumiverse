import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE_URL = process.env.LUMIVERSE_URL;
const USERNAME = process.env.LUMIVERSE_USER;
const PASSWORD = process.env.LUMIVERSE_PASS;
const OUT_DIR = process.env.OUT_DIR || './out';

if (!BASE_URL || !USERNAME || !PASSWORD) {
  console.error('Set LUMIVERSE_URL, LUMIVERSE_USER, and LUMIVERSE_PASS env vars.');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function capture(page, name) {
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), full_page: false });
}

async function getLandingStats(page) {
  return page.evaluate(() => {
    const container = document.querySelector('[data-component="LandingPage"]');
    if (!container) return null;
    const rows = Array.from(container.querySelectorAll('[data-index]'));
    const firstRow = rows[0];
    const lastRow = rows[rows.length - 1];
    const cards = rows.flatMap((row) => Array.from(row.querySelectorAll('button')));
    return {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      visibleRows: rows.length,
      firstRowIndex: firstRow ? Number(firstRow.getAttribute('data-index')) : null,
      lastRowIndex: lastRow ? Number(lastRow.getAttribute('data-index')) : null,
      visibleCards: cards.length,
    };
  });
}

async function getCDPPerformanceMetrics(page) {
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  const { metrics } = await session.send('Performance.getMetrics');
  await session.detach();
  const map = {};
  for (const m of metrics) map[m.name] = m.value;
  return map;
}

async function injectMonitor(page) {
  await page.evaluate(() => {
    window.__lvLandingDiag = {
      running: false,
      longTasks: [],
      layoutShifts: [],
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
        this.scrollEvents = 0;
        this.rafCount = 0;

        const container = document.querySelector('[data-component="LandingPage"]');
        if (container) {
          container.addEventListener('scroll', this._scrollHandler, { passive: true });
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
        const container = document.querySelector('[data-component="LandingPage"]');
        if (container) container.removeEventListener('scroll', this._scrollHandler);
        window.requestAnimationFrame = this.rafOriginal;
        for (const ob of this.observers) ob.disconnect();
        this.observers = [];
      },
      _scrollHandler: () => { window.__lvLandingDiag.scrollEvents++; },
    };
  });
}

async function getReport(page) {
  const [stats, diag] = await Promise.all([
    getLandingStats(page),
    page.evaluate(() => window.__lvLandingDiag),
  ]);
  return { stats, diag };
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

  const container = page.locator('[data-component="LandingPage"]');
  await container.waitFor({ timeout: 15000 });
  await container.locator('[data-index]').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);

  // Total recent chats for context
  const recent = await page.evaluate(async () => {
    const res = await fetch('/api/v1/chats/recent-grouped?limit=1');
    if (!res.ok) throw new Error('recent-grouped failed: ' + res.status);
    return res.json();
  });
  const totalChats = recent?.total ?? null;
  log('Total recent chats:', totalChats);

  await capture(page, 'landing-loaded');
  const beforeStats = await getLandingStats(page);
  log('Initial stats:', JSON.stringify(beforeStats));

  const metricsBefore = await getCDPPerformanceMetrics(page);

  await injectMonitor(page);
  await page.evaluate(() => window.__lvLandingDiag.start());
  log('Scroll monitor started');

  // Scroll to bottom repeatedly to exercise infinite scroll
  performance.mark('lv-landing-scroll-start');
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => {
      const c = document.querySelector('[data-component="LandingPage"]');
      c?.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
    });
    await page.waitForTimeout(1200);
  }
  performance.mark('lv-landing-scroll-end');
  performance.measure('lv-landing-scroll-gesture', 'lv-landing-scroll-start', 'lv-landing-scroll-end');

  await page.evaluate(() => window.__lvLandingDiag.stop());
  log('Scroll monitor stopped');

  const metricsAfter = await getCDPPerformanceMetrics(page);
  const report = await getReport(page);
  report.totalChats = totalChats;
  report.metricsBefore = metricsBefore;
  report.metricsAfter = metricsAfter;
  report.metricDelta = {};
  for (const key of Object.keys(metricsAfter)) {
    const before = metricsBefore[key] ?? 0;
    report.metricDelta[key] = Number((metricsAfter[key] - before).toFixed(3));
  }

  const reportPath = path.join(OUT_DIR, 'report-landing.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log('Report saved:', reportPath);

  await capture(page, 'landing-after-scroll');
  await browser.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
