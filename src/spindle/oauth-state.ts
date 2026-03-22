/**
 * Platform-managed OAuth state nonces for extension OAuth flows.
 *
 * Extensions request a state nonce via the Spindle API before building their
 * OAuth authorization URL.  The callback route validates the state parameter
 * to prevent CSRF attacks.
 */

interface OAuthStateEntry {
  extensionIdentifier: string;
  expiresAt: number;
}

const stateMap = new Map<string, OAuthStateEntry>();

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SWEEP_INTERVAL_MS = 60_000;

/** Create a new state nonce for the given extension. */
export function createOAuthState(extensionIdentifier: string): string {
  const state = crypto.randomUUID();
  stateMap.set(state, {
    extensionIdentifier,
    expiresAt: Date.now() + STATE_TTL_MS,
  });
  return state;
}

/**
 * Validate and consume an OAuth state nonce.
 * Returns true if the state is valid for the given extension, false otherwise.
 * The state is deleted after validation regardless of result.
 */
export function validateOAuthState(
  state: string,
  extensionIdentifier: string
): boolean {
  const entry = stateMap.get(state);
  stateMap.delete(state);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) return false;
  if (entry.extensionIdentifier !== extensionIdentifier) return false;
  return true;
}

// Periodically sweep expired state entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of stateMap) {
    if (now > entry.expiresAt) {
      stateMap.delete(key);
    }
  }
}, SWEEP_INTERVAL_MS);
