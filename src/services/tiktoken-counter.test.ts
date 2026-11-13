import { describe, expect, test } from "bun:test";
import { Tiktoken } from "js-tiktoken/lite";
import o200k from "js-tiktoken/ranks/o200k_base";
import { TiktokenCounter } from "./tiktoken-counter";

describe("count-only tiktoken", () => {
  test("matches the existing engine on multilingual, binary-fragment, and deterministic fuzz inputs", () => {
    const reference = new Tiktoken(o200k);
    const counter = new TiktokenCounter(o200k.bpe_ranks, o200k.pat_str, o200k.special_tokens);
    const samples = ["", "Hello world", "\r\n \t  ", "I'm YOU'RE He'S", "123456789012345", "你好世界这是中文", "こんにちは세계", "مرحبا بالعالم", "Привет мир", "Café e\u0301", "🧑🏽‍🚀👨‍👩‍👦🏳️‍🌈", "\u0000\ufeff\ud800", "\udfff", '<div class="main">x</div>', "const fn = (a, b) => a + b;", "x".repeat(1000)];
    let seed = 48271;
    const rand = () => { seed = Math.imul(seed, 16807) >>> 0; return seed; };
    for (let i = 0; i < 600; i++) {
      let text = "";
      for (let j = 0; j < 20; j++) text += samples[rand() % samples.length] + String.fromCharCode(rand() % 65536);
      expect(counter.count(text)).toBe(reference.encode(text).length);
    }
    for (const text of samples) {
      expect(counter.count(text)).toBe(reference.encode(text).length);
      expect(counter.count(text)).toBe(reference.encode(text).length);
    }
    for (const token of Object.keys(o200k.special_tokens)) {
      expect(() => counter.count(`prefix ${token} suffix`)).toThrow();
      expect(() => reference.encode(`prefix ${token} suffix`)).toThrow();
    }
  });

  test("standard and compressed vocabularies agree, including overlapping merges and leftmost ties", () => {
    const base = Array.from({ length: 256 }, (_, i) => Buffer.from([i]).toString("base64"));
    const tokens = [...base, ...["ab", "bc", "abc", "aa", "aaa", "aaaa", "aba", "你好", "你", "好"].map(s => Buffer.from(s).toString("base64"))];
    const standard = tokens.map((token, rank) => `${token} ${rank}`).join("\n") + "\n";
    const compressed = `! 0 ${tokens.join(" ")}`;
    const pattern = "[\\s\\S]+";
    const a = new TiktokenCounter(standard, pattern, {});
    const b = new TiktokenCounter(compressed, pattern, {});
    const reference = new Tiktoken({ pat_str: pattern, special_tokens: {}, bpe_ranks: compressed });
    for (const text of ["abcabc", "abababa", "aaaaaaa", "a".repeat(512), "你好你好", "abc\ud800\u0000你好", "👨‍👩‍👧‍👦"]) {
      expect(a.count(text)).toBe(reference.encode(text).length);
      expect(b.count(text)).toBe(reference.encode(text).length);
    }
    const tied = `! 0 ${base.join(" ")}\n! 256 YWI= YmM=\n! 256 YmE=`;
    const tiedReference = new Tiktoken({ pat_str: pattern, special_tokens: {}, bpe_ranks: tied });
    const tiedCounter = new TiktokenCounter(tied, pattern, {});
    for (const text of ["ababa", "ababab", "babcab", "abba"]) expect(tiedCounter.count(text)).toBe(tiedReference.encode(text).length);
  });

  test("rejects invalid vocabularies and preserves literal special-token matching", () => {
    expect(() => new TiktokenCounter("", ".+", {})).toThrow();
    expect(() => new TiktokenCounter("YQ== 0\nYg== 2\n", ".+", {})).toThrow();
    expect(() => new TiktokenCounter("not a tokenizer", ".+", {})).toThrow();
    const counter = new TiktokenCounter("YQ== 0\n", ".+", { "[x].*": 10 });
    expect(counter.count("a")).toBe(1);
    const incomplete = new Tiktoken({ pat_str: ".+", special_tokens: {}, bpe_ranks: "! 0 YQ==" });
    for (const text of ["x", "xx", "ax", "é"]) expect(counter.count(text)).toBe(incomplete.encode(text).length);
    expect(() => counter.count("[x].*")).toThrow();
    expect(() => counter.count("xx")).not.toThrow();
  });
});
