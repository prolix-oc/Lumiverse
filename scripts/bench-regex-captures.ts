import {
  regexCaptureReplacementsSandboxed,
  regexCollectSandboxed,
  shutdownRegexSandbox,
} from "../src/utils/regex-sandbox";

const groupCount = Math.max(1, Number.parseInt(Bun.argv[2] ?? "300", 10));
const matchCount = Math.max(1, Number.parseInt(Bun.argv[3] ?? "200", 10));
const iterations = Math.max(1, Number.parseInt(Bun.argv[4] ?? "250", 10));

const pattern = "(a)".repeat(groupCount);
const input = "a".repeat(groupCount * matchCount);
const replacement = "$1:$99:$100";

async function measure(run: () => Promise<unknown>): Promise<number> {
  const startedAt = performance.now();
  for (let i = 0; i < iterations; i++) await run();
  return performance.now() - startedAt;
}

try {
  for (let i = 0; i < 20; i++) {
    await regexCollectSandboxed(pattern, "g", input, 5_000);
    await regexCaptureReplacementsSandboxed(pattern, "g", input, replacement, 5_000);
  }

  const legacySample = await regexCollectSandboxed(pattern, "g", input, 5_000);
  const optimizedSample = await regexCaptureReplacementsSandboxed(
    pattern,
    "g",
    input,
    replacement,
    5_000,
  );
  const legacyMs = await measure(
    () => regexCollectSandboxed(pattern, "g", input, 5_000),
  );
  const optimizedMs = await measure(
    () => regexCaptureReplacementsSandboxed(pattern, "g", input, replacement, 5_000),
  );

  console.table({
    scenario: { groups: groupCount, matches: matchCount, iterations },
    legacy_collect: {
      milliseconds: Number(legacyMs.toFixed(2)),
      payload_bytes: JSON.stringify(legacySample).length,
    },
    capture_replacements: {
      milliseconds: Number(optimizedMs.toFixed(2)),
      payload_bytes: JSON.stringify(optimizedSample).length,
    },
    improvement: {
      speedup: Number((legacyMs / optimizedMs).toFixed(2)),
      payload_reduction: Number(
        (JSON.stringify(legacySample).length / JSON.stringify(optimizedSample).length).toFixed(2),
      ),
    },
  });
} finally {
  shutdownRegexSandbox();
}
