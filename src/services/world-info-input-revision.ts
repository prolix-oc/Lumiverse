import { createHash } from "node:crypto";
import type { WorldBookEntry } from "../types/world-book";
import { encodeCanonicalPlainData } from "../utils/canonical-plain-data";

export interface WorldInfoEntrySourceAuthorityV1 {
  readonly id: string;
  readonly bookId: string;
  readonly source: "character" | "persona" | "chat" | "global" | "peer";
  readonly uid: string;
  readonly outletName: string | null;
  readonly wiMarker: string | null;
  readonly wiMarkerSide: "before" | "after" | null;
  readonly orderValue: number;
  readonly disabled: boolean;
  readonly constant: boolean;
  readonly selective: boolean;
  readonly groupName: string;
  readonly groupOverride: boolean;
  readonly groupWeight: number;
  readonly probability: number;
  readonly scanDepth: number | null;
  readonly excludeGreeting: boolean;
  readonly caseSensitive: boolean;
  readonly matchWholeWords: boolean;
  readonly useRegex: boolean;
  readonly preventRecursion: boolean;
  readonly excludeRecursion: boolean;
  readonly delayUntilRecursion: boolean;
  readonly priority: number;
  readonly sticky: number;
  readonly cooldown: number;
  readonly delay: number;
  readonly selectiveLogic: number;
  readonly useProbability: boolean;
  readonly vectorized: boolean;
  readonly content: string;
  readonly comment: string;
  readonly keys: readonly string[];
  readonly secondaryKeys: readonly string[];
  readonly position: number;
  readonly depth: number;
  readonly role: string | null;
}

/**
 * Hash only source-owned World Info fields. Collector order, turn activation,
 * and per-turn state belong to the finalized projection, not the mutation
 * fence. Content participates only through this digest, so revision evidence
 * does not disclose it.
 */
export function worldInfoEntrySourceDigest(entry: WorldInfoEntrySourceAuthorityV1): string {
  const sourceAuthority = {
    id: entry.id,
    bookId: entry.bookId,
    source: entry.source,
    uid: entry.uid,
    outletName: entry.outletName,
    wiMarker: entry.wiMarker,
    wiMarkerSide: entry.wiMarkerSide,
    orderValue: entry.orderValue,
    disabled: entry.disabled,
    constant: entry.constant,
    selective: entry.selective,
    groupName: entry.groupName,
    groupOverride: entry.groupOverride,
    groupWeight: entry.groupWeight,
    probability: entry.probability,
    scanDepth: entry.scanDepth,
    excludeGreeting: entry.excludeGreeting,
    caseSensitive: entry.caseSensitive,
    matchWholeWords: entry.matchWholeWords,
    useRegex: entry.useRegex,
    preventRecursion: entry.preventRecursion,
    excludeRecursion: entry.excludeRecursion,
    delayUntilRecursion: entry.delayUntilRecursion,
    priority: entry.priority,
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
    selectiveLogic: entry.selectiveLogic,
    useProbability: entry.useProbability,
    vectorized: entry.vectorized,
    content: entry.content,
    comment: entry.comment,
    keys: entry.keys,
    secondaryKeys: entry.secondaryKeys,
    position: entry.position,
    depth: entry.depth,
    role: entry.role || null,
  };
  return createHash("sha256").update(encodeCanonicalPlainData(sourceAuthority), "utf8").digest("hex");
}

export function storedWorldInfoEntrySourceDigest(
  entry: WorldBookEntry,
  source: WorldInfoEntrySourceAuthorityV1["source"],
): string {
  return worldInfoEntrySourceDigest({
    id: entry.id,
    bookId: entry.world_book_id,
    source,
    uid: entry.uid,
    outletName: entry.outlet_name,
    wiMarker: entry.wi_marker,
    wiMarkerSide: entry.wi_marker_side,
    orderValue: entry.order_value,
    disabled: Boolean(entry.disabled),
    constant: Boolean(entry.constant),
    selective: Boolean(entry.selective),
    groupName: entry.group_name,
    groupOverride: Boolean(entry.group_override),
    groupWeight: entry.group_weight,
    probability: entry.probability,
    scanDepth: entry.scan_depth,
    excludeGreeting: Boolean(entry.exclude_greeting),
    caseSensitive: Boolean(entry.case_sensitive),
    matchWholeWords: Boolean(entry.match_whole_words),
    useRegex: Boolean(entry.use_regex),
    preventRecursion: Boolean(entry.prevent_recursion),
    excludeRecursion: Boolean(entry.exclude_recursion),
    delayUntilRecursion: Boolean(entry.delay_until_recursion),
    priority: entry.priority,
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
    selectiveLogic: entry.selective_logic,
    useProbability: Boolean(entry.use_probability),
    vectorized: Boolean(entry.vectorized),
    content: entry.content,
    comment: entry.comment,
    keys: entry.key,
    secondaryKeys: entry.keysecondary,
    position: entry.position,
    depth: entry.depth,
    role: entry.role,
  });
}
