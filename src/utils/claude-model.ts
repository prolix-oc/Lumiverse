export interface ClaudeOpusVersion {
  major: number;
  minor: number;
}

// Anthropic uses hyphens in direct model IDs while compatible model catalogs
// sometimes render the same version with a dot. A one- or two-digit minor
// avoids mistaking a dated alias such as `claude-opus-4-20250514` for 4.20250514.
const CLAUDE_OPUS_VERSION = /(?:^|[\/:])claude-opus-(\d+)(?:[-.](\d{1,2}))?(?=$|[-.:@])/i;

export function parseClaudeOpusVersion(
  model: string | null | undefined,
): ClaudeOpusVersion | null {
  const match = model?.trim().match(CLAUDE_OPUS_VERSION);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
  };
}

export function isClaudeOpusAtLeast(
  model: string | null | undefined,
  minimumMajor: number,
  minimumMinor = 0,
): boolean {
  const version = parseClaudeOpusVersion(model);
  if (!version) return false;

  return version.major > minimumMajor || (
    version.major === minimumMajor && version.minor >= minimumMinor
  );
}

/**
 * Opus 4.7 is the original XHigh-capable release. From Opus 4.8 onward,
 * eligibility is version-based so point releases and future majors do not
 * require another hard-coded model allowlist.
 */
export function supportsClaudeOpusXhigh(
  model: string | null | undefined,
): boolean {
  const version = parseClaudeOpusVersion(model);
  if (!version) return false;

  return (version.major === 4 && version.minor === 7)
    || version.major > 4
    || (version.major === 4 && version.minor >= 8);
}
