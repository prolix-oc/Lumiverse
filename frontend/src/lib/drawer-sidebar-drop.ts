import type { DrawerLayoutItem } from '@/types/store'
import {
  createDrawerLayoutFolderFromTabs,
  DRAWER_LAYOUT_ROOT_END_ID,
  DRAWER_LAYOUT_ROOT_START_ID,
  drawerLayoutItemKey,
  findDrawerLayoutLocation,
  moveDrawerLayoutItem,
  moveDrawerLayoutItemToRoot,
} from './drawer-layout'

export type DrawerSidebarDropSide = 'before' | 'inside' | 'after'
export type DrawerSidebarRect = { top: number; left: number; width: number; height: number }

type DividerInsertionSide = 'before' | 'after'

// A divider's two hit halves represent precise root insertion boundaries.
// They are intentionally NOT sortable layout items or draggable themselves.
export function drawerSidebarDividerDropId(dividerId: string, side: DividerInsertionSide): string {
  return `drawer-layout:divider-drop:${side}:${dividerId}`
}

function dividerInsertionTarget(layout: DrawerLayoutItem[], dropId: string): { id: string; side: DividerInsertionSide } | null {
  const match = /^drawer-layout:divider-drop:(before|after):(.+)$/.exec(dropId)
  if (!match) return null
  const id = `divider:${match[2]}`
  const location = findDrawerLayoutLocation(layout, id)
  if (location?.kind !== 'root' || location.item.type !== 'divider') return null
  return { id, side: match[1] as DividerInsertionSide }
}

/** Screen-space drop zones work for the vertical desktop rail and the horizontal mobile rail. */
export function drawerSidebarDropSide(
  dragged: DrawerSidebarRect | null | undefined,
  target: DrawerSidebarRect | null | undefined,
  horizontal: boolean,
): DrawerSidebarDropSide {
  if (!dragged || !target) return 'inside'
  const size = horizontal ? target.width : target.height
  if (!size) return 'inside'
  const center = horizontal ? dragged.left + dragged.width / 2 : dragged.top + dragged.height / 2
  const offset = (center - (horizontal ? target.left : target.top)) / size
  return offset < 0.25 ? 'before' : offset > 0.75 ? 'after' : 'inside'
}

/** Keep dnd-kit’s rendered drag inside the rail’s axis. A horizontal
 * transform inside an overflow-y:auto column makes its scrollWidth grow,
 * allowing auto-scroll to push every icon sideways during desktop dragging. */
export function constrainDrawerSidebarDrag<T extends { x: number; y: number }>(transform: T, horizontal: boolean): T {
  return horizontal ? { ...transform, y: 0 } : { ...transform, x: 0 }
}

/** The dwell gesture is valid only for two distinct tabs at the root level. */
export function canMergeDrawerSidebarTabs(layout: DrawerLayoutItem[], activeId: string, overId: string): boolean {
  if (activeId === overId) return false
  const active = findDrawerLayoutLocation(layout, activeId)
  const over = findDrawerLayoutLocation(layout, overId)
  return Boolean(active && (active.kind === 'folder-child' || active.item.type === 'tab')
    && over?.kind === 'root' && over.item.type === 'tab')
}

/** A single model operation for desktop mouse and mobile touch.
 * Unknown IDs and missing geometry never write a corrupted layout. */
export function applyDrawerSidebarDrop(
  layout: DrawerLayoutItem[],
  activeId: string,
  overId: string | null,
  side: DrawerSidebarDropSide,
  mergeReady = false,
): DrawerLayoutItem[] {
  if (!overId || overId === activeId || !findDrawerLayoutLocation(layout, activeId)) return layout
  const divider = dividerInsertionTarget(layout, overId)
  if (divider) return moveDrawerLayoutItemToRoot(layout, activeId, divider.id, divider.side)
  if (overId === DRAWER_LAYOUT_ROOT_END_ID) return moveDrawerLayoutItem(layout, activeId, overId)
  if (overId === DRAWER_LAYOUT_ROOT_START_ID) {
    return layout.length ? moveDrawerLayoutItemToRoot(layout, activeId, drawerLayoutItemKey(layout[0]), 'before') : layout
  }
  if (mergeReady && side === 'inside' && canMergeDrawerSidebarTabs(layout, activeId, overId)) {
    return createDrawerLayoutFolderFromTabs(layout, activeId, overId)
  }

  const target = findDrawerLayoutLocation(layout, overId)
  if (!target) return layout
  if (target.kind === 'folder-child') return moveDrawerLayoutItem(layout, activeId, overId)
  if (target.item.type === 'folder' && side === 'inside') {
    return moveDrawerLayoutItem(layout, activeId, overId)
  }
  // A quick release over the middle of an ordinary tab must reorder, not merge.
  // Direction is based on the source's current position rather than an arbitrary
  // DOM hit order, so an upward release always inserts before the target.
  const active = findDrawerLayoutLocation(layout, activeId)
  const direction = side === 'inside'
    ? (active?.kind === 'root' && active.index < target.index ? 'after' : 'before')
    : side
  return moveDrawerLayoutItemToRoot(layout, activeId, overId, direction)
}
