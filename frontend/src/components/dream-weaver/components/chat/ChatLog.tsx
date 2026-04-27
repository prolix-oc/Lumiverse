import { useEffect, useMemo, useRef } from "react";
import type { DreamWeaverMessage } from "@/api/dream-weaver-tooling";
import { ToolCard } from "./ToolCard";
import { UserCommandBubble } from "./UserCommandBubble";
import { SystemNote } from "./SystemNote";
import { DreamSummary } from "./DreamSummary";
import styles from "./ChatLog.module.css";

interface Props {
  messages: DreamWeaverMessage[];
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (msg: DreamWeaverMessage, nudge: string | null) => void;
}

export function ChatLog({ messages, onAccept, onReject, onCancel, onRetry }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  const latestInChain = useMemo(() => {
    const supersededIds = new Set(messages.map((m) => m.supersedes_id).filter(Boolean) as string[]);
    return new Set(messages.filter((m) => m.kind === "tool_card" && !supersededIds.has(m.id)).map((m) => m.id));
  }, [messages]);

  return (
    <div className={styles.log} ref={ref}>
      {messages.length === 0 && <SystemNote text="Session ready · enter a dream and click Dream to begin" />}
      {messages.map((m) => {
        if (m.kind === "dream_summary") {
          const p = m.payload as any;
          return <DreamSummary key={m.id} dreamText={p.dream_text} tone={p.tone} dislikes={p.dislikes} />;
        }
        if (m.kind === "user_command") {
          return <UserCommandBubble key={m.id} raw={(m.payload as any).raw} />;
        }
        if (m.kind === "system_note") {
          return <SystemNote key={m.id} text={(m.payload as any).text} />;
        }
        if (m.kind === "tool_card") {
          return (
            <ToolCard
              key={m.id}
              message={m}
              isLatestInChain={latestInChain.has(m.id)}
              onAccept={onAccept}
              onReject={onReject}
              onCancel={onCancel}
              onRetry={onRetry}
            />
          );
        }
        return null;
      })}
    </div>
  );
}
