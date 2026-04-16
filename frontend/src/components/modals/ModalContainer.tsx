import { useEffect } from 'react'
import { useStore } from '@/store'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import SettingsModal from './SettingsModal'
import GreetingPickerModal from './GreetingPickerModal'
import WorldBookEditorModal from './WorldBookEditorModal'
import LumiaEditorModal from '@/components/panels/creator-workshop/LumiaEditorModal'
import LoomEditorModal from '@/components/panels/creator-workshop/LoomEditorModal'
import ToolEditorModal from '@/components/panels/creator-workshop/ToolEditorModal'
import DryRunModal from './DryRunModal'
import PromptItemizerModal from './PromptItemizerModal'
import GroupChatCreatorModal from './GroupChatCreatorModal'
import AddGroupMemberModal from '@/components/chat/AddGroupMemberModal'
import ManageChatsModal from './ManageChatsModal'
import ChatPickerModal from './ChatPickerModal'
import MemoryCortexDiagnosticsModal from './MemoryCortexDiagnosticsModal'
import PermissionRequestModal from './PermissionRequestModal'
import CommandPalette from './CommandPalette'
import RegexEditorModal from './RegexEditorModal'
import RegexImportModal from './RegexImportModal'
import RegenFeedbackModal from './RegenFeedbackModal'
import PersonaAddonsModal from './PersonaAddonsModal'
import GlobalAddonsLibraryModal from './GlobalAddonsLibraryModal'
import GroupSettingsModal from './GroupSettingsModal'
import CustomCSSModal from './CustomCSSModal'
import { DreamWeaverStudio } from '@/components/dream-weaver/DreamWeaverStudio'

export default function ModalContainer() {
  const settingsModalOpen = useStore((s) => s.settingsModalOpen)
  const closeSettings = useStore((s) => s.closeSettings)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      useStore.getState().openSettings(detail?.view || 'extensions')
    }
    window.addEventListener('spindle:open-settings', handler)
    return () => window.removeEventListener('spindle:open-settings', handler)
  }, [])

  const activeModal = useStore((s) => s.activeModal)
  const modalProps = useStore((s) => s.modalProps)
  const closeModal = useStore((s) => s.closeModal)

  return (
    <>
      {settingsModalOpen && <SettingsModal onClose={closeSettings} />}

      {activeModal === 'confirm' && (
        <ConfirmationModal
          isOpen={true}
          title={modalProps.title || 'Confirm'}
          message={modalProps.message || 'Are you sure?'}
          variant={modalProps.variant || 'safe'}
          confirmText={modalProps.confirmText}
          onConfirm={() => {
            modalProps.onConfirm?.()
            closeModal()
          }}
          onCancel={() => {
            modalProps.onCancel?.()
            closeModal()
          }}
          secondaryText={modalProps.secondaryText}
          onSecondary={modalProps.onSecondary ? () => {
            modalProps.onSecondary?.()
            closeModal()
          } : undefined}
          secondaryVariant={modalProps.secondaryVariant}
        />
      )}

      {activeModal === 'worldBookEditor' && <WorldBookEditorModal />}

      {activeModal === 'greetingPicker' && modalProps.character && (
        <GreetingPickerModal
          character={modalProps.character}
          onSelect={(greetingIndex) => {
            modalProps.onSelect?.(greetingIndex)
            closeModal()
          }}
          onCancel={closeModal}
        />
      )}

      {activeModal === 'dryRun' && <DryRunModal />}
      {activeModal === 'promptItemizer' && <PromptItemizerModal />}
      {activeModal === 'groupChatCreator' && <GroupChatCreatorModal />}
      {activeModal === 'addGroupMember' && modalProps.chatId && <AddGroupMemberModal />}
      {activeModal === 'manageChats' && <ManageChatsModal />}
      {activeModal === 'chatPicker' && modalProps.characterId && modalProps.characterName && (
        <ChatPickerModal
          characterId={modalProps.characterId}
          characterName={modalProps.characterName}
          onSelect={(chatId) => {
            modalProps.onSelect?.(chatId)
            closeModal()
          }}
          onDismiss={closeModal}
        />
      )}
      {activeModal === 'lumiaEditor' && <LumiaEditorModal />}
      {activeModal === 'loomEditor' && <LoomEditorModal />}
      {activeModal === 'toolEditor' && <ToolEditorModal />}
      {activeModal === 'regexEditor' && <RegexEditorModal />}
      {activeModal === 'regexImport' && <RegexImportModal />}
      {activeModal === 'personaAddons' && <PersonaAddonsModal />}
      {activeModal === 'globalAddonsLibrary' && <GlobalAddonsLibraryModal />}
      {activeModal === 'groupSettings' && <GroupSettingsModal />}
      {activeModal === 'memoryCortexDiagnostics' && (
        <MemoryCortexDiagnosticsModal
          chatId={modalProps.chatId}
          onClose={closeModal}
        />
      )}

      {activeModal === 'regenFeedback' && (
        <RegenFeedbackModal
          defaultValue={useStore.getState().lastRegenFeedback}
          onSubmit={(feedback) => {
            useStore.getState().setLastRegenFeedback(feedback)
            modalProps.onSubmit?.(feedback)
            closeModal()
          }}
          onSkip={() => {
            useStore.getState().setLastRegenFeedback('')
            modalProps.onSkip?.()
            closeModal()
          }}
          onCancel={closeModal}
        />
      )}

      {activeModal === 'customCSS' && <CustomCSSModal />}
      {activeModal === 'dreamWeaverStudio' && modalProps.sessionId && (
        <DreamWeaverStudio sessionId={modalProps.sessionId} />
      )}

      <PermissionRequestModal />
      <CommandPalette />
    </>
  )
}
