import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorldBookEntry } from '@/types/api'
import type { WorldBookEntryPageSize, WorldBookEntrySortBy } from '@/types/store'

export function useWorldBookEntryLabels() {
  const { t } = useTranslation('panels', { keyPrefix: 'worldBookPanel' })

  return useMemo(() => {
    const positionShort = [
      t('entryPosition.beforeMain'),
      t('entryPosition.afterMain'),
      t('entryPosition.beforeAN'),
      t('entryPosition.afterAN'),
      t('entryPosition.depthShort'),
    ] as const

    const positionOptions = [
      { value: 0, label: t('entryPosition.beforeMain') },
      { value: 1, label: t('entryPosition.afterMain') },
      { value: 2, label: t('entryPosition.beforeAN') },
      { value: 3, label: t('entryPosition.afterAN') },
      { value: 4, label: t('entryPosition.atDepth') },
      { value: 7, label: t('entryPosition.atMarker') },
    ] as const

    const typeOptions = [
      { value: 'trigger' as const, label: t('entryType.trigger') },
      { value: 'constant' as const, label: t('entryType.constant') },
      { value: 'vector' as const, label: t('entryType.vector') },
    ]

    const sortOptions: { value: WorldBookEntrySortBy; label: string }[] = [
      { value: 'custom', label: t('entrySort.custom') },
      { value: 'priority', label: t('entrySort.priority') },
      { value: 'name', label: t('entrySort.name') },
      { value: 'created', label: t('entrySort.created') },
      { value: 'updated', label: t('entrySort.updated') },
    ]

    const pageSizeOptions: Array<{ value: WorldBookEntryPageSize; label: string }> = [
      { value: 50, label: t('pageSize.50') },
      { value: 100, label: t('pageSize.100') },
      { value: 200, label: t('pageSize.200') },
      { value: 'all', label: t('pageSize.all') },
    ]

    const roleOptions = [
      { value: 'system', label: t('entryEditor.roles.system') },
      { value: 'user', label: t('entryEditor.roles.user') },
      { value: 'assistant', label: t('entryEditor.roles.assistant') },
    ] as const

    const selectiveLogicOptions = [
      { value: 0, label: t('entryEditor.selectiveLogic.andAll') },
      { value: 1, label: t('entryEditor.selectiveLogic.notNone') },
      { value: 2, label: t('entryEditor.selectiveLogic.orAny') },
      { value: 3, label: t('entryEditor.selectiveLogic.notAll') },
    ] as const

    const positionLabel = (position: number) =>
      position === 7
        ? t('entryPosition.markerShort')
        : positionShort[position] ?? t('entryPosition.fallback', { position })

    const entryTypeLabel = (entry: WorldBookEntry) =>
      entry.constant ? t('entryType.constant') : entry.vectorized ? t('entryType.vector') : t('entryType.trigger')

    return {
      positionShort,
      positionOptions,
      typeOptions,
      sortOptions,
      pageSizeOptions,
      roleOptions,
      selectiveLogicOptions,
      positionLabel,
      entryTypeLabel,
    }
  }, [t])
}
