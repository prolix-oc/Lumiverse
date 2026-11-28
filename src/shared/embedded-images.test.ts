import { describe, expect, test } from "bun:test";
import { characterEmbeddedImageUrls, extractImageUrls, replaceEmbeddedImageUrls } from "./embedded-images";

describe("embedded image sources", () => {
  test("reads titles, balanced URLs, HTML entities, unquoted sources and CSS backgrounds", () => {
    expect(extractImageUrls([
      '![Scene](https://cdn.example.com/scene_(1).png "A title")',
      '![Portrait](<https://cdn.example.com/render?id=1>)',
      '<IMG SRC = "https://cdn.example.com/render?id=2&amp;size=full">',
      '<img src=https://cdn.example.com/portrait>',
      '<style>.notes { background: url("https://cdn.example.com/background") }</style>',
    ].join("\n"))).toEqual([
      "https://cdn.example.com/scene_(1).png", "https://cdn.example.com/render?id=1",
      "https://cdn.example.com/render?id=2&size=full", "https://cdn.example.com/portrait",
      "https://cdn.example.com/background",
    ]);
  });

  test("replaces complete sources without damaging markup or longer URLs", () => {
    const url = "https://cdn.example.com/image.png";
    expect(replaceEmbeddedImageUrls([
      `![Scene](${url} "A title")`,
      `<img class="scene" src="${url}" style="width:50%">`,
      `A different image: ${url}?version=2.`,
      `<img src="https://cdn.example.com/render?a=1&amp;b=2">`,
    ].join("\n"), new Map([
      [url, "gallery://image-1"],
      ["https://cdn.example.com/render?a=1&b=2", "gallery://image-2"],
    ]))).toBe([
      '![Scene](gallery://image-1 "A title")',
      '<img class="scene" src="gallery://image-1" style="width:50%">',
      `A different image: ${url}?version=2.`,
      '<img src="gallery://image-2">',
    ].join("\n"));
  });

  test("includes creator notes and nested extension strings while ignoring local sources", () => {
    expect(characterEmbeddedImageUrls({
      creator_notes: '![Notes](https://example.com/notes)',
      extensions: { nested: [{ html: '<img src="https://example.com/extension">', enabled: true }] },
      first_mes: '![Local](gallery://image-1) <img src="/api/v1/images/local">',
    })).toEqual(["https://example.com/notes", "https://example.com/extension"]);
  });
});
