import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Edit3, FileUp, RotateCcw, Save, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import type {
  ComfyUIFieldMapping,
  ComfyUIMappedFieldSemantic,
  ComfyUIWorkflowConfig,
  ComfyUIWorkflowList,
} from '@/api/image-gen-connections'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import styles from './ComfyWorkflowEditor.module.css'

interface ComfyWorkflowEditorProps {
  connectionId: string
  config: ComfyUIWorkflowConfig | null
  error: string | null
  onImportWorkflow: (workflow: unknown) => Promise<ComfyUIWorkflowConfig | null>
  onUpdateMappings: (mappings: ComfyUIFieldMapping[]) => Promise<ComfyUIWorkflowConfig | null>
  onWorkflowActivated: (config: ComfyUIWorkflowConfig) => Promise<void> | void
  onConnectionRefresh?: () => Promise<void> | void
  onClose: () => void
}

type StandardSemantic = Exclude<ComfyUIMappedFieldSemantic, 'custom'>
type RoleGroup = 'core' | 'sampling' | 'model'

interface RoleDef {
  semantic: StandardSemantic
  group: RoleGroup
  required?: boolean
}

const ROLE_DEFS: readonly RoleDef[] = [
  { semantic: 'positive_prompt', group: 'core', required: true },
  { semantic: 'negative_prompt', group: 'core' },
  { semantic: 'seed', group: 'core' },
  { semantic: 'width', group: 'core' },
  { semantic: 'height', group: 'core' },
  { semantic: 'steps', group: 'sampling' },
  { semantic: 'cfg', group: 'sampling' },
  { semantic: 'sampler_name', group: 'sampling' },
  { semantic: 'scheduler', group: 'sampling' },
  { semantic: 'checkpoint', group: 'model' },
  { semantic: 'unet', group: 'model' },
]

const GROUP_ORDER: readonly RoleGroup[] = ['core', 'sampling', 'model']

interface FieldTarget {
  nodeId: string
  classType: string
  title: string
  fieldName: string
}

function enumerateTargets(api: Record<string, any> | null | undefined): FieldTarget[] {
  const out: FieldTarget[] = []
  for (const [nodeId, node] of Object.entries(api ?? {})) {
    if (!node || typeof node.inputs !== 'object') continue
    const classType = String(node.class_type ?? '')
    const title = String(node._meta?.title ?? '').trim()
    for (const [fieldName, value] of Object.entries(node.inputs as Record<string, unknown>)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') continue
      out.push({ nodeId, classType, title, fieldName })
    }
  }
  return out
}

function targetLabel(target: FieldTarget): string {
  const node = target.title || (target.classType ? `${target.classType} #${target.nodeId}` : `#${target.nodeId}`)
  return `${node} · ${target.fieldName}`
}

export function ComfyWorkflowEditor({
  connectionId,
  config,
  error,
  onImportWorkflow,
  onUpdateMappings,
  onWorkflowActivated,
  onConnectionRefresh,
  onClose,
}: ComfyWorkflowEditorProps) {
  const { t } = useTranslation('panels')
  const { t: tc } = useTranslation('common')
  const [replacing, setReplacing] = useState(false)
  const [pasted, setPasted] = useState('')
  const [importing, setImporting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const [library, setLibrary] = useState<ComfyUIWorkflowList | null>(null)
  const [saveName, setSaveName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [libraryBusy, setLibraryBusy] = useState(false)
  const [pendingAction, setPendingAction] = useState<{ type: 'load' | 'delete'; id: string } | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !pendingAction) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, pendingAction])

  useEffect(() => {
    let cancelled = false
    imageGenConnectionsApi.listComfyUIWorkflows(connectionId)
      .then((list) => { if (!cancelled) setLibrary(list) })
      .catch(() => { if (!cancelled) setLibrary(null) })
    return () => { cancelled = true }
  }, [connectionId])

  const targets = useMemo(() => enumerateTargets(config?.workflow_api_json), [config])
  const mappings = config?.field_mappings ?? []
  const hasPositive = mappings.some((m) => m.mappedAs === 'positive_prompt')
  const customMappings = mappings.filter((m) => m.mappedAs === 'custom')
  const customKeys = useMemo(
    () => new Set(customMappings.map((m) => `${m.nodeId} ${m.fieldName}`)),
    [customMappings],
  )
  const nodeCount = config?.workflow_api_json ? Object.keys(config.workflow_api_json).length : 0

  const showImport = !config || replacing
  const savedWorkflows = useMemo(() => library?.workflows ?? [], [library?.workflows])
  const activeEntry = savedWorkflows.find((w) => w.id === library?.active_id) ?? null
  const currentUnsaved = Boolean(config) && library !== null && !activeEntry
  const pendingEntry = pendingAction ? savedWorkflows.find((w) => w.id === pendingAction.id) ?? null : null

  const refreshConnection = useCallback(async () => {
    try {
      await onConnectionRefresh?.()
    } catch {
    }
  }, [onConnectionRefresh])

  const persist = useCallback(
    async (next: ComfyUIFieldMapping[]) => {
      try {
        setBusy(true)
        setLocalError(null)
        await onUpdateMappings(next)
      } catch (err: any) {
        setLocalError(err?.message ?? t('comfyWorkflowEditor.mapFailed'))
      } finally {
        setBusy(false)
      }
    },
    [onUpdateMappings, t],
  )

  function setRole(semantic: StandardSemantic, target: FieldTarget | null) {
    const base = mappings.filter((m) => m.mappedAs !== semantic)
    if (!target) {
      void persist(base)
      return
    }
    void persist([...base, { nodeId: target.nodeId, fieldName: target.fieldName, mappedAs: semantic }])
  }

  function addCustom(target: FieldTarget) {
    if (customKeys.has(`${target.nodeId} ${target.fieldName}`)) return
    void persist([...mappings, { nodeId: target.nodeId, fieldName: target.fieldName, mappedAs: 'custom' }])
  }

  function removeCustom(mapping: ComfyUIFieldMapping) {
    void persist(
      mappings.filter(
        (m) => !(m.mappedAs === 'custom' && m.nodeId === mapping.nodeId && m.fieldName === mapping.fieldName),
      ),
    )
  }

  function currentTarget(semantic: StandardSemantic): FieldTarget | null {
    const m = mappings.find((x) => x.mappedAs === semantic)
    if (!m) return null
    return targets.find((x) => x.nodeId === m.nodeId && x.fieldName === m.fieldName) ?? null
  }

  async function runImport(raw: string) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      setLocalError(t('comfyWorkflowEditor.invalidJson'))
      return
    }
    try {
      setImporting(true)
      setLocalError(null)
      await onImportWorkflow(parsed)
      setPasted('')
      setReplacing(false)
      try {
        setLibrary(await imageGenConnectionsApi.listComfyUIWorkflows(connectionId))
      } catch {
      }
    } catch (err: any) {
      setLocalError(err?.message ?? t('comfyWorkflowEditor.importFailed'))
    } finally {
      setImporting(false)
    }
  }

  async function onFile(file: File) {
    try {
      await runImport(await file.text())
    } catch {
      setLocalError(t('comfyWorkflowEditor.importFailed'))
    }
  }

  const saveCurrent = useCallback(async () => {
    const name = saveName.trim()
    if (!name || libraryBusy) return
    try {
      setLibraryBusy(true)
      setLocalError(null)
      setLibrary(await imageGenConnectionsApi.saveComfyUIWorkflow(connectionId, name))
      setSaveName('')
      await refreshConnection()
    } catch (err: any) {
      setLocalError(err?.message ?? t('comfyWorkflowEditor.libraryFailed'))
    } finally {
      setLibraryBusy(false)
    }
  }, [connectionId, saveName, libraryBusy, refreshConnection, t])

  const commitRename = useCallback(async () => {
    const id = renamingId
    const name = renameValue.trim()
    setRenamingId(null)
    if (!id || !name) return
    if (savedWorkflows.find((w) => w.id === id)?.name === name) return
    try {
      setLibraryBusy(true)
      setLocalError(null)
      setLibrary(await imageGenConnectionsApi.renameComfyUIWorkflow(connectionId, id, name))
      await refreshConnection()
    } catch (err: any) {
      setLocalError(err?.message ?? t('comfyWorkflowEditor.libraryFailed'))
    } finally {
      setLibraryBusy(false)
    }
  }, [connectionId, renamingId, renameValue, savedWorkflows, refreshConnection, t])

  const loadWorkflow = useCallback(async (workflowId: string) => {
    try {
      setLibraryBusy(true)
      setLocalError(null)
      const response = await imageGenConnectionsApi.activateComfyUIWorkflow(connectionId, workflowId)
      setLibrary({ workflows: response.workflows, active_id: response.active_id })
      setReplacing(false)
      await onWorkflowActivated(response.config)
      await refreshConnection()
    } catch (err: any) {
      setLocalError(err?.message ?? t('comfyWorkflowEditor.libraryFailed'))
    } finally {
      setLibraryBusy(false)
    }
  }, [connectionId, onWorkflowActivated, refreshConnection, t])

  const deleteWorkflow = useCallback(async (workflowId: string) => {
    try {
      setLibraryBusy(true)
      setLocalError(null)
      setLibrary(await imageGenConnectionsApi.deleteComfyUIWorkflow(connectionId, workflowId))
      await refreshConnection()
    } catch (err: any) {
      setLocalError(err?.message ?? t('comfyWorkflowEditor.libraryFailed'))
    } finally {
      setLibraryBusy(false)
    }
  }, [connectionId, refreshConnection, t])

  function requestLoad(workflowId: string) {
    if (workflowId === library?.active_id) return
    if (currentUnsaved) {
      setPendingAction({ type: 'load', id: workflowId })
      return
    }
    void loadWorkflow(workflowId)
  }

  function selectValue(target: FieldTarget | null): string {
    if (!target) return ''
    return `${target.nodeId} ${target.fieldName}`
  }

  function targetFromValue(value: string): FieldTarget | null {
    if (!value) return null
    const [nodeId, fieldName] = value.split(' ')
    return targets.find((t) => t.nodeId === nodeId && t.fieldName === fieldName) ?? null
  }

  const librarySection = (savedWorkflows.length > 0 || config) && (
    <section className={styles.group}>
      <p className={styles.groupLabel}>{t('comfyWorkflowEditor.savedWorkflows')}</p>
      <p className={styles.groupHint}>{t('comfyWorkflowEditor.savedHint')}</p>
      {savedWorkflows.map((workflow) => {
        const isActiveEntry = workflow.id === library?.active_id
        return (
          <div key={workflow.id} className={styles.wfRow}>
            {renamingId === workflow.id ? (
              <input
                className={styles.textInput}
                value={renameValue}
                autoFocus
                disabled={libraryBusy}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename()
                  if (e.key === 'Escape') { e.stopPropagation(); setRenamingId(null) }
                }}
              />
            ) : (
              <>
                <span className={styles.wfName} title={workflow.name}>{workflow.name}</span>
                <span className={styles.wfMeta}>{t('comfyWorkflowEditor.nodeCount', { count: workflow.node_count })}</span>
              </>
            )}
            <div className={styles.wfActions}>
              {isActiveEntry ? (
                <span className={styles.wfBadge}>{t('comfyWorkflowEditor.active')}</span>
              ) : (
                <button
                  type="button"
                  className={styles.ghostBtn}
                  disabled={libraryBusy}
                  onClick={() => requestLoad(workflow.id)}
                >
                  {t('comfyWorkflowEditor.load')}
                </button>
              )}
              <button
                type="button"
                className={styles.removeBtn}
                disabled={libraryBusy}
                title={t('comfyWorkflowEditor.rename')}
                onClick={() => { setRenamingId(workflow.id); setRenameValue(workflow.name) }}
              >
                <Edit3 size={13} />
              </button>
              <button
                type="button"
                className={styles.removeBtn}
                disabled={libraryBusy}
                title={t('comfyWorkflowEditor.deleteSaved')}
                onClick={() => setPendingAction({ type: 'delete', id: workflow.id })}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        )
      })}
      {config && (
        <div className={styles.saveRow}>
          <input
            className={styles.textInput}
            value={saveName}
            disabled={libraryBusy}
            placeholder={t('comfyWorkflowEditor.saveNamePlaceholder')}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void saveCurrent() }}
          />
          <button
            type="button"
            className={styles.ghostBtn}
            disabled={libraryBusy || !saveName.trim()}
            onClick={() => void saveCurrent()}
          >
            <Save size={13} />
            {t('comfyWorkflowEditor.saveCurrent')}
          </button>
        </div>
      )}
      {currentUnsaved && savedWorkflows.length > 0 && (
        <p className={styles.groupHint}>{t('comfyWorkflowEditor.unsavedNotice')}</p>
      )}
    </section>
  )

  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>{t('comfyWorkflowEditor.eyebrow')}</p>
            <h3 className={styles.title}>{t('comfyWorkflowEditor.title')}</h3>
          </div>
          <div className={styles.headerActions}>
            {config && !replacing && (
              <button type="button" className={styles.ghostBtn} onClick={() => { setReplacing(true); setLocalError(null); setPasted('') }}>
                <RotateCcw size={13} />
                {t('comfyWorkflowEditor.replace')}
              </button>
            )}
            {config && replacing && (
              <button type="button" className={styles.ghostBtn} onClick={() => { setReplacing(false); setLocalError(null) }}>
                {tc('actions.cancel')}
              </button>
            )}
            {config && !replacing && (
              <button type="button" className={styles.primaryBtn} onClick={onClose}>
                <Check size={14} />
                {tc('actions.done')}
              </button>
            )}
            <button type="button" className={styles.closeBtn} onClick={onClose} aria-label={tc('actions.close')}>
              <X size={18} />
            </button>
          </div>
        </header>

        {showImport ? (
          <div className={styles.body}>
            {savedWorkflows.length > 0 && !replacing && librarySection}
            <p className={styles.lead}>{t('comfyWorkflowEditor.importLead')}</p>
            {replacing && activeEntry && (
              <div className={styles.notice}>
                {t('comfyWorkflowEditor.replaceUpdatesActive', { name: activeEntry.name })}
              </div>
            )}
            <ol className={styles.steps}>
              <li>{t('comfyWorkflowEditor.importStep1')}</li>
              <li>{t('comfyWorkflowEditor.importStep2')}</li>
              <li>{t('comfyWorkflowEditor.importStep3')}</li>
            </ol>
            <div className={styles.importRow}>
              <button
                type="button"
                className={styles.primaryBtn}
                disabled={importing}
                onClick={() => fileRef.current?.click()}
              >
                <FileUp size={14} />
                {importing ? t('comfyWorkflowEditor.importing') : t('comfyWorkflowEditor.chooseFile')}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json"
                className={styles.fileInput}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void onFile(file)
                  e.currentTarget.value = ''
                }}
              />
              <span className={styles.importOr}>{t('comfyWorkflowEditor.or')}</span>
            </div>
            <textarea
              className={styles.paste}
              rows={8}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder={t('comfyWorkflowEditor.pastePlaceholder')}
            />
            <div className={styles.importActions}>
              <button
                type="button"
                className={styles.ghostBtn}
                disabled={importing || !pasted.trim()}
                onClick={() => void runImport(pasted)}
              >
                {t('comfyWorkflowEditor.importPasted')}
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.body}>
            <div className={hasPositive ? styles.statusReady : styles.statusBlocked}>
              <span className={styles.statusDot} />
              <span>
                {hasPositive
                  ? t('comfyWorkflowEditor.ready')
                  : t('comfyWorkflowEditor.needsPositive')}
              </span>
              <span className={styles.statusMeta}>
                {activeEntry
                  ? `${activeEntry.name} · ${t('comfyWorkflowEditor.nodeCount', { count: nodeCount })}`
                  : t('comfyWorkflowEditor.nodeCount', { count: nodeCount })}
              </span>
            </div>

            {config?.needs_reimport && (
              <div className={styles.notice}>{t('comfyWorkflowEditor.needsReimport')}</div>
            )}

            {config?.unknown_nodes && config.unknown_nodes.length > 0 && (
              <div className={styles.warning}>
                {t('comfyWorkflowEditor.unknownNodes', {
                  count: config.unknown_nodes.length,
                  nodes: config.unknown_nodes.join(', '),
                })}
              </div>
            )}

            {librarySection}

            {GROUP_ORDER.map((group) => {
              const roles = ROLE_DEFS.filter((r) => r.group === group)
              if (roles.length === 0) return null
              return (
                <section key={group} className={styles.group}>
                  <p className={styles.groupLabel}>{t(`comfyWorkflowEditor.group.${group}`)}</p>
                  {roles.map((role) => (
                    <label key={role.semantic} className={styles.row}>
                      <span className={styles.rowLabel}>
                        {t(`comfyWorkflowEditor.role.${role.semantic}`)}
                        {role.required && <span className={styles.req}>*</span>}
                      </span>
                      <select
                        className={styles.select}
                        disabled={busy}
                        value={selectValue(currentTarget(role.semantic))}
                        onChange={(e) => setRole(role.semantic, targetFromValue(e.target.value))}
                      >
                        <option value="">{t('comfyWorkflowEditor.notMapped')}</option>
                        {targets.map((target) => (
                          <option key={selectValue(target)} value={selectValue(target)}>
                            {targetLabel(target)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </section>
              )
            })}

            <section className={styles.group}>
              <p className={styles.groupLabel}>{t('comfyWorkflowEditor.group.custom')}</p>
              <p className={styles.groupHint}>{t('comfyWorkflowEditor.customHint')}</p>
              {customMappings.map((m) => {
                const target = targets.find((x) => x.nodeId === m.nodeId && x.fieldName === m.fieldName)
                return (
                  <div key={`${m.nodeId} ${m.fieldName}`} className={styles.customRow}>
                    <span className={styles.customLabel}>
                      {target ? targetLabel(target) : `#${m.nodeId} · ${m.fieldName}`}
                    </span>
                    <button type="button" className={styles.removeBtn} disabled={busy} onClick={() => removeCustom(m)}>
                      <X size={13} />
                    </button>
                  </div>
                )
              })}
              <select
                className={styles.select}
                disabled={busy}
                value=""
                onChange={(e) => {
                  const target = targetFromValue(e.target.value)
                  if (target) addCustom(target)
                }}
              >
                <option value="">{t('comfyWorkflowEditor.addCustom')}</option>
                {targets
                  .filter((target) => !customKeys.has(`${target.nodeId} ${target.fieldName}`))
                  .map((target) => (
                    <option key={selectValue(target)} value={selectValue(target)}>
                      {targetLabel(target)}
                    </option>
                  ))}
              </select>
            </section>
          </div>
        )}

        {(error || localError) && <div className={styles.error}>{error || localError}</div>}

        {pendingAction && pendingEntry && (
          <ConfirmationModal
            isOpen={true}
            zIndex={10006}
            variant={pendingAction.type === 'delete' ? 'danger' : 'safe'}
            title={pendingAction.type === 'delete'
              ? t('comfyWorkflowEditor.confirmDeleteTitle')
              : t('comfyWorkflowEditor.confirmLoadTitle')}
            message={pendingAction.type === 'delete'
              ? t('comfyWorkflowEditor.confirmDeleteMessage', { name: pendingEntry.name })
              : t('comfyWorkflowEditor.confirmLoadUnsaved', { name: pendingEntry.name })}
            confirmText={pendingAction.type === 'delete'
              ? t('comfyWorkflowEditor.deleteSaved')
              : t('comfyWorkflowEditor.load')}
            onConfirm={() => {
              const action = pendingAction
              setPendingAction(null)
              if (action.type === 'delete') void deleteWorkflow(action.id)
              else void loadWorkflow(action.id)
            }}
            onCancel={() => setPendingAction(null)}
          />
        )}
      </div>
    </div>,
    document.body,
  )
}
