import { useState, useEffect, useCallback, type CSSProperties } from 'react'
import { useParams } from 'react-router'
import { charactersApi } from '@/api/characters'
import { chatsApi } from '@/api/chats'
import { getCharacterAvatarLargeUrl, getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import { useStore } from '@/store'
import LazyImage from '@/components/shared/LazyImage'
import { EditorSection } from '@/components/shared/FormComponents'
import {
  User, Users, BookOpen, MessageSquare, Sparkles, FileText,
  Pencil, Settings2, ChevronRight,
} from 'lucide-react'
import { extractPalette } from '@/lib/colorExtraction'
import { deriveHeroTextVars } from '@/lib/characterTheme'
import type { Character } from '@/types/api'
import PanelFadeIn from '@/components/shared/PanelFadeIn'
import clsx from 'clsx'
import styles from './CharacterProfile.module.css'

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
  const charId = paramId || activeCharacterId
  const storedCharacter = charId ? characters.find((entry) => entry.id === charId) ?? null : null
  const [character, setCharacter] = useState<Character | null>(storedCharacter)
  const [loading, setLoading] = useState(false)
  const [heroTextVars, setHeroTextVars] = useState<CSSProperties | undefined>(undefined)

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

  useEffect(() => {
    if (!avatarUrl) {
      setHeroTextVars(undefined)
      return
    }

    let cancelled = false

    const sampleHeroImage = async () => {
      try {
        const palette = await extractPalette(avatarUrl)
        if (cancelled) return
        setHeroTextVars(deriveHeroTextVars(palette) as CSSProperties)
      } catch {
        if (!cancelled) setHeroTextVars(undefined)
      }
    }

    sampleHeroImage()
    return () => { cancelled = true }
  }, [avatarUrl])

  if (!charId) {
    return (
      <div className={styles.empty}>
        <User size={40} strokeWidth={1} />
        <p>No character selected</p>
      </div>
    )
  }

  if (loading || !character) {
    return <div className={styles.loading}>Loading...</div>
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
            fallback={
              <div className={styles.avatarFallback}>
                {character.name[0]?.toUpperCase()}
              </div>
            }
          />
        </div>
        <div className={styles.heroMeta} style={heroTextVars}>
          <h2 className={styles.name}>{character.name}</h2>
          <button type="button" className={styles.editBtn} onClick={handleEditCharacter}>
            <Pencil size={12} />
            <span>Edit Character</span>
          </button>
          {character.creator && <span className={styles.creator}>by {character.creator}</span>}
          {character.tags.length > 0 && (
            <TagList tags={character.tags} />
          )}
        </div>
      </div>

      {/* Description */}
      <EditorSection Icon={BookOpen} title="Description" defaultExpanded={false}>
        <div className={styles.fieldContent}>
          {character.description || <span className={styles.placeholder}>No description</span>}
        </div>
      </EditorSection>

      {/* Personality */}
      <EditorSection Icon={Sparkles} title="Personality" defaultExpanded={false}>
        <div className={styles.fieldContent}>
          {character.personality || <span className={styles.placeholder}>No personality defined</span>}
        </div>
      </EditorSection>

      {/* Scenario */}
      <EditorSection Icon={FileText} title="Scenario" defaultExpanded={false}>
        <div className={styles.fieldContent}>
          {character.scenario || <span className={styles.placeholder}>No scenario</span>}
        </div>
      </EditorSection>

      {/* First Message */}
      <EditorSection Icon={MessageSquare} title="First Message" defaultExpanded={false}>
        <div className={styles.fieldContent}>
          {character.first_mes || <span className={styles.placeholder}>No first message</span>}
        </div>
      </EditorSection>

      {/* System Prompt */}
      <EditorSection Icon={FileText} title="System Prompt" defaultExpanded={false}>
        <div className={styles.fieldContent}>
          {character.system_prompt || <span className={styles.placeholder}>No system prompt</span>}
        </div>
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
      openModal('groupSettings', { chatId, chatName: chat.name || '', metadata: chat.metadata || {} })
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
          <h2 className={styles.groupName}>{chatName || 'Group Chat'}</h2>
          <span className={styles.groupMemberCount}>
            {characterIds.length} member{characterIds.length !== 1 ? 's' : ''}
          </span>
          <button type="button" className={styles.groupSettingsBtn} onClick={handleGroupSettings}>
            <Settings2 size={13} />
            <span>Group Settings</span>
          </button>
        </div>

        {/* Member list */}
        <div className={styles.groupDivider}>
          <span className={styles.groupSectionLabel}>Members</span>
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
                      <span className={styles.memberCreator}>by {char.creator}</span>
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
                      <MemberField icon={BookOpen} label="Description" content={char.description} />
                    )}
                    {char.personality && (
                      <MemberField icon={Sparkles} label="Personality" content={char.personality} />
                    )}
                    {char.scenario && (
                      <MemberField icon={FileText} label="Scenario" content={char.scenario} />
                    )}
                    <button
                      type="button"
                      className={styles.memberEditBtn}
                      onClick={() => handleEditMember(char.id)}
                    >
                      <Pencil size={11} />
                      <span>Edit Character</span>
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
      <div className={styles.memberFieldContent}>
        {display}
        {content.length > MAX_LEN && (
          <button
            type="button"
            className={styles.memberFieldToggle}
            onClick={() => setShowFull((v) => !v)}
          >
            {showFull ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    </div>
  )
}

const TAG_LIMIT = 10

function TagList({ tags }: { tags: string[] }) {
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
          {expanded ? 'Show less' : `+${overflow} more`}
        </button>
      )}
    </div>
  )
}
