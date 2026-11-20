/**
 * Canonical H13 activation provenance schema and deep projector.
 *
 * This is deliberately a no-content boundary.  Projected values contain only
 * discriminators, ids, configured patterns, and bounded numeric locations;
 * callers must never pass an internal activation object through wholesale.
 */

export type ActivationProvenanceMessageLocatorSource = {
  readonly kind: "message";
  readonly messageId: string;
  readonly messageOffset: number;
  readonly start: number;
  readonly end: number;
};

export type ActivationProvenanceRecursiveEntryLocatorSource = {
  readonly kind: "recursive_entry";
  readonly entryId: string;
  readonly start: number;
  readonly end: number;
};

export type ActivationProvenanceMixedLocatorSource = {
  readonly kind: "mixed_or_unavailable";
};

export type ActivationProvenanceLocatorSource =
  | ActivationProvenanceMessageLocatorSource
  | ActivationProvenanceRecursiveEntryLocatorSource
  | ActivationProvenanceMixedLocatorSource;

export type ActivationProvenanceKeywordExactMatch = {
  readonly configuredPattern: string;
  readonly source: ActivationProvenanceLocatorSource;
};

export type ActivationProvenance =
  | { readonly origin: "constant" }
  | { readonly origin: "sticky" }
  | {
      readonly origin: "keyword";
      readonly activationPass: number;
      readonly matchedPrimaryKeys: readonly string[];
      readonly matchedSecondaryKeys: readonly string[];
      readonly exactMatch?: ActivationProvenanceKeywordExactMatch;
    }
  | { readonly origin: "vector" };

export interface ActivationTraceEntry {
  readonly id: string;
  readonly provenance: ActivationProvenance;
}

/** Keys that must never be present in a serialized provenance payload. */
export const ACTIVATION_PROVENANCE_FORBIDDEN_KEYS = [
  "content",
  "sentence",
  "query",
  "messageContent",
  "entryContent",
] as const;

type UnknownRecord = Record<string, unknown>;

export function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function projectStringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    result.push(item);
  }
  return result;
}

function projectRange(
  startValue: unknown,
  endValue: unknown,
): { readonly start: number; readonly end: number } | undefined {
  if (!isFiniteNonNegativeInteger(startValue) || !isFiniteNonNegativeInteger(endValue)) {
    return undefined;
  }
  if (endValue < startValue) return undefined;
  return { start: startValue, end: endValue };
}

function projectLocatorSource(value: unknown): ActivationProvenanceLocatorSource | undefined {
  if (!isUnknownRecord(value)) return undefined;

  if (value.kind === "message") {
    if (typeof value.messageId !== "string" || !isFiniteNonNegativeInteger(value.messageOffset)) {
      return undefined;
    }
    const range = projectRange(value.start, value.end);
    if (range === undefined) return undefined;
    return {
      kind: "message",
      messageId: value.messageId,
      messageOffset: value.messageOffset,
      start: range.start,
      end: range.end,
    };
  }

  if (value.kind === "recursive_entry") {
    if (typeof value.entryId !== "string") return undefined;
    const range = projectRange(value.start, value.end);
    if (range === undefined) return undefined;
    return {
      kind: "recursive_entry",
      entryId: value.entryId,
      start: range.start,
      end: range.end,
    };
  }

  if (value.kind === "mixed_or_unavailable") {
    return { kind: "mixed_or_unavailable" };
  }

  return undefined;
}

function projectKeywordExactMatch(value: unknown): ActivationProvenanceKeywordExactMatch | undefined {
  if (!isUnknownRecord(value) || typeof value.configuredPattern !== "string") return undefined;

  const source = projectLocatorSource(value.source);
  if (source === undefined) return undefined;
  return { configuredPattern: value.configuredPattern, source };
}

/**
 * Deeply validate and reconstruct one provenance union member.
 *
 * Unknown fields are ignored at every level.  Any malformed required field,
 * discriminator, number, or range invalidates the complete provenance value.
 */
export function projectActivationProvenance(value: unknown): ActivationProvenance | undefined {
  if (!isUnknownRecord(value)) return undefined;

  if (value.origin === "constant") return { origin: "constant" };
  if (value.origin === "sticky") return { origin: "sticky" };
  if (value.origin === "vector") return { origin: "vector" };
  if (value.origin !== "keyword") return undefined;

  if (!isFiniteNonNegativeInteger(value.activationPass)) return undefined;
  const matchedPrimaryKeys = projectStringList(value.matchedPrimaryKeys);
  const matchedSecondaryKeys = projectStringList(value.matchedSecondaryKeys);
  if (matchedPrimaryKeys === undefined || matchedSecondaryKeys === undefined) return undefined;

  if (value.exactMatch === undefined) {
    return {
      origin: "keyword",
      activationPass: value.activationPass,
      matchedPrimaryKeys,
      matchedSecondaryKeys,
    };
  }

  const exactMatch = projectKeywordExactMatch(value.exactMatch);
  if (exactMatch === undefined) return undefined;
  return {
    origin: "keyword",
    activationPass: value.activationPass,
    matchedPrimaryKeys,
    matchedSecondaryKeys,
    exactMatch,
  };
}

/** Deep projector for the complete activation trace row. */
export function projectActivationTraceEntry(value: unknown): ActivationTraceEntry | undefined {
  if (!isUnknownRecord(value) || typeof value.id !== "string") return undefined;

  const provenance = projectActivationProvenance(value.provenance);
  if (provenance === undefined) return undefined;
  return { id: value.id, provenance };
}

export type ActivationBookSource = "character" | "persona" | "chat" | "global" | "peer";
export type PublishedActivationBookSource = Exclude<ActivationBookSource, "peer">;

/** Map the internal multiplayer peer alias to the published persona source. */
export function mapPeerBookSourceToPersona(value: unknown): PublishedActivationBookSource | undefined {
  if (value === "peer") return "persona";
  if (value === "character" || value === "persona" || value === "chat" || value === "global") {
    return value;
  }
  return undefined;
}
