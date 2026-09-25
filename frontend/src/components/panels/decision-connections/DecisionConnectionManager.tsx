import { useEffect, useRef, useState } from 'react'
import { Plus, Check, Copy, Trash2, Edit3, Zap, MoreVertical } from 'lucide-react'
import { FormField, TextInput, Select, Button } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import { decisionsApi, type DecisionConnection, type DecisionConnectionInput, type DecisionProviderInfo } from '@/api/decisions'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import ContextMenu, { type ContextMenuEntry, type ContextMenuPos } from '@/components/shared/ContextMenu'
import ProviderIcon from '@/components/shared/ProviderIcon'
import ModelCombobox from '../connection-manager/ModelCombobox'
import styles from '../ConnectionManager.module.css'
import itemStyles from '../connection-manager/ConnectionItem.module.css'

function DecisionForm({ profile, providers, onSave, onCancel }: {
  profile?: DecisionConnection
  providers: DecisionProviderInfo[]
  onSave: (input: DecisionConnectionInput) => Promise<void>
  onCancel: () => void
}) {
  const initialProvider = profile?.provider ?? providers[0]?.id ?? 'jev'
  const initialGateway = profile?.gateway ?? providers.find((entry) => entry.id === initialProvider)?.presets[0]?.id ?? 'custom'
  const [name, setName] = useState(profile?.name ?? '')
  const [provider, setProvider] = useState(initialProvider)
  const [gateway, setGateway] = useState(initialGateway)
  const [protocol, setProtocol] = useState(profile?.protocol ?? providers.find((entry) => entry.id === initialProvider)?.presets.find((entry) => entry.id === initialGateway)?.protocol ?? '')
  const [apiUrl, setApiUrl] = useState(profile?.api_url ?? '')
  const [model, setModel] = useState(profile?.model ?? '')
  const [accountId, setAccountId] = useState(profile?.account_id ?? '')
  const [apiKey, setApiKey] = useState('')
  const [isDefault, setIsDefault] = useState(profile?.is_default ?? false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [modelLabels, setModelLabels] = useState<Record<string, string>>({})
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const modelRequestId = useRef(0)
  const providerInfo = providers.find((entry) => entry.id === provider)
  const presets = providerInfo?.presets ?? []
  const protocols = providerInfo?.protocols ?? []
  const preset = presets.find((entry) => entry.id === gateway)
  const providerOptions = providers.flatMap((entry) => [
    ...entry.presets.map((option) => ({ value: `${entry.id}:${option.id}`, label: providers.length === 1 ? option.name : `${entry.name} · ${option.name}`, providerId: entry.id, gatewayId: option.id })),
    { value: `${entry.id}:custom`, label: providers.length === 1 ? 'Custom' : `${entry.name} · Custom`, providerId: entry.id, gatewayId: 'custom' },
  ])

  useEffect(() => {
    modelRequestId.current += 1
    setModels([])
    setModelLabels({})
    setModelsError('')
    setModelsLoading(false)
  }, [provider, gateway, protocol, apiUrl, accountId, apiKey])

  function selectProvider(value: string) {
    const selected = providerOptions.find((entry) => entry.value === value)
    if (!selected) return
    setProvider(selected.providerId)
    setGateway(selected.gatewayId)
    setProtocol(providers.find((entry) => entry.id === selected.providerId)?.presets.find((entry) => entry.id === selected.gatewayId)?.protocol ?? '')
    setApiUrl('')
    setModel('')
    setAccountId('')
  }

  async function refreshModels() {
    const requestId = ++modelRequestId.current
    setModelsLoading(true)
    setModelsError('')
    try {
      const result = await decisionsApi.previewModels({
        connection_id: profile?.id,
        provider,
        gateway,
        protocol: gateway === 'custom' ? protocol : undefined,
        api_url: apiUrl.trim() || undefined,
        account_id: accountId.trim() || undefined,
        api_key: apiKey.trim() || undefined,
      })
      if (requestId === modelRequestId.current) {
        setModels(result.models)
        setModelLabels(result.model_labels)
      }
    } catch (cause) {
      if (requestId === modelRequestId.current) setModelsError(cause instanceof Error ? cause.message : 'Could not load models')
    } finally {
      if (requestId === modelRequestId.current) setModelsLoading(false)
    }
  }

  async function save() {
    setSaving(true)
    setError('')
    try {
      await onSave({ name: name.trim(), provider, gateway, protocol: gateway === 'custom' ? protocol : undefined,
        api_url: apiUrl.trim() || preset?.url, model: model.trim() || preset?.model,
        account_id: accountId.trim(), is_default: isDefault, ...(apiKey ? { api_key: apiKey } : {}) })
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save connection') }
    finally { setSaving(false) }
  }

  return <div className={styles.form}>
    <FormField label="Connection name" required><TextInput value={name} onChange={setName} placeholder="Connection name" autoFocus={!profile} /></FormField>
    <FormField label="Provider" required><Select value={`${provider}:${gateway}`} onChange={selectProvider} options={providerOptions} /></FormField>
    <FormField label="API key" hint={profile?.has_api_key ? 'A key is already saved. Leave blank to keep it.' : undefined}><TextInput value={apiKey} onChange={setApiKey} type="password" placeholder={profile?.has_api_key ? '••••••••' : 'Enter API key'} /></FormField>
    {gateway === 'custom' && <FormField label="API protocol" required><Select value={protocol} onChange={setProtocol} options={[{ value: '', label: 'Choose a protocol' }, ...protocols.map((value) => ({ value, label: presets.find((entry) => entry.protocol === value)?.name ?? value }))]} /></FormField>}
    <FormField label="API URL" required={gateway === 'custom'} hint={gateway === 'custom' ? 'Full decision API endpoint' : 'Leave blank to use the provider endpoint.'}><TextInput value={apiUrl} onChange={setApiUrl} placeholder={preset?.url ?? 'https://…'} /></FormField>
    {protocol === 'cloudflare' && <FormField label="Cloudflare account ID" required><TextInput value={accountId} onChange={setAccountId} /></FormField>}
    <FormField label="Model" required={gateway === 'custom'} hint={gateway === 'custom' ? undefined : 'Leave blank to use the provider model.'}>
      <ModelCombobox value={model} onChange={setModel} models={models} modelLabels={modelLabels} loading={modelsLoading} onRefresh={() => { void refreshModels() }} placeholder={preset?.model ?? 'Model ID'} disabled={gateway === 'custom' && !protocol} autoRefreshOnFocus showAllOnFocus refreshKey={`${provider}:${gateway}:${protocol}:${apiUrl}:${accountId}:${apiKey}`} appearance="standard" />
    </FormField>
    {modelsError && <div role="alert">{modelsError}</div>}
    <FormField label=""><Toggle.Checkbox checked={isDefault} onChange={setIsDefault} disabled={profile?.is_default} label="Set as default" /></FormField>
    {error && <div role="alert">{error}</div>}
    <div className={styles.formActions}><Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button><Button variant="primary" size="sm" onClick={save} disabled={saving || !name.trim() || (!apiKey && !profile?.has_api_key) || (gateway === 'custom' && (!protocol || !apiUrl.trim() || !model.trim())) || (protocol === 'cloudflare' && !accountId.trim())}>{saving ? 'Saving…' : profile ? 'Save' : 'Create'}</Button></div>
  </div>
}

export default function DecisionConnectionManager() {
  const [connections, setConnections] = useState<DecisionConnection[]>([])
  const [providers, setProviders] = useState<DecisionProviderInfo[]>([])
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [deleting, setDeleting] = useState<DecisionConnection | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [message, setMessage] = useState<Record<string, { success: boolean; text: string }>>({})
  const [menu, setMenu] = useState<{ id: string; position: ContextMenuPos } | null>(null)
  const [error, setError] = useState('')

  async function refresh() {
    const response = await decisionsApi.list()
    setConnections(response.data)
  }
  useEffect(() => {
    void Promise.all([decisionsApi.presets(), decisionsApi.list()]).then(([catalog, result]) => {
      setProviders(catalog.providers); setConnections(result.data)
    }).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load decision connections'))
  }, [])
  useEffect(() => {
    const timers = Object.entries(message).map(([id, result]) => window.setTimeout(() => {
      setMessage((current) => {
        if (current[id] !== result) return current
        const next = { ...current }
        delete next[id]
        return next
      })
    }, 5000))
    return () => timers.forEach(window.clearTimeout)
  }, [message])

  async function save(input: DecisionConnectionInput) {
    if (editing && editing !== 'new') await decisionsApi.update(editing, input)
    else await decisionsApi.create(input)
    setEditing(null)
    await refresh()
  }
  async function action(work: () => Promise<unknown>) {
    try { setError(''); await work(); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Connection action failed') }
  }
  async function test(id: string) {
    setTesting(id)
    setMessage((current) => { const next = { ...current }; delete next[id]; return next })
    try { const result = await decisionsApi.test(id); setMessage((current) => ({ ...current, [id]: { success: result.success, text: result.message } })) }
    catch (cause) { setMessage((current) => ({ ...current, [id]: { success: false, text: cause instanceof Error ? cause.message : 'Test failed' } })) }
    finally { setTesting(null) }
  }

  return <div className={styles.manager}>
    {editing !== 'new' && <button type="button" className={styles.createBtn} disabled={!providers.length} onClick={() => setEditing('new')}><Plus size={14} /><span>New Decision Connection</span></button>}
    {editing === 'new' && <DecisionForm providers={providers} onSave={save} onCancel={() => setEditing(null)} />}
    {error && <div role="alert">{error}</div>}
    <div className={styles.list}>{connections.map((connection) => <div className={itemStyles.item} key={connection.id}>
      {editing === connection.id ? <DecisionForm profile={connection} providers={providers} onSave={save} onCancel={() => setEditing(null)} /> : <>
        <div className={itemStyles.itemRow}>
          <button type="button" className={itemStyles.itemBtn} onClick={() => { if (!connection.is_default) void action(() => decisionsApi.setDefault(connection.id)) }} title={connection.is_default ? 'Default connection' : 'Set as default'}>
            <ProviderIcon kind="llm" provider={connection.gateway} size={32} iconSize={16} className={itemStyles.itemIcon} />
            <span className={itemStyles.itemInfo}>
              <span className={itemStyles.itemName}>{connection.name}</span>
              <span className={itemStyles.itemMeta}>{connection.model}</span>
            </span>
          </button>
          <div className={itemStyles.itemActions}>
            <button type="button" className={itemStyles.actionBtn} onClick={() => setEditing(connection.id)} title="Edit connection" aria-label="Edit connection"><Edit3 size={13} /></button>
            <button type="button" className={itemStyles.actionBtn} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ id: connection.id, position: { x: rect.right, y: rect.bottom + 4 } }) }} title="More actions" aria-label="More actions"><MoreVertical size={13} /></button>
            <ContextMenu position={menu?.id === connection.id ? menu.position : null} onClose={() => setMenu(null)} items={[
              { key: 'test', label: testing === connection.id ? 'Testing…' : 'Test connection', icon: <Zap size={14} />, disabled: testing === connection.id, onClick: () => { setMenu(null); void test(connection.id) } },
              ...(!connection.is_default ? [{ key: 'default', label: 'Set as default', icon: <Check size={14} />, onClick: () => { setMenu(null); void action(() => decisionsApi.setDefault(connection.id)) } }] : []),
              { key: 'duplicate', label: 'Duplicate', icon: <Copy size={14} />, onClick: () => { setMenu(null); void action(() => decisionsApi.duplicate(connection.id)) } },
              { key: 'divider', type: 'divider' as const },
              { key: 'delete', label: 'Delete', icon: <Trash2 size={14} />, danger: true, onClick: () => { setMenu(null); setDeleting(connection) } },
            ] satisfies ContextMenuEntry[]} />
          </div>
        </div>
        {message[connection.id] && <div className={`${itemStyles.testMessage} ${message[connection.id].success ? itemStyles.testMessageSuccess : itemStyles.testMessageFail}`} role="status">{message[connection.id].text}</div>}
      </>}
    </div>)}</div>
    {!connections.length && editing !== 'new' && <div className={styles.empty}>No connections configured.</div>}
    {deleting && <ConfirmationModal isOpen title="Delete Connection" message={`Delete ${deleting.name}?`} variant="danger" confirmText="Delete" onConfirm={() => { const id = deleting.id; setDeleting(null); void action(() => decisionsApi.delete(id)) }} onCancel={() => setDeleting(null)} />}
  </div>
}
