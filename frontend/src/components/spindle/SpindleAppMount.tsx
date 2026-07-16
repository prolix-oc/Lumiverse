import { useEffect, useRef } from 'react'
import type { AppMountState } from '@/store/slices/spindle-placement'
import { getLiveRootRecordExact } from '@/lib/spindle/live-root-registry'
import { scheduleSpindleDomTask } from '@/lib/spindle/browser-scheduler'

interface Props {
  mount: AppMountState
}

export default function SpindleAppMount({ mount }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!containerRef.current) {
      const el = document.createElement('div')
      el.setAttribute('data-spindle-app-mount', mount.extensionId)
      el.setAttribute('data-spindle-mount-id', mount.id)
      if (mount.className) el.className = mount.className
      containerRef.current = el
    }

    const container = containerRef.current
    container.style.display = mount.visible ? '' : 'none'

    const cancel = scheduleSpindleDomTask(() => {
      if (!getLiveRootRecordExact(mount.extensionId, mount.root)) return
      if (!container.isConnected && !document.body.isConnected) return

      if (!container.contains(mount.root)) {
        container.replaceChildren(mount.root)
      }

      if (mount.position === 'app-overlay') {
        const appRoot = document.querySelector('[data-app-root]')
        if (appRoot) {
          container.style.position = 'relative'
          container.style.zIndex = '9990'
          appRoot.appendChild(container)
        } else {
          container.style.position = ''
          container.style.zIndex = ''
          document.body.appendChild(container)
        }
      } else if (mount.position === 'start') {
        container.style.position = ''
        container.style.zIndex = ''
        document.body.insertBefore(container, document.body.firstChild)
      } else {
        container.style.position = ''
        container.style.zIndex = ''
        document.body.appendChild(container)
      }
    }, { phase: 'paint' })

    return () => {
      cancel()
      try { container.remove() } catch { /* no-op */ }
    }
  }, [mount.id, mount.extensionId, mount.className, mount.position, mount.visible, mount.root])

  return null
}
