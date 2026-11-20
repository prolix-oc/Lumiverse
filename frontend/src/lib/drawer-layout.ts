import type { DrawerCustomIconData, DrawerLayoutItem, DrawerSettings } from '@/types/store'
import { sanitizeDrawerCustomIconData } from '@/lib/drawer-custom-icon'
import { councilViewForTab } from '@/lib/council-navigation'
import { uuidv4 } from '@/lib/uuid'
export const DEFAULT_EXTENSION_DIVIDER_ID = 'extensions'
export const DRAWER_LAYOUT_ROOT_END_ID = 'drawer-layout:root-end'

export type DrawerLayoutLocation =
  | { kind: 'root'; index: number; item: DrawerLayoutItem }
  | { kind: 'folder-child'; folderIndex: number; childIndex: number; folderId: string; tabId: string }

function cleanString(value: unknown, maxLength = 160): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, maxLength)
}

function cleanEditableString(value: unknown, fallback: string, maxLength = 80): string {
  if (typeof value !== 'string') return fallback
  return value.slice(0, maxLength)
}

export function canonicalDrawerLayoutTabId(tabId: string): string {
  // Spindle placement IDs end in a process-local registration counter. That
  // counter changes on extension reloads, updates, and mobile/desktop remounts,
  // while everything before it is the extension + declared drawer-tab ID.
  const match = /^(spindle:.*:tab:.*):\d+$/.exec(tabId)
  return match?.[1] ?? tabId
}

/** Prune installation-owned references only after the installed list is known. */
export function reconcileExtensionDrawerSettings(
  settings: DrawerSettings,
  installedExtensionIds: ReadonlySet<string>,
): DrawerSettings {
  return pruneExtensionDrawerSettings(settings, (owner) => installedExtensionIds.has(owner))
}

/** A confirmed uninstall can prune its owner even while the list is refreshing. */
export function removeExtensionDrawerSettings(settings: DrawerSettings, extensionId: string): DrawerSettings {
  return pruneExtensionDrawerSettings(settings, (owner) => owner !== extensionId)
}

function pruneExtensionDrawerSettings(
  settings: DrawerSettings,
  keepOwner: (extensionId: string) => boolean,
): DrawerSettings {
  const keepTab = (tabId: string): boolean => {
    const owner = /^spindle:([^:]+):tab:.+/.exec(tabId)?.[1]
    return !owner || keepOwner(owner)
  }
  const pruneIds = (ids: string[]): string[] => {
    if (!Array.isArray(ids)) return ids
    const next = ids.filter(keepTab)
    return next.length === ids.length ? ids : next
  }
  let layout = settings.layout
  if (Array.isArray(layout)) {
    const next: DrawerLayoutItem[] = []
    for (const item of layout) {
      if (!item || typeof item !== 'object') {
        next.push(item)
        continue
      }
      if (item.type === 'tab' && !keepTab(item.tabId)) continue
      if (item.type === 'folder') {
        const children = pruneIds(item.children)
        next.push(children === item.children ? item : { ...item, children })
      } else {
        next.push(item)
      }
    }
    if (next.length !== layout.length || next.some((item, index) => item !== layout[index])) layout = next
  }
  const tabOrder = pruneIds(settings.tabOrder)
  const hiddenTabIds = pruneIds(settings.hiddenTabIds)
  if (layout === settings.layout && tabOrder === settings.tabOrder && hiddenTabIds === settings.hiddenTabIds) {
    return settings
  }
  return { ...settings, layout, tabOrder, hiddenTabIds }
}

function sanitizeLegacyTabOrder(tabOrder?: string[] | null): string[] {
  if (!Array.isArray(tabOrder)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of tabOrder) {
    if (typeof raw !== 'string' || raw.length === 0) continue
    const tabId = canonicalDrawerLayoutTabId(raw)
    if (councilViewForTab(tabId)) continue
    if (seen.has(tabId)) continue
    seen.add(tabId)
    result.push(tabId)
  }
  return result
}

export function drawerLayoutItemKey(item: DrawerLayoutItem): string {
  switch (item.type) {
    case 'tab': return `tab:${item.tabId}`
    case 'folder': return `folder:${item.id}`
    case 'divider': return `divider:${item.id}`
  }
}

export function drawerLayoutTabKey(tabId: string): string {
  return `tab:${tabId}`
}

export function sanitizeDrawerLayout(layout?: unknown): DrawerLayoutItem[] {
  if (!Array.isArray(layout)) return []

  const claimedTabs = new Set<string>()
  const claimedContainers = new Set<string>()
  const result: DrawerLayoutItem[] = []

  for (const raw of layout) {
    if (!raw || typeof raw !== 'object') continue
    const candidate = raw as Record<string, unknown>

    if (candidate.type === 'tab') {
      const rawTabId = cleanString(candidate.tabId)
      const tabId = rawTabId ? canonicalDrawerLayoutTabId(rawTabId) : null
      if (!tabId || councilViewForTab(tabId) || claimedTabs.has(tabId)) continue
      claimedTabs.add(tabId)
      result.push({ type: 'tab', tabId })
      continue
    }

    if (candidate.type === 'divider') {
      const id = cleanString(candidate.id, 96)
      if (!id || claimedContainers.has(`divider:${id}`)) continue
      claimedContainers.add(`divider:${id}`)
      const label = cleanEditableString(candidate.label, '', 80)
      result.push(label ? { type: 'divider', id, label } : { type: 'divider', id })
      continue
    }

    if (candidate.type === 'folder') {
      const id = cleanString(candidate.id, 96)
      if (!id || claimedContainers.has(`folder:${id}`)) continue
      claimedContainers.add(`folder:${id}`)
      const children: string[] = []
      if (Array.isArray(candidate.children)) {
        for (const rawChild of candidate.children) {
          const rawTabId = cleanString(rawChild)
          const tabId = rawTabId ? canonicalDrawerLayoutTabId(rawTabId) : null
          if (!tabId || councilViewForTab(tabId) || claimedTabs.has(tabId)) continue
          claimedTabs.add(tabId)
          children.push(tabId)
        }
      }
      const icon = cleanString(candidate.icon, 40)
      const customIcon = sanitizeDrawerCustomIconData(candidate.customIcon)
      const view = candidate.view === 'grid' ? 'grid' as const : candidate.view === 'list' ? 'list' as const : undefined
      result.push({
        type: 'folder',
        id,
        name: cleanEditableString(candidate.name, 'Folder', 80),
        ...(icon ? { icon } : {}),
        ...(customIcon ? { customIcon } : {}),
        ...(view ? { view } : {}),
        children,
      })
    }
  }

  return result
}

function orderedIds(ids: string[], legacyOrder: string[]): string[] {
  if (!legacyOrder.length || ids.length < 2) return [...ids]
  const orderIndex = new Map(legacyOrder.map((id, index) => [id, index]))
  return ids
    .map((id, index) => ({ id, index }))
    .sort((a, b) => {
      const ai = orderIndex.get(a.id) ?? Number.POSITIVE_INFINITY
      const bi = orderIndex.get(b.id) ?? Number.POSITIVE_INFINITY
      return ai === bi ? a.index - b.index : ai - bi
    })
    .map(({ id }) => id)
}

export function createDefaultDrawerLayout(options: {
  builtInIds: string[]
  extensionIds: string[]
  legacyTabOrder?: string[] | null
}): DrawerLayoutItem[] {
  const legacyOrder = sanitizeLegacyTabOrder(options.legacyTabOrder)
  const builtInIds = orderedIds([...new Set(options.builtInIds.map(canonicalDrawerLayoutTabId))], legacyOrder)
  const builtInIdSet = new Set(builtInIds)
  const knownExtensionIds = [...new Set(options.extensionIds.map(canonicalDrawerLayoutTabId))].filter((id) => !builtInIdSet.has(id))
  // Legacy tabOrder was the only persistence available before folders/dividers.
  // Keep IDs that are temporarily unknown so an extension that misses this boot
  // does not lose its place during the first organization edit after upgrade.
  const unavailableLegacyIds = legacyOrder.filter((id) => !builtInIdSet.has(id) && !knownExtensionIds.includes(id))
  const extensionIds = orderedIds([...knownExtensionIds, ...unavailableLegacyIds], legacyOrder)

  const layout: DrawerLayoutItem[] = builtInIds.map((tabId) => ({ type: 'tab', tabId }))
  if (extensionIds.length) {
    layout.push({ type: 'divider', id: DEFAULT_EXTENSION_DIVIDER_ID, label: 'Extensions' })
    layout.push(...extensionIds.map((tabId) => ({ type: 'tab' as const, tabId })))
  }
  return layout
}

export function flattenDrawerLayoutTabIds(layout: DrawerLayoutItem[]): string[] {
  const result: string[] = []
  for (const item of layout) {
    if (item.type === 'tab') result.push(item.tabId)
    else if (item.type === 'folder') result.push(...item.children)
  }
  return result
}

/**
 * Reconcile persisted organization with the tabs currently known to the host.
 * Saved unknown tab IDs are intentionally retained so temporarily unavailable
 * extensions return to the same position/folder when they register again.
 * Uninstalled owners are pruned separately after the installed list loads.
 */
export function reconcileDrawerLayout(options: {
  layout?: unknown
  builtInIds: string[]
  extensionIds: string[]
  legacyTabOrder?: string[] | null
}): DrawerLayoutItem[] {
  const saved = sanitizeDrawerLayout(options.layout)
  if (!saved.length) return createDefaultDrawerLayout(options)

  const result = saved.map((item) => (
    item.type === 'folder'
      ? { ...item, children: [...item.children] }
      : { ...item }
  ))
  const present = new Set(flattenDrawerLayoutTabIds(result))
  const current = [...new Set([...options.builtInIds, ...options.extensionIds].map(canonicalDrawerLayoutTabId))]

  for (const tabId of current) {
    if (present.has(tabId)) continue
    result.push({ type: 'tab', tabId })
    present.add(tabId)
  }

  return result
}

export function findDrawerLayoutLocation(layout: DrawerLayoutItem[], sortableId: string): DrawerLayoutLocation | null {
  for (let index = 0; index < layout.length; index += 1) {
    const item = layout[index]
    if (drawerLayoutItemKey(item) === sortableId) return { kind: 'root', index, item }
    if (item.type !== 'folder') continue
    const childIndex = item.children.findIndex((tabId) => drawerLayoutTabKey(tabId) === sortableId)
    if (childIndex >= 0) {
      return {
        kind: 'folder-child',
        folderIndex: index,
        childIndex,
        folderId: item.id,
        tabId: item.children[childIndex],
      }
    }
  }
  return null
}

function removeAtLocation(layout: DrawerLayoutItem[], location: DrawerLayoutLocation): DrawerLayoutItem[] {
  const next = layout.map((item) => item.type === 'folder' ? { ...item, children: [...item.children] } : { ...item })
  if (location.kind === 'root') {
    next.splice(location.index, 1)
    return next
  }
  const folder = next[location.folderIndex]
  if (folder?.type === 'folder') folder.children.splice(location.childIndex, 1)
  return next
}

/**
 * DnD semantics:
 * - tabs dropped on a folder row move into that folder;
 * - tabs dropped on folder children move/reorder inside that folder;
 * - tabs dropped on root tabs/dividers move back to root;
 * - folders/dividers always remain root-level;
 * - the special root-end target promotes/appends any tab to root.
 */
export function moveDrawerLayoutItem(layout: DrawerLayoutItem[], activeId: string, overId: string): DrawerLayoutItem[] {
  const clean = sanitizeDrawerLayout(layout)
  const active = findDrawerLayoutLocation(clean, activeId)
  if (!active) return clean

  if (overId === DRAWER_LAYOUT_ROOT_END_ID) {
    if (active.kind === 'root' && active.index === clean.length - 1) return clean
    const moving = active.kind === 'root' ? active.item : { type: 'tab' as const, tabId: active.tabId }
    const next = removeAtLocation(clean, active)
    next.push(moving)
    return next
  }

  const over = findDrawerLayoutLocation(clean, overId)
  if (!over || activeId === overId) return clean

  if (active.kind === 'root' && active.item.type !== 'tab') {
    const moving = active.item
    const targetRootIndex = over.kind === 'root' ? over.index : over.folderIndex
    const next = removeAtLocation(clean, active)
    const insertAt = Math.max(0, Math.min(targetRootIndex, next.length))
    next.splice(insertAt, 0, moving)
    return next
  }

  const movingTabId = active.kind === 'root' ? active.item.type === 'tab' ? active.item.tabId : null : active.tabId
  if (!movingTabId) return clean

  if (over.kind === 'root' && over.item.type === 'folder') {
    const targetFolderId = over.item.id
    if (active.kind === 'folder-child' && active.folderId === targetFolderId) return clean
    const next = removeAtLocation(clean, active)
    const folder = next.find((item): item is Extract<DrawerLayoutItem, { type: 'folder' }> => item.type === 'folder' && item.id === targetFolderId)
    if (!folder) return clean
    folder.children.push(movingTabId)
    return next
  }

  if (over.kind === 'folder-child') {
    const targetFolderId = over.folderId
    const targetChildIndex = over.childIndex
    const next = removeAtLocation(clean, active)
    const folder = next.find((item): item is Extract<DrawerLayoutItem, { type: 'folder' }> => item.type === 'folder' && item.id === targetFolderId)
    if (!folder) return clean
    folder.children.splice(Math.max(0, Math.min(targetChildIndex, folder.children.length)), 0, movingTabId)
    return next
  }

  if (over.kind === 'root') {
    const next = removeAtLocation(clean, active)
    if (active.kind === 'root') {
      const targetIndex = Math.max(0, Math.min(over.index, next.length))
      next.splice(targetIndex, 0, { type: 'tab', tabId: movingTabId })
      return next
    }

    const targetKey = drawerLayoutItemKey(over.item)
    const targetIndex = next.findIndex((item) => drawerLayoutItemKey(item) === targetKey)
    next.splice(targetIndex < 0 ? next.length : targetIndex, 0, { type: 'tab', tabId: movingTabId })
    return next
  }

  return clean
}

export function removeDrawerLayoutContainer(layout: DrawerLayoutItem[], itemKey: string): DrawerLayoutItem[] {
  const clean = sanitizeDrawerLayout(layout)
  const location = findDrawerLayoutLocation(clean, itemKey)
  if (!location || location.kind !== 'root') return clean
  if (location.item.type === 'tab') return clean

  if (location.item.type === 'divider') {
    const next = [...clean]
    next.splice(location.index, 1)
    return next
  }

  const next = [...clean]
  next.splice(
    location.index,
    1,
    ...location.item.children.map((tabId) => ({ type: 'tab' as const, tabId })),
  )
  return next
}

export function updateDrawerLayoutContainer(
  layout: DrawerLayoutItem[],
  itemKey: string,
  value: string,
): DrawerLayoutItem[] {
  return sanitizeDrawerLayout(layout).map((item) => {
    if (drawerLayoutItemKey(item) !== itemKey) return item
    if (item.type === 'folder') return { ...item, name: value.slice(0, 80) }
    if (item.type === 'divider') {
      const label = value.slice(0, 80)
      return label ? { ...item, label } : { type: 'divider', id: item.id }
    }
    return item
  })
}


export function updateDrawerLayoutFolderIcon(
  layout: DrawerLayoutItem[],
  itemKey: string,
  icon: string,
): DrawerLayoutItem[] {
  const nextIcon = cleanString(icon, 40)
  return sanitizeDrawerLayout(layout).map((item) => {
    if (drawerLayoutItemKey(item) !== itemKey || item.type !== 'folder') return item
    return nextIcon
      ? { ...item, icon: nextIcon, customIcon: undefined }
      : { ...item, icon: undefined, customIcon: undefined }
  })
}

export function updateDrawerLayoutFolderCustomIcon(
  layout: DrawerLayoutItem[],
  itemKey: string,
  customIcon: DrawerCustomIconData,
): DrawerLayoutItem[] {
  const safeIcon = sanitizeDrawerCustomIconData(customIcon)
  if (!safeIcon) return sanitizeDrawerLayout(layout)
  return sanitizeDrawerLayout(layout).map((item) => {
    if (drawerLayoutItemKey(item) !== itemKey || item.type !== 'folder') return item
    return { ...item, customIcon: safeIcon }
  })
}

export function updateDrawerLayoutFolderView(
  layout: DrawerLayoutItem[],
  itemKey: string,
  view: 'list' | 'grid',
): DrawerLayoutItem[] {
  return sanitizeDrawerLayout(layout).map((item) => {
    if (drawerLayoutItemKey(item) !== itemKey || item.type !== 'folder') return item
    return { ...item, view }
  })
}

export function createDrawerLayoutContainerId(prefix: 'folder' | 'divider'): string {
  return `${prefix}-${uuidv4()}`
}
