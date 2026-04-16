import { getVisualStudioLabel } from '../../lib/visual-studio-model'
import type { VisualStudioModel } from '../../hooks/useVisualStudio'
import { ProviderParamRenderer } from '../../components/ProviderParamRenderer'
import {
  buildMappedFieldControls,
  isComfyWorkflowRunnable,
  readComfyControlValue,
  writeComfyControlPatch,
} from '../../visual-studio/comfyui/mapped-fields'
import styles from './SourceSettingsRibbon.module.css'

interface SourceSettingsRibbonProps {
  visuals: VisualStudioModel
  worldStale: boolean
}

function getWorkspaceMessage(visuals: VisualStudioModel): string {
  if (visuals.connections.length === 0) {
    return 'No image sources are available yet.'
  }

  if (!visuals.selectedConnection) {
    return 'Choose a source to unlock generation controls.'
  }

  switch (visuals.workspaceState) {
    case 'needs_workflow':
      return 'Import a ComfyUI workflow.'
    case 'needs_mapping':
      return 'Map the positive and negative prompts.'
    case 'failed':
      return 'The last generation failed.'
    default:
      return visuals.selectedConnection
        ? `${getVisualStudioLabel(visuals.selectedConnection.provider as any)} is ready.`
        : ''
  }
}

export function SourceSettingsRibbon({ visuals, worldStale }: SourceSettingsRibbonProps) {
  if (!visuals.selectedAsset) return null
  const asset = visuals.selectedAsset

  const isComfyUI = visuals.selectedConnection?.provider === 'comfyui'
  const mappedControls = isComfyUI && visuals.comfyui.config
    ? buildMappedFieldControls(visuals.comfyui.config, visuals.comfyui.capabilities).filter(
        (control) => control.key !== 'positive_prompt' && control.key !== 'negative_prompt',
      )
    : []
  const mappedCount = visuals.comfyui.config?.field_mappings.length ?? 0
  const canRunWorkflow = isComfyUI ? isComfyWorkflowRunnable(visuals.comfyui.config) : visuals.canGenerate
  const showSourceSelect =
    visuals.connections.length > 1 || !visuals.selectedConnection

  return (
    <aside className={styles.ribbon}>
      <div className={styles.section}>
        <div className={styles.sectionLabel}>Source</div>
        {visuals.connections.length === 0 ? (
          <div className={styles.sourceValue}>No sources configured</div>
        ) : showSourceSelect ? (
          <select
            className={styles.select}
            value={visuals.selectedConnectionId ?? ''}
            onChange={(event) => visuals.onSelectConnection(event.target.value || null)}
          >
            <option value="">Choose source</option>
            {visuals.connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}
              </option>
            ))}
          </select>
        ) : (
          <div className={styles.sourceValue}>{visuals.selectedConnection?.name}</div>
        )}
        {getWorkspaceMessage(visuals) ? <p className={styles.meta}>{getWorkspaceMessage(visuals)}</p> : null}
        {worldStale && <p className={styles.warning}>World content is stale.</p>}
      </div>

      {isComfyUI ? (
        <>
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionLabel}>Workflow</span>
              <span className={styles.metaInline}>{mappedCount} mapped</span>
            </div>
            <button
              type="button"
              className={styles.workflowButton}
              onClick={visuals.openWorkflowEditor}
            >
              {visuals.comfyui.config ? 'Edit Workflow' : 'Import Workflow'}
            </button>
            <p className={styles.meta}>
              {canRunWorkflow
                ? 'Prompt mappings are ready.'
                : 'Map positive and negative prompts first.'}
            </p>
          </div>

          {mappedControls.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>Settings</div>
              <div className={styles.controlGrid}>
                {mappedControls.map((control) => (
                  <label
                    key={control.key}
                    className={control.kind === 'textarea' ? styles.controlWide : styles.control}
                  >
                    <span className={styles.controlLabel}>{control.label}</span>
                    {control.kind === 'select' ? (
                      <select
                        className={styles.select}
                        value={String(readComfyControlValue(asset, control))}
                        onChange={(event) =>
                          visuals.onUpdateAsset(
                            asset.id,
                            writeComfyControlPatch(asset, control, event.target.value),
                          )
                        }
                      >
                        <option value="">Auto</option>
                        {(control.options ?? []).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={control.kind === 'number' ? 'number' : 'text'}
                        className={styles.input}
                        value={String(readComfyControlValue(asset, control))}
                        onChange={(event) =>
                          visuals.onUpdateAsset(
                            asset.id,
                            writeComfyControlPatch(asset, control, event.target.value),
                          )
                        }
                      />
                    )}
                  </label>
                ))}
              </div>
            </div>
          )}
        </>
      ) : visuals.selectedConnection ? (
        <div className={styles.section}>
          <div className={styles.sectionLabel}>Provider Settings</div>
          {visuals.providerSchema ? (
            <ProviderParamRenderer
              schema={visuals.providerSchema}
              values={visuals.providerValues}
              onChange={visuals.updateProviderParam}
              connectionId={visuals.selectedConnectionId}
            />
          ) : (
            <p className={styles.meta}>This source does not expose extra controls yet.</p>
          )}
        </div>
      ) : null}
    </aside>
  )
}
