import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import { expressionsApi } from '@/api/expressions'
import styles from './LorebookImportModal.module.css'

export interface ExpressionsImportInfo {
  characterId: string
  characterName: string
  expressionCount: number
}

interface Props {
  isOpen: boolean
  items: ExpressionsImportInfo[]
  onClose: () => void
}

export default function ExpressionsImportModal({ isOpen, items, onClose }: Props) {
  const { t } = useTranslation('modals')
  const [selected, setSelected] = useState<Set<string>>(new Set(items.map((i) => i.characterId)))
  const [enabling, setEnabling] = useState(false)

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleEnable = useCallback(async () => {
    setEnabling(true)
    try {
      for (const item of items) {
        if (!selected.has(item.characterId)) continue
        const config = await expressionsApi.get(item.characterId)
        if (config && !config.enabled) {
          await expressionsApi.put(item.characterId, { ...config, enabled: true })
        }
      }
    } finally {
      setEnabling(false)
      onClose()
    }
  }, [items, selected, onClose])

  return (
    <ModalShell isOpen={isOpen && items.length > 0} onClose={onClose} maxWidth={580}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.title}>{t('expressionsImport.title')}</span>
          <span className={styles.badge}>{items.length}</span>
        </div>
        <CloseButton onClick={onClose} />
      </div>

      <div className={styles.body}>
        <p style={{ fontSize: 12, color: 'var(--lumiverse-text-dim)', margin: '0 0 8px' }}>
          {t('expressionsImport.intro')}
        </p>
        <div className={styles.lorebookList}>
          {items.map((item) => (
            <label key={item.characterId} className={styles.lorebookItem}>
              <input
                type="checkbox"
                checked={selected.has(item.characterId)}
                onChange={() => toggle(item.characterId)}
              />
              <div className={styles.lorebookInfo}>
                <span className={styles.lorebookName}>{item.characterName}</span>
              </div>
              <span className={styles.entryBadge}>
                {item.expressionCount}{' '}
                {item.expressionCount === 1
                  ? t('expressionsImport.expression')
                  : t('expressionsImport.expressions')}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className={styles.footer}>
        <Button variant="ghost" onClick={onClose}>
          {t('expressionsImport.skip')}
        </Button>
        <Button
          variant="primary"
          disabled={selected.size === 0 || enabling}
          onClick={handleEnable}
        >
          {enabling
            ? t('expressionsImport.enabling')
            : t('expressionsImport.enable', { count: selected.size })}
        </Button>
      </div>
    </ModalShell>
  )
}
