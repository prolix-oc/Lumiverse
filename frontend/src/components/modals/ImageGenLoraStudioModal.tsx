import { useTranslation } from 'react-i18next'
import { Settings2, Plus } from 'lucide-react'
import { Button, FormField, Select, TextInput, EditorSection } from '@/components/shared/FormComponents'
import { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import { LabeledRangeSlider } from '@/components/shared/RangeSlider'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import type { MacroGroup } from '@/lib/loom/types'
import type { ImageGenSettings } from '@/types/store'
import styles from '../panels/ImageGenPanel.module.css'
import { ImageGenEditorModal } from './ImageGenEditorModal'
import { LoraDiscoveryStatus, LoraRowsEditor } from '../panels/imageGenLoraEditor'
import { ToggleRow } from '../panels/image-gen/ImageGenFields'
import type { ImageGenLoraEditor } from '../panels/image-gen/useImageGenLoraEditor'
const LORA_STRENGTH_SCALE_MIN = 0
const LORA_STRENGTH_SCALE_MAX = 2
const LORA_STRENGTH_SCALE_STEP = 0.05
export default function ImageGenLoraStudioModal({ isOpen, onClose, editor, imageGeneration, updateTop, availableMacros, refreshMacros }: {
  isOpen: boolean; onClose: () => void; editor: ImageGenLoraEditor; imageGeneration: ImageGenSettings;
  updateTop: (patch: Partial<ImageGenSettings>) => void; availableMacros: MacroGroup[]; refreshMacros: () => void
}) {
  const { t } = useTranslation('panels')
  const { loraPresetName, setLoraPresetName, draftLoras, setDraftLoras, draftLoraBaseTags, setDraftLoraBaseTags, loadedLoraPresetId, loadedLoraPreset, confirmDeleteLoraPreset, setConfirmDeleteLoraPreset, pickLoraPreset, saveLoraPreset, deleteLoraPreset, addDraftLora, loraPresetOptions, loraFilenameOptions, loraDiscovery, supportsLoraDiscovery } = editor
  return <ImageGenEditorModal dismissible={!confirmDeleteLoraPreset} isOpen={isOpen} onClose={onClose} title="LoRA Studio">
            <FormField label={t('imageGenPanel.activeLoraPreset')} hint={t('imageGenPanel.loraPresetHint')}>
              <Select
                aria-label={t('imageGenPanel.activeLoraPreset')}
                value={imageGeneration.activeLoraPresetId || ''}
                onChange={(value) => pickLoraPreset(value || null)}
                options={loraPresetOptions}
              />
            </FormField>

            <LoraDiscoveryStatus controller={loraDiscovery} />
            <LoraRowsEditor
              rows={draftLoras}
              onChange={setDraftLoras}
              filenameOptions={loraFilenameOptions}
              supportsDiscovery={supportsLoraDiscovery}
              discoveryState={loraDiscovery.state}
            />

            <Button variant="secondary" size="sm" icon={<Plus size={14} />} onClick={addDraftLora}>
              {t('imageGenPanel.addLora')}
            </Button>

            <FormField label={t('imageGenPanel.baseTags')} hint={t('imageGenPanel.baseTagsHint')}>
              <ExpandableTextarea
                className={styles.promptTextarea}
                aria-label={t('imageGenPanel.baseTags')}
                value={draftLoraBaseTags}
                onChange={setDraftLoraBaseTags}
                title={t('imageGenPanel.baseTags')}
                placeholder={t('imageGenPanel.baseTags')}
                rows={3}
                macros={availableMacros}
                onRefreshMacros={refreshMacros}
              />
            </FormField>

            <FormField label="Preset name"><div className={styles.inlineRow}>
              <TextInput
                aria-label="Preset name"
                value={loraPresetName}
                onChange={setLoraPresetName}
                placeholder={loadedLoraPreset ? t('imageGenPanel.renamePreset', { name: loadedLoraPreset.name }) : t('imageGenPanel.newLoraPresetName')}
              />
              <Button variant="secondary" size="sm" onClick={saveLoraPreset}>
                {t('imageGenPanel.saveLoraPreset')}
              </Button>
              {loadedLoraPresetId && (
                <Button variant="danger" size="sm" onClick={() => setConfirmDeleteLoraPreset(true)}>
                  {t('imageGenPanel.deleteLoraPreset')}
                </Button>
              )}
            </div></FormField>

            {confirmDeleteLoraPreset && (
              <ConfirmationModal
                    zIndex={10006}
                isOpen={true}
                title={t('imageGenPanel.deleteLoraPresetConfirmTitle')}
                message={t('imageGenPanel.deleteLoraPresetConfirmMessage', { name: loadedLoraPreset?.name })}
                variant="danger"
                confirmText={t('imageGenPanel.deleteLoraPreset')}
                onConfirm={deleteLoraPreset}
                onCancel={() => setConfirmDeleteLoraPreset(false)}
              />
            )}
            {loadedLoraPreset && (
              <div className={styles.editorTargetBanner}>
                {t('imageGenPanel.editing')} <strong>{loadedLoraPreset.name}</strong>
              </div>
            )}
          <EditorSection title={t('imageGenPanel.loraControls')} Icon={Settings2} defaultExpanded>
            <ToggleRow
              checked={!!imageGeneration.bypassCharacterLora}
              onChange={(checked) => updateTop({ bypassCharacterLora: checked })}
              label={t('imageGenPanel.bypassCharacterLora')}
              hint={t('imageGenPanel.bypassCharacterLoraHint')}
            />
            <ToggleRow
              checked={!!imageGeneration.bypassActiveLoraPreset}
              onChange={(checked) => updateTop({ bypassActiveLoraPreset: checked })}
              label={t('imageGenPanel.bypassActiveLoraPreset')}
              hint={t('imageGenPanel.bypassActiveLoraPresetHint')}
            />
            <LabeledRangeSlider
              label={t('imageGenPanel.loraStrengthScale')}
              hint={t('imageGenPanel.loraStrengthScaleHint')}
              min={LORA_STRENGTH_SCALE_MIN}
              max={LORA_STRENGTH_SCALE_MAX}
              step={LORA_STRENGTH_SCALE_STEP}
              value={imageGeneration.loraStrengthScale ?? 1}
              formatValue={(value) => value.toFixed(2).replace(/\.?0+$/, '')}
              onCommit={(value) => updateTop({ loraStrengthScale: value })}
            />
          </EditorSection>

</ImageGenEditorModal>
}
