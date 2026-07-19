import { describe, expect, test } from "bun:test"
import {
  getRegexSearchEnd,
  getRequiredTerminalLiteral,
  replaceWithinRegexSearchWindow,
} from "./search-window"

const SOCIAL_LINKS_PATTERN = String.raw`\[METER\|${String.raw`([^\]|]+)\|`.repeat(20)}([^\]|]+)\]([\s\S]*?)\[\/METER\]`

describe("regex terminal-literal search window", () => {
  test("extracts the Social Links closing delimiter conservatively", () => {
    expect(getRequiredTerminalLiteral(SOCIAL_LINKS_PATTERN)).toBe("[/METER]")
    expect(getRequiredTerminalLiteral("foo|bar[/METER]")).toBeNull()
    expect(getRequiredTerminalLiteral(String.raw`foo.*END+`)).toBeNull()
    expect(getRequiredTerminalLiteral(String.raw`(?<word>x)\k<word>ENDING`)).toBe("ENDING")
  })

  test("preserves native replacement results", () => {
    const cases = [
      {
        pattern: String.raw`foo([a-z]+)ENDING`,
        flags: "g",
        input: "foooneENDING tail footwo-without-ending",
        replacement: "[$1]",
      },
      {
        pattern: String.raw`foo([a-z]+)ENDING`,
        flags: "gi",
        input: "FOOoneending tail FOOtwo-without-ending",
        replacement: "[$1]",
      },
      {
        pattern: String.raw`(?:foo|bar)([a-z]+)ENDING`,
        flags: "g",
        input: "fooaENDING barbENDING trailing foo",
        replacement: "$1-$`",
      },
    ]

    for (const { pattern, flags, input, replacement } of cases) {
      const expected = input.replace(new RegExp(pattern, flags), replacement)
      const actual = replaceWithinRegexSearchWindow(
        input,
        new RegExp(pattern, flags),
        pattern,
        flags,
        replacement,
        replacement,
      )
      expect(actual).toBe(expected)
    }
  })

  test("does not truncate when the replacement uses the full suffix token", () => {
    const input = "fooENDING trailing text"
    expect(getRegexSearchEnd(input, "fooENDING", "g", "$'")).toBe(input.length)
  })

  test("excludes a large unterminated Social Links tail from regex execution", () => {
    const fields = Array.from({ length: 21 }, (_, index) => `field${index + 1}`).join("|")
    const valid = `[METER|${fields}]body[/METER]`
    const incomplete = `[METER|${fields}]${"body ".repeat(5)}`
    const input = valid + incomplete.repeat(3_000)
    const searchEnd = getRegexSearchEnd(input, SOCIAL_LINKS_PATTERN, "gi", "<$1>")

    expect(searchEnd).toBe(valid.length)
    const output = replaceWithinRegexSearchWindow(
      input,
      new RegExp(SOCIAL_LINKS_PATTERN, "gi"),
      SOCIAL_LINKS_PATTERN,
      "gi",
      "<$1>",
      "<$1>",
    )
    expect(output).toBe(`<field1>${incomplete.repeat(3_000)}`)
  })
})
