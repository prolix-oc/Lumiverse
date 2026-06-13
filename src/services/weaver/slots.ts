export type SlotImpact = "critical" | "high" | "medium" | "low";

export type SlotFill = "elicit" | "generate";

export interface SynthesisGroupDef {
  id: string;
  label: string;
  instruction: string;
}

export interface SpinePart {
  id: string;
  label: string;
  fill: SlotFill;
  description?: string;
}

export interface SpineSlot {
  id: string;
  category: string;
  label: string;
  description: string;
  impact: SlotImpact;
  fill: SlotFill;
  synthesisGroup: string;
  parts?: readonly SpinePart[];
  optional?: boolean;
  optIn?: boolean;
  extractionNote?: string;
}

export const IMPACT_WEIGHT: Record<SlotImpact, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export function getSlot(slots: readonly SpineSlot[], id: string): SpineSlot | undefined {
  return slots.find((s) => s.id === id);
}

export function isSlotId(slots: readonly SpineSlot[], id: unknown): id is string {
  return typeof id === "string" && slots.some((s) => s.id === id);
}

export function slotSynthesisGroup(
  slots: readonly SpineSlot[],
  groups: readonly SynthesisGroupDef[],
  id: string,
): string {
  return getSlot(slots, id)?.synthesisGroup ?? groups[0].id;
}

export function rankByImpact(slots: readonly SpineSlot[], ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => {
    const wa = IMPACT_WEIGHT[getSlot(slots, a)?.impact ?? "low"];
    const wb = IMPACT_WEIGHT[getSlot(slots, b)?.impact ?? "low"];
    return wb - wa;
  });
}

export function slotParts(slots: readonly SpineSlot[], id: string): SpinePart[] {
  const slot = getSlot(slots, id);
  if (!slot) return [];
  if (slot.parts && slot.parts.length > 0) return [...slot.parts];
  return [{ id: slot.id, label: slot.label, fill: slot.fill }];
}

export function slotHasElicit(slots: readonly SpineSlot[], id: string): boolean {
  return slotParts(slots, id).some((p) => p.fill === "elicit");
}

export function partFill(slots: readonly SpineSlot[], slotId: string, partId: string): SlotFill {
  const part = slotParts(slots, slotId).find((p) => p.id === partId);
  return part?.fill ?? slotFill(slots, slotId);
}

export function slotFill(slots: readonly SpineSlot[], id: string): SlotFill {
  if (!getSlot(slots, id)) return "elicit";
  return slotHasElicit(slots, id) ? "elicit" : "generate";
}
