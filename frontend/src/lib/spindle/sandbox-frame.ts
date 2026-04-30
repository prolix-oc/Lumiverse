import type { SpindleSandboxFrameHandle, SpindleSandboxFrameOptions } from 'lumiverse-spindle-types'

interface SandboxFrameRecord {
  iframe: HTMLIFrameElement
  token: string
  handlers: Set<(payload: unknown) => void>
  minHeight: number
  maxHeight: number
  destroyed: boolean
}

const SANDBOX_MESSAGE_KEY = '__lumiverseSpindleSandbox'
const sandboxFrames = new Map<string, SandboxFrameRecord>()

let bridgeInstalled = false

function ensureBridgeInstalled(): void {
  if (bridgeInstalled || typeof window === 'undefined') return
  window.addEventListener('message', handleSandboxMessage)
  bridgeInstalled = true
}

function handleSandboxMessage(event: MessageEvent): void {
  const data = event.data
  if (!data || typeof data !== 'object') return

  const wire = data as {
    __lumiverseSpindleSandbox?: unknown
    token?: unknown
    payload?: unknown
    height?: unknown
  }
  if (wire.__lumiverseSpindleSandbox !== SANDBOX_MESSAGE_KEY) return
  if (typeof wire.token !== 'string' || !wire.token) return

  const record = sandboxFrames.get(wire.token)
  if (!record || record.destroyed) return
  if (event.source !== record.iframe.contentWindow) return

  if (typeof wire.height === 'number' && Number.isFinite(wire.height)) {
    const nextHeight = Math.max(
      record.minHeight,
      Math.min(record.maxHeight, Math.round(wire.height))
    )
    record.iframe.style.height = `${nextHeight}px`
    return
  }

  for (const handler of record.handlers) {
    try {
      handler(wire.payload)
    } catch (err) {
      console.error('[Spindle] Sandbox frame message handler failed:', err)
    }
  }
}

export function createSandboxFrame(
  extensionId: string,
  options: SpindleSandboxFrameOptions
): SpindleSandboxFrameHandle {
  ensureBridgeInstalled()

  const token = makeSandboxToken()
  const minHeight = clampDimension(options.minHeight ?? 40, 1, 4000)
  const maxHeight = clampDimension(options.maxHeight ?? 4000, minHeight, 4000)
  const initialHeight = clampDimension(options.initialHeight ?? minHeight, minHeight, maxHeight)

  const iframe = document.createElement('iframe')
  iframe.setAttribute('data-spindle-ext', extensionId)
  iframe.setAttribute('data-spindle-sandbox-frame', token)
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.setAttribute(
    'allow',
    "accelerometer 'none'; autoplay 'none'; camera 'none'; clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'; encrypted-media 'none'; geolocation 'none'; gyroscope 'none'; hid 'none'; microphone 'none'; midi 'none'; payment 'none'; serial 'none'; usb 'none'; web-share 'none'"
  )
  iframe.referrerPolicy = 'no-referrer'
  iframe.style.width = '100%'
  iframe.style.height = `${initialHeight}px`
  iframe.style.border = 'none'
  iframe.style.display = 'block'
  iframe.style.overflow = 'hidden'
  iframe.style.background = 'transparent'
  iframe.style.maxWidth = 'none'
  iframe.style.maxHeight = 'none'

  const record: SandboxFrameRecord = {
    iframe,
    token,
    handlers: new Set(),
    minHeight,
    maxHeight,
    destroyed: false,
  }
  sandboxFrames.set(token, record)

  const destroy = () => {
    if (record.destroyed) return
    record.destroyed = true
    record.handlers.clear()
    sandboxFrames.delete(token)
    iframe.remove()
  }

  const handle: SpindleSandboxFrameHandle = {
    element: iframe,
    setContent(html: string) {
      if (record.destroyed) return
      iframe.srcdoc = buildSandboxDocument({
        html,
        token,
        autoResize: options.autoResize !== false,
        minHeight,
        maxHeight,
      })
    },
    postMessage(payload: unknown) {
      if (record.destroyed) return
      iframe.contentWindow?.postMessage(
        {
          [SANDBOX_MESSAGE_KEY]: SANDBOX_MESSAGE_KEY,
          token,
          payload,
          kind: 'host-message',
        },
        '*'
      )
    },
    onMessage(handler: (payload: unknown) => void) {
      record.handlers.add(handler)
      return () => {
        record.handlers.delete(handler)
      }
    },
    destroy,
  }

  handle.setContent(options.html)
  return handle
}

function buildSandboxDocument(options: {
  html: string
  token: string
  autoResize: boolean
  minHeight: number
  maxHeight: number
}): string {
  const injection = buildHeadInjection(options)
  const html = options.html || ''

  if (/<(?:!doctype\b|html\b|head\b|body\b)/i.test(html)) {
    const withHead = injectIntoHead(html, injection)
    return injectBeforeCloseBody(withHead, '')
  }

  return `<!DOCTYPE html><html><head>${injection}</head><body>${html}</body></html>`
}

function buildHeadInjection(options: {
  token: string
  autoResize: boolean
  minHeight: number
  maxHeight: number
}): string {
  const tokenLit = JSON.stringify(options.token)
  const autoResizeLit = options.autoResize ? 'true' : 'false'
  const minHeightLit = String(options.minHeight)
  const maxHeightLit = String(options.maxHeight)

  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; navigate-to 'none'; upgrade-insecure-requests;">`,
    '<meta name="color-scheme" content="dark light">',
    '<style>html,body{margin:0;padding:0;background:transparent!important}body{box-sizing:border-box;overflow-x:hidden}:root{color-scheme:dark light}</style>',
    '<script>(function(){',
    `var KEY=${JSON.stringify(SANDBOX_MESSAGE_KEY)};`,
    `var TOKEN=${tokenLit};`,
    `var AUTO_RESIZE=${autoResizeLit};`,
    `var MIN_HEIGHT=${minHeightLit};`,
    `var MAX_HEIGHT=${maxHeightLit};`,
    'var hostMessageHandlers=[];',
    'var resizeObserver=null;',
    'var mutationObserver=null;',
    'var lastHeight=-1;',
    'function clampHeight(value){if(!Number.isFinite(value))return MIN_HEIGHT;return Math.max(MIN_HEIGHT,Math.min(MAX_HEIGHT,Math.ceil(value)));}',
    'function postWire(extra){try{window.parent.postMessage(Object.assign({__lumiverseSpindleSandbox:KEY,token:TOKEN},extra),"*");}catch{}}',
    'function measureHeight(){var body=document.body;var doc=document.documentElement;if(!body)return MIN_HEIGHT;return Math.max(body.scrollHeight,body.offsetHeight,doc?doc.scrollHeight:0,doc?doc.offsetHeight:0,MIN_HEIGHT);}',
    'function requestResize(height){var next=clampHeight(typeof height==="number"?height:measureHeight());if(next===lastHeight)return;lastHeight=next;postWire({height:next});}',
    'function onHostMessage(event){var data=event.data;if(!data||typeof data!=="object")return;if(data.__lumiverseSpindleSandbox!==KEY||data.token!==TOKEN||data.kind!=="host-message")return;for(var i=0;i<hostMessageHandlers.length;i++){try{hostMessageHandlers[i](data.payload);}catch{}}}',
    'function observeSize(){if(!AUTO_RESIZE||!document.body)return;requestResize();window.addEventListener("load",requestResize);window.addEventListener("resize",requestResize);if(typeof ResizeObserver!=="undefined"){try{resizeObserver=new ResizeObserver(function(){requestResize();});resizeObserver.observe(document.documentElement);resizeObserver.observe(document.body);}catch{}}if(typeof MutationObserver!=="undefined"){try{mutationObserver=new MutationObserver(function(){requestResize();});mutationObserver.observe(document.documentElement,{attributes:true,childList:true,characterData:true,subtree:true});}catch{}}}',
    'window.addEventListener("message",onHostMessage);',
    'window.spindleSandbox=Object.freeze({postMessage:function(payload){postWire({payload:payload});},onMessage:function(handler){if(typeof handler!=="function")return function(){};hostMessageHandlers.push(handler);return function(){var idx=hostMessageHandlers.indexOf(handler);if(idx!==-1)hostMessageHandlers.splice(idx,1);};},requestResize:function(height){requestResize(typeof height==="number"?height:Number(height));}});',
    'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",observeSize,{once:true});else observeSize();',
    '})();</script>',
  ].join('')
}

function injectIntoHead(html: string, blob: string): string {
  const openHead = html.match(/<head\b[^>]*>/i)
  if (openHead && openHead.index !== undefined) {
    const index = openHead.index + openHead[0].length
    return html.slice(0, index) + blob + html.slice(index)
  }

  return blob + html
}

function injectBeforeCloseBody(html: string, blob: string): string {
  if (!blob) return html
  const closeBodyIndex = html.search(/<\/body>/i)
  if (closeBodyIndex === -1) return html + blob
  return html.slice(0, closeBodyIndex) + blob + html.slice(closeBodyIndex)
}

function clampDimension(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}

function makeSandboxToken(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`
}
