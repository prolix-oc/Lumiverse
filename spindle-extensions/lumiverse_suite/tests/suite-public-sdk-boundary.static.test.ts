import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, test } from 'bun:test'

const SRC_ROOT = join(import.meta.dir, '../src')

function walkSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      files.push(...walkSourceFiles(path))
      continue
    }
    if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) files.push(path)
  }
  return files
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function countMatches(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length
}

describe('suite public SDK boundary', () => {
  test('scans the entire suite source for forbidden host-DOM and SDK-boundary patterns', () => {
    const files = walkSourceFiles(SRC_ROOT)
    expect(files.length).toBeGreaterThan(10)

    const declareModules: string[] = []
    const privateImports: string[] = []
    const unknownRecords: string[] = []
    const hostCasts: string[] = []
    let rawMutationObservers = 0
    let documentWideCoreSelectorScrapes = 0
    const remainingScopedRootFiles: string[] = []

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).replaceAll('\\', '/')
      const raw = readFileSync(file, 'utf8')
      const source = stripComments(raw)

      if (/declare\s+module\s+['"]lumiverse-spindle-types['"]/.test(source)) {
        declareModules.push(rel)
      }
      if (/from\s+['"][^'"]*\/(?:internal|private)(?:\/|['"])/.test(source)) {
        privateImports.push(rel)
      }
      if (/\bUnknownRecord\b/.test(source)) unknownRecords.push(rel)

      if (/\b(?:ctx|context|host)\s+as\s+unknown\s+as\b/.test(source)
        || /as\s+unknown\s+as\s+(?:UnknownRecord|RuntimeContext|ProductivitySettingsHost|ConnectionsPickerHostContract|PortraitDockHostContract)\b/.test(source)) {
        hostCasts.push(rel)
      }

      const observerConstructions = countMatches(
        source,
        /\bnew\s+(?:[A-Za-z0-9_]*MutationObserver[A-Za-z0-9_]*|[A-Za-z0-9_]*ResizeObserver[A-Za-z0-9_]*)\s*\(/g,
      )
      const observesDocument = /\.observe\(\s*(?:document|doc(?:ument)?\.(?:body|documentElement|head)|globalThis\.document)/.test(source)
      const scopedRootTyped = /\bScopedHostRoot\b/.test(source)
      if (observerConstructions > 0 && (observesDocument || !scopedRootTyped)) {
        rawMutationObservers += observerConstructions
      } else if (observerConstructions > 0 && scopedRootTyped) {
        remainingScopedRootFiles.push(rel)
      }

      documentWideCoreSelectorScrapes += countMatches(
        source,
        /(?:document|globalThis\.document|window\.document)\s*\.\s*(?:querySelector|querySelectorAll|getElementById|getElementsBy(?:TagName|ClassName|Name))/g,
      )
      documentWideCoreSelectorScrapes += countMatches(
        source,
        /(?:document|globalThis\.document)\s*\.\s*(?:body|head|documentElement)\s*\.\s*(?:querySelector|querySelectorAll|append|appendChild)/g,
      )
    }

    console.log(`rawMutationObservers=${rawMutationObservers} documentWideCoreSelectorScrapes=${documentWideCoreSelectorScrapes}`)
    if (remainingScopedRootFiles.length > 0) {
      console.log(`scoped-root observer allowlist=${remainingScopedRootFiles.join(',')}`)
    }

    expect(declareModules).toEqual([])
    expect(privateImports).toEqual([])
    expect(unknownRecords).toEqual([])
    expect(hostCasts).toEqual([])
    expect(rawMutationObservers).toBe(0)
    expect(documentWideCoreSelectorScrapes).toBe(0)
  })

  test('rejects extension-owned raw MutationObserver and document-wide core-selector scraping', () => {
    const files = walkSourceFiles(SRC_ROOT)
    const rawObserverFiles: string[] = []
    const scrapeFiles: string[] = []
    for (const file of files) {
      const rel = relative(SRC_ROOT, file).replaceAll('\\', '/')
      const source = stripComments(readFileSync(file, 'utf8'))
      const hasRawObserver = /\bnew\s+(?:[A-Za-z0-9_]*MutationObserver|[A-Za-z0-9_]*ResizeObserver)/.test(source)
        && !/\bScopedHostRoot\b/.test(source)
      const hasScrape = /(?:document|globalThis\.document)\s*\.\s*(?:querySelectorAll?|getElementById|getElementsBy)/.test(source)
      if (hasRawObserver) rawObserverFiles.push(rel)
      if (hasScrape) scrapeFiles.push(rel)
    }
    expect(rawObserverFiles).toEqual([])
    expect(scrapeFiles).toEqual([])
  })
})
