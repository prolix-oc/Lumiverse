import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ADDABLE_MARKERS,
  CONTINUE_POSTFIX_OPTIONS,
  INJECTION_TRIGGER_TYPES,
  MARKER_NAMES,
  NAMES_BEHAVIOR_OPTIONS,
} from '@/lib/loom/constants'

const MARKER_SECTION_KEYS: Record<string, string> = {
  Structural: 'structural',
  Character: 'character',
  Prompts: 'prompts',
}

const CONTINUE_POSTFIX_I18N_KEYS: Record<string, string> = {
  '': 'none',
  ' ': 'space',
  '\n': 'newline',
  '\n\n': 'doubleNewline',
}

const NAMES_BEHAVIOR_I18N_KEYS: Record<number, string> = {
  [-1]: 'none',
  0: 'default',
  1: 'inCompletion',
  2: 'inContent',
}

export function useLoomOptionLabels() {
  const { t } = useTranslation('panels', { keyPrefix: 'loomBuilder.options' })

  return useMemo(() => {
    const injectionTriggerTypes = INJECTION_TRIGGER_TYPES.map((trigger) => ({
      ...trigger,
      label: t(`injectionTriggers.${trigger.value}`),
    }))

    const injectionTriggerLabel = (value: string) =>
      injectionTriggerTypes.find((item) => item.value === value)?.label ?? value

    const continuePostfixOptions = CONTINUE_POSTFIX_OPTIONS.map((opt) => {
      const key = CONTINUE_POSTFIX_I18N_KEYS[opt.value] ?? 'none'
      return { ...opt, label: t(`continuePostfix.${key}`) }
    })

    const namesBehaviorOptions = NAMES_BEHAVIOR_OPTIONS.map((opt) => {
      const key = NAMES_BEHAVIOR_I18N_KEYS[opt.value] ?? 'default'
      return { ...opt, label: t(`namesBehavior.${key}`) }
    })

    const markerLabel = (markerId: string) =>
      t(`markers.${markerId}`, { defaultValue: MARKER_NAMES[markerId] ?? markerId })

    const markerSectionLabel = (section: string) =>
      t(`markerSections.${MARKER_SECTION_KEYS[section] ?? section}`, { defaultValue: section })

    return {
      injectionTriggerTypes,
      injectionTriggerLabel,
      continuePostfixOptions,
      namesBehaviorOptions,
      markerLabel,
      markerSectionLabel,
      addableMarkers: ADDABLE_MARKERS,
    }
  }, [t])
}
