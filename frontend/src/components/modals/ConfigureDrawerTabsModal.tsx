import { useMemo } from 'react'
import clsx from 'clsx'
import { GripVertical } from 'lucide-react'
import {
  DndContext,
  closestCenter,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { uiScaledTransform } from '@/lib/dndUiScale'
import { useStore } from '@/store'
import { ModalShell } from '@/components/shared/ModalShell'
import { Toggle } from '@/components/shared/Toggle'
import { CloseButton } from '@/components/shared/CloseButton'
import {
  DRAWER_TABS,
  adaptExtensionTabs,
  applyDrawerTabOrder,
  isDrawerTabCore,
  sanitizeDrawerTabOrder,
  sanitizeHiddenDrawerTabIds,
  type DrawerTabEntry,
} from '@/lib/drawer-tab-registry'
import styles from './ConfigureDrawerTabsModal.module.css'

interface SortableTabRowProps {
  tab: DrawerTabEntry
  hidden: boolean
  onToggle: (tabId: string, enabled: boolean) => void
  variant: 'builtin' | 'extension'
}

function SortableTabRow({ tab, hidden, onToggle, variant }: SortableTabRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id })
  const style = { transform: uiScaledTransform(transform), transition }
  const Icon = tab.tabIcon
  const locked = variant === 'builtin' && isDrawerTabCore(tab.id)
  const enabled = !hidden

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={clsx(
        styles.row,
        locked && styles.rowLocked,
        isDragging && styles.rowDragging,
        !enabled && styles.rowHidden,
      )}
    >
      <button
        type="button"
        className={styles.dragHandle}
        title="Drag to reorder"
        aria-label={`Drag ${tab.tabName}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} />
      </button>

      <div className={styles.rowInfo}>
        <span className={styles.iconWrap}>
          <Icon size={18} strokeWidth={1.75} />
        </span>
        <div className={styles.copy}>
          <div className={styles.rowTitleWrap}>
            <span className={styles.rowTitle}>{tab.tabName}</span>
            {locked && <span className={styles.badge}>Core</span>}
            {variant === 'extension' && <span className={clsx(styles.badge, styles.badgeMuted)}>Extension</span>}
          </div>
          <p className={styles.rowDescription}>
            {locked ? 'Always visible so you can still reach core app sections.' : tab.tabDescription}
          </p>
        </div>
      </div>

      <Toggle.Switch
        checked={enabled}
        onChange={(next) => onToggle(tab.id, next)}
        disabled={locked}
      />
    </div>
  )
}

interface SortableSectionProps {
  title: string
  description: string
  tabs: DrawerTabEntry[]
  hiddenTabIds: Set<string>
  onToggle: (tabId: string, enabled: boolean) => void
  onReorder: (orderedIds: string[]) => void
  variant: 'builtin' | 'extension'
}

function SortableSection({ title, description, tabs, hiddenTabIds, onToggle, onReorder, variant }: SortableSectionProps) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  if (tabs.length === 0) return null

  const ids = tabs.map((tab) => tab.id)

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = ids.indexOf(String(active.id))
    const newIndex = ids.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    onReorder(arrayMove(ids, oldIndex, newIndex))
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h3 className={styles.sectionTitle}>{title}</h3>
        <p className={styles.sectionDescription}>{description}</p>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div className={styles.list}>
            {tabs.map((tab) => (
              <SortableTabRow
                key={tab.id}
                tab={tab}
                hidden={hiddenTabIds.has(tab.id)}
                onToggle={onToggle}
                variant={variant}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </section>
  )
}

export default function ConfigureDrawerTabsModal() {
  const closeModal = useStore((s) => s.closeModal)
  const setSetting = useStore((s) => s.setSetting)
  const drawerSettings = useStore((s) => s.drawerSettings)
  const drawerTabs = useStore((s) => s.drawerTabs)

  const hiddenTabIds = useMemo(
    () => new Set(sanitizeHiddenDrawerTabIds(drawerSettings.hiddenTabIds)),
    [drawerSettings.hiddenTabIds],
  )

  const tabOrder = useMemo(
    () => sanitizeDrawerTabOrder(drawerSettings.tabOrder),
    [drawerSettings.tabOrder],
  )

  const orderedBuiltInTabs = useMemo(
    () => applyDrawerTabOrder(DRAWER_TABS, tabOrder),
    [tabOrder],
  )

  const orderedExtensionTabs = useMemo(
    () => applyDrawerTabOrder(adaptExtensionTabs(drawerTabs), tabOrder),
    [drawerTabs, tabOrder],
  )

  const handleToggle = (tabId: string, enabled: boolean) => {
    if (isDrawerTabCore(tabId)) return
    const nextHidden = new Set(hiddenTabIds)
    if (enabled) nextHidden.delete(tabId)
    else nextHidden.add(tabId)
    setSetting('drawerSettings', {
      ...drawerSettings,
      hiddenTabIds: Array.from(nextHidden),
    })
  }

  const persistOrder = (builtInIds: string[], extensionIds: string[]) => {
    setSetting('drawerSettings', {
      ...drawerSettings,
      tabOrder: [...builtInIds, ...extensionIds],
    })
  }

  const handleBuiltInReorder = (orderedIds: string[]) => {
    const extensionIds = orderedExtensionTabs.map((tab) => tab.id)
    persistOrder(orderedIds, extensionIds)
  }

  const handleExtensionReorder = (orderedIds: string[]) => {
    const builtInIds = orderedBuiltInTabs.map((tab) => tab.id)
    persistOrder(builtInIds, orderedIds)
  }

  return (
    <ModalShell isOpen onClose={closeModal} maxWidth={720} className={styles.modal}>
      <CloseButton onClick={closeModal} variant="solid" position="absolute" />

      <div className={styles.header}>
        <div>
          <h3 className={styles.title}>Configure Tabs</h3>
          <p className={styles.subtitle}>Drag to reorder sidebar tabs. Toggle to hide optional tabs; core tabs always remain visible.</p>
        </div>
      </div>

      <div className={styles.body}>
        <SortableSection
          title="Sidebar Tabs"
          description="Drag to reorder. Core tabs stay visible but can still be moved; toggle off any tab you don't use often."
          tabs={orderedBuiltInTabs}
          hiddenTabIds={hiddenTabIds}
          onToggle={handleToggle}
          onReorder={handleBuiltInReorder}
          variant="builtin"
        />

        <SortableSection
          title="Extension Tabs"
          description="Extension-provided tabs render after the built-in tabs in the sidebar. Drag to reorder or hide individually."
          tabs={orderedExtensionTabs}
          hiddenTabIds={hiddenTabIds}
          onToggle={handleToggle}
          onReorder={handleExtensionReorder}
          variant="extension"
        />
      </div>
    </ModalShell>
  )
}
