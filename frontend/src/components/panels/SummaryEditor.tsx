import { useState, useCallback, type ReactNode } from 'react'
import {
  FileText, Check, AlertCircle, Trash2, Save, RefreshCw,
  Settings, Clock, Cloud, ChevronDown, Play, Scissors, Link2,
} from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import clsx from 'clsx'
import { useSummary } from '@/hooks/useSummary'
import NumberStepper from '@/components/shared/NumberStepper'
import { Toggle } from '@/components/shared/Toggle'
import { Badge } from '@/components/shared/Badge'
import { Button } from '@/components/shared/FormComponents'
import { Spinner } from '@/components/shared/Spinner'
import type { SummaryMode, SummaryApiSource } from '@/lib/summary/types'
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
            {status ? 'Active' : 'Off'}
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
  const {
    summaryText, originalText, hasChat, hasChanges,
    isLoading, error,
    setSummaryText, generate, save, clear, loadSummary,
  } = useSummary()

  const [isSaving, setIsSaving] = useState(false)

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

  const handleClear = useCallback(async () => {
    if (!confirm('Clear the summary for this chat?')) return
    await clear()
  }, [clear])

  return (
    <Section icon={<FileText size={16} />} title="Summary Text" defaultOpen>
      {/* Status */}
      {!hasChat ? (
        <div className={clsx(styles.status, styles.statusNoChat)}>
          <AlertCircle size={14} />
          <span>No active chat</span>
        </div>
      ) : originalText ? (
        <div className={clsx(styles.status, styles.statusExists)}>
          <Check size={14} />
          <span>Summary exists for this chat</span>
        </div>
      ) : (
        <div className={clsx(styles.status, styles.statusEmpty)}>
          <AlertCircle size={14} />
          <span>No summary yet</span>
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
          disabled={!hasChat || isLoading}
          title={isLoading ? 'Generating...' : 'Generate'}
          icon={isLoading ? <Spinner size={14} fast /> : <Play size={14} />}
        />
        <Button
          size="icon" variant="ghost"
          onClick={loadSummary}
          disabled={!hasChat}
          title="Refresh"
          icon={<RefreshCw size={14} />}
        />
        <Button
          size="icon" variant="danger-ghost"
          onClick={handleClear}
          disabled={!hasChat || !originalText}
          title="Clear"
          icon={<Trash2 size={14} />}
        />
        <Button
          size="icon" variant="primary"
          onClick={handleSave}
          disabled={!hasChat || !hasChanges}
          title={isSaving ? 'Saved!' : 'Save'}
          icon={isSaving ? <Check size={14} /> : <Save size={14} />}
        />
      </div>

      {/* Unsaved changes */}
      <AnimatePresence>
        {hasChanges && (
          <motion.div
            className={styles.unsaved}
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 5 }}
          >
            You have unsaved changes
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
  const { summarization, setSummarization, profiles, activeProfileId } = useSummary()

  const mode = summarization.mode
  const apiSource = summarization.apiSource

  const connectionOptions = profiles.map((p) => ({
    value: p.id,
    label: `${p.name} (${p.provider})`,
  }))

  return (
    <div className={styles.editor}>
      {/* Mode */}
      <Section icon={<Settings size={16} />} title="Summarization Mode" status={mode !== 'disabled'} defaultOpen>
        <div className={styles.radioGroup}>
          <RadioOption name="sum-mode" value="disabled" checked={mode === 'disabled'} onChange={(v) => setSummarization({ mode: v as SummaryMode })} label="Disabled" />
          <RadioOption name="sum-mode" value="auto" checked={mode === 'auto'} onChange={(v) => setSummarization({ mode: v as SummaryMode })} label="Automatic" />
          <RadioOption name="sum-mode" value="manual" checked={mode === 'manual'} onChange={(v) => setSummarization({ mode: v as SummaryMode })} label="Manual" />
        </div>
        <p className={styles.desc}>
          {mode === 'disabled' && 'Summarization is turned off.'}
          {mode === 'auto' && 'Summaries are generated automatically at set intervals.'}
          {mode === 'manual' && 'Click the Generate button to create summaries on demand.'}
        </p>
      </Section>

      {/* Auto Settings */}
      {mode === 'auto' && (
        <Section icon={<Clock size={16} />} title="Auto Settings" defaultOpen>
          <div className={styles.fieldRow}>
            <NumberField
              id="sum-interval" label="Interval" hint="Every N messages"
              value={summarization.autoInterval}
              onChange={(v) => setSummarization({ autoInterval: v })}
              min={1}
            />
            <NumberField
              id="sum-auto-ctx" label="Context" hint="Messages to include"
              value={summarization.autoMessageContext}
              onChange={(v) => setSummarization({ autoMessageContext: v })}
              min={1} max={100}
            />
          </div>
        </Section>
      )}

      {/* Manual Context */}
      {(mode === 'manual' || mode === 'auto') && (
        <Section icon={<FileText size={16} />} title="Manual Context" defaultOpen={mode === 'manual'}>
          <NumberField
            id="sum-manual-ctx" label="Messages to include" hint="When generating manually"
            value={summarization.manualMessageContext}
            onChange={(v) => setSummarization({ manualMessageContext: v })}
            min={1} max={100}
          />
        </Section>
      )}

      {/* API Source */}
      {mode !== 'disabled' && (
        <Section icon={<Cloud size={16} />} title="API Source">
          <div className={styles.radioGroup}>
            <RadioOption
              name="sum-source" value="sidecar"
              checked={apiSource === 'sidecar'}
              onChange={(v) => setSummarization({ apiSource: v as SummaryApiSource })}
              label="Sidecar Connection"
            />
            <RadioOption
              name="sum-source" value="active"
              checked={apiSource === 'active'}
              onChange={(v) => setSummarization({ apiSource: v as SummaryApiSource })}
              label="Active Connection"
            />
            <RadioOption
              name="sum-source" value="dedicated"
              checked={apiSource === 'dedicated'}
              onChange={(v) => setSummarization({ apiSource: v as SummaryApiSource })}
              label="Dedicated Connection"
            />
          </div>
          <p className={styles.desc}>
            {apiSource === 'sidecar'
              ? 'Uses the shared Sidecar connection configured in your settings.'
              : apiSource === 'active'
                ? 'Uses whichever connection profile is currently active.'
                : 'Uses a specific connection profile for all summarization.'}
          </p>
        </Section>
      )}

      {/* Dedicated Connection Picker */}
      {mode !== 'disabled' && apiSource === 'dedicated' && (
        <Section icon={<Link2 size={16} />} title="Dedicated Connection" defaultOpen>
          {connectionOptions.length === 0 ? (
            <p className={styles.desc}>No connection profiles configured. Create one in the Connections panel.</p>
          ) : (
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="sum-conn">Connection Profile</label>
              <select
                id="sum-conn"
                className={styles.fieldSelect}
                value={summarization.dedicatedConnectionId || ''}
                onChange={(e) => setSummarization({ dedicatedConnectionId: e.target.value || null })}
              >
                <option value="">Select a connection...</option>
                {connectionOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          )}
        </Section>
      )}

      {/* Message Limit — trim chat history to N most recent messages during generation */}
      <Section icon={<Scissors size={16} />} title="Message Limit" status={summarization.messageLimitEnabled}>
        <div className={styles.toggleRow}>
          <Toggle.Switch
            checked={summarization.messageLimitEnabled}
            onChange={(v) => setSummarization({ messageLimitEnabled: v })}
            size="sm"
          />
          <span className={styles.toggleLabel}>Limit messages in context</span>
        </div>
        {summarization.messageLimitEnabled && (
          <>
            <NumberField
              label="Message count"
              hint="Keep the N most recent messages during generation"
              value={summarization.messageLimitCount}
              onChange={(v) => setSummarization({ messageLimitCount: v })}
              min={1}
              max={500}
            />
            <p className={styles.desc}>
              {summarization.mode !== 'disabled'
                ? 'Older messages will be trimmed from context. Use {{loomSummary}} in your preset to retain context from the summary.'
                : 'Older messages will be trimmed from context. Enable summarization to preserve context from older messages via the {{loomSummary}} macro.'}
            </p>
          </>
        )}
      </Section>
    </div>
  )
}

// ─── Main Export ──────────────────────────────────────────────────

export default function SummaryEditor() {
  return (
    <div className={styles.editor}>
      <SummaryTextEditor />
      <SummarizationConfig />
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
