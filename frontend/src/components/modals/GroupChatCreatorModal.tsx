import { useState, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { X, Search, Check } from 'lucide-react'
import { useNavigate } from 'react-router'
import { useStore } from '@/store'
import { chatsApi } from '@/api/chats'
import { charactersApi } from '@/api/characters'
import Pagination from '@/components/shared/Pagination'
import type { Character } from '@/types/api'
import styles from './GroupChatCreatorModal.module.css'
import clsx from 'clsx'

type Step = 'characters' | 'greeting' | 'settings'

interface GreetingOption {
  characterId: string
  characterName: string
  greetingIndex: number
  label: string
  content: string
}

export default function GroupChatCreatorModal() {
  const navigate = useNavigate()
  const closeModal = useStore((s) => s.closeModal)
  const characters = useStore((s) => s.characters)
  const [step, setStep] = useState<Step>('characters')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [selectedGreeting, setSelectedGreeting] = useState<{ characterId: string; greetingIndex: number } | null>(null)
  const [groupName, setGroupName] = useState('')
  const [talkativenessOverrides, setTalkativenessOverrides] = useState<Record<string, number>>({})
  const [creating, setCreating] = useState(false)
  const [charPage, setCharPage] = useState(1)
  const CHARS_PER_PAGE = 50

  const selectedCharacters = useMemo(
    () => selectedIds.map((id) => characters.find((c) => c.id === id)).filter(Boolean) as Character[],
    [selectedIds, characters]
  )

  const filteredCharacters = useMemo(() => {
    if (!search.trim()) return characters
    const q = search.toLowerCase()
    return characters.filter(
      (c) => c.name.toLowerCase().includes(q) || c.tags?.some((t) => t.toLowerCase().includes(q))
    )
  }, [characters, search])

  // Reset page when search changes
  useEffect(() => {
    setCharPage(1)
  }, [search])

  const charTotalPages = Math.max(1, Math.ceil(filteredCharacters.length / CHARS_PER_PAGE))
  const safeCharPage = Math.min(charPage, charTotalPages)
  const paginatedChars = useMemo(() => {
    const start = (safeCharPage - 1) * CHARS_PER_PAGE
    return filteredCharacters.slice(start, start + CHARS_PER_PAGE)
  }, [filteredCharacters, safeCharPage])

  // Auto-generate group name from selected characters
  useEffect(() => {
    if (selectedCharacters.length >= 2) {
      const names = selectedCharacters.map((c) => c.name)
      setGroupName(names.join(', '))
    }
  }, [selectedCharacters])

  // Initialize talkativeness from character defaults
  useEffect(() => {
    const overrides: Record<string, number> = {}
    for (const char of selectedCharacters) {
      if (!(char.id in talkativenessOverrides)) {
        overrides[char.id] = char.talkativeness ?? 0.5
      }
    }
    if (Object.keys(overrides).length > 0) {
      setTalkativenessOverrides((prev) => ({ ...prev, ...overrides }))
    }
  }, [selectedCharacters])

  const greetingOptions = useMemo<GreetingOption[]>(() => {
    const options: GreetingOption[] = []
    for (const char of selectedCharacters) {
      if (char.first_mes) {
        options.push({
          characterId: char.id,
          characterName: char.name,
          greetingIndex: 0,
          label: 'Default Greeting',
          content: char.first_mes,
        })
      }
      if (char.alternate_greetings) {
        char.alternate_greetings.forEach((g, i) => {
          if (g) {
            options.push({
              characterId: char.id,
              characterName: char.name,
              greetingIndex: i + 1,
              label: `Greeting #${i + 2}`,
              content: g,
            })
          }
        })
      }
    }
    return options
  }, [selectedCharacters])

  // Auto-select first greeting when entering step 2
  useEffect(() => {
    if (step === 'greeting' && !selectedGreeting && greetingOptions.length > 0) {
      setSelectedGreeting({
        characterId: greetingOptions[0].characterId,
        greetingIndex: greetingOptions[0].greetingIndex,
      })
    }
  }, [step, selectedGreeting, greetingOptions])

  const toggleCharacter = useCallback((id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }, [])

  const handleCreate = useCallback(async () => {
    if (creating || selectedIds.length < 2) return
    setCreating(true)
    try {
      const chat = await chatsApi.createGroup({
        character_ids: selectedIds,
        name: groupName || undefined,
        greeting_character_id: selectedGreeting?.characterId,
        greeting_index: selectedGreeting?.greetingIndex,
      })
      // Store talkativeness overrides in chat metadata
      if (Object.keys(talkativenessOverrides).length > 0) {
        await chatsApi.update(chat.id, {
          metadata: {
            ...chat.metadata,
            group: true,
            character_ids: selectedIds,
            talkativeness_overrides: talkativenessOverrides,
          },
        })
      }
      closeModal()
      navigate(`/chat/${chat.id}`)
    } catch (err) {
      console.error('[GroupChatCreator] Failed to create group chat:', err)
    } finally {
      setCreating(false)
    }
  }, [creating, selectedIds, groupName, selectedGreeting, talkativenessOverrides, closeModal, navigate])

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal()
    }
    document.addEventListener('keydown', handleEscape)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = ''
    }
  }, [closeModal])

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) closeModal()
    },
    [closeModal]
  )

  const canProceed =
    step === 'characters'
      ? selectedIds.length >= 2
      : step === 'greeting'
        ? selectedGreeting !== null
        : true

  const handleNext = () => {
    if (step === 'characters') setStep('greeting')
    else if (step === 'greeting') setStep('settings')
    else handleCreate()
  }

  const handleBack = () => {
    if (step === 'greeting') setStep('characters')
    else if (step === 'settings') setStep('greeting')
  }

  const stepLabel = step === 'characters' ? 'Step 1 of 3' : step === 'greeting' ? 'Step 2 of 3' : 'Step 3 of 3'
  const stepTitle =
    step === 'characters'
      ? 'Select Characters'
      : step === 'greeting'
        ? 'Choose Opening Greeting'
        : 'Group Settings'

  return createPortal(
    <AnimatePresence>
      <motion.div
        className={styles.backdrop}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={handleBackdropClick}
      >
        <motion.div
          className={styles.modal}
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
        >
          <button onClick={closeModal} type="button" className={styles.closeBtn} aria-label="Close">
            <X size={16} />
          </button>

          <div className={styles.header}>
            <h3 className={styles.title}>{stepTitle}</h3>
            <span className={styles.stepIndicator}>{stepLabel}</span>
          </div>

          <div className={styles.body}>
            {/* Step 1: Select Characters */}
            {step === 'characters' && (
              <>
                {selectedCharacters.length > 0 && (
                  <div className={styles.selectedPills}>
                    {selectedCharacters.map((char) => (
                      <button
                        key={char.id}
                        type="button"
                        className={styles.pill}
                        onClick={() => toggleCharacter(char.id)}
                      >
                        {char.avatar_path || char.image_id ? (
                          <img
                            src={charactersApi.avatarUrl(char.id)}
                            alt={char.name}
                            className={styles.pillAvatar}
                          />
                        ) : (
                          <span className={styles.pillAvatarFallback}>
                            {char.name[0]?.toUpperCase()}
                          </span>
                        )}
                        <span>{char.name}</span>
                        <X size={10} className={styles.pillRemove} />
                      </button>
                    ))}
                  </div>
                )}

                <div className={styles.searchBar}>
                  <Search size={14} className={styles.searchIcon} />
                  <input
                    type="text"
                    className={styles.searchInput}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search characters..."
                  />
                </div>

                <div className={styles.charGrid}>
                  {paginatedChars.map((char) => {
                    const isSelected = selectedIds.includes(char.id)
                    return (
                      <button
                        key={char.id}
                        type="button"
                        className={clsx(styles.charItem, isSelected && styles.charItemSelected)}
                        onClick={() => toggleCharacter(char.id)}
                      >
                        {char.avatar_path || char.image_id ? (
                          <img
                            src={charactersApi.avatarUrl(char.id)}
                            alt={char.name}
                            className={styles.charAvatar}
                            loading="lazy"
                          />
                        ) : (
                          <span className={styles.charAvatarFallback}>
                            {char.name[0]?.toUpperCase()}
                          </span>
                        )}
                        <span className={styles.charName}>{char.name}</span>
                      </button>
                    )
                  })}
                  {filteredCharacters.length === 0 && (
                    <div className={styles.emptyState}>No characters found.</div>
                  )}
                </div>
                <Pagination
                  currentPage={safeCharPage}
                  totalPages={charTotalPages}
                  onPageChange={setCharPage}
                  totalItems={filteredCharacters.length}
                />
              </>
            )}

            {/* Step 2: Choose Greeting */}
            {step === 'greeting' && (
              <div className={styles.greetingList}>
                {greetingOptions.length === 0 && (
                  <div className={styles.emptyState}>
                    None of the selected characters have greetings defined.
                  </div>
                )}
                {greetingOptions.map((opt, i) => {
                  const isActive =
                    selectedGreeting?.characterId === opt.characterId &&
                    selectedGreeting?.greetingIndex === opt.greetingIndex
                  return (
                    <button
                      key={`${opt.characterId}-${opt.greetingIndex}`}
                      type="button"
                      className={clsx(styles.greetingCard, isActive && styles.greetingCardActive)}
                      onClick={() =>
                        setSelectedGreeting({
                          characterId: opt.characterId,
                          greetingIndex: opt.greetingIndex,
                        })
                      }
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                        <div>
                          <span className={styles.greetingCharName}>{opt.characterName}</span>
                          {' '}
                          <span className={styles.greetingLabel}>— {opt.label}</span>
                        </div>
                        {isActive && <Check size={14} style={{ color: 'var(--lumiverse-primary)' }} />}
                      </div>
                      <div className={styles.greetingPreview}>{opt.content}</div>
                    </button>
                  )
                })}
              </div>
            )}

            {/* Step 3: Group Settings */}
            {step === 'settings' && (
              <div className={styles.settingsSection}>
                <div className={styles.fieldGroup}>
                  <label className={styles.fieldLabel}>Group Name</label>
                  <input
                    type="text"
                    className={styles.fieldInput}
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    placeholder="Enter group name..."
                  />
                </div>

                <div className={styles.fieldGroup}>
                  <label className={styles.fieldLabel}>Talkativeness per Character</label>
                  {selectedCharacters.map((char) => (
                    <div key={char.id} className={styles.talkSlider}>
                      {char.avatar_path || char.image_id ? (
                        <img
                          src={charactersApi.avatarUrl(char.id)}
                          alt={char.name}
                          className={styles.talkAvatar}
                        />
                      ) : (
                        <span className={styles.talkAvatarFallback}>
                          {char.name[0]?.toUpperCase()}
                        </span>
                      )}
                      <span className={styles.talkName}>{char.name}</span>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={talkativenessOverrides[char.id] ?? 0.5}
                        onChange={(e) =>
                          setTalkativenessOverrides((prev) => ({
                            ...prev,
                            [char.id]: parseFloat(e.target.value),
                          }))
                        }
                        className={styles.talkRange}
                      />
                      <span className={styles.talkValue}>
                        {(talkativenessOverrides[char.id] ?? 0.5).toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className={styles.footer}>
            <button
              type="button"
              className={styles.footerBtn}
              onClick={step === 'characters' ? closeModal : handleBack}
            >
              {step === 'characters' ? 'Cancel' : 'Back'}
            </button>
            <button
              type="button"
              className={clsx(styles.footerBtn, styles.footerBtnPrimary)}
              onClick={handleNext}
              disabled={!canProceed || creating}
            >
              {step === 'settings' ? (creating ? 'Creating...' : 'Create Group Chat') : 'Next'}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  )
}
