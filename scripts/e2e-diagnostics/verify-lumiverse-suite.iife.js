/*
 * Lumiverse Suite browser-console verification harness.
 *
 * Usage:
 *   1. Open Lumiverse in a modern browser.
 *   2. Paste this file into DevTools.
 *   3. The complete suite runs immediately.
 *   4. The results are copied to the clipboard automatically when permitted.
 *      Use the floating "Copy results" button if the browser blocks that write.
 *   5. Re-run individual suites with:
 *        await window.__LUMIVERSE_TESTER__.testQuickToolbar()
 *      or re-run everything with:
 *        await window.__LUMIVERSE_TESTER__.runAll()
 *
 * Static checks are observational. The optional interactive probe phase clicks
 * only safe open/close controls, cancels message editing, and changes settings
 * tabs temporarily. It never clicks Save, Send, Delete, or submits a form.
 */
(async () => {
  "use strict";

  const host = window;
  const doc = document;
  const perf = host.performance || { now: () => Date.now() };
  const startedAt = perf.now();

  const MODULE_IDS = Object.freeze([
    "quick_toolbar",
    "lore_indicator",
    "connections_picker",
    "portrait_dock",
    "character_display",
    "character_library_scope",
    "lorebook_token_counts",
    "lorebook_workspace",
    "homepage_library",
  ]);

  const STORE_SLICE_KEYS = Object.freeze([
    "chat",
    "characters",
    "personas",
    "ui",
    "settings",
    "connections",
    "spindle",
    "worldInfo",
    "promptBreakdown",
    "loadouts",
    "operator",
    "floatingAvatar",
    "chatHeads",
    "databank",
    "weaver",
    "containers",
  ]);

  const SNAPSHOT_STATE_KEYS = Object.freeze([
    "quickToolbarSettings",
    "connectionsPickerSettings",
    "loreIndicatorSettings",
    "portraitDockSettings",
    "lorebookHalfEditor",
    "activatedWorldInfo",
    "settingsModalOpen",
    "settingsActiveView",
  ]);

  const COLORS = Object.freeze({
    PASS: "#49d17d",
    WARN: "#f5b942",
    FAIL: "#ff6577",
    INFO: "#54c7ec",
    GROUP: "#9cdcfe",
  });

  const BADGES = Object.freeze({
    PASS: "🟢 [PASS]",
    WARN: "🟡 [WARN]",
    FAIL: "🔴 [FAIL]",
    INFO: "ℹ️ [INFO]",
  });

  const runState = {
    currentSuite: "General",
    results: [],
    running: false,
    runPromise: null,
    lastSummary: null,
    startedAt,
  };

  const highlightOverlays = new Set();
  let copyButton = null;
  let copyButtonResetTimer = null;
  const snapshotStore =
    host.__LUMIVERSE_UI_SNAPSHOT__ &&
    typeof host.__LUMIVERSE_UI_SNAPSHOT__ === "object"
      ? host.__LUMIVERSE_UI_SNAPSHOT__
      : {};

  if (!snapshotStore.baselines || typeof snapshotStore.baselines !== "object") {
    snapshotStore.baselines = {};
  }
  if (!Array.isArray(snapshotStore.history)) {
    snapshotStore.history = [];
  }
  snapshotStore.version = 1;
  snapshotStore.description =
    "In-memory, read-only Lumiverse UI and Zustand snapshots.";

  function isObjectLike(value) {
    return value !== null && (typeof value === "object" || typeof value === "function");
  }

  function formatValue(value) {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "string") return value;
    if (typeof value === "function") return "[Function]";
    try {
      const json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch {
      return String(value);
    }
  }

  function logRecord(status, label, detail, data) {
    const level = BADGES[status] ? status : "INFO";
    const suffix = detail ? " — " + String(detail) : "";
    console.log(
      "%c%s%c %s%s",
      "color:" + COLORS[level] + ";font-weight:700",
      BADGES[level],
      "color:inherit;font-weight:400",
      label,
      suffix,
    );
    if (data !== undefined) console.log(data);
  }

  function record(status, label, detail, data) {
    const normalized = BADGES[status] ? status : "INFO";
    const entry = {
      status: normalized,
      suite: runState.currentSuite,
      label,
      detail: detail == null ? "" : String(detail),
      data: data === undefined ? null : data,
      timeMs: Math.round(perf.now() - runState.startedAt),
    };
    runState.results.push(entry);
    logRecord(normalized, label, detail, data);
    return entry;
  }

  function pass(label, detail, data) {
    return record("PASS", label, detail, data);
  }

  function warn(label, detail, data) {
    return record("WARN", label, detail, data);
  }

  function fail(label, detail, data) {
    return record("FAIL", label, detail, data);
  }

  function info(label, detail, data) {
    return record("INFO", label, detail, data);
  }

  function safeTable(rows) {
    if (!rows || !rows.length) return;
    if (typeof console.table === "function") {
      console.table(rows);
    } else {
      console.log(rows);
    }
  }

  function openGroup(title) {
    if (typeof console.groupCollapsed === "function") {
      console.groupCollapsed("%c" + title, "color:" + COLORS.GROUP + ";font-weight:700");
    } else {
      console.log(title);
    }
  }

  function closeGroup() {
    if (typeof console.groupEnd === "function") console.groupEnd();
  }

  async function runSuite(name, callback) {
    const previousSuite = runState.currentSuite;
    runState.currentSuite = name;
    openGroup(name);
    try {
      return await callback();
    } catch (error) {
      fail(
        "Suite execution completed without an uncaught exception",
        error && error.stack ? error.stack : String(error),
      );
      return null;
    } finally {
      closeGroup();
      runState.currentSuite = previousSuite;
    }
  }

  function queryAll(selector, root = doc) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function uniqueElements(elements) {
    return Array.from(new Set((elements || []).filter(Boolean)));
  }

  function firstMatch(selectors, root = doc) {
    for (const selector of selectors) {
      const found = queryAll(selector, root)[0];
      if (found) return found;
    }
    return null;
  }

  function allMatches(selectors, root = doc) {
    return uniqueElements(
      (selectors || []).flatMap((selector) => queryAll(selector, root)),
    );
  }

  function descendantsMatching(root, selectors) {
    return allMatches(selectors, root || doc);
  }

  function textOf(element) {
    return element && typeof element.textContent === "string"
      ? element.textContent.trim()
      : "";
  }

  function attr(element, name) {
    return element && element.getAttribute ? element.getAttribute(name) : null;
  }

  function hasAttributeValue(element, name, value) {
    return attr(element, name) === value;
  }

  function elementLabel(element) {
    if (!element) return "unknown";
    const component = attr(element, "data-component");
    const module = attr(element, "data-lumiverse-module");
    const id = attr(element, "id");
    const className =
      typeof element.className === "string"
        ? element.className.split(/\s+/).filter(Boolean).slice(0, 3).join(".")
        : "";
    return (
      component ||
      (module ? "module:" + module : "") ||
      (id ? "#" + id : "") ||
      (className ? "." + className : "") ||
      element.tagName.toLowerCase()
    );
  }

  function readRect(element) {
    if (!element || typeof element.getBoundingClientRect !== "function") return null;
    try {
      const rect = element.getBoundingClientRect();
      const values = {
        x: rect.x,
        y: rect.y,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      };
      return Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          Number.isFinite(value) ? Math.round(value * 100) / 100 : null,
        ]),
      );
    } catch {
      return null;
    }
  }

  function computedStyle(element) {
    if (!element || typeof host.getComputedStyle !== "function") return null;
    try {
      return host.getComputedStyle(element);
    } catch {
      return null;
    }
  }

  function isRendered(element) {
    const rect = readRect(element);
    const style = computedStyle(element);
    if (!style) return Boolean(element && element.isConnected !== false);
    return (
      element.isConnected !== false &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      Boolean(rect && (rect.width > 0 || rect.height > 0))
    );
  }

  function readCssVars(element, prefixes = []) {
    const result = {};
    const style = computedStyle(element);
    if (!style) return result;

    const accepts = (name) =>
      prefixes.some((prefix) => name === prefix || name.startsWith(prefix));

    try {
      for (let index = 0; index < style.length; index += 1) {
        const name = style[index];
        if (name && accepts(name)) {
          const value = style.getPropertyValue(name).trim();
          if (value) result[name] = value;
        }
      }
    } catch {
      // Explicit properties below still work in browsers that do not enumerate
      // custom properties through CSSStyleDeclaration.length.
    }

    const explicitNames = [
      "--quick-toolbar-x",
      "--quick-toolbar-y",
      "--quick-toolbar-width",
      "--quick-toolbar-height",
      "--quick-toolbar-natural-width",
      "--quick-toolbar-natural-height",
      "--quick-toolbar-scale",
      "--quick-toolbar-rotation",
      "--quick-toolbar-opacity",
      "--quick-toolbar-icon-size",
      "--quick-toolbar-label-size",
      "--lumiverse-ui-scale",
    ];
    for (const name of explicitNames) {
      if (!accepts(name)) continue;
      try {
        const value = style.getPropertyValue(name).trim();
        if (value) result[name] = value;
      } catch {
        // Ignore an unsupported computed-style property.
      }
    }
    return result;
  }

  function cssNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number.parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function firstCssNumber(vars, names) {
    for (const name of names) {
      const value = cssNumber(vars[name]);
      if (value !== null) return value;
    }
    return null;
  }

  function stylesSummary(element) {
    const style = computedStyle(element);
    if (!style) return {};
    return {
      display: style.display,
      visibility: style.visibility,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      position: style.position,
      transform: style.transform,
    };
  }

  function safeJsonParse(raw) {
    if (raw === null || raw === undefined || raw === "") {
      return { ok: false, value: null, reason: "missing" };
    }
    try {
      return { ok: true, value: JSON.parse(raw), reason: "" };
    } catch (error) {
      return {
        ok: false,
        value: null,
        reason: error && error.message ? error.message : "invalid JSON",
      };
    }
  }

  function readStorage(key) {
    try {
      const raw = host.localStorage.getItem(key);
      const parsed = safeJsonParse(raw);
      return { key, raw, ...parsed };
    } catch (error) {
      return {
        key,
        raw: null,
        ok: false,
        value: null,
        reason: error && error.message ? error.message : "localStorage unavailable",
      };
    }
  }

  function rectIntegrity(value, options = {}) {
    const allowPositionOnly = options.allowPositionOnly === true;
    if (!value || typeof value !== "object") return false;
    const hasFinite = (key) => Number.isFinite(Number(value[key]));
    const positionOkay = hasFinite("x") && hasFinite("y");
    const dimensionsOkay =
      hasFinite("width") &&
      hasFinite("height") &&
      Number(value.width) >= 0 &&
      Number(value.height) >= 0;
    if (positionOkay && (dimensionsOkay || allowPositionOnly)) return true;

    const values = Array.isArray(value) ? value : Object.values(value);
    const objects = values.filter((entry) => entry && typeof entry === "object");
    return (
      objects.length > 0 &&
      objects.every((entry) =>
        rectIntegrity(entry, { allowPositionOnly }),
      )
    );
  }

  function readPath(object, path) {
    if (!object) return undefined;
    const parts = Array.isArray(path) ? path : String(path).split(".");
    let current = object;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = current[part];
    }
    return current;
  }

  function findStateValue(state, key) {
    if (!state || typeof state !== "object") return undefined;
    const direct = state[key];
    if (direct !== undefined) return direct;

    const likelyRoots = [
      state.ui,
      state.settings,
      state.connections,
      state.spindle,
      state.worldInfo,
      state.chat,
      state.productivity,
    ];
    for (const rootValue of likelyRoots) {
      if (rootValue && rootValue[key] !== undefined) return rootValue[key];
    }
    return undefined;
  }

  function stateMarkerCount(value) {
    if (!value || typeof value !== "object") return 0;
    return STORE_SLICE_KEYS.concat(SNAPSHOT_STATE_KEYS).filter((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    ).length;
  }

  function tryStoreCandidate(candidate, source) {
    if (!candidate) return null;
    const possibleStore =
      typeof candidate.getState === "function"
        ? candidate
        : candidate.store && typeof candidate.store.getState === "function"
          ? candidate.store
          : null;
    if (possibleStore) {
      try {
        const state = possibleStore.getState();
        if (state && typeof state === "object") {
          return { store: possibleStore, state, source };
        }
      } catch {
        // Continue to the fiber fallback.
      }
    }
    if (stateMarkerCount(candidate) >= 2) {
      return { store: null, state: candidate, source: source + " (slice state)" };
    }
    return null;
  }

  function getFiberRoots() {
    const roots = [];
    const candidates = uniqueElements([
      doc.querySelector("#root"),
      doc.body,
    ]);
    for (const element of candidates) {
      if (!element) continue;
      try {
        for (const key of Object.keys(element)) {
          if (key.startsWith("__reactFiber$") || key.startsWith("__reactContainer$")) {
            roots.push({ source: "React Fiber " + key, value: element[key] });
          }
        }
      } catch {
        // Cross-realm or sealed DOM objects can hide expando keys.
      }
    }
    return roots;
  }

  function findStoreThroughFiber() {
    const queue = getFiberRoots();
    const seen = new WeakSet();
    const maxNodes = 20000;
    let visited = 0;

    while (queue.length && visited < maxNodes) {
      const item = queue.shift();
      const value = item && item.value;
      if (!isObjectLike(value)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      visited += 1;

      const candidate = tryStoreCandidate(value, item.source);
      if (candidate) return candidate;

      const nextKeys = [
        "child",
        "sibling",
        "return",
        "memoizedProps",
        "pendingProps",
        "memoizedState",
        "stateNode",
        "dependencies",
        "updateQueue",
        "queue",
        "baseState",
        "next",
        "_next",
        "value",
        "store",
        "api",
        "context",
      ];
      for (const key of nextKeys) {
        let next;
        try {
          next = value[key];
        } catch {
          next = null;
        }
        if (isObjectLike(next)) {
          queue.push({ source: item.source + "." + key, value: next });
        }
      }

      if (item.source.split(".").length < 8 && !("nodeType" in value)) {
        let keys = [];
        try {
          keys = Object.keys(value).slice(0, 80);
        } catch {
          keys = [];
        }
        for (const key of keys) {
          if (nextKeys.includes(key)) continue;
          let next;
          try {
            next = value[key];
          } catch {
            next = null;
          }
          if (isObjectLike(next)) {
            queue.push({ source: item.source + "." + key, value: next });
          }
        }
      }
    }
    return null;
  }

  function resolveStore() {
    const directCandidates = [
      ["window.__ZUSTAND_STORE__", host.__ZUSTAND_STORE__],
      ["window.useStore", host.useStore],
      ["window.__LUMIVERSE_STORE__", host.__LUMIVERSE_STORE__],
    ];
    for (const [source, candidate] of directCandidates) {
      const result = tryStoreCandidate(candidate, source);
      if (result) return result;
    }
    return findStoreThroughFiber();
  }

  function storeState() {
    const resolved = resolveStore();
    return resolved ? resolved.state : null;
  }

  function cloneValue(value, depth = 0, seen = new WeakSet(), budget = { count: 0 }) {
    if (value === undefined) return null;
    if (value === null) return null;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "bigint") return String(value) + "n";
    if (typeof value === "function") return "[Function " + (value.name || "anonymous") + "]";
    if (typeof value !== "object") return String(value);
    if (depth > 8) return "[MaxDepth]";
    if (seen.has(value)) return "[Circular]";
    if (budget.count > 15000) return "[MaxEntries]";
    seen.add(value);
    budget.count += 1;

    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return String(value);
    if (value instanceof Map) {
      return Array.from(value.entries())
        .slice(0, 500)
        .map(([key, entry]) => [
          cloneValue(key, depth + 1, seen, budget),
          cloneValue(entry, depth + 1, seen, budget),
        ]);
    }
    if (value instanceof Set) {
      return Array.from(value.values())
        .slice(0, 500)
        .map((entry) => cloneValue(entry, depth + 1, seen, budget));
    }
    if (Array.isArray(value)) {
      return value
        .slice(0, 500)
        .map((entry) => cloneValue(entry, depth + 1, seen, budget));
    }

    const result = {};
    let keys = [];
    try {
      keys = Object.keys(value).slice(0, 500);
    } catch {
      return "[Unserializable]";
    }
    for (const key of keys) {
      try {
        result[key] = cloneValue(value[key], depth + 1, seen, budget);
      } catch {
        result[key] = "[Unreadable]";
      }
    }
    return result;
  }

  function stateSlicesForSnapshot(state) {
    const slices = {};
    for (const key of SNAPSHOT_STATE_KEYS) {
      const value = findStateValue(state, key);
      slices[key] = value === undefined ? null : cloneValue(value);
    }
    return slices;
  }

  function moduleRoots(moduleId) {
    return allMatches([
      '[data-lumiverse-module="' + moduleId + '"]',
      '[data-module-id="' + moduleId + '"]',
      '[data-spindle-module="' + moduleId + '"]',
    ]);
  }

  function extensionRoots() {
    return allMatches([
      "[data-spindle-extension-root]",
      "[data-spindle-ext]",
      "[data-lumiverse-module]",
    ]);
  }

  function collectRegistryTokens(value, tokens = new Set(), seen = new WeakSet(), depth = 0) {
    if (value === null || value === undefined || depth > 7 || tokens.size > 5000) {
      return tokens;
    }
    if (typeof value === "string") {
      tokens.add(value);
      return tokens;
    }
    if (!isObjectLike(value) || seen.has(value)) return tokens;
    seen.add(value);

    if (value instanceof Map) {
      for (const [key, entry] of value.entries()) {
        collectRegistryTokens(key, tokens, seen, depth + 1);
        collectRegistryTokens(entry, tokens, seen, depth + 1);
      }
      return tokens;
    }
    if (value instanceof Set) {
      for (const entry of value.values()) {
        collectRegistryTokens(entry, tokens, seen, depth + 1);
      }
      return tokens;
    }

    let keys = [];
    try {
      keys = Object.keys(value).slice(0, 500);
    } catch {
      return tokens;
    }
    for (const key of keys) {
      tokens.add(key);
      try {
        collectRegistryTokens(value[key], tokens, seen, depth + 1);
      } catch {
        // Ignore accessors that throw.
      }
    }
    return tokens;
  }

  function registryInfo() {
    const registry = host.__SPINDLE_EXTENSIONS__;
    const tokens = collectRegistryTokens(registry);
    const domRoots = extensionRoots();
    for (const element of domRoots) {
      for (const name of [
        "data-spindle-extension-root",
        "data-spindle-ext",
        "data-lumiverse-module",
        "data-module-id",
        "data-spindle-module",
      ]) {
        const value = attr(element, name);
        if (value) tokens.add(value);
      }
    }
    return {
      registry,
      registryAvailable: registry !== undefined && registry !== null,
      tokens,
      domRoots,
    };
  }

  function tokenContains(tokens, expected) {
    const needle = String(expected).toLowerCase();
    return Array.from(tokens).some((token) =>
      String(token).toLowerCase().includes(needle),
    );
  }

  function parseTransformScale(transform) {
    if (!transform || transform === "none") return null;
    const matrix3d = transform.match(/^matrix3d\(([^)]+)\)$/);
    if (matrix3d) {
      const values = matrix3d[1].split(",").map(Number);
      const sx = Math.hypot(values[0] || 0, values[1] || 0);
      const sy = Math.hypot(values[4] || 0, values[5] || 0);
      return { x: sx, y: sy };
    }
    const matrix = transform.match(/^matrix\(([^)]+)\)$/);
    if (matrix) {
      const values = matrix[1].split(",").map(Number);
      return {
        x: Math.hypot(values[0] || 0, values[1] || 0),
        y: Math.hypot(values[2] || 0, values[3] || 0),
      };
    }
    return null;
  }

  function countNumericBadge(elements) {
    for (const element of elements) {
      const text = textOf(element);
      const dataCount =
        attr(element, "data-count") ||
        attr(element, "data-active-count") ||
        attr(element, "aria-label");
      const source = dataCount || text;
      const match = String(source).match(/(?:^|\D)(\d+)(?:\D|$)/);
      if (match) return Number(match[1]);
    }
    return null;
  }

  function listStateProfiles(state) {
    const profiles =
      findStateValue(state, "connectionProfiles") ||
      readPath(state, "connections.profiles") ||
      readPath(state, "connections.connectionProfiles");
    if (Array.isArray(profiles)) return profiles;
    if (profiles && typeof profiles === "object") {
      return Object.entries(profiles).map(([id, profile]) => ({
        id,
        ...(profile && typeof profile === "object" ? profile : {}),
      }));
    }
    return [];
  }

  function profileId(profile) {
    if (!profile || typeof profile !== "object") return null;
    return (
      profile.id ||
      profile.profileId ||
      profile.connectionProfileId ||
      profile.uuid ||
      null
    );
  }

  function checkSurfacePresence(label, element, extra = "") {
    if (element) {
      return pass(label, (isRendered(element) ? "present and rendered" : "present but not rendered") + extra, {
        element: elementLabel(element),
        rect: readRect(element),
      });
    }
    return warn(label, "surface not present in the current route or UI state" + extra);
  }

  async function suiteStoreAndExtensions() {
    const resolved = resolveStore();
    if (resolved && resolved.state) {
      pass(
        "Zustand store is readable",
        "source: " + resolved.source,
        { storeApi: Boolean(resolved.store), stateKeys: Object.keys(resolved.state).slice(0, 80) },
      );
    } else {
      info(
        "Zustand store is readable",
        "No direct global or React Fiber-bound store was exposed by this page",
      );
    }

    const state = resolved && resolved.state;
    const missingSlices = state
      ? STORE_SLICE_KEYS.filter((key) => findStateValue(state, key) === undefined)
      : STORE_SLICE_KEYS.slice();
    if (!state) {
      info("Expected store slice root is available", "Store state is unavailable on this page");
    } else if (!missingSlices.length) {
      pass("Expected store slice root is available", "All documented root slices were found");
    } else {
      warn(
        "Expected store slice root is available",
        "Missing or unexposed slices: " + missingSlices.join(", "),
        { missingSlices },
      );
    }

    const registry = registryInfo();
    if (registry.registryAvailable) {
      pass(
        "Spindle extension registry is exposed",
        "window.__SPINDLE_EXTENSIONS__ is readable",
      );
    } else if (registry.domRoots.length) {
      info(
        "Spindle extension registry is exposed",
        "Global registry is absent; DOM extension roots are available as evidence",
      );
    } else {
      info(
        "Spindle extension registry is exposed",
        "Neither global registry nor extension-root markers are available on this page",
      );
    }

    const suiteInstalled = tokenContains(registry.tokens, "lumiverse_suite");
    if (suiteInstalled) {
      pass("lumiverse_suite registration is discoverable", "Registry or DOM tokens include lumiverse_suite");
    } else {
      info(
        "lumiverse_suite registration is discoverable",
        "The suite UUID was not found in the exposed registry or DOM markers",
      );
    }

    pass("Spindle extension roots are enumerable", registry.domRoots.length + " matching root/module nodes", {
      count: registry.domRoots.length,
    });

    const moduleRows = MODULE_IDS.map((moduleId) => {
      const foundInRegistry = tokenContains(registry.tokens, moduleId);
      const domMatches = moduleRoots(moduleId);
      const found = foundInRegistry || domMatches.length > 0;
      return {
        moduleId,
        status: found ? "PASS" : "WARN",
        registryOrDom: found,
        domCount: domMatches.length,
      };
    });
    safeTable(moduleRows);
    for (const row of moduleRows) {
      if (row.status === "PASS") {
        pass("Module registration: " + row.moduleId, "Found in registry tokens or DOM markers", row);
      } else {
        info(
          "Module registration: " + row.moduleId,
          "Not visible in current registry/DOM evidence; it may be unmounted or unavailable on this route",
          row,
        );
      }
    }
  }

  async function suiteQuickToolbar() {
    const state = storeState();
    const settings = findStateValue(state, "quickToolbarSettings");
    const toolbar = firstMatch([
      '[data-component="QuickToolbar"]',
      ".lumiverse-quick-toolbar",
      'nav[aria-label="Quick access toolbar"]',
    ]);
    const toolbarFallback = toolbar || allMatches(['[data-layer="body"]']).find((element) =>
      Boolean(
        element.querySelector &&
          element.querySelector('[data-component="QuickToolbar"], .lumiverse-quick-toolbar'),
      ),
    );

    if (!toolbarFallback) {
      if (settings && settings.hideWhenOverlaid) {
        warn(
          "Quick Toolbar surface is locatable",
          "No toolbar root is mounted and quickToolbarSettings.hideWhenOverlaid is true",
        );
      } else if (settings && settings.enabled === false) {
        warn("Quick Toolbar surface is locatable", "Toolbar is disabled in quickToolbarSettings");
      } else {
        warn("Quick Toolbar surface is locatable", "No toolbar root is mounted on the current route");
      }
      if (settings) {
        pass("Quick Toolbar settings state is readable", "quickToolbarSettings is available", cloneValue(settings));
      } else {
        info("Quick Toolbar settings state is readable", "quickToolbarSettings is not exposed on this page");
      }
      return;
    }

    checkSurfacePresence("Quick Toolbar surface is locatable", toolbarFallback);
    if (settings) {
      pass("Quick Toolbar settings state is readable", "quickToolbarSettings is available", cloneValue(settings));
    } else {
      info("Quick Toolbar settings state is readable", "quickToolbarSettings is not exposed on this page");
    }

    const toolbarNav = firstMatch([
      'nav[aria-label="Quick access toolbar"]',
      "nav.cardStrip",
      "nav.toolbarFree",
      'nav[class*="cardStrip"]',
      'nav[class*="toolbar"]',
    ], toolbarFallback);
    const rootClassText = typeof toolbarFallback.className === "string" ? toolbarFallback.className : "";
    const navClassText =
      toolbarNav && typeof toolbarNav.className === "string" ? toolbarNav.className : "";
    const hasClassFragment = (value, fragment) =>
      String(value).toLowerCase().includes(String(fragment).toLowerCase());
    const isFree =
      hasClassFragment(rootClassText, "rootFree") ||
      hasClassFragment(navClassText, "toolbarFree");
    const isAnchored =
      hasClassFragment(rootClassText, "rootAnchored") ||
      hasClassFragment(navClassText, "cardStrip") ||
      Boolean(toolbarNav && attr(toolbarNav, "data-density"));
    if (isFree || isAnchored) {
      pass(
        "Quick Toolbar variant is identifiable",
        isFree ? "v1 free-floating" : "v2 anchored card strip",
      );
    } else {
      warn("Quick Toolbar variant is identifiable", "No rootFree/rootAnchored or known navigation variant marker");
    }

    const rect = readRect(toolbarFallback);
    const rectOkay = rect && Number(rect.width) > 0 && Number(rect.height) > 0;
    if (rectOkay) {
      pass("Quick Toolbar geometry is measurable", "Bounding rect is non-zero", rect);
    } else {
      warn("Quick Toolbar geometry is measurable", "Root has a zero-size or unavailable bounding rect", rect);
    }

    const vars = Object.assign(
      {},
      readCssVars(toolbarFallback, ["--quick-toolbar-"]),
      toolbarNav ? readCssVars(toolbarNav, ["--quick-toolbar-"]) : {},
    );
    const requiredVars = [
      "--quick-toolbar-x",
      "--quick-toolbar-y",
      "--quick-toolbar-width",
      "--quick-toolbar-height",
    ];
    const presentVars = requiredVars.filter((name) => vars[name] !== undefined);
    const invalidVars = presentVars.filter((name) => cssNumber(vars[name]) === null);
    if (!isFree && isAnchored) {
      info(
        "Quick Toolbar CSS geometry variables are numeric",
        "Anchored variant uses nav sizing variables; free-floating x/y/width/height are not applicable",
        vars,
      );
    } else if (presentVars.length === requiredVars.length && !invalidVars.length) {
      pass("Quick Toolbar CSS geometry variables are numeric", "x/y/width/height are present", vars);
    } else if (presentVars.length) {
      warn(
        "Quick Toolbar CSS geometry variables are numeric",
        "Some variables are missing or non-numeric",
        { present: presentVars, invalid: invalidVars, vars },
      );
    } else {
      warn("Quick Toolbar CSS geometry variables are numeric", "No --quick-toolbar-* geometry variables are exposed");
    }

    const scaleFromVar = firstCssNumber(vars, ["--quick-toolbar-scale", "--lumiverse-ui-scale"]);
    const transformScale = parseTransformScale(stylesSummary(toolbarFallback).transform);
    if (scaleFromVar !== null && scaleFromVar > 0) {
      const transformMatches =
        !transformScale ||
        Math.abs(transformScale.x - scaleFromVar) <= 0.05 ||
        Math.abs(transformScale.y - scaleFromVar) <= 0.05;
      if (transformMatches) {
        pass("Quick Toolbar layout scale is coherent", "Scale variable is positive and agrees with transform when present", {
          variableScale: scaleFromVar,
          transformScale,
        });
      } else {
        warn("Quick Toolbar layout scale is coherent", "Scale variable and transform scale differ", {
          variableScale: scaleFromVar,
          transformScale,
        });
      }
    } else {
      warn("Quick Toolbar layout scale is coherent", "No positive scale custom property is exposed");
    }

    const dragGrip = firstMatch([
      'button[aria-label="Move quick toolbar"]',
      ".dragHandle",
      ".dragHandleVertical",
      ".lumiverse-quick-toolbar__drag-surface",
      '[data-drag-surface="true"]',
      '[class*="dragHandle"]',
    ], toolbarFallback);
    if (dragGrip) {
      pass("Quick Toolbar drag surface is discoverable", elementLabel(dragGrip));
    } else if (isAnchored) {
      info("Quick Toolbar drag surface is discoverable", "Drag grip is only applicable to the free-floating variant");
    } else {
      warn("Quick Toolbar drag surface is discoverable", "No supported drag grip marker is mounted");
    }

    const sizingVars = {
      iconSize: vars["--quick-toolbar-icon-size"],
      labelSize: vars["--quick-toolbar-label-size"],
    };
    const missingSizingVars = Object.entries(sizingVars)
      .filter(([, value]) => value === undefined || cssNumber(value) === null)
      .map(([name]) => name);
    if (!missingSizingVars.length) {
      pass("Quick Toolbar action sizing variables are numeric", "Icon and label sizes are exposed", sizingVars);
    } else {
      warn("Quick Toolbar action sizing variables are numeric", "Icon/label sizing variables are missing or non-numeric", {
        sizingVars,
        missing: missingSizingVars,
      });
    }

    const overflowButton = firstMatch([
      "button.overflowButton",
      'button[aria-controls="quick-toolbar-overflow"]',
    ], toolbarFallback);
    if (overflowButton) {
      pass("Quick Toolbar overflow launcher is discoverable", elementLabel(overflowButton));
    } else {
      warn("Quick Toolbar overflow launcher is discoverable", "No overflow button is mounted");
    }

    const overflow = firstMatch([
      '#quick-toolbar-overflow[data-side="top"]',
      '#quick-toolbar-overflow[data-side="bottom"]',
      "#quick-toolbar-overflow",
      ".overflowList",
    ]);
    if (overflow) {
      const overflowSide = attr(overflow, "data-side");
      const overflowSearch = firstMatch([".overflowSearch input"], overflow);
      const overflowList = firstMatch([".overflowList"], overflow);
      const overflowRows = descendantsMatching(overflow, [".overflowRow"]);
      const overflowPins = descendantsMatching(overflow, [".overflowPin"]);
      safeTable([{
        side: overflowSide,
        validSide: overflowSide === "top" || overflowSide === "bottom",
        search: Boolean(overflowSearch),
        list: Boolean(overflowList),
        rows: overflowRows.length,
        pins: overflowPins.length,
      }]);
      if (overflowSide === "top" || overflowSide === "bottom") {
        pass("Quick Toolbar overflow popover side is valid", overflowSide);
      } else {
        warn("Quick Toolbar overflow popover side is valid", "data-side is missing or unrecognized", { overflowSide });
      }
      if (overflowSearch && overflowList) {
        pass("Quick Toolbar overflow popover structure is complete", overflowRows.length + " overflow row(s)");
      } else {
        warn("Quick Toolbar overflow popover structure is complete", "Search or list region is missing");
      }
    } else if (overflowButton) {
      info("Quick Toolbar overflow popover structure is complete", "Overflow launcher is present but popover is closed");
    }

    const restoreHandle = firstMatch([
      'button.modalRestoreHandle[data-component="QuickToolbar"]',
      "button.modalRestoreHandle",
    ]);
    if (restoreHandle) {
      pass("Quick Toolbar restore handle is discoverable", elementLabel(restoreHandle));
    } else {
      info("Quick Toolbar restore handle is discoverable", "Restore handle is only applicable while the toolbar modal is open");
    }

    const actionItems = descendantsMatching(toolbarFallback, [
      "[data-action-id]",
      "button.card",
      "button.item",
      'button[class*="card"]',
      'button[class*="item"]',
    ]);
    const actionRows = actionItems.map((item, index) => ({
      index,
      actionId: attr(item, "data-action-id") || textOf(item).slice(0, 60),
      width: readRect(item) && readRect(item).width,
      height: readRect(item) && readRect(item).height,
      visible: isRendered(item),
    }));
    safeTable(actionRows);

    const itemRects = actionItems
      .map((item) => ({ item, rect: readRect(item) }))
      .filter((entry) => entry.rect && entry.rect.width >= 0 && entry.rect.height >= 0);
    const rootRect = readRect(toolbarFallback);
    const clipped = rootRect
      ? itemRects.filter(({ rect: itemRect }) =>
          itemRect.right > rootRect.right + 1 ||
          itemRect.left < rootRect.left - 1 ||
          itemRect.bottom > rootRect.bottom + 1 ||
          itemRect.top < rootRect.top - 1,
        )
      : [];
    const collapsed = itemRects.filter(({ rect: itemRect }) =>
      itemRect.width === 0 || itemRect.height === 0,
    );
    if (!actionItems.length) {
      info("Quick Toolbar actions fit without clipping", "No action items are currently rendered; the toolbar may be showing only overflow/customizer controls");
    } else if (!clipped.length && !collapsed.length) {
      pass("Quick Toolbar actions fit without clipping", actionItems.length + " action item(s) have usable bounds");
    } else {
      warn("Quick Toolbar actions fit without clipping", "Clipped: " + clipped.length + "; collapsed: " + collapsed.length, {
        clipped: clipped.length,
        collapsed: collapsed.length,
      });
    }

    const toolbarStyle = stylesSummary(toolbarFallback);
    const scrollbarIssue =
      toolbarStyle.overflowX === "scroll" ||
      toolbarStyle.overflowY === "scroll" ||
      (toolbarFallback.scrollWidth > toolbarFallback.clientWidth + 1) ||
      (toolbarFallback.scrollHeight > toolbarFallback.clientHeight + 1);
    if (scrollbarIssue) {
      warn("Quick Toolbar container has no unwanted scrollbars", "Scrollable overflow is measurable", {
        scrollWidth: toolbarFallback.scrollWidth,
        clientWidth: toolbarFallback.clientWidth,
        scrollHeight: toolbarFallback.scrollHeight,
        clientHeight: toolbarFallback.clientHeight,
      });
    } else {
      pass("Quick Toolbar container has no unwanted scrollbars", "No scroll overflow detected");
    }

    if (actionItems.length > 1 && rootRect) {
      const orientation =
        (settings && settings.orientation) ||
        attr(toolbarFallback, "data-orientation") ||
        "horizontal";
      const axis = orientation === "vertical" ? "y" : "x";
      const ordered = itemRects
        .slice()
        .sort((a, b) => (axis === "x" ? a.rect.left - b.rect.left : a.rect.top - b.rect.top));
      const gaps = [];
      for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1].rect;
        const current = ordered[index].rect;
        gaps.push(
          axis === "x"
            ? Math.round((current.left - previous.right) * 100) / 100
            : Math.round((current.top - previous.bottom) * 100) / 100,
        );
      }
      const usedStart = axis === "x" ? ordered[0].rect.left : ordered[0].rect.top;
      const usedEnd =
        axis === "x"
          ? ordered[ordered.length - 1].rect.right
          : ordered[ordered.length - 1].rect.bottom;
      const containerStart = axis === "x" ? rootRect.left : rootRect.top;
      const containerEnd = axis === "x" ? rootRect.right : rootRect.bottom;
      const deadSpace = Math.max(0, containerEnd - containerStart - (usedEnd - usedStart));
      safeTable([{ orientation, averageGap: gaps.reduce((a, b) => a + b, 0) / gaps.length, deadSpace }]);
      if (gaps.some((gap) => gap < -1)) {
        warn("Quick Toolbar action gaps are non-overlapping", "At least one action overlaps its neighbor", { gaps });
      } else {
        pass("Quick Toolbar action gaps are non-overlapping", "No neighboring action overlap detected", { gaps });
      }
      if (deadSpace > Math.max(24, (axis === "x" ? rootRect.width : rootRect.height) * 0.65)) {
        warn("Quick Toolbar dead-space distribution is reasonable", "A large unused strip remains inside the container", {
          deadSpace,
          containerLength: axis === "x" ? rootRect.width : rootRect.height,
        });
      } else {
        pass("Quick Toolbar dead-space distribution is reasonable", "Action span uses the available container area");
      }
    } else {
      info("Quick Toolbar dead-space distribution is reasonable", "At least two measurable actions are needed for gap/dead-space analysis");
    }

    const handleSelectors = [
      ".resizeHandle",
      ".lumiverse-quick-toolbar__resize-handle",
      '[data-resize-handle="n"]',
      '[data-resize-handle="ne"]',
      '[data-resize-handle="e"]',
      '[data-resize-handle="se"]',
      '[data-resize-handle="s"]',
      '[data-resize-handle="sw"]',
      '[data-resize-handle="w"]',
      '[data-resize-handle="nw"]',
      ".resizeN",
      ".resizeS",
      ".resizeE",
      ".resizeW",
      ".resizeNe",
      ".resizeNw",
      ".resizeSe",
      ".resizeSw",
      '[class*="resizeHandle"]',
    ];
    const handles = descendantsMatching(toolbarFallback, handleSelectors);
    const zeroHandles = handles.filter((handle) => {
      const handleRect = readRect(handle);
      return !handleRect || handleRect.width === 0 || handleRect.height === 0;
    });
    if (settings && settings.resizeHandlesEnabled === false) {
      info("Quick Toolbar resize handles are inspectable", "Resize handles are disabled by settings");
    } else if (isAnchored) {
      info("Quick Toolbar resize handles are inspectable", "Resize handles are only applicable to the free-floating variant");
    } else if (handles.length >= 8 && !zeroHandles.length) {
      pass("Quick Toolbar resize handles are inspectable", "Eight or more non-collapsed handles found");
    } else if (!handles.length) {
      warn("Quick Toolbar resize handles are inspectable", "No resize handles are mounted");
    } else {
      warn("Quick Toolbar resize handles are inspectable", "Some handles are missing or collapsed", {
        count: handles.length,
        collapsed: zeroHandles.length,
      });
    }

    const cardStrip = isAnchored
      ? toolbarNav || firstMatch(['nav[class*="cardStrip"]'], toolbarFallback)
      : null;
    if (cardStrip) {
      const density = attr(cardStrip, "data-density");
      if (density === "compact" || density === "comfortable") {
        pass("Anchored Quick Toolbar density is valid", density);
      } else {
        warn("Anchored Quick Toolbar density is valid", "data-density is missing or unrecognized", { density });
      }
      const fit = attr(cardStrip, "data-fit");
      if (fit === "ready") {
        pass("Anchored Quick Toolbar fit state is ready", "nav.cardStrip[data-fit=ready]");
      } else if (fit === "pending") {
        warn("Anchored Quick Toolbar fit state is ready", "nav.cardStrip is still data-fit=pending");
      } else {
        warn("Anchored Quick Toolbar fit state is ready", "data-fit is missing or unrecognized", { fit });
      }
    }

    const customize = firstMatch([
      'button[aria-label="Customize toolbar"]',
      ".cardStripSettings",
      ".itemActive",
      'button[class*="cardStripSettings"]',
    ], toolbarFallback);
    if (customize) {
      pass("Quick Toolbar customizer launcher is discoverable", elementLabel(customize));
    } else {
      warn("Quick Toolbar customizer launcher is discoverable", "No customizer button is mounted");
    }
  }

  async function suiteConnectionsPicker() {
    const state = storeState();
    const settings = findStateValue(state, "connectionsPickerSettings");
    const picker = firstMatch([
      '[data-component="ConnectionsPicker"]',
      ".frame",
      ".connectionsPicker",
      ".picker[class*=\"density\"]",
    ]);
    const launcher = firstMatch([
      'button[data-action-id="connections"]',
      'button[data-action-id="lumiverse_suite.connections_picker.open"]',
      '[data-lumiverse-module="connections_picker"]',
      '[data-lumiverse-connections-launcher="true"]',
    ]);

    if (picker) {
      checkSurfacePresence("Connections Picker surface is locatable", picker);
    } else {
      info(
        "Connections Picker surface is locatable",
        launcher
          ? "Picker is closed; launcher is present and was not activated"
          : "Neither picker nor launcher is present on the current route",
      );
    }

    if (settings) {
      pass("Connections Picker settings state is readable", "connectionsPickerSettings is available", cloneValue(settings));
      const variant = settings.variant;
      if (["provider-tags", "split", "full"].includes(variant)) {
        pass("Connections Picker variant is valid", variant);
      } else {
        warn("Connections Picker variant is valid", "Missing or unknown variant", { variant });
      }
    } else {
      info("Connections Picker settings state is readable", "connectionsPickerSettings is not exposed while the picker is closed");
    }

    if (!picker) return;

    const variantButtons = descendantsMatching(picker, [".variantSwitch button"]);
    const variantLabels = variantButtons.map((button) => textOf(button).slice(0, 20));
    if (variantButtons.length) {
      pass("Connections Picker variant switcher is rendered", variantLabels.join(", "));
    } else {
      warn("Connections Picker variant switcher is rendered", "No .variantSwitch buttons found");
    }
    const pickerDensity = picker.matches && picker.matches('.picker[class*="density"]')
      ? Array.from(picker.classList).find((name) => name.startsWith("density"))
      : null;
    if (pickerDensity || attr(picker, "data-density")) {
      pass("Connections Picker density marker is present", pickerDensity || attr(picker, "data-density"));
    } else {
      warn("Connections Picker density marker is present", "No density class or data-density attribute found");
    }

    const providerTabs = descendantsMatching(picker, [
      ".providerTabs button",
      'button[data-tab="favorites"]',
      'button[data-tab="recent"]',
      'button[data-tab="all"]',
      'button[data-tab^="tag:"]',
    ]);
    const activeProviderTabs = providerTabs.filter(
      (button) =>
        attr(button, "aria-selected") === "true" ||
        button.classList.contains("active") ||
        button.classList.contains("selected"),
    );
    if (providerTabs.length) {
      pass("Connections Picker provider tabs are rendered", providerTabs.length + " tab button(s)", {
        labels: providerTabs.map((button) => textOf(button).slice(0, 60)),
        activeCount: activeProviderTabs.length,
      });
    } else {
      warn("Connections Picker provider tabs are rendered", "No provider tabs found");
    }

    const grid = firstMatch([".modelGrid", ".modelGridSection"], picker);
    const modelButtons = descendantsMatching(picker, [".modelGridButton"]);
    const activeModels = modelButtons.filter((button) =>
      button.classList.contains("modelGridButtonActive") ||
      attr(button, "aria-selected") === "true",
    );
    if (grid) {
      pass("Connections Picker model grid is rendered", modelButtons.length + " model button(s)", {
        activeModels: activeModels.length,
      });
      if (activeModels.length <= 1) {
        pass("Connections Picker has at most one active model", activeModels.length + " active model button(s)");
      } else {
        warn("Connections Picker has at most one active model", activeModels.length + " active model buttons");
      }
    } else {
      warn("Connections Picker model grid is rendered", "No .modelGrid or .modelGridSection found");
    }

    const search = firstMatch([".searchBox input", 'input[type="search"]'], picker);
    if (search) {
      pass("Connections Picker search control is discoverable", attr(search, "placeholder") || "search input");
      info(
        "Connections Picker search filtering was not exercised",
        "The harness does not type into user-facing controls or mutate picker state",
      );
    } else {
      warn("Connections Picker search control is discoverable", "No search input found");
    }

    const settingsButton = firstMatch(['button[title="Manage connections"]'], picker);
    const closeButton = firstMatch(['button[title="Close connections picker"]'], picker);
    if (settingsButton) pass("Connections Picker manage-connections control is discoverable", elementLabel(settingsButton));
    else warn("Connections Picker manage-connections control is discoverable", "Button not mounted");
    if (closeButton) pass("Connections Picker close control is discoverable", elementLabel(closeButton));
    else warn("Connections Picker close control is discoverable", "Button not mounted");

    const activeProfileId = findStateValue(state, "activeConnectionProfileId");
    const profiles = listStateProfiles(state);
    if (profiles.length) {
      const matchingProfile = profiles.find((profile) => String(profileId(profile)) === String(activeProfileId));
      if (activeProfileId && matchingProfile) {
        pass("Connections Picker active profile is bound", String(activeProfileId), {
          profileCount: profiles.length,
        });
      } else if (!activeProfileId) {
        warn("Connections Picker active profile is bound", "No activeConnectionProfileId is selected");
      } else {
        warn("Connections Picker active profile is bound", "Active ID is not present in connectionProfiles", {
          activeProfileId,
          profileIds: profiles.map(profileId),
        });
      }
    } else {
      warn("Connections Picker active profile is bound", "connectionProfiles is empty or unavailable");
    }

    const rectStorage = readStorage("lumiverse:connections-picker:rects");
    if (!rectStorage.ok) {
      warn("Connections Picker rect persistence is valid", "Stored rects are missing or invalid JSON", rectStorage.reason);
    } else if (rectIntegrity(rectStorage.value)) {
      pass("Connections Picker rect persistence is valid", "Stored rects contain finite geometry", rectStorage.value);
    } else {
      warn("Connections Picker rect persistence is valid", "Stored JSON does not contain a recognized rect shape", rectStorage.value);
    }
  }

  async function suiteLoreIndicator() {
    const state = storeState();
    const settings = findStateValue(state, "loreIndicatorSettings");
    const roots = allMatches([
      '[data-lumiverse-module="lore_indicator"]',
      '[data-surface-id="activated_lore.indicator"]',
      '[data-variant="v2-compact"]',
      '[data-variant="v4-bottom-strip"]',
      '[data-variant="v5-command-palette"]',
      ".floatingRoot",
      ".composerRoot",
      ".paletteLayer",
    ]);
    const root = roots[0] || null;
    if (root) {
      checkSurfacePresence("Lore Indicator surface is locatable", root);
    } else {
      info("Lore Indicator surface is locatable", "No supported lore indicator root is mounted on this route");
    }

    if (settings) {
      pass("Lore Indicator settings state is readable", "loreIndicatorSettings is available", cloneValue(settings));
    } else {
      info("Lore Indicator settings state is readable", "loreIndicatorSettings is not exposed on this page");
    }

    const variantRoots = allMatches([
      '[data-variant="v2-compact"]',
      '[data-variant="v4-bottom-strip"]',
      '[data-variant="v5-command-palette"]',
    ]);
    if (variantRoots.length) {
      pass(
        "Lore Indicator variant is recognized",
        variantRoots.map((element) => attr(element, "data-variant")).join(", "),
      );
    } else if (root) {
      warn("Lore Indicator variant is recognized", "Root exists without a supported data-variant marker");
    }

    const v2 = firstMatch(['[data-variant="v2-compact"]', ".floatingRoot"], root || doc);
    if (v2) {
      const compactTrigger = firstMatch([".compactTrigger", '[class*="compactTrigger"]'], v2);
      const compactPopover = firstMatch([".compactPopover", '[class*="compactPopover"]'], v2);
      const bookIcon = descendantsMatching(v2, [
        '[data-icon="BookOpen"]',
        ".bookOpen",
        "svg",
      ])[0];
      if (compactTrigger) pass("Lore Indicator V2 compact trigger is discoverable", elementLabel(compactTrigger));
      else warn("Lore Indicator V2 compact trigger is discoverable", "No .compactTrigger is mounted");
      if (bookIcon) pass("Lore Indicator V2 BookOpen icon is discoverable", elementLabel(bookIcon));
      else warn("Lore Indicator V2 BookOpen icon is discoverable", "No BookOpen/icon marker is mounted");
      if (compactPopover) {
        pass("Lore Indicator V2 compact popover is structurally present", elementLabel(compactPopover));
      } else if (compactTrigger) {
        warn("Lore Indicator V2 compact popover is structurally present", "Popover is closed or not mounted");
      }
    }

    const activatedWorldInfo = findStateValue(state, "activatedWorldInfo");
    const activeCount = Array.isArray(activatedWorldInfo)
      ? activatedWorldInfo.length
      : activatedWorldInfo && typeof activatedWorldInfo === "object"
        ? Object.keys(activatedWorldInfo).length
        : null;
    if (activeCount === null) {
      info("Lore Indicator activation state is readable", "activatedWorldInfo is unavailable or not countable on this page");
    } else {
      pass("Lore Indicator activation state is readable", activeCount + " activated world-info item(s)");
      const badgeCandidates = allMatches([
        ".compactTrigger [data-active-count]",
        ".compactTrigger .countBadge",
        ".compactTrigger [data-count]",
        ".activeCount",
        ".countBadge",
        "[data-active-count]",
      ], root || doc);
      const badgeCount = countNumericBadge(badgeCandidates);
      if (badgeCount === null) {
        warn("Lore Indicator active count badge matches state", "No numeric active-count badge found");
      } else if (badgeCount === activeCount) {
        pass("Lore Indicator active count badge matches state", String(badgeCount));
      } else {
        fail(
          "Lore Indicator active count badge matches state",
          "Badge count " + badgeCount + " differs from activatedWorldInfo length " + activeCount,
        );
      }
    }

    const v4Items = allMatches(['[data-variant="v4-bottom-strip"] .stripItem[data-activation]']);
    if (v4Items.length) {
      const invalid = v4Items.filter(
        (item) => !["constant", "keyword", "vector"].includes(attr(item, "data-activation")),
      );
      if (!invalid.length) {
        pass("Lore Indicator V4 activation markers are valid", v4Items.length + " strip item(s)");
      } else {
        warn("Lore Indicator V4 activation markers are valid", invalid.length + " invalid marker(s)");
      }
    }
    const v4 = firstMatch(['[data-variant="v4-bottom-strip"]', ".composerRoot"]);
    if (v4) {
      const strip = firstMatch([".strip"], v4);
      const panelPopover = firstMatch([".v4PanelPopover"], v4);
      const configPopover = firstMatch([".v4ConfigPopover"], v4);
      safeTable([{
        strip: Boolean(strip),
        panelPopover: Boolean(panelPopover),
        configPopover: Boolean(configPopover),
        stripItems: v4Items.length,
      }]);
      if (strip) pass("Lore Indicator V4 bottom strip is structurally present", v4Items.length + " strip item(s)");
      else warn("Lore Indicator V4 bottom strip is structurally present", "No .strip is mounted");
      if (!panelPopover && !configPopover) {
        info("Lore Indicator V4 popovers are closed", "No panel/config popover is mounted");
      }
    }

    const v5 = firstMatch(['[data-variant="v5-command-palette"]', ".paletteLayer"]);
    if (v5) {
      const dialog = firstMatch([".paletteDialog"], v5);
      const dragBar = firstMatch([".paletteDragBar"], v5);
      const content = firstMatch([".paletteContent"], v5);
      const handles = descendantsMatching(v5, [".resizeHandle", '[data-resize-handle]']);
      safeTable([
        { element: "paletteDialog", present: Boolean(dialog) },
        { element: "paletteDragBar", present: Boolean(dragBar) },
        { element: "paletteContent", present: Boolean(content) },
        { element: "resizeHandle", count: handles.length },
      ]);
      if (dialog && dragBar && content) pass("Lore Indicator V5 palette structure is complete", "Dialog, drag bar, and content are mounted");
      else warn("Lore Indicator V5 palette structure is complete", "One or more palette parts are absent");
    }

    const floatingPosition = readStorage("lumiverse:lore-indicator:floating-position");
    if (!floatingPosition.ok) {
      warn("Lore Indicator floating position persistence is valid", "Stored position is missing or invalid JSON", floatingPosition.reason);
    } else if (rectIntegrity(floatingPosition.value, { allowPositionOnly: true })) {
      pass("Lore Indicator floating position persistence is valid", "Stored x/y are finite", floatingPosition.value);
    } else {
      warn("Lore Indicator floating position persistence is valid", "Stored value has no finite x/y pair", floatingPosition.value);
    }

    const v5Rect = readStorage("lumiverse:lore-indicator:v5-rect");
    if (!v5Rect.ok) {
      warn("Lore Indicator V5 rect persistence is valid", "Stored rect is missing or invalid JSON", v5Rect.reason);
    } else if (rectIntegrity(v5Rect.value)) {
      pass("Lore Indicator V5 rect persistence is valid", "Stored x/y/width/height are finite", v5Rect.value);
    } else {
      warn("Lore Indicator V5 rect persistence is valid", "Stored value has no recognized rect shape", v5Rect.value);
    }
  }

  async function suiteLorebookTokenCounts() {
    const rows = allMatches(["[data-world-book-entry-row]"]);
    const bookContainers = allMatches(["[data-world-book-entries-book-id]"]);
    const revisionRows = allMatches(["[data-world-book-entry-revision]"]);
    const badges = allMatches([
      "[data-lumiverse-token-count-badge]",
      ".lumiverse-token-count-badge",
    ]);
    const coreCells = allMatches(['[data-world-book-token-cell="true"]']);

    if (!rows.length && !badges.length) {
      info("Lorebook token-count rows are inspectable", "No world-book entry rows or token badges are mounted on this route");
      return;
    }
    if (rows.length) {
      pass("Lorebook token-count rows are inspectable", rows.length + " world-book entry row(s)", {
        bookContainers: bookContainers.length,
        revisionRows: revisionRows.length,
      });
    } else {
      warn("Lorebook token-count rows are inspectable", "Badges exist but no entry rows are currently mounted");
    }
    if (bookContainers.length || revisionRows.length) {
      pass("Lorebook token-count target anchors are present", bookContainers.length + " book container(s), " + revisionRows.length + " revision row(s)");
    } else {
      warn("Lorebook token-count target anchors are present", "No book-id or entry-revision target markers are mounted");
    }

    if (badges.length) {
      pass("Lorebook token-count badges are injected", badges.length + " badge(s)");
      const requiredAttributes = [
        "data-book-id",
        "data-entry-id",
        "data-state",
        "data-approximate",
        "data-fingerprint",
      ];
      const sample = badges.slice(0, 50);
      const missingMetadata = sample.flatMap((badge, index) =>
        requiredAttributes
          .filter((name) => !badge.hasAttribute(name))
          .map((name) => ({ index, name })),
      );
      if (!missingMetadata.length) {
        pass("Lorebook token-count badge metadata is complete", "Sampled " + sample.length + " badge(s)");
      } else {
        warn("Lorebook token-count badge metadata is complete", "Missing metadata on sampled badges", missingMetadata);
      }
    } else {
      warn("Lorebook token-count badges are injected", "No extension badges are mounted");
    }

    const decoratedRows = rows.filter((row) =>
      Boolean(row.querySelector("[data-lumiverse-token-count-badge], .lumiverse-token-count-badge")),
    );
    const badgesInsideCoreCells = coreCells.filter((cell) =>
      Boolean(cell.querySelector("[data-lumiverse-token-count-badge], .lumiverse-token-count-badge")),
    );
    if (badgesInsideCoreCells.length) {
      fail(
        "Lorebook token-count decorator respects core token cells",
        badgesInsideCoreCells.length + " core token cell(s) contain extension badges",
      );
    } else {
      pass(
        "Lorebook token-count decorator respects core token cells",
        coreCells.length
          ? "No extension badge was injected into " + coreCells.length + " core token cell(s)"
          : "No core token cells are currently mounted",
      );
    }

    if (rows.length && decoratedRows.length === 0 && coreCells.length === 0) {
      warn(
        "Lorebook token-count coverage is visible",
        "Rows are rendered without badges and without core token cells",
      );
    } else if (decoratedRows.length) {
      pass("Lorebook token-count coverage is visible", decoratedRows.length + " row(s) have extension badges");
    }
  }

  async function suiteLorebookWorkspace() {
    const mount = firstMatch([
      '[data-mount-point="lorebook_workspace"]',
      '[data-lumiverse-module="lorebook_workspace"]',
      '[data-surface-id="lorebook.half.workspace"]',
      '[data-surface-id="lorebook.enhanced.workspace"]',
    ]);
    const editor = firstMatch([
      '[data-component="LorebookEditorWorkspace"]',
      ".lorebookEditorWorkspace",
      '[data-lumiverse-lorebook-workspace="true"]',
      "[data-lumiverse-lorebook-editor]",
    ]);
    const table = firstMatch(["[data-lumiverse-lorebook-table]"]);
    const state = storeState();
    const halfEditor = findStateValue(state, "lorebookHalfEditor");

    if (mount || editor) {
      pass(
        "Lorebook Workspace mount is present",
        elementLabel(mount || editor),
        { mount: Boolean(mount), editor: Boolean(editor), table: Boolean(table) },
      );
    } else if (halfEditor && halfEditor.open) {
      warn("Lorebook Workspace mount is present", "Half editor state is open but no workspace DOM was found", cloneValue(halfEditor));
    } else {
      info("Lorebook Workspace mount is present", "No full or half workspace is mounted on this route");
    }

    if (editor) {
      pass("Lorebook full editor workspace is locatable", elementLabel(editor), readRect(editor));
    } else {
      info("Lorebook full editor workspace is locatable", "Full editor workspace is not mounted on this route");
    }

    if (halfEditor && typeof halfEditor === "object") {
      const validOpen = typeof halfEditor.open === "boolean";
      const validMode =
        halfEditor.mode === undefined ||
        ["half", "full", "enhanced", "editor"].includes(String(halfEditor.mode));
      if (validOpen && validMode) {
        pass("Lorebook half-editor state is valid", "open=" + halfEditor.open, cloneValue(halfEditor));
      } else {
        warn("Lorebook half-editor state is valid", "Unexpected open/mode shape", cloneValue(halfEditor));
      }
      if (halfEditor.open && !halfEditor.bookId) {
        warn("Lorebook half-editor state has a book binding", "open=true but bookId is empty");
      } else if (halfEditor.open) {
        pass("Lorebook half-editor state has a book binding", String(halfEditor.bookId));
      }
    } else {
      info("Lorebook half-editor state is valid", "lorebookHalfEditor is not exposed while the workspace is closed");
    }
  }

  async function suitePortraitDock() {
    const state = storeState();
    const settings = findStateValue(state, "portraitDockSettings");
    const floatingAvatar = findStateValue(state, "floatingAvatar");
    const dock = firstMatch([
      'section[data-mode="floating"][data-open="true"]',
      'section[data-mode="docked"][data-open="true"]',
      'section[data-dock-request="floating"][data-open="true"]',
      'section[data-dock-request="left"][data-open="true"]',
      'section[data-dock-request="right"][data-open="true"]',
      '[data-lumiverse-module="portrait_dock"]',
      '[data-surface-id="portrait_dock.workspace"]',
      ".portrait-dock",
    ]);

    if (dock) {
      checkSurfacePresence("Portrait Dock surface is locatable", dock);
      const attributeRows = [
        "data-mode",
        "data-dock-request",
        "data-open",
        "data-pinned",
      ].map((name) => ({ attribute: name, value: attr(dock, name) }));
      safeTable(attributeRows);
      const handles = descendantsMatching(dock, [
        '[data-resize-handle="n"]',
        '[data-resize-handle="ne"]',
        '[data-resize-handle="e"]',
        '[data-resize-handle="se"]',
        '[data-resize-handle="s"]',
        '[data-resize-handle="sw"]',
        '[data-resize-handle="w"]',
        '[data-resize-handle="nw"]',
        ".resizeHandle",
      ]);
      const directions = new Set(
        handles.map((handle) => attr(handle, "data-resize-handle")).filter(Boolean),
      );
      const collapsed = handles.filter((handle) => {
        const handleRect = readRect(handle);
        return !handleRect || handleRect.width === 0 || handleRect.height === 0;
      });
      if (!isRendered(dock)) {
        info("Portrait Dock has eight usable resize directions", "Dock root is present but not rendered; resize controls are not applicable");
      } else if (directions.size >= 8 && !collapsed.length) {
        pass("Portrait Dock has eight usable resize directions", Array.from(directions).join(", "));
      } else if (!handles.length) {
        warn("Portrait Dock has eight usable resize directions", "No resize handles are mounted");
      } else {
        warn("Portrait Dock has eight usable resize directions", "Directions: " + directions.size + "; collapsed: " + collapsed.length);
      }

      const controls = firstMatch([
        ".portraitDockControls",
        '[role="toolbar"][aria-label="Portrait dock controls"]',
      ], dock);
      if (controls) pass("Portrait Dock hover controls are discoverable", elementLabel(controls));
      else warn("Portrait Dock hover controls are discoverable", "No portraitDockControls toolbar found");

      const buttons = descendantsMatching(dock, ["button"]);
      const pin = buttons.find((button) => /pin/i.test(attr(button, "aria-label") || attr(button, "title") || textOf(button)));
      const aspect = buttons.find((button) => /aspect|ratio|lock/i.test(attr(button, "aria-label") || attr(button, "title") || textOf(button)));
      const sides = buttons.filter((button) => /left|right|side/i.test(attr(button, "aria-label") || attr(button, "title") || textOf(button)));
      if (pin) pass("Portrait Dock pin control is discoverable", elementLabel(pin));
      else warn("Portrait Dock pin control is discoverable", "No pin button found");
      if (aspect) pass("Portrait Dock aspect-ratio control is discoverable", elementLabel(aspect));
      else warn("Portrait Dock aspect-ratio control is discoverable", "No aspect/ratio lock button found");
      if (sides.length >= 2) pass("Portrait Dock side-switch controls are discoverable", sides.length + " side-related buttons");
      else if (!isRendered(dock)) info("Portrait Dock side-switch controls are discoverable", "Dock is not rendered; side switching is not applicable");
      else warn("Portrait Dock side-switch controls are discoverable", "Fewer than two side controls found");
    } else {
      info("Portrait Dock surface is locatable", "No open dock/floating surface is mounted on this route");
    }

    if (settings) pass("Portrait Dock settings state is readable", "portraitDockSettings is available", cloneValue(settings));
    else info("Portrait Dock settings state is readable", "portraitDockSettings is not exposed on this page");
    if (floatingAvatar !== undefined) pass("Portrait Dock floating-avatar state is readable", "floatingAvatar is available", cloneValue(floatingAvatar));
    else info("Portrait Dock floating-avatar state is readable", "floatingAvatar is not exposed on this page");

    const characterDisplay = moduleRoots("character_display");
    const characterCards = allMatches([
      '[data-character-id]',
      '[data-lumiverse-module="character_display"]',
    ]);
    if (characterDisplay.length || characterCards.length) {
      pass(
        "Character display badges are discoverable",
        (characterDisplay.length || characterCards.length) + " character display/card node(s)",
      );
    } else {
      info("Character display badges are discoverable", "No character display marker is mounted on this route");
    }
  }

  async function suiteMessageEditing() {
    const messageList = firstMatch([
      '[data-component="MessageList"]',
      ".messageList",
    ]);
    const messageRows = allMatches([
      '[data-item-type="message"]',
      "[data-message-id]",
    ], messageList || doc);
    if (messageList) {
      checkSurfacePresence("Message List surface is locatable", messageList);
    } else {
      warn("Message List surface is locatable", "No MessageList root is mounted");
    }

    if (messageRows.length) {
      pass("Message rows are inspectable", messageRows.length + " message row(s)");
      const actionTokens = {
        copy: 0,
        edit: 0,
        delete: 0,
        hidden: 0,
        context: 0,
        promptBreakdown: 0,
      };
      const actionRows = [];
      for (const row of messageRows) {
        const controls = descendantsMatching(row, ["button", "[role=\"button\"]"]);
        for (const control of controls) {
          const token = (
            (attr(control, "aria-label") || "") +
            " " +
            (attr(control, "title") || "") +
            " " +
            (attr(control, "data-action-id") || "") +
            " " +
            textOf(control)
          ).toLowerCase();
          for (const kind of Object.keys(actionTokens)) {
            const pattern =
              kind === "promptBreakdown"
                ? /prompt.?breakdown|breakdown/
                : new RegExp(kind);
            if (pattern.test(token)) actionTokens[kind] += 1;
          }
        }
        actionRows.push({
          messageId: attr(row, "data-message-id") || "unknown",
          controls: controls.length,
        });
      }
      safeTable(actionRows.slice(0, 100));
      for (const [kind, count] of Object.entries(actionTokens)) {
        if (count) pass("Message action: " + kind, count + " matching control(s)");
        else info("Message action: " + kind, "No matching control is visible in current message rows");
      }
    } else {
      info("Message rows are inspectable", "No message rows are currently rendered on this route");
    }

    const explicitEditRoot = firstMatch([
      '[data-component="MessageEditArea"]',
      ".editArea",
    ]);
    const contentAnywhere = firstMatch(['textarea[name="message-edit-content"]'], doc);
    const inferredEditRoot = contentAnywhere
      ? contentAnywhere.closest('[data-component="MessageEditArea"], [class*="editArea"]')
      : null;
    const editArea =
      inferredEditRoot ||
      (explicitEditRoot &&
      (!contentAnywhere || explicitEditRoot.contains(contentAnywhere))
        ? explicitEditRoot
        : null);
    const editScope = editArea || doc;
    const content = firstMatch(['textarea[name="message-edit-content"]'], editScope) || contentAnywhere;
    const reasoning = firstMatch(['textarea[name="message-edit-reasoning"]'], editScope);
    const save = firstMatch([".editSaveBtn", 'button[aria-label="Save"]'], editScope);
    const cancel = firstMatch([".editCancelBtn", 'button[aria-label="Cancel"]'], editScope);
    const expand = firstMatch([".expandBtn"], editScope);

    if (!editArea && !content && !reasoning && !save && !cancel && !expand) {
      info("MessageEditArea surface is locatable", "No edit area is open; message editing was not activated");
      return;
    }
    if (editArea && !content && !reasoning && !save && !cancel && !expand) {
        info(
          "MessageEditArea surface is locatable",
          "A container-like marker exists without active editor fields; editing was not activated",
        { element: elementLabel(editArea) },
      );
      return;
    }
    checkSurfacePresence(
      "MessageEditArea surface is locatable",
      editArea || content || reasoning || save || cancel || expand,
    );

    if (content) pass("MessageEditArea content textarea is present", attr(content, "name"));
    else fail("MessageEditArea content textarea is present", "textarea[name=message-edit-content] is missing");
    if (reasoning) pass("MessageEditArea reasoning textarea is present", attr(reasoning, "name"));
    else info("MessageEditArea reasoning textarea is present", "Reasoning input is optional or not mounted");
    if (save) pass("MessageEditArea Save action is present", elementLabel(save));
    else fail("MessageEditArea Save action is present", "Save button is missing from the open editor");
    if (cancel) pass("MessageEditArea Cancel action is present", elementLabel(cancel));
    else fail("MessageEditArea Cancel action is present", "Cancel button is missing from the open editor");
    if (expand) pass("MessageEditArea expand action is present", elementLabel(expand));
    else info("MessageEditArea expand action is present", "Fullscreen expand control is not mounted");

    const editAndSend = descendantsMatching(editScope, ["button"]).find((button) =>
      /edit\s+and\s+send/i.test(textOf(button) + " " + (attr(button, "aria-label") || "")),
    );
    if (editAndSend) pass("MessageEditArea Edit and Send action is discoverable", elementLabel(editAndSend));
    else info("MessageEditArea Edit and Send action is discoverable", "No Edit and Send control is mounted");
  }

  function settingsTabDescriptor(button) {
    return (
      (attr(button, "data-tab") || "") +
      " " +
      (attr(button, "data-settings-tab-id") || "") +
      " " +
      (attr(button, "aria-controls") || "") +
      " " +
      textOf(button)
    ).toLowerCase();
  }

  async function suiteSettingsAndEmbeddings() {
    const state = storeState();
    const modal = firstMatch([
      '[data-component="SettingsModal"]',
      ".settingsModal",
    ]);
    const modalOpen = findStateValue(state, "settingsModalOpen");
    const activeView = findStateValue(state, "settingsActiveView");

    if (modal) {
      checkSurfacePresence("Settings Modal is locatable", modal);
    } else if (modalOpen) {
      warn("Settings Modal is locatable", "Store says it is open but no modal DOM root was found");
    } else {
      info("Settings Modal is locatable", "Settings modal is closed on the current route");
    }

    if (modalOpen === true || modal) {
      pass("Settings modal state is readable", "settingsModalOpen=" + String(modalOpen), {
        settingsModalOpen: modalOpen,
        settingsActiveView: activeView,
      });
    } else {
      info("Settings modal state is readable", "settingsModalOpen is unavailable or false");
    }

    const tabRoot = modal || doc;
    const tabButtons = allMatches([
      ".settingsTabs button",
      '[role="tab"]',
    ], tabRoot);
    const requiredTabs = ["display", "embeddings", "productivity", "memory-cortex"];
    const tabRows = requiredTabs.map((tab) => {
      const matches = tabButtons.filter((button) => settingsTabDescriptor(button).includes(tab));
      return {
        tab,
        present: matches.length > 0,
        active: matches.some(
          (button) =>
            attr(button, "aria-selected") === "true" ||
            button.classList.contains("active") ||
            button.classList.contains("selected"),
        ),
      };
    });
    safeTable(tabRows);
    for (const row of tabRows) {
      if (row.present) pass("Settings tab is accessible: " + row.tab, row.active ? "present and active" : "present");
      else info("Settings tab is accessible: " + row.tab, "Tab is not rendered while the settings modal is closed");
    }

    const embeddingsRoot = firstMatch([
      '[data-settings-tab-id="embeddings"]',
      '[data-component="EmbeddingsSettings"]',
      ".embeddingsSettings",
    ], tabRoot);
    const searchRoot = embeddingsRoot || tabRoot;
    const provider = firstMatch(["select", '[name*="provider" i]', '[id*="provider" i]'], searchRoot);
    const apiUrl = firstMatch([
      'input[type="url"]',
      'input[name*="url" i]',
      'input[id*="url" i]',
      'input[name*="api" i]',
      'input[id*="api" i]',
    ], searchRoot);
    const modelCombobox = firstMatch([
      '[data-component="ModelCombobox"]',
      '[role="combobox"]',
      'input[name*="model" i]',
    ], searchRoot);
    const testConnection = descendantsMatching(searchRoot, ["button"]).find((button) =>
      /test|connection|validate|check/i.test(
        (attr(button, "aria-label") || "") + " " + (attr(button, "title") || "") + " " + textOf(button),
      ),
    );
    const topK = firstMatch([
      'input[name="retrieval_top_k"]',
      'input[id="retrieval_top_k"]',
      'input[name*="top.?k" i]',
      'input[id*="top.?k" i]',
      'input[type="range"]',
    ], searchRoot);

    const embeddingRows = [
      { control: "provider dropdown", present: Boolean(provider), element: provider && elementLabel(provider) },
      { control: "API URL input", present: Boolean(apiUrl), element: apiUrl && elementLabel(apiUrl) },
      { control: "Model combobox", present: Boolean(modelCombobox), element: modelCombobox && elementLabel(modelCombobox) },
      { control: "test configuration button", present: Boolean(testConnection), element: testConnection && elementLabel(testConnection) },
      { control: "retrieval_top_k control", present: Boolean(topK), element: topK && elementLabel(topK) },
    ];
    safeTable(embeddingRows);
    for (const row of embeddingRows) {
      if (row.present) pass("Embeddings control: " + row.control, row.element);
      else info("Embeddings control: " + row.control, "Control is not visible in the current settings view");
    }

    const memoryRoot = firstMatch([
      '[data-component="MemoryCortexSettings"]',
      ".memoryCortexSettings",
      '[data-settings-tab-id="memory-cortex"]',
    ], tabRoot);
    if (memoryRoot) {
      const connectionSelect = firstMatch([
        '[data-component="ConnectionSelect"]',
        "select",
        '[role="combobox"]',
      ], memoryRoot);
      const fallback = descendantsMatching(memoryRoot, ["input", "button", "label"]).find((element) =>
        /fallback|provider/i.test(
          (attr(element, "aria-label") || "") + " " + (attr(element, "title") || "") + " " + textOf(element),
        ),
      );
      const presets = descendantsMatching(memoryRoot, ["button"]).filter((button) =>
        /simple|standard|advanced/i.test(textOf(button)),
      );
      if (connectionSelect) pass("Memory Cortex connection profile selector is present", elementLabel(connectionSelect));
      else warn("Memory Cortex connection profile selector is present", "ConnectionSelect/combobox is missing");
      if (fallback) pass("Memory Cortex fallback-provider control is present", elementLabel(fallback));
      else warn("Memory Cortex fallback-provider control is present", "No fallback/provider toggle is visible");
      if (presets.length >= 3) pass("Memory Cortex preset buttons are present", presets.map(textOf).join(", "));
      else warn("Memory Cortex preset buttons are present", presets.length + " preset button(s) found");
    } else {
      info("Memory Cortex settings surface is locatable", "Memory Cortex settings are not mounted while settings are closed");
    }
  }

  const SNAPSHOT_SURFACES = Object.freeze({
    QuickToolbar: [
      '[data-component="QuickToolbar"]',
      ".lumiverse-quick-toolbar",
      'nav[aria-label="Quick access toolbar"]',
    ],
    ConnectionsPicker: [
      '[data-component="ConnectionsPicker"]',
      ".connectionsPicker",
      ".picker[class*=\"density\"]",
    ],
    LoreIndicator: [
      '[data-lumiverse-module="lore_indicator"]',
      '[data-surface-id="activated_lore.indicator"]',
      '[data-variant="v2-compact"]',
      '[data-variant="v4-bottom-strip"]',
      '[data-variant="v5-command-palette"]',
    ],
    PortraitDock: [
      '[data-lumiverse-module="portrait_dock"]',
      '[data-surface-id="portrait_dock.workspace"]',
      ".portrait-dock",
      'section[data-mode="floating"]',
      'section[data-mode="docked"]',
    ],
    InputArea: [
      '[data-component="InputArea"]',
      '[data-component="MessageInput"]',
      '[data-component="MessageComposer"]',
      ".inputArea",
      'textarea[name="message"]',
    ],
    MessageList: [
      '[data-component="MessageList"]',
      ".messageList",
    ],
  });

  function snapshotNode(element, selector, index) {
    const prefixes = [
      "--quick-toolbar-",
      "--connections-",
      "--lore-",
      "--portrait-",
      "--lumiverse-",
    ];
    return {
      selector,
      index,
      tag: element && element.tagName ? element.tagName.toLowerCase() : null,
      label: elementLabel(element),
      connected: Boolean(element && element.isConnected !== false),
      visible: isRendered(element),
      rect: readRect(element),
      cssVars: readCssVars(element, prefixes),
      styles: stylesSummary(element),
      attributes: element
        ? {
            id: attr(element, "id"),
            dataComponent: attr(element, "data-component"),
            dataModule: attr(element, "data-lumiverse-module"),
            dataSurface: attr(element, "data-surface-id"),
            dataVariant: attr(element, "data-variant"),
            dataMode: attr(element, "data-mode"),
            dataOpen: attr(element, "data-open"),
          }
        : {},
    };
  }

  function captureDomSnapshot() {
    const dom = {};
    const surfaces = {};
    for (const [name, selectors] of Object.entries(SNAPSHOT_SURFACES)) {
      const seen = new Set();
      const entries = [];
      for (const selector of selectors) {
        for (const element of queryAll(selector)) {
          if (seen.has(element)) continue;
          seen.add(element);
          entries.push(snapshotNode(element, selector, entries.length));
        }
      }
      surfaces[name] = entries;
      entries.forEach((entry, index) => {
        dom[name + "#" + index] = entry;
      });
    }

    const modules = extensionRoots();
    modules.slice(0, 500).forEach((element, index) => {
      const moduleId =
        attr(element, "data-lumiverse-module") ||
        attr(element, "data-module-id") ||
        attr(element, "data-spindle-module") ||
        attr(element, "data-spindle-ext") ||
        "extension-root";
      const key = "module:" + moduleId + "#" + index;
      dom[key] = snapshotNode(element, "[data-lumiverse-module]/extension-root", index);
    });
    return { surfaces, dom };
  }

  function captureSnapshotData(label) {
    const resolved = resolveStore();
    const domSnapshot = captureDomSnapshot();
    const aggregateVars = {};
    for (const node of Object.values(domSnapshot.dom)) {
      for (const [name, value] of Object.entries(node.cssVars || {})) {
        if (aggregateVars[name] === undefined) aggregateVars[name] = value;
      }
    }
    return {
      version: 1,
      label,
      capturedAt: new Date().toISOString(),
      timestamp: Date.now(),
      viewport: {
        width: Number(host.innerWidth) || null,
        height: Number(host.innerHeight) || null,
        devicePixelRatio: Number(host.devicePixelRatio) || 1,
      },
      source: resolved ? resolved.source : null,
      storeReadable: Boolean(resolved && resolved.state),
      surfaces: domSnapshot.surfaces,
      dom: domSnapshot.dom,
      computedVars: aggregateVars,
      storeSlices: stateSlicesForSnapshot(resolved && resolved.state),
    };
  }

  function snapshotSize(snapshot) {
    try {
      return JSON.stringify(snapshot).length;
    } catch {
      return 0;
    }
  }

  function captureSnapshot(label = "baseline") {
    const safeLabel = String(label || "baseline");
    const snapshot = captureSnapshotData(safeLabel);
    snapshotStore.baselines[safeLabel] = snapshot;
    snapshotStore.latest = snapshot;
    snapshotStore.history.push(snapshot);
    if (snapshotStore.history.length > 25) snapshotStore.history.splice(0, snapshotStore.history.length - 25);
    safeTable([
      {
        label: safeLabel,
        timestamp: snapshot.capturedAt,
        surfaces: Object.values(snapshot.surfaces).reduce((sum, entries) => sum + entries.length, 0),
        domNodes: Object.keys(snapshot.dom).length,
        storeReadable: snapshot.storeReadable,
        bytes: snapshotSize(snapshot),
      },
    ]);
    info("UI snapshot captured", safeLabel + " is available at window.__LUMIVERSE_UI_SNAPSHOT__.baselines." + safeLabel);
    return snapshot;
  }

  function valuesEqual(left, right) {
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch {
      return left === right;
    }
  }

  function deepChangeRows(before, after, path, rows, limit = 300) {
    if (rows.length >= limit || valuesEqual(before, after)) return;
    const beforeObject = before && typeof before === "object";
    const afterObject = after && typeof after === "object";
    if (!beforeObject || !afterObject) {
      rows.push({
        path: path || "(root)",
        before: formatValue(before),
        after: formatValue(after),
      });
      return;
    }
    const beforeKeys = new Set(Object.keys(before));
    const afterKeys = new Set(Object.keys(after));
    for (const key of beforeKeys) {
      const childPath = path ? path + "." + key : key;
      if (!afterKeys.has(key)) {
        rows.push({ path: childPath, before: formatValue(before[key]), after: "[deleted]" });
      } else {
        deepChangeRows(before[key], after[key], childPath, rows, limit);
      }
      if (rows.length >= limit) return;
    }
    for (const key of afterKeys) {
      if (!beforeKeys.has(key)) {
        const childPath = path ? path + "." + key : key;
        rows.push({ path: childPath, before: "[added]", after: formatValue(after[key]) });
      }
      if (rows.length >= limit) return;
    }
  }

  function diffSnapshot(baselineKey) {
    const baseline =
      baselineKey && typeof baselineKey === "object"
        ? baselineKey
        : snapshotStore.baselines[String(baselineKey)];
    if (!baseline) {
      warn("Snapshot baseline is available", "No baseline found for " + String(baselineKey));
      return null;
    }

    const current = captureSnapshotData("current-diff");
    const baseDom = baseline.dom || {};
    const currentDom = current.dom || {};
    const additions = Object.keys(currentDom)
      .filter((key) => !Object.prototype.hasOwnProperty.call(baseDom, key))
      .map((key) => ({ category: "DOM addition", path: key, before: "[missing]", after: currentDom[key].label }));
    const deletions = Object.keys(baseDom)
      .filter((key) => !Object.prototype.hasOwnProperty.call(currentDom, key))
      .map((key) => ({ category: "DOM deletion", path: key, before: baseDom[key].label, after: "[missing]" }));
    const dimensionChanges = [];
    const cssChanges = [];

    for (const key of Object.keys(baseDom)) {
      if (!currentDom[key]) continue;
      const beforeRect = baseDom[key].rect;
      const afterRect = currentDom[key].rect;
      if (beforeRect && afterRect) {
        for (const field of ["x", "y", "width", "height"]) {
          const beforeValue = Number(beforeRect[field]);
          const afterValue = Number(afterRect[field]);
          if (
            Number.isFinite(beforeValue) &&
            Number.isFinite(afterValue) &&
            Math.abs(afterValue - beforeValue) > 1
          ) {
            dimensionChanges.push({
              category: "Geometry change",
              path: key + ".rect." + field,
              before: beforeValue,
              after: afterValue,
              delta: Math.round((afterValue - beforeValue) * 100) / 100,
            });
          }
        }
      }
      const beforeVars = baseDom[key].cssVars || {};
      const afterVars = currentDom[key].cssVars || {};
      const varNames = new Set(Object.keys(beforeVars).concat(Object.keys(afterVars)));
      for (const name of varNames) {
        if (!valuesEqual(beforeVars[name], afterVars[name])) {
          cssChanges.push({
            category: "CSS variable change",
            path: key + "." + name,
            before: formatValue(beforeVars[name]),
            after: formatValue(afterVars[name]),
          });
        }
      }
    }

    const stateChanges = [];
    deepChangeRows(
      baseline.storeSlices || {},
      current.storeSlices || {},
      "storeSlices",
      stateChanges,
    );

    const rows = additions
      .concat(deletions, dimensionChanges, cssChanges, stateChanges.map((row) => ({
        category: "State change",
        ...row,
      })));
    if (rows.length) {
      safeTable(rows.slice(0, 500));
      info("Snapshot diff completed", rows.length + " change(s) found", {
        additions: additions.length,
        deletions: deletions.length,
        dimensionChanges: dimensionChanges.length,
        cssChanges: cssChanges.length,
        stateChanges: stateChanges.length,
      });
    } else {
      info("Snapshot diff completed", "No DOM, geometry, CSS-variable, or selected-state changes found");
    }

    return {
      baselineKey: typeof baselineKey === "string" ? baselineKey : baseline.label || null,
      baseline,
      current,
      additions,
      deletions,
      dimensionChanges,
      cssChanges,
      stateChanges,
      changed: rows.length > 0,
    };
  }

  function normalizeHighlightColor(color) {
    const candidate = String(color || "#ff3b30").trim();
    return /^[#a-zA-Z0-9(),.%\s-]+$/.test(candidate) ? candidate : "#ff3b30";
  }

  function highlightElement(selector, color = "#ff3b30") {
    const elements = queryAll(selector);
    const borderColor = normalizeHighlightColor(color);
    if (!doc.body) {
      warn("Highlight target is available", "document.body is unavailable");
      return [];
    }
    const overlays = [];
    elements.slice(0, 100).forEach((element, index) => {
      const rect = readRect(element);
      if (!rect) return;
      const overlay = doc.createElement("div");
      overlay.setAttribute("data-lumiverse-test-highlight", "true");
      overlay.style.position = "fixed";
      overlay.style.left = rect.left + "px";
      overlay.style.top = rect.top + "px";
      overlay.style.width = Math.max(0, rect.width) + "px";
      overlay.style.height = Math.max(0, rect.height) + "px";
      overlay.style.boxSizing = "border-box";
      overlay.style.border = "2px solid " + borderColor;
      overlay.style.outline = "1px solid rgba(255,255,255,.7)";
      overlay.style.pointerEvents = "none";
      overlay.style.zIndex = "2147483646";
      const badge = doc.createElement("span");
      badge.textContent = "Lumiverse test #" + (index + 1) + " " + elementLabel(element);
      badge.style.position = "absolute";
      badge.style.left = "0";
      badge.style.top = "0";
      badge.style.transform = "translateY(-100%)";
      badge.style.background = borderColor;
      badge.style.color = "#111";
      badge.style.font = "600 11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace";
      badge.style.padding = "2px 4px";
      badge.style.whiteSpace = "nowrap";
      badge.style.pointerEvents = "none";
      overlay.appendChild(badge);
      doc.body.appendChild(overlay);
      highlightOverlays.add(overlay);
      overlays.push(overlay);
    });
    info(
      "Highlight applied",
      elements.length + " match(es) found; " + overlays.length + " overlay(s) drawn",
      { selector, color: borderColor },
    );
    return overlays;
  }

  function clearHighlights() {
    let removed = 0;
    for (const overlay of highlightOverlays) {
      if (overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
        removed += 1;
      }
    }
    highlightOverlays.clear();
    queryAll('[data-lumiverse-test-highlight="true"]').forEach((element) => {
      if (element.parentNode) {
        element.parentNode.removeChild(element);
        removed += 1;
      }
    });
    info("Highlights cleared", removed + " overlay(s) removed");
    return removed;
  }

  function waitFor(milliseconds = 100) {
    return new Promise((resolve) => host.setTimeout(resolve, milliseconds));
  }

  function firstRendered(selectors, root = doc) {
    return allMatches(selectors, root).find((element) => isRendered(element)) || null;
  }

  function firstInteractive(selectors, root = doc) {
    return allMatches(selectors, root).find((element) =>
      isRendered(element) &&
      element.disabled !== true &&
      attr(element, "aria-disabled") !== "true",
    ) || null;
  }

  async function waitForRenderedSurface(selectors, timeout = 900) {
    const started = perf.now();
    let surface = firstRendered(selectors);
    while (!surface && perf.now() - started < timeout) {
      await waitFor(60);
      surface = firstRendered(selectors);
    }
    return surface;
  }

  async function waitForSurfaceToClose(selectors, timeout = 900) {
    const started = perf.now();
    while (firstRendered(selectors) && perf.now() - started < timeout) {
      await waitFor(60);
    }
    return !firstRendered(selectors);
  }

  function clickSafeControl(element) {
    if (
      !element ||
      typeof element.click !== "function" ||
      element.disabled === true ||
      attr(element, "aria-disabled") === "true"
    ) {
      return false;
    }
    try {
      if (typeof element.focus === "function") element.focus({ preventScroll: true });
      element.click();
      return true;
    } catch {
      return false;
    }
  }

  function sendEscape() {
    try {
      doc.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  function measureSurface(label, element) {
    const rect = readRect(element);
    const style = stylesSummary(element);
    const computed = computedStyle(element);
    return {
      label,
      element: elementLabel(element),
      tag: element && element.tagName ? element.tagName.toLowerCase() : null,
      role: attr(element, "role"),
      ariaLabel: attr(element, "aria-label"),
      variant: attr(element, "data-variant"),
      mode: attr(element, "data-mode"),
      rect,
      width: rect && rect.width,
      height: rect && rect.height,
      top: rect && rect.top,
      left: rect && rect.left,
      right: rect && rect.right,
      bottom: rect && rect.bottom,
      visible: isRendered(element),
      clientWidth: Number(element && element.clientWidth) || 0,
      clientHeight: Number(element && element.clientHeight) || 0,
      scrollWidth: Number(element && element.scrollWidth) || 0,
      scrollHeight: Number(element && element.scrollHeight) || 0,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      position: style.position,
      zIndex: computed ? computed.zIndex : null,
      childCount: element && element.children ? element.children.length : 0,
      buttonCount: element ? queryAll("button", element).length : 0,
      inputCount: element ? queryAll("input, textarea, select", element).length : 0,
      cssVars: readCssVars(element, [
        "--quick-toolbar-",
        "--connections-",
        "--lore-",
        "--portrait-",
        "--lumiverse-",
      ]),
    };
  }

  function logSurfaceMeasurement(label, element) {
    const metrics = measureSurface(label, element);
    safeTable([metrics]);
    info(
      label + " dimensions captured",
      metrics.width + "px × " + metrics.height + "px; " +
        metrics.buttonCount + " button(s), " + metrics.inputCount + " input(s)",
      metrics,
    );
    return metrics;
  }

  async function closeTemporarySurface(options) {
    const {
      surfaceSelectors,
      closeSelectors = [],
      opener = null,
    } = options;
    sendEscape();
    await waitFor(100);

    let surface = firstRendered(surfaceSelectors);
    if (surface) {
      const closeControl = firstInteractive(closeSelectors, surface) ||
        firstInteractive(closeSelectors, doc);
      if (closeControl && closeControl !== opener) {
        clickSafeControl(closeControl);
        await waitFor(120);
      }
    }

    surface = firstRendered(surfaceSelectors);
    if (surface && opener && opener !== surface) {
      clickSafeControl(opener);
      await waitFor(120);
    }
    sendEscape();
    await waitFor(100);
    return waitForSurfaceToClose(surfaceSelectors);
  }

  function compareTemporaryRestoration(label, before, after, surfaceSelectors) {
    const lingeringSurface = firstRendered(surfaceSelectors);
    const stateChanges = [];
    deepChangeRows(
      before && before.storeSlices ? before.storeSlices : {},
      after && after.storeSlices ? after.storeSlices : {},
      "storeSlices",
      stateChanges,
      100,
    );
    if (!lingeringSurface && !stateChanges.length) {
      pass(
        label + " restored its pre-probe state",
        "Surface closed and selected Zustand slices are unchanged",
      );
    } else {
      warn(
        label + " restored its pre-probe state",
        lingeringSurface
          ? "Surface is still open after cleanup"
          : "Selected store state changed during the temporary probe",
        {
          lingeringSurface: Boolean(lingeringSurface),
          stateChanges: stateChanges.slice(0, 20),
        },
      );
    }
  }

  async function temporarySurfaceProbe(options) {
    const {
      name,
      openerSelectors,
      surfaceSelectors,
      closeSelectors = [],
      inspect,
      cleanup,
    } = options;
    const before = captureSnapshotData("probe-before-" + name);
    const alreadyOpen = firstRendered(surfaceSelectors);
    if (alreadyOpen) {
      info(name + " probe", "Surface is already open; it will be measured without closing the user's surface");
      logSurfaceMeasurement(name, alreadyOpen);
      if (inspect) await inspect(alreadyOpen);
      return { status: "already-open", surface: alreadyOpen };
    }

    const opener = firstInteractive(openerSelectors);
    if (!opener) {
      info(name + " probe", "No safe opener is mounted on this route; probe skipped");
      return { status: "skipped" };
    }

    const clicked = clickSafeControl(opener);
    if (!clicked) {
      fail(name + " opener is clickable", "The safe opener was found but could not be activated", {
        opener: elementLabel(opener),
      });
      return { status: "click-failed" };
    }

    let openedSurface = null;
    try {
      openedSurface = await waitForRenderedSurface(surfaceSelectors);
      if (!openedSurface) {
        warn(name + " surface opens temporarily", "Opener was activated but no rendered surface appeared", {
          opener: elementLabel(opener),
        });
      } else {
        pass(name + " surface opens temporarily", elementLabel(openedSurface));
        logSurfaceMeasurement(name, openedSurface);
        if (inspect) await inspect(openedSurface);
      }
    } catch (error) {
      fail(
        name + " interactive inspection completes",
        error && error.stack ? error.stack : String(error),
      );
    } finally {
      try {
        if (cleanup) await cleanup(openedSurface);
      } catch (error) {
        warn(
          name + " temporary cleanup callback completes",
          error && error.message ? error.message : String(error),
        );
      }
      const closed = await closeTemporarySurface({
        surfaceSelectors,
        closeSelectors,
        opener,
      });
      const after = captureSnapshotData("probe-after-" + name);
      if (closed) {
        compareTemporaryRestoration(name, before, after, surfaceSelectors);
      } else {
        warn(name + " surface closes automatically", "The surface remained rendered after Escape/close cleanup");
      }
    }
    return { status: openedSurface ? "opened-and-closed" : "opened-without-surface", surface: openedSurface };
  }

  async function inspectQuickToolbarOverflow(surface) {
    const search = firstMatch([".overflowSearch input", 'input[type="search"]'], surface);
    const rows = descendantsMatching(surface, [".overflowRow", '[class*="overflowRow"]']);
    const pins = descendantsMatching(surface, [".overflowPin", '[class*="overflowPin"]']);
    if (search && rows.length) {
      pass("Quick Toolbar overflow contains search and rows", rows.length + " row(s), search input present", {
        searchPlaceholder: attr(search, "placeholder"),
        rowCount: rows.length,
        pinCount: pins.length,
      });
    } else {
      warn("Quick Toolbar overflow contains search and rows", "Search or overflow rows are missing", {
        hasSearch: Boolean(search),
        rowCount: rows.length,
        pinCount: pins.length,
      });
    }
  }

  async function inspectConnectionsPicker(surface) {
    const tabs = descendantsMatching(surface, [
      ".providerTabs button",
      'button[data-tab="favorites"]',
      'button[data-tab="recent"]',
      'button[data-tab="all"]',
      'button[data-tab^="tag:"]',
    ]);
    const models = descendantsMatching(surface, [
      ".modelGridButton",
      '[class*="modelGridButton"]',
    ]);
    const activeModels = models.filter((button) =>
      button.classList.contains("modelGridButtonActive") ||
      attr(button, "aria-selected") === "true",
    );
    if (tabs.length) pass("Connections Picker temporary probe sees provider tabs", tabs.length + " tab(s)");
    else warn("Connections Picker temporary probe sees provider tabs", "No provider tabs were rendered");
    if (models.length) pass("Connections Picker temporary probe sees model buttons", models.length + " model button(s)", {
      activeModels: activeModels.length,
    });
    else info("Connections Picker temporary probe sees model buttons", "No models are available for the current profile");
  }

  async function inspectLorePopover(surface) {
    const items = descendantsMatching(surface, [
      ".stripItem",
      '[data-activation]',
      '[class*="lore"]',
    ]);
    if (items.length) {
      pass("Lore Indicator temporary probe sees lore details", items.length + " detail node(s)");
    } else {
      info("Lore Indicator temporary probe sees lore details", "Popover is open but has no detail rows");
    }
  }

  async function inspectMessageEditor(surface) {
    const surfaceIsTextarea =
      surface &&
      typeof surface.matches === "function" &&
      surface.matches('textarea[name="message-edit-content"], textarea[name="message-edit-reasoning"]');
    const scope = surfaceIsTextarea ? doc : surface || doc;
    const content = firstMatch(['textarea[name="message-edit-content"]'], scope);
    const reasoning = firstMatch(['textarea[name="message-edit-reasoning"]'], scope);
    const save = firstMatch([".editSaveBtn"], scope);
    const cancel = firstMatch([".editCancelBtn"], scope);
    const expand = firstMatch([".expandBtn"], scope);
    safeTable([{
      content: Boolean(content),
      reasoning: Boolean(reasoning),
      save: Boolean(save),
      cancel: Boolean(cancel),
      expand: Boolean(expand),
      contentRect: content && readRect(content),
      reasoningRect: reasoning && readRect(reasoning),
    }]);
    if (content && save && cancel) {
      pass("Message editor temporary probe sees safe edit controls", "Content, Save, and Cancel controls are present");
    } else {
      warn("Message editor temporary probe sees safe edit controls", "One or more expected edit controls are missing");
    }
  }

  async function inspectLorebookWorkspace(surface) {
    const rows = descendantsMatching(surface, [
      "[data-world-book-entry-row]",
      '[data-lumiverse-lorebook-table]',
      '[data-lumiverse-lorebook-editor]',
    ]);
    const inputs = descendantsMatching(surface, ["input", "textarea", "select"]);
    pass(
      "Lorebook Workspace temporary probe captured editor geometry",
      rows.length + " table/editor node(s), " + inputs.length + " input control(s)",
    );
  }

  async function inspectPortraitDock(surface) {
    const handles = descendantsMatching(surface, [
      '[data-resize-handle]',
      '[class*="resizeHandle"]',
    ]);
    const controls = descendantsMatching(surface, [
      ".portraitDockControls",
      '[role="toolbar"]',
      '[class*="controls"]',
    ]);
    safeTable([{
      resizeHandles: handles.length,
      controls: controls.length,
      dockRequest: attr(surface, "data-dock-request"),
      open: attr(surface, "data-open"),
      pinned: attr(surface, "data-pinned"),
    }]);
    if (handles.length) pass("Portrait Dock temporary probe captured resize controls", handles.length + " handle(s)");
    else info("Portrait Dock temporary probe captured resize controls", "No resize handles are visible in the opened mode");
  }

  async function inspectSettingsModal(surface) {
    const tabs = allMatches([".settingsTabs button", '[role="tab"]'], surface);
    const originalTab = tabs.find((button) =>
      attr(button, "aria-selected") === "true" ||
      button.classList.contains("active") ||
      button.classList.contains("selected"),
    );
    const originalDescriptor = originalTab ? settingsTabDescriptor(originalTab) : "";
    const requestedTabs = ["embeddings", "memory-cortex"];
    for (const requested of requestedTabs) {
      const tab = tabs.find((button) => settingsTabDescriptor(button).includes(requested));
      if (!tab) {
        info("Settings temporary probe tab: " + requested, "Tab is not mounted");
        continue;
      }
      if (clickSafeControl(tab)) {
        await waitFor(100);
        pass("Settings temporary probe tab: " + requested, "Tab opened for read-only inspection");
        logSurfaceMeasurement("Settings " + requested, surface);
      } else {
        warn("Settings temporary probe tab: " + requested, "Tab was found but could not be activated");
      }
    }
    if (originalDescriptor) {
      const restoreTab = tabs.find((button) => settingsTabDescriptor(button) === originalDescriptor);
      if (restoreTab) {
        clickSafeControl(restoreTab);
        await waitFor(80);
      }
    }
  }

  async function suiteInteractiveProbes() {
    await temporarySurfaceProbe({
      name: "Quick Toolbar overflow",
      openerSelectors: [
        "button.overflowButton",
        'button[aria-controls="quick-toolbar-overflow"]',
        'button[class*="overflowButton"]',
      ],
      surfaceSelectors: [
        '#quick-toolbar-overflow[data-side="top"]',
        '#quick-toolbar-overflow[data-side="bottom"]',
        "#quick-toolbar-overflow",
      ],
      closeSelectors: [
        'button[aria-controls="quick-toolbar-overflow"]',
        "button.overflowButton",
        'button[class*="overflowButton"]',
      ],
      inspect: inspectQuickToolbarOverflow,
    });

    await temporarySurfaceProbe({
      name: "Connections Picker",
      openerSelectors: [
        'button[data-action-id="connections"]',
        'button[data-action-id="lumiverse_suite.connections_picker.open"]',
        '[data-lumiverse-connections-launcher="true"]',
      ],
      surfaceSelectors: ['[data-component="ConnectionsPicker"]'],
      closeSelectors: ['button[title="Close connections picker"]'],
      inspect: inspectConnectionsPicker,
    });

    await temporarySurfaceProbe({
      name: "Lore Indicator compact popover",
      openerSelectors: [
        ".compactTrigger",
        '[class*="compactTrigger"]',
      ],
      surfaceSelectors: [
        ".compactPopover",
        '[class*="compactPopover"]',
      ],
      closeSelectors: [
        ".compactTrigger",
        '[class*="compactTrigger"]',
      ],
      inspect: inspectLorePopover,
    });

    await temporarySurfaceProbe({
      name: "Message editor",
      openerSelectors: [
        '.messageActions button[aria-label="Edit"]',
        'button[title="Edit message"]',
        '[data-message-id] button[aria-label="Edit"]',
        '[data-message-id] button[title="Edit message"]',
      ],
      surfaceSelectors: [
        '[data-component="MessageEditArea"]',
        '[class*="editArea"]',
        'textarea[name="message-edit-content"]',
      ],
      closeSelectors: [
        ".editCancelBtn",
        'button[aria-label="Cancel"]',
      ],
      inspect: inspectMessageEditor,
    });

    await temporarySurfaceProbe({
      name: "Settings Modal",
      openerSelectors: [
        'button[aria-label*="settings" i]',
        'button[title*="settings" i]',
        'button[data-action-id*="settings" i]',
      ],
      surfaceSelectors: [
        '[data-component="SettingsModal"]',
        ".settingsModal",
      ],
      closeSelectors: [
        'button[aria-label="Close settings"]',
        'button[title="Close settings"]',
        'button[aria-label="Close"]',
        'button[title="Close"]',
        ".closeButton",
      ],
      inspect: inspectSettingsModal,
    });

    await temporarySurfaceProbe({
      name: "Lorebook Workspace",
      openerSelectors: [
        'button[data-action-id="lumiverse_suite.lorebook.open_half"]',
        'button[data-action-id="lumiverse_suite.lorebook.open_enhanced"]',
      ],
      surfaceSelectors: [
        '[data-component="LorebookEditorWorkspace"]',
        ".lorebookEditorWorkspace",
        '[data-lumiverse-lorebook-editor]',
        '[data-surface-id="lorebook.half.workspace"]',
        '[data-surface-id="lorebook.enhanced.workspace"]',
      ],
      closeSelectors: [
        'button[aria-label="Close"]',
        'button[title="Close"]',
        'button[aria-label*="close" i]',
        'button[title*="close" i]',
      ],
      inspect: inspectLorebookWorkspace,
    });

    await temporarySurfaceProbe({
      name: "Portrait Dock",
      openerSelectors: [
        'button[data-action-id="portrait"]',
        'button[data-action-id="lumiverse_suite.portrait_dock.open"]',
        'button[aria-label="Open portrait dock"]',
        'button[title="Open portrait dock"]',
      ],
      surfaceSelectors: [
        'section[data-mode="floating"][data-open="true"]',
        'section[data-mode="docked"][data-open="true"]',
        '[data-lumiverse-module="portrait_dock"]',
        '[data-surface-id="portrait_dock.workspace"]',
        ".portrait-dock",
      ],
      closeSelectors: [
        'button[aria-label="Close portrait dock"]',
        'button[title="Close portrait dock"]',
      ],
      inspect: inspectPortraitDock,
    });
  }

  function buildResultsReport() {
    const result = runState.lastSummary || summary();
    const locationHref = host.location && host.location.href ? host.location.href : "unknown";
    const lines = [
      "Lumiverse Suite browser-console verification",
      "Generated: " + new Date().toISOString(),
      "Page: " + locationHref,
      "",
      "Summary",
      "-------",
      "Total checks: " + result.totalChecks,
      "Passed: " + result.passed,
      "Warnings: " + result.warnings,
      "Failed: " + result.failed,
      "Execution time (ms): " + result.executionTimeMs,
      "",
      "Checks",
      "------",
    ];

    if (!runState.results.length) {
      lines.push("No checks have run yet.");
    } else {
      for (const entry of runState.results) {
        const detail = String(entry.detail || "").replace(/\s+/g, " ").trim();
        lines.push(
          "[" +
            entry.status +
            "] " +
            entry.suite +
            " | " +
            entry.label +
            (detail ? " — " + detail : ""),
        );
      }
    }
    return lines.join("\n");
  }

  function setCopyButtonState(label, color) {
    if (!copyButton) return;
    copyButton.textContent = label;
    if (color) copyButton.style.background = color;
    else copyButton.style.background = "rgba(20, 24, 35, .94)";
    if (copyButtonResetTimer) host.clearTimeout(copyButtonResetTimer);
    if (label !== "Copy results") {
      copyButtonResetTimer = host.setTimeout(() => {
        if (copyButton) {
          copyButton.textContent = "Copy results";
          copyButton.style.background = "rgba(20, 24, 35, .94)";
        }
      }, 2200);
    }
  }

  function ensureCopyButton() {
    if (copyButton && copyButton.isConnected) return copyButton;
    const previous = doc.querySelector('[data-lumiverse-copy-results="true"]');
    if (previous && previous.parentNode) previous.parentNode.removeChild(previous);
    if (!doc.body) return null;

    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = "Copy results";
    button.title = "Copy the latest Lumiverse Suite verification report";
    button.setAttribute("aria-label", "Copy Lumiverse Suite verification results");
    button.setAttribute("data-lumiverse-copy-results", "true");
    button.style.position = "fixed";
    button.style.right = "16px";
    button.style.bottom = "16px";
    button.style.zIndex = "2147483645";
    button.style.padding = "9px 13px";
    button.style.border = "1px solid rgba(84, 199, 236, .8)";
    button.style.borderRadius = "7px";
    button.style.background = "rgba(20, 24, 35, .94)";
    button.style.color = "#e8f7ff";
    button.style.boxShadow = "0 4px 18px rgba(0, 0, 0, .35)";
    button.style.font = "700 12px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace";
    button.style.cursor = "pointer";
    button.style.pointerEvents = "auto";
    button.addEventListener("click", () => {
      void copyResultsToClipboard({ automatic: false });
    });
    doc.body.appendChild(button);
    copyButton = button;
    return button;
  }

  function removeCopyButton() {
    if (copyButtonResetTimer) host.clearTimeout(copyButtonResetTimer);
    copyButtonResetTimer = null;
    const buttons = queryAll('[data-lumiverse-copy-results="true"]');
    buttons.forEach((button) => {
      if (button.parentNode) button.parentNode.removeChild(button);
    });
    copyButton = null;
    logRecord("INFO", "Copy-results button removed", buttons.length + " injected control(s) removed");
    return buttons.length;
  }

  async function copyResultsToClipboard({ automatic = false } = {}) {
    const report = buildResultsReport();
    let method = null;
    try {
      if (
        host.navigator &&
        host.navigator.clipboard &&
        typeof host.navigator.clipboard.writeText === "function"
      ) {
        await host.navigator.clipboard.writeText(report);
        method = "navigator.clipboard.writeText";
      } else if (doc.body && typeof doc.execCommand === "function") {
        const textarea = doc.createElement("textarea");
        textarea.value = report;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        textarea.style.top = "0";
        doc.body.appendChild(textarea);
        textarea.select();
        const copied = doc.execCommand("copy");
        if (textarea.parentNode) textarea.parentNode.removeChild(textarea);
        if (!copied) throw new Error("document.execCommand('copy') returned false");
        method = "document.execCommand('copy')";
      } else {
        throw new Error("No supported clipboard API is available");
      }

      ensureCopyButton();
      setCopyButtonState("Copied!", COLORS.PASS);
      logRecord(
        "INFO",
        automatic ? "Automatic result copy succeeded" : "Verification results copied",
        method + "; " + report.length + " characters",
      );
      return { ok: true, method, text: report };
    } catch (error) {
      ensureCopyButton();
      setCopyButtonState("Copy failed — retry", COLORS.WARN);
      logRecord(
        "WARN",
        automatic ? "Automatic result copy was blocked" : "Verification results could not be copied",
        "Use the floating Copy results button or allow clipboard access",
        { reason: error && error.message ? error.message : String(error) },
      );
      return {
        ok: false,
        method,
        text: report,
        reason: error && error.message ? error.message : String(error),
      };
    }
  }

  async function testStoreAndExtensions() {
    return runSuite("1. Active Store & Extension Registration", suiteStoreAndExtensions);
  }

  async function testQuickToolbar() {
    return runSuite("2. Quick Toolbar Geometry, Bounds & Dead Space", suiteQuickToolbar);
  }

  async function testConnectionsPicker() {
    return runSuite("3. Connections Picker Profile & Model Picker", suiteConnectionsPicker);
  }

  async function testLoreIndicator() {
    return runSuite("4. Lore Indicator", suiteLoreIndicator);
  }

  async function testLorebookTokenCounts() {
    return runSuite("5. Lorebook Token Counts", suiteLorebookTokenCounts);
  }

  async function testLorebookWorkspace() {
    return runSuite("6. Lorebook Workspace", suiteLorebookWorkspace);
  }

  async function testPortraitDock() {
    return runSuite("7. Portrait Dock & Character Badges", suitePortraitDock);
  }

  async function testMessageEditing() {
    return runSuite("8. Message Actions & Edit Area Integrity", suiteMessageEditing);
  }

  async function testSettingsAndEmbeddings() {
    return runSuite("9. Settings Modal & Embeddings", suiteSettingsAndEmbeddings);
  }

  async function testInteractiveProbes() {
    return runSuite("10. Temporary Interactive Surface Probes", suiteInteractiveProbes);
  }

  function summary() {
    const checks = runState.results.filter((entry) =>
      ["PASS", "WARN", "FAIL"].includes(entry.status),
    );
    return {
      totalChecks: checks.length,
      passed: checks.filter((entry) => entry.status === "PASS").length,
      warnings: checks.filter((entry) => entry.status === "WARN").length,
      failed: checks.filter((entry) => entry.status === "FAIL").length,
      infoMessages: runState.results.filter((entry) => entry.status === "INFO").length,
      executionTimeMs: Math.round(perf.now() - runState.startedAt),
    };
  }

  function printSummary(result) {
    openGroup("Lumiverse Suite verification summary");
    safeTable([
      { metric: "Total checks", value: result.totalChecks },
      { metric: "Passed", value: result.passed },
      { metric: "Warnings", value: result.warnings },
      { metric: "Failed", value: result.failed },
      { metric: "Execution time (ms)", value: result.executionTimeMs },
    ]);
    const style =
      result.failed > 0
        ? "color:" + COLORS.FAIL + ";font-weight:700"
        : result.warnings > 0
          ? "color:" + COLORS.WARN + ";font-weight:700"
          : "color:" + COLORS.PASS + ";font-weight:700";
    console.log(
      "%cLumiverse Suite verification finished: %d passed, %d warning(s), %d failed",
      style,
      result.passed,
      result.warnings,
      result.failed,
    );
    closeGroup();
  }

  async function runAll() {
    if (runState.runPromise) {
      info("Verification run already in progress", "Returning the existing run promise");
      return runState.runPromise;
    }

    runState.runPromise = (async () => {
      runState.running = true;
      runState.results = [];
      runState.startedAt = perf.now();
      console.log(
        "%c╔══════════════════════════════════════════════════════════════╗\n" +
          "║ Lumiverse Suite browser-console verification                 ║\n" +
          "║ Read-only DOM, CSS, storage, Zustand, and Spindle inspection ║\n" +
          "╚══════════════════════════════════════════════════════════════╝",
        "color:" + COLORS.INFO + ";font-weight:700",
      );
      console.log(
        "%cController: %cwindow.__LUMIVERSE_TESTER__%c | Snapshot: %cwindow.__LUMIVERSE_UI_SNAPSHOT__%c",
        "color:" + COLORS.INFO + ";font-weight:700",
        "color:" + COLORS.PASS + ";font-weight:700",
        "color:inherit;font-weight:400",
        "color:" + COLORS.PASS + ";font-weight:700",
        "color:inherit;font-weight:400",
      );

      const suites = [
        testStoreAndExtensions,
        testQuickToolbar,
        testConnectionsPicker,
        testLoreIndicator,
        testLorebookTokenCounts,
        testLorebookWorkspace,
        testPortraitDock,
        testMessageEditing,
        testSettingsAndEmbeddings,
        testInteractiveProbes,
      ];
      for (const suite of suites) {
        await suite();
      }
      const result = summary();
      runState.lastSummary = result;
      printSummary(result);
      ensureCopyButton();
      await copyResultsToClipboard({ automatic: true });
      return result;
    })();

    try {
      return await runState.runPromise;
    } finally {
      runState.running = false;
      runState.runPromise = null;
    }
  }

  const controller = {
    version: "1.0.0",
    moduleIds: MODULE_IDS.slice(),
    runAll,
    testStoreAndExtensions,
    testQuickToolbar,
    testConnectionsPicker,
    testLoreIndicator,
    testLorebookTokenCounts,
    testLorebookWorkspace,
    testPortraitDock,
    testMessageEditing,
    testSettingsAndEmbeddings,
    testInteractiveProbes,
    captureSnapshot,
    diffSnapshot,
    highlightElement,
    clearHighlights,
    copyResults: () => copyResultsToClipboard({ automatic: false }),
    removeCopyButton,
    getReport: buildResultsReport,
    getLastSummary: () => runState.lastSummary,
    getResults: () => runState.results.slice(),
  };

  snapshotStore.captureSnapshot = captureSnapshot;
  snapshotStore.diffSnapshot = diffSnapshot;
  host.__LUMIVERSE_UI_SNAPSHOT__ = snapshotStore;
  host.__LUMIVERSE_TESTER__ = controller;
  ensureCopyButton();

  try {
    await runAll();
  } catch (error) {
    fail(
      "Automatic verification run completed",
      error && error.stack ? error.stack : String(error),
    );
  }
})();
