import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE_URL = process.env.LUMIVERSE_URL;
const USERNAME = process.env.LUMIVERSE_USER;
const PASSWORD = process.env.LUMIVERSE_PASS;
const FORCED_CHAT_ID = process.env.LUMIVERSE_CHAT_ID || '';
const TARGET_PATH = process.env.SPINDLE_TARGET_PATH || '';
const OUT_DIR = process.env.OUT_DIR || './out/spindle';
const SETTLE_MS = Number(process.env.SPINDLE_SETTLE_MS || '5000');
const CHAT_LOAD_WAIT_MS = Number(process.env.SPINDLE_CHAT_LOAD_WAIT_MS || '5000');
const MAX_WS_FRAMES = Number(process.env.SPINDLE_MAX_WS_FRAMES || '800');
const CAPTURE_MANIFESTS = process.env.SPINDLE_CAPTURE_MANIFESTS !== '0';
const EXTENSION_FILTERS = parseList(process.env.SPINDLE_EXTENSION_FILTER || '');
const ROOT_PROBE_PLAN = parseRootProbePlan(process.env.SPINDLE_ROOT_PROBE_PLAN || '');
const PROBE_ALL_VISIBLE_ROOTS = process.env.SPINDLE_PROBE_ALL_VISIBLE_ROOTS === '1';
const PROBE_BUTTON_LIMIT_PER_EXTENSION = Number(process.env.SPINDLE_PROBE_BUTTON_LIMIT_PER_EXTENSION || '0');
const PROBE_WAIT_MS = Number(process.env.SPINDLE_PROBE_WAIT_MS || '1200');

const WS_RELEVANT_EVENTS = new Set([
  'SETTINGS_UPDATED',
  'CHAT_SWITCHED',
  'SPINDLE_BACKEND_MSG',
  'SPINDLE_FRONTEND_MSG',
  'SPINDLE_FRONTEND_PROCESS',
  'SPINDLE_CHAT_STYLE_MODE',
  'SPINDLE_PRE_GENERATION_ACTIVITY',
  'SPINDLE_RUNTIME_STATS',
]);

if (!BASE_URL || !USERNAME || !PASSWORD) {
  console.error('Set LUMIVERSE_URL, LUMIVERSE_USER, and LUMIVERSE_PASS env vars.');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function parseList(raw) {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function safeFilename(value) {
  return value.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'unnamed';
}

function parseRootProbePlan(raw) {
  return raw
    .split(';')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const [hintPart, buttonPart = '__ALL__'] = segment.split('=');
      const hint = hintPart?.trim() || '';
      const normalizedButtons = buttonPart.trim();
      return {
        hint,
        buttons:
          !normalizedButtons || normalizedButtons === '__ALL__'
            ? null
            : normalizedButtons
                .split('|')
                .map((value) => value.trim())
                .filter(Boolean),
      };
    })
    .filter((entry) => entry.hint);
}

function toIsoNow() {
  return new Date().toISOString();
}

function toMillis(value) {
  return value ? Date.parse(value) : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function countBy(items, getKey) {
  const out = {};
  for (const item of items) {
    const key = getKey(item);
    if (!key) continue;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function extensionMatches(ext, hint) {
  const q = hint.toLowerCase();
  return [
    ext?.name,
    ext?.identifier,
    ext?.id,
  ]
    .filter((value) => typeof value === 'string')
    .some((value) => value.toLowerCase().includes(q));
}

function buildTargetUrl(targetPath) {
  if (/^https?:\/\//i.test(targetPath)) return targetPath;
  const normalized = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
  return `${BASE_URL}${normalized}`;
}

function summarizeWirePayload(extensionId, payload) {
  return {
    extensionId,
    dataType: payload?.type ?? null,
    dataChatId: payload?.chatId ?? null,
    dataCharacterId: payload?.characterId ?? null,
    dataKeys:
      payload && typeof payload === 'object'
        ? Object.keys(payload).slice(0, 20)
        : [],
  };
}

function summarizeWsPayload(eventName, parsed) {
  const payload = parsed?.payload;

  if (eventName === 'SPINDLE_FRONTEND_MSG') {
    return summarizeWirePayload(payload?.extensionId ?? null, payload?.data);
  }

  if (eventName === 'SPINDLE_BACKEND_MSG') {
    return summarizeWirePayload(parsed?.extensionId ?? null, parsed?.payload);
  }

  if (eventName === 'SPINDLE_FRONTEND_PROCESS') {
    return {
      extensionId: payload?.extensionId ?? null,
      action: payload?.action ?? null,
      processId: payload?.processId ?? null,
      kind: payload?.kind ?? null,
      key: payload?.key ?? null,
    };
  }

  if (eventName === 'SPINDLE_PRE_GENERATION_ACTIVITY') {
    return {
      extensionId: payload?.extensionId ?? null,
      extensionName: payload?.extensionName ?? null,
      chatId: payload?.chatId ?? null,
      phase: payload?.phase ?? null,
      status: payload?.status ?? null,
    };
  }

  if (eventName === 'SPINDLE_RUNTIME_STATS') {
    return {
      extensionId: payload?.extensionId ?? null,
      identifier: payload?.identifier ?? null,
      runtimeMode: payload?.runtimeMode ?? null,
      phase: payload?.phase ?? null,
      pid: payload?.pid ?? null,
      rssKb: payload?.rssKb ?? null,
      startupMs: payload?.startupMs ?? null,
    };
  }

  if (eventName === 'SPINDLE_CHAT_STYLE_MODE') {
    return {
      extensionId: payload?.extensionId ?? null,
      extensionName: payload?.extensionName ?? null,
      chatId: payload?.chatId ?? null,
      mode: payload?.mode ?? null,
    };
  }

  if (eventName === 'SETTINGS_UPDATED') {
    return {
      key: payload?.key ?? null,
      keys: Array.isArray(payload?.keys) ? payload.keys.slice(0, 20) : null,
      value:
        typeof payload?.value === 'string' ||
        typeof payload?.value === 'number' ||
        typeof payload?.value === 'boolean' ||
        payload?.value == null
          ? payload.value
          : '[complex]',
    };
  }

  if (eventName === 'CHAT_SWITCHED') {
    return {
      chatId: payload?.chatId ?? null,
    };
  }

  return payload ?? null;
}

function recordWsFrame(diagnostics, direction, url, rawPayload) {
  if (typeof rawPayload !== 'string') return;

  let parsed = null;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return;
  }

  const eventName = parsed?.event || parsed?.type;
  if (!WS_RELEVANT_EVENTS.has(eventName)) return;

  const frame = {
    at: toIsoNow(),
    direction,
    url,
    event: eventName,
    payload: summarizeWsPayload(eventName, parsed),
  };

  diagnostics.wsFrames.push(frame);
  if (diagnostics.wsFrames.length > MAX_WS_FRAMES) {
    diagnostics.wsFrames.splice(0, diagnostics.wsFrames.length - MAX_WS_FRAMES);
  }

  diagnostics.wsEventCounts[eventName] = (diagnostics.wsEventCounts[eventName] || 0) + 1;

  if (eventName === 'SPINDLE_FRONTEND_MSG') {
    const extKey = frame.payload?.extensionId || 'unknown';
    const dataType = frame.payload?.dataType || '<none>';
    diagnostics.wsFrontendMessageCounts[extKey] = diagnostics.wsFrontendMessageCounts[extKey] || {};
    diagnostics.wsFrontendMessageCounts[extKey][dataType] =
      (diagnostics.wsFrontendMessageCounts[extKey][dataType] || 0) + 1;
  }

  if (eventName === 'SPINDLE_BACKEND_MSG') {
    const extKey = frame.payload?.extensionId || 'unknown';
    const dataType = frame.payload?.dataType || '<none>';
    diagnostics.wsBackendMessageCounts[extKey] = diagnostics.wsBackendMessageCounts[extKey] || {};
    diagnostics.wsBackendMessageCounts[extKey][dataType] =
      (diagnostics.wsBackendMessageCounts[extKey][dataType] || 0) + 1;
  }
}

async function capture(target, name) {
  await target.screenshot({ path: path.join(OUT_DIR, `${safeFilename(name)}.png`) });
}

async function login(page) {
  log('Login');
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
  await page.fill('#username', USERNAME);
  await page.fill('#password', PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('button[type="submit"]'),
  ]);
}

async function pickChat(page) {
  const recent = await page.evaluate(async () => {
    const res = await fetch('/api/v1/chats/recent-grouped?limit=100', { credentials: 'include' });
    if (!res.ok) throw new Error(`recent-grouped failed: ${res.status}`);
    return res.json();
  });
  const items = recent?.data || [];
  if (!items.length) throw new Error('No recent chats found');

  const counts = await page.evaluate(async (itemList) => {
    const out = [];
    for (const item of itemList) {
      try {
        const res = await fetch(`/api/v1/chats/${encodeURIComponent(item.latest_chat_id)}/messages?limit=1`, {
          credentials: 'include',
        });
        if (!res.ok) continue;
        const data = await res.json();
        out.push({
          chatId: item.latest_chat_id,
          title: item.character_name || item.latest_chat_name || item.latest_chat_id,
          total: data.total || 0,
        });
      } catch {
        // ignore individual failures
      }
    }
    return out;
  }, items);

  counts.sort((a, b) => b.total - a.total);
  const top = counts[0];
  if (!top?.chatId) throw new Error('No recent chats with messages found');
  return top;
}

async function resolveTarget(page) {
  if (TARGET_PATH) {
    return {
      kind: 'path',
      targetUrl: buildTargetUrl(TARGET_PATH),
      chatId: null,
      title: TARGET_PATH,
    };
  }

  if (FORCED_CHAT_ID) {
    return {
      kind: 'chat',
      targetUrl: buildTargetUrl(`/chat/${FORCED_CHAT_ID}`),
      chatId: FORCED_CHAT_ID,
      title: 'forced chat',
    };
  }

  const topChat = await pickChat(page);
  return {
    kind: 'chat',
    targetUrl: buildTargetUrl(`/chat/${topChat.chatId}`),
    chatId: topChat.chatId,
    title: topChat.title,
    totalMessages: topChat.total,
  };
}

async function openTarget(page, target) {
  await page.goto(target.targetUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(CHAT_LOAD_WAIT_MS);
}

async function fetchJson(page, url) {
  return page.evaluate(async (targetUrl) => {
    const res = await fetch(targetUrl, { credentials: 'include' });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return {
      ok: res.ok,
      status: res.status,
      url: res.url,
      body: json,
      raw: text.slice(0, 4000),
    };
  }, url);
}

async function snapshotMountedRoots(page) {
  return page.evaluate(() => {
    const roots = Array.from(document.querySelectorAll('[data-spindle-extension-root]'));
    return roots.map((root) => {
      const el = root;
      const rect = el.getBoundingClientRect();
      const buttons = Array.from(el.querySelectorAll('button, [role="button"]')).map((btn) => {
        const button = btn;
        const buttonRect = button.getBoundingClientRect();
        const text = (button.textContent || '').replace(/\s+/g, ' ').trim();
        return {
          text: text.slice(0, 120),
          ariaLabel: button.getAttribute('aria-label'),
          title: button.getAttribute('title'),
          tagName: button.tagName,
          visible: buttonRect.width > 0 && buttonRect.height > 0,
          top: Math.round(buttonRect.top),
          left: Math.round(buttonRect.left),
          width: Math.round(buttonRect.width),
          height: Math.round(buttonRect.height),
        };
      });
      const iframes = Array.from(el.querySelectorAll('iframe')).map((frame) => {
        const iframe = frame;
        return {
          src: iframe.getAttribute('src'),
          srcdocLength: iframe.getAttribute('srcdoc')?.length || 0,
          sandbox: iframe.getAttribute('sandbox'),
          ext: iframe.getAttribute('data-spindle-ext'),
          token: iframe.getAttribute('data-spindle-sandbox-frame'),
        };
      });
      return {
        extensionId: el.getAttribute('data-spindle-extension-root'),
        mountPoint: el.getAttribute('data-spindle-mount-point'),
        modalId: el.getAttribute('data-spindle-modal'),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500),
        buttonCount: buttons.length,
        buttons,
        iframeCount: iframes.length,
        iframes,
        visible: rect.width > 0 && rect.height > 0,
        rect: {
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
    });
  });
}

async function snapshotVisibleButtons(page, limit = 250) {
  return page.evaluate((maxCount) => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    return buttons
      .map((btn, index) => {
        const el = btn;
        const rect = el.getBoundingClientRect();
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        return {
          index,
          text: text.slice(0, 120),
          ariaLabel: el.getAttribute('aria-label'),
          title: el.getAttribute('title'),
          className: typeof el.className === 'string' ? el.className : null,
          tagName: el.tagName,
          visible: rect.width > 0 && rect.height > 0,
          rect: {
            top: Math.round(rect.top),
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          rootExtensionId: el.closest('[data-spindle-extension-root]')?.getAttribute('data-spindle-extension-root') ?? null,
          html: el.outerHTML.slice(0, 500),
        };
      })
      .filter((button) => button.visible)
      .slice(0, maxCount);
  }, limit);
}

async function snapshotPage(page) {
  return page.evaluate(() => {
    const title = document.title;
    const pathname = location.pathname;
    const href = location.href;
    const activeChatHeading =
      document.querySelector('[data-chat-title]')?.textContent?.trim() ||
      document.querySelector('h1')?.textContent?.trim() ||
      null;
    const drawers = Array.from(document.querySelectorAll('[data-spindle-drawer-tab]')).map((el) => ({
      tabId: el.getAttribute('data-spindle-drawer-tab'),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    }));
    return { title, pathname, href, activeChatHeading, drawers };
  });
}

function buildManifestMap(manifests) {
  return new Map(
    manifests.map((entry) => [entry.extensionId, entry.manifest?.body || null]),
  );
}

function findExtensionByHint(extensions, hint) {
  const exact = extensions.find((ext) => [ext.id, ext.identifier, ext.name].some((value) => value === hint));
  if (exact) return exact;
  return extensions.find((ext) => extensionMatches(ext, hint)) || null;
}

function extensionMentions(text, ext) {
  const haystack = text.toLowerCase();
  return [ext.id, ext.identifier, ext.name]
    .filter((value) => typeof value === 'string')
    .some((value) => haystack.includes(value.toLowerCase()));
}

function buildExtensionSummaries(diagnostics, relevantExtensions) {
  const manifestMap = buildManifestMap(diagnostics.manifests);
  const loadedFrontends = diagnostics.console
    .map((entry) => {
      const match = entry.text.match(/^\[Spindle\] Loaded frontend: (.+)$/);
      return match ? { at: entry.at, identifier: match[1] } : null;
    })
    .filter(Boolean);

  const summaries = relevantExtensions.map((ext) => {
    const manifest = manifestMap.get(ext.id);
    const roots = diagnostics.mountedRoots.filter((root) => root.extensionId === ext.id);
    const visibleRoots = roots.filter((root) => root.visible);
    const frontendFrames = diagnostics.wsFrames.filter(
      (frame) => frame.event === 'SPINDLE_FRONTEND_MSG' && frame.payload?.extensionId === ext.id,
    );
    const backendFrames = diagnostics.wsFrames.filter(
      (frame) => frame.event === 'SPINDLE_BACKEND_MSG' && frame.payload?.extensionId === ext.id,
    );
    const processFrames = diagnostics.wsFrames.filter(
      (frame) => frame.event === 'SPINDLE_FRONTEND_PROCESS' && frame.payload?.extensionId === ext.id,
    );
    const preGenerationFrames = diagnostics.wsFrames.filter(
      (frame) => frame.event === 'SPINDLE_PRE_GENERATION_ACTIVITY' && frame.payload?.extensionId === ext.id,
    );
    const runtimeFrames = diagnostics.wsFrames.filter(
      (frame) => frame.event === 'SPINDLE_RUNTIME_STATS' && frame.payload?.extensionId === ext.id,
    );
    const chatStyleFrames = diagnostics.wsFrames.filter(
      (frame) => frame.event === 'SPINDLE_CHAT_STYLE_MODE' && frame.payload?.extensionId === ext.id,
    );
    const loadedAt = loadedFrontends.find((entry) => entry.identifier === ext.identifier)?.at || null;
    const loadedAtMs = toMillis(loadedAt);
    const frontendMessagesBeforeLoad = loadedAtMs == null
      ? []
      : frontendFrames
          .filter((frame) => (toMillis(frame.at) ?? 0) < loadedAtMs)
          .map((frame) => frame.payload?.dataType || '<none>');

    const consoleMentions = diagnostics.console.filter((entry) => extensionMentions(entry.text, ext));

    return {
      id: ext.id,
      identifier: ext.identifier,
      name: ext.name,
      version: ext.version,
      branch: ext.metadata?.branch ?? null,
      enabled: ext.enabled,
      status: ext.status,
      hasFrontend: ext.has_frontend,
      hasBackend: ext.has_backend,
      frontendLoadedAt: loadedAt,
      firstFrontendMessageAt: frontendFrames[0]?.at ?? null,
      frontendMessagesBeforeLoad,
      preLoadFrontendMessageCount: frontendMessagesBeforeLoad.length,
      manifest: manifest
        ? {
            version: manifest.version ?? null,
            minimumLumiverseVersion: manifest.minimum_lumiverse_version ?? null,
            frontendCacheKey: manifest.frontend_cache_key ?? null,
            permissionsCount: Array.isArray(manifest.permissions) ? manifest.permissions.length : 0,
            requestedCapabilitiesCount: Array.isArray(manifest.requested_capabilities) ? manifest.requested_capabilities.length : 0,
          }
        : null,
      grantedPermissionsCount: Array.isArray(ext.granted_permissions) ? ext.granted_permissions.length : 0,
      rootStats: {
        totalRoots: roots.length,
        visibleRoots: visibleRoots.length,
        totalButtons: roots.reduce((sum, root) => sum + root.buttonCount, 0),
        visibleButtons: roots.reduce((sum, root) => sum + root.buttons.filter((button) => button.visible).length, 0),
        iframeCount: roots.reduce((sum, root) => sum + root.iframeCount, 0),
        mountPoints: unique(roots.map((root) => root.mountPoint)),
      },
      rootButtons: roots
        .flatMap((root) => root.buttons.filter((button) => button.visible))
        .slice(0, 30)
        .map((button) => button.title || button.ariaLabel || button.text || `${button.top}:${button.left}`),
      ws: {
        frontendMessageCounts: diagnostics.wsFrontendMessageCounts[ext.id] || {},
        backendMessageCounts: diagnostics.wsBackendMessageCounts[ext.id] || {},
        recentFrontendMessageTypes: frontendFrames.slice(-10).map((frame) => frame.payload?.dataType || '<none>'),
        recentBackendMessageTypes: backendFrames.slice(-10).map((frame) => frame.payload?.dataType || '<none>'),
        processEventCounts: countBy(processFrames, (frame) => frame.payload?.action || '<none>'),
      },
      preGeneration: {
        total: preGenerationFrames.length,
        byStatus: countBy(preGenerationFrames, (frame) => frame.payload?.status || '<none>'),
        byPhase: countBy(preGenerationFrames, (frame) => frame.payload?.phase || '<none>'),
      },
      runtimeStats: runtimeFrames.slice(-5).map((frame) => frame.payload),
      chatStyleModes: unique(chatStyleFrames.map((frame) => frame.payload?.mode)),
      consoleMentions: consoleMentions.slice(-12).map((entry) => ({
        at: entry.at,
        type: entry.type,
        text: entry.text.slice(0, 240),
      })),
    };
  });

  summaries.sort((a, b) =>
    b.rootStats.visibleRoots - a.rootStats.visibleRoots ||
    b.preGeneration.total - a.preGeneration.total ||
    b.preLoadFrontendMessageCount - a.preLoadFrontendMessageCount ||
    a.identifier.localeCompare(b.identifier),
  );

  return summaries;
}

function buildRelevantExtensions(extensions) {
  const enabledExtensions = extensions.filter((ext) => ext?.enabled);
  if (!EXTENSION_FILTERS.length) return enabledExtensions;

  return enabledExtensions.filter((ext) =>
    EXTENSION_FILTERS.some((filterValue) => extensionMatches(ext, filterValue)),
  );
}

async function probeExtensionRootButtons(page, diagnostics, target, extension, buttonTargets) {
  const currentRoots = await snapshotMountedRoots(page);
  const currentRoot = currentRoots.find((entry) => entry.extensionId === extension.id && entry.visible)
    || currentRoots.find((entry) => entry.extensionId === extension.id);

  const probeRecord = {
    extensionId: extension.id,
    identifier: extension.identifier,
    name: extension.name,
    beforeRoots: currentRoots,
    clicks: [],
  };

  if (!currentRoot) {
    probeRecord.error = 'mounted root not found';
    return probeRecord;
  }

  const orderedButtons = currentRoot.buttons
    .filter((button) => button.visible)
    .sort((a, b) => a.top - b.top || a.left - b.left);

  let targets = buttonTargets && buttonTargets.length
    ? buttonTargets
    : orderedButtons.map((button) => button.title || button.ariaLabel || button.text || `${button.top}:${button.left}`);

  if (PROBE_BUTTON_LIMIT_PER_EXTENSION > 0) {
    targets = targets.slice(0, PROBE_BUTTON_LIMIT_PER_EXTENSION);
  }

  let first = true;
  for (const targetLabel of targets) {
    if (!first) {
      await openTarget(page, target);
      if (SETTLE_MS > 0) await page.waitForTimeout(SETTLE_MS);
    }
    first = false;

    const rootsBeforeClick = await snapshotMountedRoots(page);
    const root = rootsBeforeClick.find((entry) => entry.extensionId === extension.id && entry.visible)
      || rootsBeforeClick.find((entry) => entry.extensionId === extension.id);

    if (!root) {
      probeRecord.clicks.push({
        target: targetLabel,
        error: 'mounted root not found after reset',
      });
      continue;
    }

    const button = root.buttons.find((entry) => {
      const label = entry.title || entry.ariaLabel || entry.text || `${entry.top}:${entry.left}`;
      return label === targetLabel;
    });

    if (!button) {
      probeRecord.clicks.push({
        target: targetLabel,
        error: 'target button not found',
        availableButtons: root.buttons,
      });
      continue;
    }

    const beforeConsoleCount = diagnostics.console.length;
    const beforeFailureCount = diagnostics.requestFailures.length;
    const beforeResponseCount = diagnostics.errorResponses.length;
    const beforeWsFrameCount = diagnostics.wsFrames.length;

    await page.mouse.click(
      button.left + Math.max(6, Math.floor(button.width / 2)),
      button.top + Math.max(6, Math.floor(button.height / 2)),
    );
    await page.waitForTimeout(PROBE_WAIT_MS);

    const afterSnapshot = await snapshotPage(page);
    const afterRoots = await snapshotMountedRoots(page);
    probeRecord.clicks.push({
      target: targetLabel,
      button,
      afterSnapshot,
      afterRoots,
      consoleDelta: diagnostics.console.slice(beforeConsoleCount),
      requestFailureDelta: diagnostics.requestFailures.slice(beforeFailureCount),
      errorResponseDelta: diagnostics.errorResponses.slice(beforeResponseCount),
      wsFrameDelta: diagnostics.wsFrames.slice(beforeWsFrameCount),
    });

    const locator = page.locator(`[data-spindle-extension-root="${extension.id}"]`).first();
    await capture(locator, `probe-${extension.identifier || extension.id}-${targetLabel}`);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }

  return probeRecord;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  const page = await context.newPage();

  const diagnostics = {
    startedAt: toIsoNow(),
    baseUrl: BASE_URL,
    target: null,
    console: [],
    pageErrors: [],
    requestFailures: [],
    errorResponses: [],
    wsFrames: [],
    wsEventCounts: {},
    wsFrontendMessageCounts: {},
    wsBackendMessageCounts: {},
    rootProbes: [],
  };

  page.on('websocket', (ws) => {
    const url = typeof ws.url === 'function' ? ws.url() : '';
    if (!url.includes('/api/ws')) return;

    ws.on('framereceived', (event) => {
      recordWsFrame(diagnostics, 'received', url, event.payload);
    });

    ws.on('framesent', (event) => {
      recordWsFrame(diagnostics, 'sent', url, event.payload);
    });
  });

  page.on('console', (msg) => {
    const entry = {
      at: toIsoNow(),
      type: msg.type(),
      text: msg.text(),
      location: msg.location(),
    };
    diagnostics.console.push(entry);
    log('console', entry.type, entry.text.slice(0, 240));
  });

  page.on('pageerror', (err) => {
    diagnostics.pageErrors.push({
      at: toIsoNow(),
      message: err.message,
      stack: err.stack || null,
    });
    log('pageerror', err.message);
  });

  page.on('requestfailed', (request) => {
    diagnostics.requestFailures.push({
      at: toIsoNow(),
      url: request.url(),
      method: request.method(),
      failure: request.failure(),
      resourceType: request.resourceType(),
    });
    log('requestfailed', request.method(), request.url(), JSON.stringify(request.failure() || {}));
  });

  page.on('response', async (response) => {
    if (response.status() < 400) return;
    const url = response.url();
    if (!url.includes('/api/') && !url.includes('/spindle')) return;
    diagnostics.errorResponses.push({
      at: toIsoNow(),
      url,
      status: response.status(),
      statusText: response.statusText(),
      requestMethod: response.request().method(),
    });
    log('response', response.status(), url);
  });

  try {
    await login(page);
    log('Landing loaded');

    const target = await resolveTarget(page);
    diagnostics.target = target;
    log('Target selected', JSON.stringify(target));

    await openTarget(page, target);
    log('Target loaded');

    if (SETTLE_MS > 0) {
      await page.waitForTimeout(SETTLE_MS);
      log('Extra settle complete', SETTLE_MS);
    }

    await capture(page, 'target-full-page');

    const spindleList = await fetchJson(page, '/api/v1/spindle');
    diagnostics.spindleList = spindleList;

    const extensions = Array.isArray(spindleList?.body?.extensions)
      ? spindleList.body.extensions
      : Array.isArray(spindleList?.body?.data)
        ? spindleList.body.data
        : Array.isArray(spindleList?.body)
          ? spindleList.body
          : [];
    diagnostics.extensions = extensions;

    const relevantExtensions = buildRelevantExtensions(extensions);
    diagnostics.relevantExtensions = relevantExtensions.map((ext) => ({
      id: ext.id,
      identifier: ext.identifier,
      name: ext.name,
      version: ext.version,
      enabled: ext.enabled,
      status: ext.status,
      has_frontend: ext.has_frontend,
      has_backend: ext.has_backend,
      branch: ext.metadata?.branch ?? null,
    }));

    diagnostics.manifests = [];
    if (CAPTURE_MANIFESTS) {
      for (const ext of relevantExtensions) {
        if (!ext?.id) continue;
        const manifest = await fetchJson(page, `/api/v1/spindle/${encodeURIComponent(ext.id)}/manifest`);
        diagnostics.manifests.push({
          extensionId: ext.id,
          identifier: ext.identifier,
          name: ext.name,
          manifest,
        });
      }
    }

    diagnostics.pageSnapshot = await snapshotPage(page);
    diagnostics.mountedRoots = await snapshotMountedRoots(page);
    diagnostics.visibleButtons = await snapshotVisibleButtons(page);
    diagnostics.mountedRootsByExtension = Object.fromEntries(
      relevantExtensions.map((ext) => [ext.id, diagnostics.mountedRoots.filter((root) => root.extensionId === ext.id)]),
    );

    for (const ext of relevantExtensions) {
      const roots = diagnostics.mountedRoots.filter((root) => root.extensionId === ext.id && root.visible);
      if (!roots.length) continue;
      const locator = page.locator(`[data-spindle-extension-root="${ext.id}"]`).first();
      await capture(locator, `extension-${ext.identifier || ext.id}`);
    }

    const probeTargets = [];
    if (ROOT_PROBE_PLAN.length) {
      for (const entry of ROOT_PROBE_PLAN) {
        const extension = findExtensionByHint(relevantExtensions, entry.hint);
        if (!extension) {
          diagnostics.rootProbes.push({
            hint: entry.hint,
            error: 'extension not found',
          });
          continue;
        }
        probeTargets.push({ extension, buttons: entry.buttons });
      }
    } else if (PROBE_ALL_VISIBLE_ROOTS) {
      const visibleRootExtensionIds = unique(
        diagnostics.mountedRoots.filter((root) => root.visible).map((root) => root.extensionId),
      );
      for (const extensionId of visibleRootExtensionIds) {
        const extension = relevantExtensions.find((ext) => ext.id === extensionId);
        if (extension) probeTargets.push({ extension, buttons: null });
      }
    }

    for (const probeTarget of probeTargets) {
      const result = await probeExtensionRootButtons(page, diagnostics, target, probeTarget.extension, probeTarget.buttons);
      diagnostics.rootProbes.push(result);
    }

    diagnostics.extensionSummaries = buildExtensionSummaries(diagnostics, relevantExtensions);
    diagnostics.summary = {
      startedAt: diagnostics.startedAt,
      target: diagnostics.target,
      extensionCount: relevantExtensions.length,
      visibleRootCount: diagnostics.mountedRoots.filter((root) => root.visible).length,
      wsFrameCount: diagnostics.wsFrames.length,
      wsEventCounts: diagnostics.wsEventCounts,
      raceSignals: diagnostics.extensionSummaries
        .filter((summary) => summary.preLoadFrontendMessageCount > 0)
        .map((summary) => ({
          id: summary.id,
          identifier: summary.identifier,
          preLoadFrontendMessageCount: summary.preLoadFrontendMessageCount,
          frontendMessagesBeforeLoad: summary.frontendMessagesBeforeLoad.slice(0, 10),
        })),
      extensions: diagnostics.extensionSummaries,
    };

    fs.writeFileSync(
      path.join(OUT_DIR, 'diagnostics.json'),
      JSON.stringify(diagnostics, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(OUT_DIR, 'summary.json'),
      JSON.stringify(diagnostics.summary, null, 2),
      'utf8',
    );

    log('Wrote diagnostics:', path.join(OUT_DIR, 'diagnostics.json'));
    log('Wrote summary:', path.join(OUT_DIR, 'summary.json'));
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
