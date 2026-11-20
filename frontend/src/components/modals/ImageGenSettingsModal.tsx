import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings2, Workflow, Plus, X } from 'lucide-react'
import { IconBrush } from '@tabler/icons-react'
import { Button, FormField, Select, TextInput, EditorSection } from '@/components/shared/FormComponents'
import { LabeledRangeSlider } from '@/components/shared/RangeSlider'
import type { ImageGenSettings } from '@/types/store'
import type { ImageGenConnectionProfile, ImageGenParameterSchema } from '@/types/api'
import type { ComfyUIWorkflowConfig } from '@/api/image-gen-connections'
import type { ComfyMappedFieldControl } from '@/lib/comfyui-mapped-fields'
import { ParamField, ToggleRow } from '../panels/image-gen/ImageGenFields'
import { ImageGenEditorModal, ImageGenViews } from './ImageGenEditorModal'
import styles from '../panels/ImageGenPanel.module.css'
import { settingsGroupView } from '../panels/image-gen/settingsGroups'
const DEFAULT_PROMPT_TIMEOUT_SECONDS = 60
const DEFAULT_IMAGE_GEN_TIMEOUT_SECONDS = 300
function normalizeTimeoutSeconds(value: string, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.floor(parsed))
}

function normalizeComfyControlValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value == null) return ''
  return String(value)
}

type Param = [string, ImageGenParameterSchema]
export interface ImageGenSettingsController {
  activeConnection: ImageGenConnectionProfile | null
  paramGroups: { main: Param[]; advanced: Param[]; references: Param[]; extra: Array<{ name: string; params: Param[] }> }
  genParams: Record<string, any>
  updateParam: (key: string, value: any) => void
  providerName: string; isComfyUI: boolean; isNovelAIV5: boolean; supportsRefs: boolean; supportsImg2ImgSource: boolean
  workflowConfig: ComfyUIWorkflowConfig | null; workflowError: string | null; workflowLoading: boolean
  comfyCustomControls: ComfyMappedFieldControl[]
  readComfyCustomControlValue: (control: ComfyMappedFieldControl) => string
  updateComfyCustomControl: (control: ComfyMappedFieldControl, value: string) => void
  openWorkflow: () => void
  currentRefs: Array<{data: string; mimeType?: string}>
  setCurrentRefs: (refs: Array<{data: string; mimeType?: string}>) => void
  onPickRefs: () => void
}
type View = 'generation' | 'sources' | 'automation' | 'advanced'
export default function ImageGenSettingsModal({ isOpen, onClose, controller, imageGeneration, updateTop, nestedEditorOpen = false }: {
  isOpen: boolean; onClose: () => void; controller: ImageGenSettingsController; nestedEditorOpen?: boolean;
  imageGeneration: ImageGenSettings; updateTop: (patch: Partial<ImageGenSettings>) => void
}) {
  const { t } = useTranslation('panels')
  const [requestedView, setView] = useState<View>('generation')
  const { activeConnection, paramGroups, genParams, updateParam, providerName, isComfyUI, isNovelAIV5, supportsRefs, supportsImg2ImgSource, workflowConfig, workflowError, workflowLoading, comfyCustomControls, readComfyCustomControlValue, updateComfyCustomControl, openWorkflow, currentRefs, setCurrentRefs, onPickRefs } = controller
  const hasSources = supportsRefs || isNovelAIV5 || paramGroups.references.length > 0 || paramGroups.extra.some(group => settingsGroupView(group.name) === 'sources')
  const view = requestedView === 'sources' && !hasSources ? 'generation' : requestedView
  const views: Array<{value: View; label: string}> = [{value:'generation',label:'Generation'}, ...(hasSources ? [{value:'sources' as const,label:'Sources'}] : []), {value:'automation',label:'Automation'},{value:'advanced',label:'Advanced'}]
  const renderParams = (params: Param[]) => params.map(([key, schema]) => <ParamField key={key} paramKey={key} schema={schema} value={genParams[key]} onChange={updateParam} activeConnection={activeConnection} />)
  const extraGroups = (target: View) => paramGroups.extra.filter(group => settingsGroupView(group.name) === target).map(group => /^models?$/i.test(group.name)
    ? <details key={group.name} className={styles.modelOverrides}><summary>Model Overrides</summary>{renderParams(group.params)}</details>
    : <section key={group.name}><h3>{group.name.charAt(0).toUpperCase() + group.name.slice(1)}</h3>{renderParams(group.params)}</section>)
  return <ImageGenEditorModal dismissible={!nestedEditorOpen} isOpen={isOpen} onClose={onClose} title="Generation Settings" navigation={<ImageGenViews<View> value={view} onChange={setView} views={views} label="Generation settings view" />}>
    {view === 'generation' && <>
      {!activeConnection && <p>Select an image generation connection in the drawer to configure provider parameters.</p>}
              {isComfyUI && (
                <EditorSection title={t('imageGenPanel.comfyWorkflow')} Icon={Workflow} defaultExpanded>
                  <div className={styles.workflowCard}>
                    <div className={styles.workflowInfo}>
                      <span className={styles.workflowTitle}>
                        {workflowConfig ? t('imageGenPanel.workflowImported') : t('imageGenPanel.noWorkflowSelected')}
                      </span>
                      <span className={styles.workflowMeta}>
                        {workflowConfig
                          ? t('imageGenPanel.workflowMappedMeta', {
                              count: workflowConfig.field_mappings.length,
                              format: workflowConfig.workflow_format === 'ui_workflow'
                                ? t('imageGenPanel.workflowFormatUi')
                                : t('imageGenPanel.workflowFormatApi'),
                            })
                          : t('imageGenPanel.importWorkflowHint')}
                      </span>
                    </div>
                    <div className={styles.workflowActions}>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Workflow size={14} />}
                        onClick={openWorkflow}
                        disabled={workflowLoading}
                      >
                        {workflowConfig ? t('imageGenPanel.editWorkflow') : t('imageGenPanel.importWorkflow')}
                      </Button>
                    </div>
                  </div>
                  {comfyCustomControls.length > 0 && (
                    <div className={styles.workflowCustomFields}>
                      {comfyCustomControls.map((control) => {
                        const value = readComfyCustomControlValue(control)
                        return (
                            <FormField key={control.key} label={control.label} hint={t('imageGenPanel.exposedFromWorkflow')}>
                            {control.options ? (
                              <Select
                                value={value}
                                onChange={(next) => updateComfyCustomControl(control, next)}
                                options={[
                                  { value: '', label: t('imageGenPanel.workflowDefault') },
                                  ...control.options,
                                ]}
                              />
                            ) : (
                              <TextInput
                                type={control.kind === 'number' ? 'number' : 'text'}
                                value={value}
                                onChange={(next) => updateComfyCustomControl(control, next)}
                                placeholder={normalizeComfyControlValue(control.defaultValue)}
                              />
                            )}
                          </FormField>
                        )
                      })}
                    </div>
                  )}
                  {workflowError && <div className={styles.error}>{workflowError}</div>}
                </EditorSection>
              )}

{renderParams(paramGroups.main)}{extraGroups('generation')}
</>}
{view === 'sources' && <>
              {isNovelAIV5 && (
                <EditorSection title={t('imageGenPanel.directorReferences')} Icon={IconBrush} defaultExpanded>
                  <div className={styles.workflowCard}>
                    <div className={styles.workflowInfo}>
                      <span className={styles.workflowTitle}>{t('imageGenPanel.novelaiV5ReferencesUnavailable')}</span>
                      <span className={styles.workflowMeta}>{t('imageGenPanel.novelaiV5ReferencesUnavailableHint')}</span>
                    </div>
                  </div>
                </EditorSection>
              )}

              {/* Reference / source images — NovelAI & NanoGPT style references,
                  plus img2img init images for SwarmUI / ComfyUI / Gemini. */}
              {supportsRefs && (
                <EditorSection title={t(providerName === 'novelai' ? 'imageGenPanel.directorReferences' : 'imageGenPanel.references')} Icon={IconBrush} defaultExpanded>
                  {supportsImg2ImgSource && (
                    <>
                      <ToggleRow
                        checked={!!genParams.includeCharacterAvatar}
                        onChange={(checked) => updateParam('includeCharacterAvatar', checked)}
                        label={t('imageGenPanel.includeCharacterAvatar')}
                        hint={t('imageGenPanel.includeCharacterAvatarHint')}
                      />
                      <ToggleRow
                        checked={!!genParams.includePersonaAvatar}
                        onChange={(checked) => updateParam('includePersonaAvatar', checked)}
                        label={t('imageGenPanel.includePersonaAvatar')}
                        hint={t('imageGenPanel.includePersonaAvatarHint')}
                      />
                    </>
                  )}
                  {providerName === 'novelai' && (
                    <>
                      <ToggleRow
                        checked={!!genParams.includeCharacterAvatar}
                        onChange={(checked) => updateParam('includeCharacterAvatar', checked)}
                        label={t('imageGenPanel.includeCharacterAvatar')}
                        hint={t('imageGenPanel.includeCharacterAvatarHint')}
                      />
                      <ToggleRow
                        checked={!!genParams.includePersonaAvatar}
                        onChange={(checked) => updateParam('includePersonaAvatar', checked)}
                        label={t('imageGenPanel.includePersonaAvatar')}
                        hint={t('imageGenPanel.includePersonaAvatarHint')}
                      />
                      <LabeledRangeSlider
                        label={t('imageGenPanel.referenceStrength')}
                        min={0}
                        max={1}
                        step={0.05}
                        value={genParams.referenceStrength ?? 0.5}
                        formatValue={(v) => v.toFixed(2)}
                        onCommit={(v) => updateParam('referenceStrength', v)}
                      />
                      <LabeledRangeSlider
                        label={t('imageGenPanel.informationExtracted')}
                        min={0}
                        max={1}
                        step={0.05}
                        value={genParams.referenceInfoExtracted ?? 1}
                        formatValue={(v) => v.toFixed(2)}
                        onCommit={(v) => updateParam('referenceInfoExtracted', v)}
                      />
                      <LabeledRangeSlider
                        label={t('imageGenPanel.referenceFidelity')}
                        min={0}
                        max={1}
                        step={0.05}
                        value={genParams.referenceFidelity ?? 1}
                        formatValue={(v) => v.toFixed(2)}
                        onCommit={(v) => updateParam('referenceFidelity', v)}
                      />

                      {(genParams.includeCharacterAvatar || genParams.includePersonaAvatar) && (
                      <FormField label={t('imageGenPanel.avatarReferenceType')}>
                          <Select
                            value={genParams.avatarReferenceType || 'character'}
                            onChange={(value) => updateParam('avatarReferenceType', value)}
                            options={[
                              { value: 'character', label: t('imageGenPanel.characterOnly') },
                              { value: 'style', label: t('imageGenPanel.styleOnly') },
                              { value: 'character&style', label: t('imageGenPanel.characterAndStyle') },
                            ]}
                          />
                        </FormField>
                      )}

                      <FormField label={t('imageGenPanel.manualReferenceType')}>
                        <Select
                          value={genParams.referenceType || 'character&style'}
                          onChange={(value) => updateParam('referenceType', value)}
                          options={[
                            { value: 'character&style', label: t('imageGenPanel.characterAndStyle') },
                            { value: 'character', label: t('imageGenPanel.characterOnly') },
                            { value: 'style', label: t('imageGenPanel.styleOnly') },
                          ]}
                        />
                      </FormField>
                    </>
                  )}

                  <FormField label={`${t('imageGenPanel.referenceImages')} (${currentRefs.length}/14)`} hint={t('imageGenPanel.referenceImagesHint')}>
                    <div className={styles.refGrid}>
                      {currentRefs.map((img, idx) => (
                        <div key={idx} className={styles.refTile}>
                          <img src={`data:${img.mimeType || 'image/png'};base64,${img.data}`} alt={t('imageGenPanel.referenceImageAlt', { index: idx + 1 })} />
                          <button type="button" className={styles.refRemove} aria-label={t('imageGenPanel.referenceImageAlt', { index: idx + 1 }) + ' — remove'} onClick={() => setCurrentRefs(currentRefs.filter((_, i) => i !== idx))}>
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                    {currentRefs.length < 14 && (
                      <Button variant="secondary" size="sm" icon={<Plus size={14} />} onClick={onPickRefs}>{t('imageGenPanel.addReference')}</Button>
                    )}
                  </FormField>
                </EditorSection>
              )}

              {/* References group parameters from schema (if any future provider declares them) */}
              {paramGroups.references.length > 0 && (
                <EditorSection title={t('imageGenPanel.references')} Icon={IconBrush} defaultExpanded>
                  {paramGroups.references.map(([key, schema]) => (
                    <ParamField key={key} paramKey={key} schema={schema} value={genParams[key]} onChange={updateParam} activeConnection={activeConnection} />
                  ))}
                </EditorSection>
              )}
{extraGroups('sources')}</>}
{view === 'automation' && <>
<EditorSection title={t('imageGenPanel.sceneSettings')} defaultExpanded>
<ToggleRow checked={!!imageGeneration.forceGeneration} onChange={(checked) => updateTop({ forceGeneration: checked })} label={t('imageGenPanel.ignoreSceneChange')} />
            <ToggleRow
              checked={!!imageGeneration.recycleGeneratedImages}
              onChange={(checked) => updateTop({ recycleGeneratedImages: checked })}
              label={t('imageGenPanel.recycleGeneratedImages')}
              hint={t('imageGenPanel.recycleGeneratedImagesHint')}
            />
            <ToggleRow
              checked={imageGeneration.addToGallery !== false}
              onChange={(checked) => updateTop({ addToGallery: checked })}
              label={t('imageGenPanel.addGeneratedToGallery')}
              hint={t('imageGenPanel.addGeneratedToGalleryHint')}
            />
            {imageGeneration.recycleGeneratedImages && (
              <FormField label={t('imageGenPanel.generatedImagesResend')} hint={t('imageGenPanel.generatedImagesResendHint')}>
                <TextInput
                  type="number"
                  min={1}
                  max={20}
                  value={String(imageGeneration.recycledImageLimit ?? 1)}
                  onChange={(value) => {
                    const parsed = Number(value)
                    updateTop({ recycledImageLimit: Math.max(1, Math.min(20, Number.isFinite(parsed) ? Math.floor(parsed) : 1)) })
                  }}
                />
              </FormField>
            )}
            <FormField label={t('imageGenPanel.contextMessageLimit')} hint={t('imageGenPanel.contextMessageLimitHint')}>
              <TextInput
                type="number"
                min={1}
                max={200}
                value={String(imageGeneration.promptContextMessageLimit ?? 3)}
                onChange={(value) => {
                  const parsed = Number(value)
                  updateTop({ promptContextMessageLimit: Math.max(1, Math.min(200, Number.isFinite(parsed) ? Math.floor(parsed) : 3)) })
                }}
              />
            </FormField>
            <LabeledRangeSlider
              label={t('imageGenPanel.sceneChangeSensitivity')}
              min={1}
              max={5}
              step={1}
              integer
              value={imageGeneration.sceneChangeThreshold || 2}
              onCommit={(v) => updateTop({ sceneChangeThreshold: v })}
            />
          </EditorSection>

          {(imageGeneration.outputTarget || 'background') === 'background' && <EditorSection title={t('imageGenPanel.backgroundDisplay')} defaultExpanded>
            <LabeledRangeSlider
              label={t('imageGenPanel.opacity')}
              min={5}
              max={90}
              step={5}
              integer
              value={Math.round((imageGeneration.backgroundOpacity || 0.35) * 100)}
              formatValue={(v) => `${v}%`}
              onCommit={(v) => updateTop({ backgroundOpacity: v / 100 })}
            />
            <LabeledRangeSlider
              label={t('imageGenPanel.fadeDuration')}
              min={200}
              max={2000}
              step={100}
              integer
              value={imageGeneration.fadeTransitionMs || 800}
              formatValue={(v) => `${v}ms`}
              onCommit={(v) => updateTop({ fadeTransitionMs: v })}
            />
          </EditorSection>}

</>}
{view === 'advanced' && <>
{renderParams(paramGroups.advanced)}{extraGroups('advanced')}
          <EditorSection title={t('imageGenPanel.timeouts')} Icon={Settings2} defaultExpanded>
            <FormField label={t('imageGenPanel.promptGenerationTimeout')} hint={t('imageGenPanel.promptGenerationTimeoutHint')}>
              <TextInput
                type="number"
                min={0}
                step={1}
                value={String(imageGeneration.promptGenerationTimeoutSeconds ?? DEFAULT_PROMPT_TIMEOUT_SECONDS)}
                onChange={(value) => updateTop({ promptGenerationTimeoutSeconds: normalizeTimeoutSeconds(value, DEFAULT_PROMPT_TIMEOUT_SECONDS) })}
              />
            </FormField>

            <FormField label={t('imageGenPanel.imageGenerationTimeout')} hint={t('imageGenPanel.imageGenerationTimeoutHint')}>
              <TextInput
                type="number"
                min={0}
                step={1}
                value={String(imageGeneration.generationTimeoutSeconds ?? DEFAULT_IMAGE_GEN_TIMEOUT_SECONDS)}
                onChange={(value) => updateTop({ generationTimeoutSeconds: normalizeTimeoutSeconds(value, DEFAULT_IMAGE_GEN_TIMEOUT_SECONDS) })}
              />
            </FormField>
          </EditorSection>

</>}
</ImageGenEditorModal>
}
