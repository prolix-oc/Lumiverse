import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { AppMountState } from '@/store/slices/spindle-placement'

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

    if (!container.contains(mount.root)) {
      container.replaceChildren(mount.root)
    }

    if (mount.position === 'start') {
      document.body.insertBefore(container, document.body.firstChild)
    } else {
      document.body.appendChild(container)
    }

    return () => {
      try { container.remove() } catch { /* no-op */ }
    }
  }, [mount.id, mount.extensionId, mount.className, mount.position, mount.visible, mount.root])

  return null
}
