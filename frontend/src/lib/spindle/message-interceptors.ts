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
}

type PendingTagIntercept = {
  payload: SpindleMessageTagIntercept
  interceptor: RegisteredTagInterceptor
}

const tagInterceptors = new Map<string, RegisteredTagInterceptor[]>()
const delivered = new Set<string>()
let interceptorVersion = 0
const listeners = new Set<() => void>()

function notifyInterceptorRegistryChanged(): void {
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

function attrsMatch(needle: Record<string, string> | undefined, haystack: Record<string, string>): boolean {
  if (!needle) return true
  for (const [key, value] of Object.entries(needle)) {
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
    removeFromMessage: options.removeFromMessage !== false,
  }

  const item: RegisteredTagInterceptor = {
    extensionId,
    extensionName,
    options: normalizedOptions,
    handler,
  }
  const list = tagInterceptors.get(tagName) || []
  list.push(item)
  tagInterceptors.set(tagName, list)
  notifyInterceptorRegistryChanged()

  return () => {
    const current = tagInterceptors.get(tagName)
    if (!current) return
    const next = current.filter((entry) => entry !== item)
    if (next.length === 0) tagInterceptors.delete(tagName)
    else tagInterceptors.set(tagName, next)
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

  let output = content
  const intercepts: PendingTagIntercept[] = []

  for (const [tagName, interceptors] of tagInterceptors) {
    if (interceptors.length === 0) continue
    const re = new RegExp(`<${escapeRegex(tagName)}\\b([^>]*)>([\\s\\S]*?)</${escapeRegex(tagName)}>`, 'gi')

    output = output.replace(re, (fullMatch, attrsRaw, inner) => {
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
        if (!attrsMatch(interceptor.options.attrs, attrs)) continue
        intercepts.push({ payload, interceptor })
        if (interceptor.options.removeFromMessage !== false) {
          shouldRemove = true
        }
      }

      return shouldRemove ? '' : fullMatch
    })

    if (context.isStreaming) {
      const hiddenInterceptors = interceptors.filter((interceptor) => interceptor.options.removeFromMessage !== false)
      if (hiddenInterceptors.length === 0) continue

      const openRe = new RegExp(`<${escapeRegex(tagName)}\\b([^>]*)>[\\s\\S]*$`, 'i')
      output = output.replace(openRe, (partialMatch, attrsRaw) => {
        const attrs = parseAttrs(String(attrsRaw || ''))
        const interceptor = hiddenInterceptors.find((entry) => attrsMatch(entry.options.attrs, attrs))
        return interceptor ? pendingIndicator(interceptor) : partialMatch
      })
    }
  }

  return { content: output, intercepts }
}

export function dispatchMessageTagIntercepts(intercepts: PendingTagIntercept[]): void {
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
