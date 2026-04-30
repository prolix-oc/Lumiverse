import type React from 'react'
import { compileComponentAst, formatAstDiagnostic } from './componentAstCompiler'
import { createTrustedOverrideComponent } from './componentAstRuntime'

export interface TranspileResult {
  component: React.ComponentType<any> | null
  error: string | null
}

const compileCache = new Map<string, TranspileResult>()

/**
 * Compile user-authored TSX into a trusted React wrapper.
 *
 * This intentionally parses and interprets a constrained TSX subset instead of
 * transpiling to JavaScript. User source never reaches dynamic code execution
 * or a host-origin JavaScript execution path.
 */
export function transpileComponent(source: string): TranspileResult {
  if (!source.trim()) return { component: null, error: null }

  const cached = compileCache.get(source)
  if (cached) return cached

  const compiled = compileComponentAst(source)
  const result: TranspileResult = compiled.program
    ? { component: createTrustedOverrideComponent(compiled.program), error: null }
    : { component: null, error: compiled.error ? formatAstDiagnostic(compiled.error) : 'Invalid component override source' }

  compileCache.set(source, result)
  return result
}

/** Validate user TSX against the supported AST subset. */
export function validateTSX(source: string): { valid: boolean; error?: string } {
  if (!source.trim()) return { valid: true }
  const compiled = compileComponentAst(source)
  if (compiled.program) return { valid: true }
  return { valid: false, error: formatAstDiagnostic(compiled.error) }
}
