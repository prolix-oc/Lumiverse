import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { DndContext, closestCenter, type DragCancelEvent, type DragEndEvent, type DragOverEvent, type DragStartEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { GripVertical, RefreshCw, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { Button, FormField, TextInput } from '@/components/shared/FormComponents'
import SearchableSelect from '@/components/shared/SearchableSelect'
import { useScaledSortableStyle } from '@/lib/dndUiScale'
import type { ImageGenConnectionModelsResult, ImageGenConnectionProfile } from '@/types/api'
import { useConnectionSensors, useVerticalSortModifier } from './connection-manager/useConnectionDragAndDrop'
import { useDragHandleBlur } from './connection-manager/useDragHandleBlur'
import styles from './ImageGenPanel.module.css'

const LORA_WEIGHT_MIN = 0
const LORA_WEIGHT_MAX = 1.5
const LORA_WEIGHT_STEP = 0.05
const LORA_DEFAULT_WEIGHT = 1

export type DraftLoraEntry = {
  draftId: string
  lora_name: string
  weight_model: string
  weight_clip: string
}

export type LoraModelOption = {
  id: string
  label: string
}

export type LoraDiscoveryState = 'idle' | 'loading' | 'ready' | 'error'

export type LoraModelLoader = (id: string, subtype: string) => Promise<ImageGenConnectionModelsResult>

export type LoraDiscoveryController = {
  supportsDiscovery: boolean
  loras: LoraModelOption[]
  state: LoraDiscoveryState
  error: string | null
  retry: () => void
}

type DiscoveryResult = {
  profile: ImageGenConnectionProfile | null
  attempt: number
  loader: LoraModelLoader
  fallbackError: string
  loras: LoraModelOption[]
  state: LoraDiscoveryState
  error: string | null
}

const LORA_DISCOVERY_PROVIDERS = new Set(['comfyui', 'sdapi', 'swarmui'])

function supportsLoraDiscovery(profile: ImageGenConnectionProfile | null): boolean {
  return profile !== null && LORA_DISCOVERY_PROVIDERS.has(profile.provider)
}

function getErrorMessage(error: unknown, fallbackError: string): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  return fallbackError
}

export function interpretLoraDiscoveryResult(
  result: ImageGenConnectionModelsResult,
): { loras: LoraModelOption[]; error: string | null } {
  const error = typeof result.error === 'string' ? result.error.trim() : ''
  if (error) return { loras: [], error }

  return {
    loras: Array.isArray(result.models)
      ? result.models.map((model) => ({ id: model.id, label: model.label }))
      : [],
    error: null,
  }
}

export function reorderDraftLoras(
  entries: DraftLoraEntry[],
  activeId: string,
  overId: string | null,
): DraftLoraEntry[] {
  if (!overId || activeId === overId) return entries

  const activeIndex = entries.findIndex((entry) => entry.draftId === activeId)
  const overIndex = entries.findIndex((entry) => entry.draftId === overId)
  if (activeIndex < 0 || overIndex < 0) return entries

  return arrayMove(entries, activeIndex, overIndex)
}

export function isKnownLoraDropTarget(
  entries: DraftLoraEntry[],
  overId: string | null,
): overId is string {
  return overId !== null && entries.some((entry) => entry.draftId === overId)
}

type LoraTranslator = (key: string, values: Record<string, unknown>) => string

function describeLoraRow(
  rows: DraftLoraEntry[],
  draftId: string,
  translate: LoraTranslator,
): { name: string; position: number } | null {
  const index = rows.findIndex((row) => row.draftId === draftId)
  if (index < 0) return null

  const position = index + 1
  return {
    position,
    name: rows[index]!.lora_name.trim() || translate('imageGenPanel.loraRowFallback', { position }),
  }
}

export function formatLoraReorderAnnouncement(
  kind: 'pickedUp' | 'moving' | 'dropped' | 'cancelled',
  rows: DraftLoraEntry[],
  activeId: string,
  overId: string | null,
  translate: LoraTranslator,
): string {
  const active = describeLoraRow(rows, activeId, translate)
  if (!active) return ''

  if (kind === 'pickedUp') {
    return translate('imageGenPanel.loraReorderPickedUp', {
      name: active.name,
      position: active.position,
      total: rows.length,
    })
  }

  if (kind === 'moving') {
    if (!overId || activeId === overId) return ''
    const over = describeLoraRow(rows, overId, translate)
    if (!over) return ''
    return translate('imageGenPanel.loraReorderMoving', {
      name: active.name,
      position: over.position,
      total: rows.length,
    })
  }

  if (kind === 'dropped') {
    const next = reorderDraftLoras(rows, activeId, overId)
    const position = next.findIndex((row) => row.draftId === activeId) + 1
    return translate('imageGenPanel.loraReorderDropped', {
      name: active.name,
      position,
      total: rows.length,
    })
  }

  return translate('imageGenPanel.loraReorderCancelled', {
    name: active.name,
    position: active.position,
    total: rows.length,
  })
}

export function useLoraDiscovery(
  activeConnection: ImageGenConnectionProfile | null,
  loadModels: LoraModelLoader,
  fallbackError: string,
): LoraDiscoveryController {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<DiscoveryResult | null>(null)
  const supportsDiscovery = supportsLoraDiscovery(activeConnection)

  useEffect(() => {
    let cancelled = false
    const profile = activeConnection
    const requestAttempt = attempt

    if (!supportsDiscovery || !profile) {
      setResult({
        profile,
        attempt: requestAttempt,
        loader: loadModels,
        fallbackError,
        loras: [],
        state: 'idle',
        error: null,
      })
      return () => {
        cancelled = true
      }
    }

    void loadModels(profile.id, 'loras')
      .then((response) => {
        if (cancelled) return
        const interpreted = interpretLoraDiscoveryResult(response)
        setResult({
          profile,
          attempt: requestAttempt,
          loader: loadModels,
          fallbackError,
          loras: interpreted.loras,
          state: interpreted.error ? 'error' : 'ready',
          error: interpreted.error,
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setResult({
          profile,
          attempt: requestAttempt,
          loader: loadModels,
          fallbackError,
          loras: [],
          state: 'error',
          error: getErrorMessage(error, fallbackError),
        })
      })

    return () => {
      cancelled = true
    }
  }, [activeConnection, attempt, fallbackError, loadModels, supportsDiscovery])

  const retry = useCallback(() => {
    setAttempt((current) => current + 1)
  }, [])

  const current = result
    && result.profile === activeConnection
    && result.attempt === attempt
    && result.loader === loadModels
    && result.fallbackError === fallbackError

  if (!supportsDiscovery) {
    return { supportsDiscovery: false, loras: [], state: 'idle', error: null, retry }
  }

  if (!current) {
    return { supportsDiscovery: true, loras: [], state: 'loading', error: null, retry }
  }

  return {
    supportsDiscovery: true,
    loras: result.loras,
    state: result.state,
    error: result.error,
    retry,
  }
}

export function LoraDiscoveryStatus({
  controller,
  className,
}: {
  controller: LoraDiscoveryController
  className?: string
}): ReactNode {
  const { t } = useTranslation('panels')
  const wrapperRef = useRef<HTMLDivElement>(null)

  if (!controller.supportsDiscovery) return null

  let text: string
  if (controller.state === 'loading') {
    text = t('imageGenPanel.loadingLoras')
  } else if (controller.state === 'error') {
    text = t('imageGenPanel.loadLorasFailed', {
      error: controller.error || t('imageGenPanel.fetchLorasFailed'),
    })
  } else if (controller.loras.length === 0) {
    text = t('imageGenPanel.noLorasFound')
  } else {
    text = t('imageGenPanel.loraDiscoveryReady', { count: controller.loras.length })
  }

  const handleRetry = () => {
    wrapperRef.current?.focus()
    controller.retry()
  }

  return (
    <div
      ref={wrapperRef}
      tabIndex={-1}
      aria-busy={controller.state === 'loading'}
      className={clsx(styles.loraDiscoveryStatus, className)}
    >
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={controller.state === 'error' ? styles.error : styles.editorTargetBanner}
      >
        {text}
      </span>
      {controller.state === 'error' && (
        <Button
          variant="secondary"
          size="sm"
          icon={<RefreshCw size={14} />}
          onClick={handleRetry}
        >
          {t('imageGenPanel.retryLoraDiscovery')}
        </Button>
      )}
    </div>
  )
}

type SortableLoraRowProps = {
  row: DraftLoraEntry
  index: number
  total: number
  filenameOptions: Array<{ value: string; label: string; sublabel?: string }>
  supportsDiscovery: boolean
  discoveryState: LoraDiscoveryState
  onUpdate: (draftId: string, patch: Partial<DraftLoraEntry>) => void
  onRemove: (draftId: string) => void
}

function SortableLoraRow({
  row,
  index,
  total,
  filenameOptions,
  supportsDiscovery,
  discoveryState,
  onUpdate,
  onRemove,
}: SortableLoraRowProps) {
  const { t } = useTranslation('panels')
  const sortingDisabled = total < 2
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: row.draftId,
    disabled: sortingDisabled,
  })
  const { setNodeRef, style } = useScaledSortableStyle({ setNodeRef: setSortableRef, transform, transition, isDragging })
  const handleRef = useDragHandleBlur(isDragging)
  const setHandleRef = useCallback((node: HTMLButtonElement | null) => {
    handleRef.current = node
    setActivatorNodeRef(node)
  }, [handleRef, setActivatorNodeRef])
  const position = index + 1
  const displayName = row.lora_name.trim() || t('imageGenPanel.loraRowFallback', { position })

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={clsx(styles.loraRow, isDragging && styles.loraRowDragging)}
    >
      <div className={styles.loraRowHeader}>
        <div className={styles.loraRowHeading}>
          <button
            ref={setHandleRef}
            type="button"
            className={clsx(styles.loraDragHandle, sortingDisabled && styles.loraDragHandleDisabled)}
            aria-label={t('imageGenPanel.loraDragHandle', { position, name: displayName })}
            title={t('imageGenPanel.loraDragHandle', { position, name: displayName })}
            {...attributes}
            {...(sortingDisabled ? {} : listeners)}
            aria-disabled={sortingDisabled}
          >
            <GripVertical size={16} />
          </button>
          <span className={styles.loraRowTitle}>{t('imageGenPanel.loraEntry')} {position}</span>
        </div>
        <Button
          variant="danger-ghost"
          size="icon-sm"
          icon={<Trash2 size={14} />}
          onClick={() => onRemove(row.draftId)}
          aria-label={t('imageGenPanel.removeLora')}
        />
      </div>

      <FormField label={t('imageGenPanel.loraFilename')}>
        <div className={styles.loraFilenameControls}>
          {supportsDiscovery && (
            <SearchableSelect
              value={row.lora_name}
              onChange={(value: string) => onUpdate(row.draftId, { lora_name: value })}
              options={filenameOptions}
              placeholder={t('imageGenPanel.loraFilenamePlaceholder')}
              searchPlaceholder={t('imageGenPanel.loraFilenamePlaceholder')}
              emptyMessage={t('imageGenPanel.noModelsFound')}
              portal
              minWidth={320}
              clearable
              disabled={discoveryState === 'loading'}
            />
          )}
          <TextInput
            value={row.lora_name}
            onChange={(value) => onUpdate(row.draftId, { lora_name: value })}
            placeholder={t('imageGenPanel.loraFilenamePlaceholder')}
          />
        </div>
      </FormField>

      <div className={styles.loraWeightGrid}>
        <FormField label={t('imageGenPanel.weightModel')}>
          <TextInput
            type="number"
            min={LORA_WEIGHT_MIN}
            max={LORA_WEIGHT_MAX}
            step={LORA_WEIGHT_STEP}
            value={row.weight_model}
            onChange={(value) => onUpdate(row.draftId, { weight_model: value })}
            placeholder={String(LORA_DEFAULT_WEIGHT)}
          />
        </FormField>
        <FormField label={t('imageGenPanel.weightClip')}>
          <TextInput
            type="number"
            min={LORA_WEIGHT_MIN}
            max={LORA_WEIGHT_MAX}
            step={LORA_WEIGHT_STEP}
            value={row.weight_clip}
            onChange={(value) => onUpdate(row.draftId, { weight_clip: value })}
            placeholder={row.weight_model || String(LORA_DEFAULT_WEIGHT)}
          />
        </FormField>
      </div>
    </div>
  )
}

export function LoraRowsEditor({
  rows,
  onChange,
  filenameOptions,
  supportsDiscovery,
  discoveryState,
}: {
  rows: DraftLoraEntry[]
  onChange: (rows: DraftLoraEntry[]) => void
  filenameOptions: Array<{ value: string; label: string; sublabel?: string }>
  supportsDiscovery: boolean
  discoveryState: LoraDiscoveryState
}): ReactNode {
  const { t } = useTranslation('panels')
  const sensors = useConnectionSensors()
  const loraRowsRef = useRef<HTMLDivElement>(null)
  const restrictLoraSort = useVerticalSortModifier(loraRowsRef)
  const [reorderAnnouncement, setReorderAnnouncement] = useState('')

  const updateRow = useCallback((draftId: string, patch: Partial<DraftLoraEntry>) => {
    onChange(rows.map((row) => row.draftId === draftId ? { ...row, ...patch } : row))
  }, [onChange, rows])

  const removeRow = useCallback((draftId: string) => {
    onChange(rows.filter((row) => row.draftId !== draftId))
  }, [onChange, rows])

  const translate = useCallback<LoraTranslator>((key, values) => t(key, values), [t])
  const announceReorder = useCallback((
    kind: 'pickedUp' | 'moving' | 'dropped' | 'cancelled',
    activeId: string,
    overId: string | null,
  ) => {
    setReorderAnnouncement(formatLoraReorderAnnouncement(kind, rows, activeId, overId, translate))
  }, [rows, translate])

  const handleDragStart = useCallback(({ active }: DragStartEvent) => {
    announceReorder('pickedUp', String(active.id), null)
  }, [announceReorder])

  const handleDragOver = useCallback(({ active, over }: DragOverEvent) => {
    if (!over || active.id === over.id) return
    announceReorder('moving', String(active.id), String(over.id))
  }, [announceReorder])

  const handleDragEnd = useCallback(({ active, over }: DragEndEvent) => {
    const activeId = String(active.id)
    const overId = over === null ? null : String(over.id)
    if (!isKnownLoraDropTarget(rows, overId)) {
      announceReorder('cancelled', activeId, null)
      return
    }
    announceReorder('dropped', activeId, overId)
    const next = reorderDraftLoras(rows, activeId, overId)
    if (next !== rows) onChange(next)
  }, [announceReorder, onChange, rows])

  const handleDragCancel = useCallback(({ active }: DragCancelEvent) => {
    announceReorder('cancelled', String(active.id), null)
  }, [announceReorder])

  const accessibility = useMemo(() => ({
    screenReaderInstructions: {
      draggable: t('imageGenPanel.loraReorderInstructions'),
    },
    // dnd-kit owns a second live region internally. Keep it silent so the
    // explicitly rendered region below is the sole human-facing announcement.
    announcements: {
      onDragStart: () => '',
      onDragOver: () => '',
      onDragEnd: () => '',
      onDragCancel: () => '',
    },
  }), [t])

  return (
    <>
      <div className={styles.editorTargetBanner}>{t('imageGenPanel.loraReorderHint')}</div>
      <span
        className={styles.loraReorderAnnouncement}
        role="status"
        aria-live="assertive"
        aria-atomic="true"
      >
        {reorderAnnouncement}
      </span>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictLoraSort]}
        accessibility={accessibility}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={rows.map((row) => row.draftId)} strategy={verticalListSortingStrategy}>
          <div ref={loraRowsRef} className={styles.loraRows}>
            {rows.map((row, index) => (
              <SortableLoraRow
                key={row.draftId}
                row={row}
                index={index}
                total={rows.length}
                filenameOptions={filenameOptions}
                supportsDiscovery={supportsDiscovery}
                discoveryState={discoveryState}
                onUpdate={updateRow}
                onRemove={removeRow}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </>
  )
}
