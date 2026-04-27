import { useCallback, useEffect, useRef, useState } from "react";
import { dreamWeaverToolingApi, type DreamWeaverMessage } from "@/api/dream-weaver-tooling";
import { wsClient } from "@/ws/client";
import { EventType } from "@/ws/events";

export function useDreamWeaverMessages(sessionId: string | null) {
  const [messages, setMessages] = useState<DreamWeaverMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  useEffect(() => {
    if (!sessionId) { setMessages([]); return; }
    setLoading(true);
    dreamWeaverToolingApi.listMessages(sessionId).then((m) => {
      if (sessionRef.current === sessionId) setMessages(m);
    }).finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const unsubs = [
      wsClient.on(
        EventType.DREAM_WEAVER_MESSAGE_CREATED,
        (payload: { sessionId: string; message: DreamWeaverMessage }) => {
          if (payload.sessionId !== sessionId) return;
          setMessages((prev) => {
            if (prev.some((m) => m.id === payload.message.id)) return prev;
            return [...prev, payload.message].sort((a, b) => a.seq - b.seq);
          });
        },
      ),
      wsClient.on(
        EventType.DREAM_WEAVER_MESSAGE_UPDATED,
        (payload: {
          sessionId: string;
          messageId: string;
          status: DreamWeaverMessage["status"];
          output?: unknown;
          error?: unknown;
          duration_ms?: number | null;
          token_usage?: unknown;
        }) => {
          if (payload.sessionId !== sessionId) return;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === payload.messageId
                ? {
                    ...m,
                    status: payload.status,
                    payload: {
                      ...m.payload,
                      ...(payload.output !== undefined ? { output: payload.output } : {}),
                      ...(payload.error !== undefined ? { error: payload.error } : {}),
                      ...(payload.duration_ms !== undefined ? { duration_ms: payload.duration_ms } : {}),
                      ...(payload.token_usage !== undefined ? { token_usage: payload.token_usage } : {}),
                    },
                  }
                : m,
            ),
          );
        },
      ),
      wsClient.on(
        EventType.DREAM_WEAVER_MESSAGE_DELETED,
        (payload: { sessionId: string; messageId: string }) => {
          if (payload.sessionId !== sessionId) return;
          setMessages((prev) => prev.filter((m) => m.id !== payload.messageId));
        },
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, [sessionId]);

  const invoke = useCallback(
    async (input: { tool: string; args?: Record<string, unknown>; nudge_text?: string | null; supersedes_id?: string | null; raw?: string | null }) => {
      if (!sessionId) return;
      await dreamWeaverToolingApi.invoke(sessionId, input);
    },
    [sessionId],
  );
  const accept = useCallback(async (messageId: string) => {
    if (!sessionId) return;
    await dreamWeaverToolingApi.accept(sessionId, messageId);
  }, [sessionId]);
  const reject = useCallback(async (messageId: string) => {
    if (!sessionId) return;
    await dreamWeaverToolingApi.reject(sessionId, messageId);
  }, [sessionId]);
  const cancel = useCallback(async (messageId: string) => {
    if (!sessionId) return;
    await dreamWeaverToolingApi.cancel(sessionId, messageId);
  }, [sessionId]);
  const dream = useCallback(async () => {
    if (!sessionId) return;
    await dreamWeaverToolingApi.dream(sessionId);
  }, [sessionId]);

  return { messages, loading, invoke, accept, reject, cancel, dream };
}
