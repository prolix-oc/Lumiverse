import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { useTranslation } from 'react-i18next'
import type { ReasoningSettings, ReasoningEffort, ThinkingDisplay } from '@/types/store'
import styles from './PresetManager.module.css'
import clsx from 'clsx'

const REASONING_PRESETS: { id: 'deepseek' | 'claude' | 'o1'; prefix: string; suffix: string }[] = [
  { id: 'deepseek', prefix: '<think>\n', suffix: '\n</think>' },
  { id: 'claude', prefix: '<thinking>\n', suffix: '\n</thinking>' },
  { id: 'o1', prefix: '<reasoning>\n', suffix: '\n</reasoning>' },
]

export default function PresetManager() {
  const { t } = useTranslation('panels')
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
  const activeBindingPromptBias = activeProfile?.metadata?.reasoningBindings?.promptBias
  const normalizedActiveBinding = activeBinding
    ? normalizeReasoningSettingsForProvider(activeBinding, activeProvider, activeModel)
    : null

  const isToggleOnly = activeProvider ? TOGGLE_ONLY_PROVIDERS.has(activeProvider) : false
  const isApiReasoningDisabled = !reasoningSettings.apiReasoning
  const effortOptions = getEffortOptions(activeProvider, activeModel)
  const isAnthropic = activeProvider === 'anthropic'
  const customBody = useMemo(
    () => reasoningSettings.customBody ?? { enabled: false, rawJson: '{}' },
    [reasoningSettings.customBody],
  )
  const [localCustomBodyJson, setLocalCustomBodyJson] = useState(customBody.rawJson)
  const [customBodyError, setCustomBodyError] = useState<string | null>(null)
  const activeBindingMatchesPanel = normalizedActiveBinding
    ? areReasoningSettingsEqual(normalizedActiveBinding, reasoningSettings)
      && (typeof activeBindingPromptBias !== 'string' || activeBindingPromptBias === promptBias)
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

  useEffect(() => {
    setLocalCustomBodyJson(customBody.rawJson)
    setCustomBodyError(null)
  }, [customBody.rawJson])

  const updateCustomBody = useCallback((rawJson: string) => {
    setLocalCustomBodyJson(rawJson)
    try {
      JSON.parse(rawJson)
      setCustomBodyError(null)
      updateReasoning({ customBody: { ...customBody, rawJson } })
    } catch (error: any) {
      setCustomBodyError(error.message)
    }
  }, [customBody, updateReasoning])

  const activePreset = REASONING_PRESETS.find(
    (p) => p.prefix === reasoningSettings.prefix && p.suffix === reasoningSettings.suffix
  )

  // If the current effort value isn't valid for this provider, show it but let the user pick a new one
  const currentEffortValid = effortOptions.some((o) => o.value === reasoningSettings.reasoningEffort)

  return (
    <div className={styles.panel}>
      {/* ── Reasoning / CoT ── */}
      <CollapsibleSection title={t('presetManager.reasoningTitle')} icon={<Brain size={14} />} defaultExpanded>
        {normalizedActiveBinding && (
          <div className={styles.bindingBanner}>
            <div className={styles.bindingBannerTitle}>{t('presetManager.savedOn', { name: activeProfile?.name })}</div>
            <div className={styles.bindingBannerText}>
              {getReasoningBindingSummary(normalizedActiveBinding, activeBindingPromptBias)}
            </div>
            {!activeBindingMatchesPanel && (
              <div className={styles.bindingBannerHint}>
                {t('presetManager.bindingChangedHint')}
              </div>
            )}
          </div>
        )}
        {/* Quick preset buttons */}
        <div className={styles.presetRow}>
          {REASONING_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={clsx(
                styles.presetBtn,
                activePreset?.prefix === p.prefix && activePreset?.suffix === p.suffix && styles.presetBtnActive,
              )}
              onClick={() => updateReasoning({ prefix: p.prefix, suffix: p.suffix })}
            >
              {t(`presetManager.reasoningPresets.${p.id}`)}
            </button>
          ))}
        </div>

        {/* Prefix / Suffix */}
        <div className={styles.tagRow}>
          <div className={styles.fieldGroup}>
            <span className={styles.label}>{t('presetManager.prefix')}</span>
            <input
              name="reasoning-prefix"
              aria-label={t('presetManager.reasoningPrefix')}
              className={styles.input}
              value={reasoningSettings.prefix}
              onChange={(e) => updateReasoning({ prefix: e.target.value })}
              placeholder="<think>\n"
            />
          </div>
          <div className={styles.fieldGroup}>
            <span className={styles.label}>{t('presetManager.suffix')}</span>
            <input
              name="reasoning-suffix"
              aria-label={t('presetManager.reasoningSuffix')}
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
            <div className={styles.toggleLabel}>{t('presetManager.autoParseThoughts')}</div>
            <div className={styles.toggleDesc}>{t('presetManager.autoParseThoughtsHint')}</div>
          </div>
          <Toggle.Switch
            checked={reasoningSettings.autoParse}
            onChange={(v) => updateReasoning({ autoParse: v })}
          />
        </div>

        {/* API Reasoning toggle */}
        <div className={styles.toggleRow}>
          <div>
            <div className={styles.toggleLabel}>{t('presetManager.apiReasoning')}</div>
            <div className={styles.toggleDesc}>{t('presetManager.apiReasoningHint')}</div>
          </div>
          <Toggle.Switch
            checked={reasoningSettings.apiReasoning}
            onChange={(v) => updateReasoning({ apiReasoning: v })}
          />
        </div>

        {/* Reasoning effort */}
        <div className={clsx(styles.fieldGroup, (isToggleOnly || isApiReasoningDisabled) && styles.fieldGroupDisabled)}>
          <span className={styles.label}>
            {t('presetManager.reasoningEffort')}
            {isToggleOnly && <span className={styles.toggleOnlyHint}> {t('presetManager.toggleOnlyFor', { provider: activeProvider })}</span>}
            {!isToggleOnly && isApiReasoningDisabled && <span className={styles.toggleOnlyHint}> {t('presetManager.disabledWhileApiOff')}</span>}
          </span>
          <select
            name="reasoning-effort"
            aria-label={t('presetManager.reasoningEffort')}
            className={clsx(styles.select, (isToggleOnly || isApiReasoningDisabled) && styles.selectDisabled)}
            value={reasoningSettings.reasoningEffort}
            onChange={(e) => updateReasoning({ reasoningEffort: e.target.value as ReasoningEffort })}
            disabled={isToggleOnly || isApiReasoningDisabled}
          >
            {!currentEffortValid && (
              <option value={reasoningSettings.reasoningEffort}>
                {t('presetManager.unsupportedEffort', { effort: reasoningSettings.reasoningEffort, provider: activeProvider ?? t('presetManager.provider') })}
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
            <span className={styles.label}>{t('presetManager.thinkingDisplay')}</span>
            <select
              name="thinking-display"
              aria-label={t('presetManager.thinkingDisplay')}
              className={clsx(styles.select, isApiReasoningDisabled && styles.selectDisabled)}
              value={reasoningSettings.thinkingDisplay ?? 'auto'}
              onChange={(e) => updateReasoning({ thinkingDisplay: e.target.value as ThinkingDisplay })}
              disabled={isApiReasoningDisabled}
            >
              <option value="auto">{t('presetManager.thinkingDisplayAuto')}</option>
              <option value="summarized">{t('presetManager.thinkingDisplaySummarized')}</option>
              <option value="omitted">{t('presetManager.thinkingDisplayOmitted')}</option>
            </select>
            <span className={styles.toggleDesc}>
              {isApiReasoningDisabled
                ? t('presetManager.thinkingDisplayDisabledHint')
                : t('presetManager.thinkingDisplayHint')}
            </span>
          </div>
        )}

        {/* Custom request body */}
        <div className={styles.fieldGroup}>
          <div className={styles.customBodyHeader}>
            <span className={styles.label}>{t('loomBuilder.settings.customBody')}</span>
            <Toggle.Checkbox
              checked={customBody.enabled}
              onChange={(enabled) => updateReasoning({ customBody: { ...customBody, enabled } })}
              label={t('loomBuilder.settings.enabled')}
            />
          </div>
          <div className={!customBody.enabled ? styles.customBodyDisabled : undefined}>
            <textarea
              name="reasoning-custom-body"
              aria-label={t('loomBuilder.settings.customBody')}
              className={styles.textarea}
              value={localCustomBodyJson}
              onChange={(event) => updateCustomBody(event.target.value)}
              placeholder={'{\n  "thinking": { "type": "enabled" }\n}'}
              spellCheck={false}
              rows={5}
            />
            {customBodyError && <div className={styles.jsonError}>{customBodyError}</div>}
            <div className={styles.toggleDesc}>{t('loomBuilder.settings.customBodyHint')}</div>
          </div>
        </div>

        {/* Keep N reasoning blocks in history */}
        <div className={styles.fieldGroup}>
          <span className={styles.label}>{t('presetManager.keepInHistory')}</span>
          <div className={styles.historyRow}>
            <NumericInput
              className={styles.input}
              min={-1}
              value={reasoningSettings.keepInHistory}
              integer
              onChange={(value) => updateReasoning({ keepInHistory: value ?? reasoningSettings.keepInHistory })}
            />
            <div className={styles.historyMeta}>
              <span className={styles.historyHint}>
                {reasoningSettings.keepInHistory === -1
                  ? t('presetManager.keepAllReasoning')
                  : reasoningSettings.keepInHistory === 0
                    ? t('presetManager.stripAllReasoning')
                    : t('presetManager.keepLastBlocks', { count: reasoningSettings.keepInHistory })}
              </span>
              <span className={styles.historySubHint}>{t('presetManager.keepInHistoryHint')}</span>
            </div>
          </div>
        </div>
      </CollapsibleSection>

      {/* ── Prompt Behavior ── */}
      <CollapsibleSection title={t('presetManager.promptBehaviorTitle')} icon={<IconBolt size={14} />} defaultExpanded>
        {/* Start Reply With */}
        <div className={styles.fieldGroup}>
          <span className={styles.label}>{t('presetManager.startReplyWith')}</span>
          <textarea
            name="prompt-bias"
            aria-label={t('presetManager.startReplyWith')}
            className={styles.textarea}
            value={promptBias}
            onChange={(e) => setSetting('promptBias', e.target.value)}
            placeholder={t('presetManager.startReplyPlaceholder')}
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
              {t('presetManager.clear')}
            </button>
          </div>
        </div>

      </CollapsibleSection>
    </div>
  )
}
