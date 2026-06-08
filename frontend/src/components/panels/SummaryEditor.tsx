import { useState, useCallback, useEffect, type ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import {
  FileText, Check, AlertCircle, Trash2, Save, RefreshCw,
  Settings, Clock, Cloud, ChevronDown, Play, Scissors, Link2,
  Sparkles, RotateCcw, Hammer,
} from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import clsx from 'clsx'
import { useSummary } from '@/hooks/useSummary'
import NumberStepper from '@/components/shared/NumberStepper'
import { Toggle } from '@/components/shared/Toggle'
import { Badge } from '@/components/shared/Badge'
import { Button } from '@/components/shared/FormComponents'
import ConnectionSelect from '@/components/shared/ConnectionSelect'
import { Spinner } from '@/components/shared/Spinner'
import { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import {
  loadSummarizationDefaults,
} from '@/lib/summary/service'
import {
  FALLBACK_SUMMARIZATION_SYSTEM_PROMPT,
  FALLBACK_SUMMARIZATION_USER_PROMPT,
  SYSTEM_PROMPT_PLACEHOLDERS,
  USER_PROMPT_PLACEHOLDERS,
} from '@/lib/summary/prompts'
import { DEFAULT_SUMMARY_REQUEST_TIMEOUT_MS, type SummaryMode, type SummaryApiSource } from '@/lib/summary/types'
import { messagesApi } from '@/api/chats'
import { useStore } from '@/store'
import type { SummaryOperation } from '@/types/store'
import styles from './SummaryEditor.module.css'

// ─── Shared sub-components ────────────────────────────────────────

interface SectionProps {
  icon: ReactNode
  title: string
  children: ReactNode
  defaultOpen?: boolean
  status?: boolean
}

function Section({ icon, title, children, defaultOpen = false, status }: SectionProps) {
  const { t } = useTranslation('panels')
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={styles.section}>
      <button type="button" className={styles.sectionHeader} onClick={() => setOpen(!open)}>
        <span className={clsx(styles.chevron, open && styles.chevronOpen)}>
          <ChevronDown size={14} />
        </span>
        <span className={styles.sectionIcon}>{icon}</span>
        <span className={styles.sectionTitle}>{title}</span>
        {status !== undefined && (
          <Badge color={status ? 'primary' : 'neutral'} size="pill">
            {status ? t('summaryEditor.active') : t('summaryEditor.off')}
          </Badge>
        )}
      </button>
      {open && <div className={styles.sectionBody}>{children}</div>}
    </div>
  )
}

function RadioOption({ name, value, checked, onChange, label }: {
  name: string; value: string; checked: boolean; onChange: (v: string) => void; label: string
}) {
  return (
    <label className={clsx(styles.radioOption, checked && styles.radioSelected)}>
      <input type="radio" name={name} value={value} checked={checked} onChange={() => onChange(value)} />
      <span>{label}</span>
    </label>
  )
}

function NumberField({ label, hint, value, onChange, min, max, step = 1 }: {
  id?: string; label: string; hint?: string; value: number
  onChange: (v: number) => void; min?: number; max?: number; step?: number
}) {
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel}>{label}</label>
      <NumberStepper
        value={value}
        onChange={(v) => onChange(v ?? 0)}
        min={min}
        max={max}
        step={step}
      />
      {hint && <span className={styles.fieldHint}>{hint}</span>}
    </div>
  )
}

// ─── Summary Text Editor ──────────────────────────────────────────

function SummaryTextEditor() {
  const { t } = useTranslation('panels')
  const {
    summaryText, originalText, hasChat, hasChanges,
    isLoading, error,
    setSummaryText, generate, save, clear, loadSummary,
    rebuildProgress,
    rebuild,
  } = useSummary()

  const activeChatId = useStore((s) => s.activeChatId)
  const summarization = useStore((s) => s.summarization)
  const activeOperation = useStore((s) => s.activeSummaryOperation)

  const [isSaving, setIsSaving] = useState(false)
  const [showClearModal, setShowClearModal] = useState(false)
  const [showRebuildModal, setShowRebuildModal] = useState(false)
  const [rebuildInfo, setRebuildInfo] = useState<{ totalMessages: number; batchCount: number } | null>(null)

  const isGenerating = activeOperation === 'generating'
  const isRebuilding = activeOperation === 'rebuilding'

  const handleGenerate = useCallback(async () => {
    if (!hasChat || isLoading) return
    try {
      await generate(true)
    } catch {
      // error handled in hook
    }
  }, [hasChat, isLoading, generate])

  const handleSave = useCallback(async () => {
    setIsSaving(true)
    try {
      await save()
      setTimeout(() => setIsSaving(false), 1200)
    } catch {
      setIsSaving(false)
    }
  }, [save])

  const handleClearConfirm = useCallback(async () => {
    setShowClearModal(false)
    await clear()
  }, [clear])

  const handleRebuildConfirm = useCallback(async () => {
    setShowRebuildModal(false)
    if (!rebuildInfo) return
    await rebuild()
  }, [rebuild, rebuildInfo])

  const openRebuildModal = useCallback(async () => {
    if (!hasChat || isLoading) return
    // Get total message count for the confirmation dialog
    let totalMessages = 0
    try {
      const msgPage = await messagesApi.list(activeChatId, { limit: 1 })
      totalMessages = msgPage.total
    } catch {
      totalMessages = 0
    }
    const manualContext = summarization.manualMessageContext || 10
    const batchCount = Math.ceil(totalMessages / manualContext)
    setRebuildInfo({ totalMessages, batchCount })
    setShowRebuildModal(true)
  }, [hasChat, isLoading, activeChatId, summarization.manualMessageContext])

  return (
    <Section icon={<FileText size={16} />} title={t('summaryEditor.summaryText')} defaultOpen>
      {/* Status */}
      {!hasChat ? (
        <div className={clsx(styles.status, styles.statusNoChat)}>
          <AlertCircle size={14} />
          <span>{t('summaryEditor.noActiveChat')}</span>
        </div>
      ) : originalText ? (
        <div className={clsx(styles.status, styles.statusExists)}>
          <Check size={14} />
          <span>{t('summaryEditor.summaryExists')}</span>
        </div>
      ) : (
        <div className={clsx(styles.status, styles.statusEmpty)}>
          <AlertCircle size={14} />
          <span>{t('summaryEditor.noSummaryYet')}</span>
        </div>
      )}

      {/* Textarea */}
      <textarea
        className={styles.textarea}
        value={summaryText}
        onChange={(e) => setSummaryText(e.target.value)}
        placeholder={PLACEHOLDER_TEXT}
        disabled={!hasChat}
      />

      {/* Actions */}
      <div className={styles.actions}>
        <Button
          size="icon" variant="primary"
          onClick={handleGenerate}
          disabled={!hasChat || isRebuilding}
          title={isGenerating ? t('summaryEditor.generating') : isRebuilding ? t('summaryEditor.rebuildInProgress') : t('summaryEditor.generate')}
          icon={isGenerating ? <Spinner size={14} fast /> : <Play size={14} />}
        />
        <Button
          size="icon" variant="ghost"
          onClick={loadSummary}
          disabled={!hasChat}
          title={t('actions.refresh', { ns: 'common' })}
          icon={<RefreshCw size={14} />}
        />
        <Button
          size="icon" variant="danger-ghost"
          onClick={() => setShowClearModal(true)}
          disabled={!hasChat || !originalText || isGenerating || isRebuilding}
          title={t('actions.clear', { ns: 'common' })}
          icon={<Trash2 size={14} />}
        />
        <Button
          size="icon" variant="primary"
          onClick={handleSave}
          disabled={!hasChat || !hasChanges || isGenerating || isRebuilding}
          title={isSaving ? t('summaryEditor.saved') : t('summaryEditor.save')}
          icon={isSaving ? <Check size={14} /> : <Save size={14} />}
        />
        {/* Rebuild button */}
        <Button
          size="icon" variant="secondary"
          onClick={openRebuildModal}
          disabled={!hasChat || isGenerating}
          title={isRebuilding ? t('summaryEditor.rebuilding') : t('summaryEditor.rebuildFromScratch')}
          icon={isRebuilding ? <Spinner size={14} fast /> : <Hammer size={14} />}
        />
      </div>

      {/* Rebuild progress — shows immediately with batch count from store */}
      {rebuildProgress && rebuildProgress.totalBatches > 0 && (
        <motion.div
          className={styles.rebuildProgress}
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 5 }}
        >
          <Spinner size={12} fast />
          <span>
            {t('summaryEditor.rebuildBatchProgress', {
              current: rebuildProgress.batchNumber + 1,
              total: rebuildProgress.totalBatches,
            })}
          </span>
        </motion.div>
      )}

      {/* Clear confirmation modal */}
      <ConfirmationModal
        isOpen={showClearModal}
        onConfirm={handleClearConfirm}
        onCancel={() => setShowClearModal(false)}
        title={t('summaryEditor.clearModalTitle')}
        message={t('summaryEditor.clearConfirm')}
        variant="danger"
        confirmText={t('actions.clear', { ns: 'common' })}
      />

      {/* Rebuild confirmation modal */}
      <ConfirmationModal
        isOpen={showRebuildModal}
        onConfirm={handleRebuildConfirm}
        onCancel={() => setShowRebuildModal(false)}
        title={t('summaryEditor.rebuildModalTitle')}
        message={rebuildInfo
          ? (
            <Trans
              ns="panels"
              i18nKey="summaryEditor.rebuildModalMessage"
              values={{ totalMessages: rebuildInfo.totalMessages, batchCount: rebuildInfo.batchCount }}
              components={{ strong: <strong /> }}
            />
          )
          : t('summaryEditor.rebuildModalLoading')}
        variant="warning"
        confirmText={t('summaryEditor.rebuildConfirm')}
      />

      {/* Unsaved changes */}
      <AnimatePresence>
        {hasChanges && (
          <motion.div
            className={styles.unsaved}
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 5 }}
          >
            {t('summaryEditor.unsavedChanges')}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error */}
      {error && <div className={styles.errorBox}>{error}</div>}
    </Section>
  )
}

// ─── Summarization Config ─────────────────────────────────────────

function SummarizationConfig() {
  const { t } = useTranslation('panels')
  const { summarization, setSummarization, profiles } = useSummary()

  const mode = summarization.mode
  const apiSource = summarization.apiSource
  const updateRequestTimeoutMs = useCallback((value: number) => {
    const next = Number.isFinite(value) ? value : DEFAULT_SUMMARY_REQUEST_TIMEOUT_MS
    setSummarization({ requestTimeoutMs: Math.max(5_000, Math.round(next)) })
  }, [setSummarization])

  return (
    <div className={styles.editor}>
      {/* Mode */}
      <Section icon={<Settings size={16} />} title={t('summaryEditor.summarizationMode')} status={mode !== 'disabled'} defaultOpen>
        <div className={styles.radioGroup}>
          <RadioOption name="sum-mode" value="disabled" checked={mode === 'disabled'} onChange={(v) => setSummarization({ mode: v as SummaryMode })} label={t('summaryEditor.disabled')} />
          <RadioOption name="sum-mode" value="auto" checked={mode === 'auto'} onChange={(v) => setSummarization({ mode: v as SummaryMode })} label={t('summaryEditor.automatic')} />
          <RadioOption name="sum-mode" value="manual" checked={mode === 'manual'} onChange={(v) => setSummarization({ mode: v as SummaryMode })} label={t('summaryEditor.manual')} />
        </div>
        <p className={styles.desc}>
          {mode === 'disabled' && t('summaryEditor.modeDisabledHint')}
          {mode === 'auto' && t('summaryEditor.modeAutoHint')}
          {mode === 'manual' && t('summaryEditor.modeManualHint')}
        </p>
      </Section>

      {/* Auto Settings */}
      {mode === 'auto' && (
        <Section icon={<Clock size={16} />} title={t('summaryEditor.autoSettings')} defaultOpen>
          <div className={styles.fieldRow}>
            <NumberField
              id="sum-interval" label={t('summaryEditor.interval')} hint={t('summaryEditor.everyNMessages')}
              value={summarization.autoInterval}
              onChange={(v) => setSummarization({ autoInterval: v })}
              min={1}
            />
            <NumberField
              id="sum-auto-ctx" label={t('summaryEditor.context')} hint={t('summaryEditor.messagesToInclude')}
              value={summarization.autoMessageContext}
              onChange={(v) => setSummarization({ autoMessageContext: v })}
              min={1} max={100}
            />
          </div>
        </Section>
      )}

      {/* Manual Context */}
      {(mode === 'manual' || mode === 'auto') && (
        <Section icon={<FileText size={16} />} title={t('summaryEditor.manualContext')} defaultOpen={mode === 'manual'}>
          <NumberField
            id="sum-manual-ctx" label={t('summaryEditor.messagesToInclude')} hint={t('summaryEditor.whenGeneratingManually')}
            value={summarization.manualMessageContext}
            onChange={(v) => setSummarization({ manualMessageContext: v })}
            min={1} max={100}
          />
        </Section>
      )}

      {/* API Source */}
      {mode !== 'disabled' && (
        <Section icon={<Cloud size={16} />} title={t('summaryEditor.apiSource')}>
          <div className={styles.radioGroup}>
            <RadioOption
              name="sum-source" value="sidecar"
              checked={apiSource === 'sidecar'}
              onChange={(v) => setSummarization({ apiSource: v as SummaryApiSource })}
              label={t('summaryEditor.sidecarConnection')}
            />
            <RadioOption
              name="sum-source" value="active"
              checked={apiSource === 'active'}
              onChange={(v) => setSummarization({ apiSource: v as SummaryApiSource })}
              label={t('summaryEditor.activeConnection')}
            />
            <RadioOption
              name="sum-source" value="dedicated"
              checked={apiSource === 'dedicated'}
              onChange={(v) => setSummarization({ apiSource: v as SummaryApiSource })}
              label={t('summaryEditor.dedicatedConnection')}
            />
          </div>
          <p className={styles.desc}>
            {apiSource === 'sidecar'
              ? t('summaryEditor.sidecarHint')
              : apiSource === 'active'
                ? t('summaryEditor.activeConnectionHint')
                : t('summaryEditor.dedicatedConnectionHint')}
          </p>
        </Section>
      )}

      {/* Dedicated Connection Picker */}
      {mode !== 'disabled' && apiSource === 'dedicated' && (
        <Section icon={<Link2 size={16} />} title={t('summaryEditor.dedicatedConnection')} defaultOpen>
          {profiles.length === 0 ? (
            <p className={styles.desc}>{t('summaryEditor.noConnectionProfiles')}</p>
          ) : (
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="sum-conn">{t('summaryEditor.connectionProfile')}</label>
              <ConnectionSelect
                kind="llm"
                value={summarization.dedicatedConnectionId || ''}
                onChange={(val) => setSummarization({ dedicatedConnectionId: val || null })}
                placeholder={t('summaryEditor.selectConnection')}
                searchPlaceholder={t('summaryEditor.searchConnections')}
                ariaLabel={t('summaryEditor.connectionProfile')}
                emptyMessage={t('summaryEditor.noConnectionProfiles')}
                clearable
                clearLabel={t('summaryEditor.noDedicatedConnection')}
              />
            </div>
          )}
        </Section>
      )}

      {/* Request Timeout */}
      {mode !== 'disabled' && (
        <Section icon={<Clock size={16} />} title={t('summaryEditor.requestTimeout')}>
          <NumberField
            id="sum-timeout" label={t('summaryEditor.timeout')} hint={t('summaryEditor.timeoutHint')}
            value={summarization.requestTimeoutMs}
            onChange={updateRequestTimeoutMs}
            min={5_000}
            step={30_000}
          />
          <p className={styles.desc}>{t('summaryEditor.defaultTimeout', { value: DEFAULT_SUMMARY_REQUEST_TIMEOUT_MS })}</p>
        </Section>
      )}

      {/* Message Limit — trim chat history to N most recent messages during generation */}
      <Section icon={<Scissors size={16} />} title={t('summaryEditor.messageLimit')} status={summarization.messageLimitEnabled}>
        <div className={styles.toggleRow}>
          <Toggle.Switch
            checked={summarization.messageLimitEnabled}
            onChange={(v) => setSummarization({ messageLimitEnabled: v })}
            size="sm"
          />
          <span className={styles.toggleLabel}>{t('summaryEditor.limitMessages')}</span>
        </div>
        {summarization.messageLimitEnabled && (
          <>
            <NumberField
              label={t('summaryEditor.messageCount')}
              hint={t('summaryEditor.messageCountHint')}
              value={summarization.messageLimitCount}
              onChange={(v) => setSummarization({ messageLimitCount: v })}
              min={1}
              max={500}
            />
            <p className={styles.desc}>
              {summarization.mode !== 'disabled'
                ? t('summaryEditor.trimmedWithSummary')
                : t('summaryEditor.trimmedWithoutSummary')}
            </p>
          </>
        )}
      </Section>
    </div>
  )
}

// ─── Prompt Template Editor ───────────────────────────────────────

function PromptTemplateConfig() {
  const { t } = useTranslation('panels')
  const { summarization, setSummarization } = useSummary()

  const [defaults, setDefaults] = useState<{ systemPrompt: string; userPrompt: string }>({
    systemPrompt: FALLBACK_SUMMARIZATION_SYSTEM_PROMPT,
    userPrompt: FALLBACK_SUMMARIZATION_USER_PROMPT,
  })

  // Load backend defaults once when the section mounts so the editor displays
  // the live server-side defaults (not just the bundled fallbacks). The loader
  // is cached per-session, so re-mounting the panel is free.
  useEffect(() => {
    let cancelled = false
    loadSummarizationDefaults().then((res) => {
      if (!cancelled) setDefaults(res)
    })
    return () => { cancelled = true }
  }, [])

  const systemCustomized = summarization.systemPromptOverride !== null
  const userCustomized = summarization.userPromptOverride !== null

  const systemValue = summarization.systemPromptOverride ?? defaults.systemPrompt
  const userValue = summarization.userPromptOverride ?? defaults.userPrompt

  const handleSystemChange = useCallback((val: string) => {
    // Persist overrides as-is. Treat an empty string the same as "no override"
    // so the backend default is used instead of sending an empty prompt.
    setSummarization({ systemPromptOverride: val.length > 0 ? val : null })
  }, [setSummarization])

  const handleUserChange = useCallback((val: string) => {
    setSummarization({ userPromptOverride: val.length > 0 ? val : null })
  }, [setSummarization])

  const resetSystem = useCallback(() => {
    setSummarization({ systemPromptOverride: null })
  }, [setSummarization])

  const resetUser = useCallback(() => {
    setSummarization({ userPromptOverride: null })
  }, [setSummarization])

  return (
    <Section
      icon={<Sparkles size={16} />}
      title={t('summaryEditor.promptTemplate')}
      status={systemCustomized || userCustomized}
    >
      <p className={styles.desc}>
        {t('summaryEditor.promptTemplateHint')}
      </p>

      {/* System prompt */}
      <div className={styles.promptBlock}>
        <div className={styles.promptBlockHeader}>
          <span className={styles.promptBlockLabel}>
            {t('summaryEditor.systemPrompt')}
            {systemCustomized && <Badge color="primary" size="pill">{t('summaryEditor.customized')}</Badge>}
          </span>
          <button
            type="button"
            className={styles.promptResetBtn}
            onClick={resetSystem}
            disabled={!systemCustomized}
            title={t('summaryEditor.restoreServerDefault')}
          >
            <RotateCcw size={11} /> {t('summaryEditor.reset')}
          </button>
        </div>
        <ExpandableTextarea
          className={styles.textarea}
          value={systemValue}
          onChange={handleSystemChange}
          title={t('summaryEditor.summarizationSystemPrompt')}
          rows={8}
          spellCheck={false}
        />
        <div className={styles.placeholderList}>
          {SYSTEM_PROMPT_PLACEHOLDERS.map((p) => (
            <code key={p.token} className={styles.placeholderChip} title={p.description}>
              {p.token}
            </code>
          ))}
        </div>
      </div>

      {/* User prompt */}
      <div className={styles.promptBlock}>
        <div className={styles.promptBlockHeader}>
          <span className={styles.promptBlockLabel}>
            {t('summaryEditor.userPrompt')}
            {userCustomized && <Badge color="primary" size="pill">{t('summaryEditor.customized')}</Badge>}
          </span>
          <button
            type="button"
            className={styles.promptResetBtn}
            onClick={resetUser}
            disabled={!userCustomized}
            title={t('summaryEditor.restoreServerDefault')}
          >
            <RotateCcw size={11} /> {t('summaryEditor.reset')}
          </button>
        </div>
        <ExpandableTextarea
          className={styles.textarea}
          value={userValue}
          onChange={handleUserChange}
          title={t('summaryEditor.summarizationUserPrompt')}
          rows={6}
          spellCheck={false}
        />
        <div className={styles.placeholderList}>
          {USER_PROMPT_PLACEHOLDERS.map((p) => (
            <code key={p.token} className={styles.placeholderChip} title={p.description}>
              {p.token}
            </code>
          ))}
        </div>
      </div>
    </Section>
  )
}

// ─── Main Export ──────────────────────────────────────────────────

export default function SummaryEditor() {
  const { t } = useTranslation('common')
  const { t: tc } = useTranslation('common')

  return (
    <div className={styles.editor}>
      <SummaryTextEditor />
      <SummarizationConfig />
      <PromptTemplateConfig />
    </div>
  )
}

// ─── Constants ────────────────────────────────────────────────────

const PLACEHOLDER_TEXT = `Write or paste your Loom summary here...

Use the structured format:
**Completed Objectives**
- ...

**Focused Objectives**
- ...

**Foreshadowing Beats**
- ...

**Character Developments**
- ...

**Memorable Actions**
- ...

**Memorable Dialogues**
- ...

**Relationships**
- ...`
