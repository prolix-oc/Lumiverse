import { useState, useEffect, useCallback } from 'react'
import { Ban, Trash2, ShieldCheck } from 'lucide-react'
import { useStore } from '@/store'
import type { AuthUser } from '@/types/store'
import { Button } from '@/components/shared/FormComponents'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import styles from './UserManagement.module.css'

export default function UserManagement() {
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
      setSuccess('User created successfully')
      await fetchUsers()
    } catch (err: any) {
      setError(err.message || 'Failed to create user')
    } finally {
      setCreating(false)
    }
  }

  const handleResetPassword = async () => {
    if (!resetTarget || !resetPw) return
    clearMessages()
    setResetting(true)
    try {
      await resetUserPassword(resetTarget.id, resetPw)
      setResetTarget(null)
      setResetPw('')
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

  if (!isAdmin) {
    return <div className={styles.container}>User management requires admin access.</div>
  }

  return (
    <div className={styles.container}>
      <section className={styles.section}>
        <div className={styles.header}>
          <h3 className={styles.title}>User Management</h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setShowForm(!showForm)
              clearMessages()
            }}
          >
            {showForm ? 'Cancel' : 'Add User'}
          </Button>
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
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={creating || !username || !password}
                loading={creating}
              >
                {creating ? 'Creating...' : 'Create'}
              </Button>
            </div>
          </form>
        )}

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
              <Button
                variant="primary"
                size="sm"
                disabled={resetting || !resetPw}
                loading={resetting}
                onClick={handleResetPassword}
              >
                {resetting ? 'Resetting...' : 'Reset'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setResetTarget(null); setResetPw('') }}>
                Cancel
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
                    {user.username || user.name}
                    {isSelf && <span className={styles.youBadge}>You</span>}
                    {!!user.banned && <span className={styles.bannedBadge}>Banned</span>}
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
                      title="Reset password"
                    >
                      Reset
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
                      title={user.banned ? 'Unban user' : 'Ban user'}
                    >
                      {user.banned ? 'Enable' : 'Disable'}
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
                      title="Delete user"
                    >
                      Delete
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
          title="Delete User"
          message={
            actionLoading === confirmDelete.id
              ? `Wiping data for ${confirmDelete.username || confirmDelete.name}. This can take a while if they have a lot of chats, vectors, or files.`
              : `Are you sure you want to permanently delete ${confirmDelete.username || confirmDelete.name}? This cannot be undone.`
          }
          variant="danger"
          confirmText="Delete"
          cancelText="Cancel"
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(null)}
          loading={actionLoading === confirmDelete.id}
          loadingText="Deleting..."
        />
      )}
    </div>
  )
}
