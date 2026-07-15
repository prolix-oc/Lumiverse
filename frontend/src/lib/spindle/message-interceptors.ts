import type {
  SpindleMessageTagIntercept,
  SpindleMessageTagInterceptorOptions,
} from 'lumiverse-spindle-types'

type InterceptorHandler = (payload: SpindleMessageTagIntercept) => void

type RegisteredTagInterceptor = {
  extensionId: string
  extensionName: string
  options: SpindleMessageTagInterceptorOptions
  handler: InterceptorHandler
  attrEntries?: ReadonlyArray<readonly [string, string]>
  pendingHtml: string
}

type TagMatchPlan = {
  completeRe: RegExp
  openRe: RegExp
  lowercaseNeedle: string | null
  hiddenInterceptors: RegisteredTagInterceptor[]
}

type PendingTagIntercept = {
  payload: SpindleMessageTagIntercept
  interceptor: RegisteredTagInterceptor
}

type DeferredTagInterceptBatch = {
  intercepts: PendingTagIntercept[]
  delivered: Set<string>
}

const tagInterceptors = new Map<string, RegisteredTagInterceptor[]>()
const tagMatchPlans = new Map<string, TagMatchPlan>()
let registeredTagPresenceRe: RegExp | null = null
let interceptorVersion = 0
const listeners = new Set<() => void>()
const deferredTagInterceptBatches: DeferredTagInterceptBatch[] = []
let deferredTagInterceptTimer: ReturnType<typeof setInterval> | null = null

function notifyInterceptorRegistryChanged(): void {
  registeredTagPresenceRe = tagInterceptors.size > 0
    ? new RegExp(`<(?:${Array.from(tagInterceptors.keys(), escapeRegex).join('|')})\\b`, 'i')
    : null
  interceptorVersion += 1
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // no-op
    }
  }
}

export function subscribeTagInterceptorRegistry(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getTagInterceptorRegistryVersion(): number {
  return interceptorVersion
}

function normalizeTagName(value: string): string {
  return value.trim().toLowerCase()
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const attrRe = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let match: RegExpExecArray | null
  while ((match = attrRe.exec(raw)) !== null) {
    const key = match[1]
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    out[key] = value
  }
  return out
}

function attrsMatch(needle: ReadonlyArray<readonly [string, string]> | undefined, haystack: Record<string, string>): boolean {
  if (!needle) return true
  for (const [key, value] of needle) {
    if ((haystack[key] ?? '') !== value) return false
  }
  return true
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function pendingIndicator(interceptor: RegisteredTagInterceptor): string {
  const name = escapeHtml(interceptor.extensionName || 'Extension')
  const id = escapeHtml(interceptor.extensionId)
  return `<div class="spindle-message-tag-pending" data-spindle-extension-id="${id}"><span class="spindle-message-tag-pending-dot"></span><span>${name} is processing this part of the message...</span></div>`
}

function rebuildTagMatchPlan(tagName: string, interceptors: RegisteredTagInterceptor[]): void {
  const escapedTagName = escapeRegex(tagName)
  tagMatchPlans.set(tagName, {
    completeRe: new RegExp(`<${escapedTagName}\\b([^>]*)>([\\s\\S]*?)</${escapedTagName}>`, 'gi'),
    openRe: new RegExp(`<${escapedTagName}\\b([^>]*)>[\\s\\S]*$`, 'i'),
    lowercaseNeedle: /^[a-z0-9:_-]+$/.test(tagName) ? `<${tagName}` : null,
    hiddenInterceptors: interceptors.filter((interceptor) => interceptor.options.removeFromMessage !== false),
  })
}

function deliveryKey(payload: SpindleMessageTagIntercept, interceptor: RegisteredTagInterceptor): string {
  const scope = payload.messageId || payload.chatId || 'global'
  return [
    interceptor.extensionId,
    scope,
    payload.isStreaming ? 'streaming' : 'final',
    payload.tagName,
    payload.fullMatch,
  ].join('::')
}

export function registerTagInterceptor(
  extensionId: string,
  extensionName: string,
  options: SpindleMessageTagInterceptorOptions,
  handler: InterceptorHandler,
): () => void {
  const tagName = normalizeTagName(options.tagName || '')
  if (!tagName) {
    throw new Error('registerTagInterceptor requires a non-empty tagName')
  }

  const normalizedOptions: SpindleMessageTagInterceptorOptions = {
    ...options,
    tagName,
    ...(options.attrs ? { attrs: { ...options.attrs } } : {}),
    removeFromMessage: options.removeFromMessage !== false,
  }

  const item: RegisteredTagInterceptor = {
    extensionId,
    extensionName,
    options: normalizedOptions,
    handler,
    attrEntries: normalizedOptions.attrs
      ? Object.entries(normalizedOptions.attrs)
      : undefined,
    pendingHtml: '',
  }
  item.pendingHtml = pendingIndicator(item)
  const list = tagInterceptors.get(tagName) || []
  list.push(item)
  tagInterceptors.set(tagName, list)
  rebuildTagMatchPlan(tagName, list)
  notifyInterceptorRegistryChanged()

  return () => {
    const current = tagInterceptors.get(tagName)
    if (!current) return
    const next = current.filter((entry) => entry !== item)
    if (next.length === 0) tagInterceptors.delete(tagName)
    else tagInterceptors.set(tagName, next)
    if (next.length === 0) tagMatchPlans.delete(tagName)
    else rebuildTagMatchPlan(tagName, next)
    notifyInterceptorRegistryChanged()
  }
}

export function unregisterTagInterceptorsByExtension(extensionId: string): void {
  let changed = false
  for (const [tagName, list] of tagInterceptors) {
    const next = list.filter((entry) => entry.extensionId !== extensionId)
    if (next.length === list.length) continue
    changed = true
    if (next.length === 0) tagInterceptors.delete(tagName)
    else tagInterceptors.set(tagName, next)
    if (next.length === 0) tagMatchPlans.delete(tagName)
    else rebuildTagMatchPlan(tagName, next)
  }
  if (changed) {
    notifyInterceptorRegistryChanged()
  }
}

export function stripMessageTags(
  content: string,
  context: { messageId?: string; chatId?: string; isUser?: boolean; isStreaming?: boolean },
): { content: string; intercepts: PendingTagIntercept[] } {
  if (!content || tagInterceptors.size === 0) return { content, intercepts: [] }
  if (!content.includes('<')) return { content, intercepts: [] }
  // Below this point, cached per-tag regexes are cheaper than allocating a
  // lowercase copy and running the combined absence check. Large registries
  // are where repeated full-message scans dominate.
  const usePresencePrefilter = tagInterceptors.size >= 32
  if (usePresencePrefilter && registeredTagPresenceRe && !registeredTagPresenceRe.test(content)) {
    return { content, intercepts: [] }
  }

  let output = content
  const intercepts: PendingTagIntercept[] = []
  const lowercaseContent = usePresencePrefilter ? content.toLowerCase() : ''

  for (const [tagName, interceptors] of tagInterceptors) {
    if (interceptors.length === 0) continue
    const plan = tagMatchPlans.get(tagName)
    if (!plan) continue
    if (lowercaseContent && plan.lowercaseNeedle && !lowercaseContent.includes(plan.lowercaseNeedle)) continue
    plan.completeRe.lastIndex = 0

    output = output.replace(plan.completeRe, (fullMatch, attrsRaw, inner) => {
      const attrs = parseAttrs(String(attrsRaw || ''))
      const payload: SpindleMessageTagIntercept = {
        extensionId: '',
        tagName,
        attrs,
        content: String(inner || ''),
        fullMatch,
        messageId: context.messageId,
        chatId: context.chatId,
        isUser: context.isUser,
        isStreaming: context.isStreaming,
      }

      let shouldRemove = false
      for (const interceptor of interceptors) {
        if (!attrsMatch(interceptor.attrEntries, attrs)) continue
        intercepts.push({ payload, interceptor })
        if (interceptor.options.removeFromMessage !== false) {
          shouldRemove = true
        }
      }

      return shouldRemove ? '' : fullMatch
    })

    if (context.isStreaming) {
      if (plan.hiddenInterceptors.length === 0) continue

      plan.openRe.lastIndex = 0
      output = output.replace(plan.openRe, (partialMatch, attrsRaw) => {
        const attrs = parseAttrs(String(attrsRaw || ''))
        const interceptor = plan.hiddenInterceptors.find((entry) => attrsMatch(entry.attrEntries, attrs))
        return interceptor ? interceptor.pendingHtml : partialMatch
      })
    }
  }

  return { content: output, intercepts }
}

function processMessageTagIntercepts(intercepts: PendingTagIntercept[], delivered: Set<string>): void {
  for (const { payload, interceptor } of intercepts) {
    const key = deliveryKey(payload, interceptor)
    if (delivered.has(key)) continue
    delivered.add(key)
    try {
      interceptor.handler({ ...payload, extensionId: interceptor.extensionId })
    } catch (err) {
      console.error(`[Spindle] Tag interceptor failed (${interceptor.extensionId}):`, err)
    }
  }
}

function ensureDeferredTagInterceptPoller(): void {
  if (deferredTagInterceptTimer !== null) return
  deferredTagInterceptTimer = setInterval(() => {
    if (document.body.hasAttribute('data-chat-chrome-entering')) return
    clearInterval(deferredTagInterceptTimer!)
    deferredTagInterceptTimer = null
    const batches = deferredTagInterceptBatches.splice(0)
    for (const batch of batches) {
      processMessageTagIntercepts(batch.intercepts, batch.delivered)
    }
  }, 50)
}

export function dispatchMessageTagIntercepts(intercepts: PendingTagIntercept[], delivered: Set<string>): void {
  if (
    document.body.hasAttribute('data-chat-chrome-entering') ||
    deferredTagInterceptBatches.length > 0
  ) {
    // Preserve delivery order while using one poller for the entire chat,
    // rather than one timer per mounted message.
    deferredTagInterceptBatches.push({ intercepts, delivered })
    ensureDeferredTagInterceptPoller()
    return
  }

  processMessageTagIntercepts(intercepts, delivered)
}
