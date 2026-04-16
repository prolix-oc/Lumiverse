/**
 * Databank Mention Resolver — Resolves #document-name references in user messages.
 *
 * Extracts #slug patterns, looks up documents in active scope, fetches content
 * (full text if small, relevant chunks if large), and returns cleaned message
 * plus resolved document blocks for prompt injection.
 */

import * as crud from "./databank-crud.service";
import * as embeddingsSvc from "../embeddings.service";
import { resolveActiveDatabankIds } from "./scope-resolver.service";
import type { ResolvedMention } from "./types";

/** Regex matching #slug in user messages. Slug = lowercase alphanumeric + hyphens. */
const MENTION_PATTERN = /(?:^|\s)#([a-z0-9][a-z0-9-]*)/gi;

/** Max tokens for direct document injection. Above this, use vector search. */
const DIRECT_INJECT_TOKEN_BUDGET = 2000;

/** Approximate token count for budget check. */
function approxTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.33);
}

export interface MentionResolutionResult {
  /** User message content with #mentions stripped */
  cleanedContent: string;
  /** Resolved documents ready for prompt injection */
  resolvedDocuments: ResolvedMention[];
}

/**
 * Scan a message for #slug mentions and resolve them to document content.
 *
 * @param userId - Current user
 * @param messageContent - The raw user message text
 * @param chatId - Current chat (for scope resolution)
 * @param characterIds - Character(s) in chat (for scope resolution)
 * @param contextForQuery - Recent message text for building vector queries when docs are large
 */
export async function resolveMentions(
  userId: string,
  messageContent: string,
  chatId: string,
  characterIds: string | string[],
  contextForQuery?: string,
): Promise<MentionResolutionResult> {
  // Extract all #slug mentions
  const mentions = new Set<string>();
  let match: RegExpExecArray | null;
  const regex = new RegExp(MENTION_PATTERN.source, MENTION_PATTERN.flags);

  while ((match = regex.exec(messageContent)) !== null) {
    mentions.add(match[1].toLowerCase());
  }

  if (mentions.size === 0) {
    return { cleanedContent: messageContent, resolvedDocuments: [] };
  }

  // Resolve active banks for scope filtering
  const activeBankIds = resolveActiveDatabankIds(userId, chatId, characterIds);

  const resolvedDocuments: ResolvedMention[] = [];
  let cleanedContent = messageContent;

  for (const slug of mentions) {
    // Look up document by slug
    const doc = crud.getDocumentBySlug(userId, slug);
    if (!doc) continue;

    // Verify the document belongs to an active bank
    if (!activeBankIds.includes(doc.databankId)) continue;

    // Fetch content
    const fullText = crud.getFullDocumentText(userId, doc.id);
    if (!fullText) continue;

    let content: string;
    let truncated = false;

    if (approxTokens(fullText) <= DIRECT_INJECT_TOKEN_BUDGET) {
      // Small document — inject in full
      content = fullText;
    } else {
      // Large document — use vector search over its chunks
      truncated = true;
      try {
        const queryText = contextForQuery || messageContent;
        const [queryVector] = await embeddingsSvc.cachedEmbedTexts(userId, [queryText]);
        const results = await embeddingsSvc.searchDatabankChunks(
          userId,
          [doc.databankId],
          queryVector,
          4,
          queryText,
        );
        // Filter to only this document's chunks via metadata
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
          : fullText.slice(0, 3000); // Fallback: first ~3000 chars
      } catch {
        content = fullText.slice(0, 3000);
      }
    }

    resolvedDocuments.push({
      slug,
      documentName: doc.name,
      content,
      truncated,
    });

    // Strip the #mention from the message (preserve surrounding text)
    cleanedContent = cleanedContent.replace(
      new RegExp(`(^|\\s)#${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"),
      "$1",
    );
  }

  // Clean up extra whitespace from removals
  cleanedContent = cleanedContent.replace(/\s{2,}/g, " ").trim();

  return { cleanedContent, resolvedDocuments };
}

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
