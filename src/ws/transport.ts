import type { WebSocketHandler } from "bun";
import { websocket as honoWebsocket, type BunWebSocketData } from "@hono/bun";

export const WEBSOCKET_BACKPRESSURE_LIMIT = 8 * 1024 * 1024;

/** Native pub/sub keeps a separate buffer per subscriber. A slow tab must
 * reconnect and recover from the generation pool instead of losing deltas
 * silently or holding up generation for every other subscriber. */
export const websocket: WebSocketHandler<BunWebSocketData> = {
  ...honoWebsocket,
  maxPayloadLength: 4 * 1024 * 1024,
  backpressureLimit: WEBSOCKET_BACKPRESSURE_LIMIT,
  closeOnBackpressureLimit: true,
  error(error, ws) {
    console.error("[WS] native handler failed:", error);
    ws.close(1011, "WebSocket handler failed");
  },
};
