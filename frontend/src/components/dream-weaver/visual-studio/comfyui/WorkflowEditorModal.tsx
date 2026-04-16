import { Check, Crosshair, Maximize2, X, ZoomIn, ZoomOut } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ComfyUIFieldMapping,
  ComfyUIMappedFieldSemantic,
  ComfyUIWorkflowConfig,
} from '@/api/dream-weaver'
import type { ComfyUICapabilities } from '@/api/image-gen'
import { ComfyUIWorkflowGraph, type ComfyUIWorkflowGraphHandle } from './ComfyUIWorkflowGraph'
import { NodeContextMenu } from './NodeContextMenu'
import { isComfyWorkflowRunnable } from './mapped-fields'
import { getApiWorkflowFields, getUiWorkflowFields } from './workflow-fields'
import {
  hasComfyWorkflowFormatMismatch,
  resolveComfyApiWorkflow,
  resolveComfyGraphFormat,
} from './workflow-state'
import styles from './WorkflowEditorModal.module.css'

interface WorkflowEditorModalProps {
  config: ComfyUIWorkflowConfig | null
  capabilities: ComfyUICapabilities | null
  currentExecutingNodeId?: string | null
  error: string | null
  onImportWorkflow: (workflow: unknown) => Promise<ComfyUIWorkflowConfig | null>
  onUpdateMappings: (mappings: ComfyUIFieldMapping[]) => Promise<ComfyUIWorkflowConfig | null>
  onClose: () => void
}

interface ContextMenuState {
  nodeId: string
  classType: string
  anchor: { x: number; y: number }
}

function getAvailableFields(
  uiWorkflow: Record<string, any> | null,
  apiWorkflow: Record<string, any> | null,
  workflowFormat: 'ui_workflow' | 'api_prompt',
  nodeId: string,
): Array<{ fieldName: string; currentValue: unknown }> {
  if (workflowFormat === 'ui_workflow') {
    return getUiWorkflowFields(uiWorkflow, nodeId)
  }
  return getApiWorkflowFields(apiWorkflow, nodeId)
}

export function WorkflowEditorModal({
  config,
  currentExecutingNodeId,
  error,
  onImportWorkflow,
  onUpdateMappings,
  onClose,
}: WorkflowEditorModalProps) {
  const [mode, setMode] = useState<'import' | 'map'>(config ? 'map' : 'import')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [pasted, setPasted] = useState('')
  const [importing, setImporting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const graphRef = useRef<ComfyUIWorkflowGraphHandle | null>(null)
  const importModeLockedRef = useRef(false)

  useEffect(() => {
    if (!config) {
      setMode('import')
      return
    }

    if (!importModeLockedRef.current) {
      setMode('map')
    }
  }, [config])

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [onClose])

  const graphWorkflowFormat = resolveComfyGraphFormat(config)
  const apiWorkflow = resolveComfyApiWorkflow(config)
  const hasFormatMismatch = hasComfyWorkflowFormatMismatch(config)
  const mappedNodeIds = useMemo(
    () => Array.from(new Set(config?.field_mappings.map((mapping) => mapping.nodeId) ?? [])),
    [config],
  )
  const mappedCount = config?.field_mappings.length ?? 0
  const canRunWorkflow = isComfyWorkflowRunnable(config)
  const nodeMappings = contextMenu
    ? config?.field_mappings.filter((mapping) => mapping.nodeId === contextMenu.nodeId) ?? []
    : []
  const availableFields = contextMenu
    ? getAvailableFields(
        config?.workflow_json ?? null,
        apiWorkflow,
        graphWorkflowFormat,
        contextMenu.nodeId,
      )
    : []
  const replacingWorkflow = mode === 'import' && Boolean(config)

  async function handleImportPayload(workflow: unknown) {
    try {
      setImporting(true)
      setLocalError(null)
      await onImportWorkflow(workflow)
      importModeLockedRef.current = false
      setPasted('')
      setContextMenu(null)
      setMode('map')
    } catch (importError: any) {
      setLocalError(importError?.message ?? 'Failed to import workflow JSON')
    } finally {
      setImporting(false)
    }
  }

  async function handleFile(file: File) {
    try {
      const text = await file.text()
      await handleImportPayload(JSON.parse(text))
    } catch (importError: any) {
      setLocalError(importError?.message ?? 'Failed to import workflow JSON')
    }
  }

  async function handlePasteImport() {
    try {
      await handleImportPayload(JSON.parse(pasted))
    } catch (importError: any) {
      setLocalError(importError?.message ?? 'Failed to parse workflow JSON')
    }
  }

  async function handleToggleField(fieldName: string, mappedAs: ComfyUIMappedFieldSemantic | null) {
    if (!config || !contextMenu) return

    const nextMappingsBase = config.field_mappings.filter(
      (mapping) => !(mapping.nodeId === contextMenu.nodeId && mapping.fieldName === fieldName),
    )

    const nextMappings =
      mappedAs === null
        ? nextMappingsBase
        : [
            ...nextMappingsBase,
            {
              nodeId: contextMenu.nodeId,
              fieldName,
              mappedAs,
              autoDetected: false,
            },
          ]

    await onUpdateMappings(nextMappings)
  }

  function handleReplaceWorkflow() {
    importModeLockedRef.current = true
    setContextMenu(null)
    setLocalError(null)
    setPasted('')
    setMode('import')
  }

  function handleBackToMap() {
    importModeLockedRef.current = false
    setContextMenu(null)
    setLocalError(null)
    setPasted('')
    setMode('map')
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(event) => event.stopPropagation()}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Workflow Editor</p>
            <h3 className={styles.title}>ComfyUI Workflow</h3>
          </div>
          <div className={styles.headerActions}>
            {replacingWorkflow ? (
              <button type="button" className={styles.secondaryButton} onClick={handleBackToMap}>
                Back to Map
              </button>
            ) : mode === 'map' && config ? (
              <>
                <button type="button" className={styles.secondaryButton} onClick={handleReplaceWorkflow}>
                  Replace Workflow
                </button>
                <button type="button" className={styles.primaryButton} onClick={onClose}>
                  <Check size={15} />
                  Done
                </button>
              </>
            ) : null}
            <button
              type="button"
              className={styles.closeButton}
              onClick={onClose}
              aria-label="Close workflow editor"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        {mode === 'import' || !config ? (
          <div className={styles.importPanel}>
            <div className={styles.importLead}>
              <div>
                <p className={styles.panelEyebrow}>{replacingWorkflow ? 'Replace' : 'Import'}</p>
                <h4 className={styles.panelTitle}>
                  {replacingWorkflow
                    ? 'Swap in a new ComfyUI export.'
                    : 'Bring in the original ComfyUI export.'}
                </h4>
              </div>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
              >
                {importing ? 'Importing...' : 'Choose JSON'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json"
                className={styles.fileInput}
                onClick={(event) => {
                  event.currentTarget.value = ''
                }}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) {
                    void handleFile(file)
                  }
                  event.currentTarget.value = ''
                }}
              />
            </div>

            <p className={styles.panelHint}>
              {replacingWorkflow
                ? 'Importing a new JSON replaces the current workflow and refreshes the mapping choices.'
                : 'Dream Weaver will pick up the usual prompt, sampler, seed, and size fields when it can, and you can expose anything else from the graph after import.'}
            </p>

            <textarea
              className={styles.pasteArea}
              rows={10}
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              placeholder='{ "1": { "class_type": "..." } }'
            />

            <div className={styles.importActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => void handlePasteImport()}
                disabled={importing || !pasted.trim()}
              >
                Import Pasted JSON
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.graphSection}>
            <div className={styles.graphHeader}>
              <div>
                <p className={styles.panelEyebrow}>Map</p>
                <h4 className={styles.panelTitle}>Click a node to map prompts or expose settings.</h4>
              </div>
              <div className={styles.graphMeta}>
                <span className={styles.metaText}>
                  {mappedCount} mapped
                  {canRunWorkflow
                    ? ' · Ready. You can leave now or expose more controls.'
                    : ' · Map positive and negative prompts, then click Done.'}
                </span>
              </div>
            </div>

            {hasFormatMismatch && (
              <div className={styles.notice}>
                This workflow was recovered from legacy metadata. Re-import the original ComfyUI
                export if the graph layout looks wrong.
              </div>
            )}

            <div className={styles.graphWrap}>
              <ComfyUIWorkflowGraph
                ref={graphRef}
                workflow={config.workflow_json}
                workflowFormat={graphWorkflowFormat}
                mappedNodeIds={mappedNodeIds}
                highlightNodeId={currentExecutingNodeId ?? null}
                onNodeClick={(nodeId, classType, anchor) =>
                  setContextMenu({ nodeId, classType, anchor })
                }
              />
              <div className={styles.graphToolDock} role="toolbar" aria-label="Workflow graph controls">
                <button
                  type="button"
                  className={styles.graphToolButton}
                  onClick={() => graphRef.current?.zoomOut()}
                  aria-label="Zoom out"
                  title="Zoom out"
                >
                  <ZoomOut size={16} />
                </button>
                <button
                  type="button"
                  className={styles.graphToolButton}
                  onClick={() => graphRef.current?.zoomIn()}
                  aria-label="Zoom in"
                  title="Zoom in"
                >
                  <ZoomIn size={16} />
                </button>
                <button
                  type="button"
                  className={styles.graphToolButton}
                  onClick={() => graphRef.current?.fitToGraph()}
                  aria-label="Fit graph"
                  title="Fit graph"
                >
                  <Maximize2 size={16} />
                </button>
                <button
                  type="button"
                  className={styles.graphToolButton}
                  onClick={() => graphRef.current?.resetView()}
                  aria-label="Center graph"
                  title="Center graph"
                >
                  <Crosshair size={16} />
                </button>
              </div>
              <div className={styles.graphGuide}>
                <span>Click a node to map it.</span>
                <span>Drag to pan.</span>
                <span>Ctrl/Cmd + wheel to zoom.</span>
              </div>
            </div>

            {contextMenu && (
              <NodeContextMenu
                nodeId={contextMenu.nodeId}
                classType={contextMenu.classType}
                availableFields={availableFields}
                nodeMappings={nodeMappings}
                anchor={contextMenu.anchor}
                onToggleField={(fieldName, mappedAs) => {
                  void handleToggleField(fieldName, mappedAs)
                }}
                onClose={() => setContextMenu(null)}
              />
            )}
          </div>
        )}

        {(error || localError) && <div className={styles.error}>{error || localError}</div>}
      </div>
    </div>
  )
}
