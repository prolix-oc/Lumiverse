import { useState } from 'react'
import { FormField, TextInput, Select, Button } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import type { CreateMcpServerInput } from '@/api/mcp-servers'
import styles from '../../panels/ConnectionManager.module.css'
import formStyles from './McpServerForm.module.css'

const TRANSPORT_OPTIONS = [
  { value: 'streamable_http', label: 'Streamable HTTP' },
  { value: 'sse', label: 'SSE (Legacy)' },
  { value: 'stdio', label: 'Stdio (Subprocess)' },
]

interface HeaderRow {
  key: string
  value: string
}

interface McpServerFormProps {
  initial?: Partial<CreateMcpServerInput> & { initialHeaders?: HeaderRow[] }
  onSave: (input: CreateMcpServerInput) => void
  onCancel: () => void
}

export default function McpServerForm({ initial, onSave, onCancel }: McpServerFormProps) {
  const [name, setName] = useState(initial?.name || '')
  const [transportType, setTransportType] = useState<string>(initial?.transport_type || 'streamable_http')
  const [url, setUrl] = useState(initial?.url || '')
  const [command, setCommand] = useState(initial?.command || '')
  const [args, setArgs] = useState(initial?.args?.join(', ') || '')
  const [headers, setHeaders] = useState<HeaderRow[]>(initial?.initialHeaders || [{ key: '', value: '' }])
  const [envVars, setEnvVars] = useState<HeaderRow[]>(
    initial?.env
      ? Object.entries(initial.env).map(([key, value]) => ({ key, value }))
      : [{ key: '', value: '' }]
  )
  const [autoConnect, setAutoConnect] = useState(initial?.auto_connect !== false)
  const [enabled, setEnabled] = useState(initial?.is_enabled !== false)

  const isHttp = transportType === 'streamable_http' || transportType === 'sse'
  const isStdio = transportType === 'stdio'

  const handleSubmit = () => {
    if (!name.trim()) return

    const input: CreateMcpServerInput = {
      name: name.trim(),
      transport_type: transportType as any,
      auto_connect: autoConnect,
      is_enabled: enabled,
    }

    if (isHttp) {
      input.url = url.trim()
      const validHeaders = headers.filter((h) => h.key.trim() && h.value.trim())
      if (validHeaders.length > 0) {
        input.headers = Object.fromEntries(validHeaders.map((h) => [h.key.trim(), h.value.trim()]))
      }
    }

    if (isStdio) {
      input.command = command.trim()
      input.args = args
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean)
      const validEnv = envVars.filter((e) => e.key.trim() && e.value.trim())
      if (validEnv.length > 0) {
        input.env = Object.fromEntries(validEnv.map((e) => [e.key.trim(), e.value.trim()]))
      }
    }

    onSave(input)
  }

  const addHeaderRow = () => setHeaders([...headers, { key: '', value: '' }])
  const removeHeaderRow = (idx: number) => setHeaders(headers.filter((_, i) => i !== idx))
  const updateHeader = (idx: number, field: 'key' | 'value', val: string) => {
    const next = [...headers]
    next[idx] = { ...next[idx], [field]: val }
    setHeaders(next)
  }

  const addEnvRow = () => setEnvVars([...envVars, { key: '', value: '' }])
  const removeEnvRow = (idx: number) => setEnvVars(envVars.filter((_, i) => i !== idx))
  const updateEnvVar = (idx: number, field: 'key' | 'value', val: string) => {
    const next = [...envVars]
    next[idx] = { ...next[idx], [field]: val }
    setEnvVars(next)
  }

  return (
    <div className={styles.form}>
      <FormField label="Name">
        <TextInput
          value={name}
          onChange={setName}
          placeholder="My MCP Server"
        />
      </FormField>

      <FormField label="Transport">
        <Select value={transportType} onChange={setTransportType} options={TRANSPORT_OPTIONS} />
      </FormField>

      {isHttp && (
        <>
          <FormField label="URL" hint="The MCP server endpoint URL">
            <TextInput
              value={url}
              onChange={setUrl}
              placeholder="https://example.com/mcp"
            />
          </FormField>

          <FormField label="Headers" hint="Custom headers (API keys, auth tokens). Values are stored encrypted.">
            <div className={formStyles.kvList}>
              {headers.map((row, idx) => (
                <div key={idx} className={formStyles.kvRow}>
                  <TextInput
                    value={row.key}
                    onChange={(value) => updateHeader(idx, 'key', value)}
                    placeholder="Header name"
                  />
                  <TextInput
                    type="password"
                    value={row.value}
                    onChange={(value) => updateHeader(idx, 'value', value)}
                    placeholder="Value"
                  />
                  <button
                    className={formStyles.kvRemove}
                    onClick={() => removeHeaderRow(idx)}
                    type="button"
                  >
                    &times;
                  </button>
                </div>
              ))}
              <button className={formStyles.kvAdd} onClick={addHeaderRow} type="button">
                + Add header
              </button>
            </div>
          </FormField>
        </>
      )}

      {isStdio && (
        <>
          <FormField label="Command" hint="The executable to run (e.g. node, python3, npx)">
            <TextInput
              value={command}
              onChange={setCommand}
              placeholder="npx"
            />
          </FormField>

          <FormField label="Arguments" hint="Comma-separated command arguments">
            <TextInput
              value={args}
              onChange={setArgs}
              placeholder="-y, @modelcontextprotocol/server-filesystem, /path"
            />
          </FormField>

          <FormField label="Environment Variables" hint="Env vars passed to the subprocess. Values are stored encrypted.">
            <div className={formStyles.kvList}>
              {envVars.map((row, idx) => (
                <div key={idx} className={formStyles.kvRow}>
                  <TextInput
                    value={row.key}
                    onChange={(value) => updateEnvVar(idx, 'key', value)}
                    placeholder="Variable name"
                  />
                  <TextInput
                    type="password"
                    value={row.value}
                    onChange={(value) => updateEnvVar(idx, 'value', value)}
                    placeholder="Value"
                  />
                  <button
                    className={formStyles.kvRemove}
                    onClick={() => removeEnvRow(idx)}
                    type="button"
                  >
                    &times;
                  </button>
                </div>
              ))}
              <button className={formStyles.kvAdd} onClick={addEnvRow} type="button">
                + Add variable
              </button>
            </div>
          </FormField>
        </>
      )}

      <Toggle.Checkbox
        checked={autoConnect}
        onChange={setAutoConnect}
        label="Auto-connect on startup"
      />

      <Toggle.Checkbox
        checked={enabled}
        onChange={setEnabled}
        label="Enabled"
      />

      <div className={styles.formActions}>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button onClick={handleSubmit} disabled={!name.trim()}>Save</Button>
      </div>
    </div>
  )
}
