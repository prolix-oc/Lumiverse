import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import { emptyPersonaPlan, type WeaverSession } from '@/api/weaver'
import { connectionsApi } from '@/api/connections'
import SearchableSelect, { type SearchableSelectOption } from '@/components/shared/SearchableSelect'
import ModelCombobox from '@/components/panels/connection-manager/ModelCombobox'
import { Btn, estimateTokens } from '../primitives'
import styles from '../WeaverStudio.module.css'

const AUTOSAVE_MS = 700
const PERSONA_NONE = '__none__'

function SessionConfigRail({ session }: { session: WeaverSession }) {
  const { t } = useTranslation('weaver')
  const personas = useStore((s) => s.personas)
  const profiles = useStore((s) => s.profiles)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const setConfig = useStore((s) => s.setWeaverSessionConfig)
  const buildTypes = useStore((s) => s.weaverBuildTypes)
  const narrationModes = useStore((s) => s.weaverNarrationModes)
  const loadNarrationModes = useStore((s) => s.loadWeaverNarrationModes)

  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [modelLabels, setModelLabels] = useState<Record<string, string>>({})
  const [loadingModels, setLoadingModels] = useState(false)

  const effectiveConnectionId = session.connection_id || activeProfileId || ''
  const selectedConnection = useMemo(
    () => profiles.find((p) => p.id === effectiveConnectionId),
    [profiles, effectiveConnectionId],
  )

  const fetchModels = useCallback(async () => {
    if (!effectiveConnectionId) {
      setAvailableModels([])
      setModelLabels({})
      return
    }
    setLoadingModels(true)
    try {
      const result = await connectionsApi.models(effectiveConnectionId)
      setAvailableModels(result.models || [])
      setModelLabels(result.model_labels || {})
    } catch {
      setAvailableModels([])
      setModelLabels({})
    } finally {
      setLoadingModels(false)
    }
  }, [effectiveConnectionId])

  useEffect(() => {
    void fetchModels()
  }, [fetchModels])

  const personaOptions = useMemo<SearchableSelectOption[]>(() => {
    const opts: SearchableSelectOption[] = [{ value: PERSONA_NONE, label: t('panel.personaNone') }]
    personas.forEach((p) => opts.push({ value: p.id, label: p.name }))
    return opts
  }, [personas, t])

  useEffect(() => { void loadNarrationModes() }, [loadNarrationModes])

  const supportsNarration = useMemo(
    () => buildTypes.find((b) => b.id === session.build_type)?.narration === true,
    [buildTypes, session.build_type],
  )
  const narrationOptions = useMemo<SearchableSelectOption[]>(
    () => narrationModes.map((m) => ({ value: m.id, label: t(`dream.narration.${m.id}`, { defaultValue: m.label }) })),
    [narrationModes, t],
  )

  const connectionOptions = useMemo<SearchableSelectOption[]>(
    () => profiles.map((p) => ({ value: p.id, label: p.name, sublabel: p.provider })),
    [profiles],
  )

  const createNewPersona = session.persona_plan?.enabled ?? false
  const setCreateNewPersona = (on: boolean) => {
    const base = session.persona_plan ?? emptyPersonaPlan()
    void setConfig(session.id, { persona_plan: { ...base, enabled: on } })
  }

  return (
    <div className={styles.configRail}>
      <div className={styles.railGroupLabel}>{t('dream.configTitle')}</div>
      {!createNewPersona && (
        <div className={styles.configField}>
          <span className={styles.configLabel}>{t('panel.persona')}</span>
          <SearchableSelect
            options={personaOptions}
            value={session.persona_id ?? PERSONA_NONE}
            onChange={(v) => void setConfig(session.id, { persona_id: !v || v === PERSONA_NONE ? null : v })}
            placeholder={t('panel.personaNone')}
            ariaLabel={t('panel.persona')}
            portal
          />
        </div>
      )}
      <div className={styles.configField}>
        <label className={styles.checkRow}>
          <input type="checkbox" checked={createNewPersona} onChange={(e) => setCreateNewPersona(e.target.checked)} />
          <span>{t('persona.createToggle')}</span>
        </label>
        {createNewPersona && <p className={styles.stageHelp}>{t('persona.createHint')}</p>}
      </div>
      {supportsNarration && narrationOptions.length > 0 && (
        <div className={styles.configField}>
          <span className={styles.configLabel}>{t('dream.narration.label')}</span>
          <SearchableSelect
            options={narrationOptions}
            value={session.narration_mode ?? narrationModes[0]?.id ?? ''}
            onChange={(v) => void setConfig(session.id, { narration_mode: v || null })}
            ariaLabel={t('dream.narration.label')}
            portal
          />
        </div>
      )}
      <div className={styles.configField}>
        <span className={styles.configLabel}>{t('panel.connection')}</span>
        <SearchableSelect
          options={connectionOptions}
          value={effectiveConnectionId}
          onChange={(v) => void setConfig(session.id, { connection_id: v || null, model: null })}
          placeholder={t('panel.connectionNone')}
          ariaLabel={t('panel.connection')}
          disabled={connectionOptions.length === 0}
          portal
        />
      </div>
      <div className={styles.configField}>
        <span className={styles.configLabel}>{t('panel.model')}</span>
        <ModelCombobox
          value={session.model ?? ''}
          onChange={(v) => void setConfig(session.id, { model: v || selectedConnection?.model || null })}
          models={availableModels}
          modelLabels={modelLabels}
          loading={loadingModels}
          onRefresh={fetchModels}
          autoRefreshOnFocus
          refreshKey={effectiveConnectionId}
          placeholder={t('panel.modelNone')}
          disabled={!effectiveConnectionId}
        />
      </div>
    </div>
  )
}

const PIPELINE_STEPS = ['readback', 'interview', 'bible', 'render'] as const
function NextPipeline() {
  const { t } = useTranslation('weaver')
  return (
    <div className={styles.pipeline}>
      {PIPELINE_STEPS.map((k, i) => (
        <div className={styles.pipelineStep} key={k}>
          <div className={styles.pipelineNum}>{i + 1}</div>
          <div>
            <div className={styles.pipelineName}>{t(`dream.pipeline.${k}.name`)}</div>
            <div className={styles.pipelineDesc}>{t(`dream.pipeline.${k}.desc`)}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

export function DreamStage({ session, onAdvance }: { session: WeaverSession; onAdvance: () => void }) {
  const { t } = useTranslation('weaver')
  const onSaveSeed = useStore((s) => s.updateWeaverSeed)
  const runReadback = useStore((s) => s.runWeaverReadback)
  const readbackRunning = useStore((s) => s.weaverReadbackRunning)
  const readbackError = useStore((s) => s.weaverReadbackError)

  const [text, setText] = useState(session.seed.text)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSaved = useRef(session.seed.text)

  useEffect(() => {
    setText(session.seed.text)
    lastSaved.current = session.seed.text
    setSaveState('idle')
  }, [session.id, session.seed.text])

  const tokens = useMemo(() => estimateTokens(text), [text])

  const scheduleSave = useCallback(
    (next: string) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(async () => {
        if (next === lastSaved.current) return
        setSaveState('saving')
        try {
          await onSaveSeed(session.id, next)
          lastSaved.current = next
          setSaveState('saved')
        } catch {
          setSaveState('idle')
        }
      }, AUTOSAVE_MS)
    },
    [onSaveSeed, session.id],
  )

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  const canRead = text.trim().length > 0 && !readbackRunning

  const handleRead = async () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (text !== lastSaved.current) {
      await onSaveSeed(session.id, text)
      lastSaved.current = text
    }
    await runReadback(session.id)
    if (!useStore.getState().weaverReadbackError) onAdvance()
  }

  return (
    <>
      <div className={styles.panel}>
        <div className={styles.stageHead}>
          <div className={styles.stageHeadL}>
            <h2 className={styles.stageH}>{t('dream.heading')}</h2>
            <p className={styles.stageHelp}>{t('dream.help')}</p>
          </div>
        </div>
        {readbackError && <p className={styles.errorText}>{readbackError}</p>}
        <div className={styles.scroll} style={{ display: 'flex' }}>
          <div className={styles.dreamWrap}>
            <div className={styles.dreamGrid}>
              <div className={styles.dreamEdit}>
                <textarea
                  className={styles.field}
                  value={text}
                  placeholder={t('dream.placeholder')}
                  onChange={(e) => { setText(e.target.value); scheduleSave(e.target.value) }}
                />
                <div className={styles.dreamStatus}>
                  <span>{t('dream.tokens', { count: tokens })}</span>
                  <span>{saveState === 'saving' ? t('dream.saving') : saveState === 'saved' ? t('dream.saved') : ''}</span>
                </div>
              </div>
              <div className={styles.dreamRail}>
                <SessionConfigRail session={session} />
                <div className={styles.railGroupLabel}>{t('dream.nextTitle')}</div>
                <NextPipeline />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className={styles.footer}>
        <div className={styles.spacer} />
        <Btn
          variant="primary"
          icon={readbackRunning ? 'refresh' : null}
          iconRight={readbackRunning ? null : 'arrowRight'}
          spin={readbackRunning}
          disabled={!canRead}
          onClick={() => void handleRead()}
        >
          {readbackRunning ? t('readback.running') : t('readback.run')}
        </Btn>
      </div>
    </>
  )
}
