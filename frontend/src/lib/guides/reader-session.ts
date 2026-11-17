import { createStore } from 'zustand/vanilla'
import type { GuideDefinition } from './types'

export const GUIDE_HOME = {
  kind: 'builtin',
  path: 'index.md',
  title: 'Lumiverse Guides',
} as const

interface GuideRequest {
  guide: GuideDefinition
  title: string
}

export const guideReaderSession = createStore<{
  request: GuideRequest | null
  isOpen: boolean
  activation: number
  returnFocus: HTMLElement | null
}>(() => ({ request: null, isOpen: false, activation: 0, returnFocus: null }))

export function openGuide(guide: GuideDefinition, title: string, trigger: HTMLElement | null) {
  guideReaderSession.setState({
    request: { guide, title },
    isOpen: true,
    activation: guideReaderSession.getState().activation + 1,
    returnFocus: trigger,
  })
}

export function closeGuide() {
  const { returnFocus } = guideReaderSession.getState()
  guideReaderSession.setState({ isOpen: false, returnFocus: null })
  if (returnFocus?.isConnected) returnFocus.focus()
}
