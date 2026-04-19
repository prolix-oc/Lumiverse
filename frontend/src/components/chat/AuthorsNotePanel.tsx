import { useState, useEffect, useRef, useCallback } from 'react'
import { CloseButton } from '@/components/shared/CloseButton'
import { chatsApi } from '@/api/chats'
import styles from './AuthorsNotePanel.module.css'

const ROLES = [
  { value: 'system', label: 'System' },
  { value: 'user', label: 'User' },
  { value: 'assistant', label: 'Assistant' },
] as const

interface AuthorsNote {
  content: string
  depth: number
  role: 'system' | 'user' | 'assistant'
}

interface AuthorsNotePanelProps {
  chatId: string
  isOpen: boolean
  onClose: () => void
}

export default function AuthorsNotePanel({ chatId, isOpen, onClose }: AuthorsNotePanelProps) {
  const [noteText, setNoteText] = useState('')
  const [depth, setDepth] = useState(4)
  const [role, setRole] = useState<'system' | 'user' | 'assistant'>('system')
  const [enabled, setEnabled] = useState(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentNoteRef = useRef<AuthorsNote>({ content: '', depth: 4, role: 'system' })

  // Load from chat metadata on open. Cancel flag guards against a stale
  // response landing after the panel closed or the chatId changed.
  useEffect(() => {
    if (!isOpen || !chatId) return
    let cancelled = false

    chatsApi.get(chatId).then((chat) => {
      if (cancelled) return
      const an = chat.metadata?.authors_note as AuthorsNote | undefined
      const next: AuthorsNote = an
        ? {
            content: an.content || '',
            depth: an.depth ?? 4,
            role: an.role || 'system',
          }
        : { content: '', depth: 4, role: 'system' }
      currentNoteRef.current = next
      setNoteText(next.content)
      setDepth(next.depth)
      setRole(next.role)
      setEnabled(!!next.content)
    }).catch(console.error)

    return () => { cancelled = true }
  }, [isOpen, chatId])

  const scheduleSave = useCallback((updates: Partial<AuthorsNote>) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    // Update ref eagerly so the latest field values are always what get saved,
    // even if multiple fields change before the debounce fires.
    currentNoteRef.current = { ...currentNoteRef.current, ...updates }
    saveTimerRef.current = setTimeout(() => {
      const next = currentNoteRef.current
      // Atomic merge via PATCH so concurrent server-side writers (expression
      // detection, council caching, deferred WI/chat-var persistence) can't
      // clobber the author's note, and vice versa. `null` deletes the key.
      const payload: Record<string, any> = next.content?.trim()
        ? { authors_note: next }
        : { authors_note: null }
      chatsApi.patchMetadata(chatId, payload).catch(console.error)
    }, 400)
  }, [chatId])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setNoteText(val)
    setEnabled(!!val.trim())
    scheduleSave({ content: val })
  }, [scheduleSave])

  const handleDepthChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Math.max(0, Math.min(9999, Number(e.target.value) || 0))
    setDepth(val)
    scheduleSave({ depth: val })
  }, [scheduleSave])

  const handleRoleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value as 'system' | 'user' | 'assistant'
    setRole(val)
    scheduleSave({ role: val })
  }, [scheduleSave])

  // Escape to close
  useEffect(() => {
    if (!isOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>
          Author's Note {enabled ? '· Active' : ''}
        </span>
        <CloseButton onClick={onClose} size="sm" iconSize={12} className={styles.closeBtn} />
      </div>

      <div className={styles.body}>
        <div className={styles.field}>
          <textarea
            className={styles.textarea}
            rows={3}
            value={noteText}
            onChange={handleTextChange}
            placeholder="Write instructions or context for the AI..."
          />
        </div>

        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label}>Depth</label>
            <input
              type="number"
              className={styles.input}
              min={0}
              max={9999}
              value={depth}
              onChange={handleDepthChange}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Role</label>
            <select className={styles.select} value={role} onChange={handleRoleChange}>
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  )
}
