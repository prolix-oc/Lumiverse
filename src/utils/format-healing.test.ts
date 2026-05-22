import { describe, expect, test } from "bun:test";
import { healFormattingArtifacts } from "./format-healing";

describe("healFormattingArtifacts", () => {
  test("trims accidental spaces just inside emphasis delimiters", () => {
    expect(healFormattingArtifacts("She leaned in — * softly*.")).toBe("She leaned in — *softly*.");
    expect(healFormattingArtifacts("She leaned in — *softly *." )).toBe("She leaned in — *softly*.");
    expect(healFormattingArtifacts("She leaned in — ** softly **.")).toBe("She leaned in — **softly**.");
  });

  test("repairs quoted font-tag boundaries conservatively", () => {
    expect(healFormattingArtifacts('<font color=#abc>"Hello</font>"')).toBe('<font color=#abc>"Hello"</font>');
    expect(healFormattingArtifacts('<span style="color:#abc">"Hello</span>"')).toBe('<span style="color:#abc">"Hello"</span>');
  });

  test("trims accidental spaces just inside prose quotes", () => {
    expect(healFormattingArtifacts('He said, " like this"')).toBe('He said, "like this"');
    expect(healFormattingArtifacts('He said, "like this "')).toBe('He said, "like this"');
    expect(healFormattingArtifacts('He said, “ like this ”')).toBe('He said, “like this”');
  });

  test("does not touch fenced or inline code", () => {
    expect(healFormattingArtifacts("`* softly*` and * softly*" )).toBe("`* softly*` and *softly*");
    expect(healFormattingArtifacts("```\n* softly*\n```\n\n* softly*" )).toBe("```\n* softly*\n```\n\n*softly*");
  });

  test("leaves nested emphasis patterns alone", () => {
    expect(healFormattingArtifacts("*outer *inner**")).toBe("*outer *inner**");
  });
});
