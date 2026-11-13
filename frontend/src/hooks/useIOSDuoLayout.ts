import { useEffect, useState } from 'react'
import { resolveDuoLayout, subscribeIOSLayout, type IOSLayoutSnapshot } from '@/lib/ios-duo-layout'
import { getUiScale } from '@/lib/uiScale'

export function useIOSLayoutSnapshot() {
  const [snapshot, setSnapshot] = useState<IOSLayoutSnapshot | null>(null)
  useEffect(() => subscribeIOSLayout(setSnapshot), [])
  return snapshot
}

export function useIOSDuoLayout(side: 'left' | 'right', enabled = true) {
  const snapshot = useIOSLayoutSnapshot()
  const [scale, setScale] = useState(getUiScale)
  useEffect(() => {
    const observer = new MutationObserver(() => setScale(getUiScale()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
    return () => observer.disconnect()
  }, [])
  return enabled ? resolveDuoLayout(snapshot, side, scale) : null
}
