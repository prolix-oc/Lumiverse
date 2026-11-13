/** Verbose per-candidate and request diagnostics are opt-in for investigations. */
export function isCortexDebugEnabled(): boolean {
  return process.env.LUMIVERSE_CORTEX_DEBUG === "1";
}
