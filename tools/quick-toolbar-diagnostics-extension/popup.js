'use strict'

const $ = (id) => document.getElementById(id)
let activeTabId = null
let reports = []

function setStatus(value) {
  $('status').textContent = value
}

function render() {
  const latest = reports[reports.length - 1]
  if (!latest) {
    setStatus('No report loaded')
    $('summary').textContent = 'Open a Lumiverse chat on localhost:7860.'
    return
  }
  const geometry = latest.geometry || {}
  const artifact = latest.artifact || {}
  setStatus(`${reports.length} report${reports.length === 1 ? '' : 's'} - ${latest.primaryClass || 'UNKNOWN'}`)
  $('summary').textContent = JSON.stringify({
    capturedAt: latest.capturedAt,
    label: latest.label,
    primaryClass: latest.primaryClass,
    diagnoses: latest.diagnoses,
    artifact: { status: artifact.status, buildId: artifact.buildId, controller: artifact.serviceWorker?.controller },
    state: geometry.state,
    firstBrokenBoundary: geometry.firstBrokenBoundary,
    actionEscapes: geometry.actionEscapes,
    packing: geometry.packing,
  }, null, 2)
}

function sendToTab(message) {
  return new Promise((resolve, reject) => {
    if (activeTabId === null) return reject(new Error('No active tab'))
    chrome.tabs.sendMessage(activeTabId, message, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
      if (!response?.ok) return reject(new Error(response?.error || 'The page did not acknowledge the diagnostics request.'))
      resolve(response)
    })
  })
}

function getReports() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'GET_REPORTS', all: true }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message))
      if (!response?.ok) return reject(new Error(response?.error || 'The diagnostics service worker could not read report history.'))
      resolve(Array.isArray(response.reports) ? response.reports : [])
    })
  })
}

async function loadReports() {
  try {
    reports = await getReports()
    render()
    return reports
  } catch (error) {
    reports = []
    setStatus(`History unavailable: ${error.message}`)
    $('summary').textContent = 'The extension could not read chrome.storage.local. Reload the extension from chrome://extensions and try again.'
    return reports
  }
}

async function ensureContentScript() {
  if (activeTabId === null) throw new Error('No active tab')
  try {
    await sendToTab({ type: 'PING' })
    return
  } catch {
    if (!chrome.scripting?.executeScript) {
      throw new Error('The diagnostics script is not installed in this tab. Reload the Lumiverse chat page.')
    }
    await chrome.scripting.executeScript({ target: { tabId: activeTabId }, files: ['probe.js', 'content.js'] })
    await sendToTab({ type: 'PING' })
  }
}

chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
  activeTabId = tabs[0]?.id ?? null
  try {
    await ensureContentScript()
  } catch (error) {
    setStatus(error.message)
  }
  await loadReports()
})

$('capture').addEventListener('click', () => {
  setStatus('Capturing...')
  sendToTab({ type: 'CAPTURE', label: $('label').value.trim() || undefined })
    .then(() => loadReports())
    .catch((error) => setStatus(error.message))
})

$('mark').addEventListener('click', () => {
  setStatus('Capturing marked state...')
  sendToTab({ type: 'MARK', label: $('label').value.trim() || undefined })
    .then(() => loadReports())
    .catch((error) => setStatus(error.message))
})

$('reset').addEventListener('click', () => {
  if (!confirm('Unregister service workers, delete Cache Storage for this page origin, and reload? Cookies and login data are preserved.')) return
  setStatus('Resetting runtime...')
  sendToTab({ type: 'RESET_RUNTIME' })
    .then(() => setStatus('Reloading after runtime reset...'))
    .catch((error) => setStatus(error.message))
})

$('copy').addEventListener('click', async () => {
  try {
    const history = await getReports()
    await navigator.clipboard.writeText(JSON.stringify(history, null, 2))
    setStatus(`Copied ${history.length} report${history.length === 1 ? '' : 's'}`)
  } catch (error) {
    setStatus(`Copy failed: ${error.message}`)
  }
})

$('save').addEventListener('click', async () => {
  try {
    const history = await getReports()
    const blob = new Blob([JSON.stringify(history, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `lumiverse-quick-toolbar-history-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setStatus(`Saved ${history.length} report${history.length === 1 ? '' : 's'}`)
  } catch (error) {
    setStatus(`Save failed: ${error.message}`)
  }
})

$('clear').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_REPORTS' }, () => {
    reports = []
    render()
  })
})
