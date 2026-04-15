/**
 * Outbound WebSocket client that maintains a persistent connection to LumiHub.
 * Handles reconnection with exponential backoff, heartbeats, and dispatches
 * install commands to the installer module.
 */
import type { LumiHubWSMessage } from "./types";
import { installCharacter, installWorldbook } from "./installer";
import { buildInstallManifest } from "./manifest";
import { updateLastConnected } from "../services/lumihub-link.service";
import { getFirstUserId } from "../auth/seed";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import {
  validateInstallCharacterPayload,
  validateInstallWorldbookPayload,
} from "./payload-validation";

const HEARTBEAT_INTERVAL_MS = 30_000;
const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;
const MANIFEST_SYNC_DEBOUNCE_MS = 5_000;
// Fail fast if LumiHub doesn't complete the WebSocket handshake in time.
// Without this, an unreachable host can leave the socket stuck in CONNECTING
// (no close/error fires) and no reconnect is ever scheduled.
const CONNECT_TIMEOUT_MS = 15_000;

class LumiHubWSClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = INITIAL_RECONNECT_MS;
  private connected = false;
  private intentionalClose = false;
  private wsUrl: string = "";
  private linkToken: string = "";
  private manifestSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private eventListenersRegistered = false;

  /** Open a WebSocket connection to LumiHub. */
  connect(wsUrl: string, linkToken: string): void {
    this.wsUrl = wsUrl;
    this.linkToken = linkToken;
    this.intentionalClose = false;
    this.doConnect();
  }

  /** Gracefully disconnect and stop reconnection. */
  disconnect(): void {
    this.intentionalClose = true;
    this.cleanup();
  }

  isConnected(): boolean {
    return this.connected;
  }

  private doConnect(): void {
    this.cleanup();

    try {
      const url = `${this.wsUrl}?token=${encodeURIComponent(this.linkToken)}`;
      this.ws = new WebSocket(url);
      const ws = this.ws;

      // Arm a connect timeout so a hung handshake doesn't leave us stuck in
      // CONNECTING with no close/error event and no scheduled reconnect.
      this.connectTimeoutTimer = setTimeout(() => {
        this.connectTimeoutTimer = null;
        if (ws.readyState === WebSocket.CONNECTING) {
          console.warn(`[LumiHub WS] Connect timed out after ${CONNECT_TIMEOUT_MS}ms`);
          try { ws.close(); } catch {}
          if (!this.intentionalClose) {
            this.scheduleReconnect();
          }
        }
      }, CONNECT_TIMEOUT_MS);

      ws.addEventListener("open", () => {
        this.clearConnectTimeout();
        console.log("[LumiHub WS] Connected");
        this.connected = true;
        this.reconnectDelay = INITIAL_RECONNECT_MS;
        this.startHeartbeat();
        updateLastConnected();
        eventBus.emit(EventType.LUMIHUB_CONNECTION_CHANGED, { connected: true });
      });

      ws.addEventListener("message", (event) => {
        this.handleMessage(event.data as string);
      });

      ws.addEventListener("close", (event) => {
        this.clearConnectTimeout();
        console.log(`[LumiHub WS] Closed: ${event.code} ${event.reason}`);
        this.connected = false;
        this.stopHeartbeat();
        eventBus.emit(EventType.LUMIHUB_CONNECTION_CHANGED, { connected: false });

        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      });

      ws.addEventListener("error", (event) => {
        console.error("[LumiHub WS] Error:", event);
        // Defensive: some runtimes fire `error` without a subsequent `close`
        // when the handshake fails pre-upgrade. scheduleReconnect short-circuits
        // if already armed, so this is safe to call alongside the close path.
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      });
    } catch (err) {
      console.error("[LumiHub WS] Connection failed:", err);
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    }
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }
  }

  private handleMessage(data: string): void {
    let msg: LumiHubWSMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "ping":
        this.send({ type: "pong", id: msg.id, timestamp: Date.now() });
        break;

      case "auth_ok":
        console.log("[LumiHub WS] Authenticated successfully");
        // Send instance info
        this.send({
          type: "instance_info",
          id: crypto.randomUUID(),
          payload: {
            capabilities: ["character_import", "chub_import", "worldbook_import", "manifest_sync"],
            version: "1.0.0",
          },
          timestamp: Date.now(),
        });
        // Send initial install manifest
        this.syncManifest();
        // Register event listeners for character mutations (once)
        this.registerManifestListeners();
        break;

      case "install_character":
        this.handleInstallCharacter(msg);
        break;

      case "install_worldbook":
        this.handleInstallWorldbook(msg);
        break;

      default:
        // Unknown message type, ignore
        break;
    }
  }

  private async handleInstallCharacter(msg: LumiHubWSMessage): Promise<void> {
    const validation = validateInstallCharacterPayload(msg.payload);
    if (!validation.ok) {
      console.warn(`[LumiHub WS] Rejected install_character payload: ${validation.error}`);
      this.send({
        type: "install_result",
        id: crypto.randomUUID(),
        replyTo: msg.id,
        payload: { requestId: msg.id, success: false, error: validation.error, errorCode: "PARSE_ERROR" },
        timestamp: Date.now(),
      });
      return;
    }
    const payload = validation.value;
    console.log(`[LumiHub WS] Install request: ${payload.characterName} (source: ${payload.source})`);

    // Notify local frontend
    eventBus.emit(EventType.LUMIHUB_INSTALL_STARTED, {
      characterName: payload.characterName,
      source: payload.source,
    });

    const result = await installCharacter(msg.id, payload);

    // Send result back to LumiHub
    this.send({
      type: "install_result",
      id: crypto.randomUUID(),
      replyTo: msg.id,
      payload: result,
      timestamp: Date.now(),
    });

    if (!result.success) {
      eventBus.emit(EventType.LUMIHUB_INSTALL_FAILED, {
        characterName: payload.characterName,
        error: result.error,
      });
    }
  }

  private async handleInstallWorldbook(msg: LumiHubWSMessage): Promise<void> {
    const validation = validateInstallWorldbookPayload(msg.payload);
    if (!validation.ok) {
      console.warn(`[LumiHub WS] Rejected install_worldbook payload: ${validation.error}`);
      this.send({
        type: "install_result",
        id: crypto.randomUUID(),
        replyTo: msg.id,
        payload: { requestId: msg.id, success: false, error: validation.error },
        timestamp: Date.now(),
      });
      return;
    }
    const payload = validation.value;
    console.log(`[LumiHub WS] Worldbook install request: ${payload.worldbookName} (source: ${payload.source})`);

    eventBus.emit(EventType.LUMIHUB_INSTALL_STARTED, {
      characterName: payload.worldbookName,
      source: payload.source,
    });

    const result = await installWorldbook(msg.id, payload);

    this.send({
      type: "install_result",
      id: crypto.randomUUID(),
      replyTo: msg.id,
      payload: result,
      timestamp: Date.now(),
    });

    if (!result.success) {
      eventBus.emit(EventType.LUMIHUB_INSTALL_FAILED, {
        characterName: payload.worldbookName,
        error: result.error,
      });
    }
  }

  /** Build and send the install manifest to LumiHub. */
  private syncManifest(): void {
    try {
      const userId = getFirstUserId();
      if (!userId) return;
      const entries = buildInstallManifest(userId);
      this.send({
        type: "manifest_sync",
        id: crypto.randomUUID(),
        payload: { entries },
        timestamp: Date.now(),
      });
      console.log(`[LumiHub WS] Sent manifest sync (${entries.length} entries)`);
    } catch (err) {
      console.warn("[LumiHub WS] Failed to build/send manifest:", err);
    }
  }

  /** Debounced manifest re-sync (collapses rapid character mutations). */
  private debouncedManifestSync(): void {
    if (this.manifestSyncTimer) clearTimeout(this.manifestSyncTimer);
    this.manifestSyncTimer = setTimeout(() => {
      this.manifestSyncTimer = null;
      if (this.connected) this.syncManifest();
    }, MANIFEST_SYNC_DEBOUNCE_MS);
  }

  /** Register event listeners for character mutations to trigger manifest re-sync. */
  private registerManifestListeners(): void {
    if (this.eventListenersRegistered) return;
    this.eventListenersRegistered = true;
    const trigger = () => this.debouncedManifestSync();
    eventBus.on(EventType.CHARACTER_EDITED, trigger);
    eventBus.on(EventType.CHARACTER_DELETED, trigger);
    eventBus.on(EventType.LUMIHUB_INSTALL_COMPLETED, trigger);
  }

  private send(msg: Partial<LumiHubWSMessage>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // Send failed, will reconnect
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "ping", id: crypto.randomUUID(), timestamp: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    console.log(`[LumiHub WS] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
  }

  private cleanup(): void {
    this.stopHeartbeat();
    this.clearConnectTimeout();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(1000); } catch {}
      this.ws = null;
    }
    this.connected = false;
  }
}

// Singleton instance
let _client: LumiHubWSClient | null = null;

export function getLumiHubClient(): LumiHubWSClient {
  if (!_client) {
    _client = new LumiHubWSClient();
  }
  return _client;
}

/**
 * Auto-connect to LumiHub if a link config exists.
 * Called at startup from index.ts.
 */
export async function autoConnect(): Promise<void> {
  const { getLinkConfig } = await import("../services/lumihub-link.service");
  const config = await getLinkConfig();
  if (!config) {
    console.log("[LumiHub] No link configured — skipping auto-connect");
    return;
  }

  console.log(`[LumiHub] Auto-connecting to ${config.lumihubUrl}...`);
  const client = getLumiHubClient();
  client.connect(config.wsUrl, config.linkToken);
}
