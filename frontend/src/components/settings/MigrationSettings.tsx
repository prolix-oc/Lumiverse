import { useState, useEffect, useCallback, useRef } from 'react'
import { CheckCircle, XCircle, ArrowRight, ArrowLeft, Play, RotateCcw } from 'lucide-react'
import { Spinner } from '@/components/shared/Spinner'
import { Toggle } from '@/components/shared/Toggle'
import { toast } from '@/lib/toast'
import { formatTagLibraryImportToastMessage } from '@/lib/tagLibraryImportToast'
import { useStore } from '@/store'
import { stMigrationApi, type ValidateResult, type ScanResult, type MigrationScope, type FileConnectionConfig } from '@/api/st-migration'
import type { TagLibraryImportResult } from '@/types/api'
import type { MigrationProgressPayload } from '@/types/ws-events'
import type { AuthUser } from '@/types/store'
import DirectoryBrowser from './DirectoryBrowser'
import ConnectionPicker from './ConnectionPicker'
import styles from './MigrationSettings.module.css'

type Step = 'browse' | 'stUser' | 'scan' | 'target' | 'confirm' | 'progress'

export default function MigrationSettings() {
  const user = useStore((s) => s.user)
  const listUsers = useStore((s) => s.listUsers)
  const migrationId = useStore((s) => s.migrationId)
  const migrationPhase = useStore((s) => s.migrationPhase)
  const migrationProgress = useStore((s) => s.migrationProgress)
  const migrationLogs = useStore((s) => s.migrationLogs)
  const migrationResult = useStore((s) => s.migrationResult)
  const migrationError = useStore((s) => s.migrationError)
  const setMigrationStarted = useStore((s) => s.setMigrationStarted)
  const resetMigration = useStore((s) => s.resetMigration)
  const replaceMigrationLogs = useStore((s) => s.replaceMigrationLogs)

  // Wizard state
  const [step, setStep] = useState<Step>(migrationId && !migrationResult && !migrationError ? 'progress' : 'browse')
  const [currentPath, setCurrentPath] = useState('')
  const [connection, setConnection] = useState<FileConnectionConfig>({ type: 'local' })
  const [remoteConnected, setRemoteConnected] = useState(true) // local starts "connected"
  const [validation, setValidation] = useState<ValidateResult | null>(null)
  const [validating, setValidating] = useState(false)
  const [selectedStUser, setSelectedStUser] = useState('')
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scope, setScope] = useState<MigrationScope>({
    characters: true,
    worldBooks: true,
    personas: true,
    chats: true,
    groupChats: true,
  })
  const [targetUserId, setTargetUserId] = useState(user?.id || '')
  const [users, setUsers] = useState<AuthUser[]>([])
  const [executing, setExecuting] = useState(false)
  const [tagLibraryFile, setTagLibraryFile] = useState<File | null>(null)
  const [tagLibraryImporting, setTagLibraryImporting] = useState(false)
  const [tagLibraryResult, setTagLibraryResult] = useState<TagLibraryImportResult | null>(null)
  const [tagLibraryError, setTagLibraryError] = useState<string | null>(null)

  const logPanelRef = useRef<HTMLDivElement>(null)
  const tagLibraryImportKeyRef = useRef<string | null>(null)

  // If a migration is active, jump to progress
  useEffect(() => {
    if (migrationId && !migrationResult && !migrationError) {
      setStep('progress')
    }
  }, [migrationId, migrationResult, migrationError])

  // Recover active or recent migration state on mount and after reconnect-style renders.
  useEffect(() => {
    let cancelled = false

    const syncStatus = async () => {
      try {
        const status = await stMigrationApi.status()
        if (cancelled || status.status === 'idle') return

        if (status.migrationId && useStore.getState().migrationId !== status.migrationId) {
          useStore.getState().setMigrationStarted(status.migrationId)
        }

        if (status.recentLogs?.length) {
          replaceMigrationLogs(status.recentLogs)
        }

        if (status.status === 'running') {
          setStep('progress')
          if (status.progress && status.migrationId) {
            useStore.getState().setMigrationProgress({
              migrationId: status.migrationId,
              phase: status.progress.phase as MigrationProgressPayload['phase'],
              label: status.progress.label,
              current: status.progress.current,
              total: status.progress.total,
            })
          } else if (status.phase && status.migrationId) {
            useStore.getState().setMigrationProgress({
              migrationId: status.migrationId,
              phase: status.phase as MigrationProgressPayload['phase'],
              label: status.phase,
              current: 0,
              total: 0,
            })
          }
          return
        }

        if (status.status === 'completed' && status.results && status.migrationId) {
          useStore.getState().setMigrationCompleted({ migrationId: status.migrationId, durationMs: 0, results: status.results })
          setStep('progress')
          return
        }

        if (status.status === 'failed' && status.error) {
          useStore.getState().setMigrationFailed({ migrationId: status.migrationId ?? '', error: status.error })
          setStep('progress')
        }
      } catch {
        // Ignore status recovery errors
      }
    }

    void syncStatus()
    return () => {
      cancelled = true
    }
  }, [replaceMigrationLogs])

  // Poll /status as fallback in case WS events are missed or delayed
  useEffect(() => {
    if (step !== 'progress' || migrationResult || migrationError) return

    const poll = async () => {
      try {
        const status = await stMigrationApi.status()
        if (status.status === 'completed' && status.results) {
          useStore.getState().setMigrationCompleted({ migrationId: status.migrationId!, durationMs: 0, results: status.results })
        } else if (status.status === 'failed' && status.error) {
          useStore.getState().setMigrationFailed({ migrationId: status.migrationId ?? '', error: status.error })
        } else if (status.status === 'running' && status.migrationId) {
          if (status.recentLogs?.length) {
            replaceMigrationLogs(status.recentLogs)
          }

          if (status.progress) {
            useStore.getState().setMigrationProgress({
              migrationId: status.migrationId,
              phase: status.progress.phase as MigrationProgressPayload['phase'],
              label: status.progress.label,
              current: status.progress.current,
              total: status.progress.total,
            })
          } else if (status.phase) {
            useStore.getState().setMigrationProgress({
              migrationId: status.migrationId,
              phase: status.phase as MigrationProgressPayload['phase'],
              label: status.phase,
              current: 0,
              total: 0,
            })
          }
        }
      } catch {
        // Ignore polling errors
      }
    }

    const interval = setInterval(poll, 3000)
    return () => clearInterval(interval)
  }, [step, migrationResult, migrationError, replaceMigrationLogs])

  // Auto-scroll logs
  useEffect(() => {
    if (logPanelRef.current) {
      logPanelRef.current.scrollTop = logPanelRef.current.scrollHeight
    }
  }, [migrationLogs])

  // Fetch users for admin target selection
  useEffect(() => {
    if (user?.role === 'admin') {
      listUsers().then(setUsers).catch(() => {})
    }
  }, [user?.role, listUsers])

  const handleConnectionChange = useCallback((config: FileConnectionConfig) => {
    setConnection(config)
    setValidation(null)
    setCurrentPath('')
  }, [])

  const handleRemoteConnected = useCallback((connected: boolean) => {
    setRemoteConnected(connected)
    if (!connected) {
      setValidation(null)
      setCurrentPath('')
    }
  }, [])

  const handlePathNavigate = useCallback((path: string) => {
    setCurrentPath(path)
    setValidation(null)
  }, [])

  const handleValidate = async () => {
    if (!currentPath) return
    setValidating(true)
    try {
      const result = await stMigrationApi.validate(currentPath, connection)
      setValidation(result)
      if (result.valid && result.stUsers && result.stUsers.length === 1) {
        setSelectedStUser(result.stUsers[0])
      }
    } catch {
      setValidation({ valid: false, error: 'Failed to validate directory' })
    } finally {
      setValidating(false)
    }
  }

  const getDataDir = (): string => {
    if (!validation?.basePath) return ''
    const sep = connection.type === 'local' ? '/' : '/'
    if (validation.layout === 'legacy') {
      return `${validation.basePath}${sep}public`
    }
    return `${validation.basePath}${sep}data${sep}${selectedStUser}`
  }

  const handleScan = async () => {
    const dataDir = getDataDir()
    if (!dataDir) return
    setScanning(true)
    try {
      const result = await stMigrationApi.scan(dataDir, connection)
      setScanResult(result)
    } catch {
      setScanResult(null)
    } finally {
      setScanning(false)
    }
  }

  const handleScopeChange = (key: keyof MigrationScope, checked: boolean) => {
    const next = { ...scope, [key]: checked }
    // Auto-enable characters if chats or group chats need them
    if ((key === 'chats' || key === 'groupChats') && checked) {
      next.characters = true
    }
    setScope(next)
  }

  const handleExecute = async () => {
    const dataDir = getDataDir()
    if (!dataDir || !targetUserId) return
    setExecuting(true)
    try {
      const result = await stMigrationApi.execute({
        dataDir,
        targetUserId,
        scope,
        connection: connection.type !== 'local' ? connection : undefined,
      })
      setMigrationStarted(result.migrationId)
      setStep('progress')
    } catch (err: any) {
      alert(err?.message || 'Failed to start migration')
    } finally {
      setExecuting(false)
    }
  }

  const handleReset = () => {
    resetMigration()
    setStep('browse')
    setValidation(null)
    setScanResult(null)
    setTagLibraryFile(null)
    setTagLibraryImporting(false)
    setTagLibraryResult(null)
    setTagLibraryError(null)
    tagLibraryImportKeyRef.current = null
  }

  useEffect(() => {
    if (!migrationResult || !migrationId || !tagLibraryFile || !targetUserId) return
    if (tagLibraryImporting || tagLibraryResult || tagLibraryError) return

    const importKey = [migrationId, targetUserId, tagLibraryFile.name, tagLibraryFile.lastModified].join(':')
    if (tagLibraryImportKeyRef.current === importKey) return
    tagLibraryImportKeyRef.current = importKey

    setTagLibraryImporting(true)
    setTagLibraryError(null)
    void stMigrationApi.importTagLibrary(tagLibraryFile, targetUserId)
      .then((result) => {
        setTagLibraryResult(result)
        toast.success(formatTagLibraryImportToastMessage(result), {
          title: 'TagLibrary import complete',
          duration: 7000,
        })
      })
      .catch((err: any) => {
        const message = err?.body?.error || err?.message || 'Failed to import TagLibrary backup'
        setTagLibraryError(message)
        toast.error(message, { title: 'TagLibrary import failed' })
      })
      .finally(() => {
        setTagLibraryImporting(false)
      })
  }, [migrationError, migrationId, migrationResult, tagLibraryError, tagLibraryFile, tagLibraryImporting, tagLibraryResult, targetUserId])

  const canProceedFromBrowse = validation?.valid === true
  const canProceedFromStUser = validation?.layout === 'legacy' || !!selectedStUser
  const needsStUserStep = validation?.layout === 'multi-user' && (validation.stUsers?.length ?? 0) > 1

  const filteredUsers = users.filter((u) => {
    if (u.id === user?.id) return true
    return u.role === 'user'
  })

  const connectionLabel = connection.type === 'local'
    ? 'Local filesystem'
    : connection.type === 'sftp'
      ? `SFTP (${(connection as any).host || '...'})`
      : connection.type === 'smb'
        ? `SMB (\\\\${(connection as any).host || '...'}\\${(connection as any).share || '...'})`
        : connection.type === 'google-drive'
          ? 'Google Drive'
          : 'Dropbox'

  // Step rendering
  const renderStepIndicator = () => {
    const steps: Step[] = needsStUserStep
      ? ['browse', 'stUser', 'scan', 'target', 'confirm']
      : ['browse', 'scan', 'target', 'confirm']
    const currentIndex = steps.indexOf(step === 'progress' ? 'confirm' : step)

    return (
      <div className={styles.stepIndicator}>
        {steps.map((s, i) => (
          <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: i < steps.length - 1 ? 1 : undefined }}>
            <span className={`${styles.stepDot} ${i === currentIndex ? styles.stepDotActive : i < currentIndex ? styles.stepDotDone : ''}`} />
            {i < steps.length - 1 && <span className={styles.stepLine} />}
          </span>
        ))}
      </div>
    )
  }

  const renderBrowseStep = () => (
    <div className={styles.section}>
      <h3 className={styles.title}>Select SillyTavern Directory</h3>
      <p className={styles.subtitle}>
        Choose how to connect to your SillyTavern installation, then navigate to the root directory containing the <code>data/</code> folder.
      </p>

      <ConnectionPicker value={connection} onChange={handleConnectionChange} onConnected={handleRemoteConnected} />

      {remoteConnected && (
        <DirectoryBrowser
          key={connection.type === 'local' ? 'local' : `${connection.type}-connected`}
          onNavigate={handlePathNavigate}
          connection={connection}
        />
      )}

      <div className={styles.actions}>
        <button type="button" className={styles.btn} onClick={handleValidate} disabled={!currentPath || validating}>
          {validating ? <Spinner size={12} /> : null}
          Validate
        </button>
      </div>

      {validating && (
        <div className={styles.validChecking}>
          <Spinner size={14} />
          Checking for SillyTavern data...
        </div>
      )}
      {validation && !validating && validation.valid && (
        <div className={styles.validGood}>
          <CheckCircle size={14} />
          Valid SillyTavern installation found ({validation.layout} layout
          {validation.stUsers && validation.stUsers.length > 0 ? `, ${validation.stUsers.length} user profile(s)` : ''})
        </div>
      )}
      {validation && !validating && !validation.valid && (
        <div className={styles.validBad}>
          <XCircle size={14} />
          {validation.error || 'Not a valid SillyTavern directory'}
        </div>
      )}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.btnPrimary}
          disabled={!canProceedFromBrowse}
          onClick={() => {
            if (needsStUserStep) {
              setStep('stUser')
            } else {
              handleScan()
              setStep('scan')
            }
          }}
        >
          Next <ArrowRight size={12} />
        </button>
      </div>
    </div>
  )

  const renderStUserStep = () => (
    <div className={styles.section}>
      <h3 className={styles.title}>Select ST User Profile</h3>
      <p className={styles.subtitle}>
        Your SillyTavern installation has multiple user profiles. Select which one to migrate.
      </p>
      <div className={styles.selectRow}>
        <label className={styles.selectLabel}>User profile</label>
        <select
          className={styles.select}
          value={selectedStUser}
          onChange={(e) => setSelectedStUser(e.target.value)}
        >
          <option value="">Select...</option>
          {validation?.stUsers?.map((u) => (
            <option key={u} value={u}>{u}</option>
          ))}
        </select>
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.btn} onClick={() => setStep('browse')}>
          <ArrowLeft size={12} /> Back
        </button>
        <button
          type="button"
          className={styles.btnPrimary}
          disabled={!canProceedFromStUser}
          onClick={() => { handleScan(); setStep('scan') }}
        >
          Next <ArrowRight size={12} />
        </button>
      </div>
    </div>
  )

  const renderScanStep = () => (
    <div className={styles.section}>
      <h3 className={styles.title}>Select Data to Migrate</h3>
      {scanning ? (
        <div className={styles.validChecking}>
          <Spinner size={14} />
          Scanning SillyTavern data...
        </div>
      ) : scanResult ? (
        <div className={styles.scanCard}>
          <div className={styles.scanRow}>
            <Toggle.Checkbox checked={scope.characters} onChange={(v) => handleScopeChange('characters', v)} label="Characters" />
            <span className={styles.scanCount}>{scanResult.characters}</span>
          </div>
          <div className={styles.scanRow}>
            <Toggle.Checkbox checked={scope.worldBooks} onChange={(v) => handleScopeChange('worldBooks', v)} label="World Books" />
            <span className={styles.scanCount}>{scanResult.worldBooks}</span>
          </div>
          <div className={styles.scanRow}>
            <Toggle.Checkbox checked={scope.personas} onChange={(v) => handleScopeChange('personas', v)} label="Personas" />
            <span className={styles.scanCount}>{scanResult.personas}</span>
          </div>
          <div className={styles.scanRow}>
            <Toggle.Checkbox checked={scope.chats} onChange={(v) => handleScopeChange('chats', v)} label="Chat History" />
            <span className={styles.scanCount}>{scanResult.totalChatFiles} files across {scanResult.chatDirs} characters</span>
          </div>
          <div className={styles.scanRow}>
            <Toggle.Checkbox checked={scope.groupChats} onChange={(v) => handleScopeChange('groupChats', v)} label="Group Chats" />
            <span className={styles.scanCount}>{scanResult.groupChats} groups ({scanResult.groupChatFiles} files)</span>
          </div>
          {(scope.chats || scope.groupChats) && !scope.characters && (
            <div className={styles.scanWarning}>
              Characters will be auto-imported because chat history depends on them.
            </div>
          )}
          <div className={styles.uploadCard}>
            <div className={styles.uploadHeader}>
              <span className={styles.selectLabel}>Optional: TagLibrary Backup</span>
              <span className={styles.uploadHint}>
                Upload a SillyTavern TagLibrary JSON backup to add tags after migration. Existing character tags are preserved.
              </span>
            </div>
            <input
              type="file"
              accept="application/json,.json"
              className={styles.fileInput}
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null
                setTagLibraryFile(file)
                setTagLibraryImporting(false)
                setTagLibraryResult(null)
                setTagLibraryError(null)
                tagLibraryImportKeyRef.current = null
              }}
            />
            {tagLibraryFile && (
              <div className={styles.uploadMeta}>
                Selected: <strong>{tagLibraryFile.name}</strong>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className={styles.validBad}>
          <XCircle size={14} />
          Failed to scan directory
        </div>
      )}
      <div className={styles.actions}>
        <button type="button" className={styles.btn} onClick={() => setStep(needsStUserStep ? 'stUser' : 'browse')}>
          <ArrowLeft size={12} /> Back
        </button>
        <button
          type="button"
          className={styles.btnPrimary}
          disabled={!scanResult || scanning}
          onClick={() => setStep('target')}
        >
          Next <ArrowRight size={12} />
        </button>
      </div>
    </div>
  )

  const renderTargetStep = () => (
    <div className={styles.section}>
      <h3 className={styles.title}>Migration Target</h3>
      <p className={styles.subtitle}>
        Select which Lumiverse account should receive the imported data.
      </p>

      {user?.role === 'owner' ? (
        <div className={styles.targetInfo}>
          Migrating to your account ({user.name || user.username || user.email})
        </div>
      ) : (
        <div className={styles.selectRow}>
          <label className={styles.selectLabel}>Target user</label>
          <select
            className={styles.select}
            value={targetUserId}
            onChange={(e) => setTargetUserId(e.target.value)}
          >
            {filteredUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name || u.username || u.email}
                {u.id === user?.id ? ' (you)' : ` (${u.role})`}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className={styles.actions}>
        <button type="button" className={styles.btn} onClick={() => setStep('scan')}>
          <ArrowLeft size={12} /> Back
        </button>
        <button type="button" className={styles.btnPrimary} onClick={() => setStep('confirm')}>
          Next <ArrowRight size={12} />
        </button>
      </div>
    </div>
  )

  const renderConfirmStep = () => {
    const selectedScopes = Object.entries(scope)
      .filter(([, v]) => v)
      .map(([k]) => {
        const labels: Record<string, string> = {
          characters: 'Characters',
          worldBooks: 'World Books',
          personas: 'Personas',
          chats: 'Chat History',
          groupChats: 'Group Chats',
        }
        return labels[k] || k
      })

    const targetLabel = user?.role === 'owner'
      ? (user.name || user.username || 'Owner')
      : filteredUsers.find((u) => u.id === targetUserId)?.name || targetUserId

    return (
      <div className={styles.section}>
        <h3 className={styles.title}>Confirm Migration</h3>
        <div className={styles.summaryCard}>
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>Connection</span>
            <span className={styles.summaryValue}>{connectionLabel}</span>
          </div>
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>Source</span>
            <span className={styles.summaryValue}>{getDataDir()}</span>
          </div>
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>Importing</span>
            <span className={styles.summaryValue}>{selectedScopes.join(', ')}</span>
          </div>
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>Target user</span>
            <span className={styles.summaryValue}>{targetLabel}</span>
          </div>
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>TagLibrary backup</span>
            <span className={styles.summaryValue}>{tagLibraryFile ? tagLibraryFile.name : 'Not selected'}</span>
          </div>
        </div>
        <p className={styles.subtitle}>
          Previously imported characters will be skipped automatically. This operation may take a while for large datasets.
        </p>
        <div className={styles.actions}>
          <button type="button" className={styles.btn} onClick={() => setStep('target')}>
            <ArrowLeft size={12} /> Back
          </button>
          <button type="button" className={styles.btnPrimary} onClick={handleExecute} disabled={executing}>
            {executing ? <Spinner size={12} /> : <Play size={12} />}
            Start Migration
          </button>
        </div>
      </div>
    )
  }

  const renderProgressStep = () => {
    const phase = migrationPhase || 'starting'
    const phaseLabels: Record<string, string> = {
      starting: 'Starting...',
      scanning: 'Scanning data...',
      characters: 'Characters',
      worldBooks: 'World Books',
      personas: 'Personas',
      chats: 'Chat History',
      groupChats: 'Group Chats',
      completed: 'Completed',
      failed: 'Failed',
    }

    const progressPct = migrationProgress
      ? Math.round((migrationProgress.current / Math.max(migrationProgress.total, 1)) * 100)
      : 0

    return (
      <div className={styles.progressContainer}>
        <h3 className={styles.title}>Migration in Progress</h3>

        {migrationResult ? (
          <div className={styles.resultSuccess}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
              <CheckCircle size={16} /> Migration Complete
            </div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              Finished in {((migrationResult.durationMs || 0) / 1000).toFixed(1)}s
            </div>
            {migrationResult.results && Object.entries(migrationResult.results).map(([key, val]: [string, any]) => (
              <div key={key} className={styles.resultRow}>
                <span>{key.replace(/_/g, ' ')}</span>
                <span>
                  {val.imported ?? 0} imported
                  {val.skipped ? `, ${val.skipped} skipped` : ''}
                  {val.failed ? `, ${val.failed} failed` : ''}
                </span>
              </div>
            ))}
          </div>
        ) : migrationError ? (
          <div className={styles.resultFailed}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
              <XCircle size={16} /> Migration Failed
            </div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>{migrationError}</div>
          </div>
        ) : (
          <>
            <div className={styles.progressPhase}>{phaseLabels[phase] || phase}</div>
            <div className={styles.progressBarOuter}>
              <div className={styles.progressBarInner} style={{ width: `${progressPct}%` }} />
            </div>
            {migrationProgress && (
              <div className={styles.progressLabel}>
                {migrationProgress.label} ({migrationProgress.current}/{migrationProgress.total})
              </div>
            )}
          </>
        )}

        {migrationLogs.length > 0 && (
          <div className={styles.logPanel} ref={logPanelRef}>
            {migrationLogs.map((log, i) => (
              <div
                key={i}
                className={`${styles.logEntry} ${log.level === 'warn' ? styles.logWarn : ''} ${log.level === 'error' ? styles.logError : ''}`}
              >
                {log.message}
              </div>
            ))}
          </div>
        )}
        {(migrationResult || migrationError) && (
          <div className={styles.actions}>
            <button type="button" className={styles.btn} onClick={handleReset}>
              <RotateCcw size={12} /> Start New Migration
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={styles.container}>
      {step !== 'progress' && renderStepIndicator()}

      {step === 'browse' && renderBrowseStep()}
      {step === 'stUser' && renderStUserStep()}
      {step === 'scan' && renderScanStep()}
      {step === 'target' && renderTargetStep()}
      {step === 'confirm' && renderConfirmStep()}
      {step === 'progress' && renderProgressStep()}
    </div>
  )
}
