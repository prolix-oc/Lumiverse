import { useEffect, useId, useRef, useState } from 'react'
import { Bot, ChevronDown, Info, MessageSquare, Pin, RotateCw, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useEffectiveRuntime, type UseEffectiveRuntimeOptions } from '@/hooks/useEffectiveRuntime'
import type {
  AgentRuntimeMode,
  AgentRuntimeRepairCategory,
  LoomRuntimePolicyAvailabilityStateV1,
  LoomRuntimePolicyScopeV1,
  LoomRuntimePolicySourceV1,
  LoomRuntimePolicyV1,
} from '@/types/effective-runtime'
import type { LoomPromptInspectionItemV1 } from '@/types/agent-runtime'
import { ApiError } from '@/api/client'
import styles from './AgentRuntimeModeControl.module.css'

export type AgentRuntimeModeControlProps = UseEffectiveRuntimeOptions

const REPAIR_TRANSLATION_KEYS: Record<AgentRuntimeRepairCategory, string> = {
  slot: 'agentRuntime.repair.slot',
  provider: 'agentRuntime.repair.provider',
  isolate: 'agentRuntime.repair.isolate',
  egress: 'agentRuntime.repair.egress',
  readiness: 'agentRuntime.repair.readiness',
}

const RESPONSE_ONLY_REASON_KEYS = {
  loading: 'agentRuntime.responseOnlyReasons.loading',
  error: 'agentRuntime.responseOnlyReasons.error',
  unsupported_surface: 'agentRuntime.responseOnlyReasons.unsupportedSurface',
  agents_disabled: 'agentRuntime.responseOnlyReasons.agentsDisabled',
  repair_required: 'agentRuntime.responseOnlyReasons.repairRequired',
  unavailable: 'agentRuntime.responseOnlyReasons.unavailable',
} as const

const RUNTIME_POLICY_SOURCE_KEYS: Record<LoomRuntimePolicySourceV1, string> = {
  authenticated_one_turn: 'agentRuntime.provenance.sourceAuthenticatedOneTurn',
  durable_chat_override: 'agentRuntime.provenance.sourceDurableChatOverride',
  reviewed_preset_default: 'agentRuntime.provenance.sourceReviewedPresetDefault',
  response_fallback: 'agentRuntime.provenance.sourceResponseFallback',
  host_cap: 'agentRuntime.provenance.sourceHostCap',
  host_rejected: 'agentRuntime.provenance.sourceHostRejected',
}

const RUNTIME_POLICY_SCOPE_KEYS: Record<LoomRuntimePolicyScopeV1, string> = {
  turn: 'agentRuntime.provenance.scopeTurn',
  chat: 'agentRuntime.provenance.scopeChat',
  preset: 'agentRuntime.provenance.scopePreset',
  fallback: 'agentRuntime.provenance.scopeFallback',
  host: 'agentRuntime.provenance.scopeHost',
}

const RUNTIME_POLICY_AVAILABILITY_KEYS: Record<LoomRuntimePolicyAvailabilityStateV1, string> = {
  available: 'agentRuntime.provenance.availabilityAvailable',
  unavailable: 'agentRuntime.provenance.availabilityUnavailable',
  stale: 'agentRuntime.provenance.availabilityStale',
  invalid: 'agentRuntime.provenance.availabilityInvalid',
  denied: 'agentRuntime.provenance.availabilityDenied',
  omitted: 'agentRuntime.provenance.availabilityOmitted',
}
const RUNTIME_POLICY_AUTHORITY_KEYS: Record<LoomRuntimePolicyV1['cap']['authority'], string> = {
  host: 'agentRuntime.provenance.capAuthorityHost',
}

const REPAIR_ACKNOWLEDGEMENT_STATE_KEYS: Record<LoomRuntimePolicyV1['repairAcknowledgement']['state'], string> = {
  not_required: 'agentRuntime.provenance.repairAcknowledgementNotRequired',
  required: 'agentRuntime.provenance.repairAcknowledgementRequired',
  acknowledged: 'agentRuntime.provenance.repairAcknowledgementAcknowledged',
}

type OverrideAction =
  | { kind: 'save'; mode: AgentRuntimeMode }
  | { kind: 'reset' }

interface OverrideFailure {
  action: OverrideAction
  resolution: { code: string; message: string }
}

function boundedErrorText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().slice(0, 512)
    : fallback
}

function runtimeResolutionError(error: Error): { code: string; message: string } {
  if (error instanceof ApiError) {
    const body = error.body && typeof error.body === 'object' ? error.body as Record<string, unknown> : {}
    return {
      code: boundedErrorText(body.code, error.name).replace(/[^a-zA-Z0-9_.-]/g, '_'),
      message: boundedErrorText(body.error, error.message),
    }
  }
  return {
    code: boundedErrorText(error.name, 'runtime_resolution_failed').replace(/[^a-zA-Z0-9_.-]/g, '_'),
    message: boundedErrorText(error.message, 'Runtime resolution failed'),
  }
}

function loomOutcomeValue(item: LoomPromptInspectionItemV1, t: (key: string, options?: Record<string, unknown>) => string): string {
  const status = t(`ownerInspection.values.${item.outcome.status}`, { defaultValue: item.outcome.status })
  if (item.outcome.status === 'included') {
    return t('agentRuntime.provenance.loomInspection.ar007.outcomeIncluded', {
      status,
      index: item.outcome.effectiveIndex,
    })
  }
  if (item.outcome.status === 'deduplicated') {
    return t('agentRuntime.provenance.loomInspection.ar007.outcomeDeduplicated', {
      status,
      entry: item.outcome.keptEntryId,
      destination: item.outcome.destination,
    })
  }
  return t('agentRuntime.provenance.loomInspection.ar007.outcomeReason', {
    status,
    reason: t(`ownerInspection.values.${item.outcome.reason}`, { defaultValue: item.outcome.reason }),
  })
}

export default function AgentRuntimeModeControl(props: AgentRuntimeModeControlProps) {
  const { t } = useTranslation('chat')
  const runtime = useEffectiveRuntime(props)
  const inspectionTitleId = useId()
  const [announcement, setAnnouncement] = useState('')
  const [overrideAction, setOverrideAction] = useState<OverrideAction | null>(null)
  const [overrideFailure, setOverrideFailure] = useState<OverrideFailure | null>(null)
  const overrideActionRef = useRef<OverrideAction | null>(null)
  const overrideActionEpochRef = useRef(0)
  const [, refreshOverrideScope] = useState(0)
  const overrideScopeRef = useRef(props.chatId)
  const overrideScopeChanged = overrideScopeRef.current !== props.chatId
  useEffect(() => {
    if (overrideScopeRef.current === props.chatId) return
    overrideScopeRef.current = props.chatId
    overrideActionEpochRef.current += 1
    overrideActionRef.current = null
    setOverrideAction(null)
    setOverrideFailure(null)
    setAnnouncement('')
    refreshOverrideScope((revision) => revision + 1)
  }, [props.chatId])
  const visibleOverrideAction = overrideScopeChanged ? null : overrideAction
  const visibleOverrideFailure = overrideScopeChanged ? null : overrideFailure
  const decision = runtime.decision?.chatId === props.chatId ? runtime.decision : null
  const inspection = decision ? runtime.inspection : null
  const responseOmission = decision ? runtime.responseOmission : null
  const policy = decision?.runtimePolicy ?? null
  const visibleRuntimeError = overrideScopeChanged ? null : runtime.error
  const localOneTurnMode = decision
    ? runtime.pendingOneTurnMode ?? runtime.oneTurnMode
    : null
  const canonicalTransientMode = policy?.transientSelection?.mode ?? null
  const canonicalPendingMode = runtime.pendingOneTurnMode != null
    && policy?.nextTurnOnly === true
    && canonicalTransientMode === runtime.pendingOneTurnMode
    ? runtime.pendingOneTurnMode
    : null
  // A degraded Agentic request may have an effective Response fallback, but
  // that fallback is status, not a user selection. Keep the selected control
  // bound to authored authority until the user explicitly chooses otherwise.
  const selectedMode = localOneTurnMode
    ?? canonicalTransientMode
    ?? policy?.authoredValue
    ?? decision?.requestedMode
    ?? 'response'
  const requestedMode = policy?.authoredValue ?? decision?.requestedMode ?? 'response'
  const authoredMode = policy?.authoredValue ?? decision?.defaultMode ?? 'response'
  const effectiveMode = policy?.effectiveValue ?? decision?.effectiveMode ?? 'response'
  const canShowSelector = decision !== null && runtime.canShowSelector
  const canSetOverride = decision !== null
    && (runtime.canSetChatOverride ?? runtime.canShowSelector)
  const canResetOverride = decision !== null
    && runtime.canResetChatOverride === true
    && typeof runtime.resetChatOverride === 'function'
  const chatPolicyLocked = runtime.activeGenerationMode !== null
  const modeLabel: Record<AgentRuntimeMode, string> = {
    response: t('agentRuntime.mode.response'),
    agentic: t('agentRuntime.mode.agentic'),
  }
  const unavailableValue = t('agentRuntime.provenance.unavailable')
  const noneValue = t('agentRuntime.provenance.none')
  const reasonCodeValue = (reasonCode: string | null | undefined): string => (
    reasonCode ? boundedErrorText(reasonCode, noneValue).slice(0, 128) : noneValue
  )
  const sourceValue = policy
    ? t(RUNTIME_POLICY_SOURCE_KEYS[policy.source])
    : unavailableValue
  const authorityValue = policy
    ? t(RUNTIME_POLICY_AUTHORITY_KEYS[policy.cap.authority])
    : unavailableValue
  const scopeValue = policy
    ? t(RUNTIME_POLICY_SCOPE_KEYS[policy.scope])
    : unavailableValue
  const capAllowedModesValue = policy
    ? policy.cap.allowedModes.map((mode) => modeLabel[mode]).join(', ')
    : unavailableValue
  const capReasonCodeValue = policy
    ? reasonCodeValue(policy.cap.reasonCode)
    : unavailableValue
  const availabilityValue = policy
    ? t(RUNTIME_POLICY_AVAILABILITY_KEYS[policy.availability.state])
    : unavailableValue
  const availabilityReasonCodeValue = policy
    ? reasonCodeValue(policy.availability.reasonCode)
    : unavailableValue
  const acknowledgementStateValue = policy
    ? t(REPAIR_ACKNOWLEDGEMENT_STATE_KEYS[policy.repairAcknowledgement.state])
    : unavailableValue
  const acknowledgementReasonCodeValue = policy
    ? reasonCodeValue(policy.repairAcknowledgement.reasonCode)
    : unavailableValue
  const capabilityValue = !decision
    ? t('agentRuntime.provenance.capabilityUnavailable')
    : decision.capabilityReadiness.missing.length > 0
      ? t('agentRuntime.provenance.capabilityMissing', {
          capabilities: decision.capabilityReadiness.missing
            .map((capability) => t(`agentRuntime.capability.${capability}`))
            .join(', '),
        })
      : decision.capabilityReadiness.ready
        ? t('agentRuntime.provenance.capabilityReady')
        : t('agentRuntime.provenance.capabilityNotReady')
  const responseOnlyReason = decision
    ? (runtime.responseOnlyReason ?? 'unavailable')
    : runtime.loading
      ? 'loading'
      : 'unavailable'
  const responseOnlyText = t(RESPONSE_ONLY_REASON_KEYS[responseOnlyReason])
  const tryingAgentic = selectedMode === 'agentic'
  const shouldShowRepair = runtime.repairCategories.length > 0 && !!decision && tryingAgentic
  const shouldShowResponseEscape = !!decision && tryingAgentic && !runtime.canShowSelector
  const overrideMode: AgentRuntimeMode = canShowSelector ? selectedMode : 'response'
  const isOverrideWriteInFlight = overrideScopeChanged
    || runtime.savingOverride
    || visibleOverrideAction !== null
  const showSurface = !!decision || runtime.loading || !!visibleRuntimeError || !!visibleOverrideFailure || props.supported === false
  const resolutionError = visibleRuntimeError && !visibleOverrideFailure
    ? runtimeResolutionError(visibleRuntimeError)
    : null

  if (!showSurface) return null


  const selectMode = (mode: AgentRuntimeMode) => {
    runtime.selectOneTurnMode(mode)
    setAnnouncement(t('agentRuntime.announcement.oneTurn', { mode: modeLabel[mode] }))
  }

  const startOverrideAction = (action: OverrideAction): number | null => {
    if (
      overrideScopeChanged
      || runtime.savingOverride
      || overrideActionRef.current !== null
      || chatPolicyLocked
    ) return null
    const epoch = overrideActionEpochRef.current + 1
    overrideActionEpochRef.current = epoch
    overrideActionRef.current = action
    setOverrideAction(action)
    setOverrideFailure(null)
    return epoch
  }

  const overrideActionLabel = (action: OverrideAction): string => (
    action.kind === 'save'
      ? t('agentRuntime.overrideError.saveAction', { mode: modeLabel[action.mode] })
      : t('agentRuntime.overrideError.resetAction')
  )

  const saveOverride = async (mode: AgentRuntimeMode = overrideMode) => {
    const action: OverrideAction = { kind: 'save', mode }
    const epoch = startOverrideAction(action)
    if (epoch === null) return
    try {
      await runtime.saveChatOverride(mode)
      if (overrideActionEpochRef.current === epoch) {
        setOverrideFailure(null)
        setAnnouncement(t('agentRuntime.announcement.overrideSaved', { mode: modeLabel[mode] }))
      }
    } catch (cause) {
      if (overrideActionEpochRef.current === epoch) {
        const error = cause instanceof Error ? cause : new Error('chat_mode_write_failed')
        setOverrideFailure({ action, resolution: runtimeResolutionError(error) })
        setAnnouncement(t('agentRuntime.announcement.overrideFailed', {
          action: overrideActionLabel(action),
        }))
      }
    } finally {
      if (overrideActionRef.current === action) overrideActionRef.current = null
      setOverrideAction((current) => current === action ? null : current)
    }
  }

  const resetOverride = async () => {
    if (!runtime.resetChatOverride) return
    const action: OverrideAction = { kind: 'reset' }
    const epoch = startOverrideAction(action)
    if (epoch === null) return
    try {
      await runtime.resetChatOverride()
      if (overrideActionEpochRef.current === epoch) {
        setOverrideFailure(null)
        setAnnouncement(t('agentRuntime.announcement.resetSaved'))
      }
    } catch (cause) {
      if (overrideActionEpochRef.current === epoch) {
        const error = cause instanceof Error ? cause : new Error('chat_mode_reset_failed')
        setOverrideFailure({ action, resolution: runtimeResolutionError(error) })
        setAnnouncement(t('agentRuntime.announcement.overrideFailed', {
          action: overrideActionLabel(action),
        }))
      }
    } finally {
      if (overrideActionRef.current === action) overrideActionRef.current = null
      setOverrideAction((current) => current === action ? null : current)
    }
  }

  const retryOverride = () => {
    const action = visibleOverrideFailure?.action
    if (!action) return
    if (action.kind === 'save') void saveOverride(action.mode)
    else void resetOverride()
  }

  const useResponse = () => {
    selectMode('response')
    setAnnouncement(t('agentRuntime.announcement.responseEscape'))
  }

  const retryResolution = () => {
    void runtime.refresh()
  }
  return (
    <section className={styles.surface} aria-label={t('agentRuntime.label')}>
      <div className={styles.headingRow}>
        <span className={styles.headingGroup}>
          <strong className={styles.heading}>{t('agentRuntime.label')}</strong>
          <span className={styles.scopeLabel}>{t('agentRuntime.oneTurnLegend')}</span>
        </span>
        {canonicalPendingMode != null && (
          <span className={styles.queued} role="status">
            {t('agentRuntime.nextTurnQueued', { mode: modeLabel[canonicalPendingMode] })}
          </span>
        )}
      </div>

      {resolutionError && (
        <div className={styles.repair} role="alert">
          <div className={styles.repairCopy}>
            <ShieldAlert size={16} aria-hidden="true" />
            <div className={styles.repairBody}>
              <strong>{t('agentRuntime.provenance.resolutionError.title')}</strong>
              <p>{t('agentRuntime.provenance.resolutionError.target', {
                generationType: props.generationType,
                messageId: props.messageId ?? t('agentRuntime.provenance.resolutionError.none'),
                swipeId: props.swipeId ?? t('agentRuntime.provenance.resolutionError.none'),
              })}</p>
              <p>{t('agentRuntime.provenance.resolutionError.code', { code: resolutionError.code })}</p>
              <p>{resolutionError.message}</p>
            </div>
          </div>
          <div className={styles.chatActions}>
            <button
              type="button"
              className={styles.resetButton}
              onClick={retryResolution}
              disabled={runtime.loading}
            >
              <RotateCw size={14} aria-hidden="true" />
              <span>{t('agentRuntime.provenance.resolutionError.retry')}</span>
            </button>
            <button type="button" className={styles.responseEscape} onClick={useResponse}>
              <MessageSquare size={14} aria-hidden="true" />
              <span>{t('agentRuntime.useResponse')}</span>
            </button>
          </div>
        </div>
      )}

      {visibleOverrideFailure && (
        <div className={styles.overrideError} role="alert" aria-live="assertive">
          <div className={styles.overrideErrorCopy}>
            <ShieldAlert size={16} aria-hidden="true" />
            <div className={styles.overrideErrorBody}>
              <strong>{t('agentRuntime.overrideError.title')}</strong>
              <p>{t('agentRuntime.overrideError.action', {
                action: overrideActionLabel(visibleOverrideFailure.action),
              })}</p>
              <p>{t('agentRuntime.overrideError.code', { code: visibleOverrideFailure.resolution.code })}</p>
              <p>{visibleOverrideFailure.resolution.message}</p>
            </div>
          </div>
          <button
            type="button"
            className={styles.responseEscape}
            onClick={retryOverride}
            disabled={isOverrideWriteInFlight || chatPolicyLocked}
          >
            <RotateCw size={14} aria-hidden="true" />
            <span>{t('agentRuntime.overrideError.retry', {
              action: overrideActionLabel(visibleOverrideFailure.action),
            })}</span>
          </button>
        </div>
      )}

      <div className={styles.modeRow}>
        {canShowSelector ? (
          <fieldset className={styles.modeFieldset}>
            <legend className={styles.srOnly}>{t('agentRuntime.oneTurnLegend')}</legend>
            {(['response', 'agentic'] as const).map((mode) => (
              <label key={mode} className={styles.modeOption} data-selected={selectedMode === mode || undefined}>
                <input
                  type="radio"
                  name={`agent-runtime-mode-${props.chatId}`}
                  value={mode}
                  checked={selectedMode === mode}
                  onChange={() => selectMode(mode)}
                />
                {mode === 'response' ? <MessageSquare size={15} aria-hidden="true" /> : <Bot size={15} aria-hidden="true" />}
                <span>{modeLabel[mode]}</span>
              </label>
            ))}
          </fieldset>
        ) : (
          <div className={styles.responseOnly} role="status" aria-live="polite">
            <MessageSquare size={15} aria-hidden="true" />
            <span>
              <strong>{modeLabel.response}</strong>
              <small>{responseOnlyText}</small>
            </span>
          </div>
        )}

        {(canSetOverride || canResetOverride) && (
          <div className={styles.chatActions}>
            {canSetOverride && (
              <button
                type="button"
                className={styles.overrideButton}
                onClick={() => void saveOverride()}
                disabled={isOverrideWriteInFlight || chatPolicyLocked}
              >
                <Pin size={14} aria-hidden="true" />
                <span>
                  {isOverrideWriteInFlight
                    ? t('agentRuntime.savingOverride')
                    : t('agentRuntime.useForChatMode', { mode: modeLabel[overrideMode] })}
                </span>
              </button>
            )}
            {canResetOverride && (
              <button
                type="button"
                className={styles.resetButton}
                onClick={() => void resetOverride()}
                disabled={isOverrideWriteInFlight || chatPolicyLocked}
              >
                <RotateCw size={14} aria-hidden="true" />
                <span>
                  {isOverrideWriteInFlight
                    ? t('agentRuntime.resetting')
                    : t('agentRuntime.resetToPreset')}
                </span>
              </button>
            )}
          </div>
        )}
      </div>

      {shouldShowRepair && (
        <div className={styles.repair}>
          <div className={styles.repairCopy}>
            <ShieldAlert size={16} aria-hidden="true" />
            <div className={styles.repairBody}>
              <strong>{t('agentRuntime.repair.title')}</strong>
              <ul className={styles.repairList}>
                {runtime.repairCategories.map((category) => (
                  <li key={category}>{t(REPAIR_TRANSLATION_KEYS[category])}</li>
                ))}
                {decision?.capabilityReadiness.missing.map((capability) => (
                  <li key={capability}>
                    {t('agentRuntime.capabilityMissing', {
                      capabilities: t(`agentRuntime.capability.${capability}`),
                    })}
                  </li>
                ))}
              </ul>
              <p className={styles.repairSafety}>{t('agentRuntime.noSilentDowngrade')}</p>
            </div>
          </div>
          <div className={styles.chatActions}>
            <button
              type="button"
              className={styles.resetButton}
              onClick={retryResolution}
              disabled={runtime.loading}
            >
              <RotateCw size={14} aria-hidden="true" />
              <span>{t('agentRuntime.provenance.resolutionError.retry')}</span>
            </button>
            {shouldShowResponseEscape && (
              <button type="button" className={styles.responseEscape} onClick={useResponse}>
                <MessageSquare size={14} aria-hidden="true" />
                <span>{t('agentRuntime.useResponse')}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {!canShowSelector && !shouldShowRepair && (
        <div className={styles.fallbackRow}>
          <div className={styles.noDowngrade} role="note">
            <ShieldAlert size={15} aria-hidden="true" />
            <span>{t('agentRuntime.noSilentDowngrade')}</span>
          </div>
          {shouldShowResponseEscape && (
            <button type="button" className={styles.responseEscape} onClick={useResponse}>
              <MessageSquare size={14} aria-hidden="true" />
              <span>{t('agentRuntime.useResponse')}</span>
            </button>
          )}
        </div>
      )}

      <details className={styles.provenanceDisclosure}>
        <summary className={styles.provenanceSummary}>
          <span className={styles.provenanceSummaryLabel}>
            <Info size={14} aria-hidden="true" />
            <span>{t('agentRuntime.provenance.details')}</span>
          </span>
          <span className={styles.provenanceSummaryMode}>
            {t('agentRuntime.provenance.summary', { mode: modeLabel[effectiveMode] })}
          </span>
          <ChevronDown className={styles.provenanceChevron} size={14} aria-hidden="true" />
        </summary>
        <div className={styles.provenancePanel}>
          <dl className={styles.provenance} aria-label={t('agentRuntime.provenance.label')}>
            <div><dt>{t('agentRuntime.provenance.requested')}</dt><dd>{modeLabel[requestedMode]}</dd></div>
            <div><dt>{t('agentRuntime.provenance.authored')}</dt><dd>{modeLabel[authoredMode]}</dd></div>
            <div><dt>{t('agentRuntime.provenance.effective')}</dt><dd>{modeLabel[effectiveMode]}</dd></div>
            <div><dt>{t('agentRuntime.provenance.source')}</dt><dd>{sourceValue}</dd></div>
            <div><dt>{t('agentRuntime.provenance.scope')}</dt><dd>{scopeValue}</dd></div>
            <div><dt>{t('agentRuntime.provenance.capAuthority')}</dt><dd>{authorityValue}</dd></div>
            <div><dt>{t('agentRuntime.provenance.capAllowedModes')}</dt><dd>{capAllowedModesValue}</dd></div>
            <div><dt>{t('agentRuntime.provenance.capReasonCode')}</dt><dd>{capReasonCodeValue}</dd></div>
            <div><dt>{t('agentRuntime.provenance.availability')}</dt><dd>{availabilityValue}</dd></div>
            <div><dt>{t('agentRuntime.provenance.availabilityReasonCode')}</dt><dd>{availabilityReasonCodeValue}</dd></div>
            <div><dt>{t('agentRuntime.provenance.capability')}</dt><dd>{capabilityValue}</dd></div>
            <div><dt>{t('agentRuntime.provenance.repairAcknowledgement')}</dt><dd>{acknowledgementStateValue}</dd></div>
            <div><dt>{t('agentRuntime.provenance.repairAcknowledgementReasonCode')}</dt><dd>{acknowledgementReasonCodeValue}</dd></div>
          </dl>
          {inspection && (
            <section className={styles.loomInspection} aria-labelledby={inspectionTitleId}>
              <header className={styles.loomInspectionHeader}>
                <div>
                  <h3 id={inspectionTitleId}>{t('agentRuntime.provenance.loomInspection.title')}</h3>
                  <p>{t('agentRuntime.provenance.loomInspection.summary', { count: inspection.items.length })}</p>
                </div>
                <dl className={styles.loomInspectionMeta}>
                  <div><dt>{t('agentRuntime.provenance.loomInspection.surface')}</dt><dd><code>{inspection.surface}</code></dd></div>
                  <div><dt>{t('agentRuntime.provenance.loomInspection.checkpoint')}</dt><dd><code>{inspection.checkpoint}</code></dd></div>
                </dl>
              </header>
              <p className={styles.loomInspectionEmpty}>
                {t('agentRuntime.provenance.loomInspection.ar007.nativeBoundary')}
              </p>
              <p className={styles.loomInspectionEmpty}>
                {t('agentRuntime.provenance.loomInspection.ar007.fixedRoutes')}
              </p>
              <div className={styles.loomEffectiveOrder}>
                <span>{t('agentRuntime.provenance.loomInspection.effectiveOrder')}</span>
                {inspection.effectiveEntryIds.length > 0
                  ? <code>{inspection.effectiveEntryIds.join(' → ')}</code>
                  : <span>{noneValue}</span>}
              </div>
              {inspection.items.length === 0
                ? <p className={styles.loomInspectionEmpty}>{t('agentRuntime.provenance.loomInspection.empty')}</p>
                : (
                    <ol className={styles.loomInspectionList}>
                      {inspection.items.map((item, index) => {
                        const outcomeReason = 'reason' in item.outcome ? item.outcome.reason : null
                        const repairRequired = outcomeReason === 'stale_source'
                          || outcomeReason === 'invalid_source'
                          || outcomeReason === 'required_source_unavailable'
                          || item.conditionResult === 'invalid'
                        return (
                          <li key={item.entryId} className={styles.loomInspectionItem}>
                            <div className={styles.loomInspectionItemHeader}>
                              <span>{t('agentRuntime.provenance.loomInspection.position', { position: index + 1 })}</span>
                              <code>{item.entryId}</code>
                            </div>
                            <dl className={styles.loomInspectionFields}>
                              <div>
                                <dt>{t('agentRuntime.provenance.loomInspection.source')}</dt>
                                <dd><code>{`${item.source.blockId}@${item.source.blockRevision} · preset:${item.source.presetRevision} · order:${item.source.promptOrder}`}</code></dd>
                              </div>
                              <div>
                                <dt>{t('agentRuntime.provenance.loomInspection.ar007.fixedRole')}</dt>
                                <dd><code>{t(`ownerInspection.values.${item.bucket}`, { defaultValue: item.bucket })}</code></dd>
                              </div>
                              <div>
                                <dt>{t('agentRuntime.provenance.loomInspection.route')}</dt>
                                <dd><code>{`${item.bucket} → ${item.destination} @ ${item.checkpoint}`}</code></dd>
                              </div>
                              <div>
                                <dt>{t('agentRuntime.provenance.loomInspection.condition')}</dt>
                                <dd><code>{item.condition === undefined ? t('agentRuntime.provenance.loomInspection.ar007.conditionNotApplicable') : JSON.stringify(item.condition)}</code></dd>
                              </div>
                              <div>
                                <dt>{t('agentRuntime.provenance.loomInspection.conditionResult')}</dt>
                                <dd><code>{item.conditionResult ?? t('agentRuntime.provenance.loomInspection.ar007.conditionNotApplicable')}</code></dd>
                              </div>
                              <div><dt>{t('agentRuntime.provenance.loomInspection.required')}</dt><dd><code>{item.required ? t('agentRuntime.provenance.loomInspection.ar007.booleanTrue') : t('agentRuntime.provenance.loomInspection.ar007.booleanFalse')}</code></dd></div>
                              <div><dt>{t('agentRuntime.provenance.loomInspection.ordinarySuppressed')}</dt><dd><code>{item.ordinaryPromptSuppressed ? t('agentRuntime.provenance.loomInspection.ar007.booleanTrue') : t('agentRuntime.provenance.loomInspection.ar007.booleanFalse')}</code></dd></div>
                              <div><dt>{t('agentRuntime.provenance.loomInspection.outcome')}</dt><dd><code>{loomOutcomeValue(item, t)}</code></dd></div>
                              <div>
                                <dt>{t('ownerInspection.reason')}</dt>
                                <dd><code>{'reason' in item.outcome ? t(`ownerInspection.values.${item.outcome.reason}`, { defaultValue: item.outcome.reason }) : noneValue}</code></dd>
                              </div>
                              {item.outcome.status === 'deduplicated' ? (
                                <>
                                  <div><dt>{t('agentRuntime.provenance.loomInspection.ar007.dedupeRetainedEntry')}</dt><dd><code>{item.outcome.keptEntryId}</code></dd></div>
                                  <div><dt>{t('agentRuntime.provenance.loomInspection.ar007.dedupeRetainedDestination')}</dt><dd><code>{item.outcome.destination}</code></dd></div>
                                </>
                              ) : null}
                            </dl>
                            {repairRequired ? (
                              <div className={styles.loomOmission} role="alert">
                                <strong>{t('agentRuntime.provenance.loomInspection.ar007.repairRequired')}</strong>
                                <span>{t('agentRuntime.provenance.loomInspection.ar007.repairDetail')}</span>
                              </div>
                            ) : null}
                          </li>
                        )
                      })}
                    </ol>
                  )}
              {responseOmission && (
                <div className={styles.loomOmission} role="note">
                  <strong>{t('agentRuntime.provenance.loomInspection.responseOmission')}</strong>
                  <span>{t('agentRuntime.provenance.loomInspection.omissionCount', {
                    entryCount: responseOmission.omittedEntryIds.length,
                    phaseCount: responseOmission.omittedPhaseInstructions.length,
                  })}</span>
                  <span>
                    {t('agentRuntime.provenance.loomInspection.ar007.responseKeepsNative', { reason: responseOmission.reason })}
                  </span>
                  <dl className={styles.loomInspectionFields}>
                    <div>
                      <dt>{t('agentRuntime.provenance.loomInspection.ar007.omittedEntryIds')}</dt>
                      <dd><code>{responseOmission.omittedEntryIds.join(' · ') || noneValue}</code></dd>
                    </div>
                    <div>
                      <dt>{t('agentRuntime.provenance.loomInspection.ar007.exactSources')}</dt>
                      <dd><code>{responseOmission.source.map((source) => `${source.blockId}@${source.blockRevision}/preset:${source.presetRevision}/order:${source.promptOrder}`).join(' · ') || noneValue}</code></dd>
                    </div>
                  </dl>
                  {responseOmission.omittedPhaseInstructions.length > 0 ? (
                    <ol className={styles.loomInspectionList}>
                      {responseOmission.omittedPhaseInstructions.map(({ phaseId, source }) => (
                        <li
                          key={`${phaseId}:${source.blockId}:${source.presetRevision}:${source.blockRevision}:${source.promptOrder}`}
                          className={styles.loomInspectionItem}
                        >
                          <div className={styles.loomInspectionItemHeader}>
                          
                            <span>{t('agentRuntime.provenance.loomInspection.ar007.customPhase')}</span>
                          </div>
                          <dl className={styles.loomInspectionFields}>
                            <div><dt>{t('agentRuntime.provenance.loomInspection.ar007.exactBlock')}</dt><dd><code>{source.blockId}</code></dd></div>
                            <div><dt>{t('agentRuntime.provenance.loomInspection.ar007.presetRevision')}</dt><dd><code>{source.presetRevision}</code></dd></div>
                            <div><dt>{t('agentRuntime.provenance.loomInspection.ar007.blockRevision')}</dt><dd><code>{source.blockRevision}</code></dd></div>
                            <div><dt>{t('agentRuntime.provenance.loomInspection.ar007.sourcePromptOrder')}</dt><dd><code>{source.promptOrder}</code></dd></div>
                          </dl>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </div>
              )}
              {inspection.surface === 'WORK' ? (
                <p className={styles.loomInspectionEmpty}>
                  {t('agentRuntime.provenance.loomInspection.ar007.structuredCustomPhase')}
                </p>
              ) : null}
            </section>
          )}
        </div>
      </details>

      <span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
        {overrideScopeChanged ? '' : announcement}
      </span>
    </section>
  )
}
