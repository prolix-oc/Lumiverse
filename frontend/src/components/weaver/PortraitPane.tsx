import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { wsClient } from '@/ws/client'
import { EventType } from '@/types/ws-events'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import { imagesApi } from '@/api/images'
import * as weaverApi from '@/api/weaver'
import type { WeaverVisualCandidate, WeaverVisualJob, WeaverVisualJobProgress } from '@/api/weaver'
import type { Character, ImageGenConnectionProfile, ImageGenParameterSchema, ImageGenProviderInfo } from '@/types/api'
import type { ComfyUIWorkflowConfig } from '@/api/image-gen-connections'
import { getCharacterAvatarLargeUrlById } from '@/lib/avatarUrls'
import { Btn, Icon, IconBtn } from './primitives'
import { ParamField } from './VisualParamField'
import styles from './PortraitPane.module.css'

const KIND = 'portrait'

const SKIP_PARAMS = new Set([
  'negativePrompt', 'rawRequestOverride', 'workflow', 'prompt',
  'width', 'height', 'size', 'resolution', 'aspectRatio', 'aspect_ratio', 'seed',
])

const COMFY_SKIP = new Set(['positive_prompt', 'negative_prompt', 'seed', 'width', 'height'])
const COMFY_LABELS: Record<string, string> = {
  steps: 'Steps', cfg: 'CFG', sampler_name: 'Sampler', scheduler: 'Scheduler', checkpoint: 'Checkpoint',
}

function isComfyProvider(provider: string | undefined): boolean {
  return provider === 'comfyui' || provider === 'swarmui'
}

interface PortraitPaneProps {
  sessionId: string
  character: Character
  onCharacterUpdate: (character: Character) => void
  onCount?: (count: number) => void
}

export function PortraitPane({ sessionId, character, onCharacterUpdate, onCount }: PortraitPaneProps) {
  const { t } = useTranslation('weaver')
  const [connections, setConnections] = useState<ImageGenConnectionProfile[]>([])
  const [providers, setProviders] = useState<ImageGenProviderInfo[]>([])
  const [connId, setConnId] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [negative, setNegative] = useState('')
  const [seed, setSeed] = useState<string>('')
  const [width, setWidth] = useState<string>('')
  const [height, setHeight] = useState<string>('')
  const [params, setParams] = useState<Record<string, any>>({})
  const [comfyConfig, setComfyConfig] = useState<ComfyUIWorkflowConfig | null>(null)
  const [comfyValues, setComfyValues] = useState<Record<string, any>>({})
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [candidates, setCandidates] = useState<WeaverVisualCandidate[]>([])
  const [progress, setProgress] = useState<WeaverVisualJobProgress | null>(null)
  const [generating, setGenerating] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const jobIdRef = useRef<string | null>(null)

  const committedId = character.image_id
  const avatarUrl = useMemo(
    () => (committedId ? getCharacterAvatarLargeUrlById(character.id, committedId) : null),
    [character.id, committedId],
  )

  const activeConnection = connections.find((c) => c.id === connId) ?? null
  const schema: Record<string, ImageGenParameterSchema> = useMemo(() => {
    const provider = providers.find((p) => p.id === activeConnection?.provider)
    return provider?.capabilities.parameters ?? {}
  }, [providers, activeConnection])
  const advancedParams = useMemo(
    () => Object.entries(schema).filter(([key]) => !SKIP_PARAMS.has(key)),
    [schema],
  )

  const isComfy = isComfyProvider(activeConnection?.provider)
  useEffect(() => {
    if (!connId || !isComfy) {
      setComfyConfig(null)
      setComfyValues({})
      return
    }
    let alive = true
    void imageGenConnectionsApi.getComfyUIWorkflowConfig(connId)
      .then((r) => { if (alive) { setComfyConfig(r.config); setComfyValues({}) } })
      .catch(() => { if (alive) setComfyConfig(null) })
    return () => { alive = false }
  }, [connId, isComfy])

  const comfyControls = useMemo(() => {
    if (!comfyConfig) return []
    return comfyConfig.field_mappings
      .filter((m) => !COMFY_SKIP.has(m.mappedAs))
      .map((m) => {
        const key = `${m.nodeId}:${m.fieldName}`
        const current = comfyConfig.workflow_api_json?.[m.nodeId]?.inputs?.[m.fieldName]
        const options = comfyConfig.field_options?.[key]
        const isCustom = m.mappedAs === 'custom'
        const kind: 'select' | 'number' | 'text' =
          options && options.length ? 'select' : typeof current === 'number' ? 'number' : 'text'
        return {
          key,
          semantic: m.mappedAs as string,
          isCustom,
          label: isCustom ? m.fieldName.replace(/_/g, ' ') : COMFY_LABELS[m.mappedAs] ?? m.mappedAs,
          kind,
          options,
          current,
        }
      })
  }, [comfyConfig])

  const comfyValueFor = (c: { isCustom: boolean; key: string; semantic: string; current: any }) =>
    (c.isCustom ? comfyValues.custom?.[c.key] : comfyValues[c.semantic]) ?? c.current ?? ''
  const setComfyValue = (c: { isCustom: boolean; key: string; semantic: string }, v: any) =>
    setComfyValues((prev) =>
      c.isCustom
        ? { ...prev, custom: { ...(prev.custom ?? {}), [c.key]: v } }
        : { ...prev, [c.semantic]: v })

  const refreshCandidates = useCallback(async () => {
    try {
      const res = await weaverApi.listVisualCandidates(sessionId, KIND)
      setCandidates(res.data)
    } catch {
      /* non-fatal */
    }
  }, [sessionId])

  useEffect(() => { onCount?.(candidates.length) }, [candidates, onCount])

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
      const meta = kinds.find((k) => k.id === KIND)
      if (meta) {
        setWidth((prev) => prev || String(meta.width))
        setHeight((prev) => prev || String(meta.height))
      }
    })
    void refreshCandidates()
  }, [sessionId, refreshCandidates])

  useEffect(() => {
    const unsubs = [
      wsClient.on(EventType.WEAVER_VISUAL_JOB_PROGRESS, (job: WeaverVisualJob) => {
        if (job.id !== jobIdRef.current) return
        setProgress(job.progress)
      }),
      wsClient.on(EventType.WEAVER_VISUAL_JOB_COMPLETED, (job: WeaverVisualJob) => {
        if (job.id !== jobIdRef.current) return
        jobIdRef.current = null
        setGenerating(false)
        setProgress(null)
        if (job.result?.image_id) setFocusedId(job.result.image_id)
        void refreshCandidates()
      }),
      wsClient.on(EventType.WEAVER_VISUAL_JOB_FAILED, (job: WeaverVisualJob) => {
        if (job.id !== jobIdRef.current) return
        jobIdRef.current = null
        setGenerating(false)
        setProgress(null)
        setError(job.error ?? t('dashboard.portrait.genFailed'))
      }),
    ]
    return () => unsubs.forEach((u) => u())
  }, [refreshCandidates, t])

  const suggest = useCallback(async () => {
    if (suggesting) return
    setSuggesting(true)
    setError(null)
    try {
      const r = await weaverApi.suggestVisualTags(sessionId)
      setPrompt(r.suggestedTags)
      if (r.suggestedNegativeTags) setNegative(r.suggestedNegativeTags)
    } catch (err: any) {
      setError(err?.message ?? t('dashboard.portrait.suggestFailed'))
    } finally {
      setSuggesting(false)
    }
  }, [suggesting, sessionId, t])

  const generate = useCallback(async () => {
    if (!connId || !prompt.trim() || generating) return
    setError(null)
    setGenerating(true)
    setProgress({ stage: 'queued', message: t('dashboard.portrait.queued') })
    try {
      const job = await weaverApi.generateVisual(sessionId, {
        kind: KIND,
        prompt: prompt.trim(),
        connection_id: connId,
        negative_prompt: negative.trim() || undefined,
        seed: seed.trim() === '' ? null : Number(seed),
        width: width.trim() === '' ? undefined : Number(width),
        height: height.trim() === '' ? undefined : Number(height),
        provider_state: isComfy
          ? (Object.keys(comfyValues).length ? { comfyui_field_values: comfyValues } : undefined)
          : (Object.keys(params).length ? { params } : undefined),
      })
      jobIdRef.current = job.id
      setProgress(job.progress)
    } catch (err: any) {
      jobIdRef.current = null
      setGenerating(false)
      setProgress(null)
      setError(err?.message ?? t('dashboard.portrait.genFailed'))
    }
  }, [connId, prompt, negative, seed, width, height, params, comfyValues, isComfy, generating, sessionId, t])

  const setAsAvatar = useCallback(async (candidate: WeaverVisualCandidate) => {
    if (committing) return
    setCommitting(true)
    setError(null)
    try {
      onCharacterUpdate(await weaverApi.commitAvatar(sessionId, candidate.id))
    } catch (err: any) {
      setError(err?.message ?? t('dashboard.portrait.commitFailed'))
    } finally {
      setCommitting(false)
    }
  }, [committing, sessionId, onCharacterUpdate, t])

  const remove = useCallback(async (candidate: WeaverVisualCandidate) => {
    try {
      await imagesApi.delete(candidate.id)
      setCandidates((prev) => prev.filter((c) => c.id !== candidate.id))
      setFocusedId((prev) => (prev === candidate.id ? null : prev))
    } catch {
      setError(t('dashboard.portrait.deleteFailed'))
    }
  }, [t])

  const focused = candidates.find((c) => c.id === focusedId) ?? null
  const canvasImage = focused?.url ?? avatarUrl
  const stepText = progress?.totalSteps ? `${progress.step ?? 0} / ${progress.totalSteps}` : null
  const canGenerate = Boolean(connId) && prompt.trim().length > 0 && !generating

  return (
    <div className={styles.pane}>
      <div className={styles.head}>
        <h2 className={styles.title}>{t('dashboard.rail.portrait')}</h2>
        <p className={styles.sub}>{t('dashboard.portrait.sub')}</p>
      </div>
      <div className={styles.body}>
        <div className={styles.canvasCol}>
          <div className={styles.canvas}>
          {generating ? (
            <div className={styles.generating}>
              {progress?.preview ? (
                <img className={styles.preview} src={progress.preview} alt="" />
              ) : (
                <div className={styles.pulse}><Icon name="image" size={26} /></div>
              )}
              <div className={styles.progressText}>
                <span>{progress?.message ?? t('dashboard.portrait.generating')}</span>
                {stepText && <span className={styles.stepText}>{stepText}</span>}
              </div>
            </div>
          ) : canvasImage ? (
            <img className={styles.canvasImg} src={canvasImage} alt={character.name} />
          ) : (
            <div className={styles.empty}>
              <div className={styles.emptyFrame}><Icon name="user" size={24} /></div>
              <p>{t('dashboard.portrait.emptyCanvas')}</p>
            </div>
          )}
          </div>
        </div>

        <div className={styles.controls}>
        {error && <div className={styles.error}><Icon name="alert" size={14} />{error}</div>}

        {/* Prompt */}
        <div className={styles.band}>
          <div className={styles.bandHead}>
            <span className={styles.bandLabel}>{t('dashboard.portrait.promptLabel')}</span>
            <button type="button" className={styles.suggest} disabled={suggesting || generating} onClick={() => void suggest()}>
              <Icon name={suggesting ? 'refresh' : 'sparkles'} size={12} spin={suggesting} />
              {suggesting ? t('dashboard.portrait.suggesting') : t('dashboard.portrait.suggestTags')}
            </button>
          </div>
          <textarea
            className={styles.tags}
            rows={3}
            value={prompt}
            disabled={generating}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t('dashboard.portrait.promptPlaceholder')}
          />
        </div>

        <div className={styles.band}>
          <div className={styles.bandHead}><span className={styles.bandLabel}>{t('dashboard.portrait.negativeLabel')}</span></div>
          <textarea
            className={styles.tags}
            rows={2}
            value={negative}
            disabled={generating}
            onChange={(e) => setNegative(e.target.value)}
            placeholder={t('dashboard.portrait.negativePlaceholder')}
          />
        </div>

        {/* Adapter + params */}
        <div className={styles.band}>
          <div className={styles.bandHead}><span className={styles.bandLabel}>{t('dashboard.portrait.adapter')}</span></div>
          <div className={styles.adapterRow}>
            <span className={styles.fieldLabel}>{t('dashboard.portrait.connection')}</span>
            {connections.length === 0 ? (
              <span className={styles.adapterEmpty}>{t('dashboard.portrait.noConnections')}</span>
            ) : (
              <select className={styles.select} value={connId ?? ''} disabled={generating} onChange={(e) => setConnId(e.target.value || null)}>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} · {c.provider}</option>
                ))}
              </select>
            )}
          </div>
          <div className={styles.paramGrid}>
            <NumField label={t('dashboard.portrait.seed')} value={seed} placeholder={t('dashboard.portrait.random')} disabled={generating} onChange={setSeed} />
            <NumField label={t('dashboard.portrait.width')} value={width} disabled={generating} onChange={setWidth} />
            <NumField label={t('dashboard.portrait.height')} value={height} disabled={generating} onChange={setHeight} />
          </div>
          {(isComfy ? comfyControls.length > 0 : advancedParams.length > 0) && (
            <>
              <button type="button" className={styles.advancedToggle} onClick={() => setAdvancedOpen((v) => !v)}>
                <Icon name={advancedOpen ? 'chevronDown' : 'chevronRight'} size={13} />
                {t(isComfy ? 'dashboard.portrait.workflowSettings' : 'dashboard.portrait.advanced')}
              </button>
              {advancedOpen && (
                <div className={styles.paramGrid}>
                  {isComfy
                    ? comfyControls.map((c) => (
                        <GenField
                          key={c.key}
                          label={c.label}
                          kind={c.kind}
                          options={c.options}
                          value={comfyValueFor(c)}
                          disabled={generating}
                          onChange={(v) => setComfyValue(c, v)}
                        />
                      ))
                    : advancedParams.map(([key, ps]) => (
                        <ParamField
                          key={key}
                          paramKey={key}
                          schema={ps}
                          value={params[key] ?? ps.default}
                          disabled={generating}
                          onChange={(v) => setParams((prev) => ({ ...prev, [key]: v }))}
                        />
                      ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Variations */}
        {candidates.length > 0 && (
          <div className={styles.band}>
            <div className={styles.bandHead}><span className={styles.bandLabel}>{t('dashboard.portrait.variations')}</span></div>
            <div className={styles.grid}>
              {candidates.map((c) => {
                const isCommitted = c.id === committedId
                return (
                  <div key={c.id} className={cellClass(c.id === focusedId, isCommitted)} onClick={() => setFocusedId(c.id)}>
                    <img src={c.url} alt="" />
                    {isCommitted && <span className={styles.committedBadge}><Icon name="check" size={11} />{t('dashboard.portrait.avatar')}</span>}
                    <div className={styles.cellActions} onClick={(e) => e.stopPropagation()}>
                      {!isCommitted && <IconBtn icon="check" title={t('dashboard.portrait.setAvatar')} disabled={committing} onClick={() => void setAsAvatar(c)} />}
                      <a className={styles.dl} href={c.url} download title={t('dashboard.portrait.download')}><Icon name="download" size={15} /></a>
                      {!isCommitted && <IconBtn icon="trash" title={t('dashboard.portrait.delete')} onClick={() => void remove(c)} />}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
        </div>
      </div>

      <div className={styles.paneFooter}>
        <Btn variant="primary" icon={generating ? 'refresh' : 'sparkles'} spin={generating} disabled={!canGenerate} onClick={() => void generate()}>
          {generating ? t('dashboard.portrait.generating') : t('dashboard.portrait.generate')}
        </Btn>
      </div>
    </div>
  )
}

function cellClass(focused: boolean, committed: boolean): string {
  return [styles.cell, focused ? styles.cellFocused : '', committed ? styles.cellCommitted : ''].filter(Boolean).join(' ')
}

function NumField({ label, value, placeholder, disabled, onChange }: { label: string; value: string; placeholder?: string; disabled?: boolean; onChange: (v: string) => void }) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <input className={styles.input} type="number" value={value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

function GenField({ label, kind, options, value, disabled, onChange }: {
  label: string
  kind: 'select' | 'number' | 'text'
  options?: string[]
  value: any
  disabled?: boolean
  onChange: (v: any) => void
}) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {kind === 'select' ? (
        <select className={styles.input} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {!(options ?? []).includes(value) && <option value={value}>{String(value ?? '')}</option>}
          {(options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input
          className={styles.input}
          type={kind === 'number' ? 'number' : 'text'}
          value={value ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(kind === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
        />
      )}
    </label>
  )
}
