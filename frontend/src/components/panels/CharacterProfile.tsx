import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties } from 'react'
import { useParams } from 'react-router'
import { Marked } from 'marked'
import { charactersApi } from '@/api/characters'
import { chatsApi } from '@/api/chats'
import { getCharacterAvatarLargeUrl, getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import { sanitizeRichHtml } from '@/lib/richHtmlSanitizer'
import { useStore } from '@/store'
import LazyImage from '@/components/shared/LazyImage'
import { EditorSection } from '@/components/shared/FormComponents'
import {
  User, Users, BookOpen, MessageSquare, Sparkles, FileText,
  Pencil, Settings2, ChevronRight,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { extractPalette, getSurfaceColor, type ImagePalette, type RGB } from '@/lib/colorExtraction'
import { deriveHeroTextVars } from '@/lib/characterTheme'
import type { Character } from '@/types/api'
import PanelFadeIn from '@/components/shared/PanelFadeIn'
import clsx from 'clsx'
import styles from './CharacterProfile.module.css'

const profileMarked = new Marked({ gfm: true, breaks: true })
const HERO_CACHE_LIMIT = 60
const heroPaletteCache = new Map<string, Promise<ImagePalette>>()
const heroTextVarsCache = new Map<string, CSSProperties>()

function rememberCacheEntry<K, V>(cache: Map<K, V>, key: K, value: V): V {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, value)
  if (cache.size > HERO_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value
    if (oldestKey !== undefined) cache.delete(oldestKey)
  }
  return value
}

function getCachedPalette(src: string): Promise<ImagePalette> {
  const cached = heroPaletteCache.get(src)
  if (cached) return cached

  const promise = extractPalette(src).catch((err) => {
    heroPaletteCache.delete(src)
    throw err
  })
  return rememberCacheEntry(heroPaletteCache, src, promise)
}

function surfaceKey(surface: RGB | null): string {
  return surface ? `${surface.r},${surface.g},${surface.b}` : 'none'
}

function renderProfileMarkdown(text: string): string {
  const html = profileMarked.parse(text, { async: false }) as string
  return sanitizeRichHtml(html)
}

export default function CharacterProfile() {
  const params = useParams<{ id: string }>()
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const characters = useStore((s) => s.characters)
  const setEditingCharacterId = useStore((s) => s.setEditingCharacterId)
  const setDrawerTab = useStore((s) => s.setDrawerTab)
  const isGroupChat = useStore((s) => s.isGroupChat)
  const groupCharacterIds = useStore((s) => s.groupCharacterIds)
  const openModal = useStore((s) => s.openModal)
  const activeChatId = useStore((s) => s.activeChatId)

  if (isGroupChat && groupCharacterIds.length > 1) {
    return (
      <GroupProfile
        characterIds={groupCharacterIds}
        characters={characters}
        chatId={activeChatId}
        setEditingCharacterId={setEditingCharacterId}
        setDrawerTab={setDrawerTab}
        openModal={openModal}
      />
    )
  }

  return (
    <SingleCharacterProfile
      paramId={params.id}
      activeCharacterId={activeCharacterId}
      characters={characters}
      setEditingCharacterId={setEditingCharacterId}
      setDrawerTab={setDrawerTab}
    />
  )
}

/* ─── Single Character Profile ─────────────────────────────────────── */

function SingleCharacterProfile({
  paramId,
  activeCharacterId,
  characters,
  setEditingCharacterId,
  setDrawerTab,
}: {
  paramId?: string
  activeCharacterId: string | null
  characters: Character[]
  setEditingCharacterId: (id: string | null) => void
  setDrawerTab: (tab: string) => void
}) {
  const { t } = useTranslation('panels')
  const charId = paramId || activeCharacterId
  const storedCharacter = charId ? characters.find((entry) => entry.id === charId) ?? null : null
  const [character, setCharacter] = useState<Character | null>(storedCharacter)
  const [loading, setLoading] = useState(false)
  const [heroTextVars, setHeroTextVars] = useState<CSSProperties | undefined>(undefined)
  const [heroImageLoadedUrl, setHeroImageLoadedUrl] = useState<string | null>(null)
  const heroMetaRef = useRef<HTMLDivElement>(null)

  const handleEditCharacter = useCallback(() => {
    if (!charId) return
    setEditingCharacterId(charId)
    setDrawerTab('characters')
  }, [charId, setEditingCharacterId, setDrawerTab])

  useEffect(() => {
    if (storedCharacter) setCharacter(storedCharacter)
  }, [storedCharacter])

  useEffect(() => {
    if (!charId) return
    if (!storedCharacter) setLoading(true)
    charactersApi.get(charId)
      .then(setCharacter)
      .catch((err) => console.error('[CharacterProfile] Failed to load:', err))
      .finally(() => setLoading(false))
  }, [charId]) // eslint-disable-line react-hooks/exhaustive-deps

  const avatarUrl = getCharacterAvatarLargeUrl(character) ?? ''
  // Stored images resolve to the large WebP thumbnail tier (`?size=lg`), which
  // is plenty for palette sampling and avoids decoding original PNG cards.
  const heroSampleUrl = avatarUrl

  useEffect(() => {
    setHeroTextVars(undefined)
  }, [avatarUrl])

  useEffect(() => {
    if (!heroSampleUrl || heroImageLoadedUrl !== avatarUrl) {
      setHeroTextVars(undefined)
      return
    }

    let cancelled = false

    const sampleHeroImage = async () => {
      const surface = await new Promise<RGB | null>((resolve) => {
        requestAnimationFrame(() => {
          if (cancelled) {
            resolve(null)
            return
          }
          resolve(heroMetaRef.current ? getSurfaceColor(heroMetaRef.current) : null)
        })
      })

      if (cancelled) return

      const varsCacheKey = `${heroSampleUrl}|${surfaceKey(surface)}`
      const cachedVars = heroTextVarsCache.get(varsCacheKey)
      if (cachedVars) {
        setHeroTextVars(cachedVars)
        return
      }

      try {
        const palette = await getCachedPalette(heroSampleUrl)
        if (cancelled) return

        const vars = rememberCacheEntry(
          heroTextVarsCache,
          varsCacheKey,
          deriveHeroTextVars(palette, surface ?? undefined) as CSSProperties,
        )
        setHeroTextVars(vars)
      } catch {
        if (!cancelled) setHeroTextVars(undefined)
      }
    }

    sampleHeroImage()
    return () => { cancelled = true }
  }, [avatarUrl, heroSampleUrl, heroImageLoadedUrl])

  if (!charId) {
    return (
      <div className={styles.empty}>
        <User size={40} strokeWidth={1} />
        <p>{t('characterProfile.noCharacterSelected')}</p>
      </div>
    )
  }

  if (loading || !character) {
    return <div className={styles.loading}>{t('characterProfile.loading')}</div>
  }

  return (
    <PanelFadeIn>
      <div className={styles.profile}>
        {/* Hero avatar */}
        <div className={styles.hero}>
        <div className={styles.heroImage}>
          <LazyImage
            src={avatarUrl}
            alt={character.name}
            onLoad={() => setHeroImageLoadedUrl(avatarUrl)}
            onError={() => setHeroImageLoadedUrl(null)}
            fallback={
              <div className={styles.avatarFallback}>
                {character.name[0]?.toUpperCase()}
              </div>
            }
          />
        </div>
        <div className={styles.heroMeta} style={heroTextVars} ref={heroMetaRef}>
          <h2 className={styles.name}>{character.name}</h2>
          <button type="button" className={styles.editBtn} onClick={handleEditCharacter}>
            <Pencil size={12} />
            <span>{t('characterProfile.editCharacter')}</span>
          </button>
          {character.creator && <span className={styles.creator}>{t('characterProfile.byCreator', { creator: character.creator })}</span>}
          {character.tags.length > 0 && (
            <TagList tags={character.tags} />
          )}
        </div>
      </div>

      {/* Description */}
      <EditorSection Icon={BookOpen} title={t('characterProfile.sections.description')} defaultExpanded={false}>
        {character.description
          ? <div className={styles.fieldContent} dangerouslySetInnerHTML={{ __html: renderProfileMarkdown(character.description) }} />
          : <div className={styles.fieldContent}><span className={styles.placeholder}>{t('characterProfile.empty.description')}</span></div>
        }
      </EditorSection>

      {/* Personality */}
      <EditorSection Icon={Sparkles} title={t('characterProfile.sections.personality')} defaultExpanded={false}>
        {character.personality
          ? <div className={styles.fieldContent} dangerouslySetInnerHTML={{ __html: renderProfileMarkdown(character.personality) }} />
          : <div className={styles.fieldContent}><span className={styles.placeholder}>{t('characterProfile.empty.personality')}</span></div>
        }
      </EditorSection>

      {/* Scenario */}
      <EditorSection Icon={FileText} title={t('characterProfile.sections.scenario')} defaultExpanded={false}>
        {character.scenario
          ? <div className={styles.fieldContent} dangerouslySetInnerHTML={{ __html: renderProfileMarkdown(character.scenario) }} />
          : <div className={styles.fieldContent}><span className={styles.placeholder}>{t('characterProfile.empty.scenario')}</span></div>
        }
      </EditorSection>

      {/* First Message */}
      <EditorSection Icon={MessageSquare} title={t('characterProfile.sections.firstMessage')} defaultExpanded={false}>
        {character.first_mes
          ? <div className={styles.fieldContent} dangerouslySetInnerHTML={{ __html: renderProfileMarkdown(character.first_mes) }} />
          : <div className={styles.fieldContent}><span className={styles.placeholder}>{t('characterProfile.empty.firstMessage')}</span></div>
        }
      </EditorSection>

      {/* System Prompt */}
      <EditorSection Icon={FileText} title={t('characterProfile.sections.systemPrompt')} defaultExpanded={false}>
        {character.system_prompt
          ? <div className={styles.fieldContent} dangerouslySetInnerHTML={{ __html: renderProfileMarkdown(character.system_prompt) }} />
          : <div className={styles.fieldContent}><span className={styles.placeholder}>{t('characterProfile.empty.systemPrompt')}</span></div>
        }
      </EditorSection>
      </div>
    </PanelFadeIn>
  )
}

/* ─── Group Profile ────────────────────────────────────────────────── */

function GroupProfile({
  characterIds,
  characters,
  chatId,
  setEditingCharacterId,
  setDrawerTab,
  openModal,
}: {
  characterIds: string[]
  characters: Character[]
  chatId: string | null
  setEditingCharacterId: (id: string | null) => void
  setDrawerTab: (tab: string) => void
  openModal: (modal: string, props?: any) => void
}) {
  const { t } = useTranslation('panels')
  const [chatName, setChatName] = useState<string>('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const members = characterIds
    .map((id) => characters.find((c) => c.id === id))
    .filter(Boolean) as Character[]

  // Fetch chat info for the group name
  useEffect(() => {
    if (!chatId) return
    chatsApi.get(chatId, { messages: false })
      .then((chat) => setChatName(chat.name || ''))
      .catch(() => {})
  }, [chatId])

  const displayIds = characterIds.slice(0, 4)
  const count = Math.min(characterIds.length, 4)
  const mosaicClass =
    count === 2 ? styles.groupMosaic2
    : count === 3 ? styles.groupMosaic3
    : styles.groupMosaic4

  const handleGroupSettings = useCallback(async () => {
    if (!chatId) return
    try {
      const chat = await chatsApi.get(chatId, { messages: false })
      openModal('chatSettings', {
        chatId,
        chatName: chat.name || '',
        metadata: chat.metadata || {},
        onSaved: (updatedChat: import('@/types/api').Chat) => setChatName(updatedChat.name || ''),
      })
    } catch (err) {
      console.error('[GroupProfile] Failed to load chat:', err)
    }
  }, [chatId, openModal])

  const handleEditMember = useCallback((charId: string) => {
    setEditingCharacterId(charId)
    setDrawerTab('characters')
  }, [setEditingCharacterId, setDrawerTab])

  return (
    <PanelFadeIn>
      <div className={styles.groupProfile}>
        {/* Contained mosaic — no negative margins, no absolute positioning */}
        <div className={clsx(styles.groupMosaic, mosaicClass)}>
          {displayIds.map((id) => {
            const char = characters.find((c) => c.id === id)
            return (
              <div key={id} className={styles.groupMosaicCell}>
                <LazyImage
                  src={getCharacterAvatarLargeUrl(char) || ''}
                  alt={char?.name || ''}
                  fallback={
                    <div className={styles.groupMosaicFallback}>
                      <Users size={24} strokeWidth={1.5} />
                    </div>
                  }
                />
              </div>
            )
          })}
        </div>

        {/* Group info */}
        <div className={styles.groupInfo}>
          <h2 className={styles.groupName}>{chatName || t('characterProfile.groupChat')}</h2>
          <span className={styles.groupMemberCount}>
            {t('characterProfile.memberCount', { count: characterIds.length })}
          </span>
          <button type="button" className={styles.groupSettingsBtn} onClick={handleGroupSettings}>
            <Settings2 size={13} />
            <span>{t('characterProfile.groupSettings')}</span>
          </button>
        </div>

        {/* Member list */}
        <div className={styles.groupDivider}>
          <span className={styles.groupSectionLabel}>{t('characterProfile.members')}</span>
        </div>

        <div className={styles.groupMembers}>
          {members.map((char) => {
            const isExpanded = expandedId === char.id
            return (
              <div key={char.id} className={clsx(styles.memberCard, isExpanded && styles.memberCardExpanded)}>
                <button
                  type="button"
                  className={styles.memberHeader}
                  onClick={() => setExpandedId(isExpanded ? null : char.id)}
                >
                  <div className={styles.memberAvatar}>
                    <LazyImage
                      src={getCharacterAvatarThumbUrl(char) || ''}
                      alt={char.name}
                      spinnerSize={14}
                      fallback={
                        <div className={styles.memberAvatarFallback}>
                          {char.name[0]?.toUpperCase()}
                        </div>
                      }
                    />
                  </div>
                  <div className={styles.memberInfo}>
                    <span className={styles.memberName}>{char.name}</span>
                    {char.creator && (
                      <span className={styles.memberCreator}>{t('characterProfile.byCreator', { creator: char.creator })}</span>
                    )}
                  </div>
                  <div className={clsx(styles.memberChevron, isExpanded && styles.memberChevronOpen)}>
                    <ChevronRight size={14} />
                  </div>
                </button>
                {isExpanded && (
                  <div className={styles.memberExpanded}>
                    {char.tags.length > 0 && (
                      <div className={styles.memberTags}>
                        {char.tags.slice(0, 8).map((tag) => (
                          <span key={tag} className={styles.memberTag}>{tag}</span>
                        ))}
                        {char.tags.length > 8 && (
                          <span className={styles.memberTag}>+{char.tags.length - 8}</span>
                        )}
                      </div>
                    )}
                    {char.description && (
                      <MemberField icon={BookOpen} label={t('characterProfile.sections.description')} content={char.description} />
                    )}
                    {char.personality && (
                      <MemberField icon={Sparkles} label={t('characterProfile.sections.personality')} content={char.personality} />
                    )}
                    {char.scenario && (
                      <MemberField icon={FileText} label={t('characterProfile.sections.scenario')} content={char.scenario} />
                    )}
                    <button
                      type="button"
                      className={styles.memberEditBtn}
                      onClick={() => handleEditMember(char.id)}
                    >
                      <Pencil size={11} />
                      <span>{t('characterProfile.editCharacter')}</span>
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </PanelFadeIn>
  )
}

/* ─── Inline field for expanded member cards ──────────────────────── */

function MemberField({ icon: Icon, label, content }: { icon: any; label: string; content: string }) {
  const { t } = useTranslation('panels')
  const MAX_LEN = 200
  const [showFull, setShowFull] = useState(false)
  const truncated = content.length > MAX_LEN && !showFull
  const display = truncated ? content.slice(0, MAX_LEN) + '...' : content

  return (
    <div className={styles.memberField}>
      <div className={styles.memberFieldHeader}>
        <Icon size={12} strokeWidth={2} />
        <span>{label}</span>
      </div>
      <div className={styles.memberFieldContent} dangerouslySetInnerHTML={{ __html: renderProfileMarkdown(display) }} />
      {content.length > MAX_LEN && (
        <button
          type="button"
          className={styles.memberFieldToggle}
          onClick={() => setShowFull((v) => !v)}
        >
          {showFull ? t('characterProfile.showLess') : t('characterProfile.showMore')}
        </button>
      )}
    </div>
  )
}

const TAG_LIMIT = 10

function TagList({ tags }: { tags: string[] }) {
  const { t } = useTranslation('panels')
  const [expanded, setExpanded] = useState(false)
  const overflow = tags.length - TAG_LIMIT
  const visible = expanded ? tags : tags.slice(0, TAG_LIMIT)

  return (
    <div className={styles.tags}>
      {visible.map((tag) => (
        <span key={tag} className={styles.tag}>{tag}</span>
      ))}
      {overflow > 0 && (
        <button
          type="button"
          className={styles.tagMore}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? t('characterProfile.showLess') : t('characterProfile.moreCount', { count: overflow })}
        </button>
      )}
    </div>
  )
}
