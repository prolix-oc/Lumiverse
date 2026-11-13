import type { PromptVariableDef } from "../types/preset";

interface CoercedPromptVar {
  /** What {{var::name}} resolves to (or its stringified form). */
  rendered: string | number;
  /** Currently selected option ids — only meaningful for multiselect/select; empty otherwise. */
  selectedIds: string[];
}

export function coercePromptVariable(
  def: PromptVariableDef,
  raw: unknown,
): CoercedPromptVar {
  switch (def.type) {
    case "text":
    case "textarea": {
      if (raw === undefined || raw === null) return { rendered: def.defaultValue ?? "", selectedIds: [] };
      return { rendered: String(raw), selectedIds: [] };
    }
    case "number": {
      const fallback =
        typeof def.defaultValue === "number" ? def.defaultValue : 0;
      const n = raw === undefined || raw === null ? fallback : Number(raw);
      const v = Number.isFinite(n) ? n : fallback;
      return { rendered: clampNumber(v, def.min, def.max), selectedIds: [] };
    }
    case "slider": {
      const fallback = def.defaultValue;
      const n = raw === undefined || raw === null ? fallback : Number(raw);
      const v = Number.isFinite(n) ? n : fallback;
      return { rendered: clampNumber(v, def.min, def.max), selectedIds: [] };
    }
    case "range": {
      const fallback = normalizeRange(def.defaultValue, [def.min, def.max], def.min, def.max);
      const resolved = normalizeRange(raw, fallback, def.min, def.max);
      return { rendered: `${resolved[0]}, ${resolved[1]}`, selectedIds: [] };
    }
    case "select": {
      const options = def.options ?? [];
      const validIds = new Set(options.map((o) => o.id));
      const fallback = validIds.has(def.defaultValue)
        ? def.defaultValue
        : options[0]?.id ?? "";
      const candidate =
        raw === undefined || raw === null ? fallback : String(raw);
      const selectedId = validIds.has(candidate) ? candidate : fallback;
      const match = options.find((o) => o.id === selectedId);
      return {
        rendered: match?.value ?? "",
        selectedIds: selectedId ? [selectedId] : [],
      };
    }
    case "switch": {
      const fallback: 0 | 1 = def.defaultValue === 1 ? 1 : 0;
      if (raw === undefined || raw === null) {
        return { rendered: fallback, selectedIds: [] };
      }
      // Accept booleans, "0"/"1", "true"/"false", and numeric 0/1.
      let on = false;
      if (typeof raw === "boolean") on = raw;
      else if (typeof raw === "number") on = raw === 1;
      else {
        const s = String(raw).trim().toLowerCase();
        on = s === "1" || s === "true" || s === "on" || s === "yes";
      }
      return { rendered: on ? 1 : 0, selectedIds: [] };
    }
    case "multiselect": {
      const options = def.options ?? [];
      const validIds = new Set(options.map((o) => o.id));
      let rawIds: string[];
      if (Array.isArray(raw)) {
        rawIds = raw.map((v) => String(v));
      } else if (raw === undefined || raw === null) {
        rawIds = Array.isArray(def.defaultValue) ? def.defaultValue.slice() : [];
      } else if (typeof raw === "string" && raw.length > 0) {
        rawIds = raw.split(",").map((s) => s.trim()).filter(Boolean);
      } else {
        rawIds = [];
      }
      // Preserve option-declaration order so the joined output is stable
      // regardless of the order the end user clicked the checkboxes in.
      const selectedSet = new Set(rawIds.filter((id) => validIds.has(id)));
      const orderedSelected = options.filter((o) => selectedSet.has(o.id));
      const separator = typeof def.separator === "string" ? def.separator : "\n\n";
      return {
        rendered: orderedSelected.map((o) => o.value).join(separator),
        selectedIds: orderedSelected.map((o) => o.id),
      };
    }
  }
}

function normalizeRange(
  value: unknown,
  fallback: [number, number],
  min: number,
  max: number,
): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return fallback;
  const start = Number(value[0]);
  const end = Number(value[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return fallback;
  const clampedStart = clampNumber(start, min, max);
  const clampedEnd = clampNumber(end, min, max);
  return clampedStart <= clampedEnd
    ? [clampedStart, clampedEnd]
    : [clampedEnd, clampedStart];
}

function clampNumber(value: number, min: number | undefined, max: number | undefined): number {
  let v = value;
  if (typeof min === "number" && v < min) v = min;
  if (typeof max === "number" && v > max) v = max;
  return v;
}

