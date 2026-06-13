import type { WeaverGateVerdict, WeaverGateCriterion, WeaverBibleSpine } from "../../types/weaver";

export interface GateCriterion {
  key: string;
  label: string;
  description: string;
  applies?: (spine: WeaverBibleSpine) => boolean;
}

export function hasEntry(spine: WeaverBibleSpine, slot: string): boolean {
  return spine.entries.some((e) => e.slot === slot && e.content.trim().length > 0);
}

export function applicableBibleCriteria(
  criteria: readonly GateCriterion[],
  spine: WeaverBibleSpine,
): readonly GateCriterion[] {
  return criteria.filter((c) => !c.applies || c.applies(spine));
}

export function buildGateVerdict(
  raw: Record<string, unknown>,
  applicable: readonly GateCriterion[],
): WeaverGateVerdict {
  const applicableKeys = new Set(applicable.map((c) => c.key));
  const labelFor = (key: string) => applicable.find((c) => c.key === key)?.label ?? key;
  const rawCriteria = Array.isArray(raw.criteria) ? raw.criteria : [];
  const seen = new Map<string, WeaverGateCriterion>();
  for (const item of rawCriteria) {
    if (!item || typeof item !== "object") continue;
    const key = (item as Record<string, unknown>).key;
    if (typeof key !== "string" || !applicableKeys.has(key) || seen.has(key)) continue;
    const passed = (item as Record<string, unknown>).passed === true;
    const noteRaw = (item as Record<string, unknown>).note;
    seen.set(key, {
      key,
      label: labelFor(key),
      passed,
      note: typeof noteRaw === "string" ? noteRaw.trim() : "",
    });
  }

  const criteria = applicable
    .map((c) => seen.get(c.key))
    .filter((c): c is WeaverGateCriterion => Boolean(c));

  const passed =
    criteria.length === applicableKeys.size && criteria.every((c) => c.passed);

  const summaryRaw = raw.summary;
  return {
    passed,
    criteria,
    summary: typeof summaryRaw === "string" ? summaryRaw.trim() : "",
  };
}

export function deriveStatus(verdict: WeaverGateVerdict): "gated" | "flagged" {
  return verdict.passed ? "gated" : "flagged";
}
