/*
 * Quick Toolbar deep diagnostic probe.
 *
 * Paste this entire file into DevTools on the affected chat page. It is
 * read-only: it does not change settings, CSS, layout, or service-worker state.
 * The final object is available as window.LUMIVERSE_QUICKTOOLBAR_DEEP_DEBUG.
 */
void async function quickToolbarDeepDebug() {
  'use strict'

  const VERSION = '2.2.0'
  const round = (value) => Math.round((Number(value) || 0) * 100) / 100
  const rect = (node) => {
    if (!node || typeof node.getBoundingClientRect !== 'function') return null
    const value = node.getBoundingClientRect()
    return {
      x: round(value.x), y: round(value.y), right: round(value.right), bottom: round(value.bottom),
      width: round(value.width), height: round(value.height),
    }
  }
  const computed = (node, properties) => {
    if (!node) return null
    const style = getComputedStyle(node)
    return Object.fromEntries(properties.map((property) => [property, style.getPropertyValue(property)]))
  }
  const attrs = (node) => node
    ? Object.fromEntries([...node.attributes].map((attribute) => [attribute.name, attribute.value]))
    : null
  const describe = (node) => node ? {
    tag: node.tagName,
    className: typeof node.className === 'string' ? node.className : String(node.className || ''),
    attrs: attrs(node),
    rect: rect(node),
    computed: computed(node, [
      'display', 'position', 'width', 'min-width', 'max-width', 'height', 'min-height',
      'max-height', 'flex', 'flex-basis', 'flex-grow', 'flex-shrink', 'align-self',
      'justify-content', 'overflow', 'overflow-x', 'box-sizing', 'left', 'right',
      'top', 'transform', 'zoom', 'padding-left', 'padding-right', 'gap', 'z-index',
    ]),
  } : null
  const visible = (node) => {
    const value = rect(node)
    return Boolean(value && value.width > 0 && value.height > 0 && getComputedStyle(node).display !== 'none')
  }
  const text = (node) => (node?.innerText || node?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 180)

  const toolbarRoots = [...document.querySelectorAll('[data-component="QuickToolbar"]')]
  const toolbar = toolbarRoots[0] || null
  const nav = toolbar?.querySelector('nav[aria-label="Quick access toolbar"]') || document.querySelector('nav[aria-label="Quick access toolbar"]')
  const scroller = nav?.querySelector('[class*="cardScroller"]')
  const measureRail = toolbar?.querySelector('[class*="measureRail"]')
  const overflow = toolbar?.querySelector('button[aria-controls="quick-toolbar-overflow"]')
  const customize = toolbar?.querySelector('button[aria-label="Customize toolbar"]')
  const dockHost = document.querySelector('[data-spindle-mount="chat_top_dock"]')
  const chatToolbar = document.querySelector('[class*="chatToolbar"]')
  const chatColumnInner = document.querySelector('[data-lumiverse-surface="chat-column-inner"]')
  const scrollButton = document.querySelector('button[aria-label="Scroll to bottom"]')
  const nativeSelect = chatToolbar?.querySelector('button[aria-label*="Select messages"], button[aria-label*="Exit selection"]')

  const cssMatches = (node) => {
    if (!node) return []
    const matches = []
    const wanted = /(^|-)width|(^|-)height|(^|-)flex|(^|-)display|(^|-)position|(^|-)left|(^|-)right|(^|-)top|(^|-)overflow|(^|-)justify|(^|-)align|(^|-)padding|(^|-)gap|(^|-)transform|(^|-)zoom/
    for (const sheet of [...document.styleSheets]) {
      let rules
      try { rules = [...(sheet.cssRules || [])] } catch { continue }
      for (const rule of rules) {
        if (!rule.selectorText || !node.matches(rule.selectorText)) continue
        const declarations = [...rule.style].filter((name) => wanted.test(name)).map((name) => `${name}:${rule.style.getPropertyValue(name)}`)
        if (declarations.length) matches.push({ selector: rule.selectorText, declarations })
      }
    }
    return matches.slice(-80)
  }

  const parentChain = (node) => {
    const chain = []
    let current = node
    for (let index = 0; current && index < 12; index += 1, current = current.parentElement) {
      chain.push({ depth: index, ...describe(current) })
    }
    return chain
  }

  const actionState = (root) => [...(root?.querySelectorAll('[data-toolbar-action]') || [])].map((node) => ({
    id: node.getAttribute('data-toolbar-action'),
    label: node.getAttribute('aria-label'),
    text: text(node),
    visible: visible(node),
    rect: rect(node),
  }))

  const readReactSettings = (node) => {
    if (!node) return { found: false, value: null }
    const fiberKey = Object.keys(node).find((key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'))
    if (!fiberKey) return { found: false, value: null }
    let fiber = node[fiberKey]
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
            variant: value.variant,
            quickToolbarPlacement: value.quickToolbarPlacement,
            autoFitBounds: value.autoFitBounds,
            fillTopDockWidth: value.fillTopDockWidth,
            showNativeSelectMessages: value.showNativeSelectMessages,
            v2ViewportGeometryVersion: value.v2ViewportGeometryVersion,
            rect: value.rect,
            visibleTabIds: Array.isArray(value.visibleTabIds) ? value.visibleTabIds : null,
            iconOrder: Array.isArray(value.iconOrder) ? value.iconOrder : null,
          },
        }
      }
    }
    return { found: false, value: null }
  }

  const safeStorage = (storage) => {
    const result = {}
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index)
        if (key && /quick|toolbar|spindle|productivity/i.test(key)) result[key] = storage.getItem(key)?.slice(0, 4000)
      }
    } catch (error) { result.error = String(error) }
    return result
  }
  const objectValue = (value) => {
    if (value && typeof value === 'object') return value
    if (typeof value !== 'string') return null
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch { return null }
  }

  const settingsRows = await (async () => {
    try {
      const response = await fetch('/api/v1/settings', { credentials: 'include' })
      const rows = await response.json()
      return {
        status: response.status,
        quickToolbar: rows.filter((row) => /quick|toolbar/i.test(row.key)).map((row) => ({ key: row.key, value: row.value })),
      }
    } catch (error) { return { error: String(error) } }
  })()

  const serviceWorker = await (async () => {
    try {
      const registrations = await navigator.serviceWorker?.getRegistrations?.() || []
      return {
        controller: navigator.serviceWorker?.controller?.scriptURL || null,
        registrations: registrations.map((registration) => ({
          scope: registration.scope,
          active: registration.active?.scriptURL || null,
          state: registration.active?.state || null,
        })),
        caches: window.caches ? await caches.keys() : [],
      }
    } catch (error) { return { error: String(error) } }
  })()

  const resources = [...new Set(performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => /\/assets\/index-|\/sw\.js(?:\?|$)/.test(name)))]
  const relevantControls = [...document.querySelectorAll('button,[role="switch"],input[type="checkbox"]')]
    .filter((node) => /toolbar|top bar|top of the screen|auto-fit|fill|expand|scroll to bottom/i.test(`${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''} ${text(node)}`))
    .map((node) => ({ tag: node.tagName, label: node.getAttribute('aria-label'), title: node.getAttribute('title'), checked: node.checked ?? node.getAttribute('aria-checked'), text: text(node), rect: rect(node) }))

  const viewport = {
    innerWidth: round(window.innerWidth), innerHeight: round(window.innerHeight),
    visualWidth: round(window.visualViewport?.width || 0), visualHeight: round(window.visualViewport?.height || 0),
    devicePixelRatio: window.devicePixelRatio,
    zoom: getComputedStyle(document.body).zoom,
    url: location.href,
  }
  const toolbarBox = rect(toolbar)
  const expectedFill = toolbar?.getAttribute('data-fill-screen') === '1'
  const expectedDockFill = toolbar?.getAttribute('data-fill-top-dock') === '1'
  const actualViewportWidth = viewport.visualWidth || viewport.innerWidth
  const reactSettings = readReactSettings(toolbar)
  const canonicalSettings = objectValue(settingsRows.quickToolbar?.find((row) => row.key === 'quickToolbarSettings')?.value)
  const actionReport = actionState(nav)
  const visibleActions = actionReport.filter((action) => action.visible)
  const navBox = rect(nav)
  const scrollerBox = rect(scroller)
  const overflowBox = rect(overflow)
  const customizeBox = rect(customize)
  const dockHostBox = rect(dockHost)
  const lastVisibleActionRight = visibleActions.reduce((right, action) => Math.max(right, action.rect?.right || 0), 0)
  const trailingControlStart = [overflowBox?.x, customizeBox?.x]
    .filter((value) => Number.isFinite(value))
    .reduce((left, value) => Math.min(left, value), Number.POSITIVE_INFINITY)
  const trailingVoid = Number.isFinite(trailingControlStart) && lastVisibleActionRight > 0
    ? round(Math.max(0, trailingControlStart - lastVisibleActionRight - 6))
    : 0
  const packing = {
    visibleActionCount: visibleActions.length,
    lastVisibleActionRight: round(lastVisibleActionRight),
    trailingControlStart: Number.isFinite(trailingControlStart) ? round(trailingControlStart) : null,
    trailingVoid,
    scrollerRightGap: navBox && scrollerBox ? round(navBox.right - scrollerBox.right) : null,
    overflowRightGap: navBox && overflowBox ? round(navBox.right - overflowBox.right) : null,
    customizeRightGap: navBox && customizeBox ? round(navBox.right - customizeBox.right) : null,
  }
  const actionEscapes = actionReport.filter((action) => action.visible && navBox && action.rect && (
    action.rect.x < navBox.x - 1 || action.rect.right > navBox.right + 1
  ))
  const dockHostState = {
    visible: visible(dockHost),
    height: dockHostBox?.height ?? 0,
    collapsed: Boolean(dockHost && (!visible(dockHost) || (dockHostBox?.height || 0) <= 0)),
  }
  const fit = {
    state: nav?.getAttribute('data-fit') || null,
    ready: nav?.getAttribute('data-fit') === 'ready',
  }
  const toolbarSettingsDisabled = canonicalSettings?.enabled === false || reactSettings.value?.enabled === false
  const diagnoses = []
  if (!toolbar) diagnoses.push('NO_TOOLBAR_ROOT')
  if (toolbarRoots.length > 1) diagnoses.push('DUPLICATE_TOOLBAR_ROOTS')
  if (expectedFill && toolbarBox && (toolbarBox.x > 1 || Math.abs(toolbarBox.width - actualViewportWidth) > 1)) diagnoses.push('FILL_SCREEN_GEOMETRY_MISMATCH')
  if (toolbar?.getAttribute('data-quick-toolbar-placement') === 'chat_top_dock' && chatColumnInner && chatColumnInner.getBoundingClientRect().width > 0 && toolbarBox && toolbarBox.right > chatColumnInner.getBoundingClientRect().right + 1) diagnoses.push('DOCK_ESCAPES_CHAT_COLUMN')
  if (toolbar?.getAttribute('data-quick-toolbar-placement') === 'chat_top_dock' && dockHostBox && toolbarBox && (toolbarBox.x < dockHostBox.x - 1 || toolbarBox.right > dockHostBox.right + 1)) diagnoses.push('DOCK_ROOT_ESCAPES_HOST')
  if (toolbarBox && navBox && (navBox.x < toolbarBox.x - 1 || navBox.right > toolbarBox.right + 1)) diagnoses.push('NAV_ESCAPES_ROOT')
  if (navBox && scrollerBox && scrollerBox.right > navBox.right + 1) diagnoses.push('SCROLLER_ESCAPES_NAV')
  if (navBox && overflowBox && overflowBox.right > navBox.right + 1) diagnoses.push('OVERFLOW_ESCAPES_NAV')
  if (navBox && customizeBox && customizeBox.right > navBox.right + 1) diagnoses.push('CUSTOMIZE_ESCAPES_NAV')
  actionEscapes.forEach((action) => diagnoses.push(`ACTION_ESCAPES_NAV:${action.id || action.label || 'unknown'}`))
  if (scrollButton && (rect(scrollButton).width > 80 || rect(scrollButton).height > 80)) diagnoses.push('SCROLL_BUTTON_OVERSIZED')
  if (toolbar?.getAttribute('data-autofit') === '1' && overflow && visibleActions.length === 0) diagnoses.push('AUTOFIT_HAS_NO_VISIBLE_ACTIONS')
  if (toolbar?.getAttribute('data-autofit') === '1' && toolbarBox && toolbarBox.right > actualViewportWidth + 1) diagnoses.push('AUTOFIT_OVERFLOWS_VIEWPORT')
  if ((expectedFill || expectedDockFill) && trailingVoid > Math.max(48, (navBox?.width || 0) * 0.08)) diagnoses.push('FILL_MODE_TRAILING_VOID')
  if (canonicalSettings && reactSettings.value && canonicalSettings.autoFitBounds !== reactSettings.value.autoFitBounds) diagnoses.push('API_REACT_AUTOFIT_MISMATCH')
  if (canonicalSettings && reactSettings.value && canonicalSettings.fillTopDockWidth !== reactSettings.value.fillTopDockWidth) diagnoses.push('API_REACT_FILL_MISMATCH')
  if (reactSettings.value && String(reactSettings.value.autoFitBounds === false ? 0 : 1) !== toolbar?.getAttribute('data-autofit')) diagnoses.push('REACT_DOM_AUTOFIT_MISMATCH')
  if (reactSettings.value && toolbar?.getAttribute('data-quick-toolbar-placement') !== reactSettings.value.quickToolbarPlacement) diagnoses.push('REACT_DOM_PLACEMENT_MISMATCH')
  if (toolbarSettingsDisabled && dockHostState.collapsed) diagnoses.push('DOCK_HOST_COLLAPSED_WHEN_DISABLED')

  const report = {
    source: 'Lumiverse Quick Toolbar deep diagnostic probe',
    version: VERSION,
    capturedAt: new Date().toISOString(),
    runLabel: [
      toolbar?.getAttribute('data-quick-toolbar-placement') || 'no-toolbar',
      `autofit-${toolbar?.getAttribute('data-autofit') ?? 'unknown'}`,
      `fill-screen-${toolbar?.getAttribute('data-fill-screen') ?? 'na'}`,
      `fill-dock-${toolbar?.getAttribute('data-fill-top-dock') ?? 'na'}`,
    ].join('__'),
    viewport,
    resources,
    serviceWorker,
    settingsRows,
    reactSettings,
    toolbarRootCount: toolbarRoots.length,
    storage: { local: safeStorage(localStorage), session: safeStorage(sessionStorage) },
    toolbar: describe(toolbar),
    nav: describe(nav),
    scroller: describe(scroller),
    measureRail: describe(measureRail),
    overflow: describe(overflow),
    customize: describe(customize),
    actions: actionReport,
    actionEscapes,
    packing,
    dockHost: describe(dockHost),
    dockHostState,
    fit,
    chatToolbar: describe(chatToolbar),
    chatColumnInner: describe(chatColumnInner),
    nativeSelect: describe(nativeSelect),
    scrollButton: describe(scrollButton),
    toolbarParents: parentChain(toolbar),
    navCssMatches: cssMatches(nav),
    rootCssMatches: cssMatches(toolbar),
    scrollButtonCssMatches: cssMatches(scrollButton),
    relevantControls,
    diagnoses,
  }

  window.LUMIVERSE_QUICKTOOLBAR_DEEP_DEBUG = report
  window.LUMIVERSE_QUICKTOOLBAR_DEEP_DEBUG_RUNS = [
    ...(window.LUMIVERSE_QUICKTOOLBAR_DEEP_DEBUG_RUNS || []),
    report,
  ]
  console.log('[QuickToolbar deep debug] BEGIN')
  console.log(JSON.stringify(report, null, 2))
  console.log('[QuickToolbar deep debug] diagnoses:', diagnoses.length ? diagnoses : 'none')
  console.log('[QuickToolbar deep debug] accumulated runs:', window.LUMIVERSE_QUICKTOOLBAR_DEEP_DEBUG_RUNS.length)
  console.log('[QuickToolbar deep debug] END')
  try { await navigator.clipboard?.writeText(JSON.stringify(report, null, 2)); console.info('[QuickToolbar deep debug] JSON copied to clipboard') } catch {}
  return report
}()
