import { describe, expect, test } from "bun:test";
import { extractMentionSlugs, stripMentions } from "./mention-resolver.service";

describe("extractMentionSlugs", () => {
  test("extracts a basic slug", () => {
    const slugs = extractMentionSlugs("please read #foo and respond");
    expect(slugs.has("foo")).toBe(true);
    expect(slugs.size).toBe(1);
  });

  test("returns empty set when message has no '#' character", () => {
    expect(extractMentionSlugs("nothing to see here").size).toBe(0);
  });

  test("dedupes repeated slugs in the same message", () => {
    const slugs = extractMentionSlugs("#foo and #foo and #foo again");
    expect(slugs.size).toBe(1);
    expect(slugs.has("foo")).toBe(true);
  });

  test("captures multiple distinct slugs", () => {
    const slugs = extractMentionSlugs("compare #alpha-doc with #beta and #gamma-3");
    expect(slugs.size).toBe(3);
    expect(slugs.has("alpha-doc")).toBe(true);
    expect(slugs.has("beta")).toBe(true);
    expect(slugs.has("gamma-3")).toBe(true);
  });

  test("matches at start of string", () => {
    const slugs = extractMentionSlugs("#first-thing then talk");
    expect(slugs.has("first-thing")).toBe(true);
  });

  test("ignores hash characters not preceded by whitespace", () => {
    // "C#" or "abc#foo" are not mentions
    const slugs = extractMentionSlugs("I love C#programming and abc#foo");
    expect(slugs.size).toBe(0);
  });

  test("lowercases captured slugs", () => {
    const slugs = extractMentionSlugs("look at #FooBar");
    expect(slugs.has("foobar")).toBe(true);
  });
});

describe("stripMentions", () => {
  test("removes resolved slug while preserving surrounding text", () => {
    const out = stripMentions("please read #foo and respond", new Set(["foo"]));
    expect(out).toBe("please read and respond");
  });

  test("leaves unresolved slugs alone", () => {
    const out = stripMentions("read #foo but not #bar", new Set(["foo"]));
    expect(out).toBe("read but not #bar");
  });

  test("removes multiple instances of the same slug", () => {
    const out = stripMentions("#foo and #foo again", new Set(["foo"]));
    expect(out).toBe("and again");
  });

  test("returns input unchanged when no '#' is present", () => {
    const out = stripMentions("nothing here", new Set(["foo"]));
    expect(out).toBe("nothing here");
  });

  test("returns input unchanged when validSlugs is empty", () => {
    const out = stripMentions("read #foo please", new Set());
    expect(out).toBe("read #foo please");
  });

  test("strips longer slug exactly when present in validSlugs", () => {
    const out = stripMentions("read #foo-bar please", new Set(["foo-bar"]));
    expect(out).toBe("read please");
  });
});
