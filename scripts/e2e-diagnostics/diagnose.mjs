import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { launchTestBrowser } from './browser-runtime.mjs';
import { createTelemetryCollector } from './telemetry.mjs';
import fs from 'fs';
import path from 'path';

function integerOption(env, name, fallback, min, max) {
  const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

export function diagnosticConfig(env = process.env) {
  if (!env.LUMIVERSE_URL || !env.LUMIVERSE_USER || !env.LUMIVERSE_PASS) {
    throw new Error('Set LUMIVERSE_URL, LUMIVERSE_USER, and LUMIVERSE_PASS env vars.');
  }
  const url = new URL(env.LUMIVERSE_URL);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('LUMIVERSE_URL must use http or https');
  const channel = env.DIAG_BROWSER_CHANNEL || 'chromium';
  if (!['chromium', 'headless-shell'].includes(channel)) throw new Error('DIAG_BROWSER_CHANNEL must be chromium or headless-shell');
  return { baseUrl: env.LUMIVERSE_URL.replace(/\/+$/, ''), username: env.LUMIVERSE_USER, password: env.LUMIVERSE_PASS,
    chatId: env.LUMIVERSE_CHAT_ID || '', outDir: path.resolve(env.OUT_DIR || './out'),
    channel, headless: env.DIAG_HEADED !== '1', trace: env.DIAG_GPU_TRACE === '1',
    intervalMs: integerOption(env, 'DIAG_SAMPLE_MS', 500, 100, 10000),
    settleMs: integerOption(env, 'DIAG_SETTLE_MS', 2000, 0, 60000),
    scrollWaitMs: integerOption(env, 'DIAG_SCROLL_WAIT_MS', 1500, 100, 30000) };
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function capture(page, outDir, name) {
  await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
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

async function getReport(page, diag) {
  const [stats, navigation, gesture] = await Promise.all([
    getMessageListStats(page),
    page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0];
      return n ? { domComplete: n.domComplete, loadEventEnd: n.loadEventEnd, domInteractive: n.domInteractive } : null;
    }),
    page.evaluate(() => performance.getEntriesByName('lv-scroll-gesture').at(-1)?.duration ?? null),
  ]);
  return { stats, diag, navigation, scrollGestureDuration: gesture };
}

async function pickChat(page, forcedChatId) {
  if (forcedChatId) {
    return { chatId: forcedChatId, title: 'forced', total: null };
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

export async function runDiagnose(config = diagnosticConfig()) {
  fs.mkdirSync(config.outDir, { recursive: true });
  const runtime = await launchTestBrowser('chromium', { headless: config.headless,
    ...(config.channel === 'chromium' ? { channel: 'chromium' } : {}) });
  let telemetry;
  try {
    const context = await runtime.browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);
    page.on('console', msg => log('console', msg.type(), msg.text().slice(0, 200)));
    page.on('pageerror', err => log('pageerror', err.message));

    log('Login');
    // DOM readiness and explicit app selectors work with long-lived connections.
    await page.goto(`${config.baseUrl}/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('#username', config.username);
    await page.fill('#password', config.password);
    await Promise.all([
      page.waitForURL(url => !url.pathname.replace(/\/+$/, '').endsWith('/login'), { waitUntil: 'domcontentloaded' }),
      page.click('button[type="submit"]'),
    ]);
    log('Landing loaded');
    const top = await pickChat(page, config.chatId);
    log('Selected chat:', top.title, top.chatId, top.total ? `messages: ${top.total}` : '');
    await page.goto(`${config.baseUrl}/chat/${encodeURIComponent(top.chatId)}`, { waitUntil: 'domcontentloaded' });
    const messageList = page.locator('[data-component="MessageList"]');
    await messageList.waitFor();
    await messageList.locator('[data-item-type="message"]').first().waitFor();
    if (config.settleMs) await page.waitForTimeout(config.settleMs);
    await capture(page, config.outDir, 'chat-loaded');
    const beforeStats = await getMessageListStats(page);
    log('Initial stats:', JSON.stringify(beforeStats));

    telemetry = await createTelemetryCollector(page, { intervalMs: config.intervalMs,
      maxDurationMs: 120000, tracePath: config.trace ? path.join(config.outDir, 'performance-trace.json') : null });
    await telemetry.start('chat scroll top and bottom');
    log('Scroll monitor started');
    await page.evaluate(() => {
      performance.clearMarks('lv-scroll-start');
      performance.clearMarks('lv-scroll-end');
      performance.clearMeasures('lv-scroll-gesture');
      performance.mark('lv-scroll-start');
      const list = document.querySelector('[data-component="MessageList"]');
      if (!list) throw new Error('Message list disappeared before scrolling');
      list.scrollTo({ top: 0, behavior: 'smooth' });
    });
    await page.waitForTimeout(config.scrollWaitMs);
    await page.evaluate(() => {
      const list = document.querySelector('[data-component="MessageList"]');
      if (!list) throw new Error('Message list disappeared while scrolling');
      list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    });
    await page.waitForTimeout(config.scrollWaitMs);
    await page.evaluate(() => {
      performance.mark('lv-scroll-end');
      performance.measure('lv-scroll-gesture', 'lv-scroll-start', 'lv-scroll-end');
    });
    const performanceReport = await telemetry.stop();
    performanceReport.environment.launch = { channel: config.channel, headless: config.headless };
    log('Scroll monitor stopped');
    const report = await getReport(page, performanceReport.browser);
    Object.assign(report, { schemaVersion: 2, chatTitle: top.title, chatId: top.chatId, totalMessages: top.total,
      beforeStats, metricsBefore: performanceReport.metricsBefore, metricsAfter: performanceReport.metricsAfter,
      metricDelta: performanceReport.metricDelta, telemetry: performanceReport });
    fs.writeFileSync(path.join(config.outDir, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(config.outDir, 'telemetry.json'), JSON.stringify(performanceReport, null, 2));
    log('Report saved:', path.join(config.outDir, 'report.json'));
    await capture(page, config.outDir, 'chat-after-scroll');
    return report;
  } finally {
    try { await telemetry?.close(); }
    finally { await runtime.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runDiagnose().catch(err => { console.error(err); process.exitCode = 1; });
}
