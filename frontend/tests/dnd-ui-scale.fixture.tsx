import { StrictMode, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { closestCenter, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core'
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { DndContext, useScaledSortableStyle } from '../src/lib/dndUiScale'
import styles from '../src/components/panels/SpindlePanel.module.css'
import '../src/theme/reset.css'

const initialIds = Array.from({ length: 16 }, (_, index) => `row-${index}`)

function Row({ id }: { id: string }) {
  const sortable = useSortable({ id })
  const { setNodeRef, style } = useScaledSortableStyle(sortable)
  return <div id={id} ref={setNodeRef} style={style}
    className={[styles.extensionCard, styles.extensionCardList, styles.extensionCardManual, sortable.isDragging && styles.extensionCardDragging].filter(Boolean).join(' ')}>
    <button className={styles.dragHandle} ref={sortable.setActivatorNodeRef} {...sortable.attributes} {...sortable.listeners} aria-label={`Drag ${id}`}>⠿</button>
    <div className={styles.extensionHeader}>
      <div className={styles.extensionInfo}>
        <strong className={styles.extensionName}>{id}</strong>
        <span className={styles.extensionMeta}>Operator · 5/5 permissions</span>
      </div>
    </div>
    {Number(id.split('-')[1]) % 2 === 0 && <div>Additional permissions and branch information</div>}
  </div>
}

function Fixture() {
  const [ids, setIds] = useState(initialIds)
  const [scale, setScale] = useState(1)
  const [autoScroll, setAutoScroll] = useState(false)
  const [rectStrategy, setRectStrategy] = useState(false)
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  useLayoutEffect(() => { document.documentElement.style.setProperty('--lumiverse-ui-scale', String(scale)) }, [scale])
  useLayoutEffect(() => {
    Object.assign(window, { dndFixture: { setScale, setAutoScroll, setRectStrategy, reset: () => setIds(initialIds) } })
  }, [])
  return <div id="outer-scroll" style={{ position: 'absolute', top: 24, left: 24, width: 340, height: 400, overflow: 'auto' }}>
    <div style={{ width: 440, height: 800, padding: 24 }}>
      <div id="inner-scroll" style={{ width: 360, height: 320, overflow: 'auto' }}>
        <DndContext sensors={sensors} autoScroll={autoScroll} collisionDetection={closestCenter}
          onDragEnd={({ active, over }) => { if (over) setIds(items => arrayMove(items, items.indexOf(String(active.id)), items.indexOf(String(over.id)))) }}>
          <div id="rows" className={styles.extensionList}>
            <SortableContext items={ids} strategy={rectStrategy ? rectSortingStrategy : verticalListSortingStrategy}>
              {ids.map(id => <Row key={id} id={id} />)}
            </SortableContext>
          </div>
        </DndContext>
      </div>
    </div>
  </div>
}

createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>)
