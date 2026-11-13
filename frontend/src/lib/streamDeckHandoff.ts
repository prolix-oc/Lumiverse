import { uuidv4 } from '@/lib/uuid'

const CHANNEL_NAME = 'lumiverse:stream-deck-handoff'
const STORAGE_KEY = 'lumiverse:stream-deck-handoff-event'
const TAB_ID_KEY = 'lumiverse:stream-deck-tab-id'

type OpenChatRequest = {
  type: 'open-chat'
  requestId: string
  sourceTabId: string
  chatId: string
}

type OpenChatAck = {
  type: 'open-chat-ack'
  requestId: string
  responderTabId: string
}

type OpenChatCommit = {
  type: 'open-chat-commit'
  requestId: string
  responderTabId: string
  chatId: string
}

type HandoffMessage = OpenChatRequest | OpenChatAck | OpenChatCommit

function getTabId(): string {
  let id = sessionStorage.getItem(TAB_ID_KEY)
  if (!id) {
    id = uuidv4()
    sessionStorage.setItem(TAB_ID_KEY, id)
  }
  return id
}

function isMessage(value: unknown): value is HandoffMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  return (
    message.type === 'open-chat' &&
    typeof message.requestId === 'string' &&
    typeof message.sourceTabId === 'string' &&
    typeof message.chatId === 'string'
  ) || (
    message.type === 'open-chat-ack' &&
    typeof message.requestId === 'string' &&
    typeof message.responderTabId === 'string'
  ) || (
    message.type === 'open-chat-commit' &&
    typeof message.requestId === 'string' &&
    typeof message.responderTabId === 'string' &&
    typeof message.chatId === 'string'
  )
}

function publish(message: HandoffMessage, channel?: BroadcastChannel | null): void {
  channel?.postMessage(message)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...message, sentAt: Date.now() }))
  } catch {}
}

function listen(handler: (message: HandoffMessage) => void): () => void {
  let channel: BroadcastChannel | null = null
  if ('BroadcastChannel' in window) {
    channel = new BroadcastChannel(CHANNEL_NAME)
    channel.addEventListener('message', event => {
      if (isMessage(event.data)) handler(event.data)
    })
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return
    try {
      const message: unknown = JSON.parse(event.newValue)
      if (isMessage(message)) handler(message)
    } catch {}
  }
  window.addEventListener('storage', onStorage)

  return () => {
    channel?.close()
    window.removeEventListener('storage', onStorage)
  }
}

/** Listen for Stream Deck navigation requests originating from another tab. */
export function installStreamDeckHandoffReceiver(navigate: (path: string) => void): () => void {
  const tabId = getTabId()
  const offered = new Set<string>()
  const handled = new Set<string>()
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL_NAME) : null

  const stop = listen(message => {
    if (message.type === 'open-chat') {
      if (message.sourceTabId === tabId || offered.has(message.requestId)) return
      offered.add(message.requestId)
      publish({ type: 'open-chat-ack', requestId: message.requestId, responderTabId: tabId }, channel)
      return
    }
    if (
      message.type === 'open-chat-commit' &&
      message.responderTabId === tabId &&
      !handled.has(message.requestId)
    ) {
      handled.add(message.requestId)
      navigate(`/chat/${encodeURIComponent(message.chatId)}`)
      window.focus()
    }
  })

  return () => {
    stop()
    channel?.close()
  }
}

/** Ask an existing Lumiverse tab to open a chat, resolving false when none responds. */
export function handOffChatToExistingTab(chatId: string, timeoutMs = 500): Promise<boolean> {
  const requestId = uuidv4()
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL_NAME) : null

  return new Promise(resolve => {
    let settled = false
    const finish = (handled: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stop()
      channel?.close()
      resolve(handled)
    }
    const stop = listen(message => {
      if (message.type === 'open-chat-ack' && message.requestId === requestId) {
        publish({
          type: 'open-chat-commit',
          requestId,
          responderTabId: message.responderTabId,
          chatId,
        }, channel)
        finish(true)
      }
    })
    const timer = window.setTimeout(() => finish(false), timeoutMs)

    publish({ type: 'open-chat', requestId, sourceTabId: getTabId(), chatId }, channel)
  })
}

async function handOffChatViaServiceWorker(chatId: string, timeoutMs = 500): Promise<boolean> {
  const controller = navigator.serviceWorker?.controller
  if (!controller) return false

  return new Promise(resolve => {
    const channel = new MessageChannel()
    let settled = false
    const finish = (handled: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      channel.port1.close()
      resolve(handled)
    }
    const timer = window.setTimeout(() => finish(false), timeoutMs)
    channel.port1.onmessage = event => finish(event.data?.handled === true)
    controller.postMessage({ type: 'STREAM_DECK_OPEN_CHAT', chatId }, [channel.port2])
  })
}

/** Prefer the service worker's WindowClient API, then use cross-tab messaging. */
export async function openChatInExistingLumiverseTab(chatId: string): Promise<boolean> {
  if (await handOffChatViaServiceWorker(chatId)) return true
  return handOffChatToExistingTab(chatId)
}
