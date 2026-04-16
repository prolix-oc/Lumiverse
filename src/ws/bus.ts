import type { ServerWebSocket } from "bun";
import { EventType, type EventMessage } from "./events";

type Listener = (event: EventMessage) => void;

class EventBus {
  private server: import("bun").Server<unknown> | null = null;
  private clientToUser = new Map<ServerWebSocket<unknown>, string>();
  private sessionToClient = new Map<string, ServerWebSocket<unknown>>();
  private clientToSession = new Map<ServerWebSocket<unknown>, string>();
  private listeners = new Map<EventType, Set<Listener>>();
  /** Per-user visibility: true if at least one session reports visible. */
  private userVisibility = new Map<string, Map<string, boolean>>();
  private userAllHiddenSince = new Map<string, number>();

  /** Store the Bun server reference so we can use native publish(). */
  setServer(server: import("bun").Server<unknown>): void {
    this.server = server;
  }

  addClient(ws: ServerWebSocket<unknown>, userId: string, sessionId?: string): void {
    // Track session → socket mapping for dedup, but do NOT forcefully evict
    // the old socket. Stale sockets are cleaned up naturally via onClose →
    // removeClient. Forceful eviction causes reconnect loops because the
    // close frame triggers the client to reconnect, which evicts again, etc.
    if (sessionId) {
      const existing = this.sessionToClient.get(sessionId);
      if (existing && existing !== ws) {
        // Just remove tracking — the old socket's onClose will fire and
        // call removeClient() to clean up subscriptions.
        this.removeClient(existing);
      }
      this.sessionToClient.set(sessionId, ws);
      this.clientToSession.set(ws, sessionId);
    }

    this.clientToUser.set(ws, userId);

    // Subscribe to per-user topic and system broadcast topic.
    // Bun's native pub/sub handles delivery in Zig — no JS iteration needed.
    try {
      ws.subscribe(`user:${userId}`);
      ws.subscribe("system");
    } catch {
      // Socket may already be closed
    }
  }

  removeClient(ws: ServerWebSocket<unknown>): void {
    const userId = this.clientToUser.get(ws);
    const sessionId = this.clientToSession.get(ws);
    if (userId) {
      try {
        ws.unsubscribe(`user:${userId}`);
        ws.unsubscribe("system");
      } catch {
        // Socket may already be closed
      }
      this.clientToUser.delete(ws);
      if (sessionId) this.removeSessionVisibility(userId, sessionId);
    }
    if (sessionId) {
      // Only remove from session map if this socket is still the current one
      if (this.sessionToClient.get(sessionId) === ws) {
        this.sessionToClient.delete(sessionId);
      }
      this.clientToSession.delete(ws);
    }
  }

  on(event: EventType, listener: Listener): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return () => this.listeners.get(event)?.delete(listener);
  }

  emit(event: EventType, payload: any = {}, userId?: string): void {
    const message: EventMessage = {
      event,
      payload,
      timestamp: Date.now(),
      userId,
    };

    const json = JSON.stringify(message);

    // Use Bun's native pub/sub for WebSocket delivery — single native call
    // instead of iterating over JS Maps and calling ws.send() per-socket.
    if (this.server) {
      const topic = userId ? `user:${userId}` : "system";
      this.server.publish(topic, json);
    }

    // Fire in-process listeners asynchronously so extension worker IPC
    // doesn't block the streaming hot path.
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      for (const listener of eventListeners) {
        queueMicrotask(() => {
          try {
            listener(message);
          } catch (err) {
            console.error(`Event listener error for ${event}:`, err);
          }
        });
      }
    }
  }

  // ─── User Visibility ─────────────────────────────────────────────────

  /**
   * Record a visibility state change for a user session.
   * Called when the frontend sends a "visibility" message over the WebSocket.
   */
  setUserVisibility(userId: string, sessionId: string, visible: boolean): void {
    if (!this.userVisibility.has(userId)) {
      this.userVisibility.set(userId, new Map());
    }
    this.userVisibility.get(userId)!.set(sessionId, visible);
    this.updateUserVisibilityState(userId);
  }

  /**
   * Remove a session's visibility entry.
   * Called when a WebSocket disconnects.
   */
  removeSessionVisibility(userId: string, sessionId: string): void {
    const sessions = this.userVisibility.get(userId);
    if (!sessions) {
      this.userAllHiddenSince.set(userId, Date.now());
      return;
    }
    sessions.delete(sessionId);
    if (sessions.size === 0) this.userVisibility.delete(userId);
    this.updateUserVisibilityState(userId);
  }

  /**
   * Returns true if the user has at least one session with the app visible/focused.
   * Returns false if no sessions are connected or all sessions report hidden.
   */
  isUserVisible(userId: string): boolean {
    const sessions = this.userVisibility.get(userId);
    if (!sessions || sessions.size === 0) return false;
    for (const visible of sessions.values()) {
      if (visible) return true;
    }
    return false;
  }

  getUserVisibilitySnapshot(userId: string): {
    totalSessions: number;
    visibleSessions: number;
    hiddenSessions: number;
    isVisible: boolean;
    allHiddenSince: number | null;
  } {
    const sessions = this.userVisibility.get(userId);
    const totalSessions = sessions?.size ?? 0;
    let visibleSessions = 0;
    if (sessions) {
      for (const visible of sessions.values()) {
        if (visible) visibleSessions++;
      }
    }

    // No write here — `allHiddenSince` is set by updateUserVisibilityState
    // whenever a session transitions to hidden. Reading the snapshot used to
    // also stamp the timer, which mixed observation and mutation in the same
    // call and left subtle behavior depending on who polled first.
    let allHiddenSince: number | null = null;
    if (visibleSessions === 0) {
      allHiddenSince = this.userAllHiddenSince.get(userId) ?? null;
    }

    return {
      totalSessions,
      visibleSessions,
      hiddenSessions: Math.max(totalSessions - visibleSessions, 0),
      isVisible: visibleSessions > 0,
      allHiddenSince,
    };
  }

  private updateUserVisibilityState(userId: string): void {
    if (this.isUserVisible(userId)) {
      this.userAllHiddenSince.delete(userId);
      return;
    }

    if (!this.userAllHiddenSince.has(userId)) {
      this.userAllHiddenSince.set(userId, Date.now());
    }
  }

  get clientCount(): number {
    return this.clientToUser.size;
  }

  /** Returns the set of unique user IDs with at least one active WS connection. */
  getConnectedUserIds(): string[] {
    return [...new Set(this.clientToUser.values())];
  }
}

export const eventBus = new EventBus();
