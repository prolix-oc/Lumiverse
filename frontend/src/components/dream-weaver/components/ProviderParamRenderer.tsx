import { useCallback, useState } from "react"
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
}

interface ProviderParamRendererProps {
  schema: Record<string, ParamSchema>
  values: Record<string, any>
  onChange: (key: string, value: any) => void
}

/**
 * Dynamically renders form controls based on a provider's parameter schema.
 */
export function ProviderParamRenderer({ schema, values, onChange }: ProviderParamRendererProps) {
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
      if (entry[1].type === "string" || entry[1].type === "image_array") {
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

function ParamControl({
  paramKey,
  schema,
  value,
  onChange,
}: {
  paramKey: string
  schema: ParamSchema
  value: any
  onChange: (key: string, value: any) => void
}) {
  const label = paramKey
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")

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
