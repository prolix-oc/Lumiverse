export type AuthLockoutReason = "unauthorized" | "login" | "origin";

interface LockoutState {
  failures: Record<AuthLockoutReason, number>;
  level: number;
  lockedUntil: number;
  lastActivityAt: number;
  lastReason: AuthLockoutReason | null;
}

export interface LockoutInfo {
  clientId: string;
  level: number;
  lockedUntil: number;
  retryAfterMs: number;
  reason: AuthLockoutReason | null;
}

interface FailureResult {
  count: number;
  lockout: LockoutInfo | null;
}

const FAILURE_THRESHOLD = 5;
const INITIAL_LOCKOUT_STEPS_MS = [
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
];
const MAX_LOCKOUT_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;

const states = new Map<string, LockoutState>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function formatSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

function startSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [clientId, state] of states) {
      const hasActiveFailures = Object.values(state.failures).some((count) => count > 0);
      const activeUntil = Math.max(state.lastActivityAt, state.lockedUntil);
      if (!hasActiveFailures && now - activeUntil > STATE_TTL_MS) {
        states.delete(clientId);
      }
    }
  }, 60_000);
  if (typeof (sweepTimer as { unref?: () => void }).unref === "function") {
    (sweepTimer as { unref: () => void }).unref();
  }
}

function getOrCreateState(clientId: string, now: number): LockoutState {
  let state = states.get(clientId);
  if (state) {
    state.lastActivityAt = now;
    return state;
  }

  while (states.size >= MAX_ENTRIES && !states.has(clientId)) {
    const oldest = states.keys().next();
    if (oldest.done) break;
    states.delete(oldest.value);
  }

  state = {
    failures: { unauthorized: 0, login: 0, origin: 0 },
    level: 0,
    lockedUntil: 0,
    lastActivityAt: now,
    lastReason: null,
  };
  states.set(clientId, state);
  return state;
}

function nextLockoutMs(level: number): number {
  if (level <= INITIAL_LOCKOUT_STEPS_MS.length) {
    return INITIAL_LOCKOUT_STEPS_MS[level - 1];
  }
  const extraLevels = level - INITIAL_LOCKOUT_STEPS_MS.length;
  const ms = INITIAL_LOCKOUT_STEPS_MS[INITIAL_LOCKOUT_STEPS_MS.length - 1] * (2 ** extraLevels);
  return Math.min(ms, MAX_LOCKOUT_MS);
}

function toLockoutInfo(clientId: string, state: LockoutState, now: number): LockoutInfo | null {
  if (state.lockedUntil <= now) return null;
  return {
    clientId,
    level: state.level,
    lockedUntil: state.lockedUntil,
    retryAfterMs: state.lockedUntil - now,
    reason: state.lastReason,
  };
}

function detailsToLog(details: Record<string, unknown>): string {
  const out: string[] = [];
  for (const [key, value] of Object.entries(details)) {
    if (value == null || value === "") continue;
    out.push(`${key}=${JSON.stringify(value)}`);
  }
  return out.length > 0 ? ` ${out.join(" ")}` : "";
}

function resetReasons(state: LockoutState, reasons: AuthLockoutReason[]): void {
  for (const reason of reasons) {
    state.failures[reason] = 0;
  }
}

class AuthLockoutService {
  constructor() {
    startSweep();
  }

  getActiveLockout(clientId: string, now = Date.now()): LockoutInfo | null {
    const state = states.get(clientId);
    if (!state) return null;
    if (state.lockedUntil <= now) return null;
    return toLockoutInfo(clientId, state, now);
  }

  recordFailure(
    clientId: string,
    reason: AuthLockoutReason,
    details: Record<string, unknown> = {},
    now = Date.now(),
  ): FailureResult {
    // Don't lock out loopback — it's almost always the server owner, and
    // polling components (Operator Panel, generation recovery watchdog) can
    // hit 401s rapidly when a session expires.  Rate-limiting still applies.
    if (clientId === "127.0.0.1" || clientId === "::1" || clientId === "unknown") {
      return { count: 0, lockout: null };
    }

    const state = getOrCreateState(clientId, now);
    state.failures[reason] += 1;
    state.lastReason = reason;

    console.warn(
      `[auth-lockout] ${reason} failure ${state.failures[reason]}/${FAILURE_THRESHOLD} for ${clientId}${detailsToLog(details)}`,
    );

    if (state.failures[reason] < FAILURE_THRESHOLD) {
      return { count: state.failures[reason], lockout: null };
    }

    state.level += 1;
    state.lockedUntil = now + nextLockoutMs(state.level);
    state.lastReason = reason;
    resetReasons(state, ["unauthorized", "login", "origin"]);

    const lockout = toLockoutInfo(clientId, state, now)!;
    console.warn(
      `[auth-lockout] Locked ${clientId} for ${formatSeconds(lockout.retryAfterMs)}s at level ${lockout.level} after repeated ${reason} failures${detailsToLog(details)}`,
    );
    return { count: FAILURE_THRESHOLD, lockout };
  }

  recordSuccess(clientId: string, reasons: AuthLockoutReason | AuthLockoutReason[], now = Date.now()): void {
    const state = states.get(clientId);
    if (!state) return;
    state.lastActivityAt = now;
    resetReasons(state, Array.isArray(reasons) ? reasons : [reasons]);
  }

  logBlockedRequest(clientId: string, info: LockoutInfo, details: Record<string, unknown> = {}): void {
    console.warn(
      `[auth-lockout] Blocked locked client ${clientId} for ${formatSeconds(info.retryAfterMs)}s more at level ${info.level}${detailsToLog(details)}`,
    );
  }

  buildPayload(info: LockoutInfo, message: string) {
    return {
      error: message,
      retryAfterSeconds: formatSeconds(info.retryAfterMs),
      lockedUntil: new Date(info.lockedUntil).toISOString(),
      lockoutLevel: info.level,
      reason: info.reason,
    };
  }
}

export const authLockoutService = new AuthLockoutService();
