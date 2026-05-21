import { describe, expect, test } from "bun:test";
import { sanitizeForVectorization, stripNonProseTags } from "./content-sanitizer";

describe("sanitizeForVectorization", () => {
  test("preserves text inside common HTML formatting wrappers", () => {
    expect(sanitizeForVectorization('Before <font color="#ff0000">hidden text</font> after')).toBe(
      "Before hidden text after",
    );
    expect(sanitizeForVectorization("<p>First paragraph.</p><p>Second paragraph.</p>")).toBe(
      "First paragraph.\n\nSecond paragraph.",
    );
  });

  test("removes details blocks and reasoning while keeping surrounding content", () => {
    expect(sanitizeForVectorization("Visible <details>private note</details> still visible")).toBe("Visible still visible");
    expect(sanitizeForVectorization("A<details>private note</details>B")).toBe("A B");
    expect(sanitizeForVectorization("Answer <think>chain of thought</think> done")).toBe("Answer done");
  });

  test("strips unknown XML-like wrappers without dropping their content", () => {
    expect(sanitizeForVectorization("A <custom-tag attr=\"x\">wrapped fact</custom-tag> B")).toBe(
      "A wrapped fact B",
    );
  });
});

describe("stripNonProseTags", () => {
  test("removes <details> blocks and their content", () => {
    expect(stripNonProseTags("Visible <details>private note</details> still visible")).toBe(
      "Visible still visible",
    );
  });

  test("removes lumia_ooc blocks and their content", () => {
    expect(stripNonProseTags("Prose. <lumia_ooc>director note about scene</lumia_ooc> More prose.")).toBe(
      "Prose. More prose.",
    );
    expect(stripNonProseTags("Prose. <lumiaooc>variant</lumiaooc> rest.")).toBe("Prose. rest.");
  });

  test("removes reasoning blocks", () => {
    expect(stripNonProseTags("Answer <think>chain of thought</think> done")).toBe("Answer done");
  });

  test("strips font tags by default", () => {
    expect(stripNonProseTags('Before <font color="#ff0000">red text</font> after')).toBe(
      "Before red text after",
    );
  });

  test("preserves font tags when keepFontTags is set", () => {
    expect(
      stripNonProseTags('Before <font color="#ff0000">red text</font> after', { keepFontTags: true }),
    ).toBe('Before <font color="#ff0000">red text</font> after');
  });

  test("preserves color span tags when keepFontTags is set", () => {
    expect(
      stripNonProseTags(
        'Before <span style="color: #abc">tinted</span> after',
        { keepFontTags: true },
      ),
    ).toBe('Before <span style="color: #abc">tinted</span> after');
  });

  test("kills font tags that live inside a non-prose block even when keepFontTags is set", () => {
    expect(
      stripNonProseTags(
        'Prose. <details><font color="#fff">hidden colored note</font></details> More.',
        { keepFontTags: true },
      ),
    ).toBe("Prose. More.");
    expect(
      stripNonProseTags(
        'Prose. <lumia_ooc><font color="#fff">director colored note</font></lumia_ooc> More.',
        { keepFontTags: true },
      ),
    ).toBe("Prose. More.");
  });

  test("strips non-color spans and other HTML wrappers while preserving inner text", () => {
    expect(
      stripNonProseTags("A <b>bold</b> and <span>plain</span> and <em>italic</em>.", {
        keepFontTags: true,
      }),
    ).toBe("A bold and plain and italic.");
  });
});
