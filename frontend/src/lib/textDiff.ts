export interface LineDiffChunk {
  type: 'unchanged' | 'removed' | 'added'
  text: string
}

const MAX_LCS_CELLS = 160_000

function splitLines(text: string): string[] {
  if (!text) return []
  return text.replace(/\r\n/g, '\n').split('\n')
}

/**
 * Compute a readable line-level diff between two text values.
 * Trims shared prefixes/suffixes first and falls back to a whole-block diff
 * if the changed middle exceeds the LCS matrix budget.
 */
export function computeLineDiff(oldText: string, newText: string): LineDiffChunk[] {
  if (oldText === newText) {
    return oldText ? splitLines(oldText).map((text) => ({ type: 'unchanged', text })) : []
  }

  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)

  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++
  }

  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++
  }

  const result: LineDiffChunk[] = []
  for (let i = 0; i < prefix; i++) {
    result.push({ type: 'unchanged', text: oldLines[i] })
  }

  const midOld = oldLines.slice(prefix, oldLines.length - suffix)
  const midNew = newLines.slice(prefix, newLines.length - suffix)

  if (midOld.length === 0) {
    for (const line of midNew) result.push({ type: 'added', text: line })
  } else if (midNew.length === 0) {
    for (const line of midOld) result.push({ type: 'removed', text: line })
  } else if (midOld.length * midNew.length > MAX_LCS_CELLS) {
    for (const line of midOld) result.push({ type: 'removed', text: line })
    for (const line of midNew) result.push({ type: 'added', text: line })
  } else {
    const rows = midOld.length + 1
    const cols = midNew.length + 1
    const dp = new Int32Array(rows * cols)

    for (let i = midOld.length - 1; i >= 0; i--) {
      for (let j = midNew.length - 1; j >= 0; j--) {
        if (midOld[i] === midNew[j]) {
          dp[i * cols + j] = dp[(i + 1) * cols + (j + 1)] + 1
        } else {
          const down = dp[(i + 1) * cols + j]
          const right = dp[i * cols + (j + 1)]
          dp[i * cols + j] = down >= right ? down : right
        }
      }
    }

    let i = 0
    let j = 0
    while (i < midOld.length && j < midNew.length) {
      if (midOld[i] === midNew[j]) {
        result.push({ type: 'unchanged', text: midOld[i] })
        i++
        j++
      } else if (dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)]) {
        result.push({ type: 'removed', text: midOld[i] })
        i++
      } else {
        result.push({ type: 'added', text: midNew[j] })
        j++
      }
    }
    while (i < midOld.length) {
      result.push({ type: 'removed', text: midOld[i] })
      i++
    }
    while (j < midNew.length) {
      result.push({ type: 'added', text: midNew[j] })
      j++
    }
  }

  for (let i = oldLines.length - suffix; i < oldLines.length; i++) {
    result.push({ type: 'unchanged', text: oldLines[i] })
  }

  return result
}

export function countDiffLines(chunks: LineDiffChunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const chunk of chunks) {
    if (chunk.type === 'added') added++
    else if (chunk.type === 'removed') removed++
  }
  return { added, removed }
}
