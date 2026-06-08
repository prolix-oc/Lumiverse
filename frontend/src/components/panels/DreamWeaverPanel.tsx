import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Clock3,
  FolderOpen,
  History,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { dreamWeaverApi, type DreamWeaverSession } from '@/api/dream-weaver'
import { dreamWeaverToolingApi } from '@/api/dream-weaver-tooling'
import { personasApi } from '@/api/personas'
import { settingsApi } from '@/api/settings'
import {
  getSessionStatusLabel,
  resolveSelectedConnectionId,
} from '@/components/dream-weaver/lib/studio-model'
import {
  Button,
  EditorSection,
  TextArea,
  TextInput,
} from '@/components/shared/FormComponents'
import SearchableSelect from '@/components/shared/SearchableSelect'
import ConnectionSelect from '@/components/shared/ConnectionSelect'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { getPersonaAvatarThumbUrlById } from '@/lib/avatarUrls'
import { toast } from '@/lib/toast'
import { useStore } from '@/store'
import { EventType } from '@/types/ws-events'
import type { Persona } from '@/types/api'
import { wsClient } from '@/ws/client'
import {
  buildDreamWeaverSessionArchive,
  formatDreamWeaverSessionTimestamp,
  getDefaultExpandedDreamWeaverArchiveKeys,
  getDreamWeaverSessionPreview,
  getDreamWeaverSessionTitle,
  resolveSelectedDreamWeaverPersonaId,
  type SessionArchiveGroup,
} from './dream-weaver-panel.lib'
import styles from './DreamWeaverPanel.module.css'

type ArchiveKey = SessionArchiveGroup['key']
type ArchiveFilter = 'all' | 'drafts' | 'finalized'

interface DWGenParams {
  temperature?: number | null
  topP?: number | null
  maxTokens?: number | null
  topK?: number | null
  timeoutMs?: number | null
}

export default function DreamWeaverPanel() {
  const { t } = useTranslation('dreamWeaver')
  const [dreamText, setDreamText] = useState('')
  const [workspaceKind, setWorkspaceKind] = useState<'character' | 'scenario'>('character')
  const [tone, setTone] = useState('')
  const [constraints, setConstraints] = useState('')
  const [dislikes, setDislikes] = useState('')
  const [refineExpanded, setRefineExpanded] = useState(false)
  const [tuneExpanded, setTuneExpanded] = useState(false)
  const [genParams, setGenParams] = useState<DWGenParams>({})
  const genParamsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [sessions, setSessions] = useState<DreamWeaverSession[]>([])
  const [archiveQuery, setArchiveQuery] = useState('')
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>('all')
  const [personas, setPersonas] = useState<Persona[]>([])
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(null)
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null)
  const [selectedModel, setSelectedModel] = useState('')
  const [expandedArchiveKeys, setExpandedArchiveKeys] = useState<Partial<Record<ArchiveKey, boolean>>>({})
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [isLoadingSessions, setIsLoadingSessions] = useState(false)
  const [sessionToDelete, setSessionToDelete] = useState<DreamWeaverSession | null>(null)

  const openModal = useStore((s) => s.openModal)
  const activeModal = useStore((s) => s.activeModal)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const storedPersonas = useStore((s) => s.personas)
  const storedProfiles = useStore((s) => s.profiles)

  const resolvedPersonaId = useMemo(
    () => resolveSelectedDreamWeaverPersonaId(selectedPersonaId, activePersonaId, personas),
    [activePersonaId, personas, selectedPersonaId],
  )
  const resolvedConnectionId = useMemo(
    () => resolveSelectedConnectionId(selectedConnectionId ?? activeProfileId, storedProfiles),
    [activeProfileId, storedProfiles, selectedConnectionId],
  )

  const filteredSessions = useMemo(() => {
    if (archiveFilter === 'drafts') return sessions.filter((session) => !session.character_id)
    if (archiveFilter === 'finalized') return sessions.filter((session) => Boolean(session.character_id))
    return sessions
  }, [archiveFilter, sessions])

  const archiveGroups = useMemo(
    () => buildDreamWeaverSessionArchive(filteredSessions, archiveQuery),
    [archiveQuery, filteredSessions],
  )

  const archiveCounts = useMemo(() => ({
    all: sessions.length,
    drafts: sessions.filter((session) => !session.character_id).length,
    finalized: sessions.filter((session) => Boolean(session.character_id)).length,
  }), [sessions])

  useEffect(() => { setPersonas(storedPersonas) }, [storedPersonas])

  useEffect(() => {
    setExpandedArchiveKeys((current) => {
      const defaultKeys = new Set(getDefaultExpandedDreamWeaverArchiveKeys(archiveGroups))
      const next: Partial<Record<ArchiveKey, boolean>> = {}
      for (const group of archiveGroups) {
        next[group.key] = current[group.key] ?? defaultKeys.has(group.key)
      }
      return next
    })
  }, [archiveGroups])

  const loadSessions = useCallback(async () => {
    setIsLoadingSessions(true)
    try {
      const nextSessions = await dreamWeaverApi.getSessions()
      setSessions(nextSessions)
    } catch (error: any) {
      const message = error?.body?.error || error?.message || t('toast.loadFailed')
      toast.error(message, { title: t('brand') })
    } finally {
      setIsLoadingSessions(false)
    }
  }, [t])

  const loadBootstrapOptions = useCallback(async () => {
    // Connections come from the store (loaded in full at app init); only
    // personas still need a panel-local fetch here.
    const personaResult = await personasApi.list({ limit: 200 }).catch(() => null)
    if (personaResult) setPersonas(personaResult.data)
  }, [])

  useEffect(() => {
    void loadSessions()
    void loadBootstrapOptions()
  }, [loadBootstrapOptions, loadSessions])

  useEffect(() => {
    settingsApi.get('dreamWeaverGenParams').then((row) => {
      if (row?.value && typeof row.value === 'object') {
        setGenParams(row.value as DWGenParams)
      }
    }).catch(() => {})
  }, [])

  const updateGenParam = useCallback(<K extends keyof DWGenParams>(key: K, value: DWGenParams[K]) => {
    setGenParams((prev) => {
      const next = { ...prev, [key]: value }
      if (genParamsSaveTimerRef.current) clearTimeout(genParamsSaveTimerRef.current)
      genParamsSaveTimerRef.current = setTimeout(() => {
        settingsApi.put('dreamWeaverGenParams', next).catch(() => {})
      }, 500)
      return next
    })
  }, [])

  useEffect(() => {
    if (activeModal !== 'dreamWeaverStudio') void loadSessions()
  }, [activeModal, loadSessions])

  useEffect(() => {
    const refresh = (payload?: { sessionId?: string }) => {
      if (!payload?.sessionId) return
      void loadSessions()
    }

    const unsubs = [
      wsClient.on(EventType.DREAM_WEAVER_FINALIZED, refresh),
    ]

    return () => {
      unsubs.forEach((unsub) => unsub())
    }
  }, [loadSessions])

  const toggleArchiveGroup = useCallback((key: ArchiveKey) => {
    setExpandedArchiveKeys((current) => ({ ...current, [key]: !(current[key] ?? false) }))
  }, [])

  const handleDream = async () => {
    setIsCreating(true)
    setErrorMessage(null)
    try {
      const session = await dreamWeaverApi.createSession({
        dream_text: dreamText.trim() || undefined,
        tone: tone.trim() || undefined,
        constraints: constraints.trim() || undefined,
        dislikes: dislikes.trim() || undefined,
        persona_id: resolvedPersonaId || undefined,
        connection_id: resolvedConnectionId || undefined,
        model: selectedModel.trim() || undefined,
        workspace_kind: workspaceKind,
      })
      if (dreamText.trim()) {
        try {
          await dreamWeaverToolingApi.dream(session.id)
        } catch (error: any) {
          const message = error?.body?.error || error?.message || t('toast.dreamSaveFailed')
          const recoveryMessage = `${message}. ${t('toast.recoverySuffix')}`
          setErrorMessage(recoveryMessage)
          toast.error(recoveryMessage, { title: t('brand') })
          return
        }
      }
      setDreamText('')
      openModal('dreamWeaverStudio', { sessionId: session.id })
    } catch (error: any) {
      const message = error?.body?.error || error?.message || t('toast.createFailed')
      setErrorMessage(message)
      toast.error(message, { title: t('brand') })
    } finally {
      void loadSessions()
      setIsCreating(false)
    }
  }

  const handleOpenSession = (sessionId: string) => {
    openModal('dreamWeaverStudio', { sessionId })
  }

  const handleDeleteSession = async () => {
    if (!sessionToDelete) return
    try {
      await dreamWeaverApi.deleteSession(sessionToDelete.id)
      setSessions((current) => current.filter((s) => s.id !== sessionToDelete.id))
      toast.success(t('toast.deleted'), { title: t('brand') })
    } catch (error: any) {
      const message = error?.body?.error || error?.message || t('toast.deleteFailed')
      toast.error(message, { title: t('brand') })
    } finally {
      setSessionToDelete(null)
    }
  }

  const personaOptions = useMemo(
    () => personas.map((p) => {
      const avatarUrl = getPersonaAvatarThumbUrlById(p.id, p.image_id)
      const initial = p.name.trim().charAt(0).toUpperCase() || '?'
      const title = p.title?.trim()
      return {
        value: p.id,
        label: p.name,
        sublabel: title || undefined,
        leading: avatarUrl ? (
          <img src={avatarUrl} alt="" loading="lazy" />
        ) : (
          <span>{initial}</span>
        ),
      }
    }),
    [personas],
  )

  return (
    <>
      <div className={styles.panel}>
        <section className={styles.createSurface} aria-label={t('create.ariaLabel')}>
          <div className={styles.createHeader}>
            <div className={styles.createTitleBlock}>
              <span className={styles.createKicker}>{t('create.kicker')}</span>
              <h3 className={styles.createTitle}>{t('create.title')}</h3>
            </div>
            <div className={styles.kindField}>
              <span className={styles.fieldLabel}>{t('create.cardType')}</span>
              <div className={styles.kindToggle} aria-label={t('create.cardTypeAria')}>
                <button
                  type="button"
                  className={styles.kindButton}
                  data-active={workspaceKind === 'character' || undefined}
                  onClick={() => setWorkspaceKind('character')}
                >
                  {t('create.character')}
                </button>
                <button
                  type="button"
                  className={styles.kindButton}
                  data-active={workspaceKind === 'scenario' || undefined}
                  onClick={() => setWorkspaceKind('scenario')}
                >
                  {t('create.scenario')}
                </button>
              </div>
            </div>
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('create.sourceMaterial')}</span>
            <TextArea
              value={dreamText}
              onChange={setDreamText}
              placeholder={t('create.sourcePlaceholder')}
              rows={6}
            />
            {dreamText.length > 0 && (
              <span className={styles.charCount}>{t('create.characters', { count: dreamText.length })}</span>
            )}
          </div>

          {/* Persona / Connection (+ model) */}
          <div className={styles.selectorsGrid}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t('create.persona')}</span>
              <SearchableSelect
                value={resolvedPersonaId ?? ''}
                onChange={(v) => setSelectedPersonaId(v || null)}
                options={personaOptions}
                placeholder={t('create.personaPlaceholder')}
                searchPlaceholder={t('create.searchPersonas')}
                emptyMessage={t('create.noPersonas')}
                disabled={personas.length === 0}
                ariaLabel={t('create.persona')}
                portal
              />
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t('create.connection')}</span>
              <ConnectionSelect
                kind="llm"
                value={resolvedConnectionId ?? ''}
                onChange={(v) => setSelectedConnectionId(v || null)}
                withModel
                modelValue={selectedModel}
                onModelChange={setSelectedModel}
                placeholder={t('create.connectionPlaceholder')}
                searchPlaceholder={t('create.searchConnections')}
                emptyMessage={t('create.noConnections')}
                ariaLabel={t('create.connection')}
                modelPlaceholder={t('create.modelPlaceholder')}
                modelEmptyMessage={t('create.noModelsManual')}
                modelNoConnectionMessage={t('create.noConnection')}
                portal
              />
            </div>
          </div>

          {/* Refine — collapsed by default */}
          <div>
            <button
              type="button"
              className={styles.refineToggle}
              onClick={() => setRefineExpanded((v) => !v)}
              aria-expanded={refineExpanded}
            >
              <span className={styles.refineLine} />
              <span className={styles.refineLabel}>
                {t('create.refineDirection')}
                <ChevronRight
                  size={12}
                  className={clsx(styles.refineChevron, refineExpanded && styles.refineChevronOpen)}
                />
              </span>
              <span className={styles.refineLine} />
            </button>

            {refineExpanded && (
              <div className={styles.refineBody}>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>{t('create.tone')}</span>
                  <TextInput
                    value={tone}
                    onChange={setTone}
                    placeholder={t('create.tonePlaceholder')}
                  />
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>{t('create.keep')}</span>
                  <TextInput
                    value={constraints}
                    onChange={setConstraints}
                    placeholder={t('create.keepPlaceholder')}
                  />
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>{t('create.avoid')}</span>
                  <TextInput
                    value={dislikes}
                    onChange={setDislikes}
                    placeholder={t('create.avoidPlaceholder')}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Tune — LLM sampling params, collapsed by default */}
          <div>
            <button
              type="button"
              className={styles.refineToggle}
              onClick={() => setTuneExpanded((v) => !v)}
              aria-expanded={tuneExpanded}
            >
              <span className={styles.refineLine} />
              <span className={styles.refineLabel}>
                {t('create.advancedGeneration')}
                <ChevronRight
                  size={12}
                  className={clsx(styles.refineChevron, tuneExpanded && styles.refineChevronOpen)}
                />
              </span>
              <span className={styles.refineLine} />
            </button>

            {tuneExpanded && (
              <div className={styles.refineBody}>
                <p className={styles.tuneHint}>
                  {t('create.tuneHint')}
                </p>
                <div className={styles.tuneGrid}>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>{t('create.temperature')}</span>
                    <TextInput
                      value={genParams.temperature != null ? String(genParams.temperature) : ''}
                      onChange={(v) => updateGenParam('temperature', v !== '' ? parseFloat(v) : null)}
                      type="number"
                      placeholder={t('create.defaultPlaceholder')}
                      min={0}
                      max={2}
                      step={0.05}
                    />
                  </div>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>{t('create.topP')}</span>
                    <TextInput
                      value={genParams.topP != null ? String(genParams.topP) : ''}
                      onChange={(v) => updateGenParam('topP', v !== '' ? parseFloat(v) : null)}
                      type="number"
                      placeholder={t('create.defaultPlaceholder')}
                      min={0}
                      max={1}
                      step={0.01}
                    />
                  </div>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>{t('create.maxTokens')}</span>
                    <TextInput
                      value={genParams.maxTokens != null ? String(genParams.maxTokens) : ''}
                      onChange={(v) => updateGenParam('maxTokens', v !== '' ? parseInt(v, 10) : null)}
                      type="number"
                      placeholder={t('create.defaultPlaceholder')}
                      min={256}
                      step={256}
                    />
                  </div>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>{t('create.topK')}</span>
                    <TextInput
                      value={genParams.topK != null ? String(genParams.topK) : ''}
                      onChange={(v) => updateGenParam('topK', v !== '' ? parseInt(v, 10) : null)}
                      type="number"
                      placeholder={t('create.defaultPlaceholder')}
                      min={1}
                      step={1}
                    />
                  </div>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>{t('create.timeoutSeconds')}</span>
                    <TextInput
                      value={genParams.timeoutMs != null ? String(Math.round(genParams.timeoutMs / 1000)) : ''}
                      onChange={(v) => updateGenParam('timeoutMs', v !== '' ? parseInt(v, 10) * 1000 : null)}
                      type="number"
                      placeholder={t('create.nonePlaceholder')}
                      min={10}
                      step={10}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          <Button
            variant="primary"
            icon={<Sparkles size={14} />}
            loading={isCreating}
            disabled={isCreating}
            onClick={() => void handleDream()}
            className={styles.dreamBtn}
          >
            {isCreating ? t('create.opening') : dreamText.trim() ? t('create.startWeaving') : t('create.openBlankStudio')}
          </Button>
        </section>

        {/* Error */}
        {errorMessage && (
          <div className={styles.errorBox} role="alert">
            <AlertCircle size={16} />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Previous Weaves */}
        <EditorSection title={t('archive.previousWeaves')} Icon={History} defaultExpanded={true}>
          <div className={styles.archiveTools}>
            <div className={styles.archiveFilters} aria-label={t('archive.filterAria')}>
              {([
                ['all', t('archive.all'), archiveCounts.all],
                ['drafts', t('archive.drafts'), archiveCounts.drafts],
                ['finalized', t('archive.finalized'), archiveCounts.finalized],
              ] as const).map(([key, label, count]) => (
                <button
                  key={key}
                  type="button"
                  className={styles.archiveFilter}
                  data-active={archiveFilter === key || undefined}
                  onClick={() => setArchiveFilter(key)}
                >
                  <span>{label}</span>
                  <span className={styles.archiveFilterCount}>{count}</span>
                </button>
              ))}
            </div>
            <label className={styles.archiveSearch}>
              <Search size={13} aria-hidden />
              <input
                value={archiveQuery}
                onChange={(event) => setArchiveQuery(event.target.value)}
                placeholder={t('archive.searchPlaceholder')}
                aria-label={t('archive.searchAria')}
              />
              {archiveQuery.trim() && (
                <button type="button" onClick={() => setArchiveQuery('')} aria-label={t('archive.clearSearch')}>
                  <X size={12} />
                </button>
              )}
            </label>
          </div>
          {isLoadingSessions ? (
            <div className={styles.sessionsEmpty}>{t('archive.loading')}</div>
          ) : archiveGroups.length === 0 ? (
            <div className={styles.sessionsEmpty}>
              {sessions.length === 0 ? t('archive.empty') : t('archive.noMatch')}
            </div>
          ) : (
            <div className={styles.archiveList}>
              {archiveGroups.map((group) => {
                const expanded = expandedArchiveKeys[group.key] ?? false
                return (
                  <section key={group.key} className={styles.archiveGroup}>
                    <button
                      type="button"
                      className={styles.archiveToggle}
                      onClick={() => toggleArchiveGroup(group.key)}
                      aria-expanded={expanded}
                    >
                      <span className={styles.archiveToggleLeft}>
                        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        <span className={styles.archiveGroupLabel}>{group.label}</span>
                      </span>
                      <span className={styles.archiveGroupCount}>{group.sessions.length}</span>
                    </button>

                    {expanded && (
                      <div className={styles.archiveRows}>
                        {group.sessions.map((session) => (
                          <div
                            key={session.id}
                            className={styles.sessionRow}
                            data-finalized={session.character_id ? true : undefined}
                          >
                            <button
                              type="button"
                              className={styles.sessionMain}
                              onClick={() => handleOpenSession(session.id)}
                            >
                              <div className={styles.sessionHeading}>
                                <span className={styles.sessionTitle}>{getDreamWeaverSessionTitle(session)}</span>
                                <span className={styles.sessionKind}>
                                  {session.workspace_kind === 'scenario' ? t('create.scenario') : t('create.character')}
                                </span>
                                <span
                                  className={styles.sessionStatus}
                                  data-status={session.character_id ? 'finalized' : session.status}
                                >
                                  {getSessionStatusLabel(session)}
                                </span>
                              </div>
                              <span className={styles.sessionPreview}>{getDreamWeaverSessionPreview(session)}</span>
                              <div className={styles.sessionMeta}>
                                <span className={styles.sessionMetaItem}>
                                  <Clock3 size={11} />
                                  {formatDreamWeaverSessionTimestamp(session.updated_at)}
                                </span>
                                {session.tone && (
                                  <span className={styles.sessionMetaTag}>{session.tone}</span>
                                )}
                              </div>
                            </button>
                            <div className={styles.sessionActions}>
                              <button
                                type="button"
                                className={styles.openBtn}
                                onClick={() => handleOpenSession(session.id)}
                              >
                                <FolderOpen size={13} />
                                {t('archive.open')}
                              </button>
                              <button
                                type="button"
                                className={styles.deleteBtn}
                                onClick={() => setSessionToDelete(session)}
                                aria-label={t('archive.deleteSession')}
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
          )}
        </EditorSection>

      </div>

      {sessionToDelete && (
        <ConfirmationModal
          isOpen={true}
          title={t('confirm.deleteTitle')}
          message={t('confirm.deleteMessage')}
          variant="warning"
          confirmText={t('confirm.deleteConfirm')}
          onConfirm={() => void handleDeleteSession()}
          onCancel={() => setSessionToDelete(null)}
        />
      )}
    </>
  )
}
