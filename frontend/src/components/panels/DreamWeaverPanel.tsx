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
import { connectionsApi } from '@/api/connections'
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
import ModelCombobox from '@/components/panels/connection-manager/ModelCombobox'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { getPersonaAvatarThumbUrlById } from '@/lib/avatarUrls'
import { toast } from '@/lib/toast'
import { useStore } from '@/store'
import { EventType } from '@/types/ws-events'
import type { ConnectionProfile, Persona } from '@/types/api'
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
  const [connections, setConnections] = useState<ConnectionProfile[]>([])
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(null)
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null)
  const [selectedModel, setSelectedModel] = useState('')
  const [connectionModels, setConnectionModels] = useState<string[]>([])
  const [connectionModelLabels, setConnectionModelLabels] = useState<Record<string, string>>({})
  const [connectionModelsLoading, setConnectionModelsLoading] = useState(false)
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
    () => resolveSelectedConnectionId(selectedConnectionId ?? activeProfileId, connections),
    [activeProfileId, connections, selectedConnectionId],
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
  useEffect(() => { setConnections(storedProfiles) }, [storedProfiles])

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
      const message = error?.body?.error || error?.message || 'Failed to load Dream Weaver sessions'
      toast.error(message, { title: 'Dream Weaver' })
    } finally {
      setIsLoadingSessions(false)
    }
  }, [])

  const loadBootstrapOptions = useCallback(async () => {
    const [personaResult, connectionResult] = await Promise.allSettled([
      personasApi.list({ limit: 200 }),
      connectionsApi.list({ limit: 200 }),
    ])
    if (personaResult.status === 'fulfilled') setPersonas(personaResult.value.data)
    if (connectionResult.status === 'fulfilled') setConnections(connectionResult.value.data)
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

  const fetchConnectionModels = useCallback(async () => {
    if (!resolvedConnectionId) {
      setConnectionModels([])
      setConnectionModelLabels({})
      return
    }

    setConnectionModelsLoading(true)
    try {
      const result = await connectionsApi.models(resolvedConnectionId)
      setConnectionModels(result.models || [])
      setConnectionModelLabels(result.model_labels || {})
    } catch {
      setConnectionModels([])
      setConnectionModelLabels({})
    } finally {
      setConnectionModelsLoading(false)
    }
  }, [resolvedConnectionId])

  useEffect(() => {
    void fetchConnectionModels()
  }, [fetchConnectionModels])

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
          const message = error?.body?.error || error?.message || 'Dream source could not be saved'
          const recoveryMessage = `${message}. The studio was created, so you can reopen it later.`
          setErrorMessage(recoveryMessage)
          toast.error(recoveryMessage, { title: 'Dream Weaver' })
          return
        }
      }
      setDreamText('')
      openModal('dreamWeaverStudio', { sessionId: session.id })
    } catch (error: any) {
      const message = error?.body?.error || error?.message || 'Failed to create Dream Weaver session'
      setErrorMessage(message)
      toast.error(message, { title: 'Dream Weaver' })
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
      toast.success('Dream Weaver session deleted', { title: 'Dream Weaver' })
    } catch (error: any) {
      const message = error?.body?.error || error?.message || 'Failed to delete Dream Weaver session'
      toast.error(message, { title: 'Dream Weaver' })
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

  const connectionOptions = useMemo(
    () => connections.map((c) => ({ value: c.id, label: c.name })),
    [connections],
  )

  return (
    <>
      <div className={styles.panel}>
        <section className={styles.createSurface} aria-label="Create a Dream Weaver session">
          <div className={styles.createHeader}>
            <div className={styles.createTitleBlock}>
              <span className={styles.createKicker}>New Weave</span>
              <h3 className={styles.createTitle}>Start anywhere, shape it freely.</h3>
            </div>
            <div className={styles.kindField}>
              <span className={styles.fieldLabel}>Card Type</span>
              <div className={styles.kindToggle} aria-label="Dream Weaver card type">
                <button
                  type="button"
                  className={styles.kindButton}
                  data-active={workspaceKind === 'character' || undefined}
                  onClick={() => setWorkspaceKind('character')}
                >
                  Character
                </button>
                <button
                  type="button"
                  className={styles.kindButton}
                  data-active={workspaceKind === 'scenario' || undefined}
                  onClick={() => setWorkspaceKind('scenario')}
                >
                  Scenario
                </button>
              </div>
            </div>
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>Source Material</span>
            <TextArea
              value={dreamText}
              onChange={setDreamText}
              placeholder="Optional. Paste a premise, scene, imported card notes, worldbook ideas, or anything worth preserving."
              rows={6}
            />
            {dreamText.length > 0 && (
              <span className={styles.charCount}>{dreamText.length.toLocaleString()} characters</span>
            )}
          </div>

          {/* Persona / Connection / Model */}
          <div className={styles.selectorsGrid}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Persona</span>
              <SearchableSelect
                value={resolvedPersonaId ?? ''}
                onChange={(v) => setSelectedPersonaId(v || null)}
                options={personaOptions}
                placeholder="Use active or default persona"
                searchPlaceholder="Search personas…"
                emptyMessage="No personas available"
                disabled={personas.length === 0}
                ariaLabel="Persona"
                portal
              />
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Connection</span>
              <SearchableSelect
                value={resolvedConnectionId ?? ''}
                onChange={(v) => {
                  setSelectedConnectionId(v || null)
                  setSelectedModel('')
                }}
                options={connectionOptions}
                placeholder="Use active connection"
                searchPlaceholder="Search connections…"
                emptyMessage="No connections available"
                disabled={connections.length === 0}
                ariaLabel="Connection"
                portal
              />
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Model</span>
              <ModelCombobox
                value={selectedModel}
                onChange={setSelectedModel}
                models={connectionModels}
                modelLabels={connectionModelLabels}
                loading={connectionModelsLoading}
                onRefresh={fetchConnectionModels}
                autoRefreshOnFocus
                refreshKey={resolvedConnectionId ?? ''}
                placeholder="Connection default"
                emptyMessage={resolvedConnectionId ? 'No models returned. Enter one manually or use the connection default.' : 'No connection available.'}
                disabled={!resolvedConnectionId}
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
                Refine Direction
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
                  <span className={styles.fieldLabel}>Tone</span>
                  <TextInput
                    value={tone}
                    onChange={setTone}
                    placeholder="Uneasy, intimate, grounded, sharp…"
                  />
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Keep</span>
                  <TextInput
                    value={constraints}
                    onChange={setConstraints}
                    placeholder="Specific history, rules, relationships, or constraints."
                  />
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Avoid</span>
                  <TextInput
                    value={dislikes}
                    onChange={setDislikes}
                    placeholder="Clichés, tone drift, unwanted tropes, or exclusions."
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
                Advanced Generation
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
                  Applies to every Dream Weaver generation step. Leave blank for tool defaults.
                </p>
                <div className={styles.tuneGrid}>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>Temperature</span>
                    <TextInput
                      value={genParams.temperature != null ? String(genParams.temperature) : ''}
                      onChange={(v) => updateGenParam('temperature', v !== '' ? parseFloat(v) : null)}
                      type="number"
                      placeholder="Default"
                      min={0}
                      max={2}
                      step={0.05}
                    />
                  </div>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>Top P</span>
                    <TextInput
                      value={genParams.topP != null ? String(genParams.topP) : ''}
                      onChange={(v) => updateGenParam('topP', v !== '' ? parseFloat(v) : null)}
                      type="number"
                      placeholder="Default"
                      min={0}
                      max={1}
                      step={0.01}
                    />
                  </div>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>Max Tokens</span>
                    <TextInput
                      value={genParams.maxTokens != null ? String(genParams.maxTokens) : ''}
                      onChange={(v) => updateGenParam('maxTokens', v !== '' ? parseInt(v, 10) : null)}
                      type="number"
                      placeholder="Default"
                      min={256}
                      step={256}
                    />
                  </div>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>Top K</span>
                    <TextInput
                      value={genParams.topK != null ? String(genParams.topK) : ''}
                      onChange={(v) => updateGenParam('topK', v !== '' ? parseInt(v, 10) : null)}
                      type="number"
                      placeholder="Default"
                      min={1}
                      step={1}
                    />
                  </div>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>Timeout (s)</span>
                    <TextInput
                      value={genParams.timeoutMs != null ? String(Math.round(genParams.timeoutMs / 1000)) : ''}
                      onChange={(v) => updateGenParam('timeoutMs', v !== '' ? parseInt(v, 10) * 1000 : null)}
                      type="number"
                      placeholder="None"
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
            {isCreating ? 'Opening...' : dreamText.trim() ? 'Start Weaving' : 'Open Blank Studio'}
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
        <EditorSection title="Previous Weaves" Icon={History} defaultExpanded={true}>
          <div className={styles.archiveTools}>
            <div className={styles.archiveFilters} aria-label="Filter previous weaves">
              {([
                ['all', 'All', archiveCounts.all],
                ['drafts', 'Drafts', archiveCounts.drafts],
                ['finalized', 'Finalized', archiveCounts.finalized],
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
                placeholder="Search weaves..."
                aria-label="Search previous weaves"
              />
              {archiveQuery.trim() && (
                <button type="button" onClick={() => setArchiveQuery('')} aria-label="Clear weave search">
                  <X size={12} />
                </button>
              )}
            </label>
          </div>
          {isLoadingSessions ? (
            <div className={styles.sessionsEmpty}>Loading saved weaves...</div>
          ) : archiveGroups.length === 0 ? (
            <div className={styles.sessionsEmpty}>
              {sessions.length === 0 ? 'No saved weaves yet.' : 'No weaves match this view.'}
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
                                  {session.workspace_kind === 'scenario' ? 'Scenario' : 'Character'}
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
                                Open
                              </button>
                              <button
                                type="button"
                                className={styles.deleteBtn}
                                onClick={() => setSessionToDelete(session)}
                                aria-label="Delete session"
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
          title="Delete this session?"
          message="This removes the saved weave state. The generated character stays if you already finalized it."
          variant="warning"
          confirmText="Delete session"
          onConfirm={() => void handleDeleteSession()}
          onCancel={() => setSessionToDelete(null)}
        />
      )}
    </>
  )
}
