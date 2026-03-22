import { Eye, EyeOff, Layers } from 'lucide-react'
import { useStore } from '@/store'
import styles from './SpindleUIControlPanel.module.css'
import clsx from 'clsx'

export default function SpindleUIControlPanel() {
  const drawerTabs = useStore((s) => s.drawerTabs)
  const floatWidgets = useStore((s) => s.floatWidgets)
  const dockPanels = useStore((s) => s.dockPanels)
  const appMounts = useStore((s) => s.appMounts)
  const hiddenPlacements = useStore((s) => s.hiddenPlacements)
  const togglePlacementVisibility = useStore((s) => s.togglePlacementVisibility)
  const showAllPlacements = useStore((s) => s.showAllPlacements)
  const hideAllPlacements = useStore((s) => s.hideAllPlacements)

  const allItems = [
    ...drawerTabs.map((t) => ({ id: t.id, label: t.title, kind: 'Drawer Tab', ext: t.extensionId })),
    ...floatWidgets.map((w) => ({ id: w.id, label: w.tooltip || 'Float Widget', kind: 'Float Widget', ext: w.extensionId })),
    ...dockPanels.map((p) => ({ id: p.id, label: p.title, kind: `Dock (${p.edge})`, ext: p.extensionId })),
    ...appMounts.map((m) => ({ id: m.id, label: 'App Mount', kind: 'App Mount', ext: m.extensionId })),
  ]

  if (allItems.length === 0) return null

  const hiddenCount = allItems.filter((i) => hiddenPlacements.includes(i.id)).length

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <Layers size={13} />
        <span className={styles.headerLabel}>Extension UI ({allItems.length})</span>
        <div className={styles.headerActions}>
          <button className={styles.smallBtn} onClick={showAllPlacements} title="Show All">
            <Eye size={12} /> Show
          </button>
          <button className={styles.smallBtn} onClick={hideAllPlacements} title="Hide All">
            <EyeOff size={12} /> Hide
          </button>
        </div>
      </div>

      <div className={styles.list}>
        {allItems.map((item) => {
          const isHidden = hiddenPlacements.includes(item.id)
          return (
            <div key={item.id} className={clsx(styles.item, isHidden && styles.itemHidden)}>
              <div className={styles.itemInfo}>
                <span className={styles.itemLabel}>{item.label}</span>
                <span className={styles.itemMeta}>{item.kind}</span>
              </div>
              <button
                className={styles.toggleBtn}
                onClick={() => togglePlacementVisibility(item.id)}
                title={isHidden ? 'Show' : 'Hide'}
              >
                {isHidden ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
