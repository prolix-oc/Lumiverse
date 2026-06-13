import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import type { Character } from '@/types/api'
import type { WeaverSession } from '@/api/weaver'
import { Btn, Icon, formatFinalized } from '../primitives'
import styles from '../WeaverStudio.module.css'

function words(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

interface CardRow {
  id: string
  label: string
  text: string
}

function FieldRow({ row, emptyText }: { row: CardRow; emptyText: string }) {
  const [open, setOpen] = useState(false)
  const empty = !row.text.trim()
  return (
    <div
      className={styles.cardField}
      role="button"
      tabIndex={0}
      onClick={() => setOpen((o) => !o)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o) } }}
    >
      <span className={styles.cardFieldLabel}>{row.label}</span>
      <span className={clsx(styles.cardFieldText, !open && styles.cardFieldClamp, empty && styles.cardFieldEmpty)}>
        {empty ? emptyText : row.text}
      </span>
      <span className={styles.cardFieldCount}>{words(row.text)} w</span>
    </div>
  )
}

export function OverviewPane({ character, session, onBuild }: {
  character: Character
  session: WeaverSession
  onBuild: () => void
}) {
  const { t } = useTranslation('weaver')

  const rows: CardRow[] = [
    { id: 'name', label: t('dashboard.card.fields.name'), text: character.name },
    { id: 'description', label: t('dashboard.card.fields.description'), text: character.description },
    { id: 'personality', label: t('dashboard.card.fields.personality'), text: character.personality },
    { id: 'scenario', label: t('dashboard.card.fields.scenario'), text: character.scenario },
    { id: 'first_mes', label: t('dashboard.card.fields.firstMessage'), text: character.first_mes },
    { id: 'mes_example', label: t('dashboard.card.fields.exampleDialogue'), text: character.mes_example },
    ...character.alternate_greetings.map((g, i) => ({
      id: `greeting-${i}`,
      label: t('dashboard.card.fields.greetingN', { n: i + 1 }),
      text: g,
    })),
  ]

  const prov = session.seed.provenance
  const isRebuild = prov.import_kind === 'card' && typeof prov.original_name === 'string'

  return (
    <div className={styles.dashPaneInner}>
      <div className={styles.cardPane}>
        <div className={styles.cardPaneHead}>
          <span className={styles.cardPaneTitle}>{t('dashboard.card.title')}</span>
          <span className={styles.cardPaneCount}>
            {t('dashboard.card.meta', { count: rows.length, date: formatFinalized(character.created_at) })}
          </span>
          <span className={styles.spacer} />
          <Btn icon="pencil" onClick={onBuild}>{t('dashboard.card.editFields')}</Btn>
        </div>

        {isRebuild && (
          <div className={styles.cardProv}>
            <Icon name="fileUp" size={14} />
            {t('dashboard.card.rebuiltFrom', { name: String(prov.original_name) })}
            <span className={styles.cardProvDim}>{t('dashboard.card.originalNote')}</span>
          </div>
        )}

        <div>
          {rows.map((row) => (
            <FieldRow key={row.id} row={row} emptyText={t('dashboard.card.emptyField')} />
          ))}
        </div>
      </div>
    </div>
  )
}
