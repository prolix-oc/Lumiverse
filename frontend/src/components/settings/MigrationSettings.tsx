import { useState, useEffect, useCallback, useRef } from 'react'
import { CheckCircle, XCircle, ArrowRight, ArrowLeft, Play, RotateCcw } from 'lucide-react'
import { Spinner } from '@/components/shared/Spinner'
import { Toggle } from '@/components/shared/Toggle'
import { useStore } from '@/store'
import { stMigrationApi, type ValidateResult, type ScanResult, type MigrationScope } from '@/api/st-migration'
import type { MigrationProgressPayload } from '@/types/ws-events'
import type { AuthUser } from '@/types/store'
import DirectoryBrowser from './DirectoryBrowser'
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

  // Wizard state
  const [step, setStep] = useState<Step>(migrationId && !migrationResult && !migrationError ? 'progress' : 'browse')
  const [currentPath, setCurrentPath] = useState('')
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

  const logPanelRef = useRef<HTMLDivElement>(null)

  // If a migration is active, jump to progress
  useEffect(() => {
    if (migrationId && !migrationResult && !migrationError) {
      setStep('progress')
    }
  }, [migrationId, migrationResult, migrationError])

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
        } else if (status.status === 'running' && status.phase) {
          // Only update phase if the backend is ahead of our current state
          const current = useStore.getState().migrationPhase
          if (current === 'starting' || current === 'scanning') {
            if (status.phase !== 'starting' && status.phase !== 'scanning') {
              useStore.getState().setMigrationProgress({ migrationId: status.migrationId ?? '', phase: status.phase as MigrationProgressPayload['phase'], label: status.phase, current: 0, total: 0 })
            }
          }
        }
      } catch {
        // Ignore polling errors
      }
    }

    const interval = setInterval(poll, 3000)
    return () => clearInterval(interval)
  }, [step, migrationResult, migrationError])

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

  const handlePathNavigate = useCallback((path: string) => {
    setCurrentPath(path)
    setValidation(null)
  }, [])

  const handleValidate = async () => {
    if (!currentPath) return
    setValidating(true)
    try {
      const result = await stMigrationApi.validate(currentPath)
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
    if (validation.layout === 'legacy') {
      return `${validation.basePath}/public`
    }
    return `${validation.basePath}/data/${selectedStUser}`
  }

  const handleScan = async () => {
    const dataDir = getDataDir()
    if (!dataDir) return
    setScanning(true)
    try {
      const result = await stMigrationApi.scan(dataDir)
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
      const result = await stMigrationApi.execute({ dataDir, targetUserId, scope })
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
  }

  const canProceedFromBrowse = validation?.valid === true
  const canProceedFromStUser = validation?.layout === 'legacy' || !!selectedStUser
  const needsStUserStep = validation?.layout === 'multi-user' && (validation.stUsers?.length ?? 0) > 1

  const filteredUsers = users.filter((u) => {
    if (u.id === user?.id) return true
    return u.role === 'user'
  })

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
        Navigate to your SillyTavern installation folder. This is the root directory that contains the <code>data/</code> folder.
      </p>
      <DirectoryBrowser onNavigate={handlePathNavigate} />

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
