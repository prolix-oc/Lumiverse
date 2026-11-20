import { useState, useRef, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
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
  LogOut,
} from 'lucide-react'
import { IconBrandGoogleDrive, IconBrandDropbox } from '@tabler/icons-react'
import NumericInput from '@/components/shared/NumericInput'
import { Spinner } from '@/components/shared/Spinner'
import { stMigrationApi, googleDriveApi, dropboxApi } from '@/api/st-migration'
import type { FileConnectionConfig, SFTPConnectionConfig, SMBConnectionConfig } from '@/api/st-migration'
import styles from './ConnectionPicker.module.css'

type ConnectionType = 'local' | 'sftp' | 'smb' | 'google-drive' | 'dropbox'
type SFTPAuthMode = 'password' | 'key'

interface ConnectionPickerProps {
  value: FileConnectionConfig
  onChange: (config: FileConnectionConfig) => void
  /** Fires when a remote test-connection succeeds (or immediately for local) */
  onConnected?: (connected: boolean) => void
}

export default function ConnectionPicker({ value, onChange, onConnected }: ConnectionPickerProps) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [testError, setTestError] = useState('')
  const [sftpAuth, setSftpAuth] = useState<SFTPAuthMode>(
    value.type === 'sftp' && value.privateKey ? 'key' : 'password'
  )
  const [availableTypes, setAvailableTypes] = useState<ConnectionType[]>(['local'])
  const [gdriveStatus, setGdriveStatus] = useState<{
    configured: boolean; hasCustomCredentials: boolean; hasClientSecret: boolean; authorized: boolean
  } | null>(null)
  const [gdriveLoading, setGdriveLoading] = useState(false)
  const [gdriveClientId, setGdriveClientId] = useState('')
  const [gdriveClientSecret, setGdriveClientSecret] = useState('')
  const [gdriveSaving, setGdriveSaving] = useState(false)
  const [dbxStatus, setDbxStatus] = useState<{ configured: boolean; hasCustomAppKey: boolean; authorized: boolean } | null>(null)
  const [dbxLoading, setDbxLoading] = useState(false)
  const [dbxAppKey, setDbxAppKey] = useState('')
  const [dbxSaving, setDbxSaving] = useState(false)
  const [dbxAuthUrl, setDbxAuthUrl] = useState('')
  const [dbxSessionToken, setDbxSessionToken] = useState('')
  const [dbxCode, setDbxCode] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Probe which connection types the server actually supports
  useEffect(() => {
    stMigrationApi.connectionTypes()
      .then((res) => setAvailableTypes(res.types as ConnectionType[]))
      .catch(() => setAvailableTypes(['local']))
    googleDriveApi.getStatus()
      .then(setGdriveStatus)
      .catch(() => {})
    dropboxApi.getStatus()
      .then(setDbxStatus)
      .catch(() => {})
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
    } else if (type === 'smb') {
      onChange({ type: 'smb', host: '', share: '' })
      onConnected?.(false)
    } else if (type === 'google-drive') {
      onChange({ type: 'google-drive', accessToken: '' })
      onConnected?.(false)
      if (gdriveStatus?.authorized) {
        handleGdriveConnect()
      }
    } else if (type === 'dropbox') {
      onChange({ type: 'dropbox', accessToken: '' })
      onConnected?.(false)
      if (dbxStatus?.authorized) {
        handleDbxConnect()
      }
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
        setTestError(result.error || t('connectionPicker.connectionFailed'))
      }
    } catch (err: any) {
      setTestState('fail')
      setTestError(err?.body?.error || err?.message || t('connectionPicker.connectionFailed'))
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

  // ─── Google Drive handlers ──────────────────────────────────────────

  const handleGdriveAuth = async () => {
    setGdriveLoading(true)
    try {
      const { auth_url, session_token } = await googleDriveApi.initiateAuth()

      // Open popup
      const popup = window.open(auth_url, 'gdrive-auth', 'width=600,height=700')

      // Listen for postMessage from the landing page
      const handler = async (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return
        if (event.data?.type !== 'GOOGLE_DRIVE_OAUTH') return
        window.removeEventListener('message', handler)

        if (event.data.error) {
          setTestState('fail')
          setTestError(event.data.error)
          setGdriveLoading(false)
          return
        }

        try {
          await googleDriveApi.completeAuth(session_token, event.data.code)
          const status = await googleDriveApi.getStatus()
          setGdriveStatus(status)
          await handleGdriveConnect()
        } catch (err: any) {
          setTestState('fail')
          setTestError(err?.message || t('connectionPicker.authFailed'))
        }
        setGdriveLoading(false)
      }

      window.addEventListener('message', handler)

      // Fallback: if popup is closed without completing
      const checkClosed = setInterval(() => {
        if (popup?.closed) {
          clearInterval(checkClosed)
          window.removeEventListener('message', handler)
          setGdriveLoading(false)
        }
      }, 500)
    } catch (err: any) {
      setTestState('fail')
      setTestError(err?.body?.error || err?.message || t('connectionPicker.initiateAuthFailed'))
      setGdriveLoading(false)
    }
  }

  const handleGdriveConnect = async () => {
    try {
      const { access_token } = await googleDriveApi.getAccessToken()
      onChange({ type: 'google-drive', accessToken: access_token })
      setTestState('ok')
      onConnected?.(true)
    } catch (err: any) {
      setTestState('fail')
      setTestError(err?.body?.error || err?.message || t('connectionPicker.getTokenFailed'))
    }
  }

  const handleGdriveSaveCredentials = async () => {
    if (!gdriveClientId.trim()) return
    setGdriveSaving(true)
    try {
      await googleDriveApi.saveCredentials(gdriveClientId.trim(), gdriveClientSecret.trim() || undefined)
      const status = await googleDriveApi.getStatus()
      setGdriveStatus(status)
      setGdriveClientId('')
      setGdriveClientSecret('')
    } catch { /* ignore */ }
    setGdriveSaving(false)
  }

  const handleGdriveRevoke = async () => {
    try {
      await googleDriveApi.revoke()
      const status = await googleDriveApi.getStatus()
      setGdriveStatus(status)
      setTestState('idle')
      onConnected?.(false)
      onChange({ type: 'google-drive', accessToken: '' })
    } catch { /* ignore */ }
  }

  const handleGdriveClearCredentials = async () => {
    try {
      await googleDriveApi.clearCredentials()
      const status = await googleDriveApi.getStatus()
      setGdriveStatus(status)
      setTestState('idle')
      onConnected?.(false)
      onChange({ type: 'google-drive', accessToken: '' })
    } catch { /* ignore */ }
  }

  // ─── Dropbox handlers ───────────────────────────────────────────────

  const handleDbxSaveKey = async () => {
    if (!dbxAppKey.trim()) return
    setDbxSaving(true)
    try {
      await dropboxApi.saveCredentials(dbxAppKey.trim())
      const status = await dropboxApi.getStatus()
      setDbxStatus(status)
      setDbxAppKey('')
    } catch { /* ignore */ }
    setDbxSaving(false)
  }

  const handleDbxAuth = async () => {
    setDbxLoading(true)
    setTestState('idle')
    setTestError('')
    try {
      const { auth_url, session_token } = await dropboxApi.initiateAuth()
      setDbxAuthUrl(auth_url)
      setDbxSessionToken(session_token)
      setDbxCode('')
      // Open Dropbox auth in a new tab — they'll see the code there
      window.open(auth_url, '_blank')
    } catch (err: any) {
      setTestState('fail')
      setTestError(err?.body?.error || err?.message || t('connectionPicker.initiateAuthFailed'))
    }
    setDbxLoading(false)
  }

  const handleDbxSubmitCode = async () => {
    if (!dbxCode.trim() || !dbxSessionToken) return
    setDbxLoading(true)
    try {
      await dropboxApi.completeAuth(dbxSessionToken, dbxCode.trim())
      const status = await dropboxApi.getStatus()
      setDbxStatus(status)
      setDbxAuthUrl('')
      setDbxSessionToken('')
      setDbxCode('')
      await handleDbxConnect()
    } catch (err: any) {
      setTestState('fail')
      setTestError(err?.body?.error || err?.message || t('connectionPicker.authFailed'))
    }
    setDbxLoading(false)
  }

  const handleDbxConnect = async () => {
    try {
      const { access_token } = await dropboxApi.getAccessToken()
      onChange({ type: 'dropbox', accessToken: access_token })
      setTestState('ok')
      onConnected?.(true)
    } catch (err: any) {
      setTestState('fail')
      setTestError(err?.body?.error || err?.message || t('connectionPicker.getTokenFailed'))
    }
  }

  const handleDbxRevoke = async () => {
    try {
      await dropboxApi.revoke()
      const status = await dropboxApi.getStatus()
      setDbxStatus(status)
      setTestState('idle')
      onConnected?.(false)
      onChange({ type: 'dropbox', accessToken: '' })
    } catch { /* ignore */ }
  }

  const handleDbxClearCredentials = async () => {
    try {
      await dropboxApi.clearCredentials()
      const status = await dropboxApi.getStatus()
      setDbxStatus(status)
      setTestState('idle')
      onConnected?.(false)
      onChange({ type: 'dropbox', accessToken: '' })
    } catch { /* ignore */ }
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
          {t('connectionPicker.tabLocal')}
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
        {availableTypes.includes('google-drive') && (
          <button
            type="button"
            className={activeType === 'google-drive' ? styles.tabActive : styles.tab}
            onClick={() => switchType('google-drive')}
          >
            <IconBrandGoogleDrive size={13} className={styles.tabIcon} />
            Google Drive
          </button>
        )}
        {availableTypes.includes('dropbox') && (
          <button
            type="button"
            className={activeType === 'dropbox' ? styles.tabActive : styles.tab}
            onClick={() => switchType('dropbox')}
          >
            <IconBrandDropbox size={13} className={styles.tabIcon} />
            Dropbox
          </button>
        )}
      </div>

      {/* ─── SFTP config ─────────────────────────────────────────────── */}
      {activeType === 'sftp' && (
        <div className={styles.configForm}>
          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.label}>{t('connectionPicker.host')}</label>
              <input
                className={styles.input}
                type="text"
                placeholder={t('connectionPicker.hostPlaceholderSftp')}
                value={sftp.host || ''}
                onChange={(e) => updateField('host', e.target.value)}
              />
            </div>
            <div className={styles.fieldSmall}>
              <label className={styles.label}>{t('connectionPicker.port')}</label>
                <NumericInput
                  className={styles.input}
                  placeholder="22"
                  value={sftp.port ?? 22}
                  integer
                  onChange={(value) => updateField('port', value ?? 22)}
                />
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>{t('connectionPicker.username')}</label>
            <input
              className={styles.input}
              type="text"
              placeholder={t('connectionPicker.usernamePlaceholder')}
              value={sftp.username || ''}
              onChange={(e) => updateField('username', e.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>{t('connectionPicker.authentication')}</label>
            <div className={styles.authTabs}>
              <button
                type="button"
                className={sftpAuth === 'password' ? styles.authTabActive : styles.authTab}
                onClick={() => setSftpAuth('password')}
              >
                {t('connectionPicker.authPassword')}
              </button>
              <button
                type="button"
                className={sftpAuth === 'key' ? styles.authTabActive : styles.authTab}
                onClick={() => setSftpAuth('key')}
              >
                {t('connectionPicker.authPrivateKey')}
              </button>
            </div>
          </div>

          {sftpAuth === 'password' ? (
            <div className={styles.field}>
              <label className={styles.label}>{t('connectionPicker.password')}</label>
              <input
                className={styles.input}
                type="password"
                placeholder={t('connectionPicker.password')}
                value={sftp.password || ''}
                onChange={(e) => updateField('password', e.target.value)}
                autoComplete="off"
              />
            </div>
          ) : (
            <>
              <div className={styles.field}>
                <label className={styles.label}>{t('connectionPicker.privateKey')}</label>
                {sftp.privateKey ? (
                  <div className={styles.fileUploaded}>
                    <KeyRound size={12} />
                    {t('connectionPicker.keyLoaded', { count: sftp.privateKey.length })}
                    <button type="button" className={styles.fileClear} onClick={clearKey}>
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <div className={styles.fileUploadRow}>
                    <button type="button" className={styles.fileUploadBtn} onClick={handleKeyFileUpload}>
                      <Upload size={12} />
                      {t('connectionPicker.uploadKeyFile')}
                    </button>
                    <span className={styles.hint}>{t('connectionPicker.orPasteBelow')}</span>
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
                <label className={styles.label}>{t('connectionPicker.passphraseOptional')}</label>
                <input
                  className={styles.input}
                  type="password"
                  placeholder={t('connectionPicker.keyPassphrasePlaceholder')}
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
              {t('connectionPicker.testConnection')}
            </button>
            {testState === 'ok' && (
              <span className={styles.testOk}>
                <CheckCircle size={12} /> {t('connectionPicker.connected')}
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
              <label className={styles.label}>{t('connectionPicker.host')}</label>
              <input
                className={styles.input}
                type="text"
                placeholder={t('connectionPicker.hostPlaceholderSmb')}
                value={smb.host || ''}
                onChange={(e) => updateField('host', e.target.value)}
              />
            </div>
            <div className={styles.fieldSmall}>
              <label className={styles.label}>{t('connectionPicker.port')}</label>
                <NumericInput
                  className={styles.input}
                  placeholder="445"
                  value={smb.port ?? 445}
                  integer
                  onChange={(value) => updateField('port', value ?? 445)}
                />
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>{t('connectionPicker.shareName')}</label>
            <input
              className={styles.inputMono}
              type="text"
              placeholder={t('connectionPicker.sharePlaceholder')}
              value={smb.share || ''}
              onChange={(e) => updateField('share', e.target.value)}
            />
            <span className={styles.hint}>{t('connectionPicker.shareHint')}</span>
          </div>

          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.label}>{t('connectionPicker.usernameOptional')}</label>
              <input
                className={styles.input}
                type="text"
                placeholder="guest"
                value={smb.username || ''}
                onChange={(e) => updateField('username', e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>{t('connectionPicker.domainOptional')}</label>
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
            <label className={styles.label}>{t('connectionPicker.passwordOptional')}</label>
            <input
              className={styles.input}
              type="password"
              placeholder={t('connectionPicker.password')}
              value={smb.password || ''}
              onChange={(e) => updateField('password', e.target.value)}
              autoComplete="off"
            />
          </div>

          <div className={styles.testRow}>
            <button type="button" className={styles.testBtn} onClick={handleTest} disabled={!canTest}>
              {testState === 'testing' ? <Spinner size={11} /> : <Plug size={11} />}
              {t('connectionPicker.testConnection')}
            </button>
            {testState === 'ok' && (
              <span className={styles.testOk}>
                <CheckCircle size={12} /> {t('connectionPicker.connected')}
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

      {/* ─── Google Drive config ─────────────────────────────────────── */}
      {activeType === 'google-drive' && (
        <div className={styles.configForm}>
          {/* Credentials setup — show when no credentials exist */}
          {!gdriveStatus?.configured && (
            <>
              <p className={styles.hint}>
                {t('connectionPicker.gdriveSetupHint')}
              </p>
              <div className={styles.field}>
                <label className={styles.label}>{t('connectionPicker.clientId')}</label>
                <input
                  className={styles.inputMono}
                  type="text"
                  placeholder="123456789-abcdefg.apps.googleusercontent.com"
                  value={gdriveClientId}
                  onChange={(e) => setGdriveClientId(e.target.value)}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>{t('connectionPicker.clientSecret')}</label>
                <input
                  className={styles.input}
                  type="password"
                  placeholder="GOCSPX-..."
                  value={gdriveClientSecret}
                  onChange={(e) => setGdriveClientSecret(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className={styles.testRow}>
                <button
                  type="button"
                  className={styles.testBtn}
                  onClick={handleGdriveSaveCredentials}
                  disabled={!gdriveClientId.trim() || gdriveSaving}
                >
                  {gdriveSaving ? <Spinner size={11} /> : <KeyRound size={11} />}
                  {t('connectionPicker.saveCredentials')}
                </button>
              </div>
            </>
          )}

          {/* Authorized — ready to use */}
          {gdriveStatus?.configured && gdriveStatus?.authorized && (
            <>
              <div className={styles.testRow}>
                <span className={styles.testOk}>
                  <CheckCircle size={12} /> {t('connectionPicker.gdriveAuthorized')}
                </span>
                <button type="button" className={styles.testBtn} onClick={handleGdriveRevoke}>
                  <LogOut size={11} /> {t('connectionPicker.disconnect')}
                </button>
              </div>
              {testState !== 'ok' && (
                <div className={styles.testRow}>
                  <button type="button" className={styles.testBtn} onClick={handleGdriveConnect} disabled={gdriveLoading}>
                    {gdriveLoading ? <Spinner size={11} /> : <Plug size={11} />}
                    {t('connectionPicker.connect')}
                  </button>
                  {testState === 'fail' && (
                    <span className={styles.testFail}>
                      <XCircle size={12} /> {testError}
                    </span>
                  )}
                </div>
              )}
              {gdriveStatus.hasCustomCredentials && (
                <button type="button" className={styles.testBtn} onClick={handleGdriveClearCredentials}>
                  <X size={11} /> {t('connectionPicker.removeCredentials')}
                </button>
              )}
            </>
          )}

          {/* Configured but not yet authorized — show authorize button */}
          {gdriveStatus?.configured && !gdriveStatus?.authorized && (
            <>
              <p className={styles.hint}>
                {t('connectionPicker.gdriveAuthorizeHint')}
              </p>
              <div className={styles.testRow}>
                <button type="button" className={styles.testBtn} onClick={handleGdriveAuth} disabled={gdriveLoading}>
                  {gdriveLoading ? <Spinner size={11} /> : <IconBrandGoogleDrive size={11} />}
                  {t('connectionPicker.authorizeGDrive')}
                </button>
                <button type="button" className={styles.testBtn} onClick={handleGdriveClearCredentials}>
                  <X size={11} /> {t('connectionPicker.removeCredentials')}
                </button>
                {testState === 'fail' && (
                  <span className={styles.testFail}>
                    <XCircle size={12} /> {testError}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ─── Dropbox config ──────────────────────────────────────────── */}
      {activeType === 'dropbox' && (
        <div className={styles.configForm}>
          {!dbxStatus?.configured && (
            <>
              <p className={styles.hint}>
                {t('connectionPicker.dbxSetupHint')}
              </p>
              <div className={styles.field}>
                <label className={styles.label}>{t('connectionPicker.appKey')}</label>
                <input
                  className={styles.inputMono}
                  type="text"
                  placeholder="e.g. owdjktek8mg5ren"
                  value={dbxAppKey}
                  onChange={(e) => setDbxAppKey(e.target.value)}
                />
              </div>
              <div className={styles.testRow}>
                <button
                  type="button"
                  className={styles.testBtn}
                  onClick={handleDbxSaveKey}
                  disabled={!dbxAppKey.trim() || dbxSaving}
                >
                  {dbxSaving ? <Spinner size={11} /> : <KeyRound size={11} />}
                  {t('connectionPicker.saveAppKey')}
                </button>
              </div>
            </>
          )}

          {dbxStatus?.configured && dbxStatus?.authorized && (
            <>
              <div className={styles.testRow}>
                <span className={styles.testOk}>
                  <CheckCircle size={12} /> {t('connectionPicker.dbxAuthorized')}
                </span>
                <button type="button" className={styles.testBtn} onClick={handleDbxRevoke}>
                  <LogOut size={11} /> {t('connectionPicker.disconnect')}
                </button>
              </div>
              {testState !== 'ok' && (
                <div className={styles.testRow}>
                  <button type="button" className={styles.testBtn} onClick={handleDbxConnect} disabled={dbxLoading}>
                    {dbxLoading ? <Spinner size={11} /> : <Plug size={11} />}
                    {t('connectionPicker.connect')}
                  </button>
                  {testState === 'fail' && (
                    <span className={styles.testFail}>
                      <XCircle size={12} /> {testError}
                    </span>
                  )}
                </div>
              )}
              {dbxStatus.hasCustomAppKey && (
                <button type="button" className={styles.testBtn} onClick={handleDbxClearCredentials}>
                  <X size={11} /> {t('connectionPicker.removeAppKey')}
                </button>
              )}
            </>
          )}

          {dbxStatus?.configured && !dbxStatus?.authorized && (
            <>
              {!dbxAuthUrl ? (
                <>
                  <p className={styles.hint}>
                    {t('connectionPicker.dbxAuthorizeHint1')}
                  </p>
                  <div className={styles.testRow}>
                    <button type="button" className={styles.testBtn} onClick={handleDbxAuth} disabled={dbxLoading}>
                      {dbxLoading ? <Spinner size={11} /> : <IconBrandDropbox size={11} />}
                      {t('connectionPicker.authorizeDropbox')}
                    </button>
                    <button type="button" className={styles.testBtn} onClick={handleDbxClearCredentials}>
                      <X size={11} /> {t('connectionPicker.removeAppKey')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className={styles.hint}>
                    {t('connectionPicker.dbxAuthorizeHint2')}
                  </p>
                  <div className={styles.field}>
                    <label className={styles.label}>{t('connectionPicker.authCode')}</label>
                    <input
                      className={styles.inputMono}
                      type="text"
                      placeholder={t('connectionPicker.authCodePlaceholder')}
                      value={dbxCode}
                      onChange={(e) => setDbxCode(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleDbxSubmitCode() }}
                      autoFocus
                    />
                  </div>
                  <div className={styles.testRow}>
                    <button
                      type="button"
                      className={styles.testBtn}
                      onClick={handleDbxSubmitCode}
                      disabled={!dbxCode.trim() || dbxLoading}
                    >
                      {dbxLoading ? <Spinner size={11} /> : <CheckCircle size={11} />}
                      {t('connectionPicker.submitCode')}
                    </button>
                    <button type="button" className={styles.testBtn} onClick={() => { setDbxAuthUrl(''); setDbxSessionToken(''); setDbxCode('') }}>
                      <X size={11} /> {tc('actions.cancel')}
                    </button>
                  </div>
                </>
              )}
              {testState === 'fail' && (
                <span className={styles.testFail}>
                  <XCircle size={12} /> {testError}
                </span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
