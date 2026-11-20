import { describe, expect, test } from "bun:test";

import { maskWorldInfoScanExclusions } from "./world-info-scan-exclusion";

const fixtures: Array<{ name: string; input: string; scanned: string }> = [
  {
    name: "tag",
    input: "Rain falls. <wi-exclude>Zebulon waits.</wi-exclude> The road bends.",
    scanned: "Rain falls. The road bends.",
  },
  {
    name: "uppercase tag",
    input: "Rain. <WI-EXCLUDE>Zebulon</WI-Exclude> Road.",
    scanned: "Rain. Road.",
  },
  {
    name: "marker pair",
    input: "Rain. !--WI_EXCLUDE_START--!Zebulon!--WI_EXCLUDE_END--! Road.",
    scanned: "Rain. Road.",
  },
  {
    name: "unclosed marker",
    input: "Rain. !--WI_EXCLUDE_START--! Zebulon waits",
    scanned: "Rain.",
  },
  {
    name: "unclosed tag",
    input: "Rain. <wi-exclude>Zebulon waits",
    scanned: "Rain.",
  },
  {
    name: "attribute with nested same-name element",
    input: '<div class="tracker" wi-exclude><div>Off-scene: Zebulon</div><p>Mordecai</p></div>A dragon lands.',
    scanned: "A dragon lands.",
  },
  {
    name: "attribute with a false value among unquoted attributes",
    input: '<p id=tracker wi-exclude="false" data-x=1>Zebulon</p>Road.',
    scanned: "Road.",
  },
  {
    name: "uppercase attribute and element with nested lowercase element",
    input: "<DIV WI-EXCLUDE><div>Zebulon</div>Mordecai</DIV>Road.",
    scanned: "Road.",
  },
  {
    name: "void element",
    input: 'Rain <img wi-exclude alt="Bob"> Road',
    scanned: "Rain Road",
  },
  {
    name: "self-closing element",
    input: "Rain <span wi-exclude/>Road</span> end",
    scanned: "Rain Road</span> end",
  },
  {
    name: "element named like an Object.prototype key is not void",
    input: "<constructor wi-exclude>Zebulon</constructor> Road.",
    scanned: "Road.",
  },
  {
    name: "tags inside a marker region are inert",
    input: "!--WI_EXCLUDE_START--!<div wi-exclude>Zebulon!--WI_EXCLUDE_END--! Road.",
    scanned: "Road.",
  },
  {
    name: "two adjacent regions",
    input: "A <wi-exclude>Zebulon</wi-exclude><wi-exclude>Mordecai</wi-exclude> B",
    scanned: "A B",
  },
  {
    name: "data attribute is not an exclusion",
    input: "<div data-wi-exclude>Zebulon</div>",
    scanned: "<div data-wi-exclude>Zebulon</div>",
  },
  {
    name: "double-quoted attribute value is not an exclusion",
    input: '<span class="wi-exclude">Zebulon</span>',
    scanned: '<span class="wi-exclude">Zebulon</span>',
  },
  {
    name: "single-quoted attribute value is not an exclusion",
    input: "<b title='x wi-exclude'>Zebulon</b>",
    scanned: "<b title='x wi-exclude'>Zebulon</b>",
  },
  {
    name: "words around an exclusion do not fuse",
    input: "Bob<wi-exclude>x</wi-exclude>by",
    scanned: "Bob by",
  },
  {
    name: "stray end marker",
    input: "Rain !--WI_EXCLUDE_END--! Road",
    scanned: "Rain !--WI_EXCLUDE_END--! Road",
  },
  {
    name: "emoji inside an excluded span",
    input: "🐉 <wi-exclude>🐲 Zebulon</wi-exclude> dragon",
    scanned: "🐉 dragon",
  },
  {
    name: "quoted > inside an attribute value",
    input: '<span title="a > b" wi-exclude>Zebulon</span> Road',
    scanned: "Road",
  },
  {
    name: "unquoted attribute value is not an exclusion",
    input: "<span class = wi-exclude>Zebulon</span> Road",
    scanned: "<span class = wi-exclude>Zebulon</span> Road",
  },
  {
    name: "slash in an unquoted value does not self-close",
    input: "<a wi-exclude href=/x/>Zebulon</a> Road",
    scanned: "Road",
  },
  {
    name: "nested marker regions",
    input: "!--WI_EXCLUDE_START--!outer !--WI_EXCLUDE_START--!inner!--WI_EXCLUDE_END--! Zebulon!--WI_EXCLUDE_END--! Road",
    scanned: "Road",
  },
  {
    name: "unclosed outer marker region around a closed inner one",
    input: "Road !--WI_EXCLUDE_START--!outer !--WI_EXCLUDE_START--!inner!--WI_EXCLUDE_END--! Zebulon",
    scanned: "Road",
  },
  {
    name: "apostrophe in tag-like prose before an exclusion",
    input: "I <i don't know> <div wi-exclude>Zebulon</div> Road",
    scanned: "I <i don't know> Road",
  },
  {
    name: "tags inside an HTML comment are inert",
    input: "<div wi-exclude><!-- </div> --><span>Zebulon</span></div> Road",
    scanned: "Road",
  },
  {
    name: "a commented-out exclusion excludes nothing",
    input: "<!-- <div wi-exclude> --> Zebulon",
    scanned: "<!-- <div wi-exclude> --> Zebulon",
  },
  {
    name: "tag-like text in a raw-text body is inert",
    input: '<div wi-exclude><script>const s = "</div>";</script>Zebulon</div> Road',
    scanned: "Road",
  },
  {
    name: "an unterminated double quote hides a later attribute",
    input: '<span title="unfinished wi-exclude>Zebulon</span> Road',
    scanned: '<span title="unfinished wi-exclude>Zebulon</span> Road',
  },
  {
    name: "an unterminated single quote hides a later attribute",
    input: "<span title='unfinished wi-exclude>Zebulon</span> Road",
    scanned: "<span title='unfinished wi-exclude>Zebulon</span> Road",
  },
  {
    name: "an exclusion tag that never closes owns the rest of the message",
    input: 'Road <div wi-exclude title="unfinished>Zebulon</div> tail',
    scanned: "Road",
  },
  {
    name: "an unterminated double-quoted wi-exclude value still excludes",
    input: 'Road <div wi-exclude="unfinished>Zebulon</div> tail',
    scanned: "Road",
  },
  {
    name: "an unterminated single-quoted wi-exclude value still excludes",
    input: "Road <div wi-exclude='unfinished>Zebulon</div> tail",
    scanned: "Road",
  },
];

describe("maskWorldInfoScanExclusions", () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      const scanned = maskWorldInfoScanExclusions(fixture.input).replace(/\s+/g, " ").trim();
      expect(scanned).toBe(fixture.scanned);
    });
  }

  test("preserves UTF-16 length and only blanks code units", () => {
    for (const fixture of fixtures) {
      const masked = maskWorldInfoScanExclusions(fixture.input);
      if (masked === "") continue;
      expect(masked.length).toBe(fixture.input.length);
      for (let index = 0; index < masked.length; index++) {
        const unit = masked.charCodeAt(index);
        if (unit !== fixture.input.charCodeAt(index)) expect(unit).toBe(0x20);
      }
    }
  });

  test("returns the original string when nothing is excluded", () => {
    for (const input of ["A dragon lands.", "Use the wi-exclude attribute."]) {
      expect(maskWorldInfoScanExclusions(input)).toBe(input);
    }
  });

  test("returns an empty string for entirely excluded messages", () => {
    expect(maskWorldInfoScanExclusions("<wi-exclude>Off-scene: Zebulon</wi-exclude>")).toBe("");
    expect(maskWorldInfoScanExclusions("\n!--WI_EXCLUDE_START--!x")).toBe("");
  });

  test("stays linear on unterminated tag soup", () => {
    // A backtracking tag regex needs seconds here; the forward-only scan needs well under a millisecond.
    const inputs = [`wi-exclude <${"a".repeat(100_000)}`, `wi-exclude ${"<a ".repeat(35_000)}`];
    const started = performance.now();
    for (const input of inputs) expect(maskWorldInfoScanExclusions(input)).toBe(input);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
