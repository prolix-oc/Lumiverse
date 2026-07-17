import type React from 'react'
import { compileComponentAst, formatAstDiagnostic } from './componentAstCompiler'
import { createTrustedOverrideComponent } from './componentAstRuntime'

export interface TranspileResult {
  component: React.ComponentType<any> | null
  error: string | null
}

const compileCache = new Map<string, Promise<TranspileResult>>()

/**
 * Compile user-authored TSX into a trusted React wrapper.
 *
 * This intentionally parses and interprets a constrained TSX subset instead of
 * transpiling to JavaScript. User source never reaches dynamic code execution
 * or a host-origin JavaScript execution path.
 */
export async function transpileComponent(source: string): Promise<TranspileResult> {
  if (!source.trim()) return { component: null, error: null }

  const cached = compileCache.get(source)
  if (cached) return cached

  const promise = (async (): Promise<TranspileResult> => {
    const compiled = await compileComponentAst(source)
    const result: TranspileResult = compiled.program
      ? { component: createTrustedOverrideComponent(compiled.program), error: null }
      : { component: null, error: compiled.error ? formatAstDiagnostic(compiled.error) : 'Invalid component override source' }
    return result
  })()

  compileCache.set(source, promise)
  return promise
}

/** Validate user TSX against the supported AST subset. */
export async function validateTSX(source: string): Promise<{ valid: boolean; error?: string }> {
  if (!source.trim()) return { valid: true }
  const compiled = await compileComponentAst(source)
  if (compiled.program) return { valid: true }
  return { valid: false, error: formatAstDiagnostic(compiled.error) }
}
