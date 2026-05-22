import { useState, useCallback, useEffect, useMemo } from 'react'
import { motion } from 'motion/react'
import { ChevronUp } from 'lucide-react'
import { useStore } from '@/store'
import { chatsApi } from '@/api/chats'
import { imagesApi } from '@/api/images'
import LazyImage from '@/components/shared/LazyImage'
import styles from './AvatarSwitcherPopover.module.css'
import clsx from 'clsx'

interface AlternateAvatarEntry {
  id: string
  image_id: string
  label: string
}

interface Props {
  chatId: string
  children: React.ReactNode
}

const THUMBS_PER_ROW = 4
const MAX_VISIBLE_COLLAPSED = THUMBS_PER_ROW * 2

export default function AvatarSwitcherPopover({ chatId, children }: Props) {
  const [activeAvatarId, setActiveAvatarId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const characters = useStore((s) => s.characters)
  const character = characters.find((c) => c.id === activeCharacterId)
  const setActiveChatAvatarId = useStore((s) => s.setActiveChatAvatarId)

  const alternates = (character?.extensions?.alternate_avatars || []) as AlternateAvatarEntry[]

  const allAvatars = useMemo(() => {
    const list: { key: string; imageId: string | null; label: string }[] = []
    if (character?.image_id) {
      list.push({ key: 'primary', imageId: null, label: 'Primary' })
    }
    for (const entry of alternates) {
      list.push({ key: entry.id, imageId: entry.image_id, label: entry.label })
    }
    return list
  }, [character?.image_id, alternates])

  const needsOverflow = allAvatars.length > MAX_VISIBLE_COLLAPSED
  const visibleAvatars = expanded
    ? allAvatars
    : needsOverflow
      ? allAvatars.slice(0, MAX_VISIBLE_COLLAPSED - 1)
      : allAvatars
  const overflowCount = allAvatars.length - (MAX_VISIBLE_COLLAPSED - 1)

  useEffect(() => {
    if (!chatId || allAvatars.length < 2) return
    let cancelled = false
    chatsApi.get(chatId, { messages: false }).then((chat) => {
      if (cancelled) return
      setActiveAvatarId((chat.metadata?.active_avatar_id as string) || null)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [chatId, allAvatars.length])

  const handleSelect = useCallback(
    async (imageId: string | null) => {
      setActiveAvatarId(imageId)
      setActiveChatAvatarId(imageId)
      setExpanded(false)
      try {
        await chatsApi.patchMetadata(chatId, { active_avatar_id: imageId ?? null })
      } catch (err) {
        console.error('[AvatarSwitcher] Failed to save:', err)
      }
    },
    [chatId, setActiveChatAvatarId]
  )

  if (allAvatars.length < 2) return <>{children}</>

  return (
    <div className={styles.wrapper}>
      {children}

      <motion.div
        className={styles.strip}
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, delay: 0.15 }}
      >
        <div className={styles.thumbGrid}>
          {visibleAvatars.map((avatar) => {
            const isActive = avatar.imageId === null
              ? !activeAvatarId
              : activeAvatarId === avatar.imageId
            const src = avatar.imageId
              ? imagesApi.smallUrl(avatar.imageId)
              : character?.image_id
                ? imagesApi.smallUrl(character.image_id)
                : ''

            return (
              <button
                key={avatar.key}
                type="button"
                className={clsx(styles.thumb, isActive && styles.thumbActive)}
                onClick={() => handleSelect(avatar.imageId)}
                aria-label={avatar.label}
                aria-pressed={isActive}
                title={avatar.label}
              >
                <LazyImage
                  src={src}
                  alt={avatar.label}
                  className={styles.thumbImg}
                  fallback={
                    <div className={styles.thumbFallback}>
                      {avatar.label[0]?.toUpperCase()}
                    </div>
                  }
                />
              </button>
            )
          })}

          {needsOverflow && !expanded && (
            <button
              type="button"
              className={styles.moreBtn}
              onClick={() => setExpanded(true)}
              aria-label={`Show ${overflowCount} more avatars`}
              title={`${overflowCount} more`}
            >
              +{overflowCount}
            </button>
          )}
        </div>

        {expanded && needsOverflow && (
          <button
            type="button"
            className={styles.collapseBtn}
            onClick={() => setExpanded(false)}
            aria-label="Show fewer"
          >
            <ChevronUp size={11} />
          </button>
        )}
      </motion.div>
    </div>
  )
}
