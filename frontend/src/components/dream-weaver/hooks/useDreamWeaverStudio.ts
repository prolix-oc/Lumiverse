import { useCallback, useEffect, useState } from "react";
import { dreamWeaverApi } from "@/api/dream-weaver";
import type { DreamWeaverSession } from "@/api/dream-weaver";
import { dreamWeaverToolingApi, type DreamWeaverWorkspace } from "@/api/dream-weaver-tooling";

export type TabId = "studio" | "visuals";
export const MAIN_TABS: TabId[] = ["studio", "visuals"];

export function useDreamWeaverStudio(sessionId: string) {
  const [session, setSession] = useState<DreamWeaverSession | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("studio");
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [draft, setDraft] = useState<DreamWeaverWorkspace | null>(null);

  useEffect(() => {
    setLoading(true);
    dreamWeaverApi
      .getSession(sessionId)
      .then(setSession)
      .catch((e: any) => setErrorMessage(e?.message ?? "Failed to load session"))
      .finally(() => setLoading(false));
  }, [sessionId]);

  const refreshDraft = useCallback(async () => {
    try {
      const d = await dreamWeaverToolingApi.getDraft(sessionId);
      setDraft(d);
    } catch {
    }
  }, [sessionId]);

  useEffect(() => { void refreshDraft(); }, [refreshDraft]);

  const finalize = useCallback(async () => {
    setFinalizing(true);
    try {
      await dreamWeaverApi.finalize(sessionId);
      const updated = await dreamWeaverApi.getSession(sessionId);
      setSession(updated);
    } catch (e: any) {
      setErrorMessage(e?.message ?? "Finalize failed");
    } finally {
      setFinalizing(false);
    }
  }, [sessionId]);

  const dismissError = useCallback(() => setErrorMessage(null), []);

  const updateWorkspaceKind = useCallback(async (kind: "character" | "scenario") => {
    try {
      const updated = await dreamWeaverApi.updateSession(sessionId, { workspace_kind: kind });
      setSession(updated);
      await refreshDraft();
    } catch (e: any) {
      setErrorMessage(e?.message ?? "Failed to update studio type");
    }
  }, [refreshDraft, sessionId]);

  return {
    session,
    draft,
    activeTab,
    setActiveTab,
    loading,
    errorMessage,
    dismissError,
    finalizing,
    finalize,
    refreshDraft,
    updateWorkspaceKind,
  };
}
