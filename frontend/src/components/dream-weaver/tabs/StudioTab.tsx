import { useCallback, useEffect, useRef, useState } from "react";
import { dreamWeaverToolingApi, type ToolCatalogEntry, type DreamWeaverMessage } from "@/api/dream-weaver-tooling";
import type { DreamWeaverSession } from "@/api/dream-weaver";
import { useDreamWeaverMessages } from "../hooks/useDreamWeaverMessages";
import { useSuiteRunner } from "../hooks/useSuiteRunner";
import { ChatLog } from "../components/chat/ChatLog";
import { Composer } from "../components/chat/Composer";
import { SuiteRunner } from "../components/SuiteRunner";
import { ProgressBadges } from "../components/ProgressBadges";
import type { FieldStatus } from "../hooks/useProgressTracker";
import styles from "./StudioTab.module.css";

interface Props {
  sessionId: string;
  hasSource: boolean;
  workspaceKind: DreamWeaverSession["workspace_kind"];
  progressFields: FieldStatus[];
  onWorkspaceChanged?: () => void | Promise<void>;
}

export function StudioTab({ sessionId, hasSource, workspaceKind, progressFields, onWorkspaceChanged }: Props) {
  const [catalog, setCatalog] = useState<ToolCatalogEntry[]>([]);
  const [suiteVisible, setSuiteVisible] = useState(true);
  const { messages, invoke, accept, reject, cancel, updateSource } = useDreamWeaverMessages(sessionId);

  const suite = useSuiteRunner(sessionId);

  const prevSuiteState = useRef(suite.state);
  useEffect(() => {
    if (prevSuiteState.current === "running" && suite.state === "done") {
      void onWorkspaceChanged?.();
    }
    prevSuiteState.current = suite.state;
  }, [suite.state, onWorkspaceChanged]);

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

  const saveDream = useCallback(async (messageId: string, newText: string) => {
    await updateSource(messageId, newText);
    await onWorkspaceChanged?.();
  }, [onWorkspaceChanged, updateSource]);

  const showSuite = suiteVisible && (hasSource || suite.state !== "idle");

  return (
    <div className={styles.region}>
      <ProgressBadges fields={progressFields} workspaceKind={workspaceKind} />
      {showSuite && (
        <SuiteRunner suite={suite} onDismiss={() => setSuiteVisible(false)} />
      )}
      <ChatLog messages={messages} onAccept={acceptAndRefresh} onReject={rejectAndRefresh} onCancel={cancel} onRetry={onRetry} onSaveDream={saveDream} />
      <Composer catalog={catalog} hasSource={hasSource} onSubmit={onSubmit} />
    </div>
  );
}
