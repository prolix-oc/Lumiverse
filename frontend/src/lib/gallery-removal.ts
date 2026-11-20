import { notifyGalleryItemRemoved, onGalleryItemRemoved, onDeletionReconnect, type GalleryItemRemoved } from './deletion-events'

/** Confirm gallery membership separately from cleanup of an unused image file. */
export function completeGalleryRemoval(options: {
  characterId: string
  itemId: string
  request: () => Promise<GalleryItemRemoved>
  readStatus: (signal: AbortSignal) => Promise<{ deleted: boolean }>
  pollMs?: number
  timeoutMs?: number
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    let settled = false
    let checking = false
    let requestFailed = false
    let requestError: unknown
    let poll: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(poll)
      unsubscribe()
      disconnect()
      controller.abort()
      if (error) reject(error)
      else resolve()
    }
    const observe = (item: GalleryItemRemoved) => {
      if (item?.characterId === options.characterId && item.id === options.itemId && item.status === 'completed') finish()
    }
    const confirm = () => {
      notifyGalleryItemRemoved({ id: options.itemId, characterId: options.characterId, status: 'completed' })
      finish()
    }
    const check = async () => {
      if (settled || checking) return
      checking = true
      clearTimeout(poll)
      try {
        const status = await options.readStatus(controller.signal)
        if (status.deleted) confirm()
        else if (requestFailed) finish(requestError)
      } catch (error: any) {
        if (requestFailed) finish(requestError)
        else if (error?.status === 401 || error?.status === 403 || error?.name === 'InactiveTabError') finish(error)
      } finally {
        checking = false
        if (!settled) poll = setTimeout(check, options.pollMs ?? 1000)
      }
    }
    const unsubscribe = onGalleryItemRemoved(observe)
    const disconnect = onDeletionReconnect(() => { void check() })
    const deadline = setTimeout(() => finish(new Error('Gallery removal is unconfirmed. Refresh to check its status.')), options.timeoutMs ?? 35_000)
    // Do not cancel the DELETE after an early event: its unused-image cleanup
    // still runs, and its eventual response/rejection must remain handled.
    void options.request().then((receipt) => {
      if (receipt?.characterId === options.characterId && receipt.id === options.itemId && receipt.status === 'completed') {
        notifyGalleryItemRemoved(receipt)
        finish()
      } else { void check() }
    }).catch((error: any) => {
      if (settled) return
      if (error?.status === 401 || error?.status === 403 || error?.name === 'InactiveTabError') { finish(error); return }
      requestFailed = true
      requestError = error
      void check()
    })
    poll = setTimeout(check, options.pollMs ?? 200)
  })
}
