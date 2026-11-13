import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound } from 'lucide-react'
import { useStore } from '@/store'
import { Button } from '@/components/shared/FormComponents'
import RequestHistory from './RequestHistory'
import SingleTabSetting from './SingleTabSetting'
import styles from './UserManagement.module.css'

export default function AccountSettings() {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')
  const user = useStore((s) => s.user)
  const changePassword = useStore((s) => s.changePassword)

  const [showPasswordForm, setShowPasswordForm] = useState(false)
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [changingPw, setChangingPw] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const clearMessages = () => {
    setError(null)
    setSuccess(null)
  }

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    clearMessages()

    if (newPw !== confirmPw) {
      setError(t('account.passwordMismatch'))
      return
    }

    setChangingPw(true)
    try {
      await changePassword(currentPw, newPw)
      setCurrentPw('')
      setNewPw('')
      setConfirmPw('')
      setShowPasswordForm(false)
      setSuccess(t('account.passwordChanged'))
    } catch (err: any) {
      setError(err.body?.error || err.message || t('account.passwordChangeFailed'))
    } finally {
      setChangingPw(false)
    }
  }

  return (
    <div className={styles.container}>
      <section className={styles.section}>
        <div className={styles.header}>
          <h3 className={styles.title} id="setsec-account-general">{t('account.title')}</h3>
          <Button
            variant="ghost"
            size="sm"
            icon={<KeyRound size={13} />}
            onClick={() => {
              setShowPasswordForm(!showPasswordForm)
              clearMessages()
            }}
          >
            {showPasswordForm ? tc('actions.cancel') : t('account.changePassword')}
          </Button>
        </div>

        <div className={styles.form}>
          <div className={styles.userInfo}>
            <div className={styles.userName}>{user?.username || user?.name || t('account.signedInUser')}</div>
            <div className={styles.userEmail}>{user?.email || t('account.noEmail')}</div>
          </div>
        </div>

        {error && <div className={styles.error}>{error}</div>}
        {success && <div className={styles.success}>{success}</div>}

        {showPasswordForm && (
          <form className={styles.form} onSubmit={handleChangePassword}>
            <div className={styles.formRow}>
              <input
                className={styles.input}
                type="password"
                placeholder={t('account.currentPassword')}
                value={currentPw}
                onChange={(e) => setCurrentPw(e.target.value)}
                autoFocus
              />
              <input
                className={styles.input}
                type="password"
                placeholder={t('account.newPassword')}
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
              />
              <input
                className={styles.input}
                type="password"
                placeholder={t('account.confirmPassword')}
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
              />
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={changingPw || !currentPw || !newPw || !confirmPw}
                loading={changingPw}
              >
                {changingPw ? t('account.saving') : tc('actions.save')}
              </Button>
            </div>
          </form>
        )}
      </section>
      {user && <SingleTabSetting key={`tabs:${user.id}`} userId={user.id} />}
      {user && <RequestHistory key={user.id} />}
    </div>
  )
}
