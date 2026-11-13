import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, Plus, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { streamDeckApi, type StreamDeckToken } from '@/api/stream-deck'
import { copyTextToClipboard } from '@/lib/clipboard'
import sectionStyles from './SettingsSection.module.css'
import styles from './StreamDeckSettings.module.css'

export default function StreamDeckSettings() {
  const [tokens, setTokens] = useState<StreamDeckToken[]>([])
  const [name, setName] = useState('My Stream Deck')
  const [revealed, setRevealed] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setTokens((await streamDeckApi.list()).data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load integration tokens')
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const create = async () => {
    setBusy(true)
    try {
      const result = await streamDeckApi.create(name)
      setRevealed(result.token)
      setCopied(false)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create token')
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!revealed) return
    try {
      await copyTextToClipboard(revealed)
      setCopied(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not copy token')
    }
  }

  const remove = async (id: string) => {
    setBusy(true)
    try {
      await streamDeckApi.remove(id)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return <div className={styles.container}>
    <h2 className={clsx(sectionStyles.title, styles.title)}>Stream Deck</h2>
    <p className={styles.description}>Create a restricted token for the Lumiverse Stream Deck plugin. Tokens can only read character and recent-chat information.</p>

    <div className={styles.createRow}>
      <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} aria-label="Token name" />
      <button type="button" onClick={create} disabled={busy || !name.trim()}><Plus size={15} /> Create token</button>
    </div>

    {revealed && <div className={styles.reveal}>
      <strong>Copy this token now—it won’t be shown again.</strong>
      <code>{revealed}</code>
      <button type="button" onClick={copy}>{copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy'}</button>
    </div>}

    {error && <p className={styles.error}>{error}</p>}

    <div className={styles.list}>
      {tokens.map((item) => <div className={styles.token} key={item.id}>
        <div><strong>{item.name}</strong><span>{item.token_prefix}… · Created {new Date(item.created_at * 1000).toLocaleDateString()}</span></div>
        <button type="button" className={styles.delete} onClick={() => void remove(item.id)} disabled={busy} aria-label={`Revoke ${item.name}`}><Trash2 size={16} /></button>
      </div>)}
      {!tokens.length && <p className={styles.empty}>No Stream Deck tokens yet.</p>}
    </div>
  </div>
}
