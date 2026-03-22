import { useState, useEffect, useRef, useCallback } from 'react'
import { X } from 'lucide-react'
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
  const chatMetadataRef = useRef<Record<string, any>>({})

  // Load from chat metadata on open
  useEffect(() => {
    if (!isOpen || !chatId) return

    chatsApi.get(chatId).then((chat) => {
      chatMetadataRef.current = chat.metadata || {}
      const an = chat.metadata?.authors_note as AuthorsNote | undefined
      if (an) {
        setNoteText(an.content || '')
        setDepth(an.depth ?? 4)
        setRole(an.role || 'system')
        setEnabled(!!an.content)
      } else {
        setNoteText('')
        setDepth(4)
        setRole('system')
        setEnabled(false)
      }
    }).catch(console.error)
  }, [isOpen, chatId])

  const scheduleSave = useCallback((updates: Partial<AuthorsNote>) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const meta = { ...chatMetadataRef.current }
      const current = (meta.authors_note as AuthorsNote) || { content: '', depth: 4, role: 'system' }
      meta.authors_note = { ...current, ...updates }
      if (!meta.authors_note.content?.trim()) {
        delete meta.authors_note
      }
      chatMetadataRef.current = meta
      chatsApi.update(chatId, { metadata: meta }).catch(console.error)
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
        <button className={styles.closeBtn} onClick={onClose} title="Close" type="button">
          <X size={12} />
        </button>
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
