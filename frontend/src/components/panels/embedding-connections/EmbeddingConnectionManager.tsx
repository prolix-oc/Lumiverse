import ConnectionCollection from '../connection-manager/ConnectionCollection'
import { useConnectionLibrary, saveConnectionFolder } from '@/hooks/useConnectionLibrary'
import { reorderProfiles } from '@/store/slices/connections-order-merge'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { buildEmbeddingConfigUpdate, embeddingsApi, type EmbeddingConfigWithProfiles, type EmbeddingConnectionProfile, type EmbeddingDriverOption } from '@/api/embeddings'
import EmbeddingConnectionForm, { type EmbeddingConnectionDraft } from './EmbeddingConnectionForm'
import EmbeddingConnectionItem from './EmbeddingConnectionItem'
import styles from '../ConnectionManager.module.css'

export const EMBEDDING_CONNECTIONS_CHANGED_EVENT = 'lumiverse:embedding-connections-changed'

export default function EmbeddingConnectionManager() {
  const { t } = useTranslation('panels')
  const library = useConnectionLibrary('embedding')
  const [config, setConfig] = useState<EmbeddingConfigWithProfiles | null>(null)
  const [providers, setProviders] = useState<EmbeddingDriverOption[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<EmbeddingConnectionProfile | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [nextConfig, providerResult] = await Promise.all([
        embeddingsApi.getConfig(),
        embeddingsApi.providers(),
      ])
      setConfig(nextConfig)
      setProviders(providerResult.providers)
    } catch (err: any) {
      setError(err?.message || 'Failed to load embedding connections')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const persist = async (next: EmbeddingConfigWithProfiles, apiKeys: Record<string, string | undefined> = {}) => {
    setError(null)
    try {
      const saved = await embeddingsApi.updateConfig(buildEmbeddingConfigUpdate(next, apiKeys))
      setConfig(saved)
      window.dispatchEvent(new CustomEvent(EMBEDDING_CONNECTIONS_CHANGED_EVENT))
      return true
    } catch (err: any) {
      setError(err?.body?.error || err?.message || 'Failed to save embedding connection')
      return false
    }
  }

  const create = async (draft: EmbeddingConnectionDraft, folderId = '') => {
    if (!config) return
    const { api_key, ...profile } = draft
    const connectionProfiles = [...(config.connectionProfiles ?? []), profile]
    const firstProfile = connectionProfiles[0]
    const next = {
      ...config,
      connectionProfiles,
      primaryProfileId: config.primaryProfileId || profile.id,
      ...(config.primaryProfileId ? {} : {
        provider: firstProfile.provider as any,
        model: firstProfile.model,
        api_url: firstProfile.api_url,
        dimensions: firstProfile.dimensions,
      }),
    }
    if (await persist(next, { [profile.id]: api_key })) {
      saveConnectionFolder('embedding', profile.id, folderId)
      setCreating(false)
    }
  }

  const update = async (draft: EmbeddingConnectionDraft) => {
    if (!config) return false
    const { api_key, ...profile } = draft
    const connectionProfiles = (config.connectionProfiles ?? []).map((entry) => entry.id === profile.id ? profile : entry)
    const primary = connectionProfiles.find((entry) => entry.id === config.primaryProfileId)
    return persist({
      ...config,
      connectionProfiles,
      ...(primary ? {
        provider: primary.provider as any,
        model: primary.model,
        api_url: primary.api_url,
        dimensions: primary.dimensions,
      } : {}),
    }, { [profile.id]: api_key })
  }

  const remove = async () => {
    if (!config || !deleteTarget) return
    const connectionProfiles = (config.connectionProfiles ?? []).filter((entry) => entry.id !== deleteTarget.id)
    const fallbackProfileIds = (config.fallbackProfileIds ?? []).filter((id) => id !== deleteTarget.id)
    const primaryProfileId = config.primaryProfileId === deleteTarget.id
      ? connectionProfiles[0]?.id ?? null
      : config.primaryProfileId
    const primary = connectionProfiles.find((entry) => entry.id === primaryProfileId)
    const saved = await persist({
      ...config,
      connectionProfiles,
      primaryProfileId,
      fallbackProfileIds,
      ...(primary ? {
        provider: primary.provider as any,
        model: primary.model,
        api_url: primary.api_url,
        dimensions: primary.dimensions,
      } : {}),
    })
    if (saved) {
      library.forget(deleteTarget.id)
      setDeleteTarget(null)
    }
  }

  const orderedProfiles = reorderProfiles(config?.connectionProfiles ?? [], library.library.profileOrder)

  if (loading) return <div className={styles.loading}>Loading embedding connections…</div>
  if (!config) return <div className={styles.empty}>{error || 'Embedding connections are unavailable.'}</div>

  const inherited = !!config.inherited

  return (
    <div className={styles.manager}>
      {inherited && <div className={styles.bindingCardHint}>Embedding connections are managed by the server owner.</div>}
      {error && <div className={styles.bindingCardHint} style={{ color: 'var(--lumiverse-error)' }}>{error}</div>}
      <ConnectionCollection kind="embedding" profiles={orderedProfiles} onReorder={library.reorderProfiles}
        actions={!creating && !inherited && (
          <button type="button" className={styles.createBtn} onClick={() => setCreating(true)}>
            <Plus size={14} />
            <span>New Embedding Connection</span>
          </button>
        )}
        editor={creating && (
          <EmbeddingConnectionForm providers={providers} onSave={create} onCancel={() => setCreating(false)} />
        )}
        emptyMessage={creating ? '' : t('connections.noMatches')}
        renderProfile={(profile, placement) => <EmbeddingConnectionItem
                placement={placement}
          profile={profile} providers={providers} onUpdate={update}
          onDelete={() => setDeleteTarget(profile)} disabled={inherited}
        />} />

      {deleteTarget && (
        <ConfirmationModal
          title="Delete Embedding Connection"
          message={`Delete “${deleteTarget.name || deleteTarget.provider}”? This cannot be undone.`}
          isOpen
          variant="danger"
          confirmText="Delete"
          onConfirm={remove}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
