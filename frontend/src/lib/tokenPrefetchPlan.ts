export type PrefetchSkipReason =
  | "no-selection"
  | "already-planned"
  | "empty-content"
  | "stored-exact"
  | "already-counted";

export interface SelectionPrefetchInput {
  selected: boolean;
  entryId: string;
  content: string | null | undefined;
  model: string;
  cacheKey: string;
  alreadyPlanned?: boolean;
  storedExact?: boolean;
  alreadyCounted?: boolean;
}

export interface SelectionPrefetchSchedule {
  kind: "schedule";
  priority: "interactive";
  entryId: string;
  cacheKey: string;
  model: string;
  content: string;
}

export interface SelectionPrefetchSkip {
  kind: "skip";
  reason: PrefetchSkipReason;
}

export type SelectionPrefetchPlan =
  | SelectionPrefetchSchedule
  | SelectionPrefetchSkip;

/**
 * Computes whether selecting an entry should enqueue its token count.
 * The caller supplies identity/cache facts already obtained from cheap reads;
 * this function performs no hashing, cache access, or scheduling.
 */
export function planSelectionPrefetch(
  input: SelectionPrefetchInput,
): SelectionPrefetchPlan {
  if (!input.selected) {
    return { kind: "skip", reason: "no-selection" };
  }
  if (input.alreadyPlanned) {
    return { kind: "skip", reason: "already-planned" };
  }
  if (input.content == null || input.content.length === 0) {
    return { kind: "skip", reason: "empty-content" };
  }
  if (input.storedExact) {
    return { kind: "skip", reason: "stored-exact" };
  }
  if (input.alreadyCounted) {
    return { kind: "skip", reason: "already-counted" };
  }

  return {
    kind: "schedule",
    priority: "interactive",
    entryId: input.entryId,
    cacheKey: input.cacheKey,
    model: input.model,
    content: input.content,
  };
}

export type OpenCountMode = "automatic" | "delayed" | "manual";

export interface OpenEntryCountInput {
  mode: OpenCountMode;
  isFresh: boolean;
  isEdited: boolean;
}

/** Returns true only for an untouched, freshly opened automatic/delayed entry. */
export function shouldCountOpenEntryImmediately(
  input: OpenEntryCountInput,
): boolean {
  return (
    input.mode !== "manual" &&
    (input.mode === "automatic" || input.mode === "delayed") &&
    input.isFresh &&
    !input.isEdited
  );
}
