'use strict'

const STORAGE_KEY = 'lumiverseQuickToolbarReports'
const MAX_REPORTS = 120
const MAX_STORAGE_BYTES = 6_000_000
let storageWriteQueue = Promise.resolve()

async function readReports() {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  return Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : []
}

async function writeReports(reports) {
  const bounded = reports.slice(-MAX_REPORTS)
  while (bounded.length > 1 && JSON.stringify(bounded).length > MAX_STORAGE_BYTES) bounded.shift()
  await chrome.storage.local.set({ [STORAGE_KEY]: bounded })
  return bounded.length
}

function enqueueStorageWrite(operation) {
  const next = storageWriteQueue.then(operation)
  storageWriteQueue = next.catch(() => undefined)
  return next
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(STORAGE_KEY).then((stored) => {
    if (!Array.isArray(stored[STORAGE_KEY])) return chrome.storage.local.set({ [STORAGE_KEY]: [] })
    return undefined
  }).catch(() => undefined)
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type
  if (type === 'REPORT_READY' && message.report) {
    enqueueStorageWrite(async () => {
      const reports = await readReports()
      const report = {
        ...message.report,
        sourceTabId: sender.tab?.id ?? null,
        sourceUrl: sender.tab?.url || message.report.artifact?.page?.url || null,
      }
      return writeReports([...reports, report])
    }).then((totalReports) => sendResponse({ ok: true, totalReports }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }))
    return true
  }
  if (type === 'GET_REPORTS') {
    storageWriteQueue.then(() => readReports()).then((reports) => {
      const tabId = Number.isInteger(message.tabId) ? message.tabId : null
      const filtered = message.all === true || tabId === null
        ? reports
        : reports.filter((report) => report.sourceTabId === tabId)
      sendResponse({ ok: true, reports: filtered, totalReports: reports.length, storageKey: STORAGE_KEY })
    }).catch((error) => sendResponse({ ok: false, error: String(error), reports: [] }))
    return true
  }
  if (type === 'CLEAR_REPORTS') {
    enqueueStorageWrite(() => chrome.storage.local.set({ [STORAGE_KEY]: [] }))
      .then(() => sendResponse({ ok: true, totalReports: 0 }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }))
    return true
  }
  if (type === 'PING') {
    storageWriteQueue.then(() => readReports())
      .then((reports) => sendResponse({ ok: true, totalReports: reports.length }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }))
    return true
  }
  return false
})
