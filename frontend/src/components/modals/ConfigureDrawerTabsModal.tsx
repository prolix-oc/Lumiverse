import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'
import clsx from 'clsx'
import { Check, FolderPlus, GripVertical, Minus, Plus, Puzzle, Trash2, Upload } from 'lucide-react'
import {
  closestCenter,
  type CollisionDetection,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { DndContext, useScaledSortableStyle } from '@/lib/dndUiScale'
import { useStore } from '@/store'
import { ModalShell } from '@/components/shared/ModalShell'
import { Toggle } from '@/components/shared/Toggle'
import { CloseButton } from '@/components/shared/CloseButton'
import {
  DRAWER_TABS,
  adaptExtensionTabs,
  isDrawerTabCore,
  sanitizeHiddenDrawerTabIds,
  type DrawerTabEntry,
} from '@/lib/drawer-tab-registry'
import {
  canonicalDrawerLayoutTabId,
  createDrawerLayoutContainerId,
  DRAWER_LAYOUT_ROOT_END_ID,
  drawerLayoutItemKey,
  drawerLayoutTabKey,
  findDrawerLayoutLocation,
  flattenDrawerLayoutTabIds,
  moveDrawerLayoutItem,
  reconcileDrawerLayout,
  removeDrawerLayoutContainer,
  sanitizeDrawerLayout,
  updateDrawerLayoutContainer,
  updateDrawerLayoutFolderCustomIcon,
  updateDrawerLayoutFolderIcon,
} from '@/lib/drawer-layout'
import { DRAWER_FOLDER_ICON_OPTIONS, DrawerFolderIcon } from '@/lib/drawer-folder-icons'
import { DRAWER_CUSTOM_ICON_MAX_BYTES, parseDrawerCustomIcon } from '@/lib/drawer-custom-icon'
import type { DrawerCustomIconData, DrawerLayoutItem } from '@/types/store'
import styles from './ConfigureDrawerTabsModal.module.css'
import { filterEnabledFrontendContributions } from '@/lib/spindle/frontend-extension-availability'

interface SortableTabRowProps {
  tabId: string
  tab?: DrawerTabEntry
  hidden: boolean
  extension: boolean
  unavailable: boolean
  nested?: boolean
  onToggle: (tabId: string, enabled: boolean) => void
}

function SortableTabRow({ tabId, tab, hidden, extension, unavailable, nested = false, onToggle }: SortableTabRowProps) {
  const sortableId = drawerLayoutTabKey(tabId)
  const { attributes, listeners, setNodeRef: setSortableRef, transform, transition, isDragging } = useSortable({ id: sortableId })
  const { setNodeRef, style } = useScaledSortableStyle({ setNodeRef: setSortableRef, transform, transition, isDragging })
  const Icon = tab?.tabIcon ?? Puzzle
  const locked = isDrawerTabCore(tabId)
  const enabled = !hidden
  const title = tab?.tabName ?? tabId

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-drawer-layout-kind="tab"
      data-drawer-tab-id={tabId}
      data-drawer-layout-root={nested ? 'false' : 'true'}
      data-drawer-layout-title={title}
      className={clsx(
        styles.row,
        nested && styles.rowNested,
        locked && styles.rowLocked,
        isDragging && styles.rowDragging,
        !enabled && styles.rowHidden,
        unavailable && styles.rowUnavailable,
      )}
    >
      <button
        type="button"
        className={styles.dragHandle}
        title={i18n.t('configureDrawerTabs.dragToReorder', { ns: 'modals' })}
        aria-label={i18n.t('configureDrawerTabs.dragTab', { ns: 'modals', name: title })}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} />
      </button>

      <div className={styles.rowInfo}>
        <span className={styles.iconWrap} data-drawer-tab-icon>
          <Icon size={18} strokeWidth={1.75} />
        </span>
        <div className={styles.copy}>
          <div className={styles.rowTitleWrap}>
            <span className={styles.rowTitle} data-drawer-tab-title>{title}</span>
            {locked && <span className={styles.badge}>{i18n.t('configureDrawerTabs.coreBadge', { ns: 'modals' })}</span>}
            {extension && (
              <span className={clsx(styles.badge, styles.badgeMuted)}>
                {i18n.t('configureDrawerTabs.extensionBadge', { ns: 'modals' })}
              </span>
            )}
            {unavailable && (
              <span className={clsx(styles.badge, styles.badgeWarning)}>
                {i18n.t('configureDrawerTabs.unavailableBadge', { ns: 'modals', defaultValue: 'Unavailable' })}
              </span>
            )}
          </div>
          <p className={styles.rowDescription} data-drawer-tab-description>
            {locked
              ? i18n.t('configureDrawerTabs.coreLockedHint', { ns: 'modals' })
              : unavailable
                ? i18n.t('configureDrawerTabs.unavailableHint', {
                    ns: 'modals',
                    defaultValue: 'This tab is not registered right now. Its saved position is preserved.',
                  })
                : tab?.tabDescription}
          </p>
        </div>
      </div>

      <Toggle.Switch
        checked={enabled}
        onChange={(next) => onToggle(tabId, next)}
        disabled={locked || unavailable}
      />
    </div>
  )
}

interface SortableDividerRowProps {
  item: Extract<DrawerLayoutItem, { type: 'divider' }>
  onRename: (itemKey: string, value: string) => void
  onDelete: (itemKey: string) => void
}

function SortableDividerRow({ item, onRename, onDelete }: SortableDividerRowProps) {
  const itemKey = drawerLayoutItemKey(item)
  const { attributes, listeners, setNodeRef: setSortableRef, transform, transition, isDragging } = useSortable({ id: itemKey })
  const { setNodeRef, style } = useScaledSortableStyle({ setNodeRef: setSortableRef, transform, transition, isDragging })

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-drawer-layout-kind="divider"
      data-drawer-divider-id={item.id}
      className={clsx(styles.dividerRow, isDragging && styles.rowDragging)}
    >
      <button type="button" className={styles.dragHandle} {...attributes} {...listeners}>
        <GripVertical size={16} />
      </button>
      <Minus size={18} className={styles.dividerIcon} />
      <input
        className={styles.nameInput}
        value={item.label ?? ''}
        onChange={(event) => onRename(itemKey, event.target.value)}
        placeholder={i18n.t('configureDrawerTabs.dividerPlaceholder', { ns: 'modals', defaultValue: 'Divider label (optional)' })}
        aria-label={i18n.t('configureDrawerTabs.dividerLabel', { ns: 'modals', defaultValue: 'Divider label' })}
      />
      <button
        type="button"
        className={styles.deleteButton}
        onClick={() => onDelete(itemKey)}
        title={i18n.t('configureDrawerTabs.deleteDivider', { ns: 'modals', defaultValue: 'Delete divider' })}
      >
        <Trash2 size={15} />
      </button>
    </div>
  )
}

interface SortableFolderRowProps {
  item: Extract<DrawerLayoutItem, { type: 'folder' }>
  entryMap: Map<string, DrawerTabEntry>
  extensionIds: Set<string>
  hiddenTabIds: Set<string>
  onToggle: (tabId: string, enabled: boolean) => void
  onRename: (itemKey: string, value: string) => void
  onIconChange: (itemKey: string, icon: string) => void
  onCustomIconChange: (itemKey: string, icon: DrawerCustomIconData) => void
  onDelete: (itemKey: string) => void
}

function SortableFolderRow({
  item,
  entryMap,
  extensionIds,
  hiddenTabIds,
  onToggle,
  onRename,
  onIconChange,
  onCustomIconChange,
  onDelete,
}: SortableFolderRowProps) {
  const itemKey = drawerLayoutItemKey(item)
  const { attributes, listeners, setNodeRef: setSortableRef, transform, transition, isDragging } = useSortable({ id: itemKey })
  const { setNodeRef, style } = useScaledSortableStyle({ setNodeRef: setSortableRef, transform, transition, isDragging })
  const childIds = item.children.map(drawerLayoutTabKey)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [showCustomIconImporter, setShowCustomIconImporter] = useState(false)
  const [customIconSource, setCustomIconSource] = useState('')
  const [customIconFileError, setCustomIconFileError] = useState('')
  const customIconParse = useMemo(
    () => customIconSource.trim() ? parseDrawerCustomIcon(customIconSource) : null,
    [customIconSource],
  )
  const customIconParseError = customIconParse?.ok === false ? customIconParse.error : ''
  const customIconError = customIconFileError || customIconParseError

  const handleIconFile = async (file: File | undefined) => {
    if (!file) return
    if (file.size > DRAWER_CUSTOM_ICON_MAX_BYTES) {
      setCustomIconSource('')
      setCustomIconFileError(i18n.t('configureDrawerTabs.customIconTooLarge', {
        ns: 'modals',
        defaultValue: 'SVG is larger than the 32 KB icon limit.',
      }))
      return
    }
    setCustomIconFileError('')
    setCustomIconSource(await file.text())
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-drawer-layout-kind="folder"
      data-drawer-folder-id={item.id}
      data-drawer-layout-title={item.name}
      className={clsx(styles.folder, isDragging && styles.rowDragging)}
    >
      <div className={styles.folderHeader}>
        <button type="button" className={styles.dragHandle} {...attributes} {...listeners}>
          <GripVertical size={16} />
        </button>
        <details className={styles.iconPicker}>
          <summary
            className={styles.folderIconButton}
            data-drawer-folder-icon
            title={i18n.t('configureDrawerTabs.changeFolderIcon', { ns: 'modals', defaultValue: 'Change folder icon' })}
            aria-label={i18n.t('configureDrawerTabs.changeFolderIcon', { ns: 'modals', defaultValue: 'Change folder icon' })}
          >
            <DrawerFolderIcon icon={item.icon} customIcon={item.customIcon} size={18} strokeWidth={1.7} />
          </summary>
          <div className={clsx(styles.iconPickerMenu, showCustomIconImporter && styles.iconPickerMenuExpanded)}>
            {DRAWER_FOLDER_ICON_OPTIONS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                className={clsx(styles.iconChoice, !item.customIcon && (item.icon ?? 'folder') === id && styles.iconChoiceActive)}
                title={label}
                aria-label={label}
                onClick={(event) => {
                  onIconChange(itemKey, id)
                  setShowCustomIconImporter(false)
                  event.currentTarget.closest('details')?.removeAttribute('open')
                }}
              >
                <Icon size={17} strokeWidth={1.7} />
              </button>
            ))}
            <button
              type="button"
              className={clsx(styles.iconChoice, item.customIcon && styles.iconChoiceActive)}
              title={i18n.t('configureDrawerTabs.customIcon', { ns: 'modals', defaultValue: 'Custom SVG icon' })}
              aria-label={i18n.t('configureDrawerTabs.customIcon', { ns: 'modals', defaultValue: 'Custom SVG icon' })}
              onClick={() => setShowCustomIconImporter((open) => !open)}
            >
              <Plus size={17} strokeWidth={1.8} />
            </button>

            {showCustomIconImporter && (
              <div className={styles.customIconImporter}>
                <div className={styles.customIconPreviewRow}>
                  <span className={styles.customIconPreview}>
                    <DrawerFolderIcon
                      icon={item.icon}
                      customIcon={customIconParse?.ok ? customIconParse.icon : item.customIcon}
                      size={22}
                      strokeWidth={1.7}
                    />
                  </span>
                  <span>
                    <strong>{i18n.t('configureDrawerTabs.customIcon', { ns: 'modals', defaultValue: 'Custom SVG icon' })}</strong>
                    <small>{i18n.t('configureDrawerTabs.customIconSafety', { ns: 'modals', defaultValue: 'Sanitized locally · 32 KB max.' })}</small>
                  </span>
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".svg,image/svg+xml"
                  className={styles.customIconFileInput}
                  onChange={(event) => {
                    void handleIconFile(event.target.files?.[0])
                    event.currentTarget.value = ''
                  }}
                />
                <button type="button" className={styles.customIconUploadButton} onClick={() => fileInputRef.current?.click()}>
                  <Upload size={14} />
                  {i18n.t('configureDrawerTabs.uploadSvg', { ns: 'modals', defaultValue: 'Upload SVG' })}
                </button>
                <textarea
                  className={styles.customIconTextarea}
                  value={customIconSource}
                  maxLength={DRAWER_CUSTOM_ICON_MAX_BYTES}
                  onChange={(event) => {
                    setCustomIconFileError('')
                    setCustomIconSource(event.target.value)
                  }}
                  placeholder={i18n.t('configureDrawerTabs.customIconPlaceholder', {
                    ns: 'modals',
                    defaultValue: 'Paste <svg>, <path>, or bare path data',
                  })}
                  aria-label={i18n.t('configureDrawerTabs.customIconPaste', { ns: 'modals', defaultValue: 'Paste SVG or path data' })}
                />
                {customIconError && <div className={styles.customIconError}>{customIconError}</div>}
                <button
                  type="button"
                  className={styles.customIconUseButton}
                  disabled={!customIconParse?.ok}
                  onClick={(event) => {
                    if (!customIconParse?.ok) return
                    onCustomIconChange(itemKey, customIconParse.icon)
                    setShowCustomIconImporter(false)
                    setCustomIconSource('')
                    event.currentTarget.closest('details')?.removeAttribute('open')
                  }}
                >
                  <Check size={14} />
                  {i18n.t('configureDrawerTabs.useIcon', { ns: 'modals', defaultValue: 'Use Icon' })}
                </button>
              </div>
            )}
          </div>
        </details>
        <input
          className={styles.nameInput}
          value={item.name}
          onChange={(event) => onRename(itemKey, event.target.value)}
          onBlur={(event) => {
            if (!event.target.value.trim()) onRename(itemKey, 'Folder')
          }}
          aria-label={i18n.t('configureDrawerTabs.folderName', { ns: 'modals', defaultValue: 'Folder name' })}
        />
        <span className={styles.folderCount}>{item.children.length}</span>
        <button
          type="button"
          className={styles.deleteButton}
          onClick={() => onDelete(itemKey)}
          title={i18n.t('configureDrawerTabs.deleteFolder', { ns: 'modals', defaultValue: 'Delete folder and return its tabs to the sidebar' })}
        >
          <Trash2 size={15} />
        </button>
      </div>

      <SortableContext items={childIds} strategy={verticalListSortingStrategy}>
        <div className={styles.folderChildren}>
          {item.children.length === 0 ? (
            <div className={styles.folderEmpty}>
              {i18n.t('configureDrawerTabs.folderEmpty', { ns: 'modals', defaultValue: 'Drop tabs here' })}
            </div>
          ) : item.children.map((tabId) => {
            const tab = entryMap.get(tabId)
            return (
              <SortableTabRow
                key={tabId}
                tabId={tabId}
                tab={tab}
                hidden={hiddenTabIds.has(tabId)}
                extension={extensionIds.has(tabId)}
                unavailable={!tab}
                nested
                onToggle={onToggle}
              />
            )
          })}
        </div>
      </SortableContext>
    </div>
  )
}

function RootDropZone({ active }: { active: boolean }) {
  const { isOver, setNodeRef } = useDroppable({ id: DRAWER_LAYOUT_ROOT_END_ID })
  return (
    <div
      ref={setNodeRef}
      className={clsx(styles.rootDropZone, active && styles.rootDropZoneVisible, isOver && styles.rootDropZoneOver)}
    >
      {i18n.t('configureDrawerTabs.rootDropZone', { ns: 'modals', defaultValue: 'Drop here to move to sidebar root' })}
    </div>
  )
}

export default function ConfigureDrawerTabsModal() {
  const { t } = useTranslation('modals')
  const closeModal = useStore((s) => s.closeModal)
  const setSetting = useStore((s) => s.setSetting)
  const drawerSettings = useStore((s) => s.drawerSettings)
  const drawerTabs = useStore((s) => s.drawerTabs)
  const extensions = useStore((s) => s.extensions)
  const enabledDrawerTabs = filterEnabledFrontendContributions(drawerTabs, extensions)
  const extensionEntries = useMemo(() => adaptExtensionTabs(enabledDrawerTabs), [enabledDrawerTabs])
  const [activeDragId, setActiveDragId] = useState<string | null>(null)

  const hiddenTabIds = useMemo(
    () => new Set(
      sanitizeHiddenDrawerTabIds(drawerSettings.hiddenTabIds).map(canonicalDrawerLayoutTabId),
    ),
    [drawerSettings.hiddenTabIds],
  )

  const entryMap = useMemo(() => {
    const entries = new Map<string, DrawerTabEntry>(DRAWER_TABS.map((tab) => [tab.id, tab]))
    for (const tab of extensionEntries) entries.set(canonicalDrawerLayoutTabId(tab.id), tab)
    return entries
  }, [extensionEntries])
  const extensionIds = useMemo(
    () => new Set(extensionEntries.map((tab) => canonicalDrawerLayoutTabId(tab.id))),
    [extensionEntries],
  )

  const layout = useMemo(() => reconcileDrawerLayout({
    layout: drawerSettings.layout,
    builtInIds: DRAWER_TABS.map((tab) => tab.id),
    extensionIds: extensionEntries.map((tab) => tab.id),
    legacyTabOrder: drawerSettings.tabOrder,
  }), [drawerSettings.layout, drawerSettings.tabOrder, extensionEntries])

  const rootSortableIds = useMemo(() => new Set(layout.map(drawerLayoutItemKey)), [layout])
  const collisionDetection = useMemo<CollisionDetection>(() => (args) => {
    const activeLocation = findDrawerLayoutLocation(layout, String(args.active.id))
    const collisions = closestCenter(args)
    if (activeLocation?.kind === 'root' && activeLocation.item.type !== 'tab') {
      return collisions.filter((collision) => rootSortableIds.has(String(collision.id)))
    }
    return collisions
  }, [layout, rootSortableIds])

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const persistLayout = (next: DrawerLayoutItem[]) => {
    const normalized = sanitizeDrawerLayout(next)
    setSetting('drawerSettings', {
      ...drawerSettings,
      layout: normalized,
      tabOrder: flattenDrawerLayoutTabIds(normalized),
    })
  }

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

  const handleDragStart = (event: DragStartEvent) => setActiveDragId(String(event.active.id))

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragId(null)
    const { active, over } = event
    if (!over) return
    const next = moveDrawerLayoutItem(layout, String(active.id), String(over.id))
    persistLayout(next)
  }

  const addFolder = () => {
    persistLayout([
      ...layout,
      {
        type: 'folder',
        id: createDrawerLayoutContainerId('folder'),
        name: t('configureDrawerTabs.newFolder', { defaultValue: 'New Folder' }),
        icon: 'folder',
        children: [],
      },
    ])
  }

  const addDivider = () => {
    persistLayout([
      ...layout,
      { type: 'divider', id: createDrawerLayoutContainerId('divider') },
    ])
  }

  const activeLocation = activeDragId ? findDrawerLayoutLocation(layout, activeDragId) : null
  const rootIds = layout.map(drawerLayoutItemKey)

  return (
    <ModalShell isOpen onClose={closeModal} maxWidth={760} className={styles.modal}>
      <CloseButton onClick={closeModal} variant="solid" position="absolute" />

      <div className={styles.header} data-drawer-configure-header>
        <div>
          <h3 className={styles.title}>{t('configureDrawerTabs.title')}</h3>
          <p className={styles.subtitle} data-drawer-configure-subtitle>
            {t('configureDrawerTabs.organizerSubtitle', {
              defaultValue: 'Organize the sidebar with tabs, folders, and movable dividers. Core tabs stay accessible even when tucked into folders.',
            })}
          </p>
        </div>
        <div className={styles.headerActions} data-drawer-configure-organize-actions>
          <button type="button" className={styles.addButton} onClick={addFolder}>
            <FolderPlus size={16} />
            {t('configureDrawerTabs.addFolder', { defaultValue: 'Add Folder' })}
          </button>
          <button type="button" className={styles.addButton} onClick={addDivider}>
            <Plus size={16} />
            {t('configureDrawerTabs.addDivider', { defaultValue: 'Add Divider' })}
          </button>
        </div>
      </div>

      <div className={styles.body} data-drawer-configure-organize-panel>
        <div className={styles.organizerHint}>
          {t('configureDrawerTabs.organizerHint', {
            defaultValue: 'Drop a tab onto a folder to tuck it inside. Drop a foldered tab onto a root tab/divider, or the root target below, to pull it back out.',
          })}
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          onDragStart={handleDragStart}
          onDragCancel={() => setActiveDragId(null)}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={rootIds} strategy={verticalListSortingStrategy}>
            <div className={styles.list}>
              {layout.map((item) => {
                if (item.type === 'divider') {
                  return (
                    <SortableDividerRow
                      key={drawerLayoutItemKey(item)}
                      item={item}
                      onRename={(itemKey, value) => persistLayout(updateDrawerLayoutContainer(layout, itemKey, value))}
                      onDelete={(itemKey) => persistLayout(removeDrawerLayoutContainer(layout, itemKey))}
                    />
                  )
                }

                if (item.type === 'folder') {
                  return (
                    <SortableFolderRow
                      key={drawerLayoutItemKey(item)}
                      item={item}
                      entryMap={entryMap}
                      extensionIds={extensionIds}
                      hiddenTabIds={hiddenTabIds}
                      onToggle={handleToggle}
                      onRename={(itemKey, value) => persistLayout(updateDrawerLayoutContainer(layout, itemKey, value))}
                      onIconChange={(itemKey, icon) => persistLayout(updateDrawerLayoutFolderIcon(layout, itemKey, icon))}
                      onCustomIconChange={(itemKey, icon) => persistLayout(updateDrawerLayoutFolderCustomIcon(layout, itemKey, icon))}
                      onDelete={(itemKey) => persistLayout(removeDrawerLayoutContainer(layout, itemKey))}
                    />
                  )
                }

                const tab = entryMap.get(item.tabId)
                return (
                  <SortableTabRow
                    key={drawerLayoutItemKey(item)}
                    tabId={item.tabId}
                    tab={tab}
                    hidden={hiddenTabIds.has(item.tabId)}
                    extension={extensionIds.has(item.tabId)}
                    unavailable={!tab}
                    onToggle={handleToggle}
                  />
                )
              })}
            </div>
          </SortableContext>

          <RootDropZone active={activeLocation?.kind === 'folder-child'} />
        </DndContext>
      </div>
    </ModalShell>
  )
}
