/**
 * Document Chunker Service — Splits parsed text into token-bounded chunks.
 *
 * Prefers splitting at paragraph, line, then sentence boundaries.
 * Section-aware for markdown headers (attaches header as chunk metadata).
 */

export interface ChunkResult {
  index: number;
  content: string;
  tokenCount: number;
  metadata: {
    startOffset: number;
    endOffset: number;
    sectionHeader?: string;
  };
}

export interface ChunkOptions {
  targetTokens?: number;
  maxTokens?: number;
  overlapTokens?: number;
}

const DEFAULT_TARGET = 800;
const DEFAULT_MAX = 1600;
const DEFAULT_OVERLAP = 120;

/** Approximate token count: ~1 token per 0.75 words. Fast and synchronous. */
function approxTokens(text: string): number {
  if (!text) return 0;
  // Count whitespace-separated words, approximate at ~1.33 tokens per word
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.33);
}

/**
 * Split document text into chunks suitable for embedding.
 */
export function chunkDocument(text: string, options?: ChunkOptions): ChunkResult[] {
  const target = options?.targetTokens ?? DEFAULT_TARGET;
  const max = options?.maxTokens ?? DEFAULT_MAX;
  const overlap = options?.overlapTokens ?? DEFAULT_OVERLAP;

  if (!text.trim()) return [];

  // Split into sections by markdown headers
  const sections = splitBySections(text);
  const chunks: ChunkResult[] = [];
  let globalOffset = 0;

  for (const section of sections) {
    const sectionChunks = chunkSection(section.content, section.header, globalOffset, target, max, overlap);
    chunks.push(...sectionChunks);
    globalOffset += section.content.length;
  }

  // Re-index
  return chunks.map((c, i) => ({ ...c, index: i }));
}

interface Section {
  header?: string;
  content: string;
}

function splitBySections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let currentHeader: string | undefined;
  let currentLines: string[] = [];

  for (const line of lines) {
    // Match markdown headers: # Title, ## Title, ### Title
    const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      // Flush previous section
      if (currentLines.length > 0) {
        sections.push({ header: currentHeader, content: currentLines.join("\n") });
        currentLines = [];
      }
      currentHeader = headerMatch[2].trim();
      currentLines.push(line);
    } else {
      currentLines.push(line);
    }
  }

  // Flush final section
  if (currentLines.length > 0) {
    sections.push({ header: currentHeader, content: currentLines.join("\n") });
  }

  // If no headers found, return as single section
  if (sections.length === 0) {
    sections.push({ content: text });
  }

  return sections;
}

function chunkSection(
  text: string,
  sectionHeader: string | undefined,
  baseOffset: number,
  target: number,
  max: number,
  overlap: number,
): ChunkResult[] {
  const totalTokens = approxTokens(text);
  if (totalTokens <= target) {
    return [{
      index: 0,
      content: text.trim(),
      tokenCount: totalTokens,
      metadata: { startOffset: baseOffset, endOffset: baseOffset + text.length, sectionHeader },
    }];
  }

  // Split into paragraphs first
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  const chunks: ChunkResult[] = [];
  let currentParts: string[] = [];
  let currentTokens = 0;
  let chunkStartOffset = baseOffset;

  const flushChunk = () => {
    if (currentParts.length === 0) return;
    const content = currentParts.join("\n\n").trim();
    if (content) {
      chunks.push({
        index: chunks.length,
        content,
        tokenCount: currentTokens,
        metadata: {
          startOffset: chunkStartOffset,
          endOffset: chunkStartOffset + content.length,
          sectionHeader,
        },
      });
    }
    // Apply overlap: keep last part(s) whose tokens fit in overlap budget
    const overlapParts: string[] = [];
    let overlapCount = 0;
    for (let i = currentParts.length - 1; i >= 0; i--) {
      const partTokens = approxTokens(currentParts[i]);
      if (overlapCount + partTokens > overlap) break;
      overlapParts.unshift(currentParts[i]);
      overlapCount += partTokens;
    }
    chunkStartOffset += content.length;
    currentParts = overlapParts;
    currentTokens = overlapCount;
  };

  for (const para of paragraphs) {
    const paraTokens = approxTokens(para);

    // If single paragraph exceeds max, split by sentences
    if (paraTokens > max) {
      flushChunk();
      const sentenceChunks = splitLargeParagraph(para, target, max, overlap, chunkStartOffset, sectionHeader);
      chunks.push(...sentenceChunks.map((c, i) => ({ ...c, index: chunks.length + i })));
      chunkStartOffset += para.length;
      currentParts = [];
      currentTokens = 0;
      continue;
    }

    if (currentTokens + paraTokens > target && currentParts.length > 0) {
      flushChunk();
    }

    currentParts.push(para);
    currentTokens += paraTokens;

    if (currentTokens >= max) {
      flushChunk();
    }
  }

  flushChunk();
  return chunks;
}

function splitLargeParagraph(
  text: string,
  target: number,
  max: number,
  overlap: number,
  baseOffset: number,
  sectionHeader?: string,
): ChunkResult[] {
  // Split by sentences. Avoid breaking on common abbreviations (Dr., Mr., Mrs.,
  // Ms., Prof., Inc., Ltd., Jr., Sr., St., vs., etc., e.g., i.e.), decimal
  // numbers (3.14), and domain-like patterns (example.com).
  const sentences = text
    .split(/(?<![A-Z][a-z]?)(?<!\b(?:Dr|Mr|Mrs|Ms|Prof|Inc|Ltd|Jr|Sr|St|vs|etc|e\.g|i\.e))(?<!\d)(?<=[.!?])\s+|\n/)
    .filter((s) => s.trim());
  const chunks: ChunkResult[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length === 0) return;
    const content = current.join(" ").trim();
    if (content) {
      chunks.push({
        index: chunks.length,
        content,
        tokenCount: currentTokens,
        metadata: { startOffset: baseOffset, endOffset: baseOffset + content.length, sectionHeader },
      });
    }
    // Overlap: keep last sentence(s)
    const overlapSentences: string[] = [];
    let oc = 0;
    for (let i = current.length - 1; i >= 0; i--) {
      const st = approxTokens(current[i]);
      if (oc + st > overlap) break;
      overlapSentences.unshift(current[i]);
      oc += st;
    }
    baseOffset += content.length;
    current = overlapSentences;
    currentTokens = oc;
  };

  for (const sentence of sentences) {
    const st = approxTokens(sentence);

    // If single sentence exceeds max, just add it as its own chunk
    if (st > max) {
      flush();
      chunks.push({
        index: chunks.length,
        content: sentence.trim(),
        tokenCount: st,
        metadata: { startOffset: baseOffset, endOffset: baseOffset + sentence.length, sectionHeader },
      });
      baseOffset += sentence.length;
      continue;
    }

    if (currentTokens + st > target && current.length > 0) {
      flush();
    }

    current.push(sentence);
    currentTokens += st;
  }

  flush();
  return chunks;
}
