import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { useStore } from '@/store'
import { charactersApi } from '@/api/characters'
import type { Character } from '@/types/api'
import type { WeaverSession } from '@/api/weaver'
import { Btn, Icon, IconBtn, formatFinalized } from '../primitives'
import styles from '../WeaverStudio.module.css'

function words(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

interface CardRow {
  id: string
  label: string
  text: string
  charlField: string
  greetingIndex?: number
}

function FieldRow({ row, emptyText, editTitle, onSave }: {
  row: CardRow
  emptyText: string
  editTitle: string
  onSave: (value: string) => Promise<void>
}) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(row.text)
  const [saving, setSaving] = useState(false)
  const empty = !row.text.trim()

  useEffect(() => { setDraft(row.text) }, [row.text])

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation()
    setDraft(row.text)
    setEditing(true)
    setOpen(true)
  }
  const cancel = () => { setEditing(false); setDraft(row.text) }
  const save = async () => {
    if (draft === row.text) { setEditing(false); return }
    setSaving(true)
    try { await onSave(draft); setEditing(false) } finally { setSaving(false) }
  }

  if (editing) {
    return (
      <div className={styles.cardField}>
        <span className={styles.cardFieldLabel}>{row.label}</span>
        <div className={styles.cardFieldEdit}>
          <textarea
            className={clsx(styles.field, styles.cardFieldArea)}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') cancel() }}
          />
          <div className={styles.cardFieldEditActions}>
            <Btn icon={saving ? 'refresh' : 'check'} spin={saving} disabled={saving} onClick={() => void save()}>
              {t('actions.save')}
            </Btn>
            <Btn icon="x" disabled={saving} onClick={cancel}>{t('actions.cancel')}</Btn>
          </div>
        </div>
        <span className={styles.cardFieldCount}>{words(draft)} w</span>
      </div>
    )
  }

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
      <span className={styles.cardFieldRight}>
        <IconBtn icon="pencil" size={13} title={editTitle} onClick={startEdit} />
        <span className={styles.cardFieldCount}>{words(row.text)} w</span>
      </span>
    </div>
  )
}

export function OverviewPane({ character, session, onBuild, onCharacterUpdate }: {
  character: Character
  session: WeaverSession
  onBuild: () => void
  onCharacterUpdate: (character: Character) => void
}) {
  const { t } = useTranslation('weaver')
  const editWeaverField = useStore((s) => s.editWeaverField)
  const fieldDefs = useStore((s) => s.weaverFieldDefs)
  const loadFieldDefs = useStore((s) => s.loadWeaverFieldDefs)

  useEffect(() => {
    if (fieldDefs.length === 0) void loadFieldDefs(session.build_type)
  }, [fieldDefs.length, loadFieldDefs, session.build_type])

  const defIdByCharlField = useMemo(() => {
    const m = new Map<string, string>()
    fieldDefs.forEach((d) => m.set(d.charlField, d.id))
    return m
  }, [fieldDefs])

  const rows: CardRow[] = [
    { id: 'name', charlField: 'name', label: t('dashboard.card.fields.name'), text: character.name },
    { id: 'description', charlField: 'description', label: t('dashboard.card.fields.description'), text: character.description },
    { id: 'personality', charlField: 'personality', label: t('dashboard.card.fields.personality'), text: character.personality },
    { id: 'scenario', charlField: 'scenario', label: t('dashboard.card.fields.scenario'), text: character.scenario },
    { id: 'first_mes', charlField: 'first_mes', label: t('dashboard.card.fields.firstMessage'), text: character.first_mes },
    { id: 'mes_example', charlField: 'mes_example', label: t('dashboard.card.fields.exampleDialogue'), text: character.mes_example },
    ...character.alternate_greetings.map((g, i) => ({
      id: `greeting-${i}`,
      charlField: 'alternate_greetings',
      greetingIndex: i,
      label: t('dashboard.card.fields.greetingN', { n: i + 1 }),
      text: g,
    })),
  ]

  const saveRow = useCallback(async (row: CardRow, value: string) => {
    if (row.greetingIndex !== undefined) {
      const greetings = [...character.alternate_greetings]
      greetings[row.greetingIndex] = value
      const updated = await charactersApi.update(character.id, { alternate_greetings: greetings })
      onCharacterUpdate(updated)
      return
    }
    const updated = await charactersApi.update(character.id, { [row.charlField]: value })
    onCharacterUpdate(updated)
    const fieldId = defIdByCharlField.get(row.charlField) ?? row.charlField
    try { await editWeaverField(session.id, fieldId, value) } catch { /* sync is best-effort */ }
  }, [character, onCharacterUpdate, defIdByCharlField, editWeaverField, session.id])

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
            <FieldRow
              key={row.id}
              row={row}
              emptyText={t('dashboard.card.emptyField')}
              editTitle={t('dashboard.card.editField')}
              onSave={(value) => saveRow(row, value)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
