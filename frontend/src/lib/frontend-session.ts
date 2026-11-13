const bytes = crypto.getRandomValues(new Uint8Array(16))

// Each document owns its execution state; tabs must never share this identifier.
export const frontendSessionId = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
