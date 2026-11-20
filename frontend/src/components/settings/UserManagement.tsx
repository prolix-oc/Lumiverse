import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Ban, Trash2, ShieldCheck } from 'lucide-react'
import clsx from 'clsx'
import { useStore } from '@/store'
import type { AuthUser } from '@/types/store'
import { Button } from '@/components/shared/FormComponents'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import sectionStyles from './SettingsSection.module.css'
import styles from './UserManagement.module.css'

export default function UserManagement() {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')
  const {
    createUser, listUsers,
    resetUserPassword, banUser, unbanUser, deleteUser,
    user: currentUser,
  } = useStore()

  const [users, setUsers] = useState<AuthUser[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('user')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const [resetTarget, setResetTarget] = useState<AuthUser | null>(null)
  const [resetPw, setResetPw] = useState('')
  const [resetting, setResetting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<AuthUser | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const isAdmin = currentUser?.role === 'owner' || currentUser?.role === 'admin'
  const displayName = (user: AuthUser) => user.username || user.name || user.email || user.id

  const fetchUsers = useCallback(async () => {
    try {
      const data = await listUsers()
      setUsers(data)
    } catch {
      // Non-admin users can land here if a stale settings view is restored.
    } finally {
      setLoading(false)
    }
  }, [listUsers])

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])

  const clearMessages = () => {
    setError(null)
    setSuccess(null)
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    clearMessages()
    setCreating(true)
    try {
      await createUser(username, password, role)
      setUsername('')
      setPassword('')
      setRole('user')
      setShowForm(false)
      setSuccess(t('users.userCreated'))
      await fetchUsers()
    } catch (err: any) {
      setError(err.message || t('users.createFailed'))
    } finally {
      setCreating(false)
    }
  }

  const handleResetPassword = async () => {
    if (!resetTarget || !resetPw) return
    clearMessages()
    setResetting(true)
    const name = displayName(resetTarget)
    try {
      await resetUserPassword(resetTarget.id, resetPw)
      setResetTarget(null)
      setResetPw('')
      setSuccess(t('users.resetSuccess', { name }))
    } catch (err: any) {
      setError(err.body?.error || err.message || t('users.resetFailed'))
    } finally {
      setResetting(false)
    }
  }

  const handleBan = async (user: AuthUser) => {
    clearMessages()
    setActionLoading(user.id)
    const name = displayName(user)
    try {
      if (user.banned) {
        await unbanUser(user.id)
        setSuccess(t('users.userReEnabled', { name }))
      } else {
        await banUser(user.id)
        setSuccess(t('users.userDisabled', { name }))
      }
      await fetchUsers()
    } catch (err: any) {
      setError(err.body?.error || err.message || t('users.actionFailed'))
    } finally {
      setActionLoading(null)
    }
  }

  const handleDelete = async () => {
    if (!confirmDelete) return
    clearMessages()
    setActionLoading(confirmDelete.id)
    const name = displayName(confirmDelete)
    try {
      await deleteUser(confirmDelete.id)
      setSuccess(t('users.userDeleted', { name }))
      setConfirmDelete(null)
      await fetchUsers()
    } catch (err: any) {
      setError(err.body?.error || err.message || t('users.deleteFailed'))
    } finally {
      setActionLoading(null)
    }
  }

  if (loading) {
    return <div className={styles.container}>{t('users.loading')}</div>
  }

  if (!isAdmin) {
    return <div className={styles.container}>{t('users.adminRequired')}</div>
  }

  return (
    <div className={styles.container}>
      <section className={styles.section}>
        <div className={styles.header}>
          <h3 className={clsx(sectionStyles.title, styles.title)}>{t('users.title')}</h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setShowForm(!showForm)
              clearMessages()
            }}
          >
            {showForm ? tc('actions.cancel') : t('users.addUser')}
          </Button>
        </div>

        {showForm && (
          <form className={styles.form} onSubmit={handleCreate}>
            <div className={styles.formRow}>
              <input
                className={styles.input}
                type="text"
                placeholder={t('users.username')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
              />
              <input
                className={styles.input}
                type="password"
                placeholder={t('users.password')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <select
                className={styles.select}
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                <option value="user">{t('users.roleUser')}</option>
                <option value="admin">{t('users.roleAdmin')}</option>
              </select>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={creating || !username || !password}
                loading={creating}
              >
                {creating ? t('users.creating') : t('users.create')}
              </Button>
            </div>
          </form>
        )}

        {resetTarget && (
          <div className={styles.form}>
            <div className={styles.resetHeader}>
              {t('users.resetPasswordFor')} <strong>{displayName(resetTarget)}</strong>
            </div>
            <div className={styles.formRow}>
              <input
                className={styles.input}
                type="password"
                placeholder={t('users.newPassword')}
                value={resetPw}
                onChange={(e) => setResetPw(e.target.value)}
                autoFocus
              />
              <Button
                variant="primary"
                size="sm"
                disabled={resetting || !resetPw}
                loading={resetting}
                onClick={handleResetPassword}
              >
                {resetting ? t('users.resetting') : t('users.reset')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setResetTarget(null); setResetPw('') }}>
                {tc('actions.cancel')}
              </Button>
            </div>
          </div>
        )}

        {error && <div className={styles.error}>{error}</div>}
        {success && <div className={styles.success}>{success}</div>}

        <div className={styles.userList}>
          {users.map((user) => {
            const isSelf = user.id === currentUser?.id
            const canDelete = !isSelf && user.role !== 'owner'
            const canBan = !isSelf && user.role !== 'owner'
            const isLoading = actionLoading === user.id

            return (
              <div key={user.id} className={`${styles.userRow} ${user.banned ? styles.userRowBanned : ''}`}>
                <div className={styles.userInfo}>
                  <div className={styles.userName}>
                    {displayName(user)}
                    {isSelf && <span className={styles.youBadge}>{t('users.youBadge')}</span>}
                    {!!user.banned && <span className={styles.bannedBadge}>{t('users.bannedBadge')}</span>}
                  </div>
                  <div className={styles.userEmail}>{user.email}</div>
                </div>

                <div className={styles.userActions}>
                  <span className={styles.roleBadge} data-role={user.role || 'user'}>
                    {user.role || 'user'}
                  </span>

                  {!isSelf && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setResetTarget(user)
                        setResetPw('')
                        clearMessages()
                      }}
                      title={t('users.resetPasswordTitle')}
                    >
                      {t('users.reset')}
                    </Button>
                  )}

                  {canBan && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className={user.banned ? styles.actionBtnSuccess : styles.actionBtnWarn}
                      icon={user.banned ? <ShieldCheck size={13} /> : <Ban size={13} />}
                      onClick={() => handleBan(user)}
                      disabled={isLoading}
                      loading={isLoading}
                      title={user.banned ? t('users.unbanUser') : t('users.banUser')}
                    >
                      {user.banned ? t('users.enable') : t('users.disable')}
                    </Button>
                  )}

                  {canDelete && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Trash2 size={13} />}
                      onClick={() => {
                        setConfirmDelete(user)
                        clearMessages()
                      }}
                      disabled={isLoading}
                      title={t('users.deleteUser')}
                    >
                      {tc('actions.delete')}
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {confirmDelete && (
        <ConfirmationModal
          isOpen
          title={t('users.deleteTitle')}
          message={
            actionLoading === confirmDelete.id
              ? t('users.deleteWiping', { name: displayName(confirmDelete) })
              : t('users.deleteConfirm', { name: displayName(confirmDelete) })
          }
          variant="danger"
          confirmText={tc('actions.delete')}
          cancelText={tc('actions.cancel')}
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(null)}
          loading={actionLoading === confirmDelete.id}
          loadingText={t('users.deleting')}
        />
      )}
    </div>
  )
}
