import ConnectionFolderField, { useConnectionFolderDraft } from '@/components/panels/connection-manager/ConnectionFolderField'
import { useEffect, useMemo, useState } from 'react'
import { uuidv4 } from '@/lib/uuid'
import { Button, FormField, Select, TextInput } from '@/components/shared/FormComponents'
import NumericInput from '@/components/shared/NumericInput'
import ModelCombobox from '@/components/panels/connection-manager/ModelCombobox'
import { embeddingsApi, type EmbeddingConnectionProfile, type EmbeddingDriverOption } from '@/api/embeddings'
import styles from '../ConnectionManager.module.css'

export interface EmbeddingConnectionDraft extends EmbeddingConnectionProfile {
  api_key?: string
}

interface Props {
  providers: EmbeddingDriverOption[]
  profile?: EmbeddingConnectionProfile
  onSave: (profile: EmbeddingConnectionDraft, folderId?: string) => void
  onCancel: () => void
}

const DEFAULTS: Record<string, { api_url: string; model: string }> = {
  'openai-compatible': { api_url: 'https://api.openai.com/v1/embeddings', model: 'text-embedding-3-small' },
  openai: { api_url: 'https://api.openai.com/v1/embeddings', model: 'text-embedding-3-small' },
  mistral: { api_url: 'https://api.mistral.ai/v1/embeddings', model: 'mistral-embed' },
  cohere: { api_url: 'https://api.cohere.com/v2/embed', model: 'embed-v4.0' },
  openrouter: { api_url: 'https://openrouter.ai/api/v1/embeddings', model: 'text-embedding-3-small' },
  electronhub: { api_url: 'https://api.electronhub.top/v1/embeddings', model: 'text-embedding-3-small' },
  bananabread: { api_url: 'http://localhost:8008/v1/embeddings', model: 'mixedbread-ai/mxbai-embed-large-v1' },
  nanogpt: { api_url: 'https://nano-gpt.com/api/v1/embeddings', model: 'text-embedding-3-small' },
  'nvidia-nim': { api_url: 'https://integrate.api.nvidia.com/v1/embeddings', model: 'nvidia/nemotron-3-embed-1b' },
  google_vertex: { api_url: 'https://aiplatform.googleapis.com', model: 'gemini-embedding-001' },
}

function displayName(id: string): string {
  return ({
    'openai-compatible': 'OpenAI Compatible',
    openai: 'OpenAI',
    mistral: 'Mistral',
    cohere: 'Cohere',
    openrouter: 'OpenRouter',
    electronhub: 'ElectronHub',
    bananabread: 'BananaBread',
    nanogpt: 'Nano-GPT',
    'nvidia-nim': 'NVIDIA NIM',
    google_vertex: 'Google Vertex AI',
  } as Record<string, string>)[id] ?? id
}

export default function EmbeddingConnectionForm({ providers, profile, onSave, onCancel }: Props) {
  const folder = useConnectionFolderDraft('embedding', profile?.id)
  const initialProvider = profile?.provider || providers[0]?.id || 'openai-compatible'
  const [name, setName] = useState(profile?.name || displayName(initialProvider))
  const [provider, setProvider] = useState(initialProvider)
  const [apiUrl, setApiUrl] = useState(profile?.api_url || DEFAULTS[initialProvider]?.api_url || '')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(profile?.model || DEFAULTS[initialProvider]?.model || '')
  const [dimensions, setDimensions] = useState<number | null>(profile?.dimensions ?? null)
  const [vertexRegion, setVertexRegion] = useState(profile?.vertex_region || 'global')
  const [vertexProject, setVertexProject] = useState(profile?.vertex_project || '')
  const [models, setModels] = useState<string[]>([])
  const [modelLabels, setModelLabels] = useState<Record<string, string>>({})
  const [modelsLoading, setModelsLoading] = useState(false)

  const providerOptions = useMemo(() => providers.map((entry) => ({
    value: entry.id,
    label: entry.name && entry.name !== entry.id ? entry.name : displayName(entry.id),
  })), [providers])

  useEffect(() => {
    setModels([])
    setModelLabels({})
  }, [provider, apiUrl])

  const changeProvider = (next: string) => {
    setProvider(next)
    setApiUrl(DEFAULTS[next]?.api_url || '')
    setModel(DEFAULTS[next]?.model || '')
    if (!profile || name === displayName(provider)) setName(displayName(next))
  }

  const fetchModels = async () => {
    setModelsLoading(true)
    try {
      const result = await embeddingsApi.previewModels({
        ...(profile ? { profile_id: profile.id } : {}),
        provider: provider as any,
        api_url: apiUrl || undefined,
        api_key: apiKey.trim() || undefined,
      })
      setModels(result.models || [])
      setModelLabels(result.model_labels || {})
    } catch {
      setModels([])
      setModelLabels({})
    } finally {
      setModelsLoading(false)
    }
  }

  const submit = () => {
    if (!name.trim() || !model.trim()) return
    onSave({
      id: profile?.id || uuidv4(),
      name: name.trim(),
      provider,
      api_url: apiUrl.trim() || DEFAULTS[provider]?.api_url || '',
      model: model.trim(),
      dimensions,
      enabled: profile?.enabled ?? true,
      ...(provider === 'google_vertex' ? {
        vertex_region: vertexRegion.trim() || 'global',
        vertex_project: vertexProject.trim() || undefined,
      } : {}),
      ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
    }, folder.value)
  }

  return (
    <div className={styles.form}>
      <FormField label="Connection name" required>
        <TextInput value={name} onChange={setName} autoFocus placeholder="My embedding connection" />
      </FormField>
      <ConnectionFolderField kind="embedding" {...folder} />
      <FormField label="Provider" required>
        <Select value={provider} onChange={changeProvider} options={providerOptions} />
      </FormField>
      <FormField label="API key" hint={profile?.hasSecret ? 'A key is already configured. Leave blank to keep it.' : undefined}>
        <TextInput value={apiKey} onChange={setApiKey} type="password" placeholder={profile?.hasSecret ? '••••••••' : 'Enter API key'} />
      </FormField>
      {provider === 'google_vertex' ? (
        <>
          <FormField label="Vertex project">
            <TextInput value={vertexProject} onChange={setVertexProject} placeholder="Google Cloud project ID" />
          </FormField>
          <FormField label="Vertex region">
            <TextInput value={vertexRegion} onChange={setVertexRegion} placeholder="global" />
          </FormField>
        </>
      ) : (
        <FormField label="Embedding endpoint" hint="Use the provider's embeddings endpoint, not its chat-completions endpoint.">
          <TextInput value={apiUrl} onChange={setApiUrl} placeholder="https://…/v1/embeddings" />
        </FormField>
      )}
      <FormField label="Embedding model" required hint="Refresh to browse models exposed by this endpoint.">
        <ModelCombobox
          value={model}
          onChange={setModel}
          models={models}
          modelLabels={modelLabels}
          loading={modelsLoading}
          onRefresh={fetchModels}
          autoRefreshOnFocus
          refreshKey={`${provider}:${profile?.id || apiUrl}`}
          appearance="standard"
          placeholder="Embedding model ID"
          emptyMessage="No embedding models returned"
        />
      </FormField>
      <FormField label="Dimensions" hint="Optional. Leave blank to use the model's native dimensions.">
        <NumericInput value={dimensions} onChange={setDimensions} min={1} integer allowEmpty />
      </FormField>
      <div className={styles.formActions}>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={submit} disabled={!name.trim() || !model.trim()}>
          {profile ? 'Save' : 'Create'}
        </Button>
      </div>
    </div>
  )
}
