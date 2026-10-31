import { useEffect, useState, Suspense, lazy, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import PermissionRequestModal from './PermissionRequestModal'

// Each dialog owns its loading boundary so opening one never hides an
// already mounted settings editor or permission/confirmation dialog.
function deferredModal<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  const Component = lazy(load)
  return function DeferredModal(props: P) {
    return <Suspense fallback={null}><Component {...props} /></Suspense>
  }
}

const SettingsModal = deferredModal(() => import('./SettingsModal'))
const GreetingPickerModal = deferredModal(() => import('./GreetingPickerModal'))
const WorldBookEditorModal = deferredModal(() => import('./WorldBookEditorModal'))
const LumiaEditorModal = deferredModal(() => import('@/components/panels/creator-workshop/LumiaEditorModal'))
const LoomEditorModal = deferredModal(() => import('@/components/panels/creator-workshop/LoomEditorModal'))
const ToolEditorModal = deferredModal(() => import('@/components/panels/creator-workshop/ToolEditorModal'))
const DryRunModal = deferredModal(() => import('./DryRunModal'))
const PromptItemizerModal = deferredModal(() => import('./PromptItemizerModal'))
const GroupChatCreatorModal = deferredModal(() => import('./GroupChatCreatorModal'))
const AddGroupMemberModal = deferredModal(() => import('@/components/chat/AddGroupMemberModal'))
const MemberVoiceModal = deferredModal(() => import('./MemberVoiceModal'))
const ManageChatsModal = deferredModal(() => import('./ManageChatsModal'))
const ChatPickerModal = deferredModal(() => import('./ChatPickerModal'))
const MemoryCortexDiagnosticsModal = deferredModal(() => import('./MemoryCortexDiagnosticsModal'))
const CommandPalette = deferredModal(() => import('./CommandPalette'))
const RegexEditorModal = deferredModal(() => import('./RegexEditorModal'))
const RegexImportModal = deferredModal(() => import('./RegexImportModal'))
const RegenFeedbackModal = deferredModal(() => import('./RegenFeedbackModal'))
const PersonaAddonsModal = deferredModal(() => import('./PersonaAddonsModal'))
const GlobalAddonsLibraryModal = deferredModal(() => import('./GlobalAddonsLibraryModal'))
const ChatSettingsModal = deferredModal(() => import('./GroupSettingsModal'))
const ConfigureDrawerTabsModal = deferredModal(() => import('./ConfigureDrawerTabsModal'))
const ImagePromptPreviewModal = deferredModal(() => import('./ImagePromptPreviewModal'))
const ImageCaptionModal = deferredModal(() => import('./ImageCaptionModal'))
const QwenCustomVoiceModal = deferredModal(() => import('./QwenCustomVoiceModal'))
const HiddenFromHomeModal = deferredModal(() => import('./HiddenFromHomeModal'))
const WeaverStudio = deferredModal(() => import('@/components/weaver/WeaverStudio').then(module => ({ default: module.WeaverStudio })))
const CustomCSSModal = deferredModal(() => import('./CustomCSSModal'))


export default function ModalContainer() {
  const { t } = useTranslation('modals')
  const settingsModalOpen = useStore((s) => s.settingsModalOpen)
  const closeSettings = useStore((s) => s.closeSettings)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      useStore.getState().openSettings(
        detail?.view || 'extensions',
        detail?.extensionId ? { extensionId: detail.extensionId } : undefined,
      )
    }
    window.addEventListener('spindle:open-settings', handler)
    return () => window.removeEventListener('spindle:open-settings', handler)
  }, [])

  const activeModal = useStore((s) => s.activeModal)
  const modalProps = useStore((s) => s.modalProps)
  const closeModal = useStore((s) => s.closeModal)
  const lastRegenFeedback = useStore((s) => s.lastRegenFeedback)
  const setLastRegenFeedback = useStore((s) => s.setLastRegenFeedback)
  const commandPaletteOpen = useStore(s => s.commandPaletteOpen)
  const [paletteUsed, setPaletteUsed] = useState(false)
  useEffect(() => { if (commandPaletteOpen) setPaletteUsed(true) }, [commandPaletteOpen])

  return (
    <>
      {settingsModalOpen && <SettingsModal onClose={closeSettings} />}

      {activeModal === 'confirm' && (
        <ConfirmationModal
          isOpen={true}
          title={modalProps.title || t('confirm.defaultTitle')}
          message={modalProps.message || t('confirm.defaultMessage')}
          variant={modalProps.variant || 'safe'}
          confirmText={modalProps.confirmText}
          inputLabel={modalProps.inputLabel}
          inputPlaceholder={modalProps.inputPlaceholder}
          defaultInputValue={modalProps.defaultInputValue}
          checkboxLabel={modalProps.checkboxLabel}
          defaultCheckboxChecked={modalProps.defaultCheckboxChecked}
          onConfirm={(inputValue, checkboxChecked) => {
            closeModal()
            modalProps.onConfirm?.(inputValue, checkboxChecked)
          }}
          onCancel={() => {
            closeModal()
            modalProps.onCancel?.()
          }}
          secondaryText={modalProps.secondaryText}
          onSecondary={modalProps.onSecondary ? () => {
            closeModal()
            modalProps.onSecondary?.()
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
      {activeModal === 'memberVoice' && modalProps.chatId && modalProps.characterId && <MemberVoiceModal />}
      {activeModal === 'manageChats' && <ManageChatsModal />}
      {activeModal === 'hiddenFromHome' && <HiddenFromHomeModal />}
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
      {activeModal === 'configureTabs' && <ConfigureDrawerTabsModal />}
      {activeModal === 'personaAddons' && <PersonaAddonsModal />}
      {activeModal === 'globalAddonsLibrary' && <GlobalAddonsLibraryModal />}
      {(activeModal === 'chatSettings' || activeModal === 'groupSettings') && <ChatSettingsModal />}
      {activeModal === 'memoryCortexDiagnostics' && (
        <MemoryCortexDiagnosticsModal
          chatId={modalProps.chatId}
          onClose={closeModal}
        />
      )}

      {activeModal === 'regenFeedback' && modalProps.chatId && (
        <RegenFeedbackModal
          defaultValue={lastRegenFeedback[modalProps.chatId as string] ?? ''}
          onSaveDraft={(feedback) => setLastRegenFeedback(modalProps.chatId as string, feedback)}
          onSubmit={(feedback) => {
            modalProps.onSubmit?.(feedback)
            closeModal()
          }}
          onSkip={() => {
            modalProps.onSkip?.()
            closeModal()
          }}
          onCancel={closeModal}
        />
      )}

      {activeModal === 'customCSS' && (
        <Suspense fallback={null}>
          <CustomCSSModal />
        </Suspense>
      )}
      {activeModal === 'imagePromptPreview' && <ImagePromptPreviewModal />}
      {activeModal === 'imageCaptioner' && <ImageCaptionModal />}
      {activeModal === 'qwenCustomVoice' && modalProps.connectionId && <QwenCustomVoiceModal />}
      {activeModal === 'weaver' && <WeaverStudio />}

      <PermissionRequestModal />
      {(commandPaletteOpen || paletteUsed) && <CommandPalette />}
    </>
  )
}
