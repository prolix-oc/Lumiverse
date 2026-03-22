import { useStore } from '@/store'
import SpindleFloatWidget from './SpindleFloatWidget'
import SpindleDockPanel from './SpindleDockPanel'
import SpindleAppMount from './SpindleAppMount'

export default function SpindleUIManager() {
  const floatWidgets = useStore((s) => s.floatWidgets)
  const dockPanels = useStore((s) => s.dockPanels)
  const appMounts = useStore((s) => s.appMounts)
  const hiddenPlacements = useStore((s) => s.hiddenPlacements)

  return (
    <>
      {floatWidgets
        .filter((w) => w.visible && !hiddenPlacements.includes(w.id))
        .map((w) => (
          <SpindleFloatWidget key={w.id} widget={w} />
        ))}

      {dockPanels
        .filter((p) => !hiddenPlacements.includes(p.id))
        .map((p) => (
          <SpindleDockPanel key={p.id} panel={p} />
        ))}

      {appMounts
        .filter((m) => !hiddenPlacements.includes(m.id))
        .map((m) => (
          <SpindleAppMount key={m.id} mount={m} />
        ))}
    </>
  )
}
