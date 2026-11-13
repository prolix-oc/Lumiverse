import type { WeaverVisualKindMeta } from "../../../types/weaver";
import { EXPRESSION_VARIANTS } from "./expressions";

export const VISUAL_KINDS: readonly WeaverVisualKindMeta[] = [
  { id: "portrait", width: 832, height: 1216, aspect_ratio: "2:3", base_negative: "" },
  {
    id: "expressions",
    width: 832,
    height: 1216,
    aspect_ratio: "2:3",
    base_negative: "",
    variants: EXPRESSION_VARIANTS,
  },
  { id: "scenes", width: 1216, height: 832, aspect_ratio: "3:2", base_negative: "" },
  { id: "alternates", width: 832, height: 1216, aspect_ratio: "2:3", base_negative: "" },
] as const;

const VISUAL_KIND_MAP: ReadonlyMap<string, WeaverVisualKindMeta> = new Map(
  VISUAL_KINDS.map((kind) => [kind.id, kind]),
);

export function getVisualKind(id: string): WeaverVisualKindMeta | undefined {
  return VISUAL_KIND_MAP.get(id);
}

export function isVisualKind(id: string): boolean {
  return VISUAL_KIND_MAP.has(id);
}

export function listVisualKinds(): readonly WeaverVisualKindMeta[] {
  return VISUAL_KINDS;
}

export function visualCandidateOwner(kind: string, variant?: string | null): string {
  const base = `weaver:visual:${kind}`;
  const v = variant?.trim().toLowerCase();
  return v ? `${base}:${v}` : base;
}
