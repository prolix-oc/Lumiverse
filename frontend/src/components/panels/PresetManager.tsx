import { useCallback, useMemo } from 'react'
import { Brain } from 'lucide-react'
import { IconBolt } from '@tabler/icons-react'
import { useStore } from '@/store'
import CollapsibleSection from '@/components/shared/CollapsibleSection'
import { Toggle } from '@/components/shared/Toggle'
import type { ReasoningSettings, ReasoningEffort } from '@/types/store'
import styles from './PresetManager.module.css'
import clsx from 'clsx'

const REASONING_PRESETS: { label: string; prefix: string; suffix: string }[] = [
  { label: 'DeepSeek', prefix: '<think>\n', suffix: '\n</think>' },
  { label: 'Claude', prefix: '<thinking>\n', suffix: '\n</thinking>' },
  { label: 'o1', prefix: '<reasoning>\n', suffix: '\n</reasoning>' },
]

// ── Provider-specific reasoning effort configurations ──

interface EffortOption { value: ReasoningEffort; label: string }

/** Providers where reasoning is toggle-only (enabled/disabled) with no effort granularity. */
const TOGGLE_ONLY_PROVIDERS = new Set(['moonshot', 'zai'])

const OPENROUTER_EFFORTS: EffortOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'none', label: 'None (disabled)' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
]

const GOOGLE_EFFORTS: EffortOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

const ANTHROPIC_EFFORTS: EffortOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
]

const NANOGPT_EFFORTS: EffortOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'none', label: 'None (disabled)' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

const GENERIC_EFFORTS: EffortOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
]

function getEffortOptions(provider: string | undefined): EffortOption[] {
  switch (provider) {
    case 'openrouter': return OPENROUTER_EFFORTS
    case 'google':
    case 'google_vertex': return GOOGLE_EFFORTS
    case 'anthropic': return ANTHROPIC_EFFORTS
    case 'nanogpt': return NANOGPT_EFFORTS
    default: return GENERIC_EFFORTS
  }
}

export default function PresetManager() {
  const reasoningSettings = useStore((s) => s.reasoningSettings)
  const promptBias = useStore((s) => s.promptBias)
  const setSetting = useStore((s) => s.setSetting)

  // Derive provider from active connection profile
  const activeProfileId = useStore((s) => s.activeProfileId)
  const profiles = useStore((s) => s.profiles)
  const activeProvider = useMemo(() => {
    if (!activeProfileId) return undefined
    return profiles.find((p) => p.id === activeProfileId)?.provider
  }, [activeProfileId, profiles])

  const isToggleOnly = activeProvider ? TOGGLE_ONLY_PROVIDERS.has(activeProvider) : false
  const effortOptions = getEffortOptions(activeProvider)

  const updateReasoning = useCallback(
    (partial: Partial<ReasoningSettings>) => {
      setSetting('reasoningSettings', { ...reasoningSettings, ...partial })
    },
    [reasoningSettings, setSetting]
  )

  const activePreset = REASONING_PRESETS.find(
    (p) => p.prefix === reasoningSettings.prefix && p.suffix === reasoningSettings.suffix
  )

  // If the current effort value isn't valid for this provider, show it but let the user pick a new one
  const currentEffortValid = effortOptions.some((o) => o.value === reasoningSettings.reasoningEffort)

  return (
    <div className={styles.panel}>
      {/* ── Reasoning / CoT ── */}
      <CollapsibleSection title="Reasoning / CoT" icon={<Brain size={14} />} defaultExpanded>
        {/* Quick preset buttons */}
        <div className={styles.presetRow}>
          {REASONING_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className={clsx(styles.presetBtn, activePreset?.label === p.label && styles.presetBtnActive)}
              onClick={() => updateReasoning({ prefix: p.prefix, suffix: p.suffix })}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Prefix / Suffix */}
        <div className={styles.tagRow}>
          <div className={styles.fieldGroup}>
            <span className={styles.label}>Prefix</span>
            <input
              className={styles.input}
              value={reasoningSettings.prefix}
              onChange={(e) => updateReasoning({ prefix: e.target.value })}
              placeholder="<think>\n"
            />
          </div>
          <div className={styles.fieldGroup}>
            <span className={styles.label}>Suffix</span>
            <input
              className={styles.input}
              value={reasoningSettings.suffix}
              onChange={(e) => updateReasoning({ suffix: e.target.value })}
              placeholder="\n</think>"
            />
          </div>
        </div>

        {/* Auto-parse thoughts toggle */}
        <div className={styles.toggleRow}>
          <div>
            <div className={styles.toggleLabel}>Auto-parse thoughts</div>
            <div className={styles.toggleDesc}>Strip thinking tags from displayed output</div>
          </div>
          <Toggle.Switch
            checked={reasoningSettings.autoParse}
            onChange={(v) => updateReasoning({ autoParse: v })}
          />
        </div>

        {/* API Reasoning toggle */}
        <div className={styles.toggleRow}>
          <div>
            <div className={styles.toggleLabel}>API Reasoning</div>
            <div className={styles.toggleDesc}>Request native reasoning from the provider, if available</div>
          </div>
          <Toggle.Switch
            checked={reasoningSettings.apiReasoning}
            onChange={(v) => updateReasoning({ apiReasoning: v })}
          />
        </div>

        {/* Reasoning effort */}
        <div className={styles.fieldGroup}>
          <span className={styles.label}>
            Reasoning Effort
            {isToggleOnly && <span className={styles.toggleOnlyHint}> (toggle-only for {activeProvider})</span>}
          </span>
          <select
            className={clsx(styles.select, isToggleOnly && styles.selectDisabled)}
            value={reasoningSettings.reasoningEffort}
            onChange={(e) => updateReasoning({ reasoningEffort: e.target.value as ReasoningEffort })}
            disabled={isToggleOnly}
          >
            {!currentEffortValid && (
              <option value={reasoningSettings.reasoningEffort}>
                {reasoningSettings.reasoningEffort} (unsupported by {activeProvider ?? 'provider'})
              </option>
            )}
            {effortOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Keep N reasoning blocks in history */}
        <div className={styles.fieldGroup}>
          <span className={styles.label}>Keep in history</span>
          <div className={styles.historyRow}>
            <input
              type="number"
              className={styles.input}
              min={-1}
              value={reasoningSettings.keepInHistory}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10)
                if (!Number.isNaN(v)) updateReasoning({ keepInHistory: v })
              }}
            />
            <span className={styles.historyHint}>
              {reasoningSettings.keepInHistory === -1
                ? 'Keep all reasoning in prompt'
                : reasoningSettings.keepInHistory === 0
                  ? 'Strip all reasoning from prompt'
                  : `Keep last ${reasoningSettings.keepInHistory} block${reasoningSettings.keepInHistory === 1 ? '' : 's'}`}
            </span>
          </div>
        </div>
      </CollapsibleSection>

      {/* ── Prompt Behavior ── */}
      <CollapsibleSection title="Prompt Behavior" icon={<IconBolt size={14} />} defaultExpanded>
        {/* Start Reply With */}
        <div className={styles.fieldGroup}>
          <span className={styles.label}>Start Reply With</span>
          <textarea
            className={styles.textarea}
            value={promptBias}
            onChange={(e) => setSetting('promptBias', e.target.value)}
            placeholder="Partial assistant message to prepend..."
            rows={2}
          />
          <div className={styles.quickBtnRow}>
            <button type="button" className={styles.quickBtn} onClick={() => setSetting('promptBias', '<think>\n')}>
              {'<think>\\n'}
            </button>
            <button type="button" className={styles.quickBtn} onClick={() => setSetting('promptBias', '<think>')}>
              {'<think>'}
            </button>
            <button type="button" className={styles.quickBtn} onClick={() => setSetting('promptBias', '<thinking>')}>
              {'<thinking>'}
            </button>
            <button
              type="button"
              className={clsx(styles.quickBtn, styles.clearBtn)}
              onClick={() => setSetting('promptBias', '')}
            >
              Clear
            </button>
          </div>
        </div>

      </CollapsibleSection>
    </div>
  )
}
