import type { WeaverGateVerdict, WeaverGateCriterion } from "../../types/weaver";
import type { WeaverFieldKind } from "./fields";

export interface FieldGateCriterion {
  key: string;
  label: string;
  description: string;
  appliesTo: "all" | readonly WeaverFieldKind[];
}

export function criteriaForKind(
  criteria: readonly FieldGateCriterion[],
  kind: WeaverFieldKind,
): FieldGateCriterion[] {
  return criteria.filter((c) => c.appliesTo === "all" || c.appliesTo.includes(kind));
}

export function buildFieldGateVerdict(
  raw: Record<string, unknown>,
  applicable: readonly FieldGateCriterion[],
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

  const passed = criteria.length === applicable.length && criteria.every((c) => c.passed);

  const summaryRaw = raw.summary;
  return {
    passed,
    criteria,
    summary: typeof summaryRaw === "string" ? summaryRaw.trim() : "",
  };
}

export function deriveFieldStatus(verdict: WeaverGateVerdict): "passed" | "flagged" {
  return verdict.passed ? "passed" : "flagged";
}
