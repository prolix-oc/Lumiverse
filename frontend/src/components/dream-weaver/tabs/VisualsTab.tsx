import type { DreamWeaverDraft } from '@/api/dream-weaver'
import { getVisualAssetHintItems } from '../lib/visual-studio-model'
import type { VisualStudioModel } from '../hooks/useVisualStudio'
import { WorkflowEditorModal } from '../visual-studio/comfyui/WorkflowEditorModal'
import { PortraitStage } from './visuals/PortraitStage'
import { SourceSettingsRibbon } from './visuals/SourceSettingsRibbon'
import { VisualAssetHintRow } from './visuals/VisualAssetHintRow'
import { VisualPromptFields } from './visuals/VisualPromptFields'
import styles from './VisualsTab.module.css'

interface VisualsTabProps {
  draft: DreamWeaverDraft | null
  worldStale: boolean
  visuals: VisualStudioModel
}

export function VisualsTab({ draft, worldStale, visuals }: VisualsTabProps) {
  if (!draft) {
    return (
      <div className={styles.emptyState}>
        <p>Generate a Soul draft first.</p>
      </div>
    )
  }

  return (
    <div className={styles.visualsTab} id="section-package_health">
      <VisualAssetHintRow items={getVisualAssetHintItems()} />

      <div className={styles.stageBand}>
        <PortraitStage
          asset={visuals.selectedAsset}
          acceptedImageUrl={visuals.acceptedImageUrl}
          candidateImageUrl={visuals.candidateImageUrl}
          activeJob={visuals.activeJob}
          onAccept={visuals.onAcceptResult}
          onDismiss={visuals.onDiscardResult}
          onRegenerate={visuals.onRegenerate}
        />
        <SourceSettingsRibbon visuals={visuals} worldStale={worldStale} />
      </div>

      {visuals.selectedConnection ? <VisualPromptFields visuals={visuals} /> : null}

      {visuals.workflowEditorOpen && visuals.selectedConnection?.provider === 'comfyui' && (
        <WorkflowEditorModal
          config={visuals.comfyui.config}
          capabilities={visuals.comfyui.capabilities}
          currentExecutingNodeId={
            visuals.activeJob?.progress && typeof visuals.activeJob.progress.nodeId === 'string'
              ? visuals.activeJob.progress.nodeId
              : null
          }
          error={visuals.comfyui.error}
          onImportWorkflow={visuals.comfyui.importWorkflow}
          onUpdateMappings={visuals.comfyui.updateMappings}
          onClose={visuals.closeWorkflowEditor}
        />
      )}
    </div>
  )
}
