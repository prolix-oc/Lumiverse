import { useEffect } from 'react'
import { useStore } from 'zustand'
import { closeGuide, GUIDE_HOME, guideReaderSession, openGuide } from '@/lib/guides/reader-session'
import { GuideViewer } from './GuideViewer'

export function GuideReaderHost() {
  const { request, isOpen, activation } = useStore(guideReaderSession)
  useEffect(() => {
    function handleHelp(event: KeyboardEvent) {
      if (event.defaultPrevented || event.key !== 'F1' ||
          event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      event.preventDefault()
      if (event.repeat) return
      const current = guideReaderSession.getState()
      const active = document.activeElement
      const trigger = current.isOpen ? current.returnFocus
        : active instanceof HTMLElement ? active : null
      openGuide(current.request?.guide ?? GUIDE_HOME, current.request?.title ?? GUIDE_HOME.title, trigger)
    }
    document.addEventListener('keydown', handleHelp)
    return () => document.removeEventListener('keydown', handleHelp)
  }, [])
  return request && <GuideViewer {...request} isOpen={isOpen} activation={activation} onClose={closeGuide} />
}
