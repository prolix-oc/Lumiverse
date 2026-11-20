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

  test("preserves fenced content without temporary healing markers", () => {
    const input = 'Use this exactly:\n```json\n{ "example": "* softly*", "tag": "<font color=#abc>" }\n```\n\nThen * softly*.';
    expect(healFormattingArtifacts(input)).toBe(
      'Use this exactly:\n```json\n{ "example": "* softly*", "tag": "<font color=#abc>" }\n```\n\nThen *softly*.',
    );
  });

  test("leaves valid <json> blocks untouched while healing the prose around them", () => {
    const block = '<json>{"say": " padded ", "act": "* softly*"}</json>';
    expect(healFormattingArtifacts(`He said, " like this" ${block} then * softly*.`))
      .toBe(`He said, "like this" ${block} then *softly*.`);
    // Not JSON, so it is ordinary prose.
    expect(healFormattingArtifacts('<json>" padded " text</json>')).toBe('<json>"padded" text</json>');
  });

  test("heals a block inside a macro tag with the rest of the tag", () => {
    // The macro pass reads that block as the tag's text, not as data.
    const block = '<json>{"act": "* softly*"}</json>';
    expect(healFormattingArtifacts(`{{setvar::note::${block}}} ${block}`)).toBe(
      `{{setvar::note::<json>{"act": "*softly*"}</json>}} ${block}`,
    );
  });

  test("leaves the text past the block scan's rejection cap as written", () => {
    // The block scan never classified that text, so it may be data.
    const strays = "<json>bad</json>".repeat(256);
    const rest = '<json>{"act": "* softly*"}</json> then * softly*.';
    expect(healFormattingArtifacts(`* softly* ${strays}${rest}`)).toBe(`*softly* ${strays}${rest}`);
  });

  test("leaves nested emphasis patterns alone", () => {
    expect(healFormattingArtifacts("*outer *inner**")).toBe("*outer *inner**");
  });
});
