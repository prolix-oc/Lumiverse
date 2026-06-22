import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Copy, KeyRound, Link2, Pencil, Trash2, Unlink } from 'lucide-react'
import { Button } from '@/components/shared/FormComponents'
import { useStore } from '@/store'
import { ssoProvidersApi, type SsoDiscoveryResult, type SsoLinksResponse, type SsoProvider, type SsoProviderInput, type SsoProviderKind } from '@/api/sso-providers'
import { startSsoPopup } from '@/lib/ssoPopup'
import styles from './SsoProviderSettings.module.css'

type FormState = Omit<SsoProviderInput, 'scopes'> & { scopesText: string }

const PROVIDER_HINTS: Array<{ kind: SsoProviderKind; name: string; hint: string }> = [
  { kind: 'authelia', name: 'Authelia', hint: 'Create an OpenID Connect client and register the Lumiverse redirect URI.' },
  { kind: 'authentik', name: 'authentik', hint: 'Create an OAuth2/OpenID Provider, copy the client credentials, and use the issuer URL.' },
  { kind: 'keycloak', name: 'Keycloak', hint: 'Create a confidential client in your realm and use the realm issuer URL.' },
]

const KIND_LABEL: Record<SsoProviderKind, string> = {
  authelia: 'Authelia',
  authentik: 'authentik',
  keycloak: 'Keycloak',
  custom_oidc: 'Custom OIDC',
}

function emptyForm(): FormState {
  return {
    provider_kind: 'authelia',
    name: 'Authelia',
    slug: 'authelia',
    enabled: false,
    issuer_url: '',
    discovery_url: '',
    redirect_origin: window.location.origin,
    client_id: '',
    client_secret: '',
    scopesText: 'openid profile email',
    pkce: true,
    allow_signup: false,
    metadata: {},
  }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

function formFromProvider(provider: SsoProvider): FormState {
  const redirectOrigin = typeof provider.metadata.redirect_origin === 'string'
    ? provider.metadata.redirect_origin
    : window.location.origin
  return {
    provider_kind: provider.provider_kind,
    name: provider.name,
    slug: provider.slug,
    enabled: provider.enabled,
    issuer_url: provider.issuer_url,
    discovery_url: provider.discovery_url,
    redirect_origin: redirectOrigin,
    client_id: provider.client_id,
    client_secret: '',
    scopesText: provider.scopes.join(' '),
    pkce: provider.pkce,
    allow_signup: provider.allow_signup,
    metadata: provider.metadata,
  }
}

function toInput(form: FormState): SsoProviderInput {
  return {
    provider_kind: form.provider_kind,
    name: form.name.trim(),
    slug: form.slug.trim(),
    enabled: form.enabled,
    issuer_url: form.issuer_url.trim(),
    discovery_url: form.discovery_url.trim() || undefined,
    redirect_origin: form.redirect_origin?.trim() || undefined,
    client_id: form.client_id.trim(),
    client_secret: form.client_secret?.trim() || undefined,
    scopes: form.scopesText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    pkce: form.pkce,
    allow_signup: form.allow_signup,
    metadata: form.metadata,
  }
}

export default function SsoProviderSettings() {
  const currentUser = useStore((s) => s.user)
  const [providers, setProviders] = useState<SsoProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<FormState>(() => emptyForm())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [discovery, setDiscovery] = useState<SsoDiscoveryResult | null>(null)
  const [links, setLinks] = useState<SsoLinksResponse | null>(null)

  const isOwner = currentUser?.role === 'owner'
  const previewRedirectUri = useMemo(() => `${(form.redirect_origin || window.location.origin).replace(/\/$/, '')}/api/auth/oauth2/callback/${form.slug || '<slug>'}`, [form.redirect_origin, form.slug])

  async function load() {
    setLoading(true)
    try {
      const [nextProviders, nextLinks] = await Promise.all([
        ssoProvidersApi.list(),
        ssoProvidersApi.links(),
      ])
      setProviders(nextProviders)
      setLinks(nextLinks)
    } catch (err: any) {
      setError(err.body?.error || err.message || 'Failed to load SSO providers')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (isOwner) load()
  }, [isOwner])

  function clearMessages() {
    setError(null)
    setSuccess(null)
    setDiscovery(null)
  }

  function beginCreate(kind: SsoProviderKind = 'authelia') {
    const label = KIND_LABEL[kind]
    setEditingId(null)
    setForm({ ...emptyForm(), provider_kind: kind, name: label, slug: slugify(label) })
    setShowForm(true)
    clearMessages()
  }

  function beginEdit(provider: SsoProvider) {
    setEditingId(provider.id)
    setForm(formFromProvider(provider))
    setShowForm(true)
    clearMessages()
  }

  async function saveProvider(e: React.FormEvent) {
    e.preventDefault()
    clearMessages()
    const input = toInput(form)
    if (!editingId && !input.client_secret) {
      setError('Client secret is required for new providers.')
      return
    }
    setBusy('save')
    try {
      if (editingId) {
        await ssoProvidersApi.update(editingId, input)
      } else {
        await ssoProvidersApi.create(input)
      }
      setSuccess('Provider saved. Restart Lumiverse before using it for sign-in.')
      setShowForm(false)
      setEditingId(null)
      setForm(emptyForm())
      await load()
    } catch (err: any) {
      setError(err.body?.error || err.message || 'Failed to save provider')
    } finally {
      setBusy(null)
    }
  }

  async function testDiscovery() {
    clearMessages()
    setBusy('test')
    try {
      const result = await ssoProvidersApi.testDiscovery({ issuer_url: form.issuer_url, discovery_url: form.discovery_url || undefined })
      setDiscovery(result)
      if (result.ok) setSuccess(`Discovery succeeded: ${result.issuer || 'issuer found'}`)
      else setError(result.error || 'Discovery failed')
    } catch (err: any) {
      setError(err.body?.error || err.message || 'Discovery failed')
    } finally {
      setBusy(null)
    }
  }

  async function deleteProvider(provider: SsoProvider) {
    if (!window.confirm(`Delete SSO provider "${provider.name}"?`)) return
    clearMessages()
    setBusy(provider.id)
    try {
      await ssoProvidersApi.delete(provider.id)
      setSuccess('Provider deleted. Restart Lumiverse to remove it from active auth routes.')
      await load()
    } catch (err: any) {
      setError(err.body?.error || err.message || 'Failed to delete provider')
    } finally {
      setBusy(null)
    }
  }

  async function linkProvider(provider: SsoProvider) {
    clearMessages()
    setBusy(`link:${provider.slug}`)
    try {
      const result = await startSsoPopup({ providerId: provider.slug, flow: 'link', returnTo: '/' })
      if (!result.ok) throw new Error(result.error || 'SSO linking failed')
      setSuccess(`${provider.name} linked to your account.`)
      await load()
      setBusy(null)
    } catch (err: any) {
      setError(err.message || `Failed to start ${provider.name} linking`)
      setBusy(null)
    }
  }

  async function unlinkProvider(providerId: string) {
    if (!window.confirm('Unlink this SSO identity from your current owner account?')) return
    clearMessages()
    setBusy(`unlink:${providerId}`)
    try {
      await ssoProvidersApi.unlinkCurrentUser(providerId)
      setSuccess('SSO identity unlinked from your account.')
      await load()
    } catch (err: any) {
      setError(err.body?.error || err.message || 'Failed to unlink SSO identity')
    } finally {
      setBusy(null)
    }
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text)
    setSuccess('Copied to clipboard')
  }

  if (!isOwner) return <div className={styles.container}>Owner access is required to configure SSO providers.</div>

  return (
    <div className={styles.container}>
      <div className={styles.intro}>
        <h3 className={styles.introTitle}>Single Sign-On</h3>
        <p className={styles.introText}>
          Configure OpenID Connect providers for instance-level sign-in. Start with issuer discovery, a confidential client, and scopes <span className={styles.mono}>openid profile email</span>.
        </p>
      </div>

      <div className={styles.notice}>
        <AlertTriangle size={16} />
        <span>Safe mode is enforced: SSO cannot create users or auto-link by matching email. Sign in locally as owner, link your IdP identity here, then restart after provider changes.</span>
      </div>

      <section className={styles.section}>
        <div className={styles.header}>
          <h3 className={styles.title}>Owner Recovery</h3>
          <span className={`${styles.badge} ${links?.recovery.can_recover ? styles.badgeEnabled : ''}`}>
            {links?.recovery.can_recover ? 'Recovery OK' : 'Recovery Risk'}
          </span>
        </div>
        <div className={styles.providerRow}>
          <div className={styles.rowMain}>
            <div className={styles.rowTitle}>Current owner links</div>
            <div className={styles.rowMeta}>
              <span>Local owner password accounts: {links?.recovery.owner_credential_count ?? 0}</span>
              <span>Enabled SSO links for owners: {links?.recovery.owner_sso_link_count ?? 0}</span>
              <span>Keep at least one local owner password as break-glass access.</span>
            </div>
          </div>
        </div>
      </section>

      {!showForm && error && <div className={styles.error}>{error}</div>}
      {!showForm && success && <div className={styles.success}>{success}</div>}

      <section className={styles.section}>
        <div className={styles.header}>
          <h3 className={styles.title}>Provider Templates</h3>
          <Button variant="primary" size="sm" onClick={() => beginCreate()}>Add Provider</Button>
        </div>
        <div className={styles.providerGrid}>
          {PROVIDER_HINTS.map((provider) => (
            <button key={provider.kind} type="button" className={styles.providerCard} onClick={() => beginCreate(provider.kind)}>
              <div className={styles.providerName}>{provider.name}</div>
              <div className={styles.providerHint}>{provider.hint}</div>
            </button>
          ))}
        </div>
      </section>

      {showForm && (
        <form className={styles.form} onSubmit={saveProvider}>
          <div className={styles.header}>
            <h3 className={styles.title}>{editingId ? 'Edit Provider' : 'New Provider'}</h3>
            <Button variant="ghost" size="sm" onClick={() => { setShowForm(false); setEditingId(null); setForm(emptyForm()) }}>Cancel</Button>
          </div>

          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span className={styles.label}>Provider</span>
              <select className={styles.select} value={form.provider_kind} onChange={(e) => {
                const kind = e.target.value as SsoProviderKind
                setForm((prev) => ({ ...prev, provider_kind: kind, name: prev.name || KIND_LABEL[kind], slug: prev.slug || slugify(KIND_LABEL[kind]) }))
              }}>
                {Object.entries(KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Name</span>
              <input className={styles.input} value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Slug</span>
              <input className={styles.input} value={form.slug} onChange={(e) => setForm((prev) => ({ ...prev, slug: slugify(e.target.value) }))} />
              <span className={styles.hint}>Used as the BetterAuth provider ID.</span>
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Client ID</span>
              <input className={styles.input} value={form.client_id} onChange={(e) => setForm((prev) => ({ ...prev, client_id: e.target.value }))} />
            </label>
            <label className={`${styles.field} ${styles.fieldWide}`}>
              <span className={styles.label}>Issuer URL</span>
              <input className={styles.input} placeholder="https://auth.example.com" value={form.issuer_url} onChange={(e) => setForm((prev) => ({ ...prev, issuer_url: e.target.value }))} />
              <span className={styles.hint}>Keycloak uses the realm issuer, for example <span className={styles.mono}>https://keycloak.example.com/realms/main</span>.</span>
            </label>
            <label className={`${styles.field} ${styles.fieldWide}`}>
              <span className={styles.label}>Discovery URL</span>
              <input className={styles.input} placeholder="Defaults to issuer + /.well-known/openid-configuration" value={form.discovery_url} onChange={(e) => setForm((prev) => ({ ...prev, discovery_url: e.target.value }))} />
            </label>
            <label className={`${styles.field} ${styles.fieldWide}`}>
              <span className={styles.label}>Public Lumiverse Origin</span>
              <input className={styles.input} placeholder="https://lumiverse.example.com" value={form.redirect_origin || ''} onChange={(e) => setForm((prev) => ({ ...prev, redirect_origin: e.target.value }))} />
              <span className={styles.hint}>This must match how authentik redirects back to Lumiverse. Include scheme and host only, no path.</span>
            </label>
            <label className={`${styles.field} ${styles.fieldWide}`}>
              <span className={styles.label}>Client Secret</span>
              <input className={styles.input} type="password" placeholder={editingId ? 'Leave blank to keep existing secret' : 'Required'} value={form.client_secret || ''} onChange={(e) => setForm((prev) => ({ ...prev, client_secret: e.target.value }))} />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Scopes</span>
              <input className={styles.input} value={form.scopesText} onChange={(e) => setForm((prev) => ({ ...prev, scopesText: e.target.value }))} />
            </label>
            <div className={styles.field}>
              <span className={styles.label}>Redirect URI</span>
              <div className={styles.actions}>
                <span className={`${styles.hint} ${styles.mono}`}>{previewRedirectUri}</span>
                <Button variant="ghost" size="icon-sm" icon={<Copy size={14} />} onClick={() => copy(previewRedirectUri)} />
              </div>
            </div>
          </div>

          <label className={styles.toggleRow}><input type="checkbox" checked={form.enabled} onChange={(e) => setForm((prev) => ({ ...prev, enabled: e.target.checked }))} /> Enabled after restart</label>
          <label className={styles.toggleRow}><input type="checkbox" checked={form.pkce} onChange={(e) => setForm((prev) => ({ ...prev, pkce: e.target.checked }))} /> Use PKCE where supported</label>
          <label className={styles.toggleRow}><input type="checkbox" checked={form.allow_signup} disabled /> Auto-provisioning is disabled in safe mode; create local users first, then link SSO explicitly.</label>

          {discovery?.ok && (
            <div className={styles.success}>Discovery found authorization, token, userinfo, and JWKS metadata for this issuer.</div>
          )}
          {error && <div className={styles.error}>{error}</div>}
          {success && <div className={styles.success}>{success}</div>}

          <div className={styles.actions}>
            <Button variant="secondary" size="sm" onClick={testDiscovery} loading={busy === 'test'} disabled={!form.issuer_url}>Test Discovery</Button>
            <Button type="submit" variant="primary" size="sm" loading={busy === 'save'} disabled={!form.name || !form.slug || !form.issuer_url || !form.client_id}>Save Provider</Button>
          </div>
        </form>
      )}

      <section className={styles.section}>
        <h3 className={styles.title}>Configured Providers</h3>
        {loading ? (
          <div className={styles.empty}>Loading providers...</div>
        ) : providers.length === 0 ? (
          <div className={styles.empty}>No SSO providers configured yet.</div>
        ) : (
          <div className={styles.providerList}>
            {providers.map((provider) => (
              <div key={provider.id} className={styles.providerRow}>
                <div className={styles.rowMain}>
                  <div className={styles.rowTitle}>
                    {provider.name}
                    <span className={styles.badge}>{KIND_LABEL[provider.provider_kind]}</span>
                    <span className={`${styles.badge} ${provider.enabled ? styles.badgeEnabled : ''}`}>{provider.enabled ? 'Enabled' : 'Disabled'}</span>
                    <span className={`${styles.badge} ${provider.active ? styles.badgeEnabled : ''}`}>{provider.active ? 'Active' : 'Restart needed'}</span>
                    {provider.has_client_secret && <KeyRound size={13} />}
                  </div>
                  <div className={styles.rowMeta}>
                    <span className={styles.mono}>{provider.issuer_url}</span>
                    <span>Redirect: <span className={styles.mono}>{provider.redirect_uri || `${window.location.origin}/api/auth/oauth2/callback/${provider.slug}`}</span></span>
                    {provider.active_redirect_uri && provider.active_redirect_uri !== provider.redirect_uri && (
                      <span>Active redirect until restart: <span className={styles.mono}>{provider.active_redirect_uri}</span></span>
                    )}
                    {links?.current_user_links.some((link) => link.provider_id === provider.slug) && <span>Linked to your owner account.</span>}
                  </div>
                </div>
                <div className={styles.rowActions}>
                  {provider.enabled && provider.active && (
                    links?.current_user_links.some((link) => link.provider_id === provider.slug)
                      ? <Button variant="ghost" size="icon-sm" icon={<Unlink size={14} />} loading={busy === `unlink:${provider.slug}`} onClick={() => unlinkProvider(provider.slug)} title="Unlink from my account" />
                      : <Button variant="ghost" size="icon-sm" icon={<Link2 size={14} />} loading={busy === `link:${provider.slug}`} onClick={() => linkProvider(provider)} title="Link to my account" />
                  )}
                  <Button variant="ghost" size="icon-sm" icon={<Copy size={14} />} onClick={() => copy(provider.redirect_uri || `${window.location.origin}/api/auth/oauth2/callback/${provider.slug}`)} title="Copy redirect URI" />
                  <Button variant="ghost" size="icon-sm" icon={<Pencil size={14} />} onClick={() => beginEdit(provider)} title="Edit" />
                  <Button variant="danger-ghost" size="icon-sm" icon={<Trash2 size={14} />} loading={busy === provider.id} onClick={() => deleteProvider(provider)} title="Delete" />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className={styles.section}>
        <h3 className={styles.title}>Linked SSO Accounts</h3>
        {!links?.all_links.length ? (
          <div className={styles.empty}>No users have linked SSO identities yet.</div>
        ) : (
          <div className={styles.providerList}>
            {links.all_links.map((link) => (
              <div key={`${link.user_id}:${link.provider_id}:${link.account_id}`} className={styles.providerRow}>
                <div className={styles.rowMain}>
                  <div className={styles.rowTitle}>
                    {link.username || link.name || link.email || link.user_id}
                    <span className={styles.badge}>{link.role || 'user'}</span>
                    <span className={styles.badge}>{link.provider_name}</span>
                  </div>
                  <div className={styles.rowMeta}>
                    <span>Subject: <span className={styles.mono}>{link.account_id}</span></span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
