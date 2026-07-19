import { useEffect, useRef } from 'react'
import type { CharacterEditorTabState } from '@/store/slices/spindle-placement'
import { getLiveRootRecordExact } from '@/lib/spindle/live-root-registry'
import { scheduleSpindleDomTask } from '@/lib/spindle/browser-scheduler'

interface Props {
  tab: CharacterEditorTabState
}

export default function SpindleCharacterEditorTabContent({ tab }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    return scheduleSpindleDomTask(() => {
      if (!getLiveRootRecordExact(tab.extensionId, tab.root)) return
      if (!host.isConnected) return
      if (!host.contains(tab.root)) {
        host.replaceChildren(tab.root)
      }
    }, { phase: 'paint' })
  }, [tab.extensionId, tab.root])

  return <div ref={hostRef} style={{ width: '100%', minHeight: 0 }} />
}
