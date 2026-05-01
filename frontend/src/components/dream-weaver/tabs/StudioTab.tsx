import { useEffect, useState } from "react";
import { dreamWeaverToolingApi, type ToolCatalogEntry, type DreamWeaverMessage } from "@/api/dream-weaver-tooling";
import { useDreamWeaverMessages } from "../hooks/useDreamWeaverMessages";
import { ChatLog } from "../components/chat/ChatLog";
import { Composer } from "../components/chat/Composer";
import styles from "./StudioTab.module.css";

interface Props {
  sessionId: string;
  onWorkspaceChanged?: () => void | Promise<void>;
}

export function StudioTab({ sessionId, onWorkspaceChanged }: Props) {
  const [catalog, setCatalog] = useState<ToolCatalogEntry[]>([]);
  const { messages, invoke, accept, reject, cancel } = useDreamWeaverMessages(sessionId);

  useEffect(() => { dreamWeaverToolingApi.listTools().then(setCatalog); }, []);

  const onSubmit = (toolName: string, rawArgs: string, raw: string) => {
    void invoke({
      tool: toolName,
      args: {},
      nudge_text: rawArgs.trim() || null,
      raw,
    }).then(() => {
      if (toolName === "dream_source") void onWorkspaceChanged?.();
    });
  };

  const onRetry = (msg: DreamWeaverMessage, nudge: string | null) => {
    void invoke({
      tool: msg.tool_name!,
      args: (msg.payload as any).args ?? {},
      nudge_text: nudge,
      supersedes_id: msg.id,
    });
  };

  const acceptAndRefresh = async (id: string) => {
    await accept(id);
    await onWorkspaceChanged?.();
  };

  const rejectAndRefresh = async (id: string) => {
    await reject(id);
    await onWorkspaceChanged?.();
  };

  return (
    <div className={styles.region}>
      <ChatLog messages={messages} onAccept={acceptAndRefresh} onReject={rejectAndRefresh} onCancel={cancel} onRetry={onRetry} />
      <Composer catalog={catalog} onSubmit={onSubmit} />
    </div>
  );
}
