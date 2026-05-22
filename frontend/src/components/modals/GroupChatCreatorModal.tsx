import { useState, useEffect, useCallback, useMemo } from 'react'
import { X, Search, Check } from 'lucide-react'
import { useNavigate } from 'react-router'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import { ModalShell } from '@/components/shared/ModalShell'
import { useStore } from '@/store'
import { chatsApi } from '@/api/chats'
import { getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import Pagination from '@/components/shared/Pagination'
import type { Character } from '@/types/api'
import styles from './GroupChatCreatorModal.module.css'
import clsx from 'clsx'

type Step = 'characters' | 'greeting' | 'settings'
type GroupCardMode = 'swap' | 'merge_ignore_muted' | 'merge'

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
  const modalProps = useStore((s) => s.modalProps) as { initialCharacterIds?: string[] } | null
  const characters = useStore((s) => s.characters)
  const [step, setStep] = useState<Step>('characters')
  const [selectedIds, setSelectedIds] = useState<string[]>(modalProps?.initialCharacterIds ?? [])
  const [search, setSearch] = useState('')
  const [selectedGreeting, setSelectedGreeting] = useState<{ characterId: string; greetingIndex: number } | null>(null)
  const [groupName, setGroupName] = useState('')
  const [talkativenessOverrides, setTalkativenessOverrides] = useState<Record<string, number>>({})
  const [groupCardMode, setGroupCardMode] = useState<GroupCardMode>('swap')
  const [scenarioMode, setScenarioMode] = useState<'individual' | 'member' | 'custom'>('individual')
  const [scenarioMemberId, setScenarioMemberId] = useState<string>('')
  const [scenarioCustom, setScenarioCustom] = useState('')
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
      // Build extra metadata (talkativeness + scenario override)
      const extraMeta: Record<string, any> = {}
      if (Object.keys(talkativenessOverrides).length > 0) {
        extraMeta.talkativeness_overrides = talkativenessOverrides
      }
      if (groupCardMode !== 'swap') {
        extraMeta.group_card_mode = groupCardMode
      }
      if (scenarioMode !== 'individual') {
        extraMeta.group_scenario_override = {
          mode: scenarioMode,
          ...(scenarioMode === 'member' && scenarioMemberId ? { member_character_id: scenarioMemberId } : {}),
          ...(scenarioMode === 'custom' ? { content: scenarioCustom } : {}),
        }
      }
      if (Object.keys(extraMeta).length > 0) {
        await chatsApi.update(chat.id, {
          metadata: {
            ...chat.metadata,
            group: true,
            character_ids: selectedIds,
            ...extraMeta,
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
  }, [creating, selectedIds, groupName, selectedGreeting, talkativenessOverrides, groupCardMode, scenarioMode, scenarioMemberId, scenarioCustom, closeModal, navigate])

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

  return (
    <ModalShell isOpen={true} onClose={closeModal} maxWidth="clamp(340px, 94vw, min(760px, var(--lumiverse-content-max-width, 760px)))" className={styles.modal}>
          <CloseButton onClick={closeModal} variant="solid" position="absolute" />

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
                            src={getCharacterAvatarThumbUrl(char) || undefined}
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
                            src={getCharacterAvatarThumbUrl(char) || undefined}
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
                  <label className={styles.fieldLabel}>Character Card Macros</label>
                  <select
                    className={styles.fieldInput}
                    value={groupCardMode}
                    onChange={(e) => setGroupCardMode(e.target.value as GroupCardMode)}
                  >
                    <option value="swap">Swap to active character card</option>
                    <option value="merge_ignore_muted">Merge all unmuted member cards</option>
                    <option value="merge">Merge all member cards</option>
                  </select>
                  <div style={{ fontSize: 'calc(11px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-text-dim)', lineHeight: 1.45 }}>
                    Controls how character-card macros like {'{{description}}'}, {'{{personality}}'}, and {'{{scenario}}'} resolve during generation.
                  </div>
                </div>

                <div className={styles.fieldGroup}>
                  <label className={styles.fieldLabel}>Group Scenario</label>
                  <select
                    className={styles.fieldInput}
                    value={scenarioMode === 'member' ? `member:${scenarioMemberId}` : scenarioMode}
                    onChange={(e) => {
                      const val = e.target.value
                      if (val === 'individual') {
                        setScenarioMode('individual')
                        setScenarioMemberId('')
                      } else if (val === 'custom') {
                        setScenarioMode('custom')
                        setScenarioMemberId('')
                      } else if (val.startsWith('member:')) {
                        setScenarioMode('member')
                        setScenarioMemberId(val.slice(7))
                      }
                    }}
                  >
                    <option value="individual">Use individual scenarios</option>
                    {selectedCharacters.map((char) => (
                      <option key={char.id} value={`member:${char.id}`}>
                        Use {char.name}'s scenario
                      </option>
                    ))}
                    <option value="custom">Custom scenario</option>
                  </select>
                  {scenarioMode === 'custom' && (
                    <textarea
                      className={styles.fieldInput}
                      value={scenarioCustom}
                      onChange={(e) => setScenarioCustom(e.target.value)}
                      placeholder="Enter a shared scenario for the group..."
                      rows={4}
                      style={{ resize: 'vertical', marginTop: 8 }}
                    />
                  )}
                </div>

                <div className={styles.fieldGroup}>
                  <label className={styles.fieldLabel}>Talkativeness per Character</label>
                  {selectedCharacters.map((char) => (
                    <div key={char.id} className={styles.talkSlider}>
                      {char.avatar_path || char.image_id ? (
                        <img
                          src={getCharacterAvatarThumbUrl(char) || undefined}
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
            <Button
              variant="ghost"
              onClick={step === 'characters' ? closeModal : handleBack}
            >
              {step === 'characters' ? 'Cancel' : 'Back'}
            </Button>
            <Button
              variant="primary"
              onClick={handleNext}
              disabled={!canProceed || creating}
            >
              {step === 'settings' ? (creating ? 'Creating...' : 'Create Group Chat') : 'Next'}
            </Button>
          </div>
    </ModalShell>
  )
}
