import { useEffect, useRef } from 'react'
import type { PresetEditorToolbarItemState } from '@/store/slices/spindle-placement'
import { scheduleSpindleDomTask } from '@/lib/spindle/browser-scheduler'

interface Props {
  item: PresetEditorToolbarItemState
}

/** Mount one extension-owned preset toolbar root without sharing host DOM. */
export default function SpindlePresetEditorToolbarItem({ item }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    return scheduleSpindleDomTask(() => {
      if (!host.isConnected) return
      if (!host.contains(item.root)) host.replaceChildren(item.root)
    }, { phase: 'paint' })
  }, [item.root])

  return <div ref={hostRef} role="group" aria-label={item.ariaLabel} />
}
