import { useMemo } from "react";
import type { DreamWeaverWorkspace } from "@/api/dream-weaver-tooling";
import type { DreamWeaverSession } from "@/api/dream-weaver";

export type FieldStatus = {
  key: string;
  label: string;
  complete: boolean;
  required: boolean;
};

const CHARACTER_FIELDS: Array<{
  key: keyof DreamWeaverWorkspace;
  label: string;
  required: boolean;
}> = [
  { key: "name", label: "Name", required: true },
  { key: "personality", label: "Personality", required: true },
  { key: "first_mes", label: "First Message", required: true },
  { key: "scenario", label: "Scenario", required: false },
  { key: "appearance", label: "Appearance", required: false },
  { key: "voice_guidance", label: "Voice", required: false },
];

function isComplete(value: DreamWeaverWorkspace[keyof DreamWeaverWorkspace]): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (value && typeof value === "object" && "compiled" in value) {
    return typeof (value as any).compiled === "string" && (value as any).compiled.trim().length > 0;
  }
  return false;
}

export function useProgressTracker(
  draft: DreamWeaverWorkspace | null,
  workspaceKind: DreamWeaverSession["workspace_kind"],
): FieldStatus[] {
  return useMemo(() => CHARACTER_FIELDS.map(({ key, label, required }) => ({
    key,
    label: workspaceKind === "scenario" && key === "name" ? "Title" : label,
    required,
    complete: draft ? isComplete(draft[key]) : false,
  })), [draft, workspaceKind]);
}
