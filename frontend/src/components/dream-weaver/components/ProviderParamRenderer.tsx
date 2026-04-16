import { useCallback, useState } from "react"
import { imageGenConnectionsApi } from "@/api/image-gen-connections"
import styles from "./ProviderParamRenderer.module.css"

interface ParamSchema {
  type: "number" | "integer" | "boolean" | "string" | "select" | "image_array"
  default?: any
  min?: number
  max?: number
  step?: number
  description: string
  required?: boolean
  options?: Array<{ id: string; label: string }>
  group?: string
  modelSubtype?: string
}

interface ProviderParamRendererProps {
  schema: Record<string, ParamSchema>
  values: Record<string, any>
  onChange: (key: string, value: any) => void
  /** Connection ID used to fetch model lists for model-component fields. */
  connectionId?: string | null
}

/**
 * Dynamically renders form controls based on a provider's parameter schema.
 */
export function ProviderParamRenderer({ schema, values, onChange, connectionId }: ProviderParamRendererProps) {
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())

  const toggleGroup = useCallback((group: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }, [])

  const SKIP_KEYS = new Set(["negativePrompt", "rawRequestOverride", "workflow"])
  const ungrouped: [string, ParamSchema][] = []
  const groups = new Map<string, [string, ParamSchema][]>()

  for (const [key, param] of Object.entries(schema)) {
    if (SKIP_KEYS.has(key)) continue
    if (param.group) {
      if (!groups.has(param.group)) groups.set(param.group, [])
      groups.get(param.group)!.push([key, param])
    } else {
      ungrouped.push([key, param])
    }
  }

  const renderParams = (params: [string, ParamSchema][]) => {
    const rows: [string, ParamSchema][][] = []
    let current: [string, ParamSchema][] = []

    for (const entry of params) {
      // Model-subtype fields and plain strings always get their own row
      if (entry[1].type === "string" || entry[1].type === "image_array" || entry[1].modelSubtype) {
        if (current.length > 0) rows.push(current)
        rows.push([entry])
        current = []
      } else {
        current.push(entry)
        if (current.length === 2) {
          rows.push(current)
          current = []
        }
      }
    }
    if (current.length > 0) rows.push(current)

    return rows.map((row, i) => (
      <div key={i} className={styles.paramRow}>
        {row.map(([key, param]) => (
          <ParamControl
            key={key}
            paramKey={key}
            schema={param}
            value={values[key] ?? param.default}
            onChange={onChange}
            connectionId={connectionId}
          />
        ))}
      </div>
    ))
  }

  return (
    <div className={styles.paramGroup}>
      {renderParams(ungrouped)}

      {[...groups.entries()].map(([group, params]) => {
        const isOpen = openGroups.has(group)
        return (
          <div key={group}>
            <div className={styles.groupHeader} onClick={() => toggleGroup(group)}>
              <span className={styles.groupLabel}>{group}</span>
              <span className={styles.groupChevron} data-open={isOpen || undefined}>
                &#9656;
              </span>
            </div>
            {isOpen && (
              <div className={styles.groupContent}>{renderParams(params)}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ModelComboControl({
  paramKey,
  label,
  schema,
  value,
  onChange,
  connectionId,
}: {
  paramKey: string
  label: string
  schema: ParamSchema
  value: any
  onChange: (key: string, value: any) => void
  connectionId: string | null | undefined
}) {
  const [models, setModels] = useState<Array<{ id: string; label: string }> | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  const load = async () => {
    if (!connectionId || !schema.modelSubtype) return
    setLoading(true)
    try {
      const res = await imageGenConnectionsApi.modelsBySubtype(connectionId, schema.modelSubtype)
      setModels(res.models ?? [])
      setOpen(true)
    } catch {
      setModels([])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.paramField}>
      <label className={styles.paramLabel}>{label}</label>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input
          type="text"
          className={styles.paramInput}
          style={{ flex: 1 }}
          value={value ?? ""}
          placeholder={schema.description}
          onChange={(e) => onChange(paramKey, e.target.value)}
        />
        <button
          type="button"
          onClick={load}
          disabled={loading || !connectionId}
          title="Browse available models"
          style={{
            flexShrink: 0,
            padding: "0 6px",
            height: 26,
            background: "var(--lumiverse-surface-raised, #2a2a2a)",
            border: "1px solid var(--lumiverse-border, #444)",
            borderRadius: 3,
            color: "var(--lumiverse-text, #eee)",
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          {loading ? "…" : "↓"}
        </button>
      </div>
      {open && models !== null && (
        <div
          style={{
            marginTop: 4,
            border: "1px solid var(--lumiverse-border, #444)",
            borderRadius: 3,
            background: "var(--lumiverse-surface-raised, #2a2a2a)",
            maxHeight: 140,
            overflowY: "auto",
          }}
        >
          <div
            style={{ padding: "3px 8px", cursor: "pointer", fontSize: 11, opacity: 0.6 }}
            onClick={() => { onChange(paramKey, ""); setOpen(false) }}
          >
            (clear / use default)
          </div>
          {models.length === 0 ? (
            <div style={{ padding: "3px 8px", fontSize: 11, opacity: 0.5 }}>No models found</div>
          ) : (
            models.map((m) => (
              <div
                key={m.id}
                style={{
                  padding: "3px 8px",
                  cursor: "pointer",
                  fontSize: 11,
                  background: value === m.id ? "var(--lumiverse-accent-muted, #2d4a6e)" : undefined,
                }}
                onClick={() => { onChange(paramKey, m.id); setOpen(false) }}
              >
                {m.label}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function ParamControl({
  paramKey,
  schema,
  value,
  onChange,
  connectionId,
}: {
  paramKey: string
  schema: ParamSchema
  value: any
  onChange: (key: string, value: any) => void
  connectionId?: string | null
}) {
  const label = paramKey
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")

  if (schema.modelSubtype && schema.type === "string") {
    return (
      <ModelComboControl
        paramKey={paramKey}
        label={label}
        schema={schema}
        value={value}
        onChange={onChange}
        connectionId={connectionId}
      />
    )
  }

  switch (schema.type) {
    case "select":
      return (
        <div className={styles.paramField}>
          <label className={styles.paramLabel}>{label}</label>
          <select
            className={styles.paramSelect}
            value={value ?? ""}
            onChange={(e) => onChange(paramKey, e.target.value)}
          >
            {(schema.options || []).map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      )

    case "number":
    case "integer":
      return (
        <div className={styles.paramField}>
          <label className={styles.paramLabel}>{label}</label>
          <input
            type="number"
            className={styles.paramInput}
            value={value ?? schema.default ?? ""}
            min={schema.min}
            max={schema.max}
            step={schema.step ?? (schema.type === "integer" ? 1 : 0.1)}
            onChange={(e) => {
              const v = schema.type === "integer"
                ? parseInt(e.target.value, 10)
                : parseFloat(e.target.value)
              if (!isNaN(v)) onChange(paramKey, v)
            }}
          />
        </div>
      )

    case "boolean":
      return (
        <div className={styles.paramField}>
          <div
            className={styles.paramToggle}
            onClick={() => onChange(paramKey, !value)}
          >
            <div className={styles.toggleTrack} data-on={value || undefined}>
              <div className={styles.toggleThumb} />
            </div>
            <span className={styles.toggleLabel}>{label}</span>
          </div>
        </div>
      )

    case "string":
      return (
        <div className={styles.paramField}>
          <label className={styles.paramLabel}>{label}</label>
          <input
            type="text"
            className={styles.paramInput}
            value={value ?? ""}
            placeholder={schema.description}
            onChange={(e) => onChange(paramKey, e.target.value)}
          />
        </div>
      )

    default:
      return null
  }
}
