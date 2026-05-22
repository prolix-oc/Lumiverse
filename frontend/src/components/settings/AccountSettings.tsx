import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import { useStore } from '@/store'
import { Button } from '@/components/shared/FormComponents'
import styles from './UserManagement.module.css'

export default function AccountSettings() {
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
      setError('Passwords do not match')
      return
    }

    setChangingPw(true)
    try {
      await changePassword(currentPw, newPw)
      setCurrentPw('')
      setNewPw('')
      setConfirmPw('')
      setShowPasswordForm(false)
      setSuccess('Password changed successfully')
    } catch (err: any) {
      setError(err.body?.error || err.message || 'Failed to change password')
    } finally {
      setChangingPw(false)
    }
  }

  return (
    <div className={styles.container}>
      <section className={styles.section}>
        <div className={styles.header}>
          <h3 className={styles.title}>Account</h3>
          <Button
            variant="ghost"
            size="sm"
            icon={<KeyRound size={13} />}
            onClick={() => {
              setShowPasswordForm(!showPasswordForm)
              clearMessages()
            }}
          >
            {showPasswordForm ? 'Cancel' : 'Change Password'}
          </Button>
        </div>

        <div className={styles.form}>
          <div className={styles.userInfo}>
            <div className={styles.userName}>{user?.username || user?.name || 'Signed in user'}</div>
            <div className={styles.userEmail}>{user?.email || 'No email available'}</div>
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
                placeholder="Current password"
                value={currentPw}
                onChange={(e) => setCurrentPw(e.target.value)}
                autoFocus
              />
              <input
                className={styles.input}
                type="password"
                placeholder="New password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
              />
              <input
                className={styles.input}
                type="password"
                placeholder="Confirm new password"
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
                {changingPw ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </form>
        )}
      </section>
    </div>
  )
}
