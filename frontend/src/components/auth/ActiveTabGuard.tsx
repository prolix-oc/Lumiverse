import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import WallpaperLayer from '@/components/shared/WallpaperLayer'
import { ModalShell } from '@/components/shared/ModalShell'
import { Button } from '@/components/shared/FormComponents'
import { activeTab } from '@/lib/active-tab'
import styles from './ActiveTabGuard.module.css'

function captureBackground() {
  const state = useStore.getState()
  const character = state.useCharacterBackground
    ? state.characters.find(item => item.id === state.activeCharacterId) : undefined
  const greeting = (state.activeChatMetadata?.activeGreetingIndex as number) ?? 0
  const backgrounds = character?.extensions?.greeting_backgrounds as Record<number, string> | undefined
  const imageId = backgrounds?.[greeting] || character?.image_id
  return {
    wallpaper: state.activeChatWallpaper ?? state.wallpaper.global ?? (imageId ? { type: 'image' as const, image_id: imageId } : null),
    settings: state.wallpaper,
    scene: state.sceneBackground,
    sceneOpacity: Math.max(0, Math.min(1, state.imageGeneration.backgroundOpacity ?? 0.35)),
  }
}

export default function ActiveTabGuard({ children }: { children: ReactNode }) {
  const userId = useStore(state => state.user?.id)
  const [background, setBackground] = useState(captureBackground)
  const { t } = useTranslation('shared')
  const [readyUser, setReadyUser] = useState<string | null>(null)
  const [blocked, setBlocked] = useState(activeTab.signal.aborted)

  useEffect(() => {
    if (!userId || activeTab.signal.aborted) return
    const onBlocked = () => {
      setBackground(captureBackground())
      setBlocked(true)
    }
    activeTab.signal.addEventListener('abort', onBlocked, { once: true })
    const release = activeTab.claim(userId)
    setReadyUser(userId)
    return () => {
      release()
      activeTab.signal.removeEventListener('abort', onBlocked)
    }
  }, [userId])

  if (blocked) return (
    <main className={styles.page}>
      <WallpaperLayer wallpaper={background.wallpaper} settings={background.settings} hidden={!!background.scene} />
      {background.scene && <div className={styles.scene} style={{ backgroundImage: `url(${JSON.stringify(background.scene)})`, opacity: background.sceneOpacity }} />}
      <ModalShell isOpen onClose={() => {}} closeOnBackdrop={false} closeOnEscape={false} maxWidth={420} scrollable className={styles.card}>
        <div role="alert">
          <h1>{t('inactiveTab.title', 'This tab is inactive')}</h1>
          <p>{t('inactiveTab.message', 'Another tab is using this account. Reload this tab to take over.')}</p>
          <Button variant="primary" onClick={() => window.location.reload()}>
            {t('inactiveTab.reload', 'Reload this tab')}
          </Button>
          <p className={styles.hint}>
            {t('inactiveTab.settingsHint', 'You can forcefully disable this in:')}{' '}
            <span className={styles.settingsPath}>{t('inactiveTab.settingsPath', 'Settings → Account → Enforce one active browser tab')}</span>
          </p>
        </div>
      </ModalShell>
    </main>
  )
  return userId && readyUser === userId ? children : null
}
