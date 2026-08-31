import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  File,
  Flag,
  Link2,
  ListChecks,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Shield,
  Trash2,
  Unlink,
  X,
} from 'lucide-react'
import clsx from 'clsx'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { Button, FormField, Select, TextArea, TextInput } from '@/components/shared/FormComponents'
import type {
  AgentPersistentWorkspaceArtifactV1,
  AgentPersistentWorkspaceEditInputV1,
  AgentPersistentWorkspacePublicationInputV1,
  AgentPersistentWorkspacePublicationV1,
  AgentPersistentWorkspaceRecordV1,
  AgentPersistentWorkspaceSubmissionV1,
  AgentPersistentWorkspaceTaskInputV1,
  AgentPersistentWorkspaceTaskV1,
  AgentPersistentWorkspaceTurnSessionV1,
  AgentPersistentWorkspaceV1,
} from '@/types/agent-runs'
import styles from './PersistentWorkspaceInspector.module.css'

type WorkspaceMetadata = AgentPersistentWorkspaceV1['metadata']
type WorkspaceProgress = AgentPersistentWorkspaceV1['progress']
type WorkspaceTaskState = AgentPersistentWorkspaceTaskV1['state']
type WorkspaceProgressState = WorkspaceProgress['state']
type WorkspacePublicationCategory = AgentPersistentWorkspacePublicationV1['category']
type WorkspaceRecordKind = AgentPersistentWorkspaceRecordV1['kind']

export type PersistentWorkspaceEditInput = AgentPersistentWorkspaceEditInputV1
export type PersistentWorkspaceTaskInput = AgentPersistentWorkspaceTaskInputV1
export type PersistentWorkspacePublicationInput = AgentPersistentWorkspacePublicationInputV1

export interface PersistentWorkspacePublicationDeleteInput {
  expectedRevision: number
  publicationId: string
}

export interface PersistentWorkspaceInspectorProps {
  workspace: AgentPersistentWorkspaceV1 | null
  sessions?: readonly AgentPersistentWorkspaceTurnSessionV1[]
  sessionsTotal?: number
  sessionsHasMore?: boolean
  sessionsLoadingMore?: boolean
  tasks?: readonly AgentPersistentWorkspaceTaskV1[]
  records?: readonly AgentPersistentWorkspaceRecordV1[]
  submissions?: readonly AgentPersistentWorkspaceSubmissionV1[]
  artifacts?: readonly AgentPersistentWorkspaceArtifactV1[]
  publications?: readonly AgentPersistentWorkspacePublicationV1[]
  loading?: boolean
  error?: string | null
  onRefresh: () => void | Promise<void>
  onEdit: (input: PersistentWorkspaceEditInput) => void | Promise<void>
  onCreateTask: (input: PersistentWorkspaceTaskInput) => void | Promise<void>
  onPublish: (input: PersistentWorkspacePublicationInput) => void | Promise<void>
  onDeletePublication: (input: PersistentWorkspacePublicationDeleteInput) => void | Promise<void>
  onDeleteWorkspace: (expectedRevision: number) => void | Promise<void>
  onOpenTurnSession?: (session: AgentPersistentWorkspaceTurnSessionV1) => void
  onLoadMoreSessions?: () => void | Promise<void>
  className?: string
}

type InspectorSection = 'overview' | 'tasks' | 'records' | 'artifacts' | 'publications'
type CollapsibleSection = InspectorSection | 'sessions' | 'usage'
type Mutation = 'edit' | 'task' | 'record' | 'publish' | 'publication-delete' | 'workspace-delete' | null

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  if ('body' in error && typeof error.body === 'object' && error.body !== null && 'error' in error.body && typeof error.body.error === 'string') {
    return error.body.error
  }
  if ('code' in error && typeof error.code === 'string') return error.code
  return null
}

function isRevisionConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const statusConflict = 'status' in error && error.status === 409
  return statusConflict || errorCode(error) === 'stale_revision' || errorCode(error) === 'task_assignment_conflict'
}

const MAX_DATE_SECONDS = 8_640_000_000_000_000 / 1_000

function dateLabel(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 0 || seconds > MAX_DATE_SECONDS) return '—'
  const date = new Date(seconds * 1_000)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

function displayId(value: string | null | undefined): string {
  return value || '—'
}

function publicationCopyLabel(publication: AgentPersistentWorkspacePublicationV1): string {
  switch (publication.copy.category) {
    case 'task':
      return publication.copy.title
    case 'objective':
      return publication.copy.objective
    case 'finding':
      return publication.copy.content.summary
    case 'artifact':
      return publication.copy.provenance
  }
}

function percentValue(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value ?? 0)))
}


function SectionHeading({ icon, title, count, open, onToggle, id }: {
  icon: ReactNode
  title: string
  count?: number
  open: boolean
  onToggle: () => void
  id: string
}) {
  return (
    <button
      type="button"
      className={styles.sectionHeading}
      aria-expanded={open}
      aria-controls={id}
      onClick={onToggle}
    >
      {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
      <span className={styles.sectionHeadingIcon}>{icon}</span>
      <strong>{title}</strong>
      {count !== undefined ? <span className={styles.countBadge}>{count.toLocaleString()}</span> : null}
    </button>
  )
}

function StateBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' }) {
  return <span className={clsx(styles.stateBadge, styles[`tone${tone[0].toUpperCase()}${tone.slice(1)}`])}>{children}</span>
}

function RevisionMeta({ revision, updatedAt }: { revision: number; updatedAt: number }) {
  const { t } = useTranslation('chat')
  return (
    <div className={styles.revisionMeta}>
      <span>{t('persistentWorkspace.revision', { revision })}</span>
      <span>{t('persistentWorkspace.updatedAt', { date: dateLabel(updatedAt) })}</span>
    </div>
  )
}
export function PersistentWorkspaceInspector({
  workspace,
  sessions = [],
  sessionsTotal = sessions.length,
  sessionsHasMore = sessionsTotal > sessions.length,
  sessionsLoadingMore = false,
  tasks = [],
  records = [],
  submissions = [],
  artifacts = [],
  publications = [],
  loading = false,
  error = null,
  onRefresh,
  onEdit,
  onCreateTask,
  onPublish,
  onDeletePublication,
  onDeleteWorkspace,
  onOpenTurnSession,
  onLoadMoreSessions,
  className,
}: PersistentWorkspaceInspectorProps) {
  const { t } = useTranslation('chat')
  const [section, setSection] = useState<InspectorSection>('overview')
  const [openSections, setOpenSections] = useState<Record<CollapsibleSection, boolean>>({
    overview: true,
    sessions: true,
    usage: true,
    tasks: true,
    records: true,
    artifacts: true,
    publications: true,
  })
  const [mutation, setMutation] = useState<Mutation>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [revisionConflict, setRevisionConflict] = useState(false)
  const [confirmDeleteWorkspace, setConfirmDeleteWorkspace] = useState(false)
  const [confirmDeletePublication, setConfirmDeletePublication] = useState<AgentPersistentWorkspacePublicationV1 | null>(null)
  const [draftDirty, setDraftDirty] = useState(false)
  const [objective, setObjective] = useState('')
  const [metadata, setMetadata] = useState<WorkspaceMetadata | null>(null)
  const [progress, setProgress] = useState<WorkspaceProgress | null>(null)
  const [taskTitle, setTaskTitle] = useState('')
  const [taskObjective, setTaskObjective] = useState('')
  const [taskTurnSessionId, setTaskTurnSessionId] = useState('')
  const [recordKind, setRecordKind] = useState<WorkspaceRecordKind>('finding')
  const [recordSummary, setRecordSummary] = useState('')
  const [recordProvenance, setRecordProvenance] = useState('')
  const [recordTaskId, setRecordTaskId] = useState('')
  const [publicationCategory, setPublicationCategory] = useState<WorkspacePublicationCategory>('task')
  const [publicationSourceId, setPublicationSourceId] = useState('')

  useEffect(() => {
    if (draftDirty || !workspace) return
    setObjective(workspace.objective)
    setMetadata(workspace.metadata)
    setProgress(workspace.progress)
  }, [draftDirty, workspace])
  useEffect(() => {
    if (!workspace) {
      setDraftDirty(false)
      setObjective('')
      setMetadata(null)
      setProgress(null)
    }
  }, [workspace])

  const taskOptions = useMemo(
    () => tasks.map((task) => ({ value: task.id, label: task.title })),
    [tasks],
  )
  const sessionOptions = useMemo(
    () => sessions.map((session) => ({ value: session.id, label: `${displayId(session.turnId)} · ${t(`persistentWorkspace.sessionStatus.${session.status}`)}` })),
    [sessions, t],
  )
  const publishOptions = useMemo(() => {
    const options: Array<{ value: string; label: string; category: WorkspacePublicationCategory; revision?: number; digest?: string }> = []
    if (workspace) options.push({ value: workspace.id, label: t('persistentWorkspace.objectiveSource'), category: 'objective', revision: workspace.revision })
    for (const task of tasks) options.push({ value: task.id, label: `${t('persistentWorkspace.taskSource')}: ${task.title}`, category: 'task', revision: task.revision })
    for (const record of records) if (record.kind === 'finding') options.push({ value: record.id, label: `${t('persistentWorkspace.recordSource')}: ${record.content.summary}`, category: 'finding', revision: record.revision })
    for (const artifact of artifacts) options.push({ value: artifact.id, label: `${t('persistentWorkspace.artifactSource')}: ${artifact.mimeType}`, category: 'artifact', revision: artifact.revision, digest: artifact.blobDigest })
    return options
  }, [artifacts, records, t, tasks, workspace])

  useEffect(() => {
    if (publishOptions.length === 0) {
      setPublicationSourceId('')
      return
    }
    const selected = publishOptions.find((option) => option.value === publicationSourceId)
    if (!selected || selected.category !== publicationCategory) {
      const next = publishOptions.find((option) => option.category === publicationCategory) ?? publishOptions[0]
      setPublicationSourceId(next?.value ?? '')
      if (next && next.category !== publicationCategory) setPublicationCategory(next.category)
    }
  }, [publicationCategory, publicationSourceId, publishOptions])

  const setField = useCallback(<K extends keyof WorkspaceMetadata>(key: K, value: WorkspaceMetadata[K]) => {
    setMetadata((current) => current ? { ...current, [key]: value } : current)
    setDraftDirty(true)
  }, [])

  const runMutation = useCallback(async (kind: Exclude<Mutation, null>, operation: () => void | Promise<void>) => {
    setMutation(kind)
    setMutationError(null)
    try {
      await operation()
      setRevisionConflict(false)
      if (kind === 'edit' || kind === 'record') setDraftDirty(false)
    } catch (caught) {
      if (isRevisionConflict(caught)) setRevisionConflict(true)
      setMutationError(isRevisionConflict(caught) ? 'persistentWorkspace.conflict' : 'persistentWorkspace.mutationFailed')
    } finally {
      setMutation(null)
    }
  }, [])

  const saveWorkspace = useCallback(() => {
    if (!workspace || !metadata || !progress) return
    void runMutation('edit', () => onEdit({
      expectedRevision: workspace.revision,
      objective,
      metadata: {
        title: metadata.title,
        summary: metadata.summary,
        labels: metadata.labels,
        ownerNote: metadata.ownerNote,
      },
      progress: {
        state: progress.state,
        percent: percentValue(progress.percent),
        summary: progress.summary,
      },
    }))
  }, [metadata, objective, onEdit, progress, runMutation, workspace])

  const addTask = useCallback(() => {
    if (!workspace || taskTitle.trim().length === 0) return
    void runMutation('task', async () => {
      await onCreateTask({
        expectedRevision: workspace.revision,
        title: taskTitle.trim(),
        objective: taskObjective.trim() || undefined,
        turnSessionId: taskTurnSessionId || null,
      })
      setTaskTitle('')
      setTaskObjective('')
      setTaskTurnSessionId('')
    })
  }, [onCreateTask, runMutation, taskObjective, taskTitle, taskTurnSessionId, workspace])

  const addRecord = useCallback(() => {
    if (!workspace || recordSummary.trim().length === 0) return
    void runMutation('record', async () => {
      await onEdit({
        expectedRevision: workspace.revision,
        record: {
          kind: recordKind,
          summary: recordSummary.trim(),
          provenance: recordProvenance.trim() || null,
          taskId: recordTaskId || null,
        },
      })
      setRecordSummary('')
      setRecordProvenance('')
      setRecordTaskId('')
    })
  }, [onEdit, recordKind, recordProvenance, recordSummary, recordTaskId, runMutation, workspace])

  const publishSelection = useCallback(() => {
    if (!workspace || !publicationSourceId) return
    const selected = publishOptions.find((option) => option.value === publicationSourceId)
    if (!selected) return
    void runMutation('publish', () => onPublish({
      expectedRevision: workspace.revision,
      category: selected.category,
      sourceId: selected.value,
      sourceRevision: selected.revision,
    }))
  }, [onPublish, publicationSourceId, publishOptions, runMutation, workspace])

  const deletePublication = useCallback(() => {
    if (!workspace || !confirmDeletePublication) return
    const publication = confirmDeletePublication
    setConfirmDeletePublication(null)
    void runMutation('publication-delete', () => onDeletePublication({ expectedRevision: workspace.revision, publicationId: publication.id }))
  }, [confirmDeletePublication, onDeletePublication, runMutation, workspace])

  const toggleSection = useCallback((name: CollapsibleSection) => {
    setOpenSections((current) => ({ ...current, [name]: !current[name] }))
  }, [])

  if (!workspace) {
    return (
      <section className={clsx(styles.inspector, className)} aria-label={t('persistentWorkspace.label')}>
        <div className={styles.emptyState}>
          <BookOpen aria-hidden="true" />
          <h3>{t('persistentWorkspace.notAvailableTitle')}</h3>
          <p>{error ? t('persistentWorkspace.loadFailed') : t('persistentWorkspace.notAvailable')}</p>
          <Button type="button" onClick={() => void onRefresh()} loading={loading} icon={<RefreshCw aria-hidden="true" />}>
            {t('persistentWorkspace.refresh')}
          </Button>
        </div>
      </section>
    )
  }

  const detached = workspace.chatId === null
  const archived = workspace.state === 'archived'
  const sourceDeleted = detached || archived
  const canEdit = !archived && !detached
  const selectedPublication = publishOptions.find((option) => option.value === publicationSourceId)
  const selectedSourceLabel = selectedPublication?.label ?? t('persistentWorkspace.selectSource')

  return (
    <section className={clsx(styles.inspector, className)} aria-label={t('persistentWorkspace.label')}>
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <div className={styles.titleIcon}><BookOpen aria-hidden="true" /></div>
          <div>
            <p className={styles.eyebrow}>{t('persistentWorkspace.eyebrow')}</p>
            <h2>{workspace.metadata.title || t('persistentWorkspace.untitled')}</h2>
            <div className={styles.headerBadges}>
              <StateBadge tone={archived ? 'warning' : 'success'}>{archived ? t('persistentWorkspace.state.archived') : t('persistentWorkspace.state.active')}</StateBadge>
              {detached ? <StateBadge tone="warning"><Unlink aria-hidden="true" />{t('persistentWorkspace.detached')}</StateBadge> : <StateBadge><Link2 aria-hidden="true" />{t('persistentWorkspace.attached')}</StateBadge>}
              <StateBadge><Shield aria-hidden="true" />{t('persistentWorkspace.ownerOnly')}</StateBadge>
            </div>
          </div>
        </div>
        <div className={styles.headerActions}>
          <Button type="button" variant="ghost" size="sm" onClick={() => void onRefresh()} disabled={mutation !== null} icon={<RefreshCw aria-hidden="true" />}>
            {t('persistentWorkspace.refresh')}
          </Button>
        </div>
      </header>

      <div className={styles.metaBar}>
        <span>{t('persistentWorkspace.id', { id: displayId(workspace.id) })}</span>
        {workspace.chatId ? <span>{t('persistentWorkspace.chat', { id: displayId(workspace.chatId) })}</span> : <span>{t('persistentWorkspace.sourceChatDeleted')}</span>}
        <RevisionMeta revision={workspace.revision} updatedAt={workspace.updatedAt} />
      </div>

      {sourceDeleted ? (
        <div className={styles.notice} role="status">
          {archived ? <Archive aria-hidden="true" /> : <Unlink aria-hidden="true" />}
          <div>
            <strong>{archived ? t('persistentWorkspace.archiveNoticeTitle') : t('persistentWorkspace.deletedSourceTitle')}</strong>
            <p>{archived ? t('persistentWorkspace.archiveNotice') : t('persistentWorkspace.deletedSourceNotice')}</p>
          </div>
        </div>
      ) : null}

      {revisionConflict ? (
        <div className={styles.conflictNotice} role="alert">
          <CircleAlert aria-hidden="true" />
          <div>
            <strong>{t('persistentWorkspace.conflictTitle')}</strong>
            <p>{t('persistentWorkspace.conflictGuidance')}</p>
          </div>
          <div className={styles.noticeActions}>
            <Button type="button" size="sm" onClick={() => void onRefresh()} disabled={mutation !== null} icon={<RefreshCw aria-hidden="true" />}>
              {t('persistentWorkspace.refreshAndReapply')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setRevisionConflict(false)}>
              {t('persistentWorkspace.dismiss')}
            </Button>
          </div>
        </div>
      ) : null}

      {mutationError ? (
        <div className={styles.errorNotice} role="alert">
          <CircleAlert aria-hidden="true" />
          <span>{t(mutationError)}</span>
          <button type="button" className={styles.iconButton} onClick={() => setMutationError(null)} aria-label={t('persistentWorkspace.dismiss')}><X aria-hidden="true" /></button>
        </div>
      ) : null}
      {error ? <div className={styles.errorNotice} role="alert"><CircleAlert aria-hidden="true" /><span>{t('persistentWorkspace.loadFailed')}</span></div> : null}

      <nav className={styles.tabs} aria-label={t('persistentWorkspace.sectionsLabel')}>
        {(['overview', 'tasks', 'records', 'artifacts', 'publications'] as InspectorSection[]).map((name) => (
          <button key={name} type="button" className={clsx(styles.tab, section === name && styles.tabActive)} aria-current={section === name ? 'page' : undefined} onClick={() => setSection(name)}>
            {name === 'overview' ? <BookOpen aria-hidden="true" /> : name === 'tasks' ? <ListChecks aria-hidden="true" /> : name === 'records' ? <Flag aria-hidden="true" /> : name === 'artifacts' ? <File aria-hidden="true" /> : <Archive aria-hidden="true" />}
            <span>{t(`persistentWorkspace.sections.${name}`)}</span>
            {name === 'tasks' ? <span className={styles.tabCount}>{tasks.length}</span> : name === 'records' ? <span className={styles.tabCount}>{records.length}</span> : name === 'artifacts' ? <span className={styles.tabCount}>{artifacts.length}</span> : name === 'publications' ? <span className={styles.tabCount}>{publications.length}</span> : null}
          </button>
        ))}
      </nav>

      <div className={styles.body}>
        {section === 'overview' ? (
          <div className={styles.sectionStack}>
            <section className={styles.card}>
              <SectionHeading icon={<BookOpen aria-hidden="true" />} title={t('persistentWorkspace.overview')} open={openSections.overview} onToggle={() => toggleSection('overview')} id="persistent-workspace-overview" />
              {openSections.overview ? (
                <div id="persistent-workspace-overview" className={styles.cardBody}>
                  <p className={styles.boundaryHint}>{t('persistentWorkspace.boundaryHint')}</p>
                  <FormField label={t('persistentWorkspace.objective')} hint={t('persistentWorkspace.objectiveHint')}>
                    <TextArea value={objective} onChange={(value) => { setObjective(value); setDraftDirty(true) }} rows={3} disabled={!canEdit || mutation !== null} aria-label={t('persistentWorkspace.objective')} />
                  </FormField>
                  {metadata ? (
                    <div className={styles.formGrid}>
                      <FormField label={t('persistentWorkspace.title')}>
                        <TextInput value={metadata.title} onChange={(value) => setField('title', value)} disabled={!canEdit || mutation !== null} aria-label={t('persistentWorkspace.title')} />
                      </FormField>
                      <FormField label={t('persistentWorkspace.summary')}>
                        <TextInput value={metadata.summary} onChange={(value) => setField('summary', value)} disabled={!canEdit || mutation !== null} aria-label={t('persistentWorkspace.summary')} />
                      </FormField>
                      <FormField label={t('persistentWorkspace.ownerNote')}>
                        <TextArea value={metadata.ownerNote} onChange={(value) => setField('ownerNote', value)} rows={2} disabled={!canEdit || mutation !== null} aria-label={t('persistentWorkspace.ownerNote')} />
                      </FormField>
                    </div>
                  ) : null}
                  {progress ? (
                    <div className={styles.progressEditor}>
                      <div className={styles.progressHeading}><strong>{t('persistentWorkspace.progress')}</strong><span>{percentValue(progress.percent)}%</span></div>
                      <input className={styles.progressRange} type="range" min={0} max={100} step={1} value={percentValue(progress.percent)} disabled={!canEdit || mutation !== null} onChange={(event) => { setProgress({ ...progress, percent: Number(event.target.value) }); setDraftDirty(true) }} aria-label={t('persistentWorkspace.progress')} />
                      <div className={styles.formGrid}>
                        <FormField label={t('persistentWorkspace.progressState')}>
                          <Select value={progress.state} onChange={(value) => { setProgress({ ...progress, state: value as WorkspaceProgressState }); setDraftDirty(true) }} disabled={!canEdit || mutation !== null} aria-label={t('persistentWorkspace.progressState')} options={[
                            { value: 'not_started', label: t('persistentWorkspace.progressStates.not_started') },
                            { value: 'in_progress', label: t('persistentWorkspace.progressStates.in_progress') },
                            { value: 'blocked', label: t('persistentWorkspace.progressStates.blocked') },
                            { value: 'completed', label: t('persistentWorkspace.progressStates.completed') },
                          ]} />
                        </FormField>
                        <FormField label={t('persistentWorkspace.progressSummary')}>
                          <TextInput value={progress.summary} onChange={(value) => { setProgress({ ...progress, summary: value }); setDraftDirty(true) }} disabled={!canEdit || mutation !== null} aria-label={t('persistentWorkspace.progressSummary')} />
                        </FormField>
                      </div>
                      <p className={styles.fieldMeta}>{t('persistentWorkspace.progressUpdatedAt', { date: dateLabel(progress.updatedAt) })}</p>
                    </div>
                  ) : null}
                  <div className={styles.formActions}>
                    <Button type="button" onClick={saveWorkspace} disabled={!canEdit || !draftDirty || mutation !== null} loading={mutation === 'edit'} icon={<Save aria-hidden="true" />}>
                      {t('persistentWorkspace.saveChanges')}
                    </Button>
                    {!canEdit ? <span className={styles.muted}>{t('persistentWorkspace.archivedReadOnly')}</span> : null}
                  </div>
                </div>
              ) : null}
            </section>

            <section className={styles.card}>
              <SectionHeading icon={<Link2 aria-hidden="true" />} title={t('persistentWorkspace.turnSessions')} count={sessionsTotal} open={openSections.sessions} onToggle={() => toggleSection('sessions')} id="persistent-workspace-sessions" />
              {openSections.sessions ? (
                <div id="persistent-workspace-sessions" className={styles.cardBody}>
                  {sessions.length === 0 && sessionsTotal === 0 ? <p className={styles.emptyInline}>{t('persistentWorkspace.noTurnSessions')}</p> : (
                    <ul className={styles.sessionList}>
                      {sessions.map((session) => (
                        <li key={session.id} className={styles.sessionRow}>
                          <div><strong>{displayId(session.turnId)}</strong><span>{t('persistentWorkspace.sessionAttempt', { id: displayId(session.attemptId) })}</span><span>{session.chatId ? t('persistentWorkspace.sourceChat', { id: displayId(session.chatId) }) : t('persistentWorkspace.sourceChatDeleted')}</span></div>
                          <div className={styles.entryBadges}><StateBadge tone={session.outcome === 'completed' ? 'success' : session.outcome ? 'warning' : 'neutral'}>{t(`persistentWorkspace.sessionStatus.${session.status}`)}</StateBadge><span>{t(`persistentWorkspace.sessionPhase.${session.phase}`)}</span></div>
                          {session.outcome ? <span className={styles.sessionOutcome}>{t(`persistentWorkspace.sessionOutcome.${session.outcome}`)}</span> : null}
                          {onOpenTurnSession ? <Button type="button" variant="ghost" size="sm" onClick={() => onOpenTurnSession(session)} icon={<ChevronRight aria-hidden="true" />}>{t('persistentWorkspace.inspectTurnSession')}</Button> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                  {sessionsHasMore ? (
                    <div className={styles.formActions}>
                      <span className={styles.fieldMeta} role="status">{t('persistentWorkspace.sessionsShowing', { shown: sessions.length, total: sessionsTotal })}</span>
                      {onLoadMoreSessions ? <Button type="button" variant="secondary" onClick={() => void onLoadMoreSessions()} loading={sessionsLoadingMore} disabled={sessionsLoadingMore}>{t('persistentWorkspace.sessionsShowMore')}</Button> : null}
                    </div>
                  ) : null}
                  <p className={styles.boundaryHint}>{t('persistentWorkspace.turnSessionBoundary')}</p>
                </div>
              ) : null}
            </section>

            <section className={styles.card}>
              <SectionHeading icon={<Shield aria-hidden="true" />} title={t('persistentWorkspace.usage')} open={openSections.usage} onToggle={() => toggleSection('usage')} id="persistent-workspace-usage" />
              {openSections.usage ? (
                <div id="persistent-workspace-usage" className={styles.cardBody}>
                  <div className={styles.usageGrid}>
                    <span><strong>{workspace.usage.taskCount}</strong>{t('persistentWorkspace.usageTasks')}</span>
                    <span><strong>{workspace.usage.recordCount}</strong>{t('persistentWorkspace.usageRecords')}</span>
                    <span><strong>{workspace.usage.artifactCount}</strong>{t('persistentWorkspace.usageArtifacts')}</span>
                    <span><strong>{workspace.usage.publicationCount}</strong>{t('persistentWorkspace.usagePublications')}</span>
                  </div>
                  <p className={styles.fieldMeta}>{t('persistentWorkspace.quotaHint', { max: workspace.quota.maxBytes.toLocaleString(), used: workspace.usage.byteCount.toLocaleString() })}</p>
                </div>
              ) : null}
            </section>
          </div>
        ) : null}

        {section === 'tasks' ? (
          <div className={styles.sectionStack}>
            <section className={styles.card}>
              <SectionHeading icon={<ListChecks aria-hidden="true" />} title={t('persistentWorkspace.tasks')} count={tasks.length} open={openSections.tasks} onToggle={() => toggleSection('tasks')} id="persistent-workspace-tasks" />
              {openSections.tasks ? (
                <div id="persistent-workspace-tasks" className={styles.cardBody}>
                  <p className={styles.boundaryHint}>{t('persistentWorkspace.taskAuthorityHint')}</p>
                  {tasks.length === 0 ? <p className={styles.emptyInline}>{t('persistentWorkspace.noTasks')}</p> : (
                    <ul className={styles.entryList}>
                      {tasks.map((task) => (
                        <li key={task.id} className={styles.entryCard}>
                          <div className={styles.entryTopline}><strong>{task.title}</strong><StateBadge tone={task.state === 'completed' ? 'success' : task.state === 'failed' || task.state === 'cancelled' ? 'danger' : task.state === 'blocked' ? 'warning' : 'neutral'}>{t(`persistentWorkspace.taskStates.${task.state}`)}</StateBadge></div>
                          <p>{task.objective || t('persistentWorkspace.noObjective')}</p>
                          <div className={styles.entryBadges}>
                            <span className={task.hostAdmitted ? styles.authorityHost : styles.authorityOwner}>{task.hostAdmitted ? t('persistentWorkspace.hostAdmitted') : t('persistentWorkspace.ownerOptional')}</span>
                            <span>{task.required ? t('persistentWorkspace.required') : t('persistentWorkspace.optional')}</span>
                            {task.turnSessionId ? <span>{t('persistentWorkspace.sessionLink', { id: displayId(task.turnSessionId) })}</span> : null}
                            {task.dependencyIds.length > 0 ? <span>{t('persistentWorkspace.dependencies', { count: task.dependencyIds.length })}</span> : null}
                          </div>
                          <div className={styles.entryProgress}><span>{task.progress.summary || t('persistentWorkspace.noProgress')}</span><span>{percentValue(task.progress.percent)}%</span></div>
                          <div className={styles.entryFooter}><span>{t('persistentWorkspace.revision', { revision: task.revision })}</span><span>{t('persistentWorkspace.createdAt', { date: dateLabel(task.createdAt) })}</span><span>{t('persistentWorkspace.creator', { creator: t(`persistentWorkspace.creators.${task.creator}`) })}</span><span>{task.chatId ? t('persistentWorkspace.sourceChat', { id: displayId(task.chatId) }) : t('persistentWorkspace.sourceChatDeleted')}</span></div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </section>
            <section className={styles.card}>
              <div className={styles.cardBody}>
                <h3 className={styles.formTitle}><Plus aria-hidden="true" />{t('persistentWorkspace.addOptionalTask')}</h3>
                <p className={styles.boundaryHint}>{t('persistentWorkspace.optionalTaskHint')}</p>
                <div className={styles.formGrid}>
                  <FormField label={t('persistentWorkspace.taskTitle')} required><TextInput value={taskTitle} onChange={(value) => setTaskTitle(value)} disabled={!canEdit || mutation !== null} required aria-required="true" aria-label={t('persistentWorkspace.taskTitle')} /></FormField>
                  <FormField label={t('persistentWorkspace.taskObjective')}><TextInput value={taskObjective} onChange={(value) => setTaskObjective(value)} disabled={!canEdit || mutation !== null} aria-label={t('persistentWorkspace.taskObjective')} /></FormField>
                  <FormField label={t('persistentWorkspace.linkTurnSession')}><Select value={taskTurnSessionId} onChange={(value) => setTaskTurnSessionId(value)} disabled={!canEdit || mutation !== null} aria-label={t('persistentWorkspace.linkTurnSession')} options={[{ value: '', label: t('persistentWorkspace.noTurnSession') }, ...sessionOptions]} /></FormField>
                </div>
                <div className={styles.formActions}><Button type="button" onClick={addTask} disabled={!canEdit || !taskTitle.trim() || mutation !== null} loading={mutation === 'task'} icon={<Plus aria-hidden="true" />}>{t('persistentWorkspace.addTask')}</Button></div>
              </div>
            </section>
            <section className={styles.card}>
              <div className={styles.cardBody}>
                <h3 className={styles.formTitle}><Check aria-hidden="true" />{t('persistentWorkspace.submissions')}</h3>
                <p className={styles.boundaryHint}>{t('persistentWorkspace.submissionAuthorityHint')}</p>
                {submissions.length === 0 ? <p className={styles.emptyInline}>{t('persistentWorkspace.noSubmissions')}</p> : <ul className={styles.compactList}>{submissions.map((submission) => <li key={submission.id}><span>{t('persistentWorkspace.submissionFor', { id: displayId(submission.taskId) })}</span><StateBadge tone={submission.state === 'accepted' ? 'success' : submission.state === 'rejected' ? 'danger' : 'neutral'}>{t(`persistentWorkspace.submissionStates.${submission.state}`)}</StateBadge><span className={styles.digest}>{displayId(submission.resultDigest)}</span></li>)}</ul>}
              </div>
            </section>
          </div>
        ) : null}

        {section === 'records' ? (
          <div className={styles.sectionStack}>
            <section className={styles.card}>
              <SectionHeading icon={<Flag aria-hidden="true" />} title={t('persistentWorkspace.records')} count={records.length} open={openSections.records} onToggle={() => toggleSection('records')} id="persistent-workspace-records" />
              {openSections.records ? <div id="persistent-workspace-records" className={styles.cardBody}>
                <p className={styles.boundaryHint}>{t('persistentWorkspace.recordBoundaryHint')}</p>
                {records.length === 0 ? <p className={styles.emptyInline}>{t('persistentWorkspace.noRecords')}</p> : <ul className={styles.entryList}>{records.map((record) => <li key={record.id} className={styles.entryCard}><div className={styles.entryTopline}><strong>{t(`agentRun.workspace.recordKind.${record.kind}`)}</strong><span>{t('persistentWorkspace.revision', { revision: record.revision })}</span></div><p>{record.content.summary}</p><div className={styles.entryBadges}>{record.taskId ? <span>{t('persistentWorkspace.taskLink', { id: displayId(record.taskId) })}</span> : null}{record.turnSessionId ? <span>{t('persistentWorkspace.sessionLink', { id: displayId(record.turnSessionId) })}</span> : null}{record.content.provenance ? <span>{t('persistentWorkspace.provenancePresent')}</span> : null}</div><div className={styles.entryFooter}><span>{t('persistentWorkspace.createdAt', { date: dateLabel(record.createdAt) })}</span><span>{t('persistentWorkspace.updatedAt', { date: dateLabel(record.updatedAt) })}</span></div></li>)}</ul>}
              </div> : null}
            </section>
            <section className={styles.card}>
              <div className={styles.cardBody}>
                <h3 className={styles.formTitle}><Plus aria-hidden="true" />{t('persistentWorkspace.addRecord')}</h3>
                <p className={styles.boundaryHint}>{t('persistentWorkspace.addRecordHint')}</p>
                <div className={styles.formGrid}>
                  <FormField label={t('persistentWorkspace.recordKind')}>
                    <Select value={recordKind} onChange={(value) => setRecordKind(value as WorkspaceRecordKind)} disabled={!canEdit || mutation !== null} aria-label={t('persistentWorkspace.recordKind')} options={[{ value: 'finding', label: t('persistentWorkspace.recordKinds.finding') }, { value: 'decision', label: t('persistentWorkspace.recordKinds.decision') }, { value: 'question', label: t('persistentWorkspace.recordKinds.question') }]} />
                  </FormField>
                  <FormField label={t('persistentWorkspace.recordSummary')} required>
                    <TextArea value={recordSummary} onChange={(value) => setRecordSummary(value)} rows={3} disabled={!canEdit || mutation !== null} required aria-required="true" aria-label={t('persistentWorkspace.recordSummary')} />
                  </FormField>
                  <FormField label={t('persistentWorkspace.recordProvenance')}>
                    <TextInput value={recordProvenance} onChange={(value) => setRecordProvenance(value)} disabled={!canEdit || mutation !== null} aria-label={t('persistentWorkspace.recordProvenance')} />
                  </FormField>
                  <FormField label={t('persistentWorkspace.linkTask')}>
                    <Select value={recordTaskId} onChange={(value) => setRecordTaskId(value)} disabled={!canEdit || mutation !== null} aria-label={t('persistentWorkspace.linkTask')} options={[{ value: '', label: t('persistentWorkspace.noTask') }, ...taskOptions]} />
                  </FormField>
                </div>
                <div className={styles.formActions}>
                  <Button type="button" onClick={addRecord} disabled={!canEdit || !recordSummary.trim() || mutation !== null} loading={mutation === 'record'} icon={<Plus aria-hidden="true" />}>{t('persistentWorkspace.addRecord')}</Button>
                </div>
              </div>
            </section>
          </div>
) : null}
        {section === 'artifacts' ? (
          <div className={styles.sectionStack}>
            <section className={styles.card}>
              <SectionHeading icon={<File aria-hidden="true" />} title={t('persistentWorkspace.artifacts')} count={artifacts.length} open={openSections.artifacts} onToggle={() => toggleSection('artifacts')} id="persistent-workspace-artifacts" />
              {openSections.artifacts ? (
                <div id="persistent-workspace-artifacts" className={styles.cardBody}>
                  <p className={styles.boundaryHint}>{t('persistentWorkspace.artifactBoundaryHint')}</p>
                  {artifacts.length === 0 ? <p className={styles.emptyInline}>{t('persistentWorkspace.noArtifacts')}</p> : (
                    <ul className={styles.entryList}>
                      {artifacts.map((artifact) => (
                        <li key={artifact.id} className={styles.entryCard}>
                          <div className={styles.entryTopline}><strong>{artifact.mimeType}</strong><span>{t('agentRun.workspace.bytes', { count: artifact.byteCount.toLocaleString() })}</span></div>
                          <div className={styles.entryBadges}>
                            <span>{t('persistentWorkspace.digest', { digest: displayId(artifact.blobDigest) })}</span>
                            <span>{t('persistentWorkspace.revision', { revision: artifact.revision })}</span>
                            {artifact.turnSessionId ? <span>{t('persistentWorkspace.sessionLink', { id: displayId(artifact.turnSessionId) })}</span> : null}
                          </div>
                          <p>{artifact.provenance}</p>
                          <div className={styles.entryFooter}>
                            <span>{t('persistentWorkspace.createdAt', { date: dateLabel(artifact.createdAt) })}</span>
                            {artifact.chatId ? <span>{t('persistentWorkspace.sourceChat', { id: displayId(artifact.chatId) })}</span> : <span>{t('persistentWorkspace.sourceChatDeleted')}</span>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </section>
          </div>
        ) : null}

        {section === 'publications' ? (
          <div className={styles.sectionStack}>
            <section className={styles.card}><SectionHeading icon={<Archive aria-hidden="true" />} title={t('persistentWorkspace.publications')} count={publications.length} open={openSections.publications} onToggle={() => toggleSection('publications')} id="persistent-workspace-publications" />{openSections.publications ? <div id="persistent-workspace-publications" className={styles.cardBody}><p className={styles.boundaryHint}>{t('persistentWorkspace.publicationBoundaryHint')}</p>{publications.length === 0 ? <p className={styles.emptyInline}>{t('persistentWorkspace.noPublications')}</p> : <ul className={styles.entryList}>{publications.map((publication) => <li key={publication.id} className={styles.publicationCard}><div className={styles.entryTopline}><strong>{t(`persistentWorkspace.publicationCategories.${publication.category}`)}</strong><StateBadge tone={publication.sourceStatus === 'deleted' ? 'warning' : 'success'}>{publication.sourceStatus === 'deleted' ? t('persistentWorkspace.sourceDeleted') : t('persistentWorkspace.sourcePresent')}</StateBadge></div><p>{publicationCopyLabel(publication)}</p><div className={styles.provenanceGrid}><span>{t('persistentWorkspace.sourceId', { id: displayId(publication.sourceId) })}</span><><span>{t('persistentWorkspace.sourceRevision', { revision: publication.sourceRevision })}</span><span>{t('persistentWorkspace.sourceDigest', { digest: displayId(publication.sourceDigest) })}</span></><span>{t('persistentWorkspace.copyDigest', { digest: displayId(publication.copyDigest) })}</span><span>{t('persistentWorkspace.publishedAt', { date: dateLabel(publication.publishedAt) })}</span>{publication.sourceProvenance.sourceMessageId ? <span>{t('persistentWorkspace.sourceMessage', { id: displayId(publication.sourceProvenance.sourceMessageId) })}</span> : null}{publication.sourceProvenance.sourceSwipeId !== null ? <span>{t('persistentWorkspace.sourceSwipe', { id: publication.sourceProvenance.sourceSwipeId })}</span> : null}</div>{publication.sourceDeletedAt !== null || publication.sourceStatus === 'deleted' ? <div className={styles.deletedSource}><Unlink aria-hidden="true" />{t('persistentWorkspace.deletedPublicationNotice')}</div> : null}<div className={styles.publicationFooter}><span>{t('persistentWorkspace.immutableCopy')}</span><Button type="button" variant="danger-ghost" size="sm" onClick={() => setConfirmDeletePublication(publication)} disabled={mutation !== null} icon={<Trash2 aria-hidden="true" />}>{t('persistentWorkspace.deletePublication')}</Button></div></li>)}</ul>}</div> : null}</section>
            <section className={styles.card}>
              <div className={styles.cardBody}>
                <h3 className={styles.formTitle}><Archive aria-hidden="true" />{t('persistentWorkspace.publishSelection')}</h3>
                <p className={styles.boundaryHint}>{t('persistentWorkspace.publishHint')}</p>
                <div className={styles.formGrid}>
                  <FormField label={t('persistentWorkspace.publicationSource')}>
                    <Select value={publicationSourceId} onChange={(value) => { const selected = publishOptions.find((option) => option.value === value); setPublicationSourceId(value); if (selected) setPublicationCategory(selected.category) }} disabled={!canEdit || mutation !== null} aria-label={t('persistentWorkspace.publicationSource')} options={publishOptions.map((option) => ({ value: option.value, label: option.label }))} />
                  </FormField>
                  <FormField label={t('persistentWorkspace.publicationCategory')}>
                    <Select value={selectedPublication?.category ?? publicationCategory} onChange={(value) => setPublicationCategory(value as WorkspacePublicationCategory)} disabled={!canEdit || mutation !== null} aria-label={t('persistentWorkspace.publicationCategory')} options={[{ value: 'task', label: t('persistentWorkspace.publicationCategories.task') }, { value: 'finding', label: t('persistentWorkspace.publicationCategories.finding') }, { value: 'objective', label: t('persistentWorkspace.publicationCategories.objective') }, { value: 'artifact', label: t('persistentWorkspace.publicationCategories.artifact') }]} />
                  </FormField>
                </div>
                <p className={styles.fieldMeta}>{t('persistentWorkspace.selectedSource', { source: selectedSourceLabel })}</p>
                <div className={styles.formActions}>
                  <Button type="button" onClick={publishSelection} disabled={!canEdit || !publicationSourceId || mutation !== null} loading={mutation === 'publish'} icon={<Archive aria-hidden="true" />}>{t('persistentWorkspace.publish')}</Button>
                </div>
              </div>
            </section>
            </div>
        ) : null}
      </div>

      <footer className={styles.footer}>
        <span>{t('persistentWorkspace.ownerOnlyFooter')}</span>
        <Button type="button" variant="danger-ghost" size="sm" onClick={() => setConfirmDeleteWorkspace(true)} disabled={mutation !== null} icon={<Trash2 aria-hidden="true" />}>{t('persistentWorkspace.deleteWorkspace')}</Button>
      </footer>

      <ConfirmationModal
        isOpen={confirmDeleteWorkspace}
        onCancel={() => setConfirmDeleteWorkspace(false)}
        onConfirm={() => {
          setConfirmDeleteWorkspace(false)
          void runMutation('workspace-delete', () => onDeleteWorkspace(workspace.revision))
        }}
        title={t('persistentWorkspace.deleteWorkspaceTitle')}
        message={t('persistentWorkspace.deleteWorkspaceMessage')}
        confirmText={t('persistentWorkspace.deleteWorkspaceConfirm')}
        cancelText={t('persistentWorkspace.cancel')}
        variant="danger"
        loading={mutation === 'workspace-delete'}
        loadingText={t('persistentWorkspace.deleting')}
      />
      <ConfirmationModal
        isOpen={confirmDeletePublication !== null}
        onCancel={() => setConfirmDeletePublication(null)}
        onConfirm={deletePublication}
        title={t('persistentWorkspace.deletePublicationTitle')}
        message={t('persistentWorkspace.deletePublicationMessage')}
        confirmText={t('persistentWorkspace.deletePublicationConfirm')}
        cancelText={t('persistentWorkspace.cancel')}
        variant="danger"
        loading={mutation === 'publication-delete'}
        loadingText={t('persistentWorkspace.deleting')}
      />
      {loading ? <div className={styles.loadingOverlay} role="status"><LoaderCircle className={styles.spinner} aria-hidden="true" />{t('persistentWorkspace.refreshing')}</div> : null}
    </section>
  )
}

export default PersistentWorkspaceInspector
