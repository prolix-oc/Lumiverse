/**
 * Single-use, short-lived WebSocket tickets.
 *
 * A ticket is issued via an authenticated HTTP endpoint and exchanged during
 * the WS upgrade handshake.  This avoids putting long-lived bearer tokens in
 * query strings where they leak through logs, browser history, and referrers.
 */

interface WsTicket {
  userId: string;
  expires: number;
}

const tickets = new Map<string, WsTicket>();

const TICKET_TTL_MS = 30_000; // 30 seconds
const SWEEP_INTERVAL_MS = 60_000;

// The sweep timer is started lazily on first ticket issuance instead of at
// module-import time. The previous unconditional setInterval kept Node/Bun
// from exiting cleanly in test runs that imported the module but never called
// stopTicketSweep().
let _sweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureSweepTimer(): void {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of tickets) {
      if (now > entry.expires) {
        tickets.delete(key);
      }
    }
  }, SWEEP_INTERVAL_MS);
  // Don't keep the process alive on this timer alone.
  if (typeof (_sweepTimer as { unref?: () => void }).unref === "function") {
    (_sweepTimer as { unref: () => void }).unref();
  }
}

/** Issue a new single-use ticket for the given user. */
export function issueTicket(userId: string): string {
  ensureSweepTimer();
  const ticket = crypto.randomUUID();
  tickets.set(ticket, { userId, expires: Date.now() + TICKET_TTL_MS });
  return ticket;
}

/**
 * Consume a ticket.  Returns the userId if valid, null if invalid/expired.
 * The ticket is deleted after a single use regardless of validity.
 */
export function consumeTicket(ticket: string): string | null {
  const entry = tickets.get(ticket);
  tickets.delete(ticket);
  if (!entry) return null;
  if (Date.now() > entry.expires) return null;
  return entry.userId;
}

export function stopTicketSweep(): void {
  if (_sweepTimer) {
    clearInterval(_sweepTimer);
    _sweepTimer = null;
  }
}
