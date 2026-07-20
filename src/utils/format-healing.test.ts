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

  test("closes unterminated font tags at completed dialogue and action boundaries", () => {
    expect(healFormattingArtifacts('<font color="aaabbb>"Hey there." They said.'))
      .toBe('<font color="aaabbb">"Hey there."</font> They said.');
    expect(healFormattingArtifacts('<font color=xxxxxx>"Hey hey!" <font color=baabaa>*They look great today.*'))
      .toBe('<font color=xxxxxx>"Hey hey!"</font> <font color=baabaa>*They look great today.*</font>');
  });

  test("leaves balanced font tags unchanged", () => {
    const input = '<font color=#abc>"Hello."</font> <font color=#def>*She smiled.*</font>';
    expect(healFormattingArtifacts(input)).toBe(input);
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
