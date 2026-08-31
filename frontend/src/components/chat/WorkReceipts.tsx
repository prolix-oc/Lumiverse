import { AlertTriangle, CheckCircle2, CircleX, Clock3, EyeOff, GitBranch, ShieldAlert, Sparkles, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  AgentCortexReceiptV1,
  AgentCouncilReceiptV1,
  AgentCortexReceiptStateV1,
  AgentCortexOmissionReasonV1,
} from '@/types/agent-runs'
import styles from './WorkReceipts.module.css'

export type WorkReceiptKind = 'cortex' | 'council'
export type WorkReceiptState = AgentCortexReceiptStateV1

export interface WorkReceiptStatusItem {
  readonly kind: WorkReceiptKind
  readonly state: WorkReceiptState
  readonly required: boolean
}

export interface WorkReceiptSectionsProps {
  readonly cortexReceipts: readonly AgentCortexReceiptV1[]
  readonly councilReceipts: readonly AgentCouncilReceiptV1[]
}

export interface WorkReceiptStatusProps {
  /** Compact activity receives only this status projection, never receipt payloads. */
  readonly items: readonly WorkReceiptStatusItem[]
  readonly onInspect?: () => void
}

function stateIcon(state: WorkReceiptState) {
  if (state === 'accepted') return <CheckCircle2 aria-hidden="true" />
  if (state === 'failed') return <CircleX aria-hidden="true" />
  if (state === 'cancelled') return <Clock3 aria-hidden="true" />
  return <EyeOff aria-hidden="true" />
}

function stateLabel(state: WorkReceiptState, t: (key: string) => string): string {
  return t(`agentRun.receipts.states.${state}`)
}

function reasonLabel(reason: string | null, t: (key: string) => string): string | null {
  return reason ? t(`agentRun.receipts.reasons.${reason}`) : null
}

function omissionReasonLabel(reason: AgentCortexOmissionReasonV1, t: (key: string) => string): string {
  return t(`agentRun.receipts.omissionReasons.${reason}`)
}

function formatDateTime(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null
  return new Date(value).toLocaleString()
}

function ReceiptStateBadge({ state, required }: { state: WorkReceiptState; required: boolean }) {
  const { t } = useTranslation('chat')
  return (
    <span className={styles.stateBadge} data-state={state} data-required={required ? 'true' : 'false'}>
      {stateIcon(state)}
      <span>{stateLabel(state, t)}</span>
      <span className={styles.obligation}>{required ? t('agentRun.receipts.required') : t('agentRun.receipts.optional')}</span>
    </span>
  )
}

function CorrelationDetails({
  correlation,
  requestId,
  t,
}: {
  correlation: AgentCortexReceiptV1['correlation']
  requestId: string
  t: (key: string) => string
}) {
  return (
    <dl className={styles.correlationGrid}>
      <div>
        <dt>{t('agentRun.receipts.requestId')}</dt>
        <dd><code>{requestId}</code></dd>
      </div>
      <div>
        <dt>{t('agentRun.receipts.attemptId')}</dt>
        <dd><code>{correlation.attemptId}</code></dd>
      </div>
      <div>
        <dt>{t('agentRun.receipts.runId')}</dt>
        <dd><code>{correlation.runId}</code></dd>
      </div>
      <div>
        <dt>{t('agentRun.receipts.hostSequence')}</dt>
        <dd>{correlation.hostSequence.toLocaleString()}</dd>
      </div>
    </dl>
  )
}

function BoundaryNotice({ kind }: { kind: WorkReceiptKind }) {
  const { t } = useTranslation('chat')
  return (
    <div className={styles.boundaryNotice} data-kind={kind}>
      {kind === 'cortex' ? <ShieldAlert aria-hidden="true" /> : <GitBranch aria-hidden="true" />}
      <span>{t(`agentRun.receipts.${kind}.boundary`)}</span>
    </div>
  )
}

function CortexReceiptCard({ receipt }: { receipt: AgentCortexReceiptV1 }) {
  const { t } = useTranslation('chat')
  const omission = receipt.omission
  const reason = reasonLabel(receipt.reason, t)
  return (
    <article className={styles.receiptCard} data-kind="cortex" data-state={receipt.state}>
      <header className={styles.receiptHeader}>
        <div className={styles.receiptTitle}>
          <Sparkles aria-hidden="true" />
          <div>
            <h4>{t('agentRun.receipts.cortex.title')}</h4>
            <p>{t('agentRun.receipts.cortex.subtitle')}</p>
          </div>
        </div>
        <ReceiptStateBadge state={receipt.state} required={receipt.required} />
      </header>

      <BoundaryNotice kind="cortex" />

      <dl className={styles.metadataGrid}>
        <div>
          <dt>{t('agentRun.receipts.checkpoint')}</dt>
          <dd><code>{receipt.checkpoint}</code></dd>
        </div>
        <div>
          <dt>{t('agentRun.receipts.snapshotId')}</dt>
          <dd><code>{receipt.snapshotId}</code></dd>
        </div>
        <div>
          <dt>{t('agentRun.receipts.sourceRevision')}</dt>
          <dd><code>{String(receipt.sourceRevision)}</code></dd>
        </div>
        <div>
          <dt>{t('agentRun.receipts.revision')}</dt>
          <dd><code>{String(receipt.revision)}</code></dd>
        </div>
        <div>
          <dt>{t('agentRun.receipts.resultCount')}</dt>
          <dd>{receipt.resultCount.toLocaleString()}</dd>
        </div>
        <div>
          <dt>{t('agentRun.receipts.resultDigest')}</dt>
          <dd>{receipt.resultDigest ? <code>{receipt.resultDigest}</code> : t('agentRun.receipts.noResult')}</dd>
        </div>
      </dl>

      {omission ? (
        <div className={styles.omissionNotice} data-required={receipt.required ? 'true' : 'false'}>
          <AlertTriangle aria-hidden="true" />
          <div>
            <strong>{receipt.required ? t('agentRun.receipts.requiredFailure') : t('agentRun.receipts.optionalOmission')}</strong>
            <span>{omissionReasonLabel(omission.reason, t)}{omission.detail ? ` — ${omission.detail}` : ''}</span>
          </div>
        </div>
      ) : reason ? (
        <div className={styles.reasonNotice}>
          <span>{t('agentRun.receipts.reason')}</span>
          <strong>{reason}</strong>
        </div>
      ) : null}

      <CorrelationDetails correlation={receipt.correlation} requestId={receipt.requestId} t={t} />
      <p className={styles.payloadNotice}>{t('agentRun.receipts.payloadWithheld')}</p>
    </article>
  )
}

function CouncilReceiptCard({ receipt }: { receipt: AgentCouncilReceiptV1 }) {
  const { t } = useTranslation('chat')
  const reason = reasonLabel(receipt.reason, t)
  const startedAt = formatDateTime(receipt.startedAt)
  const completedAt = formatDateTime(receipt.completedAt)
  return (
    <article className={styles.receiptCard} data-kind="council" data-state={receipt.state}>
      <header className={styles.receiptHeader}>
        <div className={styles.receiptTitle}>
          <Users aria-hidden="true" />
          <div>
            <h4>{t('agentRun.receipts.council.title')}</h4>
            <p>{t('agentRun.receipts.council.subtitle')}</p>
          </div>
        </div>
        <ReceiptStateBadge state={receipt.state} required={receipt.required} />
      </header>

      <BoundaryNotice kind="council" />

      <dl className={styles.metadataGrid}>
        <div>
          <dt>{t('agentRun.receipts.checkpoint')}</dt>
          <dd><code>{receipt.checkpoint}</code></dd>
        </div>
        <div>
          <dt>{t('agentRun.receipts.memberCount')}</dt>
          <dd>{receipt.memberCount.toLocaleString()}</dd>
        </div>
        <div>
          <dt>{t('agentRun.receipts.resultDigest')}</dt>
          <dd>{receipt.resultDigest ? <code>{receipt.resultDigest}</code> : t('agentRun.receipts.noResult')}</dd>
        </div>
        <div>
          <dt>{t('agentRun.receipts.startedAt')}</dt>
          <dd>{startedAt ?? t('agentRun.receipts.notRecorded')}</dd>
        </div>
        <div>
          <dt>{t('agentRun.receipts.completedAt')}</dt>
          <dd>{completedAt ?? t('agentRun.receipts.inProgress')}</dd>
        </div>
      </dl>

      {receipt.state === 'omitted' ? (
        <div className={styles.omissionNotice} data-required={receipt.required ? 'true' : 'false'}>
          <AlertTriangle aria-hidden="true" />
          <div>
            <strong>{receipt.required ? t('agentRun.receipts.requiredFailure') : t('agentRun.receipts.optionalOmission')}</strong>
            <span>{reason ?? t('agentRun.receipts.omittedWithoutReason')}</span>
          </div>
        </div>
      ) : reason ? (
        <div className={styles.reasonNotice}>
          <span>{t('agentRun.receipts.reason')}</span>
          <strong>{reason}</strong>
        </div>
      ) : null}

      <CorrelationDetails correlation={receipt.correlation} requestId={receipt.requestId} t={t} />
      <p className={styles.payloadNotice}>{t('agentRun.receipts.payloadWithheld')}</p>
    </article>
  )
}

function ReceiptEmptyState({ kind }: { kind: WorkReceiptKind }) {
  const { t } = useTranslation('chat')
  return (
    <div className={styles.emptyState} data-kind={kind}>
      <EyeOff aria-hidden="true" />
      <span>{t(`agentRun.receipts.${kind}.empty`)}</span>
    </div>
  )
}

/**
 * Full owner inspection for WORK-owned Cortex/Council receipts. This component
 * deliberately renders receipt metadata and bounded result evidence only; it
 * never implies either sidecar is canonical state or commit authority.
 */
export function WorkReceiptSections({ cortexReceipts, councilReceipts }: WorkReceiptSectionsProps) {
  const { t } = useTranslation('chat')
  return (
    <section className={styles.sections} aria-labelledby="work-receipts-title">
      <header className={styles.sectionsHeader}>
        <div>
          <h3 id="work-receipts-title">{t('agentRun.receipts.title')}</h3>
          <p>{t('agentRun.receipts.subtitle')}</p>
        </div>
        <span className={styles.workBadge}>{t('agentRun.receipts.workCheckpoint')}</span>
      </header>
      <div className={styles.integrationNotice}>
        <ShieldAlert aria-hidden="true" />
        <span>{t('agentRun.receipts.integrationBoundary')}</span>
      </div>

      <div className={styles.receiptGroup}>
        <div className={styles.groupHeading}>
          <h4>{t('agentRun.receipts.cortex.groupTitle')}</h4>
          <span>{cortexReceipts.length.toLocaleString()}</span>
        </div>
        {cortexReceipts.length > 0
          ? cortexReceipts.map((receipt, index) => <CortexReceiptCard key={`${receipt.id}-${index}`} receipt={receipt} />)
          : <ReceiptEmptyState kind="cortex" />}
      </div>

      <div className={styles.receiptGroup}>
        <div className={styles.groupHeading}>
          <h4>{t('agentRun.receipts.council.groupTitle')}</h4>
          <span>{councilReceipts.length.toLocaleString()}</span>
        </div>
        {councilReceipts.length > 0
          ? councilReceipts.map((receipt, index) => <CouncilReceiptCard key={`${receipt.id}-${index}`} receipt={receipt} />)
          : <ReceiptEmptyState kind="council" />}
      </div>
    </section>
  )
}

/** Compact activity projection: status and receipt kind only, never payloads. */
export function WorkReceiptStatus({ items, onInspect }: WorkReceiptStatusProps) {
  const { t } = useTranslation('chat')
  if (items.length === 0) return null
  const content = (
    <span className={styles.statusList} role="list" aria-label={t('agentRun.receipts.statusAria')}>
      {items.map((item, index) => (
        <span key={`${item.kind}-${index}`} className={styles.statusItem} data-kind={item.kind} data-state={item.state} role="listitem">
          <span className={styles.statusIcon}>{stateIcon(item.state)}</span>
          <span className={styles.statusText}>
            <strong>{t(`agentRun.receipts.${item.kind}.shortTitle`)}</strong>
            <span>{stateLabel(item.state, t)} · {item.required ? t('agentRun.receipts.required') : t('agentRun.receipts.optional')}</span>
          </span>
        </span>
      ))}
    </span>
  )
  if (!onInspect) return content
  return (
    <button type="button" className={styles.statusButton} onClick={onInspect} aria-label={t('agentRun.receipts.inspectStatus')}>
      {content}
    </button>
  )
}

export function receiptStatusItems(
  cortexReceipts: readonly AgentCortexReceiptV1[],
  councilReceipts: readonly AgentCouncilReceiptV1[],
): WorkReceiptStatusItem[] {
  return [
    ...(cortexReceipts.length > 0 ? [{ kind: 'cortex' as const, state: cortexReceipts[cortexReceipts.length - 1].state, required: cortexReceipts[cortexReceipts.length - 1].required }] : []),
    ...(councilReceipts.length > 0 ? [{ kind: 'council' as const, state: councilReceipts[councilReceipts.length - 1].state, required: councilReceipts[councilReceipts.length - 1].required }] : []),
  ]
}
