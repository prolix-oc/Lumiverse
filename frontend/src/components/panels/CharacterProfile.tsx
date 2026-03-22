import { useState, useEffect, useCallback, type CSSProperties } from 'react'
import { useParams } from 'react-router'
import { charactersApi } from '@/api/characters'
import { useStore } from '@/store'
import LazyImage from '@/components/shared/LazyImage'
import { EditorSection, FormField, TextInput, TextArea } from '@/components/shared/FormComponents'
import { User, BookOpen, MessageSquare, Sparkles, FileText, Tags, Pencil } from 'lucide-react'
import { extractPalette } from '@/lib/colorExtraction'
import { deriveHeroTextVars } from '@/lib/characterTheme'
import type { Character } from '@/types/api'
import styles from './CharacterProfile.module.css'

export default function CharacterProfile() {
  const params = useParams<{ id: string }>()
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const setEditingCharacterId = useStore((s) => s.setEditingCharacterId)
  const setDrawerTab = useStore((s) => s.setDrawerTab)
  const charId = params.id || activeCharacterId
  const [character, setCharacter] = useState<Character | null>(null)
  const [loading, setLoading] = useState(false)
  const [heroTextVars, setHeroTextVars] = useState<CSSProperties | undefined>(undefined)

  const handleEditCharacter = useCallback(() => {
    if (!charId) return
    setEditingCharacterId(charId)
    setDrawerTab('characters')
  }, [charId, setEditingCharacterId, setDrawerTab])

  useEffect(() => {
    if (!charId) return
    setLoading(true)
    charactersApi.get(charId)
      .then(setCharacter)
      .catch((err) => console.error('[CharacterProfile] Failed to load:', err))
      .finally(() => setLoading(false))
  }, [charId])

  const avatarUrl = character ? charactersApi.avatarUrl(character.id) : ''

  useEffect(() => {
    if (!avatarUrl) {
      setHeroTextVars(undefined)
      return
    }

    let cancelled = false

    const applyFallback = () => {
      if (cancelled) return
      setHeroTextVars(undefined)
    }

    const sampleHeroImage = async () => {
      try {
        const palette = await extractPalette(avatarUrl)
        if (cancelled) return
        setHeroTextVars(deriveHeroTextVars(palette) as CSSProperties)
      } catch {
        applyFallback()
      }
    }

    sampleHeroImage()
    return () => {
      cancelled = true
    }
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
      <EditorSection Icon={BookOpen} title="Description">
        <div className={styles.fieldContent}>
          {character.description || <span className={styles.placeholder}>No description</span>}
        </div>
      </EditorSection>

      {/* Personality */}
      <EditorSection Icon={Sparkles} title="Personality">
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
