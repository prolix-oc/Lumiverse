import type { SpindleFrontendContext, SpindleManifest } from 'lumiverse-spindle-types'
import { createSandboxFrame } from './sandbox-frame'

type RpcRequest = {
  kind: 'rpc'
  id: string
  token: string
  method: string
  args?: unknown[]
}

type RuntimeMessage =
  | RpcRequest
  | { kind: 'ready'; token: string }
  | { kind: 'error'; token: string; error: string }

type HostMessage =
  | { kind: 'rpc-result'; id: string; ok: true; result: unknown }
  | { kind: 'rpc-result'; id: string; ok: false; error: string }
  | { kind: 'callback'; subscriptionId: string; args: unknown[] }
  | { kind: 'backend-message'; payload: unknown }
  | { kind: 'process-event'; payload: unknown }
  | { kind: 'teardown' }

interface RuntimeHandleRecord {
  handle: object
  type: string
  rootSurfaceId?: string
}

interface RuntimeSurfaceRecord {
  frame: ReturnType<typeof createSandboxFrame>
}

interface RuntimeSubscriptionRecord {
  unsubscribe: () => void
}

interface RuntimeProcessRecord {
  process: {
    processId: string
    ready(): void
    heartbeat(): void
    send(payload: unknown): void
    complete(result?: unknown): void
    fail(error: string): void
    onMessage(handler: (payload: unknown) => void): () => void
    onStop(handler: (detail: { reason?: string }) => void): () => void
  }
  messageUnsub?: () => void
  stopUnsub?: () => void
}

const RUNTIME_MESSAGE_KEY = '__lumiverseSpindleFrontendRuntime'

export class SandboxedFrontendRuntime {
  readonly iframe: HTMLIFrameElement

  private readonly token = crypto.randomUUID()
  private readonly handles = new Map<string, RuntimeHandleRecord>()
  private readonly surfaces = new Map<string, RuntimeSurfaceRecord>()
  private readonly subscriptions = new Map<string, RuntimeSubscriptionRecord>()
  private readonly processes = new Map<string, RuntimeProcessRecord>()
  private destroyed = false
  private readyResolve?: () => void
  private readyReject?: (err: Error) => void

  constructor(
    private readonly extensionId: string,
    private readonly manifest: SpindleManifest,
    private readonly code: string,
    private readonly context: SpindleFrontendContext & {
      processes: {
        register(kind: string, handler: (process: RuntimeProcessRecord['process']) => void | (() => void) | Promise<void | (() => void)>): () => void
      }
      messages: SpindleFrontendContext['messages'] & {
        renderWidget(
          options: { messageId: string; widgetId: string; html: string; minHeight?: number; maxHeight?: number },
          handler?: (payload: unknown) => void,
        ): () => void
        removeWidget(messageId: string, widgetId: string): void
      }
      characters: { get(characterId: string): Promise<unknown> }
      chats: { updateMessage(chatId: string, messageId: string, input: { content?: string }): Promise<unknown> }
    },
  ) {
    this.iframe = document.createElement('iframe')
    this.iframe.setAttribute('data-spindle-ext', extensionId)
    this.iframe.setAttribute('data-spindle-frontend-runtime', this.token)
    this.iframe.setAttribute('sandbox', 'allow-scripts')
    this.iframe.setAttribute(
      'allow',
      "accelerometer 'none'; autoplay 'none'; camera 'none'; clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'; encrypted-media 'none'; geolocation 'none'; gyroscope 'none'; hid 'none'; microphone 'none'; midi 'none'; payment 'none'; serial 'none'; usb 'none'; web-share 'none'"
    )
    this.iframe.referrerPolicy = 'no-referrer'
    Object.assign(this.iframe.style, {
      position: 'fixed',
      width: '0',
      height: '0',
      border: '0',
      opacity: '0',
      pointerEvents: 'none',
      left: '-9999px',
      top: '-9999px',
    })
  }

  start(): Promise<void> {
    window.addEventListener('message', this.handleMessage)
    document.body.appendChild(this.iframe)
    this.iframe.srcdoc = buildRuntimeDocument(this.token, this.manifest, this.code)

    return new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      window.setTimeout(() => {
        if (!this.destroyed && this.readyReject) {
          this.readyReject(new Error('Timed out waiting for sandboxed frontend runtime'))
          this.readyReject = undefined
        }
      }, 10000)
    })
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.post({ kind: 'teardown' })
    window.removeEventListener('message', this.handleMessage)

    for (const subscription of this.subscriptions.values()) {
      try { subscription.unsubscribe() } catch {}
    }
    this.subscriptions.clear()

    for (const surface of this.surfaces.values()) {
      try { surface.frame.destroy() } catch {}
    }
    this.surfaces.clear()

    for (const record of this.handles.values()) {
      try {
        const destroy = (record.handle as Record<string, unknown>).destroy
        if (typeof destroy === 'function') destroy.call(record.handle)
      } catch {}
    }
    this.handles.clear()

    this.iframe.remove()
  }

  sendBackendMessage(payload: unknown): void {
    this.post({ kind: 'backend-message', payload })
  }

  sendProcessEvent(payload: unknown): void {
    this.post({ kind: 'process-event', payload })
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    if (event.source !== this.iframe.contentWindow) return
    const data = event.data as RuntimeMessage & { [RUNTIME_MESSAGE_KEY]?: unknown }
    if (!data || typeof data !== 'object') return
    if (data[RUNTIME_MESSAGE_KEY] !== RUNTIME_MESSAGE_KEY || data.token !== this.token) return

    if (data.kind === 'ready') {
      this.readyResolve?.()
      this.readyResolve = undefined
      this.readyReject = undefined
      return
    }

    if (data.kind === 'error') {
      const err = new Error(data.error)
      if (this.readyReject) this.readyReject(err)
      else console.error(`[Spindle:${this.manifest.identifier}] Sandboxed frontend error:`, err)
      this.readyResolve = undefined
      this.readyReject = undefined
      return
    }

    if (data.kind === 'rpc') {
      void this.handleRpc(data)
    }
  }

  private async handleRpc(request: RpcRequest): Promise<void> {
    try {
      const result = await this.dispatchRpc(request.method, request.args || [])
      this.post({ kind: 'rpc-result', id: request.id, ok: true, result })
    } catch (err) {
      this.post({
        kind: 'rpc-result',
        id: request.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async dispatchRpc(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'events.on': {
        const [event, subscriptionId] = args
        if (typeof event !== 'string' || typeof subscriptionId !== 'string') throw new Error('Invalid events.on call')
        const unsubscribe = this.context.events.on(event, (payload) => {
          this.post({ kind: 'callback', subscriptionId, args: [payload] })
        })
        this.subscriptions.set(subscriptionId, { unsubscribe })
        return null
      }
      case 'events.emit':
        this.context.events.emit(String(args[0] || ''), args[1])
        return null
      case 'unsubscribe': {
        const subscriptionId = String(args[0] || '')
        const subscription = this.subscriptions.get(subscriptionId)
        if (subscription) {
          subscription.unsubscribe()
          this.subscriptions.delete(subscriptionId)
        }
        return null
      }
      case 'permissions.getGranted':
        return this.context.permissions.getGranted()
      case 'permissions.request':
        return this.context.permissions.request(args[0] as string[], args[1] as never)
      case 'uploads.pickFile':
        return this.context.uploads.pickFile(args[0] as never)
      case 'getActiveChat':
        return this.context.getActiveChat()
      case 'sendToBackend':
        this.context.sendToBackend(args[0])
        return null
      case 'onBackendMessage': {
        const subscriptionId = String(args[0] || '')
        const unsubscribe = this.context.onBackendMessage((payload) => {
          this.post({ kind: 'callback', subscriptionId, args: [payload] })
        })
        this.subscriptions.set(subscriptionId, { unsubscribe })
        return null
      }
      case 'messages.registerTagInterceptor': {
        const [options, subscriptionId] = args
        if (typeof subscriptionId !== 'string') throw new Error('Invalid tag interceptor subscription')
        const unsubscribe = this.context.messages.registerTagInterceptor(options as never, (payload) => {
          this.post({ kind: 'callback', subscriptionId, args: [payload] })
        })
        this.subscriptions.set(subscriptionId, { unsubscribe })
        return null
      }
      case 'messages.renderWidget': {
        const [options, subscriptionId] = args
        const handler = typeof subscriptionId === 'string'
          ? (payload: unknown) => this.post({ kind: 'callback', subscriptionId, args: [payload] })
          : undefined
        this.context.messages.renderWidget(options as never, handler)
        return null
      }
      case 'messages.removeWidget':
        this.context.messages.removeWidget(String(args[0] || ''), String(args[1] || ''))
        return null
      case 'characters.get':
        return this.context.characters.get(String(args[0] || ''))
      case 'chats.updateMessage':
        return this.context.chats.updateMessage(String(args[0] || ''), String(args[1] || ''), args[2] as never)
      case 'ui.mount': {
        const root = this.context.ui.mount(args[0] as never)
        return { rootSurfaceId: this.createSurface(root) }
      }
      case 'ui.registerDrawerTab':
        return this.registerHandle('drawerTab', this.context.ui.registerDrawerTab(args[0] as never), true)
      case 'ui.createFloatWidget':
        return this.registerHandle('floatWidget', this.context.ui.createFloatWidget(args[0] as never), true)
      case 'ui.requestDockPanel':
        return this.registerHandle('dockPanel', this.context.ui.requestDockPanel(args[0] as never), true)
      case 'ui.mountApp':
        return this.registerHandle('appMount', this.context.ui.mountApp(args[0] as never), true)
      case 'ui.showModal':
        return this.registerHandle('modal', this.context.ui.showModal(args[0] as never), true)
      case 'ui.registerInputBarAction':
        return this.registerHandle('inputBarAction', this.context.ui.registerInputBarAction(args[0] as never), false)
      case 'ui.showContextMenu':
        return this.context.ui.showContextMenu(args[0] as never)
      case 'ui.showConfirm':
        return this.context.ui.showConfirm(args[0] as never)
      case 'handle.call':
        return this.callHandle(String(args[0] || ''), String(args[1] || ''), (args[2] as unknown[]) || [])
      case 'handle.subscribe':
        return this.subscribeHandle(String(args[0] || ''), String(args[1] || ''), String(args[2] || ''))
      case 'surface.setHtml':
        return this.setSurfaceHtml(String(args[0] || ''), String(args[1] || ''))
      case 'processes.register':
        return this.registerProcessHandler(String(args[0] || ''))
      case 'process.call':
        return this.callProcess(String(args[0] || ''), String(args[1] || ''), args[2])
      case 'process.subscribe':
        return this.subscribeProcess(String(args[0] || ''), String(args[1] || ''), String(args[2] || ''))
      default:
        throw new Error(`Unsupported sandbox RPC method: ${method}`)
    }
  }

  private registerHandle(type: string, handle: object, hasRoot: boolean): unknown {
    const handleId = crypto.randomUUID()
    const handleRecord = handle as Record<string, unknown>
    const root = hasRoot ? handleRecord.root : undefined
    const rootSurfaceId = root instanceof Element ? this.createSurface(root) : undefined
    this.handles.set(handleId, { handle, type, rootSurfaceId })
    return {
      handleId,
      type,
      rootSurfaceId,
      tabId: handleRecord.tabId,
      widgetId: handleRecord.widgetId,
      panelId: handleRecord.panelId,
      mountId: handleRecord.mountId,
      modalId: handleRecord.modalId,
      actionId: handleRecord.actionId,
    }
  }

  private callHandle(handleId: string, method: string, args: unknown[]): unknown {
    const record = this.handles.get(handleId)
    if (!record) throw new Error('Unknown handle')
    const handle = record.handle as Record<string, unknown>
    const fn = handle[method]
    if (typeof fn !== 'function') throw new Error(`Handle method not found: ${method}`)
    return fn.apply(record.handle, args)
  }

  private subscribeHandle(handleId: string, method: string, subscriptionId: string): unknown {
    const record = this.handles.get(handleId)
    if (!record) throw new Error('Unknown handle')
    const handle = record.handle as Record<string, unknown>
    const fn = handle[method]
    if (typeof fn !== 'function') throw new Error(`Handle method not found: ${method}`)
    const unsubscribe = fn.call(record.handle, (...callbackArgs: unknown[]) => {
      this.post({ kind: 'callback', subscriptionId, args: callbackArgs })
    })
    if (typeof unsubscribe === 'function') this.subscriptions.set(subscriptionId, { unsubscribe })
    return null
  }

  private createSurface(root: Element): string {
    const surfaceId = crypto.randomUUID()
    const frame = createSandboxFrame(this.extensionId, {
      html: '',
      autoResize: true,
      minHeight: 1,
      initialHeight: 40,
      maxHeight: 4000,
    })
    root.replaceChildren(frame.element)
    this.surfaces.set(surfaceId, { frame })
    return surfaceId
  }

  private setSurfaceHtml(surfaceId: string, html: string): null {
    const surface = this.surfaces.get(surfaceId)
    if (!surface) throw new Error('Unknown surface')
    surface.frame.setContent(html)
    return null
  }

  private registerProcessHandler(kind: string): null {
    const unsubscribe = this.context.processes.register(kind, async (process) => {
      this.processes.set(process.processId, { process })
      this.post({
        kind: 'process-event',
        payload: {
          action: 'spawn',
          processId: process.processId,
          kind: process.kind,
          key: process.key,
          payload: process.payload,
          metadata: process.metadata,
        },
      })
    })
    this.subscriptions.set(`process:${kind}`, { unsubscribe })
    return null
  }

  private callProcess(processId: string, method: string, arg: unknown): null {
    const record = this.processes.get(processId)
    if (!record) throw new Error('Unknown process')
    if (method === 'ready') record.process.ready()
    else if (method === 'heartbeat') record.process.heartbeat()
    else if (method === 'send') record.process.send(arg)
    else if (method === 'complete') {
      record.process.complete(arg)
      this.processes.delete(processId)
    } else if (method === 'fail') {
      record.process.fail(String(arg || 'Process failed'))
      this.processes.delete(processId)
    } else {
      throw new Error(`Unsupported process method: ${method}`)
    }
    return null
  }

  private subscribeProcess(processId: string, method: string, subscriptionId: string): null {
    const record = this.processes.get(processId)
    if (!record) throw new Error('Unknown process')
    if (method === 'onMessage') {
      record.messageUnsub?.()
      record.messageUnsub = record.process.onMessage((payload) => {
        this.post({ kind: 'callback', subscriptionId, args: [payload] })
      })
    } else if (method === 'onStop') {
      record.stopUnsub?.()
      record.stopUnsub = record.process.onStop((detail) => {
        this.post({ kind: 'callback', subscriptionId, args: [detail] })
      })
    } else {
      throw new Error(`Unsupported process subscription: ${method}`)
    }
    this.subscriptions.set(subscriptionId, { unsubscribe: () => {
      if (method === 'onMessage') record.messageUnsub?.()
      if (method === 'onStop') record.stopUnsub?.()
    } })
    return null
  }

  private post(message: HostMessage): void {
    this.iframe.contentWindow?.postMessage({ [RUNTIME_MESSAGE_KEY]: RUNTIME_MESSAGE_KEY, token: this.token, ...message }, '*')
  }
}

function buildRuntimeDocument(token: string, manifest: SpindleManifest, code: string): string {
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'; navigate-to 'none'; upgrade-insecure-requests;">
</head><body><script type="module">
${buildRuntimeScript(token, manifest, code)}
</script></body></html>`
}

function buildRuntimeScript(token: string, manifest: SpindleManifest, code: string): string {
  return `
const KEY = ${JSON.stringify(RUNTIME_MESSAGE_KEY)};
const TOKEN = ${JSON.stringify(token)};
const MANIFEST = ${scriptJson(manifest)};
const CODE = ${scriptJson(code)};
let nextId = 1;
const pending = new Map();
const callbacks = new Map();
const processHandlers = new Map();
let teardownFn = null;
let moduleRef = null;

function post(message) { parent.postMessage(Object.assign({ [KEY]: KEY, token: TOKEN }, message), '*'); }
function rpc(method, ...args) {
  const id = String(nextId++);
  post({ kind: 'rpc', id, method, args });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function callbackId(handler) {
  const id = crypto.randomUUID();
  callbacks.set(id, handler);
  return id;
}
function unsubscribe(id) {
  callbacks.delete(id);
  void rpc('unsubscribe', id).catch(() => {});
}
function mirrorRoot(surfacePromise) {
  const root = document.createElement('div');
  let surfaceId = typeof surfacePromise === 'string' ? surfacePromise : null;
  let queued = false;
  if (surfacePromise && typeof surfacePromise.then === 'function') {
    surfacePromise.then((nextSurfaceId) => { surfaceId = nextSurfaceId; sync(); }).catch((err) => console.error('[Spindle] surface creation failed:', err));
  }
  const sync = () => {
    queued = false;
    if (!surfaceId) return;
    void rpc('surface.setHtml', surfaceId, root.innerHTML).catch((err) => console.error('[Spindle] surface sync failed:', err));
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(sync);
  };
  new MutationObserver(queue).observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML') || Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerHTML');
  if (desc && desc.set && desc.get) {
    Object.defineProperty(root, 'innerHTML', { get() { return desc.get.call(root); }, set(value) { desc.set.call(root, value); queue(); } });
  }
  return root;
}
function makeHandle(info, methods, subscriptions) {
  const handle = { };
  if (info.rootSurfaceId) handle.root = mirrorRoot(info.rootSurfaceId);
  for (const key of ['tabId', 'widgetId', 'panelId', 'mountId', 'modalId', 'actionId']) if (info[key]) handle[key] = info[key];
  for (const method of methods) handle[method] = (...args) => rpc('handle.call', info.handleId, method, args);
  for (const method of subscriptions) handle[method] = (handler) => { const id = callbackId(handler); void rpc('handle.subscribe', info.handleId, method, id).catch((err) => { callbacks.delete(id); console.error(err); }); return () => unsubscribe(id); };
  return handle;
}
function makePendingHandle(infoPromise, methods, subscriptions) {
  const handle = { root: mirrorRoot(infoPromise.then((info) => info.rootSurfaceId).catch(() => null)) };
  infoPromise.then((info) => {
    for (const key of ['tabId', 'widgetId', 'panelId', 'mountId', 'modalId', 'actionId']) if (info[key]) handle[key] = info[key];
  }).catch((err) => console.error('[Spindle] handle creation failed:', err));
  for (const method of methods) handle[method] = async (...args) => rpc('handle.call', (await infoPromise).handleId, method, args);
  for (const method of subscriptions) handle[method] = (handler) => {
    const id = callbackId(handler);
    infoPromise.then((info) => rpc('handle.subscribe', info.handleId, method, id)).catch((err) => { callbacks.delete(id); console.error(err); });
    return () => unsubscribe(id);
  };
  return handle;
}
function unsupportedDom(method) { return function(){ throw new Error('ctx.dom.' + method + ' is unavailable in isolated frontend modules. Render HTML/JS into iframe-backed UI roots instead.'); }; }
function makeProcessContext(payload) {
  return {
    processId: payload.processId,
    kind: payload.kind,
    key: payload.key,
    payload: payload.payload,
    metadata: payload.metadata,
    ready: () => rpc('process.call', payload.processId, 'ready'),
    heartbeat: () => rpc('process.call', payload.processId, 'heartbeat'),
    send: (message) => rpc('process.call', payload.processId, 'send', message),
    complete: (result) => rpc('process.call', payload.processId, 'complete', result),
    fail: (error) => rpc('process.call', payload.processId, 'fail', String(error || 'Process failed')),
    onMessage: (handler) => { const id = callbackId(handler); void rpc('process.subscribe', payload.processId, 'onMessage', id); return () => unsubscribe(id); },
    onStop: (handler) => { const id = callbackId(handler); void rpc('process.subscribe', payload.processId, 'onStop', id); return () => unsubscribe(id); },
  };
}
function createContext() {
  return {
    dom: {
      inject: unsupportedDom('inject'),
      addStyle: (css) => { const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style); return () => style.remove(); },
      createElement: (tag, attrs) => { const el = document.createElement(tag); if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v)); return el; },
      createSandboxFrame: unsupportedDom('createSandboxFrame'),
      query: (selector) => document.querySelector(selector),
      queryAll: (selector) => Array.from(document.querySelectorAll(selector)),
      cleanup: () => { document.body.replaceChildren(); },
    },
    events: {
      on: (event, handler) => { const id = callbackId(handler); void rpc('events.on', event, id); return () => unsubscribe(id); },
      emit: (event, payload) => { void rpc('events.emit', event, payload); },
    },
    ui: {
      mount: (point) => mirrorRoot(rpc('ui.mount', point).then((info) => info.rootSurfaceId)),
      registerDrawerTab: (options) => makePendingHandle(rpc('ui.registerDrawerTab', options), ['setTitle', 'setShortName', 'setBadge', 'activate', 'destroy'], ['onActivate']),
      createFloatWidget: (options) => makePendingHandle(rpc('ui.createFloatWidget', options), ['moveTo', 'getPosition', 'setSize', 'setVisible', 'isVisible', 'setFullscreen', 'isFullscreen', 'destroy'], ['onDragEnd']),
      requestDockPanel: (options) => makePendingHandle(rpc('ui.requestDockPanel', options), ['collapse', 'expand', 'isCollapsed', 'setTitle', 'destroy'], ['onVisibilityChange']),
      mountApp: (options) => makePendingHandle(rpc('ui.mountApp', options), ['setVisible', 'destroy'], []),
      registerInputBarAction: (options) => makePendingHandle(rpc('ui.registerInputBarAction', options), ['setLabel', 'setSubtitle', 'setEnabled', 'destroy'], ['onClick']),
      showContextMenu: (options) => rpc('ui.showContextMenu', options),
      showModal: (options) => makePendingHandle(rpc('ui.showModal', options), ['dismiss', 'setTitle'], ['onDismiss']),
      showConfirm: (options) => rpc('ui.showConfirm', options),
    },
    uploads: { pickFile: (options) => rpc('uploads.pickFile', options) },
    permissions: { getGranted: () => rpc('permissions.getGranted'), request: (permissions, options) => rpc('permissions.request', permissions, options) },
    getActiveChat: () => rpc('getActiveChat'),
    sendToBackend: (payload) => { void rpc('sendToBackend', payload); },
    onBackendMessage: (handler) => { const id = callbackId(handler); void rpc('onBackendMessage', id); return () => unsubscribe(id); },
    processes: { register: (kind, handler) => { processHandlers.set(kind, handler); void rpc('processes.register', kind); return () => processHandlers.delete(kind); } },
    messages: {
      registerTagInterceptor: (options, handler) => { const id = callbackId(handler); void rpc('messages.registerTagInterceptor', options, id); return () => unsubscribe(id); },
      renderWidget: (options, handler) => { const id = handler ? callbackId(handler) : null; void rpc('messages.renderWidget', options, id); return () => { if (id) unsubscribe(id); void rpc('messages.removeWidget', options && options.messageId, options && options.widgetId); }; },
      removeWidget: (messageId, widgetId) => { void rpc('messages.removeWidget', messageId, widgetId); },
    },
    characters: { get: (characterId) => rpc('characters.get', characterId) },
    chats: { updateMessage: (chatId, messageId, input) => rpc('chats.updateMessage', chatId, messageId, input) },
    manifest: MANIFEST,
  };
}
addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object' || data[KEY] !== KEY || data.token !== TOKEN) return;
  if (data.kind === 'rpc-result') {
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    data.ok ? entry.resolve(data.result) : entry.reject(new Error(data.error));
  } else if (data.kind === 'callback') {
    const cb = callbacks.get(data.subscriptionId);
    if (cb) cb(...(data.args || []));
  } else if (data.kind === 'process-event') {
    const payload = data.payload;
    if (payload && payload.action === 'spawn') {
      const handler = processHandlers.get(payload.kind);
      if (handler) Promise.resolve(handler(makeProcessContext(payload))).catch((err) => rpc('process.call', payload.processId, 'fail', err && err.message ? err.message : String(err)));
    }
  } else if (data.kind === 'teardown') {
    try { if (typeof teardownFn === 'function') teardownFn(); else if (moduleRef && typeof moduleRef.teardown === 'function') moduleRef.teardown(); } catch {}
  }
});
try {
  const blobUrl = URL.createObjectURL(new Blob([CODE], { type: 'text/javascript' }));
  moduleRef = await import(blobUrl);
  URL.revokeObjectURL(blobUrl);
  if (!moduleRef || typeof moduleRef.setup !== 'function') throw new Error('Frontend module missing setup()');
  teardownFn = await moduleRef.setup(createContext());
  post({ kind: 'ready' });
} catch (err) {
  post({ kind: 'error', error: err && err.message ? err.message : String(err) });
}
`
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}
