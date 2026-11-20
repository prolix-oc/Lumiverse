import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { initI18n } from '@/i18n'
import { useStore } from '@/store'
import CharacterProfile from '@/components/panels/CharacterProfile'
import '@/theme/variables.css'
import '@/theme/reset.css'
import '@/theme/global.css'

// Browser diagnostics supply isolated characters before this module loads.
const probeWindow = window as typeof window & {
  profileCharacters: import('@/types/api').Character[]
  profileRenderingMode: string
  profileProbe?: { select(id: string): void }
}
await initI18n()
document.documentElement.dataset.renderingMode = probeWindow.profileRenderingMode
useStore.setState({
  characters: probeWindow.profileCharacters,
  activeCharacterId: probeWindow.profileCharacters[0].id,
  isGroupChat: false,
  personas: [],
})
probeWindow.profileProbe = { select: id => useStore.setState({ activeCharacterId: id }) }
createRoot(document.getElementById('root')!).render(<MemoryRouter><CharacterProfile /></MemoryRouter>)
