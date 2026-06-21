import { describe, expect, test } from "bun:test";
import {
  sanitizeForVectorization,
  stripHtmlFormattingTags,
  stripNonProseTags,
} from "./content-sanitizer";

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

  test("strips scaffold tags and their content", () => {
    expect(sanitizeForVectorization("Prose. <status>HP: 100/100\nMP: 50/50</status> More prose.")).toBe(
      "Prose. More prose.",
    );
    expect(sanitizeForVectorization("Before <hud>Level: 5 | XP: 1200</hud> after")).toBe(
      "Before after",
    );
    expect(sanitizeForVectorization("Text <dice>3d6: 14</dice> rest")).toBe(
      "Text rest",
    );
    expect(sanitizeForVectorization("A <inventory>sword, shield</inventory> B")).toBe(
      "A B",
    );
    expect(sanitizeForVectorization("Narrative <tool_call>function(args)</tool_call> continues")).toBe(
      "Narrative continues",
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

  test("strips non-font tags AND their inner content (strict prose mode)", () => {
    // Authored prose is expected to be top-level text. Any wrapping is treated
    // as scaffolding/UI/visual element and gets removed wholesale.
    expect(
      stripNonProseTags("A <b>bold</b> and <span>plain</span> and <em>italic</em>.", {
        keepFontTags: true,
      }),
    ).toBe("A and and .");
  });

  test("preserves inline formatting INSIDE a font block as plain text", () => {
    // Emphasis tags nested inside an authored font color block should still
    // pass through as text, otherwise we'd lose color-attributed prose.
    expect(
      stripNonProseTags(
        '<font color="#ff00ff">Hello, said <b>Juniper</b> calmly.</font>',
        { keepFontTags: true },
      ),
    ).toBe('<font color="#ff00ff">Hello, said Juniper calmly.</font>');
  });

  test("removes div/p UI wrappers and any font inside them", () => {
    // User example: a structural wrapper indicates a UI/visual element. The
    // whole block — including a font tag living inside it — gets stripped.
    const input = '<div class="thing-in-message">\ncontent in here <p> doesn\'t matter what kind </p> <font> get it out </font>\n</div>';
    expect(stripNonProseTags(input, { keepFontTags: true })).toBe("");
  });

  test("preserves a top-level font block while killing a sibling UI block", () => {
    const input = '<div class="badge">UI noise</div> <font color="#abc">colored prose</font> trailing text.';
    expect(stripNonProseTags(input, { keepFontTags: true })).toBe(
      '<font color="#abc">colored prose</font> trailing text.',
    );
  });

  test("strips Spindle extension XML tags and their inner content", () => {
    const input = 'Prose before. <spindle_game_state>HP: 50/100\nMana: 30</spindle_game_state> Prose after.';
    expect(stripNonProseTags(input, { keepFontTags: true })).toBe(
      "Prose before. Prose after.",
    );
  });

  test("strips Spindle tags nested inside a loom narrative block", () => {
    // loom_state preserves inner text (tag markers stripped), then the
    // aggressive pass catches the now-top-level extension tags.
    const input = 'Intro. <loom_state>Context. <ext_tracker>HP: 50</ext_tracker> More context.</loom_state> End.';
    expect(stripNonProseTags(input, { keepFontTags: true })).toBe(
      "Intro. Context. More context. End.",
    );
  });

  test("strips self-closing and attribute-bearing extension tags", () => {
    const input = 'A. <ext_ping status="ready" /> B. <ext_data type="json">{"key":"val"}</ext_data> C.';
    expect(stripNonProseTags(input, { keepFontTags: true })).toBe("A. B. C.");
  });
});

describe("stripHtmlFormattingTags", () => {
  test("removes block-level HTML islands and preserves inline formatted prose", () => {
    const input = [
      'I say <font color="#8B7355">"Y-yeah, that\'s me."</font>',
      '<div class="html-island">',
      '  <div class="title">linked_list.cpp</div>',
      '  <pre><code>head = newNode&nbsp;</code></pre>',
      '  <div class="problems">expected \';\' after expression</div>',
      '</div>',
      '<span>*Still nervous.*</span>',
    ].join("\n");

    const stripped = stripHtmlFormattingTags(input);

    expect(stripped).toContain('<font color="#8B7355">"Y-yeah, that\'s me."</font>');
    expect(stripped).toContain("*Still nervous.*");
    expect(stripped).not.toMatch(/\n{3,}/);
    expect(stripped).not.toContain("linked_list.cpp");
    expect(stripped).not.toContain("head = newNode");
    expect(stripped).not.toContain("expected ';' after expression");
  });
});
