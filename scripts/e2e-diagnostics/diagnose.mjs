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
  const gesture = await page.evaluate(() => {
    const m = performance.getEntriesByName('lv-scroll-gesture');
    return m[0]?.duration ?? null;
  });
  return { stats, diag, navigation: nav, scrollGestureDuration: gesture };
}

async function pickChat(page) {
  if (FORCED_CHAT_ID) {
    return { chatId: FORCED_CHAT_ID, title: 'forced', total: null };
  }
  const recent = await page.evaluate(async () => {
    const res = await fetch('/api/v1/chats/recent-grouped?limit=100');
    if (!res.ok) throw new Error('recent-grouped failed: ' + res.status);
    return res.json();
  });
  const items = recent?.data || [];
  if (!items.length) throw new Error('No recent chats found');

  const counts = await page.evaluate(async (itemList) => {
    const out = [];
    for (const item of itemList) {
      try {
        const res = await fetch(`/api/v1/chats/${encodeURIComponent(item.latest_chat_id)}/messages?limit=1`);
        if (!res.ok) continue;
        const data = await res.json();
        out.push({
          chatId: item.latest_chat_id,
          title: item.character_name || item.latest_chat_name,
          total: data.total || 0,
        });
      } catch (e) {}
    }
    return out;
  }, items);
  counts.sort((a, b) => b.total - a.total);
  const top = counts[0];
  if (!top || !top.total) throw new Error('No chats with messages found');
  return top;
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

  const top = await pickChat(page);
  log('Selected chat:', top.title, top.chatId, top.total ? `messages: ${top.total}` : '');

  await page.goto(`${BASE_URL}/chat/${top.chatId}`, { waitUntil: 'networkidle' });

  const messageList = page.locator('[data-component="MessageList"]');
  await messageList.waitFor({ timeout: 15000 });
  await messageList.locator('[data-item-type="message"]').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(2000);
  log('Chat loaded');

  await capture(page, 'chat-loaded');

  const beforeStats = await getMessageListStats(page);
  log('Initial stats:', JSON.stringify(beforeStats));

  const metricsBefore = await getCDPPerformanceMetrics(page);

  await injectMonitor(page);
  await page.evaluate(() => window.__lvDiag.start());
  log('Scroll monitor started');

  await page.evaluate(() => {
    const list = document.querySelector('[data-component="MessageList"]');
    performance.mark('lv-scroll-start');
    list?.scrollTo({ top: 0, behavior: 'smooth' });
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const list = document.querySelector('[data-component="MessageList"]');
    list?.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    performance.mark('lv-scroll-end');
    performance.measure('lv-scroll-gesture', 'lv-scroll-start', 'lv-scroll-end');
  });

  await page.evaluate(() => window.__lvDiag.stop());
  log('Scroll monitor stopped');

  const metricsAfter = await getCDPPerformanceMetrics(page);

  const report = await getReport(page);
  report.chatTitle = top.title;
  report.chatId = top.chatId;
  report.totalMessages = top.total;
  report.metricsBefore = metricsBefore;
  report.metricsAfter = metricsAfter;
  report.metricDelta = {};
  for (const key of Object.keys(metricsAfter)) {
    const before = metricsBefore[key] ?? 0;
    report.metricDelta[key] = Number((metricsAfter[key] - before).toFixed(3));
  }

  const reportPath = path.join(OUT_DIR, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log('Report saved:', reportPath);

  await capture(page, 'chat-after-scroll');
  await browser.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
