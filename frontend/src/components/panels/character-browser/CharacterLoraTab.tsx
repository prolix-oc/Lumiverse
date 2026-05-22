import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, Trash2 } from 'lucide-react'
import { charactersApi, type CharacterLoraBinding } from '@/api/characters'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import { useStore } from '@/store'
import SearchableSelect from '@/components/shared/SearchableSelect'
import { Button } from '@/components/shared/FormComponents'
import styles from './CharacterEditorPage.module.css'

interface CharacterLoraTabProps {
  characterId: string
}

interface LoraOption {
  id: string
  label: string
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

/**
 * Character editor "Image LoRA" tab. Stores the per-character LoRA used by
 * the image-generation pipeline whenever this character is the active chat
 * subject. Lives in a separate settings row server-side (not on the
 * character's extensions), so it owns its own save lifecycle independent of
 * the surrounding editor's autosave.
 *
 * The picker is connection-aware: it pulls available LoRAs from the active
 * image-gen connection (ComfyUI/SwarmUI). Other providers won't return any
 * LoRAs, in which case we surface a helpful message instead of an empty list.
 */
export default function CharacterLoraTab({ characterId }: CharacterLoraTabProps) {
  const imageGenProfiles = useStore((s) => s.imageGenProfiles)
  const activeImageGenConnectionId = useStore((s) => s.activeImageGenConnectionId)

  const activeConnection = useMemo(
    () => imageGenProfiles.find((p) => p.id === activeImageGenConnectionId) ?? null,
    [imageGenProfiles, activeImageGenConnectionId],
  )

  const supportsLoraDiscovery =
    !!activeConnection && (activeConnection.provider === 'comfyui' || activeConnection.provider === 'swarmui')

  const [loras, setLoras] = useState<LoraOption[]>([])
  const [lorasState, setLorasState] = useState<LoadState>('idle')
  const [lorasError, setLorasError] = useState<string | null>(null)

  const [binding, setBinding] = useState<CharacterLoraBinding | null>(null)
  const [loraName, setLoraName] = useState('')
  const [weightModel, setWeightModel] = useState('1')
  const [weightClip, setWeightClip] = useState('1')
  const [baseTags, setBaseTags] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [statusMessage, setStatusMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const lastLoadedCharacterId = useRef<string | null>(null)

  // Load the existing binding when the tab mounts or the character changes.
  useEffect(() => {
    if (lastLoadedCharacterId.current === characterId) return
    lastLoadedCharacterId.current = characterId

    charactersApi
      .getImageGenLora(characterId)
      .then((res) => {
        const b = res.binding
        setBinding(b)
        setLoraName(b?.lora_name ?? '')
        setWeightModel(b ? String(b.weight_model) : '1')
        setWeightClip(b ? String(b.weight_clip) : '1')
        setBaseTags(b?.base_tags ?? '')
        setSourceUrl(b?.source_url ?? '')
      })
      .catch((err) => {
        console.warn('[character-lora] Failed to load binding:', err)
      })
  }, [characterId])

  // Fetch LoRAs from the active image-gen connection. We do this once per
  // connection change; the list can be hundreds of entries so we don't refetch
  // on every focus.
  useEffect(() => {
    if (!supportsLoraDiscovery || !activeConnection) {
      setLoras([])
      setLorasState('idle')
      return
    }

    let cancelled = false
    setLorasState('loading')
    setLorasError(null)
    imageGenConnectionsApi
      .modelsBySubtype(activeConnection.id, 'loras')
      .then((res) => {
        if (cancelled) return
        setLoras(res.models.map((m) => ({ id: m.id, label: m.label })))
        setLorasState('ready')
      })
      .catch((err) => {
        if (cancelled) return
        setLorasError(err?.message || 'Failed to fetch LoRAs')
        setLorasState('error')
      })
    return () => {
      cancelled = true
    }
  }, [supportsLoraDiscovery, activeConnection])

  const handleSave = useCallback(async () => {
    const trimmedName = loraName.trim()
    if (!trimmedName) {
      setStatusMessage({ kind: 'error', text: 'Pick a LoRA before saving.' })
      return
    }
    const wm = Number(weightModel)
    const wc = Number(weightClip)
    if (!Number.isFinite(wm) || !Number.isFinite(wc)) {
      setStatusMessage({ kind: 'error', text: 'Weights must be numbers.' })
      return
    }

    setSaving(true)
    setStatusMessage(null)
    try {
      const res = await charactersApi.setImageGenLora(characterId, {
        lora_name: trimmedName,
        weight_model: wm,
        weight_clip: wc,
        base_tags: baseTags.trim() || undefined,
        source_url: sourceUrl.trim() || undefined,
      })
      setBinding(res.binding)
      setStatusMessage({ kind: 'ok', text: 'Saved.' })
    } catch (err: any) {
      setStatusMessage({ kind: 'error', text: err?.message || 'Save failed.' })
    } finally {
      setSaving(false)
    }
  }, [characterId, loraName, weightModel, weightClip, baseTags, sourceUrl])

  const handleClear = useCallback(async () => {
    setSaving(true)
    setStatusMessage(null)
    try {
      await charactersApi.deleteImageGenLora(characterId)
      setBinding(null)
      setLoraName('')
      setWeightModel('1')
      setWeightClip('1')
      setBaseTags('')
      setSourceUrl('')
      setStatusMessage({ kind: 'ok', text: 'Cleared.' })
    } catch (err: any) {
      setStatusMessage({ kind: 'error', text: err?.message || 'Clear failed.' })
    } finally {
      setSaving(false)
    }
  }, [characterId])

  // Build the dropdown option set. Always include the currently-selected
  // value even if it didn't come back from the connection (e.g. file was
  // moved or the LoRA is from a different connection) so the user can see
  // what's saved without losing it.
  const loraOptions = useMemo(() => {
    const seen = new Set<string>()
    const out: { value: string; label: string; sublabel?: string }[] = []
    for (const lora of loras) {
      if (seen.has(lora.id)) continue
      seen.add(lora.id)
      out.push({ value: lora.id, label: lora.label, sublabel: lora.id })
    }
    if (loraName && !seen.has(loraName)) {
      out.unshift({
        value: loraName,
        label: loraName,
        sublabel: 'Not in current connection — saved value',
      })
    }
    return out
  }, [loras, loraName])

  return (
    <div className={styles.fieldGroup} style={{ gap: 16 }}>
      <div className={styles.fieldGroup}>
        <span className={styles.fieldLabel}>Active image-gen connection</span>
        <span className={styles.fieldHelper}>
          The LoRA list below is pulled from this connection. To change it, switch the active
          connection in the Image Gen panel.
        </span>
        <div className={styles.fieldHelper}>
          {activeConnection
            ? `${activeConnection.name} (${activeConnection.provider})`
            : 'No image-gen connection selected.'}
        </div>
      </div>

      <div className={styles.fieldGroup}>
        <span className={styles.fieldLabel}>LoRA</span>
        <span className={styles.fieldHelper}>
          Spliced into the active ComfyUI workflow's LoraLoader node, or sent as a SwarmUI
          loras/loraweights parameter. Other providers will ignore this field but still see
          the base tags below.
        </span>
        {!supportsLoraDiscovery ? (
          <div className={styles.fieldHelper}>
            LoRA discovery is only available for ComfyUI and SwarmUI connections. You can still
            type a filename manually below.
          </div>
        ) : null}
        {lorasState === 'loading' ? (
          <div className={styles.fieldHelper}>Loading LoRAs…</div>
        ) : null}
        {lorasState === 'error' ? (
          <div className={styles.fieldHelper}>Failed to load LoRAs: {lorasError}</div>
        ) : null}
        <SearchableSelect
          value={loraName}
          onChange={(value) => setLoraName(value)}
          options={loraOptions}
          placeholder="Pick a LoRA…"
          searchPlaceholder="Search LoRAs…"
          emptyMessage={
            lorasState === 'ready' && loraOptions.length === 0
              ? 'No LoRAs found on the active connection'
              : 'No matching LoRAs'
          }
          portal
          minWidth={320}
          clearable
        />
        <input
          type="text"
          className={styles.fieldInput}
          value={loraName}
          onChange={(e) => setLoraName(e.target.value)}
          placeholder="…or type a filename (e.g. aerith_v3.safetensors)"
        />
      </div>

      <div className={styles.fieldGroup}>
        <span className={styles.fieldLabel}>Strength (model / CLIP)</span>
        <span className={styles.fieldHelper}>
          Typical range is 0–1. ComfyUI applies each strength separately; SwarmUI uses the
          model strength only.
        </span>
        <div style={{ display: 'flex', gap: 12 }}>
          <input
            type="number"
            step="0.05"
            min={-2}
            max={2}
            className={styles.fieldInput}
            value={weightModel}
            onChange={(e) => setWeightModel(e.target.value)}
            placeholder="Model strength"
          />
          <input
            type="number"
            step="0.05"
            min={-2}
            max={2}
            className={styles.fieldInput}
            value={weightClip}
            onChange={(e) => setWeightClip(e.target.value)}
            placeholder="CLIP strength"
          />
        </div>
      </div>

      <div className={styles.fieldGroup}>
        <span className={styles.fieldLabel}>Base tags</span>
        <span className={styles.fieldHelper}>
          Prepended to every image prompt for this character. Booru-style tags work best
          (lowercase, underscores).
        </span>
        <textarea
          className={styles.fieldTextarea}
          rows={3}
          value={baseTags}
          onChange={(e) => setBaseTags(e.target.value)}
          placeholder="1girl, long brown hair, pink dress, green eyes"
        />
      </div>

      <div className={styles.fieldGroup}>
        <span className={styles.fieldLabel}>Source URL (optional)</span>
        <span className={styles.fieldHelper}>
          Travels with PNG exports as a display-only hint. Lumiverse will never auto-download
          from this URL.
        </span>
        <input
          type="url"
          className={styles.fieldInput}
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder="https://civitai.com/models/…"
        />
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button variant="primary" onClick={handleSave} loading={saving} disabled={saving}>
          {binding ? 'Update' : 'Save'}
        </Button>
        {binding ? (
          <Button variant="danger-ghost" onClick={handleClear} icon={<Trash2 size={14} />} disabled={saving}>
            Clear
          </Button>
        ) : null}
        {sourceUrl ? (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              color: 'var(--lumiverse-primary)',
              fontSize: 'calc(12px * var(--lumiverse-font-scale, 1))',
            }}
          >
            <ExternalLink size={12} />
            Open source page
          </a>
        ) : null}
        {statusMessage ? (
          <span
            className={styles.fieldHelper}
            style={{
              color:
                statusMessage.kind === 'error'
                  ? 'var(--lumiverse-danger, #d44)'
                  : 'var(--lumiverse-text-dim)',
            }}
          >
            {statusMessage.text}
          </span>
        ) : null}
      </div>
    </div>
  )
}
