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
const TOKENS_PER_WORD = 1.33;

/** Approximate token count: ~1 token per 0.75 words. Fast and synchronous. */
function approxTokens(text: string): number {
  if (!text) return 0;
  // Count whitespace-separated words, approximate at ~1.33 tokens per word
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * TOKENS_PER_WORD);
}

/**
 * Split document text into chunks suitable for embedding.
 */
export function chunkDocument(text: string, options?: ChunkOptions): ChunkResult[] {
  const max = Math.max(2, options?.maxTokens ?? DEFAULT_MAX);
  const target = Math.min(max, Math.max(1, options?.targetTokens ?? DEFAULT_TARGET));
  const overlap = Math.min(max, Math.max(0, Math.min(target - 1, options?.overlapTokens ?? DEFAULT_OVERLAP)));

  if (!text.trim()) return [];

  // Split into sections by markdown headers
  const sections = splitBySections(text);
  const chunks: ChunkResult[] = [];
  for (const section of sections) {
    const sectionChunks = chunkSection(section.content, section.header, section.startOffset, target, max, overlap);
    chunks.push(...sectionChunks);
  }

  // Re-index
  return chunks.map((c, i) => ({ ...c, index: i }));
}

interface Section {
  header?: string;
  content: string;
  startOffset: number;
}

function splitBySections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let currentHeader: string | undefined;
  let sectionStart = 0;
  let offset = 0;

  for (const line of lines) {
    // Match markdown headers: # Title, ## Title, ### Title
    const headerMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      // Flush previous section
      if (offset > sectionStart) {
        sections.push({ header: currentHeader, content: text.slice(sectionStart, offset - 1), startOffset: sectionStart });
      }
      currentHeader = headerMatch[2].trim();
      sectionStart = offset;
    }
    offset += line.length + 1;
  }

  // Flush final section
  if (sectionStart < text.length) {
    sections.push({ header: currentHeader, content: text.slice(sectionStart), startOffset: sectionStart });
  }

  // If no headers found, return as single section
  if (sections.length === 0) {
    sections.push({ content: text, startOffset: 0 });
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
    const leading = text.length - text.trimStart().length;
    const content = text.trim();
    return [{
      index: 0,
      content,
      tokenCount: approxTokens(content),
      metadata: { startOffset: baseOffset + leading, endOffset: baseOffset + leading + content.length, sectionHeader },
    }];
  }

  // Split into paragraphs first
  const paragraphs = [...text.matchAll(/\S[\s\S]*?(?=\n\s*\n|$)/g)].map((match) => {
    const raw = match[0];
    const leading = raw.length - raw.trimStart().length;
    const content = raw.trim();
    const start = baseOffset + (match.index ?? 0) + leading;
    return { content, start, end: start + content.length };
  }).filter((paragraph) => paragraph.content !== "");
  const chunks: ChunkResult[] = [];
  let currentParts: { content: string; start: number; end: number }[] = [];
  let currentTokens = 0;

  const flushChunk = () => {
    if (currentParts.length === 0) return;
    const startOffset = currentParts[0].start;
    const endOffset = currentParts[currentParts.length - 1].end;
    const content = text.slice(startOffset - baseOffset, endOffset - baseOffset).trim();
    if (content) {
      chunks.push({
        index: chunks.length,
        content,
        tokenCount: currentTokens,
        metadata: {
          startOffset,
          endOffset,
          sectionHeader,
        },
      });
    }
    // Apply overlap: keep last part(s) whose tokens fit in overlap budget
    const overlapParts: typeof currentParts = [];
    let overlapCount = 0;
    for (let i = currentParts.length - 1; i >= 0; i--) {
      const partTokens = approxTokens(currentParts[i].content);
      if (overlapCount + partTokens > overlap) break;
      overlapParts.unshift(currentParts[i]);
      overlapCount += partTokens;
    }
    currentParts = overlapParts;
    currentTokens = overlapCount;
  };

  for (const para of paragraphs) {
    const paraTokens = approxTokens(para.content);

    // If single paragraph exceeds max, split by sentences
    if (paraTokens > max) {
      flushChunk();
      const sentenceChunks = splitLargeParagraph(para.content, target, max, overlap, para.start, sectionHeader);
      chunks.push(...sentenceChunks.map((c, i) => ({ ...c, index: chunks.length + i })));
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
  const sentencePattern = /(?<![A-Z][a-z]?)(?<!\b(?:Dr|Mr|Mrs|Ms|Prof|Inc|Ltd|Jr|Sr|St|vs|etc|e\.g|i\.e))(?<!\d)(?<=[.!?])\s+|\n/;
  const sentences: { content: string; start: number; end: number }[] = [];
  let sentenceStart = 0;
  for (const match of text.matchAll(new RegExp(sentencePattern.source, "g"))) {
    const separatorStart = match.index ?? 0;
    const raw = text.slice(sentenceStart, separatorStart);
    const leading = raw.length - raw.trimStart().length;
    const content = raw.trim();
    const start = baseOffset + sentenceStart + leading;
    if (content) sentences.push({ content, start, end: start + content.length });
    sentenceStart = separatorStart + match[0].length;
  }
  const tail = text.slice(sentenceStart);
  if (tail.trim()) {
    const leading = tail.length - tail.trimStart().length;
    const content = tail.trim();
    sentences.push({ content, start: baseOffset + sentenceStart + leading, end: baseOffset + sentenceStart + leading + content.length });
  }
  const chunks: ChunkResult[] = [];
  let current: { content: string; start: number; end: number }[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length === 0) return;
    const startOffset = current[0].start;
    const endOffset = current[current.length - 1].end;
    const content = text.slice(startOffset - baseOffset, endOffset - baseOffset).trim();
    if (content) {
      chunks.push({
        index: chunks.length,
        content,
        tokenCount: currentTokens,
        metadata: { startOffset, endOffset, sectionHeader },
      });
    }
    // Overlap: keep last sentence(s)
    const overlapSentences: typeof current = [];
    let oc = 0;
    for (let i = current.length - 1; i >= 0; i--) {
      const st = approxTokens(current[i].content);
      if (oc + st > overlap) break;
      overlapSentences.unshift(current[i]);
      oc += st;
    }
    current = overlapSentences;
    currentTokens = oc;
  };

  for (const sentence of sentences) {
    const st = approxTokens(sentence.content);

    // Split overlong sentences at word boundaries so every chunk stays within max.
    if (st > max) {
      flush();
      // Separately emitted chunks break the span covered by retained overlap.
      current = [];
      currentTokens = 0;
      const words = [...sentence.content.matchAll(/\S+/g)];
      const maxWords = Math.max(1, Math.floor(max / TOKENS_PER_WORD));
      for (let startWord = 0; startWord < words.length; startWord += maxWords) {
        const endWord = Math.min(words.length, startWord + maxWords);
        const start = words[startWord].index!;
        const end = words[endWord - 1].index! + words[endWord - 1][0].length;
        const content = sentence.content.slice(start, end);
        chunks.push({
          index: chunks.length,
          content,
          tokenCount: Math.ceil((endWord - startWord) * TOKENS_PER_WORD),
          metadata: { startOffset: sentence.start + start, endOffset: sentence.start + end, sectionHeader },
        });
      }
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
