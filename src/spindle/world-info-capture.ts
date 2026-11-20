import type { ActivatedWorldInfoEntryDTO } from "lumiverse-spindle-types";
import type { ActivatedWorldInfoEntry } from "../llm/types";

export const INTERNAL_WORLD_INFO_CAPTURES_KEY = "__spindleWorldInfoCaptures";

export function buildWorldInfoCaptureMap(
  requests: ReadonlyMap<string, ReadonlySet<string>>,
  activated: readonly ActivatedWorldInfoEntry[],
): Record<string, ActivatedWorldInfoEntry[]> {
  const result: Record<string, ActivatedWorldInfoEntry[]> = {};
  for (const [extensionId, ids] of requests) {
    result[extensionId] = activated.filter((entry) => ids.has(entry.id));
  }
  return result;
}

function toCaptureDTO(entry: ActivatedWorldInfoEntry): ActivatedWorldInfoEntryDTO {
  const dto: ActivatedWorldInfoEntryDTO = {
    id: entry.id,
    comment: entry.comment,
    keys: entry.keys,
    source: entry.source,
  };
  if (entry.score !== undefined) dto.score = entry.score;
  if (entry.bookId !== undefined) dto.bookId = entry.bookId;
  if (entry.bookSource === "peer") dto.bookSource = "persona";
  else if (entry.bookSource !== undefined) dto.bookSource = entry.bookSource;
  return dto;
}

export function projectWorldInfoCaptureContext(
  context: unknown,
  extensionId: string,
): Record<string, unknown> {
  const projected =
    context && typeof context === "object"
      ? { ...(context as Record<string, unknown>) }
      : {};
  const rawCaptures = projected[INTERNAL_WORLD_INFO_CAPTURES_KEY];
  delete projected[INTERNAL_WORLD_INFO_CAPTURES_KEY];
  delete projected.capturedWorldInfo;

  if (Array.isArray(projected.activatedWorldInfo)) {
    projected.activatedWorldInfo = projected.activatedWorldInfo
      .filter(
        (entry): entry is ActivatedWorldInfoEntry =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as { id?: unknown }).id === "string",
      )
      .map(toCaptureDTO);
  }

  if (
    !rawCaptures ||
    typeof rawCaptures !== "object" ||
    !Object.prototype.hasOwnProperty.call(rawCaptures, extensionId)
  ) {
    return projected;
  }
  const entries = (rawCaptures as Record<string, unknown>)[extensionId];
  projected.capturedWorldInfo = Array.isArray(entries)
    ? entries
        .filter(
          (entry): entry is ActivatedWorldInfoEntry =>
            !!entry &&
            typeof entry === "object" &&
            typeof (entry as { id?: unknown }).id === "string",
        )
        .map(toCaptureDTO)
    : [];
  return projected;
}
