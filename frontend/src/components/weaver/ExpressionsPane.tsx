import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { wsClient } from '@/ws/client'
import { EventType } from '@/types/ws-events'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import { imagesApi } from '@/api/images'
import { expressionsApi } from '@/api/expressions'
import * as weaverApi from '@/api/weaver'
import type {
  WeaverVisualCandidate,
  WeaverVisualImageInputSupport,
  WeaverVisualJob,
  WeaverVisualVariantDef,
} from '@/api/weaver'
import type { Character, ImageGenConnectionProfile, ImageGenParameterSchema, ImageGenProviderInfo } from '@/types/api'
import { Btn, Icon, IconBtn } from './primitives'
import { ParamField } from './VisualParamField'
import shared from './PortraitPane.module.css'
import styles from './ExpressionsPane.module.css'

const KIND = 'expressions'

const SKIP_PARAMS = new Set([
  'negativePrompt', 'rawRequestOverride', 'workflow', 'prompt',
  'width', 'height', 'size', 'resolution', 'aspectRatio', 'aspect_ratio', 'seed',
])

const COMFY_ALLOWED = new Set(['denoise'])

function isComfyProvider(provider: string | undefined): boolean {
  return provider === 'comfyui' || provider === 'swarmui'
}

interface ExpressionsPaneProps {
  sessionId: string
  character: Character
  onCount?: (count: number) => void
}

export function ExpressionsPane({ sessionId, character, onCount }: ExpressionsPaneProps) {
  const { t } = useTranslation('weaver')
  const [connections, setConnections] = useState<ImageGenConnectionProfile[]>([])
  const [providers, setProviders] = useState<ImageGenProviderInfo[]>([])
  const [connId, setConnId] = useState<string | null>(null)
  const [support, setSupport] = useState<WeaverVisualImageInputSupport | null>(null)
  const [variants, setVariants] = useState<WeaverVisualVariantDef[]>([])
  const [config, setConfig] = useState<weaverApi.WeaverExpressionConfig | null>(null)
  const [candidates, setCandidates] = useState<Record<string, WeaverVisualCandidate[]>>({})
  const [basePrompt, setBasePrompt] = useState('')
  const [baseNegative, setBaseNegative] = useState('')
  const [params, setParams] = useState<Record<string, any>>({})
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [customDraft, setCustomDraft] = useState('')
  const [customLabels, setCustomLabels] = useState<string[]>([])
  const [running, setRunning] = useState<string | null>(null)
  const [batching, setBatching] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [committing, setCommitting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const jobIdRef = useRef<string | null>(null)
  const queueRef = useRef<string[]>([])
  const startRef = useRef<(label: string) => Promise<void>>(async () => {})

  const sourceId = character.image_id
  const mappings = useMemo(() => config?.mappings ?? {}, [config])

  const labels = useMemo(() => {
    const out = variants.map((v) => v.id)
    for (const label of Object.keys(mappings)) if (!out.includes(label)) out.push(label)
    for (const label of customLabels) if (!out.includes(label)) out.push(label)
    return out
  }, [variants, mappings, customLabels])

  useEffect(() => { onCount?.(Object.keys(mappings).length) }, [mappings, onCount])

  const activeConnection = connections.find((c) => c.id === connId) ?? null
  const isComfy = isComfyProvider(activeConnection?.provider)
  const schema: Record<string, ImageGenParameterSchema> = useMemo(() => {
    const provider = providers.find((p) => p.id === activeConnection?.provider)
    return provider?.capabilities.parameters ?? {}
  }, [providers, activeConnection])
  const advancedParams = useMemo(
    () => Object.entries(schema).filter(([key]) =>
      isComfy ? COMFY_ALLOWED.has(key) : !SKIP_PARAMS.has(key)),
    [schema, isComfy],
  )

  useEffect(() => {
    void imageGenConnectionsApi.list({ limit: 100 }).then((r) => {
      setConnections(r.data)
      const preferred = r.data.find((c) => c.is_default) ?? r.data[0]
      setConnId((prev) => prev ?? preferred?.id ?? null)
    })
    void imageGenConnectionsApi.providers().then((r) => {
      if (r.providers?.length) setProviders(r.providers)
    })
    void weaverApi.getVisualKinds().then((kinds) => {
      setVariants(kinds.find((k) => k.id === KIND)?.variants ?? [])
    })
    void expressionsApi.get(character.id).then(setConfig).catch(() => setConfig(null))
  }, [sessionId, character.id])

  useEffect(() => {
    if (!connId) { setSupport(null); return }
    let alive = true
    void weaverApi.getVisualImageInput(sessionId, connId)
      .then((s) => { if (alive) setSupport(s) })
      .catch(() => { if (alive) setSupport(null) })
    return () => { alive = false }
  }, [sessionId, connId])

  const refreshLabel = useCallback(async (label: string) => {
    try {
      const res = await weaverApi.listVisualCandidates(sessionId, KIND, label)
      setCandidates((prev) => ({ ...prev, [label]: res.data }))
    } catch {
      /* non-fatal */
    }
  }, [sessionId])

  useEffect(() => {
    for (const label of labels) {
      if (!(label in candidates)) void refreshLabel(label)
    }
  }, [labels, candidates, refreshLabel])

  const startGenerate = useCallback(async (label: string) => {
    if (!connId || !sourceId) return
    setError(null)
    setRunning(label)
    try {
      const job = await weaverApi.generateVisual(sessionId, {
        kind: KIND,
        variant: label,
        prompt: basePrompt.trim(),
        negative_prompt: baseNegative.trim() || undefined,
        connection_id: connId,
        source_image_id: sourceId,
        provider_state: Object.keys(params).length ? { params } : undefined,
      })
      jobIdRef.current = job.id
    } catch (err: any) {
      jobIdRef.current = null
      setRunning(null)
      setError(err?.body?.error ?? err?.message ?? t('dashboard.expressions.genFailed'))
      queueRef.current = []
      setBatching(false)
    }
  }, [connId, sourceId, sessionId, basePrompt, baseNegative, params, t])
  useEffect(() => { startRef.current = startGenerate }, [startGenerate])

  const advanceQueue = useCallback(() => {
    const next = queueRef.current.shift()
    if (next) {
      void startRef.current(next)
    } else {
      setBatching(false)
      setRunning(null)
    }
  }, [])

  useEffect(() => {
    const unsubs = [
      wsClient.on(EventType.WEAVER_VISUAL_JOB_COMPLETED, (job: WeaverVisualJob) => {
        if (job.id !== jobIdRef.current) return
        jobIdRef.current = null
        if (job.variant) void refreshLabel(job.variant)
        advanceQueue()
      }),
      wsClient.on(EventType.WEAVER_VISUAL_JOB_FAILED, (job: WeaverVisualJob) => {
        if (job.id !== jobIdRef.current) return
        jobIdRef.current = null
        setError(job.error ?? t('dashboard.expressions.genFailed'))
        queueRef.current = []
        setBatching(false)
        setRunning(null)
      }),
    ]
    return () => unsubs.forEach((u) => u())
  }, [advanceQueue, refreshLabel, t])

  const generateAll = useCallback(() => {
    const pending = labels.filter((l) => !mappings[l])
    if (pending.length === 0 || running) return
    queueRef.current = pending.slice(1)
    setBatching(true)
    void startGenerate(pending[0])
  }, [labels, mappings, running, startGenerate])

  const stopBatch = useCallback(() => {
    queueRef.current = []
    setBatching(false)
  }, [])

  const suggest = useCallback(async () => {
    if (suggesting) return
    setSuggesting(true)
    setError(null)
    try {
      const r = await weaverApi.suggestVisualTags(sessionId)
      setBasePrompt(r.suggestedTags)
      if (r.suggestedNegativeTags) setBaseNegative(r.suggestedNegativeTags)
    } catch (err: any) {
      setError(err?.message ?? t('dashboard.portrait.suggestFailed'))
    } finally {
      setSuggesting(false)
    }
  }, [suggesting, sessionId, t])

  const commit = useCallback(async (label: string, candidate: WeaverVisualCandidate) => {
    if (committing) return
    setCommitting(label)
    setError(null)
    try {
      setConfig(await weaverApi.commitExpressions(sessionId, { [label]: candidate.id }))
    } catch (err: any) {
      setError(err?.body?.error ?? err?.message ?? t('dashboard.expressions.commitFailed'))
    } finally {
      setCommitting(null)
    }
  }, [committing, sessionId, t])

  const removeCandidate = useCallback(async (label: string, candidate: WeaverVisualCandidate) => {
    try {
      await imagesApi.delete(candidate.id)
      setCandidates((prev) => ({
        ...prev,
        [label]: (prev[label] ?? []).filter((c) => c.id !== candidate.id),
      }))
    } catch {
      setError(t('dashboard.portrait.deleteFailed'))
    }
  }, [t])

  const addCustom = useCallback(() => {
    const label = customDraft.trim().toLowerCase().replace(/[^a-z0-9_\- ]/g, '').trim()
    if (!label || labels.includes(label)) { setCustomDraft(''); return }
    setCustomLabels((prev) => [...prev, label])
    setCustomDraft('')
  }, [customDraft, labels])

  if (!sourceId) {
    return (
      <div className={styles.pane}>
        <div className={shared.head}>
          <h2 className={shared.title}>{t('dashboard.rail.expressions')}</h2>
          <p className={shared.sub}>{t('dashboard.expressions.sub')}</p>
        </div>
        <div className={styles.emptyPane}>
          <div className={styles.emptyFrame}><Icon name="smile" size={24} /></div>
          <p>{t('dashboard.expressions.noPortrait')}</p>
        </div>
      </div>
    )
  }

  const gated = support !== null && !support.supported
  const isEdit = support?.mechanism === 'edit'
  const busyLabel = running ?? committing

  return (
    <div className={styles.pane}>
      <div className={shared.head}>
        <h2 className={shared.title}>{t('dashboard.rail.expressions')}</h2>
        <p className={shared.sub}>{t('dashboard.expressions.sub')}</p>
      </div>
      <div className={styles.body}>
        <div className={styles.gridCol}>
          {error && <div className={shared.error}><Icon name="alert" size={14} />{error}</div>}
          {gated && (
            <div className={styles.gateNote}>
              <Icon name="alert" size={14} />
              {support?.reason ?? t('dashboard.expressions.gateGeneric')}
            </div>
          )}
          <div className={styles.grid} style={gated || error ? { marginTop: 12 } : undefined}>
            {labels.map((label) => {
              const cell = candidates[label] ?? []
              const latest = cell[0] ?? null
              const committedImageId = mappings[label]
              const imgUrl = latest?.url ?? (committedImageId ? imagesApi.largeUrl(committedImageId) : null)
              const isCommittedShown = !latest && Boolean(committedImageId)
              const cellRunning = running === label
              return (
                <div key={label} className={committedImageId ? `${styles.cell} ${styles.cellCommitted}` : styles.cell}>
                  <div className={styles.cellImgWrap}>
                    {imgUrl
                      ? <img className={styles.cellImg} src={imgUrl} alt={label} />
                      : <span className={styles.cellEmpty}><Icon name="smile" size={20} /></span>}
                    {committedImageId && (latest?.id === committedImageId || isCommittedShown) && (
                      <span className={styles.cellBadge}><Icon name="check" size={10} />{t('dashboard.expressions.inUse')}</span>
                    )}
                    {cellRunning && (
                      <span className={styles.cellWorking}><Icon name="refresh" size={18} spin /></span>
                    )}
                  </div>
                  <div className={styles.cellBar}>
                    <span className={styles.cellLabel}>{label}</span>
                    {latest && latest.id !== committedImageId && (
                      <IconBtn
                        icon="check"
                        title={t('dashboard.expressions.use')}
                        disabled={busyLabel !== null}
                        onClick={() => void commit(label, latest)}
                      />
                    )}
                    {latest && latest.id !== committedImageId && (
                      <IconBtn
                        icon="trash"
                        title={t('dashboard.portrait.delete')}
                        disabled={busyLabel !== null}
                        onClick={() => void removeCandidate(label, latest)}
                      />
                    )}
                    <IconBtn
                      icon={latest || committedImageId ? 'refresh' : 'sparkles'}
                      title={t('dashboard.expressions.generateCell')}
                      disabled={gated || running !== null}
                      onClick={() => void startGenerate(label)}
                    />
                  </div>
                </div>
              )
            })}
          </div>
          <div className={styles.addRow}>
            <input
              className={styles.addInput}
              value={customDraft}
              placeholder={t('dashboard.expressions.addPlaceholder')}
              onChange={(e) => setCustomDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addCustom() }}
            />
            <Btn icon="plus" disabled={!customDraft.trim()} onClick={addCustom}>{t('dashboard.expressions.add')}</Btn>
          </div>
        </div>

        <div className={styles.controls}>
          <div className={shared.band}>
            <div className={shared.bandHead}><span className={shared.bandLabel}>{t('dashboard.portrait.adapter')}</span></div>
            <div className={shared.adapterRow}>
              <span className={shared.fieldLabel}>{t('dashboard.portrait.connection')}</span>
              {connections.length === 0 ? (
                <span className={shared.adapterEmpty}>{t('dashboard.portrait.noConnections')}</span>
              ) : (
                <select className={shared.select} value={connId ?? ''} disabled={running !== null} onChange={(e) => setConnId(e.target.value || null)}>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} · {c.provider}</option>
                  ))}
                </select>
              )}
            </div>
            {support?.supported && (
              <p className={styles.mechanismNote}>
                {t(`dashboard.expressions.mechanism.${support.mechanism}`, { defaultValue: '' })}
              </p>
            )}
          </div>

          {!isEdit && (
            <>
              <div className={shared.band}>
                <div className={shared.bandHead}>
                  <span className={shared.bandLabel}>{t('dashboard.expressions.basePromptLabel')}</span>
                  <button type="button" className={shared.suggest} disabled={suggesting || running !== null} onClick={() => void suggest()}>
                    <Icon name={suggesting ? 'refresh' : 'sparkles'} size={12} spin={suggesting} />
                    {suggesting ? t('dashboard.portrait.suggesting') : t('dashboard.portrait.suggestTags')}
                  </button>
                </div>
                <textarea
                  className={shared.tags}
                  rows={3}
                  value={basePrompt}
                  disabled={running !== null}
                  onChange={(e) => setBasePrompt(e.target.value)}
                  placeholder={t('dashboard.expressions.basePromptPlaceholder')}
                />
              </div>
              <div className={shared.band}>
                <div className={shared.bandHead}><span className={shared.bandLabel}>{t('dashboard.portrait.negativeLabel')}</span></div>
                <textarea
                  className={shared.tags}
                  rows={2}
                  value={baseNegative}
                  disabled={running !== null}
                  onChange={(e) => setBaseNegative(e.target.value)}
                  placeholder={t('dashboard.portrait.negativePlaceholder')}
                />
              </div>
            </>
          )}
          {isEdit && (
            <p className={styles.mechanismNote}>{t('dashboard.expressions.editNoPrompt')}</p>
          )}

          {advancedParams.length > 0 && (
            <div className={shared.band}>
              <button type="button" className={shared.advancedToggle} onClick={() => setAdvancedOpen((v) => !v)}>
                <Icon name={advancedOpen ? 'chevronDown' : 'chevronRight'} size={13} />
                {t('dashboard.portrait.advanced')}
              </button>
              {advancedOpen && (
                <div className={shared.paramGrid}>
                  {advancedParams.map(([key, ps]) => (
                    <ParamField
                      key={key}
                      paramKey={key}
                      schema={ps}
                      value={params[key] ?? ps.default}
                      disabled={running !== null}
                      onChange={(v) => setParams((prev) => ({ ...prev, [key]: v }))}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className={shared.paneFooter}>
        {batching && (
          <Btn icon="x" onClick={stopBatch}>{t('dashboard.expressions.stop')}</Btn>
        )}
        <Btn
          variant="primary"
          icon={running ? 'refresh' : 'sparkles'}
          spin={running !== null}
          disabled={gated || running !== null || labels.every((l) => Boolean(mappings[l]))}
          onClick={generateAll}
        >
          {running ? t('dashboard.expressions.generating', { label: running }) : t('dashboard.expressions.generateAll')}
        </Btn>
      </div>
    </div>
  )
}
