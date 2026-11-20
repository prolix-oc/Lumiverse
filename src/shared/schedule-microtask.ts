/**
 * Explicit microtask scheduler for work that must run before the next task or
 * browser paint. Use the low-priority task scheduler for background work.
 */
export function scheduleMicrotask(run: () => void): void {
  void Promise.resolve().then(run)
}
