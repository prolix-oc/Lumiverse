interface ScanResult {
  containsUnboundedQuantifier: boolean
  hasNestedUnboundedQuantifier: boolean
  end: number
}

function characterClassEnd(pattern: string, start: number): number {
  for (let index = start + 1; index < pattern.length; index += 1) {
    if (pattern[index] === '\\') {
      index += 1
      continue
    }
    if (pattern[index] === ']') return index + 1
  }
  return pattern.length
}

function quantifierEnd(pattern: string, start: number): { end: number; unbounded: boolean } | null {
  const marker = pattern[start]
  if (marker === '*' || marker === '+') {
    return { end: pattern[start + 1] === '?' ? start + 2 : start + 1, unbounded: true }
  }
  if (marker === '?') {
    return { end: pattern[start + 1] === '?' ? start + 2 : start + 1, unbounded: false }
  }
  if (marker !== '{') return null

  const close = pattern.indexOf('}', start + 1)
  if (close < 0) return null
  const body = pattern.slice(start + 1, close)
  if (!/^\d+(?:,\d*)?$/.test(body)) return null
  const end = pattern[close + 1] === '?' ? close + 2 : close + 1
  return { end, unbounded: body.endsWith(',') }
}

function scanSequence(pattern: string, start: number, stopAtClose: boolean): ScanResult {
  let containsUnboundedQuantifier = false
  let hasNestedUnboundedQuantifier = false
  let index = start

  while (index < pattern.length) {
    if (stopAtClose && pattern[index] === ')') break

    let atomContainsUnboundedQuantifier = false
    if (pattern[index] === '\\') {
      index = Math.min(pattern.length, index + 2)
    } else if (pattern[index] === '[') {
      index = characterClassEnd(pattern, index)
    } else if (pattern[index] === '(') {
      const nested = scanSequence(pattern, index + 1, true)
      atomContainsUnboundedQuantifier = nested.containsUnboundedQuantifier
      hasNestedUnboundedQuantifier ||= nested.hasNestedUnboundedQuantifier
      index = nested.end < pattern.length && pattern[nested.end] === ')'
        ? nested.end + 1
        : nested.end
    } else {
      index += 1
    }

    const quantifier = quantifierEnd(pattern, index)
    if (!quantifier) continue
    if (quantifier.unbounded) {
      if (atomContainsUnboundedQuantifier) hasNestedUnboundedQuantifier = true
      containsUnboundedQuantifier = true
    } else if (atomContainsUnboundedQuantifier) {
      containsUnboundedQuantifier = true
    }
    index = quantifier.end
  }

  return {
    containsUnboundedQuantifier,
    hasNestedUnboundedQuantifier,
    end: index,
  }
}

/**
 * Durable quarantine must be more conservative than the per-render watchdog.
 * A wall-clock timeout can be caused by scheduler starvation, so only persist
 * it when the browser scheduler looked healthy and the resolved pattern has a
 * high-confidence catastrophic-backtracking shape (an unbounded quantifier
 * nested inside another unbounded quantifier).
 */
export function shouldPermanentlyQuarantineRegex(
  pattern: string,
  environmentCongested: boolean,
): boolean {
  if (environmentCongested) return false
  return scanSequence(pattern, 0, false).hasNestedUnboundedQuantifier
}
