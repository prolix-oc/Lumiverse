import { useConnectionEditor } from '@/hooks/useConnectionEditor'
import { connectionRowId, type ConnectionPlacement } from '@/lib/connectionPlacement'
import { useScaledSortable } from '@/lib/dndUiScale'
import { useDragHandleBlur } from './useDragHandleBlur'

export function useConnectionRow(profileId: string, placement: ConnectionPlacement) {
  const editor = useConnectionEditor(profileId, placement)
  const sortable = useScaledSortable({
    id: connectionRowId(profileId, placement),
    disabled: {
      draggable: placement !== 'list' || editor.dragDisabled,
      droppable: placement !== 'list',
    },
  })
  const handleRef = useDragHandleBlur(sortable.isDragging)
  return { ...editor, ...sortable, handleRef, isRecent: placement === 'recent' }
}
