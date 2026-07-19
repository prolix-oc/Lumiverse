import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { CloseButton } from '@/components/shared/CloseButton'
import { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import NumericInput from '@/components/shared/NumericInput'
import { chatsApi } from '@/api/chats'
import styles from './AuthorsNotePanel.module.css'

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
  const { t } = useTranslation('chat')
  const [noteText, setNoteText] = useState('')
  const [depth, setDepth] = useState(4)
  const [role, setRole] = useState<'system' | 'user' | 'assistant'>('system')
  const [enabled, setEnabled] = useState(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentNoteRef = useRef<AuthorsNote>({ content: '', depth: 4, role: 'system' })

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
    currentNoteRef.current = { ...currentNoteRef.current, ...updates }
    saveTimerRef.current = setTimeout(() => {
      const next = currentNoteRef.current
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

  const handleTextChange = useCallback((val: string) => {
    setNoteText(val)
    setEnabled(!!val.trim())
    scheduleSave({ content: val })
  }, [scheduleSave])

  const handleDepthChange = useCallback((value: number | null) => {
    const val = Math.max(0, Math.min(9999, value ?? 0))
    setDepth(val)
    scheduleSave({ depth: val })
  }, [scheduleSave])

  const handleRoleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value as 'system' | 'user' | 'assistant'
    setRole(val)
    scheduleSave({ role: val })
  }, [scheduleSave])

  useEffect(() => {
    if (!isOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const roles = ['system', 'user', 'assistant'] as const

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>
          {t('authorsNote.title')}{enabled ? ` ${t('authorsNote.active')}` : ''}
        </span>
        <CloseButton onClick={onClose} size="sm" iconSize={12} className={styles.closeBtn} />
      </div>

      <div className={styles.body}>
        <div className={styles.field}>
          <ExpandableTextarea
            name="authors-note"
            aria-label={t('authorsNote.ariaLabel')}
            className={styles.textarea}
            rows={3}
            value={noteText}
            onChange={handleTextChange}
            title={t('authorsNote.title')}
            placeholder={t('authorsNote.placeholder')}
          />
        </div>

        <div className={styles.row}>
          <div className={styles.field}>
            <label className={styles.label}>{t('authorsNote.depth')}</label>
            <NumericInput
              className={styles.input}
              min={0}
              max={9999}
              value={depth}
              integer
              onChange={handleDepthChange}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>{t('authorsNote.role')}</label>
            <select
              name="authors-note-role"
              aria-label={t('authorsNote.roleAria')}
              className={styles.select}
              value={role}
              onChange={handleRoleChange}
            >
              {roles.map((r) => (
                <option key={r} value={r}>{t(`roles.${r}`)}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  )
}
