import { useCallback, useMemo } from 'react'
import { Brain } from 'lucide-react'
import { IconBolt } from '@tabler/icons-react'
import { useStore } from '@/store'
import {
  areReasoningSettingsEqual,
  getEffortOptions,
  getReasoningBindingSummary,
  normalizeReasoningSettingsForProvider,
  TOGGLE_ONLY_PROVIDERS,
} from '@/lib/reasoning-binding'
import CollapsibleSection from '@/components/shared/CollapsibleSection'
import NumericInput from '@/components/shared/NumericInput'
import { Toggle } from '@/components/shared/Toggle'
import type { ReasoningSettings, ReasoningEffort, ThinkingDisplay } from '@/types/store'
import styles from './PresetManager.module.css'
import clsx from 'clsx'

const REASONING_PRESETS: { label: string; prefix: string; suffix: string }[] = [
  { label: 'DeepSeek', prefix: '<think>\n', suffix: '\n</think>' },
  { label: 'Claude', prefix: '<thinking>\n', suffix: '\n</thinking>' },
  { label: 'o1', prefix: '<reasoning>\n', suffix: '\n</reasoning>' },
]

export default function PresetManager() {
  const reasoningSettings = useStore((s) => s.reasoningSettings)
  const promptBias = useStore((s) => s.promptBias)
  const setSetting = useStore((s) => s.setSetting)

  // Derive provider from active connection profile
  const activeProfileId = useStore((s) => s.activeProfileId)
  const profiles = useStore((s) => s.profiles)
  const activeProfile = useMemo(() => {
    if (!activeProfileId) return undefined
    return profiles.find((p) => p.id === activeProfileId)
  }, [activeProfileId, profiles])
  const activeProvider = activeProfile?.provider
  const activeModel = activeProfile?.model
  const activeBinding = activeProfile?.metadata?.reasoningBindings?.settings
  const normalizedActiveBinding = activeBinding
    ? normalizeReasoningSettingsForProvider(activeBinding, activeProvider, activeModel)
    : null

  const isToggleOnly = activeProvider ? TOGGLE_ONLY_PROVIDERS.has(activeProvider) : false
  const isApiReasoningDisabled = !reasoningSettings.apiReasoning
  const effortOptions = getEffortOptions(activeProvider, activeModel)
  const isAnthropic = activeProvider === 'anthropic'
  const activeBindingMatchesPanel = normalizedActiveBinding
    ? areReasoningSettingsEqual(normalizedActiveBinding, reasoningSettings)
    : false

  const updateReasoning = useCallback(
    (partial: Partial<ReasoningSettings>) => {
      const next = normalizeReasoningSettingsForProvider(
        { ...reasoningSettings, ...partial },
        activeProvider,
        activeModel,
      )
      setSetting('reasoningSettings', next)
    },
    [activeModel, activeProvider, reasoningSettings, setSetting]
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
        {normalizedActiveBinding && (
          <div className={styles.bindingBanner}>
            <div className={styles.bindingBannerTitle}>Saved on {activeProfile?.name}</div>
            <div className={styles.bindingBannerText}>
              {getReasoningBindingSummary(normalizedActiveBinding)}
            </div>
            {!activeBindingMatchesPanel && (
              <div className={styles.bindingBannerHint}>
                The panel has been changed locally. Edit the connection and use Capture Current to update the saved snapshot.
              </div>
            )}
          </div>
        )}
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
        <div className={clsx(styles.fieldGroup, (isToggleOnly || isApiReasoningDisabled) && styles.fieldGroupDisabled)}>
          <span className={styles.label}>
            Reasoning Effort
            {isToggleOnly && <span className={styles.toggleOnlyHint}> (toggle-only for {activeProvider})</span>}
            {!isToggleOnly && isApiReasoningDisabled && <span className={styles.toggleOnlyHint}> (disabled while API reasoning is off)</span>}
          </span>
          <select
            className={clsx(styles.select, (isToggleOnly || isApiReasoningDisabled) && styles.selectDisabled)}
            value={reasoningSettings.reasoningEffort}
            onChange={(e) => updateReasoning({ reasoningEffort: e.target.value as ReasoningEffort })}
            disabled={isToggleOnly || isApiReasoningDisabled}
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

        {/* Anthropic-only: thinking.display field on the Messages API */}
        {isAnthropic && (
          <div className={clsx(styles.fieldGroup, isApiReasoningDisabled && styles.fieldGroupDisabled)}>
            <span className={styles.label}>Thinking Display</span>
            <select
              className={clsx(styles.select, isApiReasoningDisabled && styles.selectDisabled)}
              value={reasoningSettings.thinkingDisplay ?? 'auto'}
              onChange={(e) => updateReasoning({ thinkingDisplay: e.target.value as ThinkingDisplay })}
              disabled={isApiReasoningDisabled}
            >
              <option value="auto">Auto (model default)</option>
              <option value="summarized">Summarized</option>
              <option value="omitted">Omitted</option>
            </select>
            <span className={styles.toggleDesc}>
              {isApiReasoningDisabled
                ? 'Only sent when API reasoning is enabled.'
                : 'Opus 4.7 and Mythos Preview default to Omitted. Pick Summarized to receive summary text.'}
            </span>
          </div>
        )}

        {/* Keep N reasoning blocks in history */}
        <div className={styles.fieldGroup}>
          <span className={styles.label}>Keep in history</span>
          <div className={styles.historyRow}>
            <NumericInput
              className={styles.input}
              min={-1}
              value={reasoningSettings.keepInHistory}
              integer
              onChange={(value) => updateReasoning({ keepInHistory: value ?? reasoningSettings.keepInHistory })}
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
