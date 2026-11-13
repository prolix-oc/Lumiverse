import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings2 } from 'lucide-react'
import { Button, FormField, Select, TextInput, EditorSection } from '@/components/shared/FormComponents'
import { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import { LabeledRangeSlider } from '@/components/shared/RangeSlider'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import type { MacroGroup } from '@/lib/loom/types'
import type { ImageGenSettings } from '@/types/store'
import styles from '../panels/ImageGenPanel.module.css'
import { ImageGenEditorModal, ImageGenViews } from './ImageGenEditorModal'
import ConnectionSelect from '@/components/shared/ConnectionSelect'
import type { ImageGenPromptEditor } from '../panels/image-gen/useImageGenPromptEditor'
export default function ImageGenPromptStudioModal({ isOpen, onClose, editor, imageGeneration, updateTop, availableMacros, refreshMacros }: {
  isOpen: boolean; onClose: () => void; editor: ImageGenPromptEditor; imageGeneration: ImageGenSettings;
  updateTop: (patch: Partial<ImageGenSettings>) => void; availableMacros: MacroGroup[]; refreshMacros: () => void
}) {
  const { t } = useTranslation('panels')
  const [parserView, setParserView] = useState(false)
  useEffect(() => setParserView(false), [isOpen, editor.editTarget])
  const captioning = editor.editTarget === 'captioning' && !parserView
  const parserSettings = captioning ? editor.captionParser : { parserConnectionId: imageGeneration.promptParserConnectionId, parserModel: imageGeneration.promptParserModel, parserParameters: imageGeneration.promptParserParameters }
  const updateParser = (patch: Partial<typeof parserSettings>) => {
    if (captioning) editor.updateCaptionParser(patch)
    else updateTop({
      ...(Object.hasOwn(patch, 'parserConnectionId') ? { promptParserConnectionId: patch.parserConnectionId } : {}),
      ...(Object.hasOwn(patch, 'parserModel') ? { promptParserModel: patch.parserModel } : {}),
      ...(Object.hasOwn(patch, 'parserParameters') ? { promptParserParameters: patch.parserParameters } : {}),
    })
  }
  const { presetName, setPresetName, editTarget, setEditTarget, draftPrompt, draftNegative, loadedPresetId, loadedPreset, confirmDeletePreset, setConfirmDeletePreset, onDraftPromptChange, onDraftNegativeChange, pickPreset, savePromptPreset, deletePromptPreset, mainPresetOptions, characterPresetOptions, personaPresetOptions, captioningPresetOptions, activeCharacterId, activePersonaId } = editor
  return <ImageGenEditorModal dismissible={!confirmDeletePreset} isOpen={isOpen} onClose={onClose} title="Prompt Studio" navigation={<ImageGenViews<ImageGenPromptEditor['editTarget'] | 'parser'> value={parserView ? 'parser' : editTarget} onChange={(value) => { setParserView(value === 'parser'); if (value !== 'parser') setEditTarget(value) }} label="Prompt authoring target" views={[{value:'main',label:'Main'},{value:'character',label:'Character'},{value:'persona',label:'Persona'},{value:'parser',label:'Parser'},{value:'captioning',label:'Captioning'}]} />}>
                {!parserView && <>
                <FormField
                  label={editTarget === 'main' ? t('imageGenPanel.activeMainPreset') : editTarget === 'character' ? t('imageGenPanel.boundCharacterPreset') : editTarget === 'captioning' ? t('imageGenPanel.boundCaptioningPreset') : t('imageGenPanel.boundPersonaPreset')}
                  hint={
                    editTarget === 'main'
                      ? t('imageGenPanel.pickMainPresetHint')
                      : editTarget === 'character'
                        ? activeCharacterId
                          ? t('imageGenPanel.pickCharacterPresetHint')
                          : t('imageGenPanel.openChatBindPreset')
                        : editTarget === 'captioning'
                          ? t('imageGenPanel.pickCaptioningPresetHint')
                          : activePersonaId
                            ? t('imageGenPanel.pickPersonaPresetHint')
                            : t('imageGenPanel.selectActivePersona')
                  }
                >
                  <Select
                    aria-label="Prompt preset"
                    value={loadedPresetId || ''}
                    onChange={(value) => pickPreset(value || null)}
                    options={
                      editTarget === 'main' ? mainPresetOptions : editTarget === 'character' ? characterPresetOptions : editTarget === 'captioning' ? captioningPresetOptions : personaPresetOptions
                    }
                  />
                </FormField>

                <FormField
                  label={
                    editTarget === 'main'
                      ? (imageGeneration.promptMode === 'parsed_custom' ? t('imageGenPanel.parserInstructions') : t('imageGenPanel.prompt'))
                      : editTarget === 'character' ? t('imageGenPanel.characterSnippet')
                      : editTarget === 'captioning' ? t('imageGenPanel.captioningInstructions')
                      : t('imageGenPanel.personaSnippet')
                  }
                  hint={
                    editTarget === 'main'
                      ? (imageGeneration.promptMode === 'parsed_custom'
                          ? t('imageGenPanel.parserInstructionsHint')
                          : t('imageGenPanel.sentDirectlyHint'))
                      : editTarget === 'character'
                        ? t('imageGenPanel.characterSnippetHint')
                        : editTarget === 'captioning'
                          ? t('imageGenPanel.captioningInstructionsHint')
                          : t('imageGenPanel.personaSnippetHint')
                  }
                >
                  <ExpandableTextarea
                    className={styles.promptTextarea}
                    aria-label="Prompt or parser instructions"
                    value={draftPrompt}
                    onChange={onDraftPromptChange}
                    title={loadedPreset ? t('imageGenPanel.editingPresetTitle', { name: loadedPreset.name }) : t('imageGenPanel.editTargetPromptTitle', { target: editTarget })}
                    placeholder={
                      editTarget === 'main'
                        ? (imageGeneration.promptMode === 'parsed_custom'
                            ? t('imageGenPanel.parserPromptExample')
                            : t('imageGenPanel.describeImage'))
                        : editTarget === 'character'
                          ? '1girl, long red hair, leather jacket'
                          : editTarget === 'captioning'
                            ? 'Describe this image in detail using concise image-generation tags. Include subject, composition, style, lighting, mood, and colors.'
                            : 'middle-aged man, glasses, beige coat'
                    }
                    rows={5}
                    macros={availableMacros}
                    onRefreshMacros={refreshMacros}
                  />
                  {editTarget === 'main' && /\{\{\s*character_prompt\s*\}\}/i.test(draftPrompt) && (
                    <div className={styles.editorTargetBanner}>
                      <code>{'{{character_prompt}}'}</code> {t('imageGenPanel.characterPromptMacroHint')}
                    </div>
                  )}
                  {editTarget === 'main' && /\{\{\s*persona_prompt\s*\}\}/i.test(draftPrompt) && (
                    <div className={styles.editorTargetBanner}>
                      <code>{'{{persona_prompt}}'}</code> {t('imageGenPanel.personaPromptMacroHint')}
                    </div>
                  )}
                </FormField>

                <FormField
                  label={editTarget === 'main' ? 'Preset Negative Prompt' : `${editTarget === 'character' ? t('imageGenPanel.character') : editTarget === 'captioning' ? t('imageGenPanel.captioning') : t('imageGenPanel.persona')} ${t('imageGenPanel.negativeSnippet')}`}
                  hint={
                    editTarget === 'main'
                      ? undefined
                      : t('imageGenPanel.negativeSnippetHint', { target: editTarget })
                  }
                >
                  <ExpandableTextarea
                    className={styles.promptTextarea}
                    aria-label="Preset negative prompt"
                    value={draftNegative}
                    onChange={onDraftNegativeChange}
                    title={loadedPreset ? t('imageGenPanel.editingPresetNegativeTitle', { name: loadedPreset.name }) : t('imageGenPanel.editTargetNegativeTitle', { target: editTarget })}
                    placeholder={t('imageGenPanel.optionalNegativePrompt')}
                    rows={3}
                    macros={availableMacros}
                    onRefreshMacros={refreshMacros}
                  />
                </FormField>

                <FormField label="Preset name"><div className={styles.inlineRow}>
                  <TextInput
                    aria-label="Preset name"
                    value={presetName}
                    onChange={setPresetName}
                    placeholder={loadedPreset ? t('imageGenPanel.renamePreset', { name: loadedPreset.name }) : t('imageGenPanel.newPresetName', { target: editTarget })}
                  />
                  <Button variant="secondary" size="sm" onClick={() => savePromptPreset()}>
                    {loadedPresetId ? t('imageGenPanel.saveChanges') : t('imageGenPanel.saveAsNew')}
                  </Button>
                  {loadedPresetId && <Button variant="secondary" size="sm" onClick={() => savePromptPreset(true)}>{t('imageGenPanel.saveAsNew')}</Button>}
                  {loadedPresetId && <Button variant="danger" size="sm" onClick={() => setConfirmDeletePreset(true)}>{t('imageGenPanel.delete')}</Button>}
                </div></FormField>

                {confirmDeletePreset && (
                  <ConfirmationModal
                    zIndex={10006}
                    isOpen={true}
                    title={t('imageGenPanel.deletePresetConfirmTitle')}
                    message={t('imageGenPanel.deletePresetConfirmMessage', { name: loadedPreset?.name })}
                    variant="danger"
                    confirmText={t('imageGenPanel.delete')}
                    onConfirm={deletePromptPreset}
                    onCancel={() => setConfirmDeletePreset(false)}
                  />
                )}
                {loadedPreset && (
                  <div className={styles.editorTargetBanner}>
                    {t('imageGenPanel.editing')} <strong>{loadedPreset.name}</strong> ({editTarget})
                    {editTarget === 'character' && activeCharacterId && ` · ${t('imageGenPanel.boundToActiveCharacter')}`}
                    {editTarget === 'persona' && activePersonaId && ` · ${t('imageGenPanel.boundToActivePersona')}`}
                  </div>
                )}
                </>}
          {(captioning || parserView) && (
            <EditorSection title={t('imageGenPanel.promptParser')} Icon={Settings2} defaultExpanded>
              <FormField label={t('imageGenPanel.parserConnection')} hint={t(captioning ? 'imageGenPanel.captionParserConnectionHint' : 'imageGenPanel.parserConnectionHint')}>
                <ConnectionSelect
                  kind="llm"
                  value={parserSettings.parserConnectionId || ''}
                  onChange={(value) => updateParser({ parserConnectionId: value || null })}
                  withModel
                  seedDefaultModel={false}
                  modelValue={parserSettings.parserModel || ''}
                  onModelChange={(value) => updateParser({ parserModel: value })}
                  placeholder={t('imageGenPanel.useSidecarOrSelect')}
                  searchPlaceholder={t('imageGenPanel.searchConnections')}
                  emptyMessage={t('imageGenPanel.noLlmConnections')}
                  aria-label={t('imageGenPanel.parserConnection')}
                  modelPlaceholder={t('imageGenPanel.useConnectionDefault')}
                  modelEmptyMessage={t('imageGenPanel.noModelsReturned')}
                  modelNoConnectionMessage={t('imageGenPanel.pickParserConnectionFirst')}
                  modelAppearance="standard"
                  portal
                />
              </FormField>

              <LabeledRangeSlider
                label={t('imageGenPanel.parserTemperature')}
                min={0}
                max={2}
                step={0.05}
                value={parserSettings.parserParameters?.temperature ?? 0.4}
                formatValue={(v) => v.toFixed(2)}
                onCommit={(v) => updateParser({ parserParameters: { ...(parserSettings.parserParameters || {}), temperature: v } })}
              />

              <LabeledRangeSlider
                label={t('imageGenPanel.parserTopP')}
                min={0}
                max={1}
                step={0.05}
                value={parserSettings.parserParameters?.top_p ?? 1}
                formatValue={(v) => v.toFixed(2)}
                onCommit={(v) => updateParser({ parserParameters: { ...(parserSettings.parserParameters || {}), top_p: v } })}
              />

              <FormField label={t('imageGenPanel.parserMaxTokens')}>
                <TextInput
                  value={String(parserSettings.parserParameters?.max_tokens ?? '')}
                  onChange={(value) => updateParser({ parserParameters: { ...(parserSettings.parserParameters || {}), max_tokens: value ? Number(value) : undefined } })}
                  placeholder={t('imageGenPanel.useConnectionDefault')}
                />
              </FormField>
            </EditorSection>
          )}

</ImageGenEditorModal>
}
