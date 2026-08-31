import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  CircleX,
  Clock3,
  Copy,
  EyeOff,
  FileText,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldAlert,
  X,
} from 'lucide-react'
import { useStore } from '@/store'
import { agentRunsApi } from '@/api/agent-runs'
import type {
  AgentPersistentWorkspaceArtifactV1,
  AgentPersistentWorkspacePublicationV1,
  AgentPersistentWorkspaceRecordV1,
  AgentPersistentWorkspaceSubmissionV1,
  AgentPersistentWorkspaceTaskV1,
  AgentPersistentWorkspaceTurnSessionPageV1,
  AgentPersistentWorkspaceTurnSessionV1,
  AgentPersistentWorkspaceV1,
  AgentInspectionCorrelationV1,
  AgentInspectionMarkerV1,
  AgentInspectionTranscriptRecordV1,
  AgentInspectionUsageV1,
  AgentInspectionUsageLayerV1,
  AgentRenderCrossingV1,
  AgentPromptEvidenceV1,
  AgentRunInspectionDetailV1,
  AgentTurnSessionEntryV1,
  AgentWorkspaceAssociationV1,
  WorkSegmentInspectionProjectionV1,
} from '@/types/agent-runs'
import type {
  LoomPromptInspectionItemV1,
  LoomPromptInspectionV1,
} from '@/types/agent-runtime'
import type { AgentPersistentWorkspaceCollectionV1 } from '@/types/store'
import { WorkReceiptSections } from './WorkReceipts'
import PersistentWorkspaceInspector, {
  type PersistentWorkspaceEditInput,
  type PersistentWorkspacePublicationDeleteInput,
  type PersistentWorkspacePublicationInput,
  type PersistentWorkspaceTaskInput,
} from './PersistentWorkspaceInspector'
import styles from './OwnerRunInspector.module.css'
type WorkTransitionInspectionV1 = WorkSegmentInspectionProjectionV1['transitions'][number]
type WorkDispatchInspectionV1 = WorkSegmentInspectionProjectionV1['dispatches'][number]
type WorkCausalTimelineItemV1 =
  | { readonly kind: 'recovery'; readonly id: string; readonly recovery: WorkSegmentInspectionProjectionV1['recovery']; readonly dispatch: WorkDispatchInspectionV1 | null }
  | { readonly kind: 'transition'; readonly id: string; readonly transition: WorkTransitionInspectionV1; readonly dispatch: WorkDispatchInspectionV1 | null }

const MAX_PAYLOAD_CHARS = 2_048
const MAX_EXPANDED_PAYLOAD_CHARS = 16_384
const MAX_RENDERED_ID_CHARS = 256
const INITIAL_VISIBLE_COLLECTION_COUNT = 12
const COLLECTION_REVEAL_STEP = 24
const PERSISTENT_WORKSPACE_SESSION_PAGE_SIZE = 50

type InspectionTab =
  | 'summary'
  | 'chronology'
  | 'turnSession'
  | 'prompts'
  | 'markers'
  | 'usage'
  | 'provenance'
  | 'receipts'

const INSPECTION_TABS: readonly InspectionTab[] = [
  'summary',
  'chronology',
  'turnSession',
  'prompts',
  'markers',
  'usage',
  'provenance',
  'receipts',
]

const TAB_LABEL_KEYS: Record<InspectionTab, string> = {
  summary: 'tabsSummary',
  chronology: 'tabsChronology',
  turnSession: 'tabsTurnSession',
  prompts: 'tabsPrompts',
  markers: 'tabsMarkers',
  usage: 'tabsUsage',
  provenance: 'tabsProvenance',
  receipts: 'tabsReceipts',
}

function formatEnum(value: string | null | undefined): string {
  if (!value) return '—'
  return value
}

type ChatTranslate = (key: string, options?: Record<string, unknown>) => string

const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000

function safeIsoTimestamp(value: number | null | undefined): string | undefined {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < -MAX_DATE_MILLISECONDS
    || value > MAX_DATE_MILLISECONDS
  ) return undefined
  try {
    return new Date(value).toISOString()
  } catch {
    return undefined
  }
}

function formatTimestamp(value: number | null | undefined, notRecorded: string): string {
  const iso = safeIsoTimestamp(value)
  if (!iso) return notRecorded
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso))
  } catch {
    return notRecorded
  }
}

function formatDuration(value: number | null | undefined, notRecorded: string, translate: ChatTranslate): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return notRecorded
  const milliseconds = Math.max(0, Math.round(value))
  if (milliseconds < 1_000) {
    return translate('ownerInspection.durationMilliseconds', { count: milliseconds })
  }
  const seconds = milliseconds / 1_000
  if (seconds < 60) {
    return translate('ownerInspection.durationSeconds', {
      value: seconds.toFixed(seconds >= 10 ? 0 : 1),
    })
  }
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds % 60)
  return translate('ownerInspection.durationMinutesSeconds', { minutes, seconds: remainingSeconds })
}

function boundedId(value: string | null | undefined): string {
  if (!value) return '—'
  return value.length > MAX_RENDERED_ID_CHARS ? `${value.slice(0, MAX_RENDERED_ID_CHARS)}…` : value
}

function compareCorrelation(
  left: AgentInspectionCorrelationV1 | null | undefined,
  right: AgentInspectionCorrelationV1 | null | undefined,
): number {
  const leftSequence = left?.hostSequence ?? Number.MAX_SAFE_INTEGER
  const rightSequence = right?.hostSequence ?? Number.MAX_SAFE_INTEGER
  if (leftSequence !== rightSequence) return leftSequence - rightSequence
  const leftParent = left?.parentId ?? ''
  const rightParent = right?.parentId ?? ''
  if (leftParent !== rightParent) return leftParent.localeCompare(rightParent)
  return (left?.hostCorrelationId ?? '').localeCompare(right?.hostCorrelationId ?? '')
}

function compareTranscript(left: AgentInspectionTranscriptRecordV1, right: AgentInspectionTranscriptRecordV1): number {
  const correlationOrder = compareCorrelation(left.correlation, right.correlation)
  if (correlationOrder !== 0) return correlationOrder
  if (left.occurredAt !== right.occurredAt) return left.occurredAt - right.occurredAt
  return left.id.localeCompare(right.id)
}

function compareTurnSession(left: AgentTurnSessionEntryV1, right: AgentTurnSessionEntryV1): number {
  const correlationOrder = compareCorrelation(left.correlation, right.correlation)
  if (correlationOrder !== 0) return correlationOrder
  if (left.occurredAt !== right.occurredAt) return left.occurredAt - right.occurredAt
  return left.id.localeCompare(right.id)
}

function comparePromptEvidence(left: AgentPromptEvidenceV1, right: AgentPromptEvidenceV1): number {
  const correlationOrder = compareCorrelation(left.correlation, right.correlation)
  if (correlationOrder !== 0) return correlationOrder
  return left.id.localeCompare(right.id)
}

function compareRenderCrossing(left: AgentRenderCrossingV1, right: AgentRenderCrossingV1): number {
  const correlationOrder = compareCorrelation(left.correlation, right.correlation)
  if (correlationOrder !== 0) return correlationOrder
  return left.id.localeCompare(right.id)
}


function loomInspectionKey(inspection: LoomPromptInspectionV1): string {
  const itemKeys = inspection.items.map((item) => {
    const outcomeKey = item.outcome.status === 'included'
      ? `${item.outcome.status}:${item.outcome.effectiveIndex}`
      : item.outcome.status === 'deduplicated'
        ? `${item.outcome.status}:${item.outcome.keptEntryId}:${item.outcome.destination}`
        : `${item.outcome.status}:${item.outcome.reason}`
    return [
      item.entryId,
      item.bucket,
      item.destination,
      item.checkpoint,
      item.source.blockId,
      item.source.presetRevision,
      item.source.blockRevision,
      item.source.promptOrder,
      item.required,
      item.condition ? JSON.stringify(item.condition) : 'unconditional',
      item.conditionResult ?? 'not_applicable',
      item.ordinaryPromptSuppressed,
      outcomeKey,
    ].join('\u0000')
  })
  const responseOmissionKey = inspection.responseOmission
    ? [
        inspection.responseOmission.reason,
        inspection.responseOmission.omittedEntryIds.join('\u0000'),
        inspection.responseOmission.source
          .map((source) => (
            `${source.blockId}:${source.presetRevision}:${source.blockRevision}:${source.promptOrder}`
          ))
          .join('\u0000'),
        inspection.responseOmission.omittedPhaseInstructions
          .map(({ phaseId, source }) => (
            `${phaseId}:${source.blockId}:${source.presetRevision}:${source.blockRevision}:${source.promptOrder}`
          ))
          .join('\u0000'),
      ].join('\u0001')
    : 'no_response_omission'
  return [
    inspection.surface,
    inspection.checkpoint,
    itemKeys.join('\u0001'),
    inspection.effectiveEntryIds.join('\u0000'),
    responseOmissionKey,
  ].join('\u0002')
}

function loomOutcomeValue(item: LoomPromptInspectionItemV1, t: ChatTranslate): string {
  const status = valueLabel(t, item.outcome.status)
  if (item.outcome.status === 'included') {
    return t('ownerInspection.ar007.outcomeIncluded', { status, index: item.outcome.effectiveIndex + 1 })
  }
  if (item.outcome.status === 'deduplicated') {
    return t('ownerInspection.ar007.outcomeDeduplicated', {
      status,
      entry: boundedId(item.outcome.keptEntryId),
      destination: valueLabel(t, item.outcome.destination),
    })
  }
  return t('ownerInspection.ar007.outcomeReason', {
    status,
    reason: valueLabel(t, item.outcome.reason),
  })
}

function loomRepairReason(item: LoomPromptInspectionItemV1, t: ChatTranslate): string | null {
  const reason = 'reason' in item.outcome ? item.outcome.reason : null
  if (
    reason === 'stale_source'
    || reason === 'invalid_source'
    || reason === 'required_source_unavailable'
    || item.conditionResult === 'invalid'
  ) {
    return t('ownerInspection.ar007.repairRequired')
  }
  return null
}

function statusTone(inspection: AgentRunInspectionDetailV1): 'live' | 'completed' | 'failed' | 'stopped' {
  if (!inspection.terminal) return 'live'
  if (inspection.outcome === 'completed') return 'completed'
  if (inspection.outcome === 'stopped') return 'stopped'
  return 'failed'
}

function StatusGlyph({ tone, live }: { tone: ReturnType<typeof statusTone>; live?: boolean }) {
  if (tone === 'completed') return <CheckCircle2 aria-hidden="true" />
  if (tone === 'failed') return <CircleX aria-hidden="true" />
  if (tone === 'stopped') return <Clock3 aria-hidden="true" />
  return live ? <LoaderCircle className={styles.spinner} aria-hidden="true" /> : <CircleDot aria-hidden="true" />
}

function useDialogFocus(isOpen: boolean, onClose: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!isOpen) return
    const returnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const focusable = dialog?.querySelectorAll<HTMLElement>(focusableSelector)
    const autoFocus = dialog?.querySelector<HTMLElement>('[data-inspector-autofocus="true"]')
    ;(autoFocus ?? focusable?.[0] ?? dialog)?.focus()
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const controls = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
      if (controls.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    dialog?.addEventListener('keydown', handleKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      dialog?.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      returnTarget?.focus()
    }
  }, [isOpen, onClose])
  return dialogRef
}

function valueLabel(translate: (key: string, options?: Record<string, unknown>) => string, value: string | null | undefined): string {
  if (!value) return '—'
  return translate(`ownerInspection.values.${value}`, { defaultValue: formatEnum(value) })
}

function errorSummaryLabel(
  translate: (key: string, options?: Record<string, unknown>) => string,
  summaryCode: string,
  code: string,
): string {
  const key = summaryCode.startsWith('agentRun.errors.')
    ? summaryCode
    : `agentRun.errors.${code}`
  return translate(key, { defaultValue: formatEnum(code) })
}

function Field({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className={styles.field}>
      <dt>{label}</dt>
      <dd className={mono ? styles.mono : undefined}>{value}</dd>
    </div>
  )
}

function CorrelationGrid({ correlation, t }: {
  correlation: AgentInspectionCorrelationV1
  t: (key: string, options?: Record<string, unknown>) => string
}) {
  return (
    <dl className={styles.correlationGrid} aria-label={t('ownerInspection.correlation')}>
      <Field label={t('ownerInspection.turnSessionId')} value={boundedId(correlation.turnSessionId)} mono />
      <Field label={t('ownerInspection.runId')} value={boundedId(correlation.runId)} mono />
      <Field label={t('ownerInspection.attemptId')} value={boundedId(correlation.attemptId)} mono />
      <Field label={t('ownerInspection.chatId')} value={boundedId(correlation.chatId)} mono />
      <Field label={t('ownerInspection.generationId')} value={boundedId(correlation.generationId)} mono />
      <Field label={t('ownerInspection.message')} value={boundedId(correlation.messageId)} mono />
      <Field label={t('ownerInspection.swipe')} value={correlation.swipeId ?? '—'} />
      <Field label={t('ownerInspection.actor')} value={valueLabel(t, correlation.actorId)} />
      <Field label={t('ownerInspection.recipient')} value={valueLabel(t, correlation.recipientId)} />
      <Field label={t('ownerInspection.phase')} value={valueLabel(t, correlation.phase)} />
      <Field label={t('ownerInspection.task')} value={boundedId(correlation.taskId)} mono />
      <Field label={t('ownerInspection.tool')} value={boundedId(correlation.toolId)} mono />
      <Field label={t('ownerInspection.parent')} value={boundedId(correlation.parentId)} mono />
      <Field label={t('ownerInspection.hostCorrelationId')} value={boundedId(correlation.hostCorrelationId)} mono />
      <Field label={t('ownerInspection.hostSequence')} value={correlation.hostSequence} />
    </dl>
  )
}

function Payload({ value, label, t }: {
  value: string | null | undefined
  label: string
  t: (key: string, options?: Record<string, unknown>) => string
}) {
  const [expanded, setExpanded] = useState(false)
  if (!value) return <p className={styles.noContent}>{label}: {t('ownerInspection.noContent')}</p>
  const isBounded = value.length > MAX_PAYLOAD_CHARS
  const limit = expanded ? MAX_EXPANDED_PAYLOAD_CHARS : MAX_PAYLOAD_CHARS
  const text = value.length > limit ? `${value.slice(0, limit)}\n…` : value
  return (
    <div className={styles.payload}>
      <div className={styles.payloadLabel}>{label}</div>
      <pre className={styles.payloadText} tabIndex={0}>{text}</pre>
      {isBounded ? (
        <div className={styles.payloadActions}>
          <span className={styles.payloadNotice}>{t('ownerInspection.boundedContent')}</span>
          <button type="button" className={styles.inlineButton} onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>
            {expanded ? t('ownerInspection.showLess') : t('ownerInspection.showMore')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function MarkerBadge({ marker, t }: { marker: AgentInspectionMarkerV1; t: (key: string, options?: Record<string, unknown>) => string }) {
  const privacy = marker.kind === 'credentials_withheld' || marker.kind === 'other_user_data_withheld'
  return <span className={styles.markerBadge} data-privacy={privacy || undefined}>{privacy ? <LockKeyhole aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}{valueLabel(t, marker.kind)}</span>
}

function TranscriptCard({ record, t, notRecorded }: {
  record: AgentInspectionTranscriptRecordV1
  t: (key: string, options?: Record<string, unknown>) => string
  notRecorded: string
}) {
  const isoTimestamp = safeIsoTimestamp(record.occurredAt)
  return (
    <article className={styles.recordCard} data-late={record.late || undefined}>
      <header className={styles.recordHeader}>
        <div className={styles.recordTitle}><FileText aria-hidden="true" /><strong>{valueLabel(t, record.kind)}</strong><span className={styles.actorBadge}>{valueLabel(t, record.actor)}</span>{record.recipient ? <span className={styles.recipientBadge}>→ {valueLabel(t, record.recipient)}</span> : null}{record.late ? <span className={styles.lateBadge}>{t('ownerInspection.late')}</span> : null}</div>
        <div className={styles.recordMeta}><time {...(isoTimestamp ? { dateTime: isoTimestamp } : {})}>{formatTimestamp(record.occurredAt, notRecorded)}</time><span>#{record.correlation.hostSequence}</span><span>{formatDuration(record.durationMs, notRecorded, t)}</span></div>
      </header>
      <CorrelationGrid correlation={record.correlation} t={t} />
      <div className={styles.recordPayloads}><Payload value={record.content} label={t('ownerInspection.content')} t={t} /><Payload value={record.arguments} label={t('ownerInspection.arguments')} t={t} /><Payload value={record.result} label={t('ownerInspection.result')} t={t} /></div>
      {record.provider ? <dl className={styles.providerGrid}><Field label={t('ownerInspection.providerAdapter')} value={record.provider.adapter} /><Field label={t('ownerInspection.providerId')} value={boundedId(record.provider.providerId)} mono /><Field label={t('ownerInspection.modelId')} value={boundedId(record.provider.modelId)} mono /><Field label={t('ownerInspection.connectionId')} value={boundedId(record.provider.connectionId ?? null)} mono /><Field label={t('ownerInspection.configRevision')} value={record.provider.configRevision ?? '—'} /><Field label={t('ownerInspection.connectionRevision')} value={record.provider.connectionRevision ?? '—'} /></dl> : null}
      {record.errorReason ? <div className={styles.errorLine} role="status"><CircleX aria-hidden="true" /><span>{t('ownerInspection.errorReason')}: {valueLabel(t, record.errorReason)}</span></div> : null}
    </article>
  )
}

function TurnSessionCard({ entry, t, notRecorded, resetKey }: {
  entry: AgentTurnSessionEntryV1
  t: (key: string, options?: Record<string, unknown>) => string
  notRecorded: string
  resetKey: string
}) {
  const isoTimestamp = safeIsoTimestamp(entry.occurredAt)
  return (
    <article className={styles.sessionCard}>
      <header className={styles.recordHeader}><div className={styles.recordTitle}><ShieldAlert aria-hidden="true" /><strong>{valueLabel(t, entry.kind)}</strong></div><time {...(isoTimestamp ? { dateTime: isoTimestamp } : {})}>{formatTimestamp(entry.occurredAt, notRecorded)}</time></header>
      <p className={styles.sessionDetail}>{entry.detail}</p>
      <CorrelationGrid correlation={entry.correlation} t={t} />
      {entry.transcriptRecordIds.length > 0 ? (
        <BoundedIdList
          ids={entry.transcriptRecordIds}
          resetKey={`${resetKey}:${entry.id}`}
          listId={`owner-inspection-turn-session-${entry.id}-linked-records`}
          label={t('ownerInspection.linkedRecords')}
          t={t}
        />
      ) : null}
    </article>
  )
}

function PromptCard({ prompt, t, position, resetKey }: {
  prompt: AgentPromptEvidenceV1
  t: (key: string, options?: Record<string, unknown>) => string
  position: number
  resetKey: string
}) {
  const nativeProvenance = prompt.nativeProvenance
  const nativeLabel = nativeProvenance?.kind === 'world_info'
    ? t('ownerInspection.ar007.nativeWorldInfo')
    : nativeProvenance?.kind === 'databank'
      ? t('ownerInspection.ar007.nativeDatabank')
      : null
  const orderedNativeSources = useMemo(
    () => nativeProvenance?.kind === 'databank'
      ? nativeProvenance.sources.map((source, sourceIndex) => ({ source, sourceIndex }))
      : [],
    [nativeProvenance],
  )
  return (
    <article className={styles.promptCard}>
      <header className={styles.recordHeader}>
        <div className={styles.recordTitle}>
          <span className={styles.orderBadge}>{position + 1}</span>
          <FileText aria-hidden="true" />
          <strong>{valueLabel(t, prompt.destination)}</strong>
          <span className={styles.actorBadge}>{valueLabel(t, prompt.role)}</span>
          {nativeLabel ? <span className={styles.nativeBadge}>{nativeLabel}</span> : null}
          <span className={prompt.included ? styles.includedBadge : styles.omittedBadge}>
            {prompt.included ? t('ownerInspection.promptIncluded') : t('ownerInspection.promptOmitted')}
          </span>
        </div>
        <span className={styles.recordMeta}>#{prompt.correlation.hostSequence}</span>
      </header>
      <dl className={styles.providerGrid}>
        <Field label={t('ownerInspection.ar007.orderedRecord')} value={position + 1} />
        <Field label={t('ownerInspection.promptRole')} value={valueLabel(t, prompt.role)} />
        <Field label={t('ownerInspection.promptDestination')} value={valueLabel(t, prompt.destination)} />
        <Field label={t('ownerInspection.sourceId')} value={boundedId(prompt.sourceId)} mono />
        <Field label={t('ownerInspection.sourceRevision')} value={prompt.sourceRevision} />
        <Field label={t('ownerInspection.promptOrder')} value={prompt.promptOrder} />
        <Field label={t('ownerInspection.contentDigest')} value={boundedId(prompt.contentDigest)} mono />
      </dl>
      {nativeProvenance?.kind === 'world_info' ? (
        <section className={styles.nativeProvenance} aria-label={t('ownerInspection.ar007.nativeWorldInfoAria')}>
          <p className={styles.nativeBoundary}>{t('ownerInspection.ar007.worldInfoBoundary')}</p>
          <dl className={styles.providerGrid}>
            <Field label={t('ownerInspection.ar007.nativeKind')} value="world_info" mono />
            <Field label={t('ownerInspection.ar007.worldInfoSource')} value={boundedId(nativeProvenance.sourceId)} mono />
            <Field label={t('ownerInspection.ar007.nativeSourceRevision')} value={nativeProvenance.sourceRevision} />
            <Field label={t('ownerInspection.ar007.nativeSourceIndex')} value={nativeProvenance.sourceIndex} />
            <Field label={t('ownerInspection.ar007.assembledContentDigest')} value={boundedId(prompt.contentDigest)} mono />
          </dl>
        </section>
      ) : null}
      {nativeProvenance?.kind === 'databank' ? (
        <section className={styles.nativeProvenance} aria-label={t('ownerInspection.ar007.nativeDatabankAria')}>
          <p className={styles.nativeBoundary}>{t('ownerInspection.ar007.databankBoundary')}</p>
          <dl className={styles.providerGrid}>
            <Field label={t('ownerInspection.ar007.nativeKind')} value="databank" mono />
            <Field label={t('ownerInspection.ar007.databankSourceRevision')} value={boundedId(nativeProvenance.sourceRevision)} mono />
            <Field label={t('ownerInspection.ar007.nativeSourceCount')} value={nativeProvenance.sources.length.toLocaleString()} />
            <Field label={t('ownerInspection.ar007.assembledContentDigest')} value={boundedId(prompt.contentDigest)} mono />
          </dl>
          <BoundedCollection
            items={orderedNativeSources}
            resetKey={`${resetKey}:${prompt.id}:native-databank`}
            listId={`owner-inspection-prompt-${prompt.id}-native-databank`}
            label={t('ownerInspection.ar007.nativeDatabankSources')}
            getKey={({ source, sourceIndex }) => `${sourceIndex}:${source.kind}:${source.databankId}:${source.documentId}:${source.chunkId ?? 'mention'}:${source.contentHash}`}
            className={styles.nativeSourceList}
            t={t}
            renderItem={({ source, sourceIndex }) => (
              <article className={styles.nativeSourceItem}>
                <header className={styles.recordHeader}>
                  <strong>{source.documentName}</strong>
                  <span className={styles.nativeBadge}>{source.kind}</span>
                </header>
                <dl className={styles.providerGrid}>
                  <Field label={t('ownerInspection.ar007.nativeSourceOrder')} value={sourceIndex + 1} />
                  <Field label={t('ownerInspection.ar007.databank')} value={boundedId(source.databankId)} mono />
                  <Field label={t('ownerInspection.ar007.document')} value={boundedId(source.documentId)} mono />
                  <Field label={t('ownerInspection.ar007.chunk')} value={boundedId(source.chunkId)} mono />
                  <Field label={t('ownerInspection.ar007.documentContentHash')} value={boundedId(source.documentContentHash)} mono />
                  <Field label={t('ownerInspection.ar007.deliveredContentHash')} value={boundedId(source.contentHash)} mono />
                </dl>
              </article>
            )}
          />
        </section>
      ) : null}
      {prompt.loomInspection ? (
        <p className={styles.boundaryNotice}>
          <ShieldAlert aria-hidden="true" />
          {t('ownerInspection.ar007.loomRecordLink')}
        </p>
      ) : null}
      <CorrelationGrid correlation={prompt.correlation} t={t} />
      <Payload value={prompt.content} label={t('ownerInspection.content')} t={t} />
      {!prompt.included && prompt.omissionReason ? (
        <div className={styles.omissionLine}>
          <EyeOff aria-hidden="true" />
          {t('ownerInspection.omissionReason')}: {prompt.omissionReason}
        </div>
      ) : null}
    </article>
  )
}

function LoomInspectionLedger({
  inspection,
  inspectionIndex,
  roleBySource,
  resetKey,
  t,
  notRecorded,
}: {
  inspection: LoomPromptInspectionV1
  inspectionIndex: number
  roleBySource: ReadonlyMap<string, AgentPromptEvidenceV1['role']>
  resetKey: string
  t: ChatTranslate
  notRecorded: string
}) {
  const responseOmission = inspection.responseOmission
  const ledgerId = `owner-inspection-loom-${inspectionIndex}`
  return (
    <article className={styles.inspectionLedger}>
      <header className={styles.ledgerHeader}>
        <div>
          <p className={styles.ledgerEyebrow}>{t('ownerInspection.ar007.loomAgenticInstructions')}</p>
          <h4>{t('ownerInspection.loomInspection')}</h4>
          <p>{t('ownerInspection.ar007.loomNativeBoundary')}</p>
        </div>
        <dl className={styles.ledgerMeta}>
          <Field label={t('ownerInspection.loomSurface')} value={valueLabel(t, inspection.surface)} />
          <Field label={t('ownerInspection.loomCheckpoint')} value={valueLabel(t, inspection.checkpoint)} />
        </dl>
      </header>
      <p className={styles.nativeBoundary}>{t('ownerInspection.ar007.fixedRoutes')}</p>

      {inspection.effectiveEntryIds.length > 0 ? (
        <BoundedIdList
          ids={inspection.effectiveEntryIds}
          resetKey={`${resetKey}:loom-effective:${inspectionIndex}`}
          listId={`${ledgerId}-effective-order`}
          label={t('ownerInspection.ar007.effectiveEntryOrder')}
          t={t}
        />
      ) : (
        <p className={styles.mutedNotice}>{t('ownerInspection.ar007.noEffectiveLoomEntry')}</p>
      )}

      {inspection.items.length > 0 ? (
        <BoundedCollection
          items={inspection.items}
          resetKey={`${resetKey}:loom-items:${inspectionIndex}`}
          listId={`${ledgerId}-items`}
          label={t('ownerInspection.loomInspection')}
          getKey={(item) => item.entryId}
          className={styles.loomItems}
          t={t}
          renderItem={(item) => {
            const repairReason = loomRepairReason(item, t)
            const outcomeReason = item.outcome.reason
            const fixedRole = roleBySource.get(JSON.stringify([
              item.source.blockId,
              item.source.promptOrder,
              item.source.blockRevision,
            ]))
            return (
              <details className={styles.loomItem}>
                <summary className={styles.loomItemSummary}>
                  <span className={styles.orderBadge}>
                    {item.outcome.status === 'included' ? item.outcome.effectiveIndex + 1 : item.source.promptOrder + 1}
                  </span>
                  <span className={styles.loomItemIdentity}>
                    <strong>{boundedId(item.entryId)}</strong>
                    <small>{valueLabel(t, item.bucket)} → {valueLabel(t, item.destination)} @ {valueLabel(t, item.checkpoint)}</small>
                  </span>
                  <span className={item.outcome.status === 'included' ? styles.includedBadge : styles.omittedBadge}>
                    {valueLabel(t, item.outcome.status)}
                  </span>
                </summary>
                <div className={styles.loomItemBody}>
                  <dl className={styles.providerGrid}>
                    <Field label={t('ownerInspection.loomSource')} value={boundedId(item.source.blockId)} mono />
                    <Field label={t('ownerInspection.ar007.presetRevision')} value={item.source.presetRevision} />
                    <Field label={t('ownerInspection.ar007.blockRevision')} value={item.source.blockRevision} />
                    <Field label={t('ownerInspection.promptOrder')} value={item.source.promptOrder} />
                    <Field label={t('ownerInspection.ar007.fixedRole')} value={fixedRole ? valueLabel(t, fixedRole) : notRecorded} />
                    <Field label={t('ownerInspection.loomDestination')} value={valueLabel(t, item.destination)} />
                    <Field label={t('ownerInspection.loomCheckpoint')} value={valueLabel(t, item.checkpoint)} />
                    <Field label={t('agentRuntime.provenance.loomInspection.required')} value={item.required ? t('ownerInspection.ar007.booleanTrue') : t('ownerInspection.ar007.booleanFalse')} />
                    <Field
                      label={t('agentRuntime.provenance.loomInspection.condition')}
                      value={item.condition ? JSON.stringify(item.condition) : t('ownerInspection.ar007.notApplicable')}
                      mono={Boolean(item.condition)}
                    />
                    <Field
                      label={t('agentRuntime.provenance.loomInspection.conditionResult')}
                      value={valueLabel(t, item.conditionResult ?? 'not_applicable')}
                    />
                    <Field label={t('agentRuntime.provenance.loomInspection.outcome')} value={loomOutcomeValue(item, t)} />
                    {outcomeReason ? <Field label={t('ownerInspection.reason')} value={valueLabel(t, outcomeReason)} /> : null}
                    {item.outcome.status === 'deduplicated' ? (
                      <>
                        <Field label={t('ownerInspection.ar007.dedupeRetainedEntry')} value={boundedId(item.outcome.keptEntryId)} mono />
                        <Field label={t('ownerInspection.ar007.dedupeRetainedDestination')} value={valueLabel(t, item.outcome.destination)} />
                      </>
                    ) : null}
                    <Field
                      label={t('agentRuntime.provenance.loomInspection.ordinarySuppressed')}
                      value={item.ordinaryPromptSuppressed ? t('ownerInspection.ar007.booleanTrue') : t('ownerInspection.ar007.booleanFalse')}
                    />
                  </dl>
                  {repairReason ? (
                    <p className={styles.repairReason}>
                      <ShieldAlert aria-hidden="true" />
                      {repairReason}
                    </p>
                  ) : null}
                  <Payload value={item.effectiveText} label={t('ownerInspection.loomEffectiveText')} t={t} />
                </div>
              </details>
            )
          }}
        />
      ) : (
        <p className={styles.mutedNotice}>{t('ownerInspection.ar007.noFixedBucketEntries')}</p>
      )}

      {responseOmission ? (
        <section className={styles.responseOmissionLedger} aria-label={t('ownerInspection.responseOmission')}>
          <header>
            <EyeOff aria-hidden="true" />
            <div>
              <strong>{t('ownerInspection.responseOmission')}</strong>
              <p>{t('ownerInspection.ar007.responseKeepsNative', { reason: responseOmission.reason })}</p>
            </div>
          </header>
          {responseOmission.omittedEntryIds.length > 0 ? (
            <BoundedIdList
              ids={responseOmission.omittedEntryIds}
              resetKey={`${resetKey}:response-omitted:${inspectionIndex}`}
              listId={`${ledgerId}-response-omitted`}
              label={t('ownerInspection.ar007.omittedFixedBucketEntries')}
              t={t}
            />
          ) : null}
          {responseOmission.omittedPhaseInstructions.length > 0 ? (
            <BoundedCollection
              items={responseOmission.omittedPhaseInstructions}
              resetKey={`${resetKey}:response-phases:${inspectionIndex}`}
              listId={`${ledgerId}-response-phases`}
              label={t('ownerInspection.ar007.omittedCustomPhaseInstructions')}
              getKey={({ phaseId, source }) => `${phaseId}:${source.blockId}:${source.presetRevision}:${source.blockRevision}:${source.promptOrder}`}
              t={t}
              renderItem={({ phaseId, source }) => {
                const fixedRole = roleBySource.get(JSON.stringify([
                  source.blockId,
                  source.promptOrder,
                  source.blockRevision,
                ]))
                return (
                  <article className={styles.phaseItem}>
                    <header className={styles.recordHeader}>
                      <strong>{boundedId(phaseId)}</strong>
                      <span className={styles.omittedBadge}>{t('ownerInspection.ar007.responseOmitted')}</span>
                    </header>
                    <dl className={styles.providerGrid}>
                      <Field label={t('ownerInspection.ar007.customPhase')} value={boundedId(phaseId)} mono />
                      <Field label={t('ownerInspection.loomSource')} value={boundedId(source.blockId)} mono />
                      <Field label={t('ownerInspection.ar007.presetRevision')} value={source.presetRevision} />
                      <Field label={t('ownerInspection.ar007.blockRevision')} value={source.blockRevision} />
                      <Field label={t('ownerInspection.promptOrder')} value={source.promptOrder} />
                      <Field label={t('ownerInspection.ar007.fixedRole')} value={fixedRole ? valueLabel(t, fixedRole) : notRecorded} />
                      <Field label={t('ownerInspection.reason')} value={t('ownerInspection.ar007.responseSurfaceReason')} />
                    </dl>
                  </article>
                )
              }}
            />
          ) : null}
        </section>
      ) : inspection.surface === 'WORK' ? (
        <p className={styles.evidenceUnavailable}>
          {t('ownerInspection.ar007.customPhaseExecutionUnavailable')}
        </p>
      ) : null}
    </article>
  )
}

function ExecutionEvidenceCard({
  record,
  t,
  notRecorded,
}: {
  record: AgentInspectionTranscriptRecordV1
  t: (key: string, options?: Record<string, unknown>) => string
  notRecorded: string
}) {
  return (
    <article className={styles.receiptCard}>
      <header className={styles.recordHeader}>
        <div className={styles.recordTitle}>
          <ShieldAlert aria-hidden="true" />
          <strong>{valueLabel(t, record.kind)}</strong>
          <span className={styles.actorBadge}>{valueLabel(t, record.actor)}</span>
          {record.recipient ? <span className={styles.recipientBadge}>{valueLabel(t, record.recipient)}</span> : null}
        </div>
        <span className={styles.recordMeta}>#{record.correlation.hostSequence}</span>
      </header>
      <dl className={styles.providerGrid}>
        <Field label={t('ownerInspection.phase')} value={valueLabel(t, record.correlation.phase)} />
        <Field label={t('ownerInspection.tool')} value={boundedId(record.correlation.toolId)} mono />
        <Field label={t('ownerInspection.task')} value={boundedId(record.correlation.taskId)} mono />
        <Field label={t('ownerInspection.duration')} value={formatDuration(record.durationMs, notRecorded, t)} />
        <Field label={t('ownerInspection.errorReason')} value={valueLabel(t, record.errorReason)} />
      </dl>
      <p className={styles.privacyNotice}>
        <LockKeyhole aria-hidden="true" />
        {t('ownerInspection.ar007.executionPrivacy')}
      </p>
    </article>
  )
}

function UsageCard({ usage, t }: { usage: AgentInspectionUsageV1 | AgentInspectionUsageLayerV1; t: (key: string, options?: Record<string, unknown>) => string }) {
  return (
    <article className={styles.usageCard}>
      <header className={styles.recordHeader}><strong>{valueLabel(t, usage.source)}</strong><span className={usage.canonical ? styles.includedBadge : styles.omittedBadge}>{usage.canonical ? t('ownerInspection.canonical') : t('ownerInspection.provisional')}</span></header>
      <dl className={styles.usageGrid}><Field label={t('ownerInspection.inputTokens')} value={usage.inputTokens.toLocaleString()} /><Field label={t('ownerInspection.outputTokens')} value={usage.outputTokens.toLocaleString()} /><Field label={t('ownerInspection.totalTokens')} value={usage.totalTokens.toLocaleString()} /><Field label={t('ownerInspection.toolCalls')} value={usage.toolCalls.toLocaleString()} /><Field label={t('ownerInspection.childInvocations')} value={usage.childInvocations.toLocaleString()} /></dl>
      {usage.correlation ? <CorrelationGrid correlation={usage.correlation} t={t} /> : null}
    </article>
  )
}

function RenderCrossingCard({ crossing, t }: {
  crossing: AgentRenderCrossingV1
  t: (key: string, options?: Record<string, unknown>) => string
}) {
  return (
    <article className={styles.receiptCard}>
      <header className={styles.recordHeader}>
        <div className={styles.recordTitle}>
          <ShieldAlert aria-hidden="true" />
          <strong>{valueLabel(t, crossing.kind)}</strong>
          <span className={styles.includedBadge}>{t('ownerInspection.ar007.renderAccepted')}</span>
        </div>
        <span className={styles.recordMeta}>#{crossing.correlation.hostSequence}</span>
      </header>
      <dl className={styles.providerGrid}>
        <Field label={t('ownerInspection.ar007.crossingKind')} value={valueLabel(t, crossing.kind)} />
        <Field label={t('ownerInspection.ar007.source')} value={boundedId(crossing.sourceId)} mono />
        <Field label={t('ownerInspection.sourceRevision')} value={crossing.sourceRevision ?? '—'} />
        <Field label={t('ownerInspection.contentDigest')} value={boundedId(crossing.contentDigest)} mono />
        <Field label={t('ownerInspection.phase')} value={valueLabel(t, crossing.correlation.phase)} />
      </dl>
      {crossing.content !== null ? (
        <Payload value={crossing.content} label={t('ownerInspection.ar007.boundedRenderContent')} t={t} />
      ) : (
        <p className={styles.mutedNotice}>{t('ownerInspection.ar007.digestOnlyCrossing')}</p>
      )}
      <p className={styles.privacyNotice}>
        <LockKeyhole aria-hidden="true" />
        {t('ownerInspection.ar007.renderProjectionPrivacy')}
      </p>
      <CorrelationGrid correlation={crossing.correlation} t={t} />
    </article>
  )
}

function WorkspaceAssociationCard({ association, t }: { association: AgentWorkspaceAssociationV1; t: (key: string, options?: Record<string, unknown>) => string }) {
  return (
    <article className={styles.workspaceCard} data-deleted={association.sourceDeleted || undefined}>
      <header className={styles.recordHeader}><strong>{valueLabel(t, association.objectKind)}</strong><span className={association.sourceDeleted ? styles.omittedBadge : styles.includedBadge}>{association.sourceDeleted ? t('ownerInspection.deletedSource') : valueLabel(t, association.relation)}</span></header>
      <dl className={styles.providerGrid}><Field label={t('ownerInspection.workspaceId')} value={boundedId(association.workspaceId)} mono /><Field label={t('ownerInspection.workspaceRevision')} value={association.workspaceRevision} /><Field label={t('ownerInspection.relation')} value={valueLabel(t, association.relation)} /><Field label={t('ownerInspection.object')} value={boundedId(association.objectId)} mono /><Field label={t('ownerInspection.sourceRevision')} value={association.sourceRevision ?? '—'} /><Field label={t('ownerInspection.contentDigest')} value={boundedId(association.provenanceDigest)} mono /></dl>
      {association.sourceDeleted ? <p className={styles.deletedNotice}>{t('ownerInspection.retentionDeleted')}</p> : null}
      <CorrelationGrid correlation={association.correlation} t={t} />
    </article>
  )
}

function useCollectionWindow<T>(items: readonly T[], resetKey: string) {
  const [windowState, setWindowState] = useState(() => ({
    resetKey,
    visibleCount: INITIAL_VISIBLE_COLLECTION_COUNT,
  }))
  const resetPending = windowState.resetKey !== resetKey
  const visibleCount = resetPending ? INITIAL_VISIBLE_COLLECTION_COUNT : windowState.visibleCount
  useEffect(() => {
    setWindowState((current) => current.resetKey === resetKey
      ? current
      : { resetKey, visibleCount: INITIAL_VISIBLE_COLLECTION_COUNT })
  }, [resetKey])
  useEffect(() => {
    setWindowState((current) => {
      const currentVisibleCount = current.resetKey === resetKey ? current.visibleCount : INITIAL_VISIBLE_COLLECTION_COUNT
      const nextVisibleCount = Math.min(Math.max(currentVisibleCount, INITIAL_VISIBLE_COLLECTION_COUNT), Math.max(items.length, INITIAL_VISIBLE_COLLECTION_COUNT))
      return current.resetKey === resetKey && currentVisibleCount === nextVisibleCount
        ? current
        : { resetKey, visibleCount: nextVisibleCount }
    })
  }, [items.length, resetKey])
  const shownCount = Math.min(items.length, visibleCount)
  const revealMore = useCallback(() => {
    setWindowState((current) => {
      const currentVisibleCount = current.resetKey === resetKey ? current.visibleCount : INITIAL_VISIBLE_COLLECTION_COUNT
      return {
        resetKey,
        visibleCount: Math.min(currentVisibleCount + COLLECTION_REVEAL_STEP, items.length),
      }
    })
  }, [items.length, resetKey])
  return {
    visibleItems: items.slice(0, shownCount),
    shownCount,
    revealMore,
  }
}

function CollectionControls({
  label,
  listId,
  shown,
  total,
  hasMore = shown < total,
  onShowMore,
  t,
}: {
  label: string
  listId: string
  shown: number
  total: number
  hasMore?: boolean
  onShowMore: () => void
  t: (key: string, options?: Record<string, unknown>) => string
}) {
  if (total === 0) return null
  return (
    <div className={styles.collectionControls}>
      <span role="status" aria-live="polite">{label}: {shown.toLocaleString()} / {total.toLocaleString()}</span>
      {hasMore ? (
        <button
          type="button"
          className={styles.secondaryButton}
          aria-controls={listId}
          onClick={onShowMore}
        >
          {t('ownerInspection.transcriptShowMore')}
        </button>
      ) : null}
    </div>
  )
}

function BoundedCollection<T>({
  items,
  resetKey,
  listId,
  label,
  getKey,
  renderItem,
  t,
  className = styles.cardList,
}: {
  items: readonly T[]
  resetKey: string
  listId: string
  label: string
  getKey: (item: T) => string
  renderItem: (item: T) => ReactNode
  t: (key: string, options?: Record<string, unknown>) => string
  className?: string
}) {
  const window = useCollectionWindow(items, resetKey)
  return (
    <>
      <div id={listId} className={className}>
        {window.visibleItems.map((item) => <Fragment key={getKey(item)}>{renderItem(item)}</Fragment>)}
      </div>
      <CollectionControls
        label={label}
        listId={listId}
        shown={window.shownCount}
        total={items.length}
        onShowMore={window.revealMore}
        t={t}
      />
    </>
  )
}

function BoundedIdList({
  ids,
  resetKey,
  listId,
  label,
  t,
}: {
  ids: readonly string[]
  resetKey: string
  listId: string
  label: string
  t: (key: string, options?: Record<string, unknown>) => string
}) {
  const window = useCollectionWindow(ids, resetKey)
  return (
    <div className={styles.linkedRecords}>
      <strong>{label}</strong>
      <ul id={listId}>
        {window.visibleItems.map((id) => <li key={id}><code>{boundedId(id)}</code></li>)}
      </ul>
      <CollectionControls
        label={label}
        listId={listId}
        shown={window.shownCount}
        total={ids.length}
        onShowMore={window.revealMore}
        t={t}
      />
    </div>
  )
}

function EmptyState({ children, icon = <FileText aria-hidden="true" /> }: { children: ReactNode; icon?: ReactNode }) {
  return <div className={styles.emptyState}>{icon}<p>{children}</p></div>
}

export interface OwnerRunInspectorProps {
  attemptId: string | null | undefined
  chatId?: string | null
  isOpen: boolean
  onClose: () => void
  initialInspection?: AgentRunInspectionDetailV1 | null
}

export default function OwnerRunInspector({ attemptId, chatId, isOpen, onClose, initialInspection = null }: OwnerRunInspectorProps) {
  const { t } = useTranslation('chat')
  const beginPersistentWorkspaceRequest = useStore((state) => state.beginPersistentWorkspaceRequest)
  const applyPersistentWorkspace = useStore((state) => state.applyPersistentWorkspace)
  const openModal = useStore((state) => state.openModal)
  const beginPersistentWorkspaceCollection = useStore((state) => state.beginPersistentWorkspaceCollection)
  const applyPersistentWorkspaceCollection = useStore((state) => state.applyPersistentWorkspaceCollection)
  const failPersistentWorkspaceCollection = useStore((state) => state.failPersistentWorkspaceCollection)
  const dialogRef = useDialogFocus(isOpen, onClose)
  const [inspection, setInspection] = useState<AgentRunInspectionDetailV1 | null>(initialInspection)
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [tab, setTab] = useState<InspectionTab>('summary')
  const [selectedRecordIndex, setSelectedRecordIndex] = useState(0)
  const [copiedCorrelation, setCopiedCorrelation] = useState(false)
  const [copyCorrelationError, setCopyCorrelationError] = useState(false)
  const [persistentWorkspace, setPersistentWorkspace] = useState<AgentPersistentWorkspaceV1 | null>(null)
  const persistentWorkspaceIdentityRef = useRef<{ id: string; chatId: string | null } | null>(null)
  useEffect(() => {
    persistentWorkspaceIdentityRef.current = persistentWorkspace
      ? { id: persistentWorkspace.id, chatId: persistentWorkspace.chatId }
      : null
  }, [persistentWorkspace?.chatId, persistentWorkspace?.id])
  const [workspaceSessions, setWorkspaceSessions] = useState<AgentPersistentWorkspaceTurnSessionV1[]>([])
  const [workspaceSessionsTotal, setWorkspaceSessionsTotal] = useState(0)
  const workspaceSessionsTotalRef = useRef(0)
  useEffect(() => {
    workspaceSessionsTotalRef.current = workspaceSessionsTotal
  }, [workspaceSessionsTotal])
  const [workspaceSessionsNextOffset, setWorkspaceSessionsNextOffset] = useState(0)
  const [workspaceSessionsLoadingMore, setWorkspaceSessionsLoadingMore] = useState(false)
  const [workspaceTasks, setWorkspaceTasks] = useState<AgentPersistentWorkspaceTaskV1[]>([])
  const [workspaceRecords, setWorkspaceRecords] = useState<AgentPersistentWorkspaceRecordV1[]>([])
  const [workspaceSubmissions, setWorkspaceSubmissions] = useState<AgentPersistentWorkspaceSubmissionV1[]>([])
  const [workspaceArtifacts, setWorkspaceArtifacts] = useState<AgentPersistentWorkspaceArtifactV1[]>([])
  const [workspacePublications, setWorkspacePublications] = useState<AgentPersistentWorkspacePublicationV1[]>([])
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const storeWorkspace = useStore((state) => {
    const workspaceId = persistentWorkspace?.id
    return workspaceId ? state.agentPersistentWorkspaceById[workspaceId]?.workspace ?? null : null
  })
  const renderedPersistentWorkspace = storeWorkspace
    && (!persistentWorkspace || storeWorkspace.revision >= persistentWorkspace.revision)
    ? storeWorkspace
    : persistentWorkspace
  const workspaceRequestRef = useRef(0)
  const inspectionRequestRef = useRef(0)
  const inspectionRef = useRef<AgentRunInspectionDetailV1 | null>(initialInspection)
  const inspectionGenerationRef = useRef(0)

  const loadInspection = useCallback(async (
    generation = inspectionGenerationRef.current,
  ): Promise<AgentRunInspectionDetailV1 | null> => {
    if (inspectionGenerationRef.current !== generation) return null
    const requestId = ++inspectionRequestRef.current
    const isCurrentRequest = () => inspectionGenerationRef.current === generation
      && inspectionRequestRef.current === requestId
    if (!attemptId) {
      inspectionRef.current = null
      setInspection(null)
      setLoadFailed(false)
      return null
    }
    setLoading(true)
    setLoadFailed(false)
    try {
      const detail = await agentRunsApi.inspection(attemptId, chatId ?? undefined)
      if (inspectionGenerationRef.current !== generation) return null
      if (!isCurrentRequest()) return inspectionRef.current
      inspectionRef.current = detail
      setInspection(detail)
      return detail
    } catch {
      if (!isCurrentRequest()) return inspectionRef.current
      setLoadFailed(true)
      return null
    } finally {
      if (isCurrentRequest()) setLoading(false)
    }
  }, [attemptId, chatId])
  const loadPersistentWorkspace = useCallback(async (
    workspaceIdOverride?: string | null,
    generation = inspectionGenerationRef.current,
    preserveLoadedCollections = false,
  ) => {
    if (inspectionGenerationRef.current !== generation) return
    const requestId = ++workspaceRequestRef.current
    const inspectionSnapshot = inspectionRef.current
    const workspaceId = workspaceIdOverride ?? inspectionSnapshot?.workspaceAssociations[0]?.workspaceId ?? null
    const workspaceAssociation = workspaceId
      ? inspectionSnapshot?.workspaceAssociations.find((association) => association.workspaceId === workspaceId)
      : undefined
    const expectedWorkspaceChatId = workspaceId === null
      ? undefined
      : workspaceAssociation?.sourceDeleted
        ? null
        : workspaceAssociation?.correlation.chatId ?? inspectionSnapshot?.attempt.target.chatId ?? chatId ?? null
    const workspaceAvailability = inspectionSnapshot?.sectionAvailability.find((entry) => entry.section === 'workspace')
    const sourceDeletedWithoutAssociation = !workspaceId
      && inspectionSnapshot?.workspaceAssociations.length === 0
      && inspectionSnapshot.reason === 'stale_input'
      && workspaceAvailability?.reason === 'stale_input'
      && (workspaceAvailability.state === 'source_deleted' || workspaceAvailability.state === 'not_recorded')
    const isCurrent = () => inspectionGenerationRef.current === generation
      && workspaceRequestRef.current === requestId
    const scope = workspaceId
      ? `id:${workspaceId}`
      : sourceDeletedWithoutAssociation
        ? null
        : chatId ? `chat:${chatId}` : null
    if (!scope) {
      if (!isCurrent()) return
      setPersistentWorkspace(null)
      setWorkspaceSessions([])
      setWorkspaceSessionsTotal(0)
      setWorkspaceSessionsNextOffset(0)
      setWorkspaceSessionsLoadingMore(false)
      setWorkspaceTasks([])
      setWorkspaceRecords([])
      setWorkspaceSubmissions([])
      setWorkspaceArtifacts([])
      setWorkspacePublications([])
      setWorkspaceError(null)
      setWorkspaceLoading(false)
      return
    }
    setWorkspaceLoading(true)
    setWorkspaceSessionsLoadingMore(false)
    setWorkspaceError(null)
    const workspaceEpoch = beginPersistentWorkspaceRequest(scope)
    const keepWorkspaceMounted = workspaceId !== null
      ? persistentWorkspaceIdentityRef.current?.id === workspaceId
      : persistentWorkspaceIdentityRef.current?.chatId === chatId
    if (!keepWorkspaceMounted) {
      setPersistentWorkspace(null)
      setWorkspaceSessions([])
      setWorkspaceSessionsTotal(0)
      setWorkspaceSessionsNextOffset(0)
      setWorkspaceSessionsLoadingMore(false)
      setWorkspaceTasks([])
      setWorkspaceRecords([])
      setWorkspaceSubmissions([])
      setWorkspaceArtifacts([])
      setWorkspacePublications([])
    }
    try {
      const nextWorkspace = workspaceId
        ? await agentRunsApi.persistentWorkspaceById(workspaceId, expectedWorkspaceChatId)
        : await agentRunsApi.persistentWorkspace(chatId!)
      if (!isCurrent()) return
      const accepted = applyPersistentWorkspace(scope, workspaceEpoch, nextWorkspace)
      const acceptedWorkspace = useStore.getState().agentPersistentWorkspaceById[nextWorkspace.id]?.workspace
        ?? (accepted ? nextWorkspace : null)
      if (!acceptedWorkspace) return
      setPersistentWorkspace(acceptedWorkspace)
      const fetchCollection = async <T,>(collection: AgentPersistentWorkspaceCollectionV1, fetcher: () => Promise<T[]>) => {
        if (!isCurrent()) return [] as T[]
        const collectionEpoch = beginPersistentWorkspaceCollection(nextWorkspace.id, collection)
        try {
          const items = await fetcher()
          if (!isCurrent()) return [] as T[]
          if (!applyPersistentWorkspaceCollection(nextWorkspace.id, collection, collectionEpoch, items)) return [] as T[]
          return items
        } catch (caught) {
          if (isCurrent()) failPersistentWorkspaceCollection(nextWorkspace.id, collection, collectionEpoch, t('persistentWorkspace.loadFailed'))
          throw caught
        }
      }
      const fetchSessionPage = async (): Promise<AgentPersistentWorkspaceTurnSessionPageV1 | null> => {
        if (!isCurrent()) return null
        const collectionEpoch = beginPersistentWorkspaceCollection(nextWorkspace.id, 'sessions')
        try {
          const page = await agentRunsApi.persistentWorkspaceSessions(nextWorkspace.id, {
            limit: PERSISTENT_WORKSPACE_SESSION_PAGE_SIZE,
            offset: 0,
          })
          if (!isCurrent()) return null
          if (!applyPersistentWorkspaceCollection(nextWorkspace.id, 'sessions', collectionEpoch, page, false, 0)) return null
          return page
        } catch (caught) {
          if (isCurrent()) failPersistentWorkspaceCollection(nextWorkspace.id, 'sessions', collectionEpoch, t('persistentWorkspace.loadFailed'))
          throw caught
        }
      }
      const [sessionPage, tasks, records, submissions, artifacts, publications] = await Promise.all([
        fetchSessionPage(),
        fetchCollection('tasks', () => agentRunsApi.persistentWorkspaceTasks(nextWorkspace.id)),
        fetchCollection('records', () => agentRunsApi.persistentWorkspaceRecords(nextWorkspace.id)),
        fetchCollection('submissions', () => agentRunsApi.persistentWorkspaceSubmissions(nextWorkspace.id)),
        fetchCollection('artifacts', () => agentRunsApi.persistentWorkspaceArtifacts(nextWorkspace.id)),
        fetchCollection('publications', () => agentRunsApi.persistentWorkspacePublications(nextWorkspace.id)),
      ])
      if (!isCurrent() || !sessionPage) return
      const preserveSessionPage = preserveLoadedCollections && keepWorkspaceMounted && sessionPage.total >= workspaceSessionsTotalRef.current
      if (preserveSessionPage) {
        setWorkspaceSessions((current) => {
          const byId = new Map(current.map((item) => [item.id, item]))
          sessionPage.data.forEach((item) => {
            const existing = byId.get(item.id)
            if (!existing || existing.revision <= item.revision) byId.set(item.id, item)
          })
          return [...byId.values()]
        })
        setWorkspaceSessionsTotal((current) => Math.max(current, sessionPage.total))
        setWorkspaceSessionsNextOffset((current) => Math.max(current, sessionPage.offset + sessionPage.data.length))
      } else {
        setWorkspaceSessions(sessionPage.data)
        setWorkspaceSessionsTotal(sessionPage.total)
        setWorkspaceSessionsNextOffset(sessionPage.offset + sessionPage.data.length)
      }
      setWorkspaceTasks(tasks)
      setWorkspaceRecords(records)
      setWorkspaceSubmissions(submissions)
      setWorkspaceArtifacts(artifacts)
      setWorkspacePublications(publications)
    } catch {
      if (isCurrent()) setWorkspaceError(t('persistentWorkspace.loadFailed'))
    } finally {
      if (isCurrent()) setWorkspaceLoading(false)
    }
  }, [applyPersistentWorkspace, applyPersistentWorkspaceCollection, beginPersistentWorkspaceCollection, beginPersistentWorkspaceRequest, chatId, failPersistentWorkspaceCollection, t])
  const refreshInspectionAndWorkspace = useCallback(async (
    fallbackInspection: AgentRunInspectionDetailV1 | null = null,
    generation = inspectionGenerationRef.current,
    preserveLoadedCollections = false,
  ) => {
    const fetchedInspection = await loadInspection(generation)
    if (inspectionGenerationRef.current !== generation) return
    const sourceInspection = fetchedInspection ?? fallbackInspection
    const workspaceId = sourceInspection?.workspaceAssociations[0]?.workspaceId ?? null
    await loadPersistentWorkspace(workspaceId, generation, preserveLoadedCollections)
  }, [loadInspection, loadPersistentWorkspace])

  useEffect(() => {
    const generation = ++inspectionGenerationRef.current
    if (!isOpen) return
    setTab('summary')
    setSelectedRecordIndex(0)
    setCopiedCorrelation(false)
    setCopyCorrelationError(false)
    inspectionRef.current = initialInspection
    setInspection(initialInspection)
    void refreshInspectionAndWorkspace(initialInspection, generation)
    return () => {
      if (inspectionGenerationRef.current === generation) inspectionGenerationRef.current += 1
    }
  }, [isOpen, attemptId, initialInspection, refreshInspectionAndWorkspace])
  useEffect(() => {
    if (!isOpen || !attemptId || !inspection || inspection.terminal) return
    const generation = inspectionGenerationRef.current
    const refreshTimer = window.setInterval(() => {
      void refreshInspectionAndWorkspace(null, generation, true)
    }, 5_000)
    return () => window.clearInterval(refreshTimer)
  }, [attemptId, inspection?.terminal, isOpen, refreshInspectionAndWorkspace])
  const editPersistentWorkspace = useCallback(async (input: PersistentWorkspaceEditInput) => {
    if (!renderedPersistentWorkspace || renderedPersistentWorkspace.chatId === null) return
    const generation = inspectionGenerationRef.current
    const workspaceId = renderedPersistentWorkspace.id
    await agentRunsApi.editPersistentWorkspace(workspaceId, input)
    if (inspectionGenerationRef.current !== generation) return
    await loadPersistentWorkspace(workspaceId, generation)
  }, [loadPersistentWorkspace, renderedPersistentWorkspace])

  const createPersistentWorkspaceTask = useCallback(async (input: PersistentWorkspaceTaskInput) => {
    if (!renderedPersistentWorkspace || renderedPersistentWorkspace.chatId === null) return
    const generation = inspectionGenerationRef.current
    const workspaceId = renderedPersistentWorkspace.id
    await agentRunsApi.createPersistentWorkspaceTask(workspaceId, input)
    if (inspectionGenerationRef.current !== generation) return
    await loadPersistentWorkspace(workspaceId, generation)
  }, [loadPersistentWorkspace, renderedPersistentWorkspace])

  const publishPersistentWorkspace = useCallback(async (input: PersistentWorkspacePublicationInput) => {
    if (!renderedPersistentWorkspace || renderedPersistentWorkspace.chatId === null) return
    const generation = inspectionGenerationRef.current
    const workspaceId = renderedPersistentWorkspace.id
    await agentRunsApi.publishPersistentWorkspace(workspaceId, input)
    if (inspectionGenerationRef.current !== generation) return
    await loadPersistentWorkspace(workspaceId, generation)
  }, [loadPersistentWorkspace, renderedPersistentWorkspace])

  const deletePersistentWorkspacePublication = useCallback(async ({ expectedRevision, publicationId }: PersistentWorkspacePublicationDeleteInput) => {
    if (!renderedPersistentWorkspace) return
    const generation = inspectionGenerationRef.current
    const workspaceId = renderedPersistentWorkspace.id
    await agentRunsApi.deletePersistentWorkspacePublication(workspaceId, publicationId, expectedRevision)
    if (inspectionGenerationRef.current !== generation) return
    await loadPersistentWorkspace(workspaceId, generation)
  }, [loadPersistentWorkspace, renderedPersistentWorkspace])

  const deletePersistentWorkspace = useCallback(async (expectedRevision: number) => {
    if (!renderedPersistentWorkspace) return
    const generation = inspectionGenerationRef.current
    const workspaceId = renderedPersistentWorkspace.id
    await agentRunsApi.deletePersistentWorkspace(workspaceId, expectedRevision)
    if (inspectionGenerationRef.current !== generation) return
    if (workspaceRequestRef.current) workspaceRequestRef.current += 1
    setPersistentWorkspace(null)
    setWorkspaceSessions([])
    setWorkspaceSessionsTotal(0)
    setWorkspaceSessionsNextOffset(0)
    setWorkspaceSessionsLoadingMore(false)
    setWorkspaceTasks([])
    setWorkspaceRecords([])
    setWorkspaceSubmissions([])
    setWorkspaceArtifacts([])
    setWorkspacePublications([])
  }, [renderedPersistentWorkspace])
  const loadMoreWorkspaceSessions = useCallback(async () => {
    const workspace = renderedPersistentWorkspace
    const requestOffset = workspaceSessionsNextOffset
    if (!workspace || workspaceSessionsLoadingMore || requestOffset >= workspaceSessionsTotal) return
    const generation = inspectionGenerationRef.current
    const requestId = workspaceRequestRef.current
    const isCurrent = () => inspectionGenerationRef.current === generation
      && workspaceRequestRef.current === requestId
    setWorkspaceSessionsLoadingMore(true)
    const collectionEpoch = beginPersistentWorkspaceCollection(workspace.id, 'sessions')
    try {
      const page = await agentRunsApi.persistentWorkspaceSessions(workspace.id, {
        limit: PERSISTENT_WORKSPACE_SESSION_PAGE_SIZE,
        offset: requestOffset,
      })
      if (!isCurrent()) return
      if (!applyPersistentWorkspaceCollection(workspace.id, 'sessions', collectionEpoch, page, true, requestOffset)) return
      setWorkspaceSessions((current) => {
        const byId = new Map(current.map((item) => [item.id, item]))
        for (const item of page.data) {
          const previous = byId.get(item.id)
          if (!previous || previous.revision <= item.revision) byId.set(item.id, item)
        }
        return [...byId.values()]
      })
      setWorkspaceSessionsTotal(page.total)
      setWorkspaceSessionsNextOffset(page.offset + page.data.length)
    } catch {
      if (isCurrent()) setWorkspaceError(t('persistentWorkspace.loadFailed'))
    } finally {
      if (isCurrent()) setWorkspaceSessionsLoadingMore(false)
    }
  }, [applyPersistentWorkspaceCollection, beginPersistentWorkspaceCollection, renderedPersistentWorkspace, t, workspaceSessionsLoadingMore, workspaceSessionsNextOffset, workspaceSessionsTotal])



  const inspectionResetKey = `${attemptId ?? 'unavailable'}:${isOpen ? 'open' : 'closed'}`
  const transcript = useMemo(() => inspection ? [...inspection.transcript].sort(compareTranscript) : [], [inspection])
  const transcriptWindow = useCollectionWindow(transcript, `${inspectionResetKey}:transcript`)
  const renderedTranscript = transcriptWindow.visibleItems
  const selectedRecord = renderedTranscript[selectedRecordIndex] ?? null
  const turnSession = useMemo(() => inspection ? [...inspection.turnSession].sort(compareTurnSession) : [], [inspection])
  const prompts = useMemo(() => inspection ? [...inspection.promptEvidence].sort(comparePromptEvidence) : [], [inspection])
  const promptRoleCorrelationAvailable = inspection?.sectionAvailability.some(
    (entry) => entry.section === 'prompt' && entry.state === 'available',
  ) ?? false
  const orderedPromptRecords = useMemo(
    () => prompts.map((prompt, position) => ({ prompt, position })),
    [prompts],
  )
  const markers = inspection?.markers ?? []
  const usage = inspection?.usageEvidence ?? []
  const workspaceAssociations = inspection?.workspaceAssociations ?? []
  const cortexReceipts = inspection?.cortexReceipts ?? []
  const councilReceipts = inspection?.councilReceipts ?? []
  const loomInspections = useMemo(() => {
    const retained: Array<{ inspection: LoomPromptInspectionV1; key: string; position: number }> = []
    const seen = new Set<string>()
    for (const prompt of prompts) {
      if (!prompt.loomInspection) continue
      const key = loomInspectionKey(prompt.loomInspection)
      if (seen.has(key)) continue
      seen.add(key)
      retained.push({ inspection: prompt.loomInspection, key, position: retained.length })
    }
    return retained
  }, [prompts])
  const loomRoleBySource = useMemo(() => {
    const roles = new Map<string, AgentPromptEvidenceV1['role']>()
    if (!promptRoleCorrelationAvailable) return roles
    const fingerprints = new Map<string, string>()
    const collisions = new Set<string>()
    for (const prompt of prompts) {
      const key = JSON.stringify([prompt.sourceId, prompt.promptOrder, prompt.sourceRevision])
      if (collisions.has(key)) continue
      const fingerprint = JSON.stringify([prompt.role, prompt.contentDigest, prompt.content])
      const retained = fingerprints.get(key)
      if (retained === undefined) {
        fingerprints.set(key, fingerprint)
        roles.set(key, prompt.role)
      } else if (retained !== fingerprint) {
        roles.delete(key)
        collisions.add(key)
      }
    }
    return roles
  }, [promptRoleCorrelationAvailable, prompts])
  const executionEvidence = useMemo(
    () => transcript.filter((record) => record.kind === 'tool' || record.kind === 'delegation' || record.kind === 'child_result'),
    [transcript],
  )
  const acceptedRenderCrossings = useMemo(
    () => inspection ? [...inspection.renderCrossings].sort(compareRenderCrossing) : [],
    [inspection],
  )
  const workspaceSessionsWindow = useCollectionWindow(workspaceSessions, `${inspectionResetKey}:workspace-sessions`)
  const workspaceSessionsHasMore = workspaceSessionsWindow.shownCount < workspaceSessions.length
    || workspaceSessionsNextOffset < workspaceSessionsTotal
  const revealWorkspaceSessions = useCallback(() => {
    if (workspaceSessionsWindow.shownCount < workspaceSessions.length) {
      workspaceSessionsWindow.revealMore()
      return
    }
    void loadMoreWorkspaceSessions()
  }, [loadMoreWorkspaceSessions, workspaceSessions.length, workspaceSessionsWindow.revealMore, workspaceSessionsWindow.shownCount])
  const workspaceTasksWindow = useCollectionWindow(workspaceTasks, `${inspectionResetKey}:workspace-tasks`)
  const workspaceRecordsWindow = useCollectionWindow(workspaceRecords, `${inspectionResetKey}:workspace-records`)
  const workspaceSubmissionsWindow = useCollectionWindow(workspaceSubmissions, `${inspectionResetKey}:workspace-submissions`)
  const workspaceArtifactsWindow = useCollectionWindow(workspaceArtifacts, `${inspectionResetKey}:workspace-artifacts`)
  const workspacePublicationsWindow = useCollectionWindow(workspacePublications, `${inspectionResetKey}:workspace-publications`)
  const cortexReceiptsWindow = useCollectionWindow(cortexReceipts, `${inspectionResetKey}:cortex-receipts`)
  const councilReceiptsWindow = useCollectionWindow(councilReceipts, `${inspectionResetKey}:council-receipts`)
  const workCausalTimeline = useMemo<WorkCausalTimelineItemV1[]>(() => {
    const workSegments = inspection?.workSegments
    if (!workSegments) return []
    const dispatchBySegment = new Map<string, WorkDispatchInspectionV1>()
    const segmentOrdinalById = new Map(
      workSegments.segments.map((segment) => [segment.identity.segmentId, segment.identity.segmentOrdinal] as const),
    )
    const compareDispatchOrder = (left: WorkDispatchInspectionV1, right: WorkDispatchInspectionV1) => {
      const segmentOrder = (segmentOrdinalById.get(left.segmentId) ?? -1)
        - (segmentOrdinalById.get(right.segmentId) ?? -1)
      return segmentOrder || left.dispatchOrdinal - right.dispatchOrdinal
    }
    let latestDispatch: WorkDispatchInspectionV1 | null = null
    let recoveryDispatch: WorkDispatchInspectionV1 | null = null
    for (const dispatch of workSegments.dispatches) {
      const existing = dispatchBySegment.get(dispatch.segmentId)
      if (!existing || existing.dispatchOrdinal < dispatch.dispatchOrdinal) dispatchBySegment.set(dispatch.segmentId, dispatch)
      if (!latestDispatch || compareDispatchOrder(latestDispatch, dispatch) < 0) latestDispatch = dispatch
      if (dispatch.budgetClass === 'recovery' && (!recoveryDispatch || compareDispatchOrder(recoveryDispatch, dispatch) < 0)) recoveryDispatch = dispatch
    }
    const currentRecoveryDispatch = workSegments.recovery.currentSegmentId
      ? dispatchBySegment.get(workSegments.recovery.currentSegmentId) ?? null
      : recoveryDispatch ?? latestDispatch
    return [
      { kind: 'recovery', id: 'recovery:' + (workSegments.recovery.currentSegmentId ?? 'closed'), recovery: workSegments.recovery, dispatch: currentRecoveryDispatch },
      ...workSegments.transitions.map((transition) => ({
        kind: 'transition' as const,
        id: transition.transitionId,
        transition,
        dispatch: dispatchBySegment.get(transition.sourceSegment.segmentId) ?? null,
      })),
    ]
  }, [inspection])
  const tone = inspection ? statusTone(inspection) : 'live'
  const notRecorded = t('ownerInspection.notRecorded')

  useEffect(() => {
    setSelectedRecordIndex((current) => renderedTranscript.length === 0 ? 0 : Math.min(current, renderedTranscript.length - 1))
  }, [renderedTranscript.length])

  const selectRecord = useCallback((nextIndex: number) => {
    if (renderedTranscript.length === 0) return
    setSelectedRecordIndex(Math.max(0, Math.min(nextIndex, renderedTranscript.length - 1)))
  }, [renderedTranscript.length])

  const handleChronologyKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'Home') selectRecord(0)
    else if (event.key === 'End') selectRecord(renderedTranscript.length - 1)
    else if (event.key === 'ArrowLeft') selectRecord(selectedRecordIndex - 1)
    else selectRecord(selectedRecordIndex + 1)
  }, [renderedTranscript.length, selectRecord, selectedRecordIndex])

  const handleTabKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const currentIndex = INSPECTION_TABS.indexOf(tab)
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? INSPECTION_TABS.length - 1 : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + INSPECTION_TABS.length) % INSPECTION_TABS.length
    const nextTab = INSPECTION_TABS[nextIndex]
    setTab(nextTab)
    document.getElementById(`owner-inspection-tab-${nextTab}`)?.focus()
  }, [tab])

  const copyCorrelation = useCallback(async () => {
    const correlationId = inspection?.hostCorrelationId
    if (!correlationId) return
    try {
      await navigator.clipboard.writeText(correlationId)
      setCopiedCorrelation(true)
      setCopyCorrelationError(false)
      window.setTimeout(() => setCopiedCorrelation(false), 1_500)
    } catch {
      setCopiedCorrelation(false)
      setCopyCorrelationError(true)
    }
  }, [inspection?.hostCorrelationId])
  const openExactAttemptPromptBreakdown = useCallback(() => {
    if (!attemptId || !chatId) return
    openModal('promptItemizer', { inspectionAttemptId: attemptId, chatId })
  }, [attemptId, chatId, openModal])

  if (!isOpen) return null

  const headerLabel = inspection ? inspection.terminal ? t('ownerInspection.statusTerminal') : inspection.activity.reconciliation === 'recovered' ? t('ownerInspection.statusRecovered') : t('ownerInspection.statusLive') : t('ownerInspection.title')

  return createPortal(
    <div className={styles.backdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialogRef} className={styles.surface} role="dialog" aria-modal="true" aria-labelledby="owner-inspection-title" tabIndex={-1}>
        <header className={styles.header}>
          <div className={styles.headerCopy}><div className={styles.eyebrow}>{headerLabel}</div><h2 id="owner-inspection-title">{t('ownerInspection.title')}</h2><p>{t('ownerInspection.subtitle')}</p></div>
          <div className={styles.headerActions}>{attemptId ? <code className={styles.headerAttempt}>{boundedId(attemptId)}</code> : null}<button type="button" className={styles.iconButton} onClick={onClose} aria-label={t('ownerInspection.close')}><X aria-hidden="true" /></button></div>
        </header>

        <div className={styles.tabs} role="tablist" aria-label={t('ownerInspection.ariaTabs')} onKeyDown={handleTabKeyDown}>
          {INSPECTION_TABS.map((tabKey) => <button key={tabKey} type="button" role="tab" id={`owner-inspection-tab-${tabKey}`} aria-selected={tab === tabKey} aria-controls={`owner-inspection-panel-${tabKey}`} tabIndex={tab === tabKey ? 0 : -1} data-inspector-autofocus={tabKey === 'summary' ? 'true' : undefined} onClick={() => setTab(tabKey)}>{t(`ownerInspection.${TAB_LABEL_KEYS[tabKey]}`)}</button>)}
        </div>

        <div className={styles.body}>
          {loading && !inspection ? <div className={styles.loadingState} role="status"><LoaderCircle className={styles.spinner} aria-hidden="true" /><span>{t('ownerInspection.loading')}</span></div> : loadFailed && !inspection ? <div className={styles.errorState} role="alert"><CircleX aria-hidden="true" /><p>{attemptId ? t('ownerInspection.loadError') : t('ownerInspection.unavailableDetail')}</p>{attemptId ? <button type="button" className={styles.secondaryButton} onClick={() => void refreshInspectionAndWorkspace()}><RefreshCw aria-hidden="true" />{t('ownerInspection.retry')}</button> : null}</div> : !inspection ? <EmptyState icon={<EyeOff aria-hidden="true" />}>{attemptId ? t('ownerInspection.empty') : t('ownerInspection.unavailableDetail')}</EmptyState> : <>
            {loadFailed ? <div className={styles.inlineWarning} role="status"><RefreshCw aria-hidden="true" />{t('ownerInspection.loadError')}<button type="button" className={styles.inlineButton} onClick={() => void refreshInspectionAndWorkspace()}>{t('ownerInspection.retry')}</button></div> : null}

              {inspection.error ? (
                <section className={styles.section} role="alert" aria-labelledby="owner-inspection-error-heading">
                  <div className={styles.sectionHeading}>
                    <div>
                      <h3 id="owner-inspection-error-heading">{t('ownerInspection.resolutionError.title')}</h3>
                      <p>{t('ownerInspection.resolutionError.code', { code: boundedId(inspection.error.code) })} · {valueLabel(t, inspection.error.category)} · {errorSummaryLabel(t, inspection.error.summaryCode, inspection.error.code)}</p>
                    </div>
                  </div>
                  <dl className={styles.summaryGrid}>
                    <Field label={t('ownerInspection.attemptId')} value={boundedId(inspection.error.inspectionAttemptId)} mono />
                    <Field label={t('ownerInspection.outcome')} value={valueLabel(t, inspection.error.workOutcome)} />
                    {inspection.error.causalCode ? <Field label={t('ownerInspection.errorReason')} value={boundedId(inspection.error.causalCode)} mono /> : null}
                    {inspection.error.reason ? <Field label={t('ownerInspection.reason')} value={valueLabel(t, inspection.error.reason)} /> : null}
                    <Field label={t('agentRuntime.provenance.authority')} value={valueLabel(t, inspection.error.authority)} />
                    <Field label={t('agentRuntime.provenance.source')} value={valueLabel(t, inspection.error.source)} />
                    <Field label={t('agentRuntime.provenance.scope')} value={valueLabel(t, inspection.error.scope)} />
                    <Field label={t('ownerInspection.phase')} value={valueLabel(t, inspection.error.workPhase)} />
                    <Field label={t('ownerInspection.status')} value={valueLabel(t, inspection.error.workStatus)} />
                    {inspection.error.capGate ? <Field label={t('agentRuntime.provenance.gate')} value={`${boundedId(inspection.error.capGate.id)} · ${inspection.error.capGate.observed ?? '—'} / ${inspection.error.capGate.limit ?? '—'} · ${inspection.error.capGate.exceeded ? t('agentRuntime.provenance.capabilityNotReady') : t('agentRuntime.provenance.capabilityReady')}`} mono /> : null}
                    <Field label={t('ownerInspection.omitted')} value={inspection.error.omissionCount} />
                  </dl>
                </section>
              ) : null}
            <section id="owner-inspection-panel-summary" className={styles.panel} role="tabpanel" aria-labelledby="owner-inspection-tab-summary" hidden={tab !== 'summary'} tabIndex={tab === 'summary' ? 0 : -1}>
              <div className={styles.statusCard} data-tone={tone}><span className={styles.statusGlyph}><StatusGlyph tone={tone} live={!inspection.terminal} /></span><div className={styles.statusCopy}><strong>{valueLabel(t, inspection.outcome ?? inspection.status)}</strong><span>{valueLabel(t, inspection.lifecycle)} · {valueLabel(t, inspection.reason)}</span></div><span className={styles.statusLabel}>{headerLabel}</span></div>

              <section className={styles.section} aria-labelledby="owner-inspection-attempt-heading"><div className={styles.sectionHeading}><div><h3 id="owner-inspection-attempt-heading">{t('ownerInspection.attempt')}</h3><p>{t('ownerInspection.correlation')}</p></div><button type="button" className={styles.secondaryButton} onClick={() => void copyCorrelation()}><Copy aria-hidden="true" />{copiedCorrelation ? t('ownerInspection.copied') : t('ownerInspection.copyCorrelation')}</button></div><dl className={styles.summaryGrid}><Field label={t('ownerInspection.attemptId')} value={boundedId(inspection.attempt.attemptId)} mono /><Field label={t('ownerInspection.previousAttempt')} value={boundedId(inspection.attempt.previousAttemptId)} mono /><Field label={t('ownerInspection.target')} value={valueLabel(t, inspection.attempt.target.generationType)} /><Field label={t('ownerInspection.message')} value={boundedId(inspection.attempt.target.messageId)} mono /><Field label={t('ownerInspection.swipe')} value={inspection.attempt.target.swipeId ?? t('ownerInspection.targetUnattributed')} /><Field label={t('ownerInspection.chatId')} value={boundedId(inspection.attempt.target.chatId)} mono /><Field label={t('ownerInspection.hostCorrelationId')} value={boundedId(inspection.hostCorrelationId)} mono /><Field label={t('ownerInspection.revision')} value={inspection.revision} /></dl><p className={styles.mutedNotice}>{t('ownerInspection.hostSequence')}: {inspection.activity.milestones[0]?.correlation.hostSequence ?? t('ownerInspection.notRecorded')}</p></section>
              {copyCorrelationError ? <div className={styles.inlineWarning} role="alert"><CircleX aria-hidden="true" /><span>{t('ownerInspection.copyCorrelationFailed')}</span><button type="button" className={styles.inlineButton} onClick={() => void copyCorrelation()}>{t('ownerInspection.retryCopy')}</button></div> : null}

              {inspection.committedTarget ? <section className={styles.section} aria-labelledby="owner-inspection-committed-response-heading"><div className={styles.sectionHeading}><h3 id="owner-inspection-committed-response-heading">{t('ownerInspection.committedResponse')}</h3></div><dl className={styles.summaryGrid}><Field label={t('ownerInspection.message')} value={boundedId(inspection.committedTarget.messageId)} mono /><Field label={t('ownerInspection.swipe')} value={inspection.committedTarget.swipeId} /></dl></section> : null}

              <section className={styles.section} aria-labelledby="owner-inspection-lifecycle-heading"><div className={styles.sectionHeading}><h3 id="owner-inspection-lifecycle-heading">{t('ownerInspection.lifecycle')}</h3></div><dl className={styles.summaryGrid}><Field label={t('ownerInspection.lifecycle')} value={valueLabel(t, inspection.lifecycle)} /><Field label={t('ownerInspection.status')} value={valueLabel(t, inspection.status)} /><Field label={t('ownerInspection.outcome')} value={valueLabel(t, inspection.outcome)} /><Field label={t('ownerInspection.reason')} value={valueLabel(t, inspection.reason)} /><Field label={t('ownerInspection.started')} value={formatTimestamp(inspection.startedAt, notRecorded)} /><Field label={t('ownerInspection.updated')} value={formatTimestamp(inspection.updatedAt, notRecorded)} /><Field label={t('ownerInspection.terminal')} value={inspection.terminal ? t('ownerInspection.statusTerminal') : t('ownerInspection.runningApprox')} /><Field label={t('ownerInspection.duration')} value={formatDuration(inspection.terminalAt ? inspection.terminalAt - inspection.startedAt : inspection.updatedAt - inspection.startedAt, notRecorded, t)} /></dl></section>

              {inspection.workSegments ? (
                <section className={styles.section} aria-labelledby="owner-inspection-work-segments-heading">
                  <div className={styles.sectionHeading}><div><h3 id="owner-inspection-work-segments-heading">{t('ownerInspection.workSegments')}</h3><p>{t('ownerInspection.workSegmentsIntro')}</p></div></div>
                  <dl className={styles.summaryGrid}>
                    <Field label={t('ownerInspection.segmentCount')} value={inspection.workSegments.segments.length} />
                    <Field label={t('ownerInspection.dispatchCount')} value={inspection.workSegments.dispatches.length} />
                    <Field label={t('ownerInspection.transitionCount')} value={inspection.workSegments.transitions.length} />
                    <Field label={t('ownerInspection.workspaceRevision')} value={inspection.workSegments.recovery.workspaceRevision} />
                  </dl>
                  {inspection.workSegments.segments.map((segment) => (
                    <article key={segment.identity.segmentId} className={styles.recordCard}>
                      <div className={styles.recordHeader}><strong>{segment.identity.phaseId === null ? t('ownerInspection.builtInWork') : boundedId(segment.identity.phaseId)}</strong><span>{valueLabel(t, segment.lifecycle)}</span></div>
                      <dl className={styles.summaryGrid}>
                        <Field label={t('ownerInspection.occurrence')} value={segment.identity.phaseOccurrence} />
                        <Field label={t('ownerInspection.status')} value={valueLabel(t, segment.lifecycle)} />
                        <Field label={t('ownerInspection.boundaryClass')} value={valueLabel(t, segment.boundaryClass)} />
                        <Field label={t('ownerInspection.providerDispatches')} value={segment.usage.providerDispatches} />
                        <Field label={t('ownerInspection.toolCalls')} value={segment.usage.toolCalls} />
                        <Field label={t('ownerInspection.workspaceOperations')} value={segment.usage.workspaceOperations} />
                      </dl>
                    </article>
                  ))}
                  <div className={styles.sectionHeading}><h4>{t('ownerInspection.causalTimeline')}</h4></div>
                  <BoundedCollection
                    items={workCausalTimeline}
                    resetKey={inspectionResetKey + ':work-causal-timeline'}
                    listId="owner-inspection-work-causal-timeline"
                    label={t('ownerInspection.causalTimeline')}
                    getKey={(item) => item.id}
                    t={t}
                    renderItem={(item) => item.kind === 'recovery' ? (
                      <article className={styles.recordCard} aria-label={t('ownerInspection.causalTimeline') + ': ' + valueLabel(t, 'recovery')}>
                        <div className={styles.recordHeader}><strong>{valueLabel(t, 'recovery')}</strong><span>{valueLabel(t, item.recovery.state)}</span></div>
                        <dl className={styles.summaryGrid}>
                          <Field label={t('ownerInspection.sourcePhase')} value={item.recovery.phaseId === null ? t('ownerInspection.builtInWork') : boundedId(item.recovery.phaseId)} />
                          <Field label={t('ownerInspection.workspaceRevision')} value={item.recovery.workspaceRevision} />
                          <Field label={t('ownerInspection.boundaryClass')} value={valueLabel(t, item.recovery.terminalBoundaryClass)} />
                          <Field label={t('ownerInspection.dispatchId')} value={boundedId(item.dispatch?.dispatchId ?? null)} mono />
                        </dl>
                      </article>
                    ) : (
                      <article className={styles.recordCard} aria-label={t('ownerInspection.causalTimeline') + ': ' + valueLabel(t, item.transition.transitionKind)}>
                        <div className={styles.recordHeader}><strong>{valueLabel(t, item.transition.transitionKind)}</strong><span>{boundedId(item.transition.handoffId)}</span></div>
                        <dl className={styles.summaryGrid}>
                          <Field label={t('ownerInspection.sourcePhase')} value={item.transition.sourceSegment.phaseId === null ? t('ownerInspection.builtInWork') : boundedId(item.transition.sourceSegment.phaseId)} />
                          <Field label={t('ownerInspection.targetPhase')} value={item.transition.targetPhaseId === null ? valueLabel(t, 'terminal') : boundedId(item.transition.targetPhaseId)} />
                          <Field label={t('ownerInspection.occurrence')} value={String(item.transition.sourceSegment.phaseOccurrence) + ' → ' + String(item.transition.targetPhaseOccurrence ?? '—')} />
                          <Field label={t('ownerInspection.handoffId')} value={boundedId(item.transition.handoffId)} mono />
                          <Field label={t('ownerInspection.workspaceRevision')} value={item.transition.sourceWorkspaceRevision} />
                          <Field label={t('ownerInspection.cause')} value={valueLabel(t, item.transition.cause)} />
                          <Field label={t('ownerInspection.dispatchId')} value={boundedId(item.dispatch?.dispatchId ?? null)} mono />
                          <Field label={t('ownerInspection.boundaryClass')} value={valueLabel(t, item.dispatch?.boundaryClass ?? item.transition.cause)} />
                        </dl>
                      </article>
                    )}
                  />
                </section>
              ) : null}

              <section className={styles.section} aria-labelledby="owner-inspection-recovery-heading"><div className={styles.sectionHeading}><h3 id="owner-inspection-recovery-heading">{t('ownerInspection.retryEligibility')}</h3></div><div className={styles.recoveryGrid}><div className={inspection.retry.allowed ? styles.recoveryAllowed : styles.recoveryDenied}><strong>{inspection.retry.allowed ? t('ownerInspection.retryAllowed') : t('ownerInspection.retryUnavailable')}</strong><span>{t('ownerInspection.retryReason')}: {valueLabel(t, inspection.retry.reason)}</span><span>{t('ownerInspection.target')}: {inspection.retry.targetValid ? t('ownerInspection.included') : t('ownerInspection.omitted')}</span></div>{inspection.stop ? <div className={styles.stopReceipt}><strong>{t('ownerInspection.stopReceipt')}</strong><span>{t('ownerInspection.stopState')}: {valueLabel(t, inspection.stop.state)}</span><span>{t('ownerInspection.stopRequested')}: {formatTimestamp(inspection.stop.requestedAt, notRecorded)}</span><span>{t('ownerInspection.stopReceived')}: {formatTimestamp(inspection.stop.receiptAt, notRecorded)}</span></div> : null}</div></section>
              <p className={styles.boundaryNotice}><EyeOff aria-hidden="true" />{t('ownerInspection.noResponse')}</p>
            </section>

            <section
              id="owner-inspection-panel-chronology"
              className={styles.panel}
              role="tabpanel"
              aria-labelledby="owner-inspection-tab-chronology"
              hidden={tab !== 'chronology'}
              tabIndex={tab === 'chronology' ? 0 : -1}
              onKeyDown={handleChronologyKeyDown}
            >
              <div className={styles.sectionHeading}>
                <div>
                  <h3>{t('ownerInspection.chronology')}</h3>
                  <p>{t('ownerInspection.transcriptIntro')}</p>
                </div>
                <div className={styles.chronologyControls}>
                  <button type="button" className={styles.iconButton} onClick={() => selectRecord(selectedRecordIndex - 1)} disabled={selectedRecordIndex <= 0} aria-label={t('ownerInspection.chronologyPrevious')}><ChevronLeft aria-hidden="true" /></button>
                  <span aria-live="polite">{t('ownerInspection.chronologyPosition', { current: renderedTranscript.length ? selectedRecordIndex + 1 : 0, total: transcript.length })}</span>
                  <button type="button" className={styles.iconButton} onClick={() => selectRecord(selectedRecordIndex + 1)} disabled={selectedRecordIndex < 0 || selectedRecordIndex >= renderedTranscript.length - 1} aria-label={t('ownerInspection.chronologyNext')}><ChevronRight aria-hidden="true" /></button>
                </div>
              </div>
              {renderedTranscript.length === 0
                ? <EmptyState icon={<FileText aria-hidden="true" />}>{t('ownerInspection.transcriptEmpty')}</EmptyState>
                : <>
                    <div id="owner-inspection-timeline" className={styles.timeline} role="listbox" aria-label={t('ownerInspection.chronology')} aria-activedescendant={selectedRecord ? `owner-inspection-record-${selectedRecord.id}` : undefined}>
                      {renderedTranscript.map((record, index) => (
                        <button key={record.id} id={`owner-inspection-record-${record.id}`} type="button" role="option" aria-selected={selectedRecordIndex === index} aria-current={selectedRecordIndex === index ? 'true' : undefined} className={styles.timelineButton} data-selected={selectedRecordIndex === index || undefined} onClick={() => selectRecord(index)}>
                          <span className={styles.timelineSequence}>{index + 1}</span>
                          <span className={styles.timelineText}><strong>{valueLabel(t, record.kind)}</strong><span>{valueLabel(t, record.actor)} · {formatTimestamp(record.occurredAt, notRecorded)}</span></span>
                        </button>
                      ))}
                    </div>
                    <div className={styles.chronologyControls}>
                      <span role="status">{t('ownerInspection.transcriptShowing', { shown: renderedTranscript.length, total: transcript.length })}</span>
                      {renderedTranscript.length < transcript.length
                        ? <button type="button" className={styles.secondaryButton} aria-controls="owner-inspection-timeline" onClick={transcriptWindow.revealMore}>{t('ownerInspection.transcriptShowMore')}</button>
                        : null}
                    </div>
                    {selectedRecord ? <TranscriptCard record={selectedRecord} t={t} notRecorded={notRecorded} /> : null}
                  </>}
            </section>
            

            <section id="owner-inspection-panel-turnSession" className={styles.panel} role="tabpanel" aria-labelledby="owner-inspection-tab-turnSession" hidden={tab !== 'turnSession'} tabIndex={tab === 'turnSession' ? 0 : -1}><div className={styles.sectionHeading}><div><h3>{t('ownerInspection.turnSession')}</h3><p>{t('ownerInspection.turnSessionIntro')}</p></div></div>{turnSession.length === 0 ? <EmptyState icon={<ShieldAlert aria-hidden="true" />}>{t('ownerInspection.turnSessionEmpty')}</EmptyState> : <BoundedCollection items={turnSession} resetKey={`${inspectionResetKey}:turn-session`} listId="owner-inspection-turn-session-list" label={t('ownerInspection.turnSession')} getKey={(entry) => entry.id} t={t} renderItem={(entry) => <TurnSessionCard entry={entry} t={t} notRecorded={notRecorded} resetKey={inspectionResetKey} />} />}</section>


            <section
              id="owner-inspection-panel-prompts"
              className={styles.panel}
              role="tabpanel"
              aria-labelledby="owner-inspection-tab-prompts"
              hidden={tab !== 'prompts'}
              tabIndex={tab === 'prompts' ? 0 : -1}
            >
              <div className={styles.sectionHeading}>
                <div>
                  <h3>{t('ownerInspection.prompts')}</h3>
                  <p>{t('ownerInspection.ar007.promptsSummary')}</p>
                </div>
                {attemptId && chatId ? (
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={openExactAttemptPromptBreakdown}
                  >
                    <FileText aria-hidden="true" />
                    {t('ownerInspection.ar007.openPromptBreakdown')}
                  </button>
                ) : null}
              </div>

              <div className={styles.boundaryStack}>
                <p className={styles.boundaryNotice}>
                  <ShieldAlert aria-hidden="true" />
                  {t('ownerInspection.ar007.loomBoundary')}
                </p>
                <p className={styles.privacyNotice}>
                  <LockKeyhole aria-hidden="true" />
                  {t('ownerInspection.ar007.ownerPrivacyBoundary')}
                </p>
              </div>

              <section className={styles.section} aria-labelledby="owner-inspection-loom-ledger-heading">
                <div className={styles.sectionHeading}>
                  <div>
                    <h4 id="owner-inspection-loom-ledger-heading">{t('ownerInspection.ar007.loomRoutingLedger')}</h4>
                    <p>{t('ownerInspection.ar007.loomRoutingSummary')}</p>
                  </div>
                </div>
                {loomInspections.length > 0 ? (
                  <BoundedCollection
                    items={loomInspections}
                    resetKey={`${inspectionResetKey}:loom-inspections`}
                    listId="owner-inspection-loom-ledgers"
                    label={t('ownerInspection.ar007.loomRoutingLedgers')}
                    getKey={(item) => item.key}
                    className={styles.ledgerList}
                    t={t}
                    renderItem={({ inspection: loomInspection, position }) => (
                      <LoomInspectionLedger
                        inspection={loomInspection}
                        inspectionIndex={position}
                        roleBySource={loomRoleBySource}
                        resetKey={inspectionResetKey}
                        t={t}
                        notRecorded={notRecorded}
                      />
                    )}
                  />
                ) : (
                  <p className={styles.evidenceUnavailable}>
                    {t('ownerInspection.ar007.noStructuredLoomInspection')}
                  </p>
                )}
              </section>

              <section className={styles.section} aria-labelledby="owner-inspection-ordered-prompts-heading">
                <div className={styles.sectionHeading}>
                  <div>
                    <h4 id="owner-inspection-ordered-prompts-heading">{t('ownerInspection.ar007.orderedPromptRecords')}</h4>
                    <p>{t('ownerInspection.ar007.orderedPromptSummary')}</p>
                  </div>
                </div>
                {orderedPromptRecords.length === 0 ? (
                  <EmptyState icon={<FileText aria-hidden="true" />}>{t('ownerInspection.promptsEmpty')}</EmptyState>
                ) : (
                  <BoundedCollection
                    items={orderedPromptRecords}
                    resetKey={`${inspectionResetKey}:prompts`}
                    listId="owner-inspection-prompts-list"
                    label={t('ownerInspection.prompts')}
                    getKey={({ prompt }) => prompt.id}
                    t={t}
                    renderItem={({ prompt, position }) => (
                      <PromptCard
                        prompt={prompt}
                        t={t}
                        position={position}
                        resetKey={inspectionResetKey}
                      />
                    )}
                  />
                )}
              </section>

              <section className={styles.section} aria-labelledby="owner-inspection-render-crossings-heading">
                <div className={styles.sectionHeading}>
                  <div>
                    <h4 id="owner-inspection-render-crossings-heading">{t('ownerInspection.ar007.acceptedRenderCrossings')}</h4>
                    <p>{t('ownerInspection.ar007.acceptedRenderSummary')}</p>
                  </div>
                </div>
                {acceptedRenderCrossings.length > 0 ? (
                  <BoundedCollection
                    items={acceptedRenderCrossings}
                    resetKey={`${inspectionResetKey}:render-crossings`}
                    listId="owner-inspection-render-crossings"
                    label={t('ownerInspection.ar007.acceptedRenderCrossingList')}
                    getKey={(crossing) => crossing.id}
                    t={t}
                    renderItem={(crossing) => <RenderCrossingCard crossing={crossing} t={t} />}
                  />
                ) : (
                  <p className={styles.evidenceUnavailable}>
                    {t('ownerInspection.ar007.noAcceptedRender')}
                  </p>
                )}
              </section>

              <section className={styles.section} aria-labelledby="owner-inspection-execution-evidence-heading">
                <div className={styles.sectionHeading}>
                  <div>
                    <h4 id="owner-inspection-execution-evidence-heading">{t('ownerInspection.ar007.toolsDelegation')}</h4>
                    <p>{t('ownerInspection.ar007.toolsDelegationSummary')}</p>
                  </div>
                </div>
                {executionEvidence.length > 0 ? (
                  <BoundedCollection
                    items={executionEvidence}
                    resetKey={`${inspectionResetKey}:execution-evidence`}
                    listId="owner-inspection-execution-evidence"
                    label={t('ownerInspection.ar007.toolsDelegationEvidence')}
                    getKey={(record) => record.id}
                    t={t}
                    renderItem={(record) => <ExecutionEvidenceCard record={record} t={t} notRecorded={notRecorded} />}
                  />
                ) : (
                  <p className={styles.evidenceUnavailable}>{t('ownerInspection.ar007.noToolsDelegation')}</p>
                )}
              </section>
            </section>


            <section id="owner-inspection-panel-markers" className={styles.panel} role="tabpanel" aria-labelledby="owner-inspection-tab-markers" hidden={tab !== 'markers'} tabIndex={tab === 'markers' ? 0 : -1}>

              <div className={styles.sectionHeading}><div><h3>{t('ownerInspection.markers')}</h3><p>{t('ownerInspection.markersIntro')}</p></div></div>
              {inspection.sectionAvailability.length > 0 ? (
                <section className={styles.section} aria-labelledby="owner-inspection-availability-heading">
                  <div className={styles.sectionHeading}><h4 id="owner-inspection-availability-heading">{t('ownerInspection.availability')}</h4></div>
                  <BoundedCollection
                    items={inspection.sectionAvailability}
                    resetKey={`${inspectionResetKey}:availability`}
                    listId="owner-inspection-availability-list"
                    label={t('ownerInspection.availability')}
                    getKey={(availability) => availability.section}
                    t={t}
                    renderItem={(availability) => (
                      <article className={styles.markerCard}>
                        <header className={styles.markerHeader}><strong>{valueLabel(t, availability.section)}</strong><span className={styles.markerBadge}>{valueLabel(t, availability.state)}</span></header>
                        {availability.reason ? <p className={styles.markerDetail}>{t('ownerInspection.reason')}: {valueLabel(t, availability.reason)}</p> : null}
                      </article>
                    )}
                  />
                </section>
              ) : null}
              {markers.length === 0
                ? <EmptyState icon={<CheckCircle2 aria-hidden="true" />}>{t('ownerInspection.markersEmpty')}</EmptyState>
                : <BoundedCollection
                    items={markers}
                    resetKey={`${inspectionResetKey}:markers`}
                    listId="owner-inspection-markers-list"
                    label={t('ownerInspection.markers')}
                    getKey={(marker) => marker.id}
                    t={t}
                    renderItem={(marker) => <article className={styles.markerCard}><header className={styles.markerHeader}><MarkerBadge marker={marker} t={t}/><strong>{valueLabel(t, marker.scope)}</strong></header><dl className={styles.providerGrid}><Field label={t('ownerInspection.markerRange')} value={marker.firstSequence === null ? '—' : `${marker.firstSequence}–${marker.lastSequence ?? marker.firstSequence}`} /><Field label={t('ownerInspection.recoverable')} value={marker.recoverable === null ? notRecorded : marker.recoverable ? t('ownerInspection.included') : t('ownerInspection.omitted')} /></dl>{marker.detail ? <p className={styles.markerDetail}>{marker.detail}</p> : null}{marker.kind === 'credentials_withheld' || marker.kind === 'other_user_data_withheld' ? <p className={styles.privacyNotice}><LockKeyhole aria-hidden="true" />{t('ownerInspection.omissionPrivacy')}</p> : null}{marker.correlation ? <CorrelationGrid correlation={marker.correlation} t={t}/> : null}</article>}
                  />}
            </section>

            <section id="owner-inspection-panel-usage" className={styles.panel} role="tabpanel" aria-labelledby="owner-inspection-tab-usage" hidden={tab !== 'usage'} tabIndex={tab === 'usage' ? 0 : -1}>

              <div className={styles.sectionHeading}><div><h3>{t('ownerInspection.usage')}</h3><p>{t('ownerInspection.transcriptIntro')}</p></div></div>
              <section className={styles.section} aria-labelledby="owner-inspection-usage-total-heading">
                <div className={styles.sectionHeading}><h3 id="owner-inspection-usage-total-heading">{t('ownerInspection.totalUsage')}</h3></div>
                <dl className={styles.usageGrid}><Field label={t('ownerInspection.inputTokens')} value={inspection.usage.totals.inputTokens.toLocaleString()} /><Field label={t('ownerInspection.outputTokens')} value={inspection.usage.totals.outputTokens.toLocaleString()} /><Field label={t('ownerInspection.totalTokens')} value={inspection.usage.totals.totalTokens.toLocaleString()} /><Field label={t('ownerInspection.toolCalls')} value={inspection.usage.totals.toolCalls.toLocaleString()} /><Field label={t('ownerInspection.childInvocations')} value={inspection.usage.totals.childInvocations.toLocaleString()} /><Field label={t('ownerInspection.evidenceCount')} value={inspection.usage.evidenceCount.toLocaleString()} /><Field label={t('ownerInspection.omittedEvidenceCount')} value={inspection.usage.omittedEvidenceCount.toLocaleString()} /></dl>
              </section>
              {inspection.usage.layers.length > 0 ? <section className={styles.section} aria-labelledby="owner-inspection-usage-layer-heading"><div className={styles.sectionHeading}><h3 id="owner-inspection-usage-layer-heading">{t('ownerInspection.layers')}</h3></div><BoundedCollection items={inspection.usage.layers} resetKey={`${inspectionResetKey}:usage-layers`} listId="owner-inspection-usage-layers-list" label={t('ownerInspection.layers')} getKey={(layer) => `${layer.layer}:${layer.correlation?.hostSequence ?? layer.evidenceIds.join(',')}`} t={t} renderItem={(layer) => <article className={styles.usageCard}><header className={styles.recordHeader}><strong>{valueLabel(t, layer.layer)}</strong><span className={styles.recordMeta}>{t('ownerInspection.evidence')}: {layer.evidenceIds.length.toLocaleString()}</span></header><UsageCard usage={layer} t={t}/></article>} /></section> : null}
              {usage.length === 0 ? <EmptyState>{t('ownerInspection.usageEmpty')}</EmptyState> : <BoundedCollection items={usage} resetKey={`${inspectionResetKey}:usage`} listId="owner-inspection-usage-list" label={t('ownerInspection.usage')} getKey={(item) => item.id} t={t} renderItem={(item) => <UsageCard usage={item} t={t}/>} />}
            </section>

            <section id="owner-inspection-panel-provenance" className={styles.panel} role="tabpanel" aria-labelledby="owner-inspection-tab-provenance" hidden={tab !== 'provenance'} tabIndex={tab === 'provenance' ? 0 : -1}>
              <div className={styles.sectionHeading}><div><h3>{t('ownerInspection.workspace')}</h3><p>{t('ownerInspection.workspaceBoundary')}</p></div></div>
              <div className={styles.collectionControlStack}>
                <CollectionControls label={t('persistentWorkspace.turnSessions')} listId="owner-inspection-workspace-content" shown={workspaceSessionsWindow.shownCount} total={workspaceSessionsTotal} hasMore={workspaceSessionsHasMore} onShowMore={revealWorkspaceSessions} t={t} />
                <CollectionControls label={t('persistentWorkspace.sections.tasks')} listId="owner-inspection-workspace-content" shown={workspaceTasksWindow.shownCount} total={workspaceTasks.length} onShowMore={workspaceTasksWindow.revealMore} t={t} />
                <CollectionControls label={t('persistentWorkspace.sections.records')} listId="owner-inspection-workspace-content" shown={workspaceRecordsWindow.shownCount} total={workspaceRecords.length} onShowMore={workspaceRecordsWindow.revealMore} t={t} />
                <CollectionControls label={t('persistentWorkspace.submissions')} listId="owner-inspection-workspace-content" shown={workspaceSubmissionsWindow.shownCount} total={workspaceSubmissions.length} onShowMore={workspaceSubmissionsWindow.revealMore} t={t} />
                <CollectionControls label={t('persistentWorkspace.sections.artifacts')} listId="owner-inspection-workspace-content" shown={workspaceArtifactsWindow.shownCount} total={workspaceArtifacts.length} onShowMore={workspaceArtifactsWindow.revealMore} t={t} />
                <CollectionControls label={t('persistentWorkspace.sections.publications')} listId="owner-inspection-workspace-content" shown={workspacePublicationsWindow.shownCount} total={workspacePublications.length} onShowMore={workspacePublicationsWindow.revealMore} t={t} />
              </div>
              <div id="owner-inspection-workspace-content">
                <PersistentWorkspaceInspector workspace={renderedPersistentWorkspace} sessions={workspaceSessionsWindow.visibleItems} sessionsTotal={workspaceSessionsTotal} sessionsHasMore={workspaceSessionsHasMore} sessionsLoadingMore={workspaceSessionsLoadingMore} onLoadMoreSessions={revealWorkspaceSessions} tasks={workspaceTasksWindow.visibleItems} records={workspaceRecordsWindow.visibleItems} submissions={workspaceSubmissionsWindow.visibleItems} artifacts={workspaceArtifactsWindow.visibleItems} publications={workspacePublicationsWindow.visibleItems} loading={workspaceLoading} error={workspaceError} onRefresh={loadPersistentWorkspace} onEdit={editPersistentWorkspace} onCreateTask={createPersistentWorkspaceTask} onPublish={publishPersistentWorkspace} onDeletePublication={deletePersistentWorkspacePublication} onDeleteWorkspace={deletePersistentWorkspace} onOpenTurnSession={() => setTab('turnSession')} />
              </div>
              {workspaceAssociations.length > 0 ? <BoundedCollection items={workspaceAssociations} resetKey={`${inspectionResetKey}:workspace-associations`} listId="owner-inspection-workspace-associations-list" label={t('ownerInspection.workspace')} getKey={(association) => association.id} t={t} renderItem={(association) => <WorkspaceAssociationCard association={association} t={t}/>} /> : null}
            </section>


            <section id="owner-inspection-panel-receipts" className={styles.panel} role="tabpanel" aria-labelledby="owner-inspection-tab-receipts" hidden={tab !== 'receipts'} tabIndex={tab === 'receipts' ? 0 : -1}>
              <div className={styles.collectionControlStack}>
                <CollectionControls label={t('agentRun.receipts.cortex.groupTitle')} listId="owner-inspection-receipts-content" shown={cortexReceiptsWindow.shownCount} total={cortexReceipts.length} onShowMore={cortexReceiptsWindow.revealMore} t={t} />
                <CollectionControls label={t('agentRun.receipts.council.groupTitle')} listId="owner-inspection-receipts-content" shown={councilReceiptsWindow.shownCount} total={councilReceipts.length} onShowMore={councilReceiptsWindow.revealMore} t={t} />
              </div>
              <div id="owner-inspection-receipts-content">
                <WorkReceiptSections cortexReceipts={cortexReceiptsWindow.visibleItems} councilReceipts={councilReceiptsWindow.visibleItems} />
              </div>
            </section>
          </>}
        </div>
      </div>
    </div>,
    document.body,
  )
}
