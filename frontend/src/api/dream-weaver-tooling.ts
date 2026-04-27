import * as apiClient from "./client";

export interface ToolCatalogEntry {
  name: string;
  displayName: string;
  category: "soul" | "world" | "lifecycle";
  userInvocable: boolean;
  slashCommand: string | null;
  description: string;
  conflictMode: "overwrite" | "append";
}

export interface DreamWeaverMessage {
  id: string;
  session_id: string;
  user_id: string;
  created_at: number;
  seq: number;
  kind: "user_command" | "tool_card" | "system_note" | "dream_summary";
  payload: Record<string, unknown>;
  tool_name: string | null;
  status: "running" | "pending" | "accepted" | "rejected" | "superseded" | null;
  supersedes_id: string | null;
}

export interface DreamWeaverToolTokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  tokenizer_name: string;
  model: string;
}

export const dreamWeaverToolingApi = {
  async listTools(): Promise<ToolCatalogEntry[]> {
    const res = await apiClient.get<{ tools: ToolCatalogEntry[] }>(`/dream-weaver/tools`);
    return res.tools;
  },
  async listMessages(sessionId: string): Promise<DreamWeaverMessage[]> {
    const res = await apiClient.get<{ messages: DreamWeaverMessage[] }>(
      `/dream-weaver/sessions/${sessionId}/messages`,
    );
    return res.messages;
  },
  async getDraft(sessionId: string): Promise<Record<string, unknown>> {
    const res = await apiClient.get<{ draft: Record<string, unknown> }>(
      `/dream-weaver/sessions/${sessionId}/draft`,
    );
    return res.draft;
  },
  async dream(sessionId: string): Promise<void> {
    await apiClient.post(`/dream-weaver/sessions/${sessionId}/dream`, {});
  },
  async invoke(
    sessionId: string,
    body: { tool: string; args?: Record<string, unknown>; nudge_text?: string | null; supersedes_id?: string | null; raw?: string | null },
  ): Promise<{ userCommandId: string | null; cardId: string }> {
    return apiClient.post(`/dream-weaver/sessions/${sessionId}/invoke`, body);
  },
  async accept(sessionId: string, messageId: string): Promise<DreamWeaverMessage> {
    return apiClient.post(`/dream-weaver/sessions/${sessionId}/messages/${messageId}/accept`, {});
  },
  async reject(sessionId: string, messageId: string): Promise<DreamWeaverMessage> {
    return apiClient.post(`/dream-weaver/sessions/${sessionId}/messages/${messageId}/reject`, {});
  },
  async cancel(sessionId: string, messageId: string): Promise<void> {
    await apiClient.post(`/dream-weaver/sessions/${sessionId}/messages/${messageId}/cancel`, {});
  },
};
