import { getRegexSearchEnd } from "../frontend/src/lib/regex/search-window"

interface LegacyRegexScript {
  findRegex: string
  replaceString: string
}

const sourcePath = Bun.argv[2] ?? `${process.env.HOME}/Downloads/regex-social_links.json`
const sourceFile = Bun.file(sourcePath)
const fallbackPattern = String.raw`\[METER\|${String.raw`([^\]|]+)\|`.repeat(20)}([^\]|]+)\]([\s\S]*?)\[\/METER\]`
const fallbackReplacement = `$1${"x".repeat(28_398)}`
const script = await sourceFile.exists()
  ? await sourceFile.json() as LegacyRegexScript
  : { findRegex: fallbackPattern, replaceString: fallbackReplacement }
const flags = "gi"
const fields = Array.from({ length: 21 }, (_, index) => `field${index + 1}`).join("|")
const validCard = `[METER|${fields}]body text[/METER]`
const incompleteCard = `[METER|${fields}]${"body text ".repeat(5)}`
const boundedPattern = script.findRegex.replace(
  String.raw`([\s\S]*?)\[\/METER\]`,
  String.raw`((?:(?!\[METER\|)[\s\S])*?)\[\/METER\]`,
)

function runNative(input: string, pattern: string): string {
  return input.replace(new RegExp(pattern, flags), script.replaceString)
}

function runGuarded(input: string): string {
  const searchEnd = getRegexSearchEnd(input, script.findRegex, flags, script.replaceString)
  const searchable = searchEnd === input.length ? input : input.slice(0, searchEnd)
  const output = runNative(searchable, script.findRegex)
  return searchEnd === input.length ? output : output + input.slice(searchEnd)
}

function measure(run: () => string, iterations: number): { milliseconds: number; outputBytes: number } {
  for (let i = 0; i < 3; i += 1) run()
  const startedAt = performance.now()
  let output = ""
  for (let i = 0; i < iterations; i += 1) output = run()
  return {
    milliseconds: Number((performance.now() - startedAt).toFixed(2)),
    outputBytes: output.length,
  }
}

const validInput = validCard.repeat(300)
const worstCaseInput = incompleteCard.repeat(3_000)

console.table({
  valid_original: measure(() => runNative(validInput, script.findRegex), 20),
  valid_guarded: measure(() => runGuarded(validInput), 20),
  worst_original: measure(() => runNative(worstCaseInput, script.findRegex), 3),
  worst_guarded: measure(() => runGuarded(worstCaseInput), 3),
  worst_bounded_pattern: measure(() => runNative(worstCaseInput, boundedPattern), 3),
})
