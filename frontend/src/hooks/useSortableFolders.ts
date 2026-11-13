import { useRef, useState, type RefObject } from 'react'
import { closestCenter, pointerWithin, MeasuringStrategy, type CollisionDetection, type DragEndEvent, type DragOverEvent, type KeyboardCoordinateGetter } from '@dnd-kit/core'
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { useSortableListSensors, useVerticalSortModifier } from './useSortableList'

export interface SortableFolderGroup {
  id: string
  items: string[]
}

export const sortableFolderId = (id: string) => `folder:${id}`
const isFolder = (id: string | number) => String(id).startsWith('folder:')
const containingFolder = (groups: SortableFolderGroup[], item: string) => groups.find(group => group.items.includes(item))?.id

const keyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  const folderDrag = args.context.active && isFolder(args.context.active.id)
  const droppableRects = new Map([...args.context.droppableRects].filter(([id, rect]) =>
    rect.width > 0 && rect.height > 0 && (!folderDrag || isFolder(id))))
  return sortableKeyboardCoordinates(event, { ...args, context: { ...args.context, droppableRects } })
}

const collisionDetection: CollisionDetection = args => {
  if (isFolder(args.active.id)) {
    const folders = { ...args, droppableContainers: args.droppableContainers.filter(item => isFolder(item.id)) }
    const hits = pointerWithin(folders)
    return hits.length ? hits : closestCenter(folders)
  }
  const hits = pointerWithin(args)
  // Include the source slot: excluding it turns ordinary row sorting into a
  // folder drop and makes the displacement disappear under the pointer.
  const rows = hits.filter(hit => !isFolder(hit.id))
  return rows.length ? rows : hits.length ? hits : closestCenter(args)
}

/**
 * Native sortable lists with a transient cross-folder membership preview.
 * The caller owns data and persistence; cancel never calls a commit callback.
 * Both folder containers and their rows use verticalListSortingStrategy.
 */
export function useSortableFolders({ groups, listRef, disabled, filtered, onExpand, onMove, onReorder }: {
  groups: SortableFolderGroup[]
  listRef: RefObject<HTMLDivElement | null>
  disabled: boolean
  filtered: boolean
  onExpand: (folderId: string) => void
  onMove: (itemId: string, folderId: string, orderedIds: string[]) => void
  onReorder: (folderIds: string[]) => void
}) {
  // Expanded containers have unequal heights. Keyboard arrows choose a logical
  // neighbor; pointer collisions still use the measured rectangles. Otherwise
  // a tall group's center can remain closer to itself than the short next group.
  const keyboardFolderTarget = useRef<string | null>(null)
  const folderKeyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
    if (!args.context.active || !isFolder(args.context.active.id)) return keyboardCoordinates(event, args)
    const direction = event.code === 'ArrowDown' ? 1 : event.code === 'ArrowUp' ? -1 : 0
    if (!direction) return
    event.preventDefault()
    const current = keyboardFolderTarget.current ?? String(args.context.active.id)
    const index = groups.findIndex(group => sortableFolderId(group.id) === current)
    const next = groups[index + direction]
    if (!next) return
    const id = sortableFolderId(next.id)
    const rect = args.context.droppableRects.get(id)
    if (!rect) return
    keyboardFolderTarget.current = id
    return { x: rect.left, y: rect.top }
  }
  const sensors = useSortableListSensors(folderKeyboardCoordinates)
  const restrictToList = useVerticalSortModifier(listRef)
  const [activeItem, setActiveItem] = useState<string | null>(null)
  const [preview, setPreview] = useState<SortableFolderGroup[] | null>(null)
  const displayed = preview ?? groups
  const sourceFolder = activeItem ? containingFolder(groups, activeItem) : undefined
  const previewFolder = activeItem ? containingFolder(displayed, activeItem) : undefined

  const clear = () => { setActiveItem(null); setPreview(null); keyboardFolderTarget.current = null }
  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over || isFolder(active.id)) return
    const source = String(active.id)
    const target = String(over.id)
    const to = isFolder(target) ? target.slice(7) : containingFolder(displayed, target)
    if (to === undefined) return
    onExpand(to)
    setPreview(current => {
      if (!current) return current
      const from = containingFolder(current, source)
      if (from === undefined || from === to) return current
      return current.map(group => {
        if (group.id === from) return { ...group, items: group.items.filter(id => id !== source) }
        if (group.id !== to) return group
        const index = group.items.indexOf(target)
        const below = active.rect.current.translated && active.rect.current.translated.top > over.rect.top + over.rect.height / 2
        const insertion = index < 0 ? group.items.length : index + (below ? 1 : 0)
        return { ...group, items: [...group.items.slice(0, insertion), source, ...group.items.slice(insertion)] }
      })
    })
  }

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    clear()
    if (disabled || !over) return
    const source = String(active.id)
    const target = String(over.id)
    if (isFolder(source)) {
      if (filtered || source === target) return
      const ids = groups.map(group => sortableFolderId(group.id))
      const from = ids.indexOf(source), to = ids.indexOf(target)
      if (from >= 0 && to >= 0) onReorder(arrayMove(ids, from, to).map(id => id.slice(7)))
      return
    }
    if (!preview) return
    const folder = containingFolder(preview, source)
    if (folder === undefined) return
    const ids = preview.flatMap(group => group.items)
    const from = ids.indexOf(source), to = ids.indexOf(target)
    const ordered = !filtered && from >= 0 && to >= 0 ? arrayMove(ids, from, to) : ids
    const original = groups.flatMap(group => group.items)
    if (folder !== containingFolder(groups, source) || ordered.some((id, index) => id !== original[index])) {
      onMove(source, folder, ordered)
    }
  }

  return {
    groups: displayed,
    activeItem,
    receivingFolder: sourceFolder !== previewFolder ? previewFolder : undefined,
    contextProps: {
      sensors,
      modifiers: [restrictToList],
      collisionDetection: (args: Parameters<CollisionDetection>[0]) => {
        const target = keyboardFolderTarget.current
        return !args.pointerCoordinates && isFolder(args.active.id) && target
          ? [{ id: target }] : collisionDetection(args)
      },
      measuring: { droppable: { strategy: MeasuringStrategy.Always } },
      onDragStart: ({ active }: { active: { id: string | number } }) => {
        keyboardFolderTarget.current = null
        if (disabled || isFolder(active.id)) return
        setActiveItem(String(active.id))
        setPreview(groups)
      },
      onDragOver,
      onDragEnd,
      onDragCancel: clear,
    },
  }
}
