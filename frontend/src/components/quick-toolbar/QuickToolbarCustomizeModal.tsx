import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { GripVertical, RotateCcw, Search } from 'lucide-react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CloseButton } from '@/components/shared/CloseButton'
import { ModalShell } from '@/components/shared/ModalShell'
import { Toggle } from '@/components/shared/Toggle'
import { useScaledSortableStyle } from '@/lib/dndUiScale'
import { filterActionIds, filterActions } from '@/lib/toolbarActionSearch'
import { isAutoFitToolbarBounds, isFillTopDockWidth, isOpaqueToolbarBackdrop, isShowNativeSelectMessages, isV2IconOnly, readQuickToolbarPlacement } from './quickToolbarDock'
import { nextToolbarIconOrder } from './toolbarPointerHold'
import { useQuickToolbarActions, type ToolbarAction } from './useQuickToolbarActions'
import styles from './QuickToolbarCustomizeModal.module.css'

interface QuickToolbarCustomizeModalProps {
  onClose: () => void
}

function SortableActionRow({
  action,
  enabled,
  onToggle,
}: {
  action: ToolbarAction
  enabled: boolean
  onToggle: (id: string) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: action.id, disabled: !enabled })
  const { setNodeRef, style } = useScaledSortableStyle({ setNodeRef: setSortableRef, transform, transition, isDragging })
  const Icon = action.icon

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={clsx(styles.row, isDragging && styles.rowDragging, !enabled && styles.rowDisabled)}
    >
      <button
        type="button"
        className={styles.dragHandle}
        title={enabled ? 'Drag to reorder' : 'Enable this icon to reorder it'}
        aria-label={`Drag ${action.label}`}
        disabled={!enabled}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} />
      </button>

      <span className={styles.iconWrap}>
        <Icon size={18} strokeWidth={1.75} />
      </span>

      <div className={styles.copy}>
        <span className={styles.rowTitle}>{action.label}</span>
        <p className={styles.rowDescription}>{action.description}</p>
      </div>

      <Toggle.Switch
        checked={enabled}
        onChange={() => onToggle(action.id)}
        aria-label={`${enabled ? 'Hide' : 'Show'} ${action.label}`}
      />
    </div>
  )
}

function RangeRow({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  suffix: string
  onChange: (value: number) => void
}) {
  return (
    <label className={styles.rangeRow}>
      <span className={styles.rangeLabel}>{label}</span>
      <output className={styles.rangeValue}>{value}{suffix}</output>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}

/**
 * Full-surface toolbar customizer. The glued popover covers the quick controls;
 * this is the roomy, touch-friendly version — cards with real hit targets and
 * drag-to-reorder that works on a phone.
 */
export default function QuickToolbarCustomizeModal({ onClose }: QuickToolbarCustomizeModalProps) {
  const {
    settings,
    updateSettings,
    actionCatalog,
    actionById,
    catalogOrder,
    visibleIds,
    orderedIds,
    reorderActions,
    toggleAction,
    resetCurrentVariant,
  } = useQuickToolbarActions()

  /**
   * Component-local and deliberately never persisted: every other filter box in
   * the app (`bookSearch`, `entrySearch`, `SearchableSelect`) is plain `useState`
   * too, and a persisted query would round-trip to the server and reopen this
   * modal mysteriously filtered.
   */
  const [query, setQuery] = useState('')

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const anchored = settings.variant === 'v2-settings-adjacent'
  const iconSize = anchored ? settings.v2IconSize : settings.iconSize
  const labelTextSize = anchored ? settings.v2LabelTextSize : settings.labelTextSize
  const rows = useMemo(
    () => catalogOrder
      .map((id) => actionCatalog.find((action) => action.id === id))
      .filter((action): action is ToolbarAction => Boolean(action)),
    [actionCatalog, catalogOrder],
  )

  const filteredRows = useMemo(() => filterActions(rows, query), [rows, query])
  /**
   * Filtering changes what is RENDERED, never what is stored.
   *
   * `verticalListSortingStrategy` indexes rects by position in `items`, so an id
   * whose row is filtered out has no mounted node and yields a `null` rect —
   * transforms and collision detection then degrade. Hand dnd-kit the enabled
   * ids that survive the filter instead. `filterActionIds` returns `orderedIds`
   * *itself* for an empty query, so with no search active `items` is literally
   * the array it has always been and dnd-kit behaviour is bit-for-bit unchanged.
   *
   * `handleDragEnd` below still resolves both endpoints by id against the full
   * `orderedIds`, so the move math is untouched by filtering.
   */
  const sortableIds = useMemo(
    () => filterActionIds(orderedIds, actionById, query),
    [actionById, orderedIds, query],
  )
  /** True only while the filter is actually narrowing the list — `filterActions` returns its input for an empty query. */
  const filtering = filteredRows !== rows
  const filteredEnabledCount = useMemo(
    () => filteredRows.reduce((total, action) => total + (visibleIds.includes(action.id) ? 1 : 0), 0),
    [filteredRows, visibleIds],
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over) return
    const next = nextToolbarIconOrder(orderedIds, String(active.id), String(over.id))
    if (!next) return
    reorderActions(next)
  }

  return (
    <ModalShell data-component="QuickToolbarCustomizeModal" isOpen onClose={onClose} maxWidth={760} className={styles.modal}>
      <CloseButton onClick={onClose} variant="solid" position="absolute" />

      <div className={styles.header}>
        <h3 className={styles.title}>Customize Toolbar</h3>
        <p className={styles.subtitle}>
          Drag to reorder toolbar icons. Toggle to hide the ones you don’t use. Changes apply immediately.
        </p>
      </div>

      <div className={styles.body}>
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h4 className={styles.sectionTitle}>Toolbar icons</h4>
            <p className={styles.sectionDescription}>
              {filtering
                ? `${filteredRows.length} of ${rows.length} match, ${filteredEnabledCount} of those shown in the toolbar.`
                : `${visibleIds.length} of ${rows.length} shown, in toolbar order.`}
            </p>
            <label className={styles.searchField}>
              <Search size={14} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search icons..."
                aria-label="Search toolbar icons"
              />
            </label>
            {filtering && (
              <p className={styles.searchHint}>
                Dragging still reorders while filtered — an icon lands beside the visible row you drop it
                on, jumping any hidden ones.
              </p>
            )}
          </div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
              <div className={styles.list}>
                {filtering && filteredRows.length === 0 ? (
                  <p className={styles.emptyState}>No toolbar icons match “{query.trim()}”.</p>
                ) : filteredRows.map((action) => (
                  <SortableActionRow
                    key={action.id}
                    action={action}
                    enabled={visibleIds.includes(action.id)}
                    onToggle={toggleAction}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h4 className={styles.sectionTitle}>Appearance</h4>
            <p className={styles.sectionDescription}>Applies to the active toolbar variant.</p>
          </div>

          <div className={styles.controls}>
            <RangeRow
              label="Icon size"
              value={iconSize}
              min={16}
              max={36}
              suffix="px"
              onChange={(value) => updateSettings(anchored ? { v2IconSize: value } : { iconSize: value })}
            />
            <RangeRow
              label="Label size"
              value={labelTextSize}
              min={9}
              max={18}
              suffix="px"
              onChange={(value) => updateSettings(anchored ? { v2LabelTextSize: value } : { labelTextSize: value })}
            />
            <RangeRow
              label="Opacity"
              value={Math.round(settings.opacity * 100)}
              min={30}
              max={100}
              suffix="%"
              onChange={(value) => updateSettings({ opacity: value / 100 })}
            />
            {!anchored && (
              <>
                <RangeRow
                  label="Scale"
                  value={Math.round(settings.scale * 100)}
                  min={60}
                  max={160}
                  suffix="%"
                  onChange={(value) => updateSettings({ scale: value / 100 })}
                />
                <RangeRow
                  label="Rotation"
                  value={settings.rotationDeg}
                  min={-180}
                  max={180}
                  suffix="°"
                  onChange={(rotationDeg) => updateSettings({ rotationDeg })}
                />
              </>
            )}

            <div className={styles.switchRow}>
              <span>Show labels</span>
              <Toggle.Switch
                checked={anchored ? settings.v2LabelVisible !== false && !isV2IconOnly(settings) : settings.labelVisible}
                onChange={(visible) => updateSettings(
                  anchored
                    ? { v2LabelVisible: visible }
                    : { labelVisible: visible },
                )}
                aria-label="Show toolbar labels"
              />
            </div>
            {anchored && (
              <div className={styles.switchRow}>
                <span>Icon-only</span>
                <Toggle.Switch
                  checked={isV2IconOnly(settings)}
                  onChange={(v2IconOnly) => updateSettings({
                    v2IconOnly,
                    v2LabelVisible: v2IconOnly ? false : settings.v2LabelVisible,
                  } as typeof settings)}
                  aria-label="V2 icon-only toolbar"
                />
              </div>
            )}
            {(!anchored || (anchored && readQuickToolbarPlacement(settings) === 'floating')) && (
              <div className={styles.switchRow}>
                <span>Auto-fit toolbar bounds to content</span>
                <Toggle.Switch
                  checked={isAutoFitToolbarBounds(settings)}
                  onChange={(autoFitBounds) => updateSettings({ autoFitBounds } as typeof settings)}
                  aria-label="Auto-fit toolbar bounds to content"
                />
              </div>
            )}
            <div className={styles.switchRow}>
              <span>
                {readQuickToolbarPlacement(settings) === 'chat_top_dock'
                  ? 'Fill chat top bar width'
                  : 'Fill the entire top of the screen'}
              </span>
              <Toggle.Switch
                checked={isFillTopDockWidth(settings)}
                onChange={(fillTopDockWidth) => updateSettings({ fillTopDockWidth } as typeof settings)}
                aria-label={readQuickToolbarPlacement(settings) === 'chat_top_dock'
                  ? 'Fill chat top bar width'
                  : 'Fill the entire top of the screen'}
              />
            </div>
            <div className={styles.switchRow}>
              <span>Show select-messages on chat top bar</span>
              <Toggle.Switch
                checked={isShowNativeSelectMessages(settings)}
                onChange={(showNativeSelectMessages) => updateSettings({ showNativeSelectMessages } as typeof settings)}
                aria-label="Show select-messages on chat top bar"
              />
            </div>
            <div className={styles.switchRow}>
              <span>Opaque toolbar backdrop</span>
              <Toggle.Switch
                checked={isOpaqueToolbarBackdrop(settings)}
                onChange={(opaqueToolbarBackdrop) => updateSettings({ opaqueToolbarBackdrop } as typeof settings)}
                aria-label="Opaque toolbar backdrop"
              />
            </div>

            {!anchored && (
              <>
                <div className={styles.switchRow}>
                  <span>Snap to edge</span>
                  <Toggle.Switch
                    checked={settings.snapToEdge}
                    onChange={(snapToEdge) => updateSettings({ snapToEdge })}
                    aria-label="Snap toolbar to edge"
                  />
                </div>
                <div className={styles.switchRow}>
                  <span>Resize handles</span>
                  <Toggle.Switch
                    checked={settings.resizeHandlesEnabled !== false}
                    onChange={(resizeHandlesEnabled) => updateSettings({ resizeHandlesEnabled })}
                    aria-label="Show toolbar resize handles"
                  />
                </div>
                <div className={styles.switchRow}>
                  <span>Orientation</span>
                  <div className={styles.segmented}>
                    {(['horizontal', 'vertical'] as const).map((orientation) => (
                      <button
                        key={orientation}
                        type="button"
                        className={clsx(settings.orientation === orientation && styles.segmentActive)}
                        onClick={() => updateSettings({ orientation })}
                      >
                        {orientation === 'horizontal' ? 'Horizontal' : 'Vertical'}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </section>
      </div>

      <div className={styles.footer}>
        <button type="button" className={styles.resetButton} onClick={resetCurrentVariant}>
          <RotateCcw size={14} />
          Reset this variant
        </button>
        <button type="button" className={styles.doneButton} onClick={onClose}>Done</button>
      </div>
    </ModalShell>
  )
}
