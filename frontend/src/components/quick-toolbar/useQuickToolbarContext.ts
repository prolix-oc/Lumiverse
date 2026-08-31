import { useMemo } from 'react'
import { useStore } from '@/store'

/**
 * Contextual sub-labels for the V2 settings-adjacent cards, keyed by action id.
 * Actions without a known context render as a plain title, which is what the
 * confirmed design shows for the trailing utility cards.
 *
 * **The rule this file exists to enforce:** a card's value describes *the surface
 * that card opens*, resolved from `DRAWER_TABS` — never "whatever is related to
 * the id's name". Two ids that open different panels must never be handed the
 * same string. With "Show labels" off (`QuickToolbar.tsx:386` drops `.cardTitle`)
 * the value is the *only* text on the card, so a shared value renders as two
 * visually identical, meaningless cards — the duplicate-"Narrator" bug.
 *
 * Each value is therefore self-describing on its own, not just as a completion of
 * its hidden heading.
 */
export function useQuickToolbarContext(): Record<string, string> {
  const characters = useStore((s) => s.characters)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const personas = useStore((s) => s.personas)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const profiles = useStore((s) => s.profiles)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const activatedWorldInfo = useStore((s) => s.activatedWorldInfo)
  const reasoningSettings = useStore((s) => s.reasoningSettings)
  const selectedLoomStyles = useStore((s) => s.selectedLoomStyles)
  const selectedLoomUtils = useStore((s) => s.selectedLoomUtils)
  const selectedLoomRetrofits = useStore((s) => s.selectedLoomRetrofits)
  const loomRegistry = useStore((s) => s.loomRegistry)
  const activeLoomPresetId = useStore((s) => s.activeLoomPresetId)

  return useMemo(() => {
    const characterName = characters.find((character) => character.id === activeCharacterId)?.name
    const personaName = personas.find((persona) => persona.id === activePersonaId)?.name
    const connectionName = profiles.find((profile) => profile.id === activeProfileId && profile.review_required !== true)?.name
      ?? profiles.find((profile) => profile.is_default && profile.review_required !== true)?.name
    const loreLabel = `${activatedWorldInfo.length} ${activatedWorldInfo.length === 1 ? 'entry' : 'entries'}`
    // `characters` opens CharacterBrowser — the *library*, not the active card —
    // so it reports inventory. This is the half of the duplicate-"Narrator" fix
    // that had to change: the active character belongs to `profile` below.
    const libraryLabel = `${characters.length} ${characters.length === 1 ? 'card' : 'cards'}`
    // `presets` opens PresetManager, which despite its id and filename is the
    // **Reasoning** panel (`DRAWER_TABS` id `presets` → tabName 'Reasoning' →
    // `<PresetManager />`, which reads `reasoningSettings`/`promptBias` and never
    // touches `activePresetId`). So the card reports reasoning state.
    // `|| 'auto'` mirrors REASONING_DEFAULTS rather than trusting the persisted
    // blob: this runs inside a render, so an absent field would crash the strip.
    const effort = reasoningSettings.reasoningEffort || 'auto'
    const reasoningLabel = reasoningSettings.apiReasoning
      ? `${effort.charAt(0).toUpperCase()}${effort.slice(1)} effort`
      : 'Reasoning off'
    // `prompt` opens PromptPanel ("Composition"). Mirrors the three counters the
    // panel itself renders (`PromptPanel.tsx:185-187`).
    const loomItemCount = selectedLoomStyles.length + selectedLoomUtils.length + selectedLoomRetrofits.length
    const compositionLabel = loomItemCount === 0
      ? 'No Loom items'
      : `${loomItemCount} Loom ${loomItemCount === 1 ? 'item' : 'items'}`
    // The live "active preset" is `activeLoomPresetId` — `getActivePresetForGeneration()`
    // returns it, and nothing in the UI ever calls `setActivePreset`, so the old
    // `presets[activePresetId]?.name` lookup resolved to `undefined` in practice.
    // The name belongs to `loom`, the tab that actually selects it.
    const loomPresetName = activeLoomPresetId ? loomRegistry[activeLoomPresetId]?.name : undefined

    const context: Record<string, string> = {
      lorebook: loreLabel,
      worldinfo: loreLabel,
      characters: libraryLabel,
      presets: reasoningLabel,
      prompt: compositionLabel,
    }
    if (characterName) context.profile = characterName
    if (personaName) context.personas = personaName
    if (connectionName) context.connections = connectionName
    if (loomPresetName) context.loom = loomPresetName
    return context
  }, [
    activatedWorldInfo.length,
    activeCharacterId,
    activeLoomPresetId,
    activePersonaId,
    activeProfileId,
    characters,
    loomRegistry,
    personas,
    profiles,
    reasoningSettings.apiReasoning,
    reasoningSettings.reasoningEffort,
    selectedLoomRetrofits.length,
    selectedLoomStyles.length,
    selectedLoomUtils.length,
  ])
}
