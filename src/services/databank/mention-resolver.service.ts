/**
 * Databank Mention Resolver — Resolves #document-name references in chat history.
 *
 * Batch-oriented API so prompt assembly can:
 *   1. Extract slugs from every user message (pure regex)
 *   2. Look up the union of slugs once (single sync pass — no duplicate DB hits)
 *   3. Strip resolved #mentions from every message in history (pure string ops)
 *   4. Fetch the full content for the last user message's slugs (the only ones
 *      that contribute to the appendix)
 *
 * Resolution results are cached for 5 minutes so regens/swipes do not rebuild
 * the same document appendix. Explicit mentions always inject the entire
 * document; semantic chunk retrieval is reserved for automatic databank recall.
 */

import * as crud from "./databank-crud.service";
import { resolveActiveDatabankIds } from "./scope-resolver.service";
import type { DatabankDocument, ResolvedMention } from "./types";

/** Regex matching #slug in user messages. Slug = lowercase alphanumeric + hyphens. */
const MENTION_PATTERN = /(?:^|\s)#([a-z0-9][a-z0-9-]*)/gi;

// ─── Extraction & Stripping (pure) ────────────────────────────

/** Pull every unique #slug out of a single message. Pure regex, no I/O. */
export function extractMentionSlugs(content: string): Set<string> {
  const slugs = new Set<string>();
  if (!content.includes("#")) return slugs;
  const regex = new RegExp(MENTION_PATTERN.source, MENTION_PATTERN.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    slugs.add(match[1].toLowerCase());
  }
  return slugs;
}

/**
 * Remove `#slug` tokens (only those in `validSlugs`) from a message, preserving
 * the leading whitespace/start-of-string anchor. Collapses double spaces.
 */
export function stripMentions(content: string, validSlugs: Set<string>): string {
  if (validSlugs.size === 0 || !content.includes("#")) return content;
  let out = content;
  for (const slug of validSlugs) {
    out = out.replace(
      new RegExp(`(^|\\s)#${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"),
      "$1",
    );
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

// ─── Scope Lookup (sync) ──────────────────────────────────────

export interface SlugLookupResult {
  /** Slugs that resolved to a ready document in an active databank */
  validSlugs: Set<string>;
  /** Slug → document, only for valid slugs */
  docs: Map<string, DatabankDocument>;
}

/**
 * Sync batch lookup: for a deduped set of slugs, return the subset that maps
 * to ready documents in active databanks (plus the doc rows themselves).
 * One indexed SQL query per unique slug — cheap enough to call unconditionally.
 */
export function lookupSlugsInScope(
  userId: string,
  slugs: Iterable<string>,
  chatId: string,
  characterIds: string | string[],
): SlugLookupResult {
  const validSlugs = new Set<string>();
  const docs = new Map<string, DatabankDocument>();
  const slugArr = Array.from(slugs);
  if (slugArr.length === 0) return { validSlugs, docs };

  const activeBankIds = resolveActiveDatabankIds(userId, chatId, characterIds);
  if (activeBankIds.length === 0) return { validSlugs, docs };
  const activeBankSet = new Set(activeBankIds);

  for (const slug of slugArr) {
    const doc = crud.getDocumentBySlug(userId, slug);
    if (!doc) continue;
    if (!activeBankSet.has(doc.databankId)) continue;
    validSlugs.add(slug);
    docs.set(slug, doc);
  }
  return { validSlugs, docs };
}

// ─── Full-document Resolution (async, cached) ───────────────────

const RESOLVE_CACHE_TTL_MS = 5 * 60 * 1000;
const RESOLVE_CACHE_MAX_ENTRIES = 256;
const RESOLVE_CACHE_MAX_RESULT_CHARS = 256 * 1024;

interface CachedResolve {
  result: ResolvedMention[];
  cachedAt: number;
}

const resolveCache = new Map<string, CachedResolve>();

function resolveCacheKey(
  userId: string,
  chatId: string,
  slugs: Iterable<string>,
  docs: Map<string, DatabankDocument>,
): string {
  const versions = Array.from(slugs)
    .map((slug) => {
      const doc = docs.get(slug);
      return `${slug}:${doc?.id ?? ""}:${doc?.contentHash ?? ""}:${doc?.updatedAt ?? ""}`;
    })
    .sort()
    .join(",");
  return `${userId}:${chatId}:${Bun.hash(versions).toString(36)}`;
}

/** Drop cached resolutions for a user+chat (e.g. after a doc update). */
export function clearResolveCache(userId: string, chatId: string): void {
  const prefix = `${userId}:${chatId}:`;
  for (const key of resolveCache.keys()) {
    if (key.startsWith(prefix)) resolveCache.delete(key);
  }
}

/** Drop all reconstructable mention resolutions. */
export function clearAllResolveCache(): void {
  resolveCache.clear();
}

function cacheResolvedMentions(key: string, result: ResolvedMention[], now: number): void {
  // Full documents can be up to the upload limit. Avoid retaining a second
  // multi-megabyte copy solely for regen convenience.
  const resultChars = result.reduce((total, mention) => total + mention.content.length, 0);
  if (resultChars > RESOLVE_CACHE_MAX_RESULT_CHARS) {
    resolveCache.delete(key);
    return;
  }

  for (const [cachedKey, cached] of resolveCache) {
    if (now - cached.cachedAt > RESOLVE_CACHE_TTL_MS) resolveCache.delete(cachedKey);
  }
  resolveCache.delete(key);
  while (resolveCache.size >= RESOLVE_CACHE_MAX_ENTRIES) {
    const oldest = resolveCache.keys().next().value;
    if (oldest === undefined) break;
    resolveCache.delete(oldest);
  }
  resolveCache.set(key, { result, cachedAt: now });
}

export const __mentionResolveCacheTest = {
  clear: clearAllResolveCache,
  keys: (): string[] => [...resolveCache.keys()],
  set: (key: string, result: ResolvedMention[], cachedAt = Date.now()): void => {
    cacheResolvedMentions(key, result, cachedAt);
  },
  size: (): number => resolveCache.size,
};

/**
 * Resolve a set of slugs to their full injectable content.
 *
 * Explicit mentions are deterministic and bypass semantic retrieval. The
 * document identity, content hash, and update time are part of the cache key so
 * an edit cannot reuse an appendix built from an older document revision.
 */
export async function resolveSlugContent(
  userId: string,
  chatId: string,
  slugs: Iterable<string>,
  docs: Map<string, DatabankDocument>,
  signal?: AbortSignal,
): Promise<ResolvedMention[]> {
  const slugArr = Array.from(slugs).filter((s) => docs.has(s));
  if (slugArr.length === 0) return [];

  const key = resolveCacheKey(userId, chatId, slugArr, docs);
  const cached = resolveCache.get(key);
  if (cached && Date.now() - cached.cachedAt <= RESOLVE_CACHE_TTL_MS) {
    resolveCache.delete(key);
    resolveCache.set(key, cached);
    return cached.result;
  }
  if (cached) resolveCache.delete(key);

  const resolved: ResolvedMention[] = [];
  for (const slug of slugArr) {
    if (signal?.aborted) break;
    const doc = docs.get(slug)!;
    const fullText = crud.getFullDocumentText(userId, doc.id);
    if (!fullText) continue;

    resolved.push({
      slug,
      documentName: doc.name,
      content: fullText,
      truncated: false,
    });
  }

  if (!signal?.aborted) {
    cacheResolvedMentions(key, resolved, Date.now());
  }
  return resolved;
}

// ─── Formatting ───────────────────────────────────────────────

/**
 * Format resolved mentions as an appendix to the user message.
 * Returns a single string to be appended after the user's text with clear separation.
 */
export function formatMentionsAsAppendix(mentions: ResolvedMention[]): string {
  if (mentions.length === 0) return "";

  const docs = mentions.map((m) => {
    const truncNote = m.truncated ? " (most relevant excerpts)" : "";
    return `## ${m.documentName}${truncNote}\n${m.content}`;
  });

  return [
    "",
    "---",
    "",
    "# Additional Context",
    "The user has attached the following reference material for you to consider when responding.",
    "",
    docs.join("\n\n---\n\n"),
  ].join("\n");
}
