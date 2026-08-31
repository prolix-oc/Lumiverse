import { createHash } from "node:crypto";
import { getDb } from "../../db/connection";
import * as embeddingsSvc from "../embeddings.service";
import * as crud from "./databank-crud.service";
import {
  extractMentionSlugs,
  formatMentionsAsAppendix,
  lookupSlugsInScope,
  resolveSlugContent,
  stripMentions,
} from "./mention-resolver.service";
import {
  getCachedDatabankResult,
  searchDatabanks,
} from "./retrieval.service";
import { loadDatabankSettings } from "./databank-settings.service";
import { resolvePersistedActiveDatabankIds } from "./scope-resolver.service";
import type {
  DatabankDocument,
  DatabankRetrievalResult,
  ResolvedMention,
} from "./types";
import type {
  SnapshotDatabankChunkV1,
  SnapshotDatabankMentionV1,
  SnapshotDatabankProvenanceV1,
  SnapshotDatabankV1,
} from "../prompt-assembly-snapshot.service";

const encoder = new TextEncoder();
const MAX_MENTION_COUNT = 64;
const MAX_AUTOMATIC_CHUNKS = 20;
// Native history treats JSON true and legacy numeric 1 as hidden. Invalid or
// non-object extra payloads hydrate as visible, so keep the SQL predicate equal.
const VISIBLE_MESSAGE_SQL = `CASE
  WHEN json_valid(m.extra) THEN json_extract(m.extra, '$.hidden')
END IS NOT 1`;
const EMPTY_PROJECTION: SnapshotDatabankV1 = Object.freeze({
  enabled: false,
  activeBankIds: Object.freeze([]),
  automaticChunks: Object.freeze([]),
  automaticFormatted: "",
  mentions: Object.freeze([]),
  strippedUserInput: "",
  mentionAppendix: "",
  provenance: Object.freeze([]),
});

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clampUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || bytes(value) <= maxBytes) return maxBytes <= 0 ? "" : value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && bytes(value.slice(0, end)) > maxBytes) end = Math.max(0, Math.floor(end * 0.9));
  while (end < value.length && bytes(value.slice(0, end + 1)) <= maxBytes) end += 1;
  return value.slice(0, end);
}
function selectedMessageContent(row: {
  readonly content?: unknown;
  readonly swipes?: unknown;
  readonly swipe_id?: unknown;
} | null): string {
  const fallback = typeof row?.content === "string" ? row.content : "";
  if (typeof row?.swipes !== "string" || !Number.isSafeInteger(row.swipe_id)) return fallback;
  try {
    const swipes: unknown = JSON.parse(row.swipes);
    return Array.isArray(swipes) && typeof swipes[row.swipe_id as number] === "string"
      ? swipes[row.swipe_id as number] as string
      : fallback;
  } catch {
    return fallback;
  }
}
function latestUserInput(userId: string, chatId: string): string {
  const row = getDb().query(
    `SELECT m.content, m.swipes, m.swipe_id
       FROM messages m
       JOIN chats c ON c.id = m.chat_id
      WHERE m.chat_id = ? AND c.user_id = ? AND m.is_user = 1
        AND (${VISIBLE_MESSAGE_SQL})
      ORDER BY m.index_in_chat DESC, m.id DESC
      LIMIT 1`,
  ).get(chatId, userId) as {
    content?: unknown;
    swipes?: unknown;
    swipe_id?: unknown;
  } | null;
  return selectedMessageContent(row);
}


function emptyProjection(userInput = ""): SnapshotDatabankV1 {
  return Object.freeze({
    ...EMPTY_PROJECTION,
    strippedUserInput: userInput,
  });
}

function source(
  kind: SnapshotDatabankProvenanceV1["kind"],
  value: {
    databankId: string;
    documentId: string;
    documentName: string;
    content: string;
    chunkId?: string | null;
    documentContentHash?: string | null;
  },
): SnapshotDatabankProvenanceV1 {
  return Object.freeze({
    kind,
    databankId: value.databankId,
    documentId: value.documentId,
    documentName: value.documentName,
    chunkId: value.chunkId ?? null,
    documentContentHash: value.documentContentHash ?? null,
    contentHash: sha256(value.content),
  });
}

function automaticFormatted(chunks: readonly SnapshotDatabankChunkV1[]): string {
  if (chunks.length === 0) return "";
  const sections = chunks.map((chunk) => `[Source: ${chunk.documentName}]\n${chunk.content}`);
  return `[Relevant reference material from the user's knowledge bank]\n${sections.join("\n---\n")}`;
}
function recentQueryText(
  userId: string,
  chatId: string,
  userInput: string,
  excludedMessageId: string | null | undefined,
  maxBytes: number,
): string {
  try {
    const rows = getDb().query(
      `SELECT m.content, m.swipes, m.swipe_id
         FROM messages m
         JOIN chats c ON c.id = m.chat_id
        WHERE m.chat_id = ? AND c.user_id = ? AND (? IS NULL OR m.id <> ?)
          AND (${VISIBLE_MESSAGE_SQL})
        ORDER BY m.index_in_chat DESC, m.id DESC
        LIMIT 6`,
    ).all(
      chatId,
      userId,
      excludedMessageId ?? null,
      excludedMessageId ?? null,
    ) as Array<{ content?: unknown; swipes?: unknown; swipe_id?: unknown }>;
    const selectedHistory = rows
      .reverse()
      .map((row) => selectedMessageContent(row))
      .filter(Boolean);
    if (userInput && selectedHistory[selectedHistory.length - 1] !== userInput) {
      selectedHistory.push(userInput);
    }
    return clampUtf8(selectedHistory.join(" "), maxBytes);
  } catch {
    // The retrieval service remains best-effort, just like native Response.
    return clampUtf8(userInput, maxBytes);
  }
}
function hydrateAutomaticChunks(
  userId: string,
  activeBankIds: readonly string[],
  result: DatabankRetrievalResult,
  maxBytes: number,
): { chunks: readonly SnapshotDatabankChunkV1[]; provenance: readonly SnapshotDatabankProvenanceV1[] } {
  const active = new Set(activeBankIds);
  const chunks: SnapshotDatabankChunkV1[] = [];
  const provenance: SnapshotDatabankProvenanceV1[] = [];
  let totalBytes = 0;
  for (const raw of result.chunks.slice(0, MAX_AUTOMATIC_CHUNKS)) {
    if (!raw || typeof raw.content !== "string" || raw.content.length === 0) continue;
    if (!active.has(raw.databankId) || !raw.documentId || !raw.chunkId) continue;
    const document = crud.getDocument(userId, raw.documentId);
    const liveChunk = getDb().query(
      "SELECT document_id, databank_id, content FROM databank_chunks WHERE id = ? AND user_id = ? LIMIT 1",
    ).get(raw.chunkId, userId) as {
      document_id?: unknown;
      databank_id?: unknown;
      content?: unknown;
    } | null;
    if (
      !document
      || document.status !== "ready"
      || document.databankId !== raw.databankId
      || liveChunk?.document_id !== raw.documentId
      || liveChunk.databank_id !== raw.databankId
      || typeof liveChunk.content !== "string"
      || liveChunk.content !== raw.content
    ) {
      continue;
    }
    const documentName = document.name;
    const framing = chunks.length === 0
      ? `[Relevant reference material from the user's knowledge bank]\n[Source: ${documentName}]\n`
      : `\n---\n[Source: ${documentName}]\n`;
    const remainingBytes = maxBytes - totalBytes - bytes(framing);
    if (remainingBytes <= 0) break;
    const content = clampUtf8(liveChunk.content, Math.min(remainingBytes, 2 * 1024 * 1024));
    if (!content) break;
    totalBytes += bytes(framing) + bytes(content);
    const item: SnapshotDatabankChunkV1 = Object.freeze({
      chunkId: raw.chunkId,
      documentId: raw.documentId,
      databankId: raw.databankId,
      documentName,
      content,
      score: typeof raw.score === "number" && Number.isFinite(raw.score) ? raw.score : null,
      documentContentHash: document?.contentHash ?? null,
      contentHash: sha256(content),
    });
    chunks.push(item);
    provenance.push(source("automatic", {
      databankId: item.databankId,
      documentId: item.documentId,
      documentName: item.documentName,
      content: item.content,
      chunkId: item.chunkId,
      documentContentHash: item.documentContentHash,
    }));
  }
  return { chunks: Object.freeze(chunks), provenance: Object.freeze(provenance) };
}

function hydrateMentions(
  docs: Map<string, DatabankDocument>,
  resolved: readonly ResolvedMention[],
  maxBytes: number,
): { mentions: readonly SnapshotDatabankMentionV1[]; provenance: readonly SnapshotDatabankProvenanceV1[] } {
  const mentions: SnapshotDatabankMentionV1[] = [];
  const provenance: SnapshotDatabankProvenanceV1[] = [];
  let totalBytes = 0;
  for (const item of resolved.slice(0, MAX_MENTION_COUNT)) {
    const doc = docs.get(item.slug);
    if (!doc || !item.content) continue;
    const content = clampUtf8(item.content, Math.min(maxBytes, 2 * 1024 * 1024));
    const nextBytes = totalBytes + bytes(content);
    if (nextBytes > maxBytes && mentions.length > 0) break;
    totalBytes = nextBytes;
    const mention: SnapshotDatabankMentionV1 = Object.freeze({
      slug: item.slug,
      documentId: doc.id,
      databankId: doc.databankId,
      documentName: item.documentName || doc.name,
      content,
      truncated: item.truncated,
      documentContentHash: doc.contentHash,
      contentHash: sha256(content),
    });
    mentions.push(mention);
    provenance.push(source("mention", {
      databankId: mention.databankId,
      documentId: mention.documentId,
      documentName: mention.documentName,
      content: mention.content,
      documentContentHash: mention.documentContentHash,
    }));
  }
  return { mentions: Object.freeze(mentions), provenance: Object.freeze(provenance) };
}

/**
 * Resolve the live native Databank surface before entering Agentic's strict
 * snapshot boundary. This wrapper deliberately delegates scope, vector search,
 * slug lookup, sizing, and formatting to the native services; the result is a
 * bounded immutable observation with owned source revisions.
 */
export async function resolveAgenticDatabankProjection(input: {
  readonly userId: string;
  readonly chatId: string;
  readonly targetCharacterId?: string | null;
  readonly userInput?: string;
  readonly excludedMessageId?: string | null;
  readonly signal?: AbortSignal;
  readonly maxBytes?: number;
}): Promise<SnapshotDatabankV1> {
  let userInput = typeof input.userInput === "string" ? input.userInput : "";
  if (userInput.length === 0) {
    userInput = latestUserInput(input.userId, input.chatId);
  }
  const maxBytes = Math.max(1, Math.min(input.maxBytes ?? 8 * 1024 * 1024, 8 * 1024 * 1024));
  if (input.signal?.aborted) return emptyProjection(userInput);
  try {
    const activeBankIds = resolvePersistedActiveDatabankIds(
      input.userId,
      input.chatId,
      input.targetCharacterId ?? [],
    );
    const queryText = recentQueryText(
      input.userId,
      input.chatId,
      userInput,
      input.excludedMessageId,
      maxBytes,
    );
    const settings = loadDatabankSettings(input.userId);
    let automatic: DatabankRetrievalResult = { chunks: [], formatted: "", count: 0 };
    if (activeBankIds.length > 0 && (await embeddingsSvc.getEmbeddingConfig(input.userId)).enabled) {
      automatic = getCachedDatabankResult(
        input.userId,
        input.chatId,
        activeBankIds,
        queryText,
        settings.retrievalTopK,
      ) ?? await searchDatabanks(
        input.userId,
        input.chatId,
        activeBankIds,
        queryText,
        settings.retrievalTopK,
        input.signal,
      );
    }
    if (input.signal?.aborted) return emptyProjection(userInput);

    const automaticProjection = hydrateAutomaticChunks(input.userId, activeBankIds, automatic, maxBytes);
    const slugs = [...extractMentionSlugs(userInput)].slice(0, MAX_MENTION_COUNT);
    let validSlugs = new Set<string>();
    let docs = new Map<string, DatabankDocument>();
    if (slugs.length > 0 && activeBankIds.length > 0) {
      const lookup = lookupSlugsInScope(input.userId, slugs, activeBankIds);
      validSlugs = lookup.validSlugs;
      docs = lookup.docs;
    }
    const resolved = validSlugs.size > 0
      ? await resolveSlugContent(input.userId, input.chatId, validSlugs, docs, queryText, input.signal)
      : [];
    const mentionProjection = hydrateMentions(docs, resolved, maxBytes);
    const selectedSlugs = new Set(mentionProjection.mentions.map((mention) => mention.slug));
    const stripped = stripMentions(userInput, selectedSlugs);
    let mentions = mentionProjection.mentions;
    let appendix = formatMentionsAsAppendix(mentions.map((mention) => ({
      slug: mention.slug,
      documentName: mention.documentName,
      content: mention.content,
      truncated: mention.truncated,
    })));
    while (bytes(`${stripped}${appendix}`) > maxBytes && mentions.length > 0) {
      mentions = Object.freeze(mentions.slice(0, -1));
      appendix = formatMentionsAsAppendix(mentions.map((mention) => ({
        slug: mention.slug,
        documentName: mention.documentName,
        content: mention.content,
        truncated: mention.truncated,
      })));
    }
    const mentionSources = mentions.map((mention) => source("mention", {
      databankId: mention.databankId,
      documentId: mention.documentId,
      documentName: mention.documentName,
      content: mention.content,
      documentContentHash: mention.documentContentHash,
    }));
    const projection: SnapshotDatabankV1 = {
      enabled: activeBankIds.length > 0,
      activeBankIds: Object.freeze([...activeBankIds]),
      automaticChunks: automaticProjection.chunks,
      automaticFormatted: automaticFormatted(automaticProjection.chunks),
      mentions,
      strippedUserInput: stripped,
      mentionAppendix: appendix,
      provenance: Object.freeze([
        ...automaticProjection.provenance,
        ...mentionSources,
      ]),
    };
    return Object.freeze(projection);
  } catch (error) {
    if (!input.signal?.aborted) console.warn("[agentic] Native Databank projection unavailable:", error);
    return emptyProjection(userInput);
  }
}