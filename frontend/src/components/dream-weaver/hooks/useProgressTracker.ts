import { useMemo } from "react";
import type { DreamWeaverWorkspace } from "@/api/dream-weaver-tooling";
import type { DreamWeaverSession } from "@/api/dream-weaver";

export type FieldStatus = {
  key: string;
  label: string;
  complete: boolean;
  required: boolean;
};

type FieldKey = keyof DreamWeaverWorkspace;

const CHARACTER_FIELDS: Array<{ key: FieldKey; label: string; required: boolean }> = [
  { key: "name", label: "Name", required: true },
  { key: "personality", label: "Personality", required: true },
  { key: "first_mes", label: "First Message", required: true },
  { key: "scenario", label: "Scenario", required: false },
  { key: "appearance", label: "Appearance", required: false },
  { key: "voice_guidance", label: "Voice", required: false },
];

const SCENARIO_FIELDS: Array<{ key: FieldKey; label: string; required: boolean }> = [
  { key: "name", label: "Title", required: true },
  { key: "scenario", label: "Premise", required: true },
  { key: "first_mes", label: "Opening Scene", required: true },
  { key: "personality", label: "Main Character", required: false },
  { key: "appearance", label: "Appearance", required: false },
  { key: "voice_guidance", label: "Voice", required: false },
];

const MIN_SCENARIO_NPCS = 2;
const MIN_SCENARIO_LOREBOOKS = 3;

function isComplete(value: DreamWeaverWorkspace[FieldKey]): boolean {
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
  return useMemo(() => {
    const isScenario = workspaceKind === "scenario";
    const fieldDefs = isScenario ? SCENARIO_FIELDS : CHARACTER_FIELDS;

    const fieldStatuses: FieldStatus[] = fieldDefs.map(({ key, label, required }) => ({
      key: key as string,
      label,
      required,
      complete: draft ? isComplete(draft[key]) : false,
    }));

    if (!isScenario) return fieldStatuses;

    const npcCount = draft?.npcs?.length ?? 0;
    const loreCount = draft?.lorebooks?.length ?? 0;
    fieldStatuses.push({
      key: "npcs",
      label: `NPCs (${npcCount}/${MIN_SCENARIO_NPCS})`,
      required: false,
      complete: npcCount >= MIN_SCENARIO_NPCS,
    });
    fieldStatuses.push({
      key: "lorebooks",
      label: `Lorebook (${loreCount}/${MIN_SCENARIO_LOREBOOKS})`,
      required: false,
      complete: loreCount >= MIN_SCENARIO_LOREBOOKS,
    });
    return fieldStatuses;
  }, [draft, workspaceKind]);
}
