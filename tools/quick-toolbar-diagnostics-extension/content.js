(function installQuickToolbarContent(global) {
  'use strict'

  if (global.__LUMIVERSE_QUICK_TOOLBAR_CONTENT_INSTALLED__) return
  global.__LUMIVERSE_QUICK_TOOLBAR_CONTENT_INSTALLED__ = true

  const probe = global.LumiverseQuickToolbarProbe
  let lastUrl = location.href
  let captureInFlight = false
  let mutationTimer = null

  function sendReport(report) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'REPORT_READY', report }, (response) => {
        const runtimeError = chrome.runtime.lastError
        if (runtimeError) return reject(new Error(runtimeError.message))
        if (!response?.ok) return reject(new Error(response?.error || 'The diagnostics service worker did not save the report.'))
        resolve(response)
      })
    })
  }

  async function capture(label) {
    if (!probe || captureInFlight) return null
    captureInFlight = true
    try {
      const report = await probe.capture(label)
      await sendReport(report)
      return report
    } finally {
      captureInFlight = false
    }
  }

  async function resetRuntime() {
  const registrations = await navigator.serviceWorker?.getRegistrations?.() || []
  const unregistered = []
  for (const registration of registrations) {
    try { unregistered.push(await registration.unregister()) } catch { unregistered.push(false) }
  }
  const cacheNames = globalThis.caches ? await caches.keys() : []
  const deletedCaches = []
  for (const name of cacheNames) {
    try { deletedCaches.push({ name, deleted: await caches.delete(name) }) } catch { deletedCaches.push({ name, deleted: false }) }
  }
  setTimeout(() => location.reload(), 80)
  return { unregistered, deletedCaches, reloading: true, preserved: ['cookies', 'IndexedDB', 'localStorage'] }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'PING') {
    sendResponse({ ok: true, installed: true })
    return false
  }
  if (message?.type === 'CAPTURE' || message?.type === 'MARK') {
    capture(message.label)
      .then((report) => sendResponse({ ok: Boolean(report), report }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }))
    return true
  }
  if (message?.type === 'RESET_RUNTIME') {
    resetRuntime()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }))
    return true
  }
  return false
  })

  setTimeout(() => capture(), 500)
  setInterval(() => {
    if (location.href === lastUrl) return
    lastUrl = location.href
    capture().catch(() => undefined)
  }, 1000)

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') capture().catch(() => undefined)
  })

  function hasRelevantMutation(mutation) {
  const element = mutation.target?.nodeType === Node.ELEMENT_NODE
    ? mutation.target
    : mutation.target?.parentElement
  if (element?.closest?.('[data-component="QuickToolbar"], [data-spindle-mount="chat_top_dock"], [class*="chatToolbar"]')) return true
  if (mutation.type !== 'childList') return false
  return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => node.nodeType === Node.ELEMENT_NODE
    && (node.matches?.('[data-component="QuickToolbar"], [data-spindle-mount="chat_top_dock"]')
      || node.querySelector?.('[data-component="QuickToolbar"], [data-spindle-mount="chat_top_dock"]')))
  }

  const mutationObserver = new MutationObserver((mutations) => {
    if (!mutations.some(hasRelevantMutation)) return
    clearTimeout(mutationTimer)
    mutationTimer = setTimeout(() => capture().catch(() => undefined), 320)
  })
  mutationObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-fit', 'data-autofit', 'data-fill-screen', 'data-fill-top-dock', 'data-quick-toolbar-placement', 'data-dock-request', 'data-spindle-occupied', 'style'],
  })
})(globalThis)
