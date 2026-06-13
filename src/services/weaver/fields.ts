export type WeaverFieldKind =
  | "short"
  | "bundle"
  | "voice"
  | "scene"
  | "voiced"
  | "alichat"
  | "greetings";

export type WeaverFieldRender = "synthesize" | "direct";

export type WeaverCharlField =
  | "name"
  | "description"
  | "personality"
  | "scenario"
  | "first_mes"
  | "mes_example"
  | "alternate_greetings";

export interface WeaverFieldDef {
  id: string;
  label: string;
  charlField: WeaverCharlField;
  order: number;
  kind: WeaverFieldKind;
  render: WeaverFieldRender;
  directSlot?: string;
  primarySlots: string[];
  renderGuidance: string;
  usesVoiceMaterial?: boolean;
  list?: { separator: string };
}

export function getField(defs: readonly WeaverFieldDef[], id: string): WeaverFieldDef | undefined {
  return defs.find((f) => f.id === id);
}

export function isFieldId(defs: readonly WeaverFieldDef[], id: unknown): id is string {
  return typeof id === "string" && defs.some((f) => f.id === id);
}

export function rankByOrder(defs: readonly WeaverFieldDef[]): WeaverFieldDef[] {
  return [...defs].sort((a, b) => a.order - b.order);
}
