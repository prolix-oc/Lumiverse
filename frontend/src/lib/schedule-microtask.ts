/**
 * Explicit microtask scheduler. Use this instead of the raw platform primitive
 * so the codebase has a single named seam and tests can reason about async timing.
 */
export function scheduleMicrotask(run: () => void): void {
  void Promise.resolve().then(run)
}
