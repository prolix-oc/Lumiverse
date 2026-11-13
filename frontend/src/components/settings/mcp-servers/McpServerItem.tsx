import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Plug, PlugZap, Unplug, RefreshCw, Trash2, Pencil,
  ChevronDown, ChevronRight, TestTube, Terminal, Globe, Radio,
} from 'lucide-react'
import type { McpServerProfile, McpServerStatus, McpServerTestResult, CreateMcpServerInput } from '@/api/mcp-servers'
import McpServerForm from './McpServerForm'
import styles from './McpServerItem.module.css'

const TRANSPORT_LABELS: Record<string, { label: string; icon: typeof Globe }> = {
  streamable_http: { label: 'HTTP', icon: Globe },
  sse: { label: 'SSE', icon: Radio },
  stdio: { label: 'Stdio', icon: Terminal },
}

interface McpServerItemProps {
  server: McpServerProfile
  status?: McpServerStatus
  onUpdate: (id: string, input: Partial<CreateMcpServerInput>) => Promise<void>
  onDelete: () => void
  onConnect: () => void
  onDisconnect: () => void
  onTest: () => Promise<McpServerTestResult>
}

export default function McpServerItem({
  server,
  status,
  onUpdate,
  onDelete,
  onConnect,
  onDisconnect,
  onTest,
}: McpServerItemProps) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<McpServerTestResult | null>(null)
  const [connecting, setConnecting] = useState(false)

  const isConnected = status?.connected ?? false
  const transport = TRANSPORT_LABELS[server.transport_type] || TRANSPORT_LABELS.streamable_http
  const TransportIcon = transport.icon

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await onTest()
      setTestResult(result)
      setTimeout(() => setTestResult(null), 5000)
    } catch {
      setTestResult({ success: false, message: t('mcp.testRequestFailed'), tools: [] })
      setTimeout(() => setTestResult(null), 5000)
    } finally {
      setTesting(false)
    }
  }

  const handleConnect = async () => {
    setConnecting(true)
    try {
      await onConnect()
    } finally {
      setConnecting(false)
    }
  }

  const handleDisconnect = async () => {
    setConnecting(true)
    try {
      await onDisconnect()
    } finally {
      setConnecting(false)
    }
  }

  if (editing) {
    return (
      <McpServerForm
        initial={{
          name: server.name,
          transport_type: server.transport_type,
          url: server.url,
          command: server.command,
          args: server.args,
          is_enabled: server.is_enabled,
          auto_connect: server.auto_connect,
        }}
        onSave={async (input) => {
          await onUpdate(server.id, input)
          setEditing(false)
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }

  const hasTools = (status?.tool_count ?? 0) > 0

  return (
    <div className={styles.item}>
      <div className={styles.header}>
        <div className={styles.info}>
          <div className={styles.statusDot} data-connected={isConnected} data-error={!!server.last_error && !isConnected} />
          <span className={styles.name}>{server.name}</span>
          <span className={styles.badge}>
            <TransportIcon size={10} />
            {transport.label}
          </span>
          {isConnected && hasTools && (
            <span className={styles.toolBadge}>
              {t('mcp.toolCount', { count: status!.tool_count })}
            </span>
          )}
          {!server.is_enabled && (
            <span className={styles.disabledBadge}>{t('mcp.disabled')}</span>
          )}
        </div>

        <div className={styles.actions}>
          {testResult && (
            <span className={styles.testResult} data-success={testResult.success}>
              {testResult.success ? t('mcp.testPass') : t('mcp.testFail')}
            </span>
          )}
          <button
            className={styles.actionBtn}
            onClick={handleTest}
            disabled={testing}
            title={t('mcp.testConnection')}
          >
            <TestTube size={14} />
          </button>
          {isConnected ? (
            <button
              className={styles.actionBtn}
              onClick={handleDisconnect}
              disabled={connecting}
              title={t('mcp.disconnect')}
            >
              <Unplug size={14} />
            </button>
          ) : (
            <button
              className={styles.actionBtn}
              onClick={handleConnect}
              disabled={connecting}
              title={t('mcp.connect')}
            >
              <PlugZap size={14} />
            </button>
          )}
          <button
            className={styles.actionBtn}
            onClick={() => setEditing(true)}
            title={tc('actions.edit')}
          >
            <Pencil size={14} />
          </button>
          <button
            className={styles.actionBtn}
            onClick={onDelete}
            title={tc('actions.delete')}
            data-danger
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {server.last_error && !isConnected && (
        <div className={styles.error}>{server.last_error}</div>
      )}

      {isConnected && hasTools && (
        <div className={styles.toolsSection}>
          <button
            className={styles.toolsToggle}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {t('mcp.discoveredTools')}
          </button>
          {expanded && (
            <div className={styles.toolsList}>
              {status!.tools.map((tool) => (
                <div key={tool.name} className={styles.toolItem}>
                  <span className={styles.toolName}>{tool.name}</span>
                  {tool.description && (
                    <span className={styles.toolDesc}>{tool.description}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
