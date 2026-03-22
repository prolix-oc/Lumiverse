import { useCallback } from 'react'
import { Brain, Zap } from 'lucide-react'
import { useStore } from '@/store'
import CollapsibleSection from '@/components/shared/CollapsibleSection'
import type { ReasoningSettings } from '@/types/store'
import styles from './PresetManager.module.css'
import clsx from 'clsx'

const REASONING_PRESETS: { label: string; prefix: string; suffix: string }[] = [
  { label: 'DeepSeek', prefix: '<think>\n', suffix: '\n</think>' },
  { label: 'Claude', prefix: '<thinking>\n', suffix: '\n</thinking>' },
  { label: 'o1', prefix: '<reasoning>\n', suffix: '\n</reasoning>' },
]

const EFFORT_OPTIONS = ['auto', 'low', 'medium', 'high', 'max'] as const

export default function PresetManager() {
  const reasoningSettings = useStore((s) => s.reasoningSettings)
  const promptBias = useStore((s) => s.promptBias)
  const setSetting = useStore((s) => s.setSetting)

  const updateReasoning = useCallback(
    (partial: Partial<ReasoningSettings>) => {
      setSetting('reasoningSettings', { ...reasoningSettings, ...partial })
    },
    [reasoningSettings, setSetting]
  )

  const activePreset = REASONING_PRESETS.find(
    (p) => p.prefix === reasoningSettings.prefix && p.suffix === reasoningSettings.suffix
  )

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
          <button
            type="button"
            className={clsx(styles.toggle, reasoningSettings.autoParse && styles.toggleOn)}
            onClick={() => updateReasoning({ autoParse: !reasoningSettings.autoParse })}
          />
        </div>

        {/* API Reasoning toggle */}
        <div className={styles.toggleRow}>
          <div>
            <div className={styles.toggleLabel}>API Reasoning</div>
            <div className={styles.toggleDesc}>For o1, DeepSeek R1, Claude extended/adaptive thinking</div>
          </div>
          <button
            type="button"
            className={clsx(styles.toggle, reasoningSettings.apiReasoning && styles.toggleOn)}
            onClick={() => updateReasoning({ apiReasoning: !reasoningSettings.apiReasoning })}
          />
        </div>

        {/* Reasoning effort */}
        <div className={styles.fieldGroup}>
          <span className={styles.label}>Reasoning Effort</span>
          <select
            className={styles.select}
            value={reasoningSettings.reasoningEffort}
            onChange={(e) => updateReasoning({ reasoningEffort: e.target.value as ReasoningSettings['reasoningEffort'] })}
          >
            {EFFORT_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>{opt}{opt === 'max' ? ' (Opus 4.6 only)' : ''}</option>
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
      <CollapsibleSection title="Prompt Behavior" icon={<Zap size={14} />} defaultExpanded>
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
