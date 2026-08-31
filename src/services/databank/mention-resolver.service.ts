/**
 * Databank Mention Resolver — Resolves #document-name references in chat history.
 *
 * Refactored to a batch-oriented API so prompt assembly can:
 *   1. Extract slugs from every user message (pure regex)
 *   2. Look up the union of slugs once (single sync pass — no duplicate DB hits)
 *   3. Strip resolved #mentions from every message in history (pure string ops)
 *   4. Run the expensive content fetch + vector search ONLY for the last user
 *      message's slugs (the only ones that contribute to the appendix)
 *
 * Heavy resolution results are cached for 5 minutes by user/chat, sorted
 * document identities, and query context so unchanged regens/swipes reuse work
 * while document or scope changes cannot return stale content.
 */

import { getDb } from "../../db/connection";
import * as crud from "./databank-crud.service";
import * as embeddingsSvc from "../embeddings.service";
import {
  rowToDocument,
  type DatabankDocument,
  type DatabankDocumentRow,
  type ResolvedMention,
} from "./types";
import {
  clearResolveCache as clearResolveCacheStore,
  getResolveCache,
  getResolveCacheVersion,
  setResolveCache,
} from "./mention-resolve-cache.service";

/** Regex matching #slug in user messages. Slug = lowercase alphanumeric + hyphens. */
const MENTION_PATTERN = /(?:^|\s)#([a-z0-9][a-z0-9-]*)/gi;

/** Max tokens for direct document injection. Above this, use vector search. */
const DIRECT_INJECT_TOKEN_BUDGET = 2000;

/** Approximate token count for budget check. */
function approxTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.33);
}

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
 * Sync batch lookup against the caller's already-resolved active databank IDs.
 * The lookup independently enforces ownership, enabled banks, ready documents,
 * and materialized chunks so malformed or stale callers fail closed.
 */
export function lookupSlugsInScope(
  userId: string,
  slugs: Iterable<string>,
  activeBankIds: readonly string[],
): SlugLookupResult {
  const validSlugs = new Set<string>();
  const docs = new Map<string, DatabankDocument>();
  const slugArr = [...new Set(Array.from(slugs, (slug) => slug.toLowerCase()).filter(Boolean))];
  const bankIds = [...new Set(activeBankIds.filter(Boolean))];
  if (slugArr.length === 0 || bankIds.length === 0) return { validSlugs, docs };

  const slugPlaceholders = slugArr.map(() => "?").join(",");
  const bankPlaceholders = bankIds.map(() => "?").join(",");
  const rows = getDb().query(
    `SELECT dd.*
       FROM databank_documents dd
       JOIN databanks d
         ON d.id = dd.databank_id
        AND d.user_id = dd.user_id
      WHERE dd.user_id = ?
        AND d.user_id = ?
        AND d.enabled = 1
        AND dd.status = 'ready'
        AND dd.total_chunks > 0
        AND dd.slug IN (${slugPlaceholders})
        AND dd.databank_id IN (${bankPlaceholders})
        AND EXISTS (
          SELECT 1
            FROM databank_chunks dc
           WHERE dc.document_id = dd.id
             AND dc.databank_id = dd.databank_id
             AND dc.user_id = dd.user_id
        )
      ORDER BY dd.updated_at DESC, dd.id ASC`,
  ).all(userId, userId, ...slugArr, ...bankIds) as DatabankDocumentRow[];

  for (const row of rows) {
    if (docs.has(row.slug)) continue;
    validSlugs.add(row.slug);
    docs.set(row.slug, rowToDocument(row));
  }
  return { validSlugs, docs };
}

// ─── Heavy Resolution (async, cached) ─────────────────────────

const RESOLVE_CACHE_MAX_ENTRIES = 256;

interface ResolveCacheIndexEntry {
  userId: string;
  chatId: string;
}

// Metadata-only LRU index for the versioned cache store. Results remain owned
// by mention-resolve-cache.service so mutation-version invalidation has a
// single authoritative cache.
const resolveCacheIndex = new Map<string, ResolveCacheIndexEntry>();
function resolveCacheKey(
  userId: string,
  chatId: string,
  slugs: Iterable<string>,
  docs: Map<string, DatabankDocument>,
  queryContext: string,
): string {
  const identities = Array.from(slugs)
    .sort()
    .map((slug) => {
      const doc = docs.get(slug);
      return [
        slug,
        doc?.id ?? "",
        doc?.databankId ?? "",
        doc?.name ?? "",
        doc?.contentHash ?? "",
        doc?.status ?? "",
        doc?.updatedAt ?? 0,
      ];
    });
  return `${userId}:${chatId}:${Bun.hash(JSON.stringify(identities)).toString(36)}:${Bun.hash(queryContext).toString(36)}`;
}

/** Drop cached resolutions for a user+chat (e.g. after a doc update). */
export function clearResolveCache(userId: string, chatId: string): void {
  clearIndexedResolveCacheScope(userId, chatId);
}

/** Drop all reconstructable mention resolutions. */
export function clearAllResolveCache(): void {
  const scopes = new Map<string, ResolveCacheIndexEntry>();
  for (const entry of resolveCacheIndex.values()) {
    scopes.set(`${entry.userId}:${entry.chatId}`, entry);
  }
  for (const { userId, chatId } of scopes.values()) {
    clearResolveCacheStore(userId, chatId);
  }
  resolveCacheIndex.clear();
}

function forgetResolveCacheScope(userId: string, chatId: string): void {
  for (const [key, entry] of resolveCacheIndex) {
    if (entry.userId === userId && entry.chatId === chatId) resolveCacheIndex.delete(key);
  }
}

function clearIndexedResolveCacheScope(userId: string, chatId: string): void {
  clearResolveCacheStore(userId, chatId);
  forgetResolveCacheScope(userId, chatId);
}

function cacheResolvedMentions(
  key: string,
  result: ResolvedMention[],
  userId: string,
  chatId: string,
  expectedVersion: string,
): void {
  if (getResolveCacheVersion(userId, chatId) !== expectedVersion) return;
  resolveCacheIndex.delete(key);
  while (resolveCacheIndex.size >= RESOLVE_CACHE_MAX_ENTRIES) {
    const oldest = resolveCacheIndex.values().next().value;
    if (!oldest) break;
    clearIndexedResolveCacheScope(oldest.userId, oldest.chatId);
  }
  setResolveCache(key, result, userId, chatId, expectedVersion);
  if (getResolveCacheVersion(userId, chatId) === expectedVersion) {
    resolveCacheIndex.set(key, { userId, chatId });
  }
}

export const __mentionResolveCacheTest = {
  clear: clearAllResolveCache,
  keys: (): string[] => [...resolveCacheIndex.keys()],
  set: (key: string, result: ResolvedMention[]): void => {
    const [userId, chatId] = key.split(":");
    if (!userId || !chatId) throw new Error("Mention cache test key must include user and chat IDs");
    cacheResolvedMentions(key, result, userId, chatId, getResolveCacheVersion(userId, chatId));
  },
  size: (): number => resolveCacheIndex.size,
};

/**
 * Resolve a set of slugs to their injectable content.
 *  - Small docs (≤ DIRECT_INJECT_TOKEN_BUDGET): full text inline.
 *  - Large docs: a single vector search against the slug's databank, filtered
 *    to the document's chunks; falls back to the first ~3000 chars if no
 *    chunks return.
 *
 * Cached for 5 min by user/chat, document identities, and query context so
 * regens/swipes skip embedding and LanceDB work only while inputs are unchanged.
 */
export async function resolveSlugContent(
  userId: string,
  chatId: string,
  slugs: Iterable<string>,
  docs: Map<string, DatabankDocument>,
  queryContext: string,
  signal?: AbortSignal,
): Promise<ResolvedMention[]> {
  const slugArr = Array.from(slugs).filter((s) => docs.has(s));
  if (slugArr.length === 0) return [];

  const key = resolveCacheKey(userId, chatId, slugArr, docs, queryContext);
  const cacheVersion = getResolveCacheVersion(userId, chatId);
  const cached = getResolveCache(key);
  if (!cached) {
    resolveCacheIndex.delete(key);
  } else {
    const indexed = resolveCacheIndex.get(key);
    if (indexed) {
      resolveCacheIndex.delete(key);
      resolveCacheIndex.set(key, indexed);
    }
    return cached;
  }
  const resolved: ResolvedMention[] = [];
  // Embedded lazily on the first large-doc miss, then reused for the rest of
  // the batch — every large-doc search in a single call uses the same
  // queryContext, so we only need one embedding round trip.
  let queryVector: number[] | null = null;

  for (const slug of slugArr) {
    if (signal?.aborted) break;
    const doc = docs.get(slug)!;
    const fullText = crud.getFullDocumentText(userId, doc.id);
    if (!fullText) continue;

    let content: string;
    let truncated = false;

    if (approxTokens(fullText) <= DIRECT_INJECT_TOKEN_BUDGET) {
      content = fullText;
    } else {
      truncated = true;
      try {
        if (!queryVector) {
          const [v] = await embeddingsSvc.cachedEmbedTexts(
            userId,
            [queryContext],
            { signal, inputType: "query" },
          );
          if (signal?.aborted) break;
          queryVector = v;
        }
        const results = await embeddingsSvc.searchDatabankChunks(
          userId,
          [doc.databankId],
          queryVector,
          4,
          queryContext,
          signal,
        );
        const docResults = results.filter((r) => {
          try {
            const meta = typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata;
            return meta?.documentId === doc.id;
          } catch {
            return false;
          }
        });
        content = docResults.length > 0
          ? docResults.map((r) => r.content).join("\n---\n")
          : fullText.slice(0, 3000);
      } catch {
        content = fullText.slice(0, 3000);
    }
  }

    resolved.push({
      slug,
      documentName: doc.name,
      content,
      truncated,
    });
  }

  if (!signal?.aborted) {
    cacheResolvedMentions(
      key,
      resolved,
      userId,
      chatId,
      cacheVersion,
    );
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
