import type { TFunction } from 'i18next'
import { GROUP_LABEL_FALLBACKS } from '@/lib/prompt-breakdown'

export function translateBreakdownGroupLabel(id: string, t: TFunction): string {
  return t(`promptItemizer.groups.${id}`, {
    ns: 'modals',
    defaultValue: GROUP_LABEL_FALLBACKS[id] ?? id,
  })
}
