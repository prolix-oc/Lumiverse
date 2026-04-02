import { useState, useEffect, useCallback } from 'react'
import { Plus } from 'lucide-react'
import { mcpServersApi } from '@/api/mcp-servers'
import type { McpServerProfile, CreateMcpServerInput } from '@/api/mcp-servers'
import { useStore } from '@/store'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import McpServerForm from './McpServerForm'
import McpServerItem from './McpServerItem'
import styles from '../../panels/ConnectionManager.module.css'

export default function McpServerSettings() {
  const servers = useStore((s) => s.mcpServers)
  const setServers = useStore((s) => s.setMcpServers)
  const addServer = useStore((s) => s.addMcpServer)
  const updateServer = useStore((s) => s.updateMcpServer)
  const removeServer = useStore((s) => s.removeMcpServer)
  const statuses = useStore((s) => s.mcpServerStatuses)
  const setStatus = useStore((s) => s.setMcpServerStatus)

  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<McpServerProfile | null>(null)

  useEffect(() => {
    let cancelled = false

    async function init() {
      setLoading(true)
      try {
        const [serversResult, statusResult] = await Promise.allSettled([
          mcpServersApi.list({ limit: 100 }),
          mcpServersApi.allStatus(),
        ])

        if (cancelled) return

        if (serversResult.status === 'fulfilled') {
          setServers(serversResult.value.data)
        }

        if (statusResult.status === 'fulfilled') {
          for (const s of statusResult.value.servers) {
            setStatus(s.id, s)
          }
        }
      } catch (err) {
        console.error('[McpServerSettings] Init failed:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    init()
    return () => { cancelled = true }
  }, [])

  const handleCreate = useCallback(async (input: CreateMcpServerInput) => {
    try {
      const server = await mcpServersApi.create(input)
      addServer(server)
      setCreating(false)
    } catch (err) {
      console.error('[McpServerSettings] Create failed:', err)
    }
  }, [addServer])

  const handleUpdate = useCallback(async (id: string, input: Partial<CreateMcpServerInput>) => {
    try {
      const server = await mcpServersApi.update(id, input)
      updateServer(id, server)
    } catch (err) {
      console.error('[McpServerSettings] Update failed:', err)
    }
  }, [updateServer])

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await mcpServersApi.delete(deleteTarget.id)
      removeServer(deleteTarget.id)
    } catch (err) {
      console.error('[McpServerSettings] Delete failed:', err)
    } finally {
      setDeleteTarget(null)
    }
  }, [deleteTarget, removeServer])

  const handleConnect = useCallback(async (id: string) => {
    try {
      const status = await mcpServersApi.connect(id)
      setStatus(id, status)
    } catch (err) {
      console.error('[McpServerSettings] Connect failed:', err)
    }
  }, [setStatus])

  const handleDisconnect = useCallback(async (id: string) => {
    try {
      await mcpServersApi.disconnect(id)
      setStatus(id, { id, connected: false, tool_count: 0, tools: [] })
    } catch (err) {
      console.error('[McpServerSettings] Disconnect failed:', err)
    }
  }, [setStatus])

  const handleTest = useCallback(async (id: string) => {
    const result = await mcpServersApi.test(id)
    return result
  }, [])

  if (loading) {
    return <div className={styles.loading}>Loading MCP servers...</div>
  }

  return (
    <div className={styles.manager}>
      <button
        className={styles.createBtn}
        onClick={() => setCreating(true)}
        disabled={creating}
      >
        <Plus size={14} />
        Add MCP Server
      </button>

      {creating && (
        <McpServerForm
          onSave={handleCreate}
          onCancel={() => setCreating(false)}
        />
      )}

      {servers.length === 0 && !creating && (
        <div className={styles.empty}>
          No MCP servers configured. Add one to enable external tool access.
        </div>
      )}

      <div className={styles.list}>
        {servers.map((server) => (
          <McpServerItem
            key={server.id}
            server={server}
            status={statuses[server.id]}
            onUpdate={handleUpdate}
            onDelete={() => setDeleteTarget(server)}
            onConnect={() => handleConnect(server.id)}
            onDisconnect={() => handleDisconnect(server.id)}
            onTest={() => handleTest(server.id)}
          />
        ))}
      </div>

      {deleteTarget && (
        <ConfirmationModal
          title="Delete MCP Server"
          message={`Are you sure you want to delete "${deleteTarget.name}"? This will disconnect and remove the server configuration.`}
          isOpen={true}
          variant="danger"
          confirmText="Delete"
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
