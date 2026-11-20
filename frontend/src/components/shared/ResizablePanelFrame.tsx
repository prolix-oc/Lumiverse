import type { CSSProperties, ReactNode } from 'react'
import { usePersistentRect, type RectBounds } from '@/hooks/usePersistentRect'
import type { SettingsWriteSource, SurfaceRectPrefs } from '@/types/store'
import styles from './ResizablePanelFrame.module.css'
export interface ResizablePanelFrameProps { rect: SurfaceRectPrefs; bounds: RectBounds; onCommit: (rect: SurfaceRectPrefs, source: SettingsWriteSource) => void; title?: ReactNode; toolbar?: ReactNode; children: ReactNode; className?: string; snapToEdge?: boolean; preserveAspectRatio?: boolean; aspectRatio?: number; persistGeometry?: string; showHeader?: boolean; resizable?: boolean; 'aria-label'?: string }
const handles = ['n','s','e','w','ne','nw','se','sw'] as const
export function ResizablePanelFrame({ rect, bounds, onCommit, title, toolbar, children, className, snapToEdge, preserveAspectRatio, aspectRatio, persistGeometry, showHeader = true, resizable = true, 'aria-label': ariaLabel }: ResizablePanelFrameProps) {
  const state = usePersistentRect({ rect, bounds, onCommit, snapToEdge, preserveAspectRatio, aspectRatio, persistGeometry })
  const style = { '--panel-x': `${state.rect.x}px`, '--panel-y': `${state.rect.y}px`, '--panel-width': `${state.rect.width}px`, '--panel-height': `${state.rect.height}px` } as CSSProperties
  return <section className={[styles.frame, className].filter(Boolean).join(' ')} style={style} aria-label={ariaLabel}>
    {showHeader && <div className={styles.header} onPointerDown={event => { event.stopPropagation(); state.startDrag('move', event) }}><div className={styles.title}>{title}</div><div className={styles.toolbar} onPointerDown={event => event.stopPropagation()}>{toolbar}</div></div>}
    <div className={styles.body}>{children}</div>
    {resizable && handles.map(handle => <button key={handle} type="button" className={`${styles.handle} ${styles[`handle${handle[0].toUpperCase()}${handle.slice(1)}` as keyof typeof styles]}`} aria-label={`Resize ${handle}`} onPointerDown={event => state.startDrag(handle, event)} />)}
  </section>
}
