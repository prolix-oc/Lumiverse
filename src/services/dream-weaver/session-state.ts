import type { DreamWeaverSession, DW_DRAFT_V1 } from "../../types/dream-weaver";

export type DreamWeaverSoulState = "empty" | "generating" | "ready" | "error";
export type DreamWeaverWorldState = "empty" | "ready" | "stale";
export interface DreamWeaverSessionStateSnapshot {
  soul_state: DreamWeaverSoulState;
  world_state: DreamWeaverWorldState;
  soul_revision: number;
  world_source_revision: number | null;
}

type SoulSlice = Pick<DW_DRAFT_V1, "kind" | "meta" | "voice_guidance" | "alternate_fields" | "greetings"> & {
  card: DW_DRAFT_V1["card"];
};

function stable<T>(value: T): string {
  return JSON.stringify(value);
}

export function extractSoulSlice(draft: DW_DRAFT_V1 | null | undefined): SoulSlice | null {
  if (!draft) return null;
  return {
    kind: draft.kind,
    meta: draft.meta,
    card: draft.card,
    voice_guidance: draft.voice_guidance,
    alternate_fields: draft.alternate_fields,
    greetings: draft.greetings,
  };
}

export function hasValidSoulDraft(draft: DW_DRAFT_V1 | null | undefined): boolean {
  if (!draft) return false;
  return Boolean(
    draft.card.name.trim() &&
    draft.card.description.trim() &&
    draft.card.personality.trim() &&
    draft.card.scenario.trim() &&
    draft.card.first_mes.trim(),
  );
}

export function deriveStoredSoulState(
  draft: DW_DRAFT_V1 | null | undefined,
): Exclude<DreamWeaverSoulState, "generating" | "error"> {
  return hasValidSoulDraft(draft) ? "ready" : "empty";
}

export function hasWorldContent(draft: DW_DRAFT_V1 | null | undefined): boolean {
  if (!draft) return false;
  return draft.lorebooks.length > 0 || draft.npc_definitions.length > 0;
}

export function didSoulSliceChange(
  previous: DW_DRAFT_V1 | null | undefined,
  next: DW_DRAFT_V1 | null | undefined,
): boolean {
  return stable(extractSoulSlice(previous)) !== stable(extractSoulSlice(next));
}

export function deriveWorldState(
  draft: DW_DRAFT_V1 | null | undefined,
  soulRevision: number,
  worldSourceRevision: number | null,
): DreamWeaverWorldState {
  if (!hasWorldContent(draft)) return "empty";
  if (worldSourceRevision == null) return "stale";
  return worldSourceRevision < soulRevision ? "stale" : "ready";
}

export function mergeGeneratedSoul(
  existing: DW_DRAFT_V1 | null | undefined,
  generated: DW_DRAFT_V1,
): DW_DRAFT_V1 {
  if (!existing) return generated;
  return {
    ...existing,
    format: generated.format,
    version: generated.version,
    kind: generated.kind,
    meta: generated.meta,
    card: generated.card,
    voice_guidance: generated.voice_guidance,
    alternate_fields: generated.alternate_fields,
    greetings: generated.greetings,
  };
}

export function deriveSessionStateSnapshot(
  previousSession:
    | Pick<DreamWeaverSession, "soul_revision" | "world_source_revision">
    | null
    | undefined,
  previousDraft: DW_DRAFT_V1 | null | undefined,
  nextDraft: DW_DRAFT_V1 | null | undefined,
  options?: { worldGeneratedFromCurrentSoul?: boolean },
): DreamWeaverSessionStateSnapshot {
  if (!nextDraft) {
    return {
      soul_state: "empty",
      world_state: "empty",
      soul_revision: 0,
      world_source_revision: null,
    };
  }

  const previousSoulRevision = Math.max(0, Number(previousSession?.soul_revision ?? 0));
  const previousWorldSourceRevision =
    previousSession?.world_source_revision == null
      ? null
      : Number(previousSession.world_source_revision);
  const soulChanged = didSoulSliceChange(previousDraft, nextDraft);
  const soulRevision = soulChanged
    ? previousSoulRevision + 1
    : Math.max(previousSoulRevision, 1);

  let worldSourceRevision: number | null = null;
  if (hasWorldContent(nextDraft)) {
    if (options?.worldGeneratedFromCurrentSoul) {
      worldSourceRevision = soulRevision;
    } else if (!soulChanged) {
      worldSourceRevision = previousWorldSourceRevision ?? soulRevision;
    } else {
      worldSourceRevision = previousWorldSourceRevision;
    }
  }

  return {
    soul_state: deriveStoredSoulState(nextDraft),
    world_state: deriveWorldState(nextDraft, soulRevision, worldSourceRevision),
    soul_revision: soulRevision,
    world_source_revision: worldSourceRevision,
  };
}

export function canFinalizeSession(
  session: Pick<DreamWeaverSession, "soul_state" | "character_id">,
  draft: DW_DRAFT_V1 | null | undefined,
): boolean {
  return session.soul_state === "ready" && !session.character_id && hasValidSoulDraft(draft);
}
