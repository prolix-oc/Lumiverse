/**
 * Shared exhaustiveness guard.
 *
 * Terminate every `switch` over a union or enum with `default: return assertNever(value)`.
 * The type checker rejects the call when a union member is left unhandled, and at runtime
 * an out-of-union value throws loudly with the offending value serialized instead of
 * silently falling through.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled union member: ${JSON.stringify(value)}`)
}
