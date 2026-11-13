export type DiscordPresenceRefreshResult = 'ok' | 'needs-auth';

/** Serialize polls, retaining one follow-up when a chat changes during a fetch. */
export function createDiscordPresenceRefreshQueue(
  poll: () => Promise<DiscordPresenceRefreshResult>,
): () => Promise<DiscordPresenceRefreshResult> {
  let inFlight: Promise<DiscordPresenceRefreshResult> | null = null;
  let requested = false;

  async function drain(): Promise<DiscordPresenceRefreshResult> {
    try {
      let result: DiscordPresenceRefreshResult;
      do {
        requested = false;
        result = await poll();
      } while (requested);
      return result;
    } finally {
      inFlight = null;
    }
  }

  return () => {
    requested = true;
    if (!inFlight) {
      inFlight = drain();
    }
    return inFlight;
  };
}
