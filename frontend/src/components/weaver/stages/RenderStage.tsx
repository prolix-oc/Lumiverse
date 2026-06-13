import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { useStore } from '@/store'
import type { WeaverField, WeaverFieldDef, WeaverSession } from '@/api/weaver'
import { Btn, FlagBand, Icon, IconBtn, renderFieldPreview, SDot, Tag } from '../primitives'
import styles from '../WeaverStudio.module.css'

function fieldStatusOf(def: WeaverFieldDef, field: WeaverField | undefined, rendering: string[]): string {
  if (rendering.includes(def.id)) return 'rendering'
  if (!field) return 'none'
  if (field.stale) return 'stale'
  if (field.status === 'passed' || field.status === 'manually_edited') return 'passed'
  if (field.status === 'flagged') return 'flagged'
  return 'none'
}

function RenderStatusTag({ status, revised }: { status: string; revised?: boolean }) {
  const { t } = useTranslation('weaver')
  if (status === 'rendering') {
    return <span className={clsx(styles.tag, styles.tagRendering)}><Icon name="refresh" size={11} spin /> {t('render.status.rendering')}</span>
  }
  if (status === 'passed') {
    return <Tag kind="success" icon="check">{t('render.status.passed')}{revised ? ` · ${t('render.status.revised')}` : ''}</Tag>
  }
  if (status === 'flagged') return <Tag kind="warning" icon="alert">{t('render.status.flagged')}</Tag>
  if (status === 'stale') return <Tag kind="warning">{t('render.status.stale')}</Tag>
  return <Tag kind="neutral">{t('render.notRenderedTag')}</Tag>
}

export function RenderStage({ session, onBack, onContinue }: { session: WeaverSession; onBack: () => void; onContinue: () => void }) {
  const { t } = useTranslation('weaver')
  const fieldDefs = useStore((s) => s.weaverFieldDefs)
  const fields = useStore((s) => (s.weaverStateSessionId === session.id ? s.weaverFields : []))
  const rendering = useStore((s) => s.weaverFieldRendering)
  const error = useStore((s) => s.weaverRenderError)
  const bible = useStore((s) => (s.weaverStateSessionId === session.id ? s.weaverBible : null))
  const loadFieldDefs = useStore((s) => s.loadWeaverFieldDefs)
  const loadFields = useStore((s) => s.loadWeaverFields)
  const loadBible = useStore((s) => s.loadWeaverBible)
  const renderAll = useStore((s) => s.renderWeaverFields)
  const renderOne = useStore((s) => s.renderWeaverField)
  const editOne = useStore((s) => s.editWeaverField)
  const acceptOne = useStore((s) => s.acceptWeaverField)
  const nudgeOne = useStore((s) => s.nudgeWeaverField)

  useEffect(() => {
    void loadFieldDefs(session.build_type)
    void loadFields(session.id)
    void loadBible(session.id)
  }, [session.id, session.build_type, loadFieldDefs, loadFields, loadBible])

  const orderedDefs = useMemo(() => [...fieldDefs].sort((a, b) => a.order - b.order), [fieldDefs])
  const fieldBy = useMemo(() => new Map(fields.map((f) => [f.field_name, f])), [fields])
  const anyRendering = rendering.length > 0
  const hasAny = fields.length > 0
  const allReady = useMemo(
    () =>
      orderedDefs.length > 0 &&
      orderedDefs.every((d) => {
        const f = fieldBy.get(d.id)
        return Boolean(f && f.content.trim() && (f.status === 'passed' || f.status === 'manually_edited' || f.provenance.accepted === true))
      }),
    [orderedDefs, fieldBy],
  )

  const [focusKey, setFocusKey] = useState<string | null>(null)
  const focusDef = useMemo(
    () => orderedDefs.find((d) => d.id === focusKey) ?? orderedDefs[0] ?? null,
    [orderedDefs, focusKey],
  )

  const spend = useMemo(
    () => fields.reduce((acc, f) => ({ total: acc.total + f.token_usage.total_tokens, calls: acc.calls + f.token_usage.calls }), { total: 0, calls: 0 }),
    [fields],
  )

  const failedBibleCrit = bible?.gate ? bible.gate.criteria.filter((c) => !c.passed).map((c) => c.label) : []

  return (
    <>
      <div className={styles.panel}>
        <div className={styles.stageHead}>
          <div className={styles.stageHeadL}>
            <h2 className={styles.stageH}>{t('render.heading')}</h2>
            <p className={styles.stageHelp}>{t('render.help')}</p>
          </div>
          {hasAny && <div className={styles.spend}>{t('render.spend', { count: spend.total, calls: spend.calls })}</div>}
        </div>
        <div className={styles.scroll}>
          {error && <p className={styles.errorText}>{error}</p>}
          {bible && bible.status === 'flagged' && (
            <div style={{ marginBottom: 24 }}>
              <FlagBand
                compact
                subject={t('render.bibleFlaggedSubject')}
                criteria={failedBibleCrit}
                detail={t('render.bibleFlaggedCompact')}
                note={t('render.flag.compactNote')}
                action={{ label: t('render.openBible'), onClick: onBack }}
              />
            </div>
          )}
          <div className={styles.work}>
            <div className={styles.workRail}>
              <div>
                <div className={styles.railGroupLabel}>{t('render.fieldsRail', { count: orderedDefs.length })}</div>
                <div className={styles.railList}>
                  {orderedDefs.map((def) => {
                    const st = fieldStatusOf(def, fieldBy.get(def.id), rendering)
                    const isFocus = focusDef?.id === def.id
                    const isDirect = def.render === 'direct'
                    return (
                      <div
                        key={def.id}
                        role="button"
                        tabIndex={0}
                        className={clsx(styles.railItem, isFocus && styles.railItemActive)}
                        onClick={() => setFocusKey(def.id)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFocusKey(def.id) } }}
                      >
                        <span className={styles.railMarker}><SDot status={st} /></span>
                        <span className={styles.railName}>{def.label}</span>
                        {!isDirect && (
                          <IconBtn
                            icon="refresh"
                            size={13}
                            cls={styles.sq22}
                            title={t('render.rerender')}
                            spin={st === 'rendering'}
                            disabled={anyRendering}
                            onClick={(e) => {
                              e.stopPropagation()
                              if (fieldBy.get(def.id)?.status === 'manually_edited') setFocusKey(def.id)
                              else void renderOne(session.id, def.id)
                            }}
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
                <div className={styles.railLegend}>
                  <span className={styles.railLegendRow}><SDot status="passed" /> {t('render.legend.passed')}</span>
                  <span className={styles.railLegendRow}><SDot status="flagged" /> {t('render.legend.flagged')}</span>
                  <span className={styles.railLegendRow}><SDot status="stale" /> {t('render.legend.stale')}</span>
                  <span className={styles.railLegendRow}><SDot status="none" /> {t('render.legend.none')}</span>
                </div>
              </div>
            </div>

            <div className={styles.workMain}>
              {focusDef && (
                <FieldView
                  def={focusDef}
                  field={fieldBy.get(focusDef.id)}
                  status={fieldStatusOf(focusDef, fieldBy.get(focusDef.id), rendering)}
                  anyRendering={anyRendering}
                  onReRender={(force) => void renderOne(session.id, focusDef.id, force)}
                  onEdit={(content) => void editOne(session.id, focusDef.id, content)}
                  onAccept={(accepted) => void acceptOne(session.id, focusDef.id, accepted)}
                  onNudge={(nudge, force) => void nudgeOne(session.id, focusDef.id, nudge, force)}
                />
              )}
            </div>
          </div>
        </div>
      </div>
      <div className={styles.footer}>
        <Btn icon="arrowLeft" onClick={onBack}>{t('render.backToBible')}</Btn>
        <Btn variant="primary" icon={anyRendering ? 'refresh' : 'sparkles'} spin={anyRendering} disabled={anyRendering} onClick={() => void renderAll(session.id)}>
          {anyRendering ? t('render.rendering') : hasAny ? t('render.renderAllAgain') : t('render.renderAll')}
        </Btn>
        <div className={styles.spacer} />
        <Btn
          iconRight="arrowRight"
          disabled={!allReady || anyRendering}
          title={allReady ? t('render.continueToFinalize') : t('render.finalizeBlocked')}
          onClick={onContinue}
        >
          {t('render.continueToFinalize')}
        </Btn>
      </div>
    </>
  )
}

function FieldView({ def, field, status, anyRendering, onReRender, onEdit, onAccept, onNudge }: {
  def: WeaverFieldDef
  field: WeaverField | undefined
  status: string
  anyRendering: boolean
  onReRender: (force?: boolean) => void
  onEdit: (content: string) => void
  onAccept: (accepted: boolean) => void
  onNudge: (nudge: string, force?: boolean) => void
}) {
  const { t } = useTranslation('weaver')
  const isDirect = def.render === 'direct'
  const isRendered = Boolean(field)
  const isEdited = field?.status === 'manually_edited'
  const accepted = field?.provenance.accepted === true
  const stale = field?.stale === true
  const busy = status === 'rendering' || anyRendering

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [nudge, setNudge] = useState('')
  const [pending, setPending] = useState<null | { kind: 'render' } | { kind: 'nudge'; text: string }>(null)

  useEffect(() => { setEditing(false); setNudge(''); setPending(null) }, [def.id])

  const beginEdit = () => { setDraft(field?.content ?? ''); setEditing(true) }
  const requestReRender = () => { if (isEdited) setPending({ kind: 'render' }); else onReRender() }
  const submitNudge = () => {
    const text = nudge.trim()
    if (!text) return
    if (isEdited) { setPending({ kind: 'nudge', text }); return }
    onNudge(text); setNudge('')
  }
  const runPending = () => {
    if (!pending) return
    if (pending.kind === 'render') onReRender(true)
    else { onNudge(pending.text, true); setNudge('') }
    setPending(null)
  }

  return (
    <div>
      <div className={styles.fieldHead}>
        <div className={styles.fieldHeadL}>
          <span className={styles.fieldTitle}>{def.label}</span>
          {isDirect && <span className={styles.fieldSub}>{t('render.directFieldNote')}</span>}
        </div>
        <div className={styles.fieldHeadR}>
          <RenderStatusTag status={status} revised={field?.provenance.revised} />
          {isEdited && <Tag kind="neutral" icon="pencil">{t('render.editTag')}</Tag>}
          {accepted && <Tag kind="success" icon="check">{t('render.acceptedTag')}</Tag>}
          {isRendered && !editing && <IconBtn icon="pencil" size={15} cls={styles.sq26} title={t('render.edit')} disabled={busy} onClick={beginEdit} />}
          {!isDirect && <IconBtn icon="refresh" size={15} cls={styles.sq26} title={t('render.rerender')} spin={status === 'rendering'} disabled={anyRendering} onClick={requestReRender} />}
        </div>
      </div>

      {stale && !editing && status !== 'rendering' && (
        <FlagBand
          inField
          subject={def.label}
          detail={isEdited ? t('render.staleBodyEdited') : t('render.staleBody')}
          fix={t('render.staleTitle')}
          note={t('render.noRetryNote')}
          action={{ label: t('render.rerender'), onClick: requestReRender }}
        />
      )}

      {pending && (
        <FlagBand
          inField
          subject={t('render.replaceEditTitle')}
          detail={t('render.replaceEditBody')}
          note={t('render.noRetryNote')}
          action={{ label: t('render.replaceEdit'), onClick: runPending }}
        />
      )}

      {status === 'rendering' ? (
        <div className={styles.fieldRendering}><Icon name="refresh" size={16} spin /> {t('render.renderingField', { field: def.label })}</div>
      ) : editing ? (
        <div className={styles.editArea}>
          <textarea
            className={styles.field}
            value={draft}
            rows={isDirect ? 2 : 12}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className={styles.editActions}>
            <Btn onClick={() => setEditing(false)}>{t('render.editCancel')}</Btn>
            <Btn variant="primary" disabled={!draft.trim()} onClick={() => { onEdit(draft); setEditing(false) }}>{t('render.editSave')}</Btn>
          </div>
        </div>
      ) : !field || !field.content ? (
        <div className={styles.fieldEmpty}>{field?.status === 'flagged' ? t('render.flaggedNoContent') : t('render.notRendered')}</div>
      ) : isDirect ? (
        <div className={styles.fieldNameBig}>{field.content}</div>
      ) : (
        <div className={styles.fieldBody} dangerouslySetInnerHTML={{ __html: renderFieldPreview(def.kind, field.content) }} />
      )}

      {status === 'flagged' && field?.provenance.gate && !editing && (
        <FlagBand
          inField
          subject={t('render.fieldFlaggedSubject', { field: def.label })}
          criteria={field.provenance.gate.criteria.filter((c) => !c.passed).map((c) => c.label)}
          detail={field.provenance.gate.summary}
          fix={t('render.fieldFlaggedFix')}
          note={t('render.noRetryNote')}
        />
      )}

      {isRendered && !editing && status !== 'rendering' && (
        <div className={styles.fieldTools}>
          <Btn icon={accepted ? 'check' : null} disabled={busy} onClick={() => onAccept(!accepted)}>
            {accepted ? t('render.unaccept') : t('render.accept')}
          </Btn>
          {!isDirect && (
            <div className={styles.toolRow}>
              <input
                className={styles.toolin}
                value={nudge}
                placeholder={t('render.nudgePlaceholder')}
                disabled={anyRendering}
                onChange={(e) => setNudge(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitNudge() } }}
              />
              <Btn icon="sparkles" disabled={anyRendering || !nudge.trim()} onClick={submitNudge}>{t('render.nudgeRun')}</Btn>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
