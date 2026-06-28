import { useEffect, useMemo } from 'react'
import { useStore } from '@/store'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import QwenCustomVoiceManager from '@/components/panels/tts-connections/QwenCustomVoiceManager'

export default function QwenCustomVoiceModal() {
  const closeModal = useStore((s) => s.closeModal)
  const modalProps = useStore((s) => s.modalProps)
  const ttsProfiles = useStore((s) => s.ttsProfiles)
  const updateTtsProfile = useStore((s) => s.updateTtsProfile)

  const connectionId = typeof modalProps.connectionId === 'string' ? modalProps.connectionId : ''
  const profile = useMemo(
    () => ttsProfiles.find((item) => item.id === connectionId) ?? null,
    [ttsProfiles, connectionId],
  )

  useEffect(() => {
    if (connectionId && !profile) closeModal()
  }, [connectionId, profile, closeModal])

  if (!profile) return null

  return (
    <ModalShell
      isOpen
      onClose={closeModal}
      maxWidth="clamp(360px, 94vw, min(760px, var(--lumiverse-content-max-width, 760px)))"
      maxHeight="86vh"
    >
      <CloseButton onClick={closeModal} variant="solid" position="absolute" />
      <QwenCustomVoiceManager
        profile={profile}
        onUpdate={(updated) => updateTtsProfile(updated.id, updated)}
      />
    </ModalShell>
  )
}
