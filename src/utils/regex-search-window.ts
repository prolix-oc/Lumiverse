const ESCAPABLE_LITERAL_CHARS = new Set("\\^$.*+?()[]{}|/");

/** Conservative extraction of a literal run every successful match ends with. */
export function getRequiredTerminalLiteral(pattern: string): string | null {
  let suffix = "";
  let depth = 0;
  let inCharacterClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "\\") {
      const escaped = pattern[i + 1];
      if (escaped === undefined) return null;
      i++;
      if (inCharacterClass) continue;
      if (ESCAPABLE_LITERAL_CHARS.has(escaped)) suffix += escaped;
      else {
        suffix = "";
        if ((escaped === "k" || escaped === "p" || escaped === "P") && pattern[i + 1] === "<") {
          const close = pattern.indexOf(">", i + 2);
          if (close >= 0) i = close;
        } else if ((escaped === "p" || escaped === "P") && pattern[i + 1] === "{") {
          const close = pattern.indexOf("}", i + 2);
          if (close >= 0) i = close;
        } else if (escaped === "u" && pattern[i + 1] === "{") {
          const close = pattern.indexOf("}", i + 2);
          if (close >= 0) i = close;
        } else if (escaped === "u") i = Math.min(pattern.length - 1, i + 4);
        else if (escaped === "x") i = Math.min(pattern.length - 1, i + 2);
        else if (escaped === "c") i = Math.min(pattern.length - 1, i + 1);
        else if (/\d/.test(escaped)) while (/\d/.test(pattern[i + 1] ?? "")) i++;
      }
      continue;
    }

    if (inCharacterClass) {
      if (char === "]") inCharacterClass = false;
      continue;
    }
    if (char === "[") {
      inCharacterClass = true;
      suffix = "";
      continue;
    }
    if (char === "(") {
      depth++;
      suffix = "";
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      suffix = "";
      continue;
    }
    if (char === "|") {
      if (depth === 0) return null;
      suffix = "";
      continue;
    }
    if (".*+?^${}".includes(char)) {
      suffix = "";
      continue;
    }
    suffix += char;
  }

  return suffix.length >= 4 ? suffix : null;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lastLiteralIndex(input: string, literal: string, flags: string): number {
  if (!flags.includes("i")) return input.lastIndexOf(literal);
  const unicodeFlag = flags.includes("v") ? "v" : flags.includes("u") ? "u" : "";
  const guard = new RegExp(escapeRegexLiteral(literal), `gi${unicodeFlag}`);
  let lastIndex = -1;
  let match: RegExpExecArray | null;
  while ((match = guard.exec(input)) !== null) lastIndex = match.index;
  return lastIndex;
}

/**
 * Return the last position at which this pattern can possibly finish.
 * `$'` replacement templates bypass the optimization because they observe the
 * complete original suffix.
 */
export function getRegexSearchEnd(
  input: string,
  pattern: string,
  flags: string,
  replacementTemplate: string,
): number {
  if (replacementTemplate.includes("$'")) return input.length;
  const terminal = getRequiredTerminalLiteral(pattern);
  if (!terminal) return input.length;
  const index = lastLiteralIndex(input, terminal, flags);
  return index < 0 ? 0 : index + terminal.length;
}
