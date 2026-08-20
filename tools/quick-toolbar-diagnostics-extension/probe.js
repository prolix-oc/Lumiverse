/*
 * Lumiverse Quick Toolbar diagnostics probe v3.
 *
 * This file is both a pasteable DevTools script and the shared content-script
 * probe used by the MV3 diagnostics extension. It is read-only.
 */
(function installQuickToolbarProbe(global) {
  'use strict'

  const VERSION = '3.0.0'
  const REPORT_KEY = 'LUMIVERSE_QUICKTOOLBAR_RUNS'
  const state = {
    runs: Array.isArray(global[REPORT_KEY]) ? global[REPORT_KEY].slice(-100) : [],
  }
  global[REPORT_KEY] = state.runs
  const round = (value) => Math.round((Number(value) || 0) * 100) / 100
  const now = () => new Date().toISOString()
  const text = (node) => (node?.innerText || node?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 240)
  const finite = (value) => Number.isFinite(Number(value))

  function box(node) {
    if (!node || typeof node.getBoundingClientRect !== 'function') return null
    const value = node.getBoundingClientRect()
    return {
      x: round(value.x), y: round(value.y), right: round(value.right), bottom: round(value.bottom),
      width: round(value.width), height: round(value.height),
    }
  }

  function styles(node) {
    if (!node) return null
    const style = getComputedStyle(node)
    const properties = [
      'display', 'visibility', 'position', 'width', 'min-width', 'max-width', 'height',
      'min-height', 'max-height', 'flex', 'flex-basis', 'flex-grow', 'flex-shrink',
      'align-self', 'justify-content', 'overflow', 'overflow-x', 'overflow-y',
      'box-sizing', 'left', 'right', 'top', 'transform', 'transform-origin', 'zoom',
      'padding-left', 'padding-right', 'padding-top', 'padding-bottom', 'border-left-width',
      'border-right-width', 'gap', 'z-index',
    ]
    return Object.fromEntries(properties.map((property) => [property, style.getPropertyValue(property)]))
  }

  function describe(node) {
    if (!node) return null
    return {
      tag: node.tagName,
      id: node.id || null,
      className: typeof node.className === 'string' ? node.className : String(node.className || ''),
      attrs: Object.fromEntries([...node.attributes].map((attribute) => [attribute.name, attribute.value])),
      rect: box(node),
      clientWidth: round(node.clientWidth),
      scrollWidth: round(node.scrollWidth),
      clientHeight: round(node.clientHeight),
      scrollHeight: round(node.scrollHeight),
      text: text(node),
      computed: styles(node),
    }
  }

  function visible(node) {
    const rect = box(node)
    if (!rect) return false
    const style = getComputedStyle(node)
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
  }

  function parentChain(node) {
    const chain = []
    let current = node
    for (let depth = 0; current && depth < 14; depth += 1, current = current.parentElement) {
      chain.push({
        depth,
        tag: current.tagName,
        className: typeof current.className === 'string' ? current.className : String(current.className || ''),
        surface: current.getAttribute('data-lumiverse-surface'),
        mount: current.getAttribute('data-spindle-mount'),
        rect: box(current),
        computed: styles(current),
      })
    }
    return chain
  }

  function objectValue(value) {
    if (value && typeof value === 'object') return value
    if (typeof value !== 'string') return null
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  async function digest(buffer) {
    if (!global.crypto?.subtle) return null
    const hash = await global.crypto.subtle.digest('SHA-256', buffer)
    return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join('')
  }

  async function fetchDigest(url) {
    try {
      const response = await fetch(url, { credentials: 'include', cache: 'no-store' })
      const buffer = await response.arrayBuffer()
      return {
        url,
        status: response.status,
        contentType: response.headers.get('content-type'),
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        cacheControl: response.headers.get('cache-control'),
        hash: await digest(buffer),
        bytes: buffer.byteLength,
      }
    } catch (error) {
      return { url, error: String(error) }
    }
  }

  async function artifactReport() {
    const performanceUrls = [...new Set(performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => /\/assets\/index-[^/?]+\.(?:js|css)|\/sw\.js(?:\?|$)/.test(name)))]
    const htmlUrl = location.href
    const html = await fetchDigest(htmlUrl)
    let htmlText = ''
    try {
      const response = await fetch(htmlUrl, { credentials: 'include', cache: 'no-store' })
      htmlText = await response.text()
    } catch {}
    const references = [...htmlText.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => new URL(match[1], location.href).href)
      .filter((url) => /\/assets\/index-[^/?]+\.(?:js|css)|\/sw\.js(?:\?|$)/.test(url))
    const assets = [...new Set([...performanceUrls, ...references])]
    const loaded = []
    for (const url of assets) loaded.push(await fetchDigest(url))
    const registrations = await navigator.serviceWorker?.getRegistrations?.() || []
    const caches = global.caches ? await global.caches.keys() : []
    const cacheMatches = []
    for (const cacheName of caches) {
      try {
        const cache = await global.caches.open(cacheName)
        const matches = await Promise.all(assets.map(async (url) => {
          const match = await cache.match(url)
          return match ? url : null
        }))
        cacheMatches.push({ name: cacheName, assets: matches.filter(Boolean) })
      } catch (error) {
        cacheMatches.push({ name: cacheName, error: String(error) })
      }
    }
    const buildId = document.querySelector('meta[name="lumiverse-build-id"]')?.getAttribute('content') || null
    const buildIdValid = /^lumiverse-\d+$/.test(buildId || '')
    const indexAssets = loaded.filter((asset) => /\/assets\/index-[^/?]+\.(?:js|css)$/.test(asset.url))
    const stale = html.status !== 200 || !buildIdValid || indexAssets.length === 0 || indexAssets.some((asset) => asset.status !== 200 || !asset.hash)
    return {
      status: stale ? 'FAIL' : 'PASS',
      reason: stale
        ? (!buildIdValid ? 'missing or invalid lumiverse-build-id marker' : indexAssets.length === 0 ? 'no loaded index JS/CSS assets were discovered' : 'one or more runtime resources failed to load or hash')
        : 'runtime resources loaded and hashed',
      buildId,
      buildIdValid,
      page: { url: location.href, title: document.title },
      html,
      loaded,
      performanceUrls,
      references,
      serviceWorker: {
        controller: navigator.serviceWorker?.controller?.scriptURL || null,
        registrations: registrations.map((registration) => ({
          scope: registration.scope,
          active: registration.active?.scriptURL || null,
          state: registration.active?.state || null,
        })),
        caches,
        cacheMatches,
      },
    }
  }

  function readReactSettings(toolbar) {
    if (!toolbar) return { found: false, value: null }
    const fiberKey = Object.keys(toolbar).find((key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'))
    if (!fiberKey) return { found: false, value: null }
    let fiber = toolbar[fiberKey]
    for (let depth = 0; fiber && depth < 60; depth += 1, fiber = fiber.return) {
      const candidates = [fiber.memoizedProps?.settings, fiber.memoizedProps?.quickToolbarSettings]
      let hook = fiber.memoizedState
      for (let hop = 0; hook && hop < 80; hop += 1, hook = hook.next) candidates.push(hook.memoizedState)
      for (const value of candidates) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        if (!('autoFitBounds' in value || 'fillTopDockWidth' in value || 'quickToolbarPlacement' in value)) continue
        return {
          found: true,
          value: {
            enabled: value.enabled,
            quickToolbarPlacement: value.quickToolbarPlacement,
            autoFitBounds: value.autoFitBounds,
            fillTopDockWidth: value.fillTopDockWidth,
            hideInChatTopDock: value.hideInChatTopDock,
            rect: value.rect,
            v2ViewportGeometryVersion: value.v2ViewportGeometryVersion,
          },
        }
      }
    }
    return { found: false, value: null }
  }

  async function settingsReport() {
    try {
      const response = await fetch('/api/v1/settings', { credentials: 'include', cache: 'no-store' })
      const rows = await response.json()
      const quickToolbar = rows.filter((row) => /quick|toolbar/i.test(row.key)).map((row) => ({ key: row.key, value: row.value }))
      return { status: response.status, rows: quickToolbar, canonical: objectValue(quickToolbar.find((row) => row.key === 'quickToolbarSettings')?.value) }
    } catch (error) {
      return { status: null, rows: [], canonical: null, error: String(error) }
    }
  }

  function captureGeometry() {
    const toolbar = document.querySelector('[data-component="QuickToolbar"]')
    const nav = toolbar?.querySelector('nav[aria-label="Quick access toolbar"]') || document.querySelector('nav[aria-label="Quick access toolbar"]')
    const scroller = nav?.querySelector('[class*="cardScroller"]')
    const overflow = toolbar?.querySelector('button[aria-controls="quick-toolbar-overflow"]')
    const customize = toolbar?.querySelector('button[aria-label="Customize toolbar"]')
    const dockHost = document.querySelector('[data-spindle-mount="chat_top_dock"]')
    const chatToolbar = document.querySelector('[class*="chatToolbar"]')
    const chatColumn = document.querySelector('[data-lumiverse-surface="chat-column-inner"]')
    const scrollButton = document.querySelector('button[aria-label="Scroll to bottom"]')
    const actions = [...(nav?.querySelectorAll('[data-toolbar-action]') || [])].map((node) => ({
      id: node.getAttribute('data-toolbar-action'),
      label: node.getAttribute('aria-label'),
      visible: visible(node),
      rect: box(node),
    }))
    const toolbarBox = box(toolbar)
    const navBox = box(nav)
    const visibleActions = actions.filter((action) => action.visible && action.rect)
    const trailingStart = [box(overflow)?.x, box(customize)?.x].filter(finite).reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY)
    const lastActionRight = visibleActions.reduce((max, action) => Math.max(max, action.rect.right), 0)
    const actionEscapes = visibleActions.filter((action) => navBox && (action.rect.x < navBox.x - 1 || action.rect.right > navBox.right + 1))
    const boundaries = [
      ['dockHost -> toolbar', dockHost, toolbar],
      ['toolbar -> nav', toolbar, nav],
      ['nav -> scroller', nav, scroller],
      ['nav -> overflow', nav, overflow],
      ['nav -> customize', nav, customize],
    ].map(([name, parent, child]) => {
      const parentBox = box(parent)
      const childBox = box(child)
      const contained = !parentBox || !childBox || (childBox.x >= parentBox.x - 1 && childBox.right <= parentBox.right + 1 && childBox.y >= parentBox.y - 1 && childBox.bottom <= parentBox.bottom + 1)
      return { name, contained, parent: parentBox, child: childBox }
    })
    const firstBrokenBoundary = boundaries.find((boundary) => !boundary.contained) || (actionEscapes[0] ? {
      name: `nav -> action:${actionEscapes[0].id || actionEscapes[0].label || 'unknown'}`,
      contained: false,
      parent: navBox,
      child: actionEscapes[0].rect,
    } : null)
    const viewportWidth = global.visualViewport?.width || global.innerWidth
    const fillScreen = toolbar?.getAttribute('data-fill-screen') === '1'
    const fillDock = toolbar?.getAttribute('data-fill-top-dock') === '1'
    const trailingVoid = Number.isFinite(trailingStart) && lastActionRight > 0 ? round(Math.max(0, trailingStart - lastActionRight - 6)) : 0
    const hostBox = box(dockHost)
    const hostCollapsed = Boolean(dockHost && (!visible(dockHost) || !hostBox || hostBox.height <= 0))
    const diagnoses = []
    if (!toolbar) diagnoses.push('NO_TOOLBAR_ROOT')
    if (toolbar && fillScreen && (toolbarBox?.x > 1 || Math.abs((toolbarBox?.width || 0) - viewportWidth) > 1)) diagnoses.push('FILL_SCREEN_GEOMETRY_MISMATCH')
    if (firstBrokenBoundary) diagnoses.push(`FIRST_BROKEN_BOUNDARY:${firstBrokenBoundary.name}`)
    actionEscapes.forEach((action) => diagnoses.push(`ACTION_ESCAPES_NAV:${action.id || action.label || 'unknown'}`))
    if ((fillScreen || fillDock) && trailingVoid > Math.max(48, (navBox?.width || 0) * 0.08)) diagnoses.push('FILL_MODE_TRAILING_VOID')
    if (toolbar?.getAttribute('data-fit') === 'pending') diagnoses.push('FIT_NEVER_SETTLED')
    if (scrollButton && ((box(scrollButton)?.width || 0) !== 40 || (box(scrollButton)?.height || 0) !== 40)) diagnoses.push('SCROLL_BUTTON_SIZE_MISMATCH')
    if (hostCollapsed) diagnoses.push('DOCK_HOST_COLLAPSED')
    const primaryClass = diagnoses.includes('NO_TOOLBAR_ROOT') ? 'FIT_LIFECYCLE'
      : diagnoses.some((diagnosis) => diagnosis.startsWith('FIRST_BROKEN_BOUNDARY:dockHost')) ? 'HOST_BOUNDARY'
        : diagnoses.some((diagnosis) => diagnosis.startsWith('ACTION_ESCAPES_NAV')) ? 'ACTION_CONTAINMENT'
          : diagnoses.includes('FILL_MODE_TRAILING_VOID') ? 'PACKING'
            : diagnoses.includes('FIT_NEVER_SETTLED') || diagnoses.includes('DOCK_HOST_COLLAPSED') ? 'FIT_LIFECYCLE'
              : 'PASS'
    return {
      viewport: { innerWidth: round(global.innerWidth), innerHeight: round(global.innerHeight), visualWidth: round(viewportWidth), devicePixelRatio: global.devicePixelRatio, zoom: getComputedStyle(document.body).zoom },
      toolbar: describe(toolbar), nav: describe(nav), scroller: describe(scroller), overflow: describe(overflow), customize: describe(customize),
      dockHost: describe(dockHost), chatToolbar: describe(chatToolbar), chatColumn: describe(chatColumn), scrollButton: describe(scrollButton),
      parents: parentChain(toolbar), actions, actionEscapes, boundaries, firstBrokenBoundary,
      packing: {
        visibleActionCount: visibleActions.length,
        lastActionRight: round(lastActionRight),
        trailingStart: Number.isFinite(trailingStart) ? round(trailingStart) : null,
        trailingVoid,
        scrollerRightGap: navBox && box(scroller) ? round(navBox.right - box(scroller).right) : null,
      },
      state: {
        placement: toolbar?.getAttribute('data-quick-toolbar-placement') || null,
        fit: nav?.getAttribute('data-fit') || null,
        autofit: toolbar?.getAttribute('data-autofit') || null,
        fillScreen: toolbar?.getAttribute('data-fill-screen') || null,
        fillDock: toolbar?.getAttribute('data-fill-top-dock') || null,
        hostCollapsed,
      },
      diagnoses,
      primaryClass,
    }
  }

  function reconcile(settings, geometry) {
    const react = readReactSettings(document.querySelector('[data-component="QuickToolbar"]'))
    const canonical = settings.canonical
    const domPlacement = geometry.state.placement
    const domAutoFit = geometry.state.autofit === '1'
    const domFillScreen = geometry.state.fillScreen === '1'
    const mismatches = []
    if (canonical && react.value && canonical.autoFitBounds !== react.value.autoFitBounds) mismatches.push({ field: 'autoFitBounds', api: canonical.autoFitBounds, react: react.value.autoFitBounds })
    if (canonical && react.value && canonical.fillTopDockWidth !== react.value.fillTopDockWidth) mismatches.push({ field: 'fillTopDockWidth', api: canonical.fillTopDockWidth, react: react.value.fillTopDockWidth })
    if (react.value && react.value.autoFitBounds !== domAutoFit) mismatches.push({ field: 'autoFitBounds', react: react.value.autoFitBounds, dom: domAutoFit })
    if (react.value && react.value.quickToolbarPlacement !== domPlacement) mismatches.push({ field: 'quickToolbarPlacement', react: react.value.quickToolbarPlacement, dom: domPlacement })
    return { status: mismatches.length ? 'FAIL' : 'PASS', mismatches, react }
  }

  function deriveLabel(settings, geometry, previous) {
    const state = geometry.state
    const enabled = settings.canonical?.enabled ?? geometry.toolbar?.attrs?.['data-enabled']
    if (enabled === false) return 'toolbar-disabled'
    if (previous?.settings?.canonical?.enabled === false && enabled !== false) return 'toolbar-reenabled'
    if (state.placement === 'chat_top_dock') {
      if (previous?.geometry?.state?.placement === 'chat_top_dock'
        && previous.geometry.state.fillDock === '1'
        && state.fillDock === '0') return 'dock-fill-on-to-off'
      return state.fillDock === '1' ? 'dock-fill-on' : 'dock-fill-off'
    }
    if (state.fillScreen === '1') return 'floating-fill-on'
    if (state.autofit === '1') return 'floating-autofit-on-fill-off'
    const hostOn = geometry.dockHost?.attrs?.['data-dock-request'] === 'strip'
    return `floating-autofit-off-fill-off-dock-host-${hostOn ? 'on' : 'off'}`
  }

  async function settle() {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await new Promise((resolve) => setTimeout(resolve, 140))
  }

  async function capture(label) {
    await settle()
    const settings = await settingsReport()
    const geometry = captureGeometry()
    const reconciliation = reconcile(settings, geometry)
    const artifact = await artifactReport()
    const previous = state.runs[state.runs.length - 1]
    const resolvedLabel = label || deriveLabel(settings, geometry, previous)
    const diagnoses = [...geometry.diagnoses]
    if (artifact.status !== 'PASS') diagnoses.unshift('STALE_RUNTIME_ARTIFACT')
    if (reconciliation.status !== 'PASS') diagnoses.unshift('SETTINGS_CONVERGENCE_MISMATCH')
    const primaryClass = diagnoses.includes('STALE_RUNTIME_ARTIFACT') ? 'STALE_RUNTIME'
      : diagnoses.includes('SETTINGS_CONVERGENCE_MISMATCH') ? 'HYDRATION'
        : geometry.primaryClass
    const report = {
      source: 'Lumiverse Quick Toolbar diagnostics probe',
      version: VERSION,
      capturedAt: now(),
      label: resolvedLabel,
      artifact,
      settings,
      reconciliation,
      geometry,
      diagnoses,
      primaryClass,
    }
    state.runs.push(report)
    state.runs = state.runs.slice(-100)
    global[REPORT_KEY] = state.runs
    global.LUMIVERSE_QUICKTOOLBAR_DEBUG = report
    return report
  }

  async function mark(label) {
    return capture(label)
  }

  const api = {
    version: VERSION,
    capture,
    mark,
    runs: () => [...state.runs],
    clear: () => { state.runs = []; global[REPORT_KEY] = [] },
    export: () => JSON.stringify(state.runs, null, 2),
  }
  global.LumiverseQuickToolbarProbe = api
  global.LUMIVERSE_QUICKTOOLBAR_MARK = mark

  if (!global.chrome?.runtime?.id) {
    capture('manual-paste').then((report) => {
      console.log('[Lumiverse Quick Toolbar probe v3]', report)
      try { global.navigator.clipboard?.writeText(JSON.stringify(report, null, 2)) } catch {}
    }).catch((error) => console.error('[Lumiverse Quick Toolbar probe v3] failed', error))
  }
})(globalThis)
