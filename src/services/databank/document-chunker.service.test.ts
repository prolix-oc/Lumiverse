import { describe, expect, test } from "bun:test";
import { chunkDocument } from "./document-chunker.service";

describe("chunkDocument", () => {
  test("metadata offsets identify the exact source text", () => {
    const text = "Intro text.\n\n## Details\nFirst paragraph.\n\nSecond paragraph.";
    const chunks = chunkDocument(text, { targetTokens: 2, maxTokens: 4, overlapTokens: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(text.slice(chunk.metadata.startOffset, chunk.metadata.endOffset)).toBe(chunk.content);
    }
  });

  test("splits overlong sentences without exceeding maxTokens", () => {
    const text = `## Words\n${"word ".repeat(40).trim()}`;
    const chunks = chunkDocument(text, { targetTokens: 4, maxTokens: 8, overlapTokens: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(8);
      expect(chunk.tokenCount).toBe(Math.ceil(chunk.content.split(/\s+/).length * 1.33));
      expect(text.slice(chunk.metadata.startOffset, chunk.metadata.endOffset)).toBe(chunk.content);
    }
  });

  test("clamps overlap below the target so chunks always make progress", () => {
    const text = Array.from({ length: 40 }, (_, i) => `paragraph-${i}`).join("\n\n");
    const chunks = chunkDocument(text, { targetTokens: 4, maxTokens: 8, overlapTokens: 8 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(new Set(chunks.map((chunk) => chunk.content)).size).toBe(chunks.length);
  });

  test("normalizes an impractically small max token limit", () => {
    const chunks = chunkDocument("one two three", { targetTokens: 1, maxTokens: 1, overlapTokens: 1 });

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.tokenCount <= 2)).toBe(true);
  });

  test("does not carry stale overlap across an overlong sentence", () => {
    const sentence = `${"word ".repeat(1500).trim()}.`;
    const text = `Intro sentence. ${sentence} Final sentence.`;
    const chunks = chunkDocument(text);

    expect(chunks[0].content).toBe("Intro sentence.");
    expect(chunks.at(-1)!.content).toBe("Final sentence.");
    expect(chunks.slice(1, -1).map((chunk) => chunk.content).join(" ")).toBe(sentence);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(1600);
      expect(chunk.tokenCount).toBe(Math.ceil(chunk.content.split(/\s+/).length * 1.33));
      expect(text.slice(chunk.metadata.startOffset, chunk.metadata.endOffset)).toBe(chunk.content);
    }
  });

  test("does not emit stale overlap after a final overlong sentence", () => {
    const sentence = `${"word ".repeat(1500).trim()}.`;
    const chunks = chunkDocument(`Intro sentence. ${sentence}`);

    expect(chunks[0].content).toBe("Intro sentence.");
    expect(chunks.slice(1).map((chunk) => chunk.content).join(" ")).toBe(sentence);
  });

  test("sentence offsets exclude trailing whitespace before line breaks", () => {
    for (const lineBreak of ["\n", "\r\n"]) {
      const text = `  First line \t ${lineBreak}${"word ".repeat(10).trim()}`;
      const chunks = chunkDocument(text, { targetTokens: 4, maxTokens: 6, overlapTokens: 0 });

      expect(chunks[0].content).toBe("First line");
      expect(chunks[0].metadata.startOffset).toBe(2);
      expect(chunks[0].metadata.endOffset).toBe(12);
      for (const chunk of chunks) {
        expect(text.slice(chunk.metadata.startOffset, chunk.metadata.endOffset)).toBe(chunk.content);
      }
    }
  });

  test("splits large unpunctuated documents without losing words or source whitespace", () => {
    const text = Array.from({ length: 100_000 }, (_, i) => `word${i}`).join(" \t ");
    const chunks = chunkDocument(text);
    const words = chunks.flatMap((chunk) => chunk.content.split(/\s+/));

    expect(words).toEqual(text.split(/\s+/));
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(1600);
      expect(chunk.tokenCount).toBe(Math.ceil(chunk.content.split(/\s+/).length * 1.33));
      expect(text.slice(chunk.metadata.startOffset, chunk.metadata.endOffset)).toBe(chunk.content);
    }
  });
});
