import { useEffect, useMemo, useState } from 'react'
import { useStore } from '@/store'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import VoicePicker from '@/components/shared/VoicePicker'
import { Button } from '@/components/shared/FormComponents'
import { ttsConnectionsApi } from '@/api/tts-connections'
import { chatsApi } from '@/api/chats'
import { toast } from '@/lib/toast'
import type { VoiceRef } from '@/types/api'

/**
 * Parse a free-form metadata blob into a VoiceRef. Returns null on shape
 * mismatch so untyped chat.metadata can't crash the editor.
 */
function readVoiceRef(value: unknown): VoiceRef | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.connectionId !== 'string' || !v.connectionId) return null
  const voice = typeof v.voice === 'string' ? v.voice : ''
  const parameters =
    v.parameters && typeof v.parameters === 'object'
      ? { speed: typeof (v.parameters as any).speed === 'number' ? (v.parameters as any).speed : undefined }
      : undefined
  return { connectionId: v.connectionId, voice, parameters }
}

/**
 * Per-member voice override modal. Writes to
 * `chat.metadata.voiceOverrides.characters[characterId]` via patchMetadata —
 * the server's metadata patch is shallow, so we send the FULL voiceOverrides
 * object on each save to avoid clobbering siblings.
 */
export default function MemberVoiceModal() {
  const closeModal = useStore((s) => s.closeModal)
  const modalProps = useStore((s) => s.modalProps)
  const activeChatMetadata = useStore((s) => s.activeChatMetadata)
  const setActiveChatMetadata = useStore((s) => s.setActiveChatMetadata)
  const characters = useStore((s) => s.characters)
  const ttsProfiles = useStore((s) => s.ttsProfiles)
  const setTtsProfiles = useStore((s) => s.setTtsProfiles)
  const setTtsProviders = useStore((s) => s.setTtsProviders)

  const chatId: string | undefined = modalProps.chatId
  const characterId: string | undefined = modalProps.characterId
  const character = useMemo(
    () => (characterId ? characters.find((c) => c.id === characterId) ?? null : null),
    [characterId, characters],
  )

  // Lazy-load TTS profiles if the user opened the modal without visiting
  // Voice settings first.
  useEffect(() => {
    if (ttsProfiles.length === 0) {
      ttsConnectionsApi.list().then((res) => setTtsProfiles(res.data || [])).catch(() => {})
    }
    ttsConnectionsApi.providers().then((res) => setTtsProviders(res.providers || [])).catch(() => {})
  }, [ttsProfiles.length, setTtsProfiles, setTtsProviders])

  const existingOverride = useMemo(() => {
    const overrides = activeChatMetadata?.voiceOverrides
    if (!overrides || typeof overrides !== 'object') return null
    const chars = (overrides as any).characters
    if (!chars || typeof chars !== 'object' || !characterId) return null
    return readVoiceRef(chars[characterId])
  }, [activeChatMetadata, characterId])

  const characterDefault = useMemo(
    () => readVoiceRef(character?.extensions?.ttsVoice),
    [character],
  )

  const [draft, setDraft] = useState<VoiceRef | null>(existingOverride)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!chatId || !characterId) return closeModal()
    setSaving(true)
    try {
      // Re-read metadata at save time so concurrent edits to OTHER members
      // aren't dropped. The /metadata PATCH is shallow at the top level —
      // we still need to hand back the full `voiceOverrides` blob.
      const current = activeChatMetadata?.voiceOverrides ?? {}
      const currentChars = (current as any).characters ?? {}
      const nextChars = { ...currentChars }
      if (draft) {
        nextChars[characterId] = draft
      } else {
        delete nextChars[characterId]
      }
      const nextOverrides = {
        ...(current as any),
        characters: nextChars,
      }
      // If both narrator and characters are empty, drop voiceOverrides
      // entirely to keep metadata tidy.
      const isEmpty =
        !nextOverrides.narrator
        && Object.keys(nextOverrides.characters || {}).length === 0
      const updated = await chatsApi.patchMetadata(chatId, {
        voiceOverrides: isEmpty ? null : nextOverrides,
      })
      setActiveChatMetadata(updated.metadata ?? null)
      closeModal()
    } catch (err: any) {
      console.error('[MemberVoiceModal] Save failed:', err)
      toast.error(err?.body?.error || err?.message || 'Failed to save voice override')
    } finally {
      setSaving(false)
    }
  }

  if (!chatId || !characterId || !character) {
    return null
  }

  return (
    <ModalShell isOpen onClose={closeModal} maxWidth={460}>
      <CloseButton onClick={closeModal} variant="solid" position="absolute" />

      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Voice — {character.name}</h3>
        <div style={{ fontSize: 12, color: 'var(--text-secondary, #a0a0a8)' }}>
          Override {character.name}&apos;s voice for this chat only. Leave unset to use
          {characterDefault ? ' the character’s default voice' : ' the global default'}.
        </div>

        <VoicePicker
          value={draft}
          onChange={setDraft}
          ariaLabel={`${character.name} voice`}
          clearLabel={characterDefault ? 'Use character default' : 'Use global default'}
          portal
        />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <Button onClick={closeModal} disabled={saving} variant="ghost">Cancel</Button>
          <Button onClick={save} disabled={saving} variant="primary">
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </ModalShell>
  )
}
