import { useState, useRef, useCallback, useEffect } from 'react'
import {
  HardDrive,
  Globe,
  Server,
  Plug,
  CheckCircle,
  XCircle,
  Upload,
  X,
  KeyRound,
} from 'lucide-react'
import { Spinner } from '@/components/shared/Spinner'
import { stMigrationApi } from '@/api/st-migration'
import type { FileConnectionConfig, SFTPConnectionConfig, SMBConnectionConfig } from '@/api/st-migration'
import styles from './ConnectionPicker.module.css'

type ConnectionType = 'local' | 'sftp' | 'smb'
type SFTPAuthMode = 'password' | 'key'

interface ConnectionPickerProps {
  value: FileConnectionConfig
  onChange: (config: FileConnectionConfig) => void
  /** Fires when a remote test-connection succeeds (or immediately for local) */
  onConnected?: (connected: boolean) => void
}

export default function ConnectionPicker({ value, onChange, onConnected }: ConnectionPickerProps) {
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [testError, setTestError] = useState('')
  const [sftpAuth, setSftpAuth] = useState<SFTPAuthMode>(
    value.type === 'sftp' && value.privateKey ? 'key' : 'password'
  )
  const [availableTypes, setAvailableTypes] = useState<ConnectionType[]>(['local'])
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Probe which connection types the server actually supports
  useEffect(() => {
    stMigrationApi.connectionTypes()
      .then((res) => setAvailableTypes(res.types as ConnectionType[]))
      .catch(() => setAvailableTypes(['local']))
  }, [])

  const activeType = value.type

  const switchType = (type: ConnectionType) => {
    if (type === activeType) return
    setTestState('idle')
    setTestError('')
    if (type === 'local') {
      onChange({ type: 'local' })
      onConnected?.(true)
    } else if (type === 'sftp') {
      onChange({ type: 'sftp', host: '', username: '', port: 22 })
      onConnected?.(false)
    } else {
      onChange({ type: 'smb', host: '', share: '' })
      onConnected?.(false)
    }
  }

  const updateField = useCallback(
    (field: string, val: string | number) => {
      onChange({ ...value, [field]: val } as FileConnectionConfig)
      setTestState('idle')
      onConnected?.(false)
    },
    [value, onChange, onConnected]
  )

  const handleTest = async () => {
    if (value.type === 'local') return
    setTestState('testing')
    setTestError('')
    try {
      const result = await stMigrationApi.testConnection(value)
      if (result.success) {
        setTestState('ok')
        onConnected?.(true)
      } else {
        setTestState('fail')
        setTestError(result.error || 'Connection failed')
      }
    } catch (err: any) {
      setTestState('fail')
      setTestError(err?.body?.error || err?.message || 'Connection failed')
    }
  }

  const handleKeyFileUpload = () => {
    fileInputRef.current?.click()
  }

  const handleKeyFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = reader.result as string
      updateField('privateKey', text)
    }
    reader.readAsText(file)
    // Reset input so the same file can be re-selected
    e.target.value = ''
  }

  const clearKey = () => {
    updateField('privateKey', '')
  }

  const sftp = value as SFTPConnectionConfig
  const smb = value as SMBConnectionConfig

  const isRemote = activeType !== 'local'
  const canTest =
    isRemote &&
    testState !== 'testing' &&
    ((activeType === 'sftp' && sftp.host && sftp.username) ||
      (activeType === 'smb' && smb.host && smb.share))

  return (
    <div className={styles.wrapper}>
      {/* ─── Connection type tabs ─────────────────────────────────────── */}
      <div className={styles.tabs}>
        <button
          type="button"
          className={activeType === 'local' ? styles.tabActive : styles.tab}
          onClick={() => switchType('local')}
        >
          <HardDrive size={13} className={styles.tabIcon} />
          Local
        </button>
        {availableTypes.includes('sftp') && (
          <button
            type="button"
            className={activeType === 'sftp' ? styles.tabActive : styles.tab}
            onClick={() => switchType('sftp')}
          >
            <Globe size={13} className={styles.tabIcon} />
            SFTP
          </button>
        )}
        {availableTypes.includes('smb') && (
          <button
            type="button"
            className={activeType === 'smb' ? styles.tabActive : styles.tab}
            onClick={() => switchType('smb')}
          >
            <Server size={13} className={styles.tabIcon} />
            SMB
          </button>
        )}
      </div>

      {/* ─── SFTP config ─────────────────────────────────────────────── */}
      {activeType === 'sftp' && (
        <div className={styles.configForm}>
          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.label}>Host</label>
              <input
                className={styles.input}
                type="text"
                placeholder="192.168.1.50 or hostname"
                value={sftp.host || ''}
                onChange={(e) => updateField('host', e.target.value)}
              />
            </div>
            <div className={styles.fieldSmall}>
              <label className={styles.label}>Port</label>
              <input
                className={styles.input}
                type="number"
                placeholder="22"
                value={sftp.port ?? 22}
                onChange={(e) => updateField('port', parseInt(e.target.value) || 22)}
              />
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Username</label>
            <input
              className={styles.input}
              type="text"
              placeholder="user"
              value={sftp.username || ''}
              onChange={(e) => updateField('username', e.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Authentication</label>
            <div className={styles.authTabs}>
              <button
                type="button"
                className={sftpAuth === 'password' ? styles.authTabActive : styles.authTab}
                onClick={() => setSftpAuth('password')}
              >
                Password
              </button>
              <button
                type="button"
                className={sftpAuth === 'key' ? styles.authTabActive : styles.authTab}
                onClick={() => setSftpAuth('key')}
              >
                Private Key
              </button>
            </div>
          </div>

          {sftpAuth === 'password' ? (
            <div className={styles.field}>
              <label className={styles.label}>Password</label>
              <input
                className={styles.input}
                type="password"
                placeholder="Password"
                value={sftp.password || ''}
                onChange={(e) => updateField('password', e.target.value)}
                autoComplete="off"
              />
            </div>
          ) : (
            <>
              <div className={styles.field}>
                <label className={styles.label}>Private Key</label>
                {sftp.privateKey ? (
                  <div className={styles.fileUploaded}>
                    <KeyRound size={12} />
                    Key loaded ({sftp.privateKey.length} chars)
                    <button type="button" className={styles.fileClear} onClick={clearKey}>
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <div className={styles.fileUploadRow}>
                    <button type="button" className={styles.fileUploadBtn} onClick={handleKeyFileUpload}>
                      <Upload size={12} />
                      Upload key file
                    </button>
                    <span className={styles.hint}>or paste below</span>
                  </div>
                )}
                <textarea
                  className={styles.textarea}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                  value={sftp.privateKey || ''}
                  onChange={(e) => updateField('privateKey', e.target.value)}
                  spellCheck={false}
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pem,.key,.pub,.ppk,*"
                  style={{ display: 'none' }}
                  onChange={handleKeyFileChange}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Passphrase (optional)</label>
                <input
                  className={styles.input}
                  type="password"
                  placeholder="Key passphrase"
                  value={sftp.passphrase || ''}
                  onChange={(e) => updateField('passphrase', e.target.value)}
                  autoComplete="off"
                />
              </div>
            </>
          )}

          <div className={styles.testRow}>
            <button type="button" className={styles.testBtn} onClick={handleTest} disabled={!canTest}>
              {testState === 'testing' ? <Spinner size={11} /> : <Plug size={11} />}
              Test Connection
            </button>
            {testState === 'ok' && (
              <span className={styles.testOk}>
                <CheckCircle size={12} /> Connected
              </span>
            )}
            {testState === 'fail' && (
              <span className={styles.testFail}>
                <XCircle size={12} /> {testError}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ─── SMB config ──────────────────────────────────────────────── */}
      {activeType === 'smb' && (
        <div className={styles.configForm}>
          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.label}>Host</label>
              <input
                className={styles.input}
                type="text"
                placeholder="nas.local or 192.168.1.100"
                value={smb.host || ''}
                onChange={(e) => updateField('host', e.target.value)}
              />
            </div>
            <div className={styles.fieldSmall}>
              <label className={styles.label}>Port</label>
              <input
                className={styles.input}
                type="number"
                placeholder="445"
                value={smb.port ?? 445}
                onChange={(e) => updateField('port', parseInt(e.target.value) || 445)}
              />
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Share Name</label>
            <input
              className={styles.inputMono}
              type="text"
              placeholder="shared, backups, SillyTavern..."
              value={smb.share || ''}
              onChange={(e) => updateField('share', e.target.value)}
            />
            <span className={styles.hint}>The name of the shared folder (e.g. \\host\<b>share</b>)</span>
          </div>

          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.label}>Username (optional)</label>
              <input
                className={styles.input}
                type="text"
                placeholder="guest"
                value={smb.username || ''}
                onChange={(e) => updateField('username', e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Domain (optional)</label>
              <input
                className={styles.input}
                type="text"
                placeholder="WORKGROUP"
                value={smb.domain || ''}
                onChange={(e) => updateField('domain', e.target.value)}
              />
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Password (optional)</label>
            <input
              className={styles.input}
              type="password"
              placeholder="Password"
              value={smb.password || ''}
              onChange={(e) => updateField('password', e.target.value)}
              autoComplete="off"
            />
          </div>

          <div className={styles.testRow}>
            <button type="button" className={styles.testBtn} onClick={handleTest} disabled={!canTest}>
              {testState === 'testing' ? <Spinner size={11} /> : <Plug size={11} />}
              Test Connection
            </button>
            {testState === 'ok' && (
              <span className={styles.testOk}>
                <CheckCircle size={12} /> Connected
              </span>
            )}
            {testState === 'fail' && (
              <span className={styles.testFail}>
                <XCircle size={12} /> {testError}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
