import { upgradeWebSocket } from "hono/bun";
import { eventBus } from "./bus";
import { EventType } from "./events";
import { auth } from "../auth";
import { consumeTicket } from "./tickets";
import { getWorkerHost } from "../spindle/lifecycle";
import * as managerSvc from "../spindle/manager.service";
import { getFirstUserId } from "../auth/seed";

export const wsHandler = upgradeWebSocket((c) => {
  // Authenticate during upgrade — extract userId + sessionId
  let userId: string | null = null;
  let userRole: string | null = null;
  let sessionId: string | null = null;

  return {
    async onOpen(_event, ws) {
      console.log("[WS] onOpen fired");

      try {
        const url = new URL(c.req.url);

        // Auth path 1: single-use ticket (preferred, avoids token in URL)
        const ticket = url.searchParams.get("ticket");
        if (ticket) {
          const ticketUserId = consumeTicket(ticket);
          if (!ticketUserId) {
            console.warn("[WS] Auth failed — invalid or expired ticket");
            ws.send(
              JSON.stringify({
                event: "AUTH_ERROR",
                payload: { message: "Invalid or expired ticket" },
                timestamp: Date.now(),
              })
            );
            ws.close(1008, "Invalid or expired ticket");
            return;
          }
          userId = ticketUserId;
          // Ticket auth doesn't carry role/session — fetch from DB
          const { getDb } = await import("../db/connection");
          const row = getDb()
            .query('SELECT id, role FROM "user" WHERE id = ?')
            .get(ticketUserId) as { id: string; role: string } | null;
          userRole = row?.role || "user";
          sessionId = `ticket-${crypto.randomUUID()}`;
        } else {
          // Auth path 2: cookie-based session (original path)
          const session = await auth.api.getSession({
            headers: c.req.raw.headers,
          });

          if (!session) {
            console.warn("[WS] Auth failed — no session found");
            ws.send(
              JSON.stringify({
                event: "AUTH_ERROR",
                payload: { message: "Authentication required" },
                timestamp: Date.now(),
              })
            );
            ws.close(1008, "Authentication required");
            return;
          }

          userId = session.user.id;
          userRole = session.user.role || null;

          // Same as requireAuth: if BetterAuth omitted the role, read from DB
          if (!userRole) {
            const { getDb } = await import("../db/connection");
            const row = getDb()
              .query('SELECT role FROM "user" WHERE id = ?')
              .get(userId) as { role: string } | null;
            userRole = row?.role || "user";
          }

          sessionId = session.session.id;
        }

        // Self-healing: first user (user 0) is always the instance owner.
        if (userId && userRole !== "owner") {
          const cachedFirstId = getFirstUserId();
          if (cachedFirstId && cachedFirstId === userId) {
            const { getDb } = await import("../db/connection");
            getDb().run('UPDATE "user" SET role = ? WHERE id = ?', ["owner", userId]);
            userRole = "owner";
            console.log(`[WS] Self-healed owner role for first user ${userId}`);
          }
        }

        console.log(`[WS] Authenticated as user ${userId}, session ${sessionId}`);

        const raw = (ws as any).raw as import("bun").ServerWebSocket<unknown>;
        if (raw) {
          eventBus.addClient(raw, userId, sessionId);
          console.log(`[WS] Client registered for user ${userId} (total: ${eventBus.clientCount})`);
        } else {
          console.warn("[WS] Could not extract raw Bun WebSocket — events will not reach this client");
        }

        ws.send(
          JSON.stringify({
            event: EventType.CONNECTED,
            payload: { message: "Connected to Lumiverse event bus", userId, role: userRole },
            timestamp: Date.now(),
          })
        );
      } catch (err) {
        console.error("[WS] onOpen error:", err);
      }
    },
    async onMessage(event, ws) {
      try {
        const data = JSON.parse(event.data as string);
        if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
          return;
        }

        if (data.type === "visibility") {
          if (userId && sessionId) {
            eventBus.setUserVisibility(userId, sessionId, !!data.visible);
          }
          return;
        }

        if (data.type === "SPINDLE_TEXT_EDITOR_RESULT") {
          if (userId && data.requestId) {
            eventBus.emit(EventType.SPINDLE_TEXT_EDITOR_RESULT, {
              requestId: data.requestId,
              text: data.text,
              cancelled: !!data.cancelled,
            }, userId);
          }
          return;
        }

        if (data.type === "SPINDLE_CONFIRM_RESULT") {
          if (userId && data.requestId) {
            eventBus.emit(EventType.SPINDLE_CONFIRM_RESULT, {
              requestId: data.requestId,
              confirmed: !!data.confirmed,
            }, userId);
          }
          return;
        }

        if (data.type === "SPINDLE_MODAL_RESULT") {
          if (userId && data.requestId) {
            eventBus.emit(EventType.SPINDLE_MODAL_RESULT, {
              requestId: data.requestId,
              dismissedBy: data.dismissedBy,
            }, userId);
          }
          return;
        }

        if (data.type === "SPINDLE_INPUT_PROMPT_RESULT") {
          if (userId && data.requestId) {
            eventBus.emit(EventType.SPINDLE_INPUT_PROMPT_RESULT, {
              requestId: data.requestId,
              value: data.value ?? null,
              cancelled: !!data.cancelled,
            }, userId);
          }
          return;
        }

        if (data.type === "SPINDLE_BACKEND_MSG") {
          const extensionId = typeof data.extensionId === "string" ? data.extensionId : null;
          if (!extensionId) return;
          if (!userId) return;

          const ext = await managerSvc.getExtensionForUser(extensionId, userId, userRole);
          if (!ext) {
            return;
          }

          const host = getWorkerHost(extensionId);
          if (!host) return;

          if (
            data.payload &&
            typeof data.payload === "object" &&
            (data.payload as Record<string, unknown>).type === "message_tag_intercepted"
          ) {
            eventBus.emit(EventType.MESSAGE_TAG_INTERCEPTED, {
              extensionId,
              identifier: host.manifest.identifier,
              ...(data.payload as Record<string, unknown>),
            });
          }

          host.sendFrontendMessage(data.payload, userId!);
        }

        if (data.type === "SPINDLE_COMMAND_INVOKE") {
          const extensionId = typeof data.extensionId === "string" ? data.extensionId : null;
          const commandId = typeof data.commandId === "string" ? data.commandId : null;
          if (!extensionId || !commandId || !userId) return;

          const ext = await managerSvc.getExtensionForUser(extensionId, userId, userRole);
          if (!ext) return;

          const host = getWorkerHost(extensionId);
          if (!host) return;

          host.invokeCommand(commandId, data.context ?? {}, userId);
        }
      } catch {
        // Ignore malformed messages
      }
    },
    onClose(_event, ws) {
      const raw = (ws as any).raw as import("bun").ServerWebSocket<unknown>;
      if (raw) {
        eventBus.removeClient(raw);
      }
    },
  };
});
