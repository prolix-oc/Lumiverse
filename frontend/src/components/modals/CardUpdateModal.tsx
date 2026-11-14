import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  FileDiff,
  Sparkles,
  UserPlus,
} from 'lucide-react'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import { Spinner } from '@/components/shared/Spinner'
import { charactersApi } from '@/api/characters'
import { toast } from '@/lib/toast'
import { computeLineDiff, countDiffLines } from '@/lib/textDiff'
import type {
  AlternateGreetingsUpdateMode,
  AvatarUpdateMode,
  CardScalarField,
  CardUpdateApplySummary,
  CardUpdatePreview,
  CardUpdateSelection,
  Character,
  CharacterUpdateMatchCandidate,
  CharxAssetsUpdateMode,
  ExtensionsUpdateMode,
  FirstMesUpdateMode,
  RegexUpdateMode,
  TagsUpdateMode,
  WorldBookUpdateMode,
} from '@/types/api'
import styles from './CardUpdateModal.module.css'

const SCALAR_FIELDS: readonly CardScalarField[] = [
  'name',
  'description',
  'personality',
  'scenario',
  'mes_example',
  'creator',
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
] as const

function normalizeGreeting(value: string): string {
  return value.trim()
}

function buildInitialState(target: Character, preview: CardUpdatePreview) {
  const { incoming, extras } = preview
  const changedScalars = new Set<CardScalarField>()
  for (const field of SCALAR_FIELDS) {
    if (field === 'name') continue // Preserve existing name unless user opts in
    if ((incoming[field] ?? '') !== (target[field] ?? '')) {
      changedScalars.add(field)
    }
  }

  const firstMesChanged = (incoming.first_mes ?? '') !== (target.first_mes ?? '')
  const firstMesMode: FirstMesUpdateMode = firstMesChanged ? 'replace' : 'keep'

  const existingKeys = new Set<string>()
  if ((target.first_mes ?? '').trim()) existingKeys.add(normalizeGreeting(target.first_mes))
  for (const g of target.alternate_greetings ?? []) {
    if (g.trim()) existingKeys.add(normalizeGreeting(g))
  }

  const newIncomingIndices: number[] = []
  ;(incoming.alternate_greetings ?? []).forEach((g, idx) => {
    const key = normalizeGreeting(g)
    if (key && !existingKeys.has(key)) newIncomingIndices.push(idx)
  })

  const alternateGreetingsMode: AlternateGreetingsUpdateMode =
    newIncomingIndices.length > 0 ? 'append_new' : 'keep'

  const existingTagsSet = new Set(target.tags ?? [])
  const hasNewTags = (incoming.tags ?? []).some((tag) => !existingTagsSet.has(tag))
  const tagsMode: TagsUpdateMode = hasNewTags ? 'merge' : 'keep'

  const charxHasAssets =
    extras.galleryCount > 0 ||
    extras.expressionCount > 0 ||
    extras.expressionGroupCount > 0 ||
    extras.alternateAvatarCount > 0 ||
    extras.alternateFieldKeys.length > 0 ||
    extras.landingPerspectiveLayerCount > 0

  return {
    selectedFields: changedScalars,
    firstMesMode,
    alternateGreetingsMode,
    keepExistingGreetingIndices: (target.alternate_greetings ?? []).map((_, idx) => idx),
    selectedIncomingGreetingIndices: newIncomingIndices,
    tagsMode,
    avatarMode: 'keep' as AvatarUpdateMode,
    extensionsMode: 'keep' as ExtensionsUpdateMode,
    worldBookMode: 'keep' as WorldBookUpdateMode,
    regexMode: 'keep' as RegexUpdateMode,
    charxAssetsMode: 'keep' as CharxAssetsUpdateMode,
    charxHasAssets,
  }
}

function formatBadgeLabel(format: CardUpdatePreview['format']): string {
  if (format === 'jpeg_polyglot') return 'CHARX'
  return format.toUpperCase()
}

function DiffBlock({ oldText, newText }: { oldText: string; newText: string }) {
  const chunks = useMemo(() => computeLineDiff(oldText, newText), [oldText, newText])
  return (
    <div className={styles.diffContainer}>
      {chunks.length === 0 ? (
        <div className={clsx(styles.diffLine, styles.diffLineUnchanged)}>
          <span className={styles.diffPrefix}> </span>
          <span>(empty)</span>
        </div>
      ) : (
        chunks.map((chunk, idx) => (
          <div
            key={idx}
            className={clsx(
              styles.diffLine,
              chunk.type === 'added' && styles.diffLineAdded,
              chunk.type === 'removed' && styles.diffLineRemoved,
              chunk.type === 'unchanged' && styles.diffLineUnchanged,
            )}
          >
            <span className={styles.diffPrefix}>
              {chunk.type === 'added' ? '+' : chunk.type === 'removed' ? '-' : ' '}
            </span>
            <span>{chunk.text || ' '}</span>
          </div>
        ))
      )}
    </div>
  )
}

export interface CardUpdateModalProps {
  isOpen: boolean
  file: File | null
  preview: CardUpdatePreview | null
  initialTargetCharacter?: Character | null
  matches?: CharacterUpdateMatchCandidate[]
  onImportAsNew?: () => Promise<void> | void
  onApplied: (character: Character, summary: CardUpdateApplySummary) => void
  onClose: () => void
}

export default function CardUpdateModal({
  isOpen,
  file,
  preview,
  initialTargetCharacter = null,
  matches,
  onImportAsNew,
  onApplied,
  onClose,
}: CardUpdateModalProps) {
  const { t } = useTranslation('modals')
  const { t: tc } = useTranslation('common')

  const [selectedTargetId, setSelectedTargetId] = useState<string>('')
  const [loadedTarget, setLoadedTarget] = useState<Character | null>(initialTargetCharacter)
  const [loadingTarget, setLoadingTarget] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [selectedFields, setSelectedFields] = useState<Set<CardScalarField>>(new Set())
  const [firstMesMode, setFirstMesMode] = useState<FirstMesUpdateMode>('keep')
  const [alternateGreetingsMode, setAlternateGreetingsMode] = useState<AlternateGreetingsUpdateMode>('keep')
  const [keepExistingGreetingIndices, setKeepExistingGreetingIndices] = useState<number[]>([])
  const [selectedIncomingGreetingIndices, setSelectedIncomingGreetingIndices] = useState<number[]>([])
  const [tagsMode, setTagsMode] = useState<TagsUpdateMode>('keep')
  const [avatarMode, setAvatarMode] = useState<AvatarUpdateMode>('keep')
  const [extensionsMode, setExtensionsMode] = useState<ExtensionsUpdateMode>('keep')
  const [worldBookMode, setWorldBookMode] = useState<WorldBookUpdateMode>('keep')
  const [regexMode, setRegexMode] = useState<RegexUpdateMode>('keep')
  const [charxAssetsMode, setCharxAssetsMode] = useState<CharxAssetsUpdateMode>('keep')

  const [showUnchanged, setShowUnchanged] = useState(false)
  const [expandedDiffs, setExpandedDiffs] = useState<Set<string>>(new Set(['first_mes']))
  const [expandedGreetings, setExpandedGreetings] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)
  const [importingAsNew, setImportingAsNew] = useState(false)

  // Reset selected target whenever modal opens with a new preview or initial character
  useEffect(() => {
    if (!isOpen) return
    if (initialTargetCharacter) {
      setSelectedTargetId(initialTargetCharacter.id)
      setLoadedTarget(initialTargetCharacter)
      setLoadError(null)
    } else if (matches && matches.length > 0) {
      setSelectedTargetId(matches[0].id)
      setLoadedTarget(null)
      setLoadError(null)
    } else {
      setSelectedTargetId('')
      setLoadedTarget(null)
    }
    setShowUnchanged(false)
    setExpandedDiffs(new Set(['first_mes']))
    setExpandedGreetings(new Set())
  }, [isOpen, initialTargetCharacter, matches, preview])

  // Load full character details when choosing among browser match candidates
  useEffect(() => {
    if (!isOpen || initialTargetCharacter || !selectedTargetId) return
    let cancelled = false
    setLoadingTarget(true)
    setLoadError(null)
    charactersApi.get(selectedTargetId)
      .then((char) => {
        if (!cancelled) setLoadedTarget(char)
      })
      .catch((err: any) => {
        if (!cancelled) setLoadError(err?.body?.error || err?.message || 'Failed to load character')
      })
      .finally(() => {
        if (!cancelled) setLoadingTarget(false)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, initialTargetCharacter, selectedTargetId])

  const target = initialTargetCharacter ?? loadedTarget

  // Initialize merge defaults once both target and preview are available
  useEffect(() => {
    if (!isOpen || !target || !preview) return
    const init = buildInitialState(target, preview)
    setSelectedFields(init.selectedFields)
    setFirstMesMode(init.firstMesMode)
    setAlternateGreetingsMode(init.alternateGreetingsMode)
    setKeepExistingGreetingIndices(init.keepExistingGreetingIndices)
    setSelectedIncomingGreetingIndices(init.selectedIncomingGreetingIndices)
    setTagsMode(init.tagsMode)
    setAvatarMode(init.avatarMode)
    setExtensionsMode(init.extensionsMode)
    setWorldBookMode(init.worldBookMode)
    setRegexMode(init.regexMode)
    setCharxAssetsMode(init.charxAssetsMode)
  }, [isOpen, target, preview])

  const existingGreetingKeys = useMemo(() => {
    const keys = new Set<string>()
    if (!target) return keys
    if ((target.first_mes ?? '').trim()) keys.add(normalizeGreeting(target.first_mes))
    for (const g of target.alternate_greetings ?? []) {
      if (g.trim()) keys.add(normalizeGreeting(g))
    }
    return keys
  }, [target])

  const incomingAlternates = useMemo(
    () => preview?.incoming.alternate_greetings ?? [],
    [preview?.incoming.alternate_greetings],
  )
  const existingAlternates = useMemo(
    () => target?.alternate_greetings ?? [],
    [target?.alternate_greetings],
  )

  const newIncomingCount = useMemo(() => {
    return incomingAlternates.filter((g) => {
      const k = normalizeGreeting(g)
      return k && !existingGreetingKeys.has(k)
    }).length
  }, [incomingAlternates, existingGreetingKeys])

  const firstMesDiffers = !!target && !!preview && (preview.incoming.first_mes ?? '') !== (target.first_mes ?? '')
  const alternatesDiffer = useMemo(() => {
    if (!target || !preview) return false
    if (incomingAlternates.length !== existingAlternates.length) return true
    return incomingAlternates.some((g, idx) => g !== existingAlternates[idx])
  }, [target, preview, incomingAlternates, existingAlternates])

  const tagsInfo = useMemo(() => {
    if (!target || !preview) return { differs: false, added: [] as string[], removed: [] as string[] }
    const existingSet = new Set(target.tags ?? [])
    const incomingSet = new Set(preview.incoming.tags ?? [])
    const added = (preview.incoming.tags ?? []).filter((tag) => !existingSet.has(tag))
    const removed = (target.tags ?? []).filter((tag) => !incomingSet.has(tag))
    return {
      differs: added.length > 0 || removed.length > 0,
      added,
      removed,
    }
  }, [target, preview])

  const hasCharxAssets = useMemo(() => {
    if (!preview) return false
    const e = preview.extras
    return (
      e.galleryCount > 0 ||
      e.expressionCount > 0 ||
      e.expressionGroupCount > 0 ||
      e.alternateAvatarCount > 0 ||
      e.alternateFieldKeys.length > 0 ||
      e.landingPerspectiveLayerCount > 0
    )
  }, [preview])

  const hasWorldBooks = !!preview && (preview.extras.embeddedLorebookEntries > 0 || preview.extras.lumiverseWorldBookCount > 0)
  const hasRegexScripts = !!preview && preview.extras.regexScriptCount > 0
  const hasPortableExtensions = !!preview && Object.keys(preview.incoming.extensions ?? {}).length > 0

  const toggleDiffExpanded = useCallback((key: string) => {
    setExpandedDiffs((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const toggleGreetingPreview = useCallback((key: string) => {
    setExpandedGreetings((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const toggleScalarField = useCallback((field: CardScalarField, checked: boolean) => {
    setSelectedFields((prev) => {
      const next = new Set(prev)
      if (checked) next.add(field)
      else next.delete(field)
      return next
    })
  }, [])

  const applyPresetAll = useCallback(() => {
    if (!target || !preview) return
    const nextFields = new Set<CardScalarField>()
    for (const field of SCALAR_FIELDS) {
      if ((preview.incoming[field] ?? '') !== (target[field] ?? '')) {
        nextFields.add(field)
      }
    }
    setSelectedFields(nextFields)
    setFirstMesMode(firstMesDiffers ? 'replace' : 'keep')
    setAlternateGreetingsMode(newIncomingCount > 0 ? 'append_new' : alternatesDiffer ? 'replace_all' : 'keep')
    setTagsMode(tagsInfo.added.length > 0 ? 'merge' : tagsInfo.differs ? 'replace' : 'keep')
  }, [target, preview, firstMesDiffers, newIncomingCount, alternatesDiffer, tagsInfo])

  const applyPresetGreetingsOnly = useCallback(() => {
    setSelectedFields(new Set())
    setFirstMesMode((prev) => (firstMesDiffers ? (prev === 'replace_and_demote' ? 'replace_and_demote' : 'replace') : 'keep'))
    setAlternateGreetingsMode(newIncomingCount > 0 ? 'append_new' : alternatesDiffer ? 'replace_all' : 'keep')
    setTagsMode('keep')
    setAvatarMode('keep')
    setExtensionsMode('keep')
    setWorldBookMode('keep')
    setRegexMode('keep')
    setCharxAssetsMode('keep')
  }, [firstMesDiffers, newIncomingCount, alternatesDiffer])

  const applyPresetClear = useCallback(() => {
    setSelectedFields(new Set())
    setFirstMesMode('keep')
    setAlternateGreetingsMode('keep')
    setTagsMode('keep')
    setAvatarMode('keep')
    setExtensionsMode('keep')
    setWorldBookMode('keep')
    setRegexMode('keep')
    setCharxAssetsMode('keep')
  }, [])

  const selectedChangeCount = useMemo(() => {
    let count = selectedFields.size
    if (firstMesMode !== 'keep') count++
    if (alternateGreetingsMode !== 'keep') count++
    if (tagsMode !== 'keep') count++
    if (avatarMode !== 'keep') count++
    if (extensionsMode !== 'keep') count++
    if (worldBookMode !== 'keep') count++
    if (regexMode !== 'keep') count++
    if (charxAssetsMode !== 'keep') count++
    return count
  }, [
    selectedFields.size,
    firstMesMode,
    alternateGreetingsMode,
    tagsMode,
    avatarMode,
    extensionsMode,
    worldBookMode,
    regexMode,
    charxAssetsMode,
  ])

  const anyDifferencesDetected = useMemo(() => {
    if (!target || !preview) return false
    if (firstMesDiffers || alternatesDiffer || tagsInfo.differs) return true
    if (SCALAR_FIELDS.some((field) => (preview.incoming[field] ?? '') !== (target[field] ?? ''))) return true
    if (preview.hasAvatar || hasWorldBooks || hasRegexScripts || hasCharxAssets) return true
    return false
  }, [target, preview, firstMesDiffers, alternatesDiffer, tagsInfo.differs, hasWorldBooks, hasRegexScripts, hasCharxAssets])

  const handleApply = useCallback(async () => {
    if (!target || !file || selectedChangeCount === 0 || applying) return
    setApplying(true)
    try {
      const selection: CardUpdateSelection = {
        fields: Array.from(selectedFields),
        firstMesMode,
        alternateGreetingsMode,
        ...(alternateGreetingsMode === 'select'
          ? {
              keepExistingGreetingIndices,
              selectedIncomingGreetingIndices,
            }
          : {}),
        tagsMode,
        avatarMode,
        extensionsMode,
        worldBookMode,
        regexMode,
        charxAssetsMode,
      }
      const result = await charactersApi.applyCardUpdate(target.id, file, selection)
      onApplied(result.character, result.summary)
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('cardUpdate.applyFailed'))
    } finally {
      setApplying(false)
    }
  }, [
    target,
    file,
    selectedChangeCount,
    applying,
    selectedFields,
    firstMesMode,
    alternateGreetingsMode,
    keepExistingGreetingIndices,
    selectedIncomingGreetingIndices,
    tagsMode,
    avatarMode,
    extensionsMode,
    worldBookMode,
    regexMode,
    charxAssetsMode,
    onApplied,
    t,
  ])

  const handleImportAsNew = useCallback(async () => {
    if (!onImportAsNew || importingAsNew) return
    setImportingAsNew(true)
    try {
      await onImportAsNew()
    } finally {
      setImportingAsNew(false)
    }
  }, [onImportAsNew, importingAsNew])

  const activeMatch = useMemo(
    () => matches?.find((m) => m.id === selectedTargetId) ?? matches?.[0] ?? null,
    [matches, selectedTargetId],
  )

  const renderMatchReason = (reason: CharacterUpdateMatchCandidate['matchReason']) => {
    if (reason === 'source_filename') return t('cardUpdate.matchReasonFilename')
    if (reason === 'name_and_creator') return t('cardUpdate.matchReasonNameCreator')
    return t('cardUpdate.matchReasonName')
  }

  return (
    <ModalShell
      isOpen={isOpen && !!preview}
      onClose={() => !applying && !importingAsNew && onClose()}
      maxWidth={760}
      mobilePresentation="fullscreen"
      modalId="card-update"
      data-component="CardUpdateModal"
    >
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <FileDiff size={18} />
          <div className={styles.titleGroup}>
            <div className={styles.titleRow}>
              <span className={styles.title}>{t('cardUpdate.title')}</span>
              {preview && (
                <span className={styles.formatBadge}>{formatBadgeLabel(preview.format)}</span>
              )}
            </div>
            {preview?.filename && (
              <span className={styles.filename}>{preview.filename}</span>
            )}
          </div>
        </div>
        <CloseButton onClick={() => !applying && !importingAsNew && onClose()} />
      </div>

      {matches && matches.length > 0 && (
        <div className={styles.matchBanner}>
          <div className={styles.matchBannerInfo}>
            {(target?.image_id || activeMatch?.image_id) && (
              <img
                src={charactersApi.avatarUrl(target?.id ?? activeMatch!.id)}
                alt={target?.name ?? activeMatch?.name ?? ''}
                className={styles.matchAvatar}
              />
            )}
            <div className={styles.matchText}>
              <span className={styles.matchHeading}>
                {t('cardUpdate.existingMatchFound', {
                  name: target?.name ?? activeMatch?.name ?? '',
                })}
              </span>
              {activeMatch && (
                <span className={styles.matchSub}>
                  {renderMatchReason(activeMatch.matchReason)}
                  {activeMatch.creator ? ` · ${activeMatch.creator}` : ''}
                </span>
              )}
            </div>
          </div>

          <div className={styles.matchActions}>
            {matches.length > 1 && (
              <select
                className={styles.matchSelect}
                value={selectedTargetId}
                onChange={(e) => setSelectedTargetId(e.target.value)}
                disabled={applying || importingAsNew}
              >
                {matches.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}{m.creator ? ` (${m.creator})` : ''}
                  </option>
                ))}
              </select>
            )}
            {onImportAsNew && (
              <Button
                variant="secondary"
                size="sm"
                icon={<UserPlus size={14} />}
                loading={importingAsNew}
                disabled={applying}
                onClick={() => void handleImportAsNew()}
              >
                {t('cardUpdate.importAsNew')}
              </Button>
            )}
          </div>
        </div>
      )}

      {target && preview && (
        <div className={styles.toolbar}>
          <div className={styles.presetGroup}>
            <button type="button" className={styles.presetBtn} onClick={applyPresetAll}>
              {t('cardUpdate.presetAllChanges')}
            </button>
            <button type="button" className={styles.presetBtn} onClick={applyPresetGreetingsOnly}>
              {t('cardUpdate.presetGreetingsOnly')}
            </button>
            <button type="button" className={styles.presetBtn} onClick={applyPresetClear}>
              {t('cardUpdate.presetClear')}
            </button>
          </div>
          <Toggle.Checkbox
            checked={showUnchanged}
            onChange={setShowUnchanged}
            label={t('cardUpdate.showUnchanged')}
          />
        </div>
      )}

      <div className={styles.body}>
        {loadingTarget && (
          <div className={styles.loadingState}>
            <Spinner size={18} fast />
            <span>{t('cardUpdate.loadingTarget')}</span>
          </div>
        )}

        {loadError && !loadingTarget && (
          <div className={styles.noDiffNotice}>
            <span>{loadError}</span>
          </div>
        )}

        {target && preview && !loadingTarget && (
          <>
            {!anyDifferencesDetected && (
              <div className={styles.noDiffNotice}>
                <CheckCircle2 size={16} />
                <span>{t('cardUpdate.noDifferences')}</span>
              </div>
            )}

            {/* ── Greetings Section ── */}
            {(firstMesDiffers || alternatesDiffer || newIncomingCount > 0 || showUnchanged) && (
              <div className={styles.section}>
                <div className={styles.sectionHeader}>
                  <span className={styles.sectionTitle}>{t('cardUpdate.sectionGreetings')}</span>
                </div>

                {(firstMesDiffers || showUnchanged) && (
                  <div className={clsx(styles.cardBlock, firstMesDiffers && styles.cardBlockChanged)}>
                    <div className={styles.cardBlockHeader}>
                      <div className={styles.cardBlockLeft}>
                        <span className={styles.fieldLabel}>{t('cardUpdate.fields.first_mes')}</span>
                        <span className={clsx(styles.statusPill, firstMesDiffers ? styles.pillChanged : styles.pillSame)}>
                          {firstMesDiffers ? t('cardUpdate.changed') : t('cardUpdate.unchanged')}
                        </span>
                        {firstMesDiffers && (() => {
                          const counts = countDiffLines(computeLineDiff(target.first_mes ?? '', preview.incoming.first_mes ?? ''))
                          return (
                            <span className={styles.diffStats}>
                              {counts.added > 0 && <span className={styles.statAdded}>+{counts.added}</span>}
                              {counts.removed > 0 && <span className={styles.statRemoved}>-{counts.removed}</span>}
                            </span>
                          )
                        })()}
                      </div>
                      <div className={styles.cardBlockRight}>
                        <select
                          className={styles.modeSelect}
                          value={firstMesMode}
                          onChange={(e) => setFirstMesMode(e.target.value as FirstMesUpdateMode)}
                        >
                          <option value="keep">{t('cardUpdate.modes.keepCurrent')}</option>
                          <option value="replace">{t('cardUpdate.modes.replace')}</option>
                          {(target.first_mes ?? '').trim().length > 0 && (
                            <option value="replace_and_demote">
                              {t('cardUpdate.modes.replaceAndDemote')}
                            </option>
                          )}
                        </select>
                        {firstMesDiffers && (
                          <button
                            type="button"
                            className={styles.expandBtn}
                            onClick={() => toggleDiffExpanded('first_mes')}
                          >
                            {expandedDiffs.has('first_mes') ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            <span>{t('cardUpdate.diff')}</span>
                          </button>
                        )}
                      </div>
                    </div>
                    {expandedDiffs.has('first_mes') && firstMesDiffers && (
                      <DiffBlock oldText={target.first_mes ?? ''} newText={preview.incoming.first_mes ?? ''} />
                    )}
                  </div>
                )}

                {(alternatesDiffer || incomingAlternates.length > 0 || showUnchanged) && (
                  <div className={clsx(styles.cardBlock, alternatesDiffer && styles.cardBlockChanged)}>
                    <div className={styles.cardBlockHeader}>
                      <div className={styles.cardBlockLeft}>
                        <span className={styles.fieldLabel}>{t('cardUpdate.fields.alternate_greetings')}</span>
                        {newIncomingCount > 0 ? (
                          <span className={clsx(styles.statusPill, styles.pillNew)}>
                            {t('cardUpdate.newGreetingsCount', { count: newIncomingCount })}
                          </span>
                        ) : (
                          <span className={clsx(styles.statusPill, alternatesDiffer ? styles.pillChanged : styles.pillSame)}>
                            {alternatesDiffer
                              ? t('cardUpdate.incomingCount', { count: incomingAlternates.length })
                              : t('cardUpdate.unchanged')}
                          </span>
                        )}
                      </div>
                      <div className={styles.cardBlockRight}>
                        <select
                          className={styles.modeSelect}
                          value={alternateGreetingsMode}
                          onChange={(e) => setAlternateGreetingsMode(e.target.value as AlternateGreetingsUpdateMode)}
                        >
                          <option value="keep">{t('cardUpdate.modes.keepCurrent')}</option>
                          {newIncomingCount > 0 && (
                            <option value="append_new">
                              {t('cardUpdate.modes.appendNewGreetings', { count: newIncomingCount })}
                            </option>
                          )}
                          <option value="select">{t('cardUpdate.modes.pickGreetings')}</option>
                          <option value="replace_all">{t('cardUpdate.modes.replaceAll')}</option>
                        </select>
                      </div>
                    </div>

                    {(alternateGreetingsMode === 'append_new' || alternateGreetingsMode === 'select' || (alternatesDiffer && expandedDiffs.has('alternate_greetings'))) && (
                      <div className={styles.greetingList}>
                        {alternateGreetingsMode === 'select' && existingAlternates.length > 0 && (
                          <>
                            <div className={styles.greetingSubheading}>
                              {t('cardUpdate.existingAlternateGreetings')}
                            </div>
                            {existingAlternates.map((greeting, idx) => {
                              const checked = keepExistingGreetingIndices.includes(idx)
                              const previewKey = `existing-${idx}`
                              const isExpanded = expandedGreetings.has(previewKey)
                              return (
                                <label key={previewKey} className={styles.greetingItem}>
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={(e) => {
                                      setKeepExistingGreetingIndices((prev) =>
                                        e.target.checked
                                          ? [...prev, idx].sort((a, b) => a - b)
                                          : prev.filter((i) => i !== idx),
                                      )
                                    }}
                                  />
                                  <div className={styles.greetingBody}>
                                    <div className={styles.greetingMetaRow}>
                                      <span className={styles.greetingTitle}>
                                        {t('cardUpdate.greetingNumber', { number: idx + 1 })}
                                      </span>
                                      <span className={clsx(styles.statusPill, styles.pillSame)}>
                                        {t('cardUpdate.currentLabel')}
                                      </span>
                                      {greeting.length > 180 && (
                                        <button
                                          type="button"
                                          className={styles.expandBtn}
                                          onClick={(e) => {
                                            e.preventDefault()
                                            toggleGreetingPreview(previewKey)
                                          }}
                                        >
                                          {isExpanded ? t('cardUpdate.less') : t('cardUpdate.more')}
                                        </button>
                                      )}
                                    </div>
                                    <div
                                      className={clsx(
                                        styles.greetingPreview,
                                        !isExpanded && styles.greetingPreviewCollapsed,
                                      )}
                                    >
                                      {greeting}
                                    </div>
                                  </div>
                                </label>
                              )
                            })}
                          </>
                        )}

                        {incomingAlternates.length > 0 && (
                          <>
                            <div className={styles.greetingSubheading}>
                              {t('cardUpdate.incomingAlternateGreetings')}
                            </div>
                            {incomingAlternates.map((greeting, idx) => {
                              const isDuplicate = existingGreetingKeys.has(normalizeGreeting(greeting))
                              const checked =
                                alternateGreetingsMode === 'append_new'
                                  ? !isDuplicate
                                  : selectedIncomingGreetingIndices.includes(idx)
                              const previewKey = `incoming-${idx}`
                              const isExpanded = expandedGreetings.has(previewKey)
                              return (
                                <label key={previewKey} className={styles.greetingItem}>
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={(e) => {
                                      if (alternateGreetingsMode === 'append_new') {
                                        // Promote to custom selection so user can pick/unpick individual incoming items
                                        setAlternateGreetingsMode('select')
                                        setKeepExistingGreetingIndices(existingAlternates.map((_, i) => i))
                                        const defaultIncoming = incomingAlternates
                                          .map((g, i) => (!existingGreetingKeys.has(normalizeGreeting(g)) ? i : -1))
                                          .filter((i) => i >= 0)
                                        setSelectedIncomingGreetingIndices(
                                          e.target.checked
                                            ? [...new Set([...defaultIncoming, idx])].sort((a, b) => a - b)
                                            : defaultIncoming.filter((i) => i !== idx),
                                        )
                                        return
                                      }
                                      setSelectedIncomingGreetingIndices((prev) =>
                                        e.target.checked
                                          ? [...prev, idx].sort((a, b) => a - b)
                                          : prev.filter((i) => i !== idx),
                                      )
                                    }}
                                  />
                                  <div className={styles.greetingBody}>
                                    <div className={styles.greetingMetaRow}>
                                      <span className={styles.greetingTitle}>
                                        {t('cardUpdate.greetingNumber', { number: idx + 1 })}
                                      </span>
                                      <span className={clsx(styles.statusPill, isDuplicate ? styles.pillSame : styles.pillNew)}>
                                        {isDuplicate ? t('cardUpdate.alreadyExists') : t('cardUpdate.newBadge')}
                                      </span>
                                      {greeting.length > 180 && (
                                        <button
                                          type="button"
                                          className={styles.expandBtn}
                                          onClick={(e) => {
                                            e.preventDefault()
                                            toggleGreetingPreview(previewKey)
                                          }}
                                        >
                                          {isExpanded ? t('cardUpdate.less') : t('cardUpdate.more')}
                                        </button>
                                      )}
                                    </div>
                                    <div
                                      className={clsx(
                                        styles.greetingPreview,
                                        !isExpanded && styles.greetingPreviewCollapsed,
                                      )}
                                    >
                                      {greeting}
                                    </div>
                                  </div>
                                </label>
                              )
                            })}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── Core Text Fields ── */}
            {(() => {
              const visibleFields = SCALAR_FIELDS.filter(
                (field) => showUnchanged || (preview.incoming[field] ?? '') !== (target[field] ?? ''),
              )
              if (visibleFields.length === 0) return null
              return (
                <div className={styles.section}>
                  <div className={styles.sectionHeader}>
                    <span className={styles.sectionTitle}>{t('cardUpdate.sectionFields')}</span>
                  </div>
                  {visibleFields.map((field) => {
                    const oldVal = target[field] ?? ''
                    const newVal = preview.incoming[field] ?? ''
                    const changed = oldVal !== newVal
                    const checked = selectedFields.has(field)
                    const diffCounts = changed ? countDiffLines(computeLineDiff(oldVal, newVal)) : null
                    return (
                      <div key={field} className={clsx(styles.cardBlock, changed && styles.cardBlockChanged)}>
                        <div className={styles.cardBlockHeader}>
                          <div className={styles.cardBlockLeft}>
                            <Toggle.Checkbox
                              checked={checked}
                              onChange={(val) => toggleScalarField(field, val)}
                              disabled={!changed}
                              label={<span className={styles.fieldLabel}>{t(`cardUpdate.fields.${field}`)}</span>}
                            />
                            <span className={clsx(styles.statusPill, changed ? styles.pillChanged : styles.pillSame)}>
                              {changed ? t('cardUpdate.changed') : t('cardUpdate.unchanged')}
                            </span>
                            {diffCounts && (
                              <span className={styles.diffStats}>
                                {diffCounts.added > 0 && <span className={styles.statAdded}>+{diffCounts.added}</span>}
                                {diffCounts.removed > 0 && <span className={styles.statRemoved}>-{diffCounts.removed}</span>}
                              </span>
                            )}
                          </div>
                          {changed && (
                            <div className={styles.cardBlockRight}>
                              <button
                                type="button"
                                className={styles.expandBtn}
                                onClick={() => toggleDiffExpanded(field)}
                              >
                                {expandedDiffs.has(field) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                                <span>{t('cardUpdate.diff')}</span>
                              </button>
                            </div>
                          )}
                        </div>
                        {expandedDiffs.has(field) && changed && (
                          <DiffBlock oldText={oldVal} newText={newVal} />
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })()}

            {/* ── Tags, Media & Embedded Extras ── */}
            {(tagsInfo.differs || preview.hasAvatar || hasWorldBooks || hasRegexScripts || hasCharxAssets || hasPortableExtensions || showUnchanged) && (
              <div className={styles.section}>
                <div className={styles.sectionHeader}>
                  <span className={styles.sectionTitle}>{t('cardUpdate.sectionExtras')}</span>
                </div>

                {(tagsInfo.differs || showUnchanged) && (
                  <div className={clsx(styles.cardBlock, tagsInfo.differs && styles.cardBlockChanged)}>
                    <div className={styles.cardBlockHeader}>
                      <div className={styles.cardBlockLeft}>
                        <span className={styles.fieldLabel}>{t('cardUpdate.fields.tags')}</span>
                        <span className={clsx(styles.statusPill, tagsInfo.differs ? styles.pillChanged : styles.pillSame)}>
                          {tagsInfo.differs ? t('cardUpdate.changed') : t('cardUpdate.unchanged')}
                        </span>
                      </div>
                      <div className={styles.cardBlockRight}>
                        <select
                          className={styles.modeSelect}
                          value={tagsMode}
                          onChange={(e) => setTagsMode(e.target.value as TagsUpdateMode)}
                        >
                          <option value="keep">{t('cardUpdate.modes.keepCurrent')}</option>
                          <option value="merge">{t('cardUpdate.modes.mergeTags')}</option>
                          <option value="replace">{t('cardUpdate.modes.replace')}</option>
                        </select>
                      </div>
                    </div>
                    {tagsInfo.differs && (
                      <div className={styles.tagsCompare}>
                        {tagsInfo.added.map((tag) => (
                          <span key={`add-${tag}`} className={clsx(styles.tagChip, styles.tagChipAdded)}>
                            + {tag}
                          </span>
                        ))}
                        {tagsInfo.removed.map((tag) => (
                          <span key={`rem-${tag}`} className={clsx(styles.tagChip, styles.tagChipRemoved)}>
                            - {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {preview.hasAvatar && (
                  <div className={styles.cardBlock}>
                    <div className={styles.cardBlockHeader}>
                      <div className={styles.cardBlockLeft}>
                        <span className={styles.fieldLabel}>{t('cardUpdate.fields.avatar')}</span>
                      </div>
                      <div className={styles.cardBlockRight}>
                        <select
                          className={styles.modeSelect}
                          value={avatarMode}
                          onChange={(e) => setAvatarMode(e.target.value as AvatarUpdateMode)}
                        >
                          <option value="keep">{t('cardUpdate.modes.keepCurrent')}</option>
                          <option value="replace_primary">{t('cardUpdate.modes.replaceAvatar')}</option>
                          <option value="add_alternate">{t('cardUpdate.modes.addAlternateAvatar')}</option>
                        </select>
                      </div>
                    </div>
                    <div className={styles.avatarCompare}>
                      <div className={styles.avatarSlot}>
                        {target.image_id ? (
                          <img
                            src={charactersApi.avatarUrl(target.id)}
                            alt={target.name}
                            className={styles.avatarThumb}
                          />
                        ) : (
                          <div className={styles.avatarPlaceholder}>{t('cardUpdate.none')}</div>
                        )}
                        <span className={styles.avatarSlotLabel}>{t('cardUpdate.currentLabel')}</span>
                      </div>
                      <ArrowRight size={16} />
                      <div className={styles.avatarSlot}>
                        {preview.avatarPreviewUrl ? (
                          <img
                            src={preview.avatarPreviewUrl}
                            alt={preview.incoming.name}
                            className={styles.avatarThumb}
                          />
                        ) : (
                          <div className={styles.avatarPlaceholder}>{t('cardUpdate.newBadge')}</div>
                        )}
                        <span className={styles.avatarSlotLabel}>{t('cardUpdate.incomingLabel')}</span>
                      </div>
                    </div>
                  </div>
                )}

                {hasWorldBooks && (
                  <div className={styles.cardBlock}>
                    <div className={styles.cardBlockHeader}>
                      <div className={styles.cardBlockLeft}>
                        <span className={styles.fieldLabel}>{t('cardUpdate.fields.worldBook')}</span>
                        <span className={clsx(styles.statusPill, styles.pillNew)}>
                          {preview.extras.lumiverseWorldBookCount > 0
                            ? t('cardUpdate.worldBooksCount', { count: preview.extras.lumiverseWorldBookCount })
                            : t('cardUpdate.entriesCount', { count: preview.extras.embeddedLorebookEntries })}
                        </span>
                      </div>
                      <div className={styles.cardBlockRight}>
                        <select
                          className={styles.modeSelect}
                          value={worldBookMode}
                          onChange={(e) => setWorldBookMode(e.target.value as WorldBookUpdateMode)}
                        >
                          <option value="keep">{t('cardUpdate.modes.keepCurrent')}</option>
                          <option value="import_new">{t('cardUpdate.modes.importAndLinkWorldBook')}</option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}

                {hasRegexScripts && (
                  <div className={styles.cardBlock}>
                    <div className={styles.cardBlockHeader}>
                      <div className={styles.cardBlockLeft}>
                        <span className={styles.fieldLabel}>{t('cardUpdate.fields.regexScripts')}</span>
                        <span className={clsx(styles.statusPill, styles.pillNew)}>
                          {t('cardUpdate.scriptsCount', { count: preview.extras.regexScriptCount })}
                        </span>
                      </div>
                      <div className={styles.cardBlockRight}>
                        <select
                          className={styles.modeSelect}
                          value={regexMode}
                          onChange={(e) => setRegexMode(e.target.value as RegexUpdateMode)}
                        >
                          <option value="keep">{t('cardUpdate.modes.keepCurrent')}</option>
                          <option value="merge_new">{t('cardUpdate.modes.mergeNewRegex')}</option>
                          <option value="replace_character_bound">{t('cardUpdate.modes.replaceRegex')}</option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}

                {hasCharxAssets && (
                  <div className={styles.cardBlock}>
                    <div className={styles.cardBlockHeader}>
                      <div className={styles.cardBlockLeft}>
                        <span className={styles.fieldLabel}>{t('cardUpdate.fields.charxAssets')}</span>
                        <span className={clsx(styles.statusPill, styles.pillNew)}>CHARX</span>
                      </div>
                      <div className={styles.cardBlockRight}>
                        <select
                          className={styles.modeSelect}
                          value={charxAssetsMode}
                          onChange={(e) => setCharxAssetsMode(e.target.value as CharxAssetsUpdateMode)}
                        >
                          <option value="keep">{t('cardUpdate.modes.keepCurrent')}</option>
                          <option value="merge">{t('cardUpdate.modes.mergeMissingAssets')}</option>
                          <option value="replace">{t('cardUpdate.modes.replaceAssets')}</option>
                        </select>
                      </div>
                    </div>
                    <div className={styles.extrasSummary}>
                      {[
                        preview.extras.expressionCount > 0 && t('cardUpdate.summaryExpressions', { count: preview.extras.expressionCount }),
                        preview.extras.expressionGroupCount > 0 && t('cardUpdate.summaryExpressionGroups', { count: preview.extras.expressionGroupCount }),
                        preview.extras.galleryCount > 0 && t('cardUpdate.summaryGallery', { count: preview.extras.galleryCount }),
                        preview.extras.alternateAvatarCount > 0 && t('cardUpdate.summaryAlternateAvatars', { count: preview.extras.alternateAvatarCount }),
                        preview.extras.alternateFieldKeys.length > 0 && t('cardUpdate.summaryAlternateFields', { count: preview.extras.alternateFieldKeys.length }),
                        preview.extras.landingPerspectiveLayerCount > 0 && t('cardUpdate.summaryPerspectiveLayers', { count: preview.extras.landingPerspectiveLayerCount }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </div>
                )}

                {hasPortableExtensions && (
                  <div className={styles.cardBlock}>
                    <div className={styles.cardBlockHeader}>
                      <div className={styles.cardBlockLeft}>
                        <span className={styles.fieldLabel}>{t('cardUpdate.fields.extensions')}</span>
                      </div>
                      <div className={styles.cardBlockRight}>
                        <select
                          className={styles.modeSelect}
                          value={extensionsMode}
                          onChange={(e) => setExtensionsMode(e.target.value as ExtensionsUpdateMode)}
                        >
                          <option value="keep">{t('cardUpdate.modes.keepCurrent')}</option>
                          <option value="merge_portable">{t('cardUpdate.modes.mergePortableExtensions')}</option>
                          <option value="replace_portable">{t('cardUpdate.modes.replacePortableExtensions')}</option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className={styles.footer}>
        <span className={styles.footerHint}>
          {selectedChangeCount > 0
            ? t('cardUpdate.selectedSummary', { count: selectedChangeCount })
            : t('cardUpdate.nothingSelected')}
        </span>
        <div className={styles.footerActions}>
          <Button variant="ghost" onClick={onClose} disabled={applying || importingAsNew}>
            {tc('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            icon={<Sparkles size={14} />}
            loading={applying}
            disabled={!target || !file || selectedChangeCount === 0 || loadingTarget || importingAsNew}
            onClick={() => void handleApply()}
          >
            {selectedChangeCount > 0
              ? t('cardUpdate.applyUpdatesCount', { count: selectedChangeCount })
              : t('cardUpdate.applyUpdates')}
          </Button>
        </div>
      </div>
    </ModalShell>
  )
}
