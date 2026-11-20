import { useLayoutEffect, useMemo, useSyncExternalStore, type SetStateAction } from 'react'
import type { MessageAttachment } from '@/types/api'

export type ComposerAttachment = MessageAttachment & { previewUrl?: string }
export interface ComposerDraft {
  text: string
  attachments: ComposerAttachment[]
}

const draftKey = (chatId: string) => `lumiverse:composerDraft:v1:${chatId}`
const legacyKey = (chatId: string) => `lumiverse:chatDraft:${chatId}`

function readDraft(chatId: string): ComposerDraft {
  try {
    const raw = localStorage.getItem(draftKey(chatId))
    if (raw) {
      const saved = JSON.parse(raw)
      if (typeof saved.text === 'string' && Array.isArray(saved.attachments)) {
        return {
          text: saved.text,
          attachments: saved.attachments.filter((a: ComposerAttachment) => a
            && ['image', 'audio', 'video'].includes(a.type)
            && typeof a.image_id === 'string'
            && typeof a.original_filename === 'string'
            && typeof a.mime_type === 'string'),
        }
      }
    }
  } catch { /* Keep the composer usable if browser storage is unavailable. */ }
  try {
    return { text: localStorage.getItem(legacyKey(chatId)) || '', attachments: [] }
  } catch {
    return { text: '', attachments: [] }
  }
}

/** A session remains bound to its chat when a save finishes after navigation. */
function createDraftSession(chatId: string) {
  let current: ComposerDraft = { text: '', attachments: [] }
  let persistent = false
  let lastStored: string | null = null
  const listeners = new Set<() => void>()

  const persist = () => {
    if (!persistent) return
    try {
      const serialized = current.text || current.attachments.length
        ? JSON.stringify({
          text: current.text,
          // Uploaded media IDs survive refresh; transient preview URLs do not.
          attachments: current.attachments.map(({ previewUrl: _, ...a }) => a),
        })
        : null
      if (serialized !== null) localStorage.setItem(draftKey(chatId), serialized)
      else localStorage.removeItem(draftKey(chatId))
      lastStored = serialized
      // Migrate only after the replacement was successfully written.
      localStorage.removeItem(legacyKey(chatId))
    } catch { /* The live draft must survive a quota/security error too. */ }
  }

  const update = (next: ComposerDraft, save = true) => {
    current = next
    if (save) persist()
    for (const listener of listeners) listener()
  }

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => current,
    setPersistence(enabled: boolean) {
      if (persistent === enabled) return
      persistent = enabled
      if (enabled) {
        if (!current.text && current.attachments.length === 0) current = readDraft(chatId)
        update(current)
      } else {
        try {
          localStorage.removeItem(draftKey(chatId))
          localStorage.removeItem(legacyKey(chatId))
        } catch {}
      }
    },
    setText(value: SetStateAction<string>) {
      const text = typeof value === 'function' ? value(current.text) : value
      update({ ...current, text })
    },
    setAttachments(value: SetStateAction<ComposerAttachment[]>) {
      const attachments = typeof value === 'function' ? value(current.attachments) : value
      update({ ...current, attachments })
    },
    acknowledge(submitted: ComposerDraft) {
      // Do not clear edits or uploads made while the request was in flight.
      const next = {
        text: current.text === submitted.text ? '' : current.text,
        attachments: current.attachments.filter((a) => !submitted.attachments.includes(a)),
      }
      let ownsStoredDraft = true
      try {
        ownsStoredDraft = localStorage.getItem(draftKey(chatId)) === lastStored
      } catch {}
      // A new mount/tab may have saved a newer draft for this same chat.
      update(next, ownsStoredDraft)
    },
  }
}

/** Persist at the edit boundary, before refresh, suspension or unmount can run. */
export function useComposerDraft(chatId: string, saveDraftInput: boolean) {
  const session = useMemo(() => createDraftSession(chatId), [chatId])
  const draft = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  useLayoutEffect(() => { session.setPersistence(saveDraftInput) }, [session, saveDraftInput])
  return {
    draft,
    text: draft.text,
    setText: session.setText,
    attachments: draft.attachments,
    setAttachments: session.setAttachments,
    acknowledgeDraft: session.acknowledge,
  }
}
