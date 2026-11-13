import { useState, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Layers } from 'lucide-react'
import { useStore } from '@/store'
import { chatsApi } from '@/api/chats'
import styles from './AlternateFieldSwitcher.module.css'
import clsx from 'clsx'

interface AlternateFieldVariant {
  id: string
  label: string
  content: string
}

const FIELDS = ['description', 'personality', 'scenario'] as const

export default function AlternateFieldSwitcher({ chatId }: { chatId: string }) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const [selections, setSelections] = useState<Record<string, string>>({})
  const [chatMetadata, setChatMetadata] = useState<Record<string, any> | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const characters = useStore((s) => s.characters)

  const character = characters.find((c) => c.id === activeCharacterId)

  const altFields = character?.extensions?.alternate_fields as
    | Record<string, AlternateFieldVariant[]>
    | undefined

  const hasAlternates =
    altFields && Object.values(altFields).some((arr) => Array.isArray(arr) && arr.length > 0)

  const fieldLabel = useCallback((field: string) => {
    return t(`fields.${field}` as 'fields.description')
  }, [t])

  useEffect(() => {
    if (!chatId || !hasAlternates) return
    let cancelled = false
    chatsApi.get(chatId, { messages: false }).then((chat) => {
      if (cancelled) return
      setChatMetadata(chat.metadata || {})
      setSelections((chat.metadata?.alternate_field_selections as Record<string, string>) || {})
    }).catch(() => {})
    return () => { cancelled = true }
  }, [chatId, hasAlternates])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleSelect = useCallback(
    async (field: string, variantId: string | null) => {
      const newSelections = { ...selections }
      if (variantId) {
        newSelections[field] = variantId
      } else {
        delete newSelections[field]
      }
      setSelections(newSelections)

      const newMetadata = { ...(chatMetadata || {}), alternate_field_selections: newSelections }
      const payload = Object.keys(newSelections).length > 0
        ? { alternate_field_selections: newSelections }
        : { alternate_field_selections: null }
      if (Object.keys(newSelections).length === 0) {
        delete newMetadata.alternate_field_selections
      }

      try {
        await chatsApi.patchMetadata(chatId, payload)
        setChatMetadata(newMetadata)
      } catch (err) {
        console.error('[AlternateFieldSwitcher] Failed to save:', err)
      }
    },
    [chatId, chatMetadata, selections]
  )

  if (!hasAlternates) return null

  const hasActiveSelection = Object.keys(selections).length > 0

  return (
    <div className={styles.wrapper} ref={ref}>
      <button
        type="button"
        className={clsx(styles.triggerBtn, open && styles.triggerBtnActive)}
        onClick={() => setOpen((v) => !v)}
        title={t('alternateFieldSwitcher.title')}
      >
        <Layers size={14} />
        {hasActiveSelection && <span className={styles.badge} />}
      </button>

      {open && (
        <div className={styles.popover}>
          <div className={styles.popoverTitle}>{t('alternateFieldSwitcher.panelTitle')}</div>
          {FIELDS.map((field) => {
            const variants = altFields?.[field]
            if (!Array.isArray(variants) || variants.length === 0) return null
            const selectedId = selections[field] || null
            const label = fieldLabel(field)

            return (
              <div key={field} className={styles.fieldRow}>
                <span className={styles.fieldLabel}>{label}</span>
                <select
                  name={`alt-field-${field}`}
                  aria-label={label}
                  className={styles.fieldSelect}
                  value={selectedId || ''}
                  onChange={(e) => handleSelect(field, e.target.value || null)}
                >
                  <option value="">{t('defaultOption')}</option>
                  {variants.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
