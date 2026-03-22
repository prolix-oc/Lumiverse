import { useState, useEffect, useCallback } from 'react'
import { KeyRound, Ban, Trash2, ShieldCheck } from 'lucide-react'
import { useStore } from '@/store'
import type { AuthUser } from '@/types/store'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import styles from './UserManagement.module.css'

export default function UserManagement() {
  const {
    createUser, listUsers, changePassword,
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

  // Self-service password state
  const [showPasswordForm, setShowPasswordForm] = useState(false)
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [changingPw, setChangingPw] = useState(false)

  // Admin action state
  const [resetTarget, setResetTarget] = useState<AuthUser | null>(null)
  const [resetPw, setResetPw] = useState('')
  const [resetting, setResetting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<AuthUser | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const isAdmin = currentUser?.role === 'owner' || currentUser?.role === 'admin'

  const fetchUsers = useCallback(async () => {
    try {
      const data = await listUsers()
      setUsers(data)
    } catch {
      // Non-admin users can't list users — that's fine
    } finally {
      setLoading(false)
    }
  }, [listUsers])

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])

  const clearMessages = () => { setError(null); setSuccess(null) }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    clearMessages()
    setCreating(true)
    try {
      await createUser(username, password, role)
      setUsername(''); setPassword(''); setRole('user')
      setShowForm(false)
      setSuccess('User created successfully')
      await fetchUsers()
    } catch (err: any) {
      setError(err.message || 'Failed to create user')
    } finally {
      setCreating(false)
    }
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
      setCurrentPw(''); setNewPw(''); setConfirmPw('')
      setShowPasswordForm(false)
      setSuccess('Password changed successfully')
    } catch (err: any) {
      setError(err.body?.error || err.message || 'Failed to change password')
    } finally {
      setChangingPw(false)
    }
  }

  const handleResetPassword = async () => {
    if (!resetTarget || !resetPw) return
    clearMessages()
    setResetting(true)
    try {
      await resetUserPassword(resetTarget.id, resetPw)
      setResetTarget(null); setResetPw('')
      setSuccess(`Password reset for ${resetTarget.username || resetTarget.name}`)
    } catch (err: any) {
      setError(err.body?.error || err.message || 'Failed to reset password')
    } finally {
      setResetting(false)
    }
  }

  const handleBan = async (user: AuthUser) => {
    clearMessages()
    setActionLoading(user.id)
    try {
      if (user.banned) {
        await unbanUser(user.id)
        setSuccess(`${user.username || user.name} has been re-enabled`)
      } else {
        await banUser(user.id)
        setSuccess(`${user.username || user.name} has been disabled`)
      }
      await fetchUsers()
    } catch (err: any) {
      setError(err.body?.error || err.message || 'Action failed')
    } finally {
      setActionLoading(null)
    }
  }

  const handleDelete = async () => {
    if (!confirmDelete) return
    clearMessages()
    setActionLoading(confirmDelete.id)
    try {
      await deleteUser(confirmDelete.id)
      setSuccess(`${confirmDelete.username || confirmDelete.name} has been deleted`)
      setConfirmDelete(null)
      await fetchUsers()
    } catch (err: any) {
      setError(err.body?.error || err.message || 'Failed to delete user')
    } finally {
      setActionLoading(null)
    }
  }

  if (loading) {
    return <div className={styles.container}>Loading...</div>
  }

  return (
    <div className={styles.container}>
      {/* ── Your Account ── */}
      <section className={styles.section}>
        <div className={styles.header}>
          <h3 className={styles.title}>Your Account</h3>
          <button
            type="button"
            className={styles.addBtn}
            onClick={() => { setShowPasswordForm(!showPasswordForm); clearMessages() }}
          >
            <KeyRound size={13} />
            {showPasswordForm ? 'Cancel' : 'Change Password'}
          </button>
        </div>

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
              <button
                type="submit"
                className={styles.createBtn}
                disabled={changingPw || !currentPw || !newPw || !confirmPw}
              >
                {changingPw ? 'Saving...' : 'Save'}
              </button>
            </div>
          </form>
        )}
      </section>

      {/* ── User Management (admin only) ── */}
      {isAdmin && (
        <section className={styles.section}>
          <div className={styles.header}>
            <h3 className={styles.title}>User Management</h3>
            <button
              type="button"
              className={styles.addBtn}
              onClick={() => { setShowForm(!showForm); clearMessages() }}
            >
              {showForm ? 'Cancel' : 'Add User'}
            </button>
          </div>

          {showForm && (
            <form className={styles.form} onSubmit={handleCreate}>
              <div className={styles.formRow}>
                <input
                  className={styles.input}
                  type="text"
                  placeholder="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoFocus
                />
                <input
                  className={styles.input}
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <select
                  className={styles.select}
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
                <button
                  type="submit"
                  className={styles.createBtn}
                  disabled={creating || !username || !password}
                >
                  {creating ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          )}

          {/* Reset password inline form */}
          {resetTarget && (
            <div className={styles.form}>
              <div className={styles.resetHeader}>
                Reset password for <strong>{resetTarget.username || resetTarget.name}</strong>
              </div>
              <div className={styles.formRow}>
                <input
                  className={styles.input}
                  type="password"
                  placeholder="New password"
                  value={resetPw}
                  onChange={(e) => setResetPw(e.target.value)}
                  autoFocus
                />
                <button
                  type="button"
                  className={styles.createBtn}
                  disabled={resetting || !resetPw}
                  onClick={handleResetPassword}
                >
                  {resetting ? 'Resetting...' : 'Reset'}
                </button>
                <button
                  type="button"
                  className={styles.addBtn}
                  onClick={() => { setResetTarget(null); setResetPw('') }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className={styles.userList}>
            {users.map((u) => {
              const isSelf = u.id === currentUser?.id
              const isBanned = !!u.banned
              return (
                <div key={u.id} className={`${styles.userRow} ${isBanned ? styles.userRowBanned : ''}`}>
                  <div className={styles.userInfo}>
                    <span className={styles.userName}>
                      {u.username || u.name}
                      {isSelf && <span className={styles.youBadge}>you</span>}
                      {isBanned && <span className={styles.bannedBadge}>disabled</span>}
                    </span>
                    <span className={styles.userEmail}>{u.email}</span>
                  </div>
                  <div className={styles.userActions}>
                    <span className={styles.roleBadge} data-role={u.role}>
                      {u.role || 'user'}
                    </span>
                    {!isSelf && (
                      <>
                        <button
                          type="button"
                          className={styles.actionBtn}
                          title="Reset password"
                          onClick={() => { setResetTarget(u); setResetPw(''); clearMessages() }}
                        >
                          <KeyRound size={13} />
                        </button>
                        <button
                          type="button"
                          className={isBanned ? styles.actionBtnSuccess : styles.actionBtnWarn}
                          title={isBanned ? 'Enable login' : 'Disable login'}
                          disabled={actionLoading === u.id}
                          onClick={() => handleBan(u)}
                        >
                          {isBanned ? <ShieldCheck size={13} /> : <Ban size={13} />}
                        </button>
                        <button
                          type="button"
                          className={styles.actionBtnDanger}
                          title="Delete user"
                          disabled={actionLoading === u.id}
                          onClick={() => { setConfirmDelete(u); clearMessages() }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {error && <div className={styles.error}>{error}</div>}
      {success && <div className={styles.success}>{success}</div>}

      <ConfirmationModal
        isOpen={!!confirmDelete}
        title="Delete User"
        message={confirmDelete ? `Permanently delete "${confirmDelete.username || confirmDelete.name}" and all their data? This cannot be undone.` : ''}
        confirmText="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  )
}
