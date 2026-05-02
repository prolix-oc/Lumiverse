import * as apiClient from "./client";
import type { DreamWeaverVisualAsset } from "./dream-weaver";

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
  kind: "user_command" | "tool_card" | "system_note" | "dream_summary" | "source_card";
  payload: Record<string, unknown>;
  tool_name: string | null;
  status: "running" | "pending" | "accepted" | "rejected" | "superseded" | null;
  supersedes_id: string | null;
}

export interface DreamWeaverWorkspace {
  kind: "character" | "scenario";
  sources: Array<{
    id: string;
    type: "dream" | "note" | "import_character" | "import_worldbook";
    title: string;
    content: string;
    tone?: string | null;
    constraints?: string | null;
    dislikes?: string | null;
  }>;
  name: string | null;
  appearance: string | null;
  appearance_data: Record<string, unknown> | null;
  personality: string | null;
  scenario: string | null;
  first_mes: string | null;
  greeting: string | null;
  voice_guidance: any;
  lorebooks: Array<{ key: string[]; comment: string; content: string }>;
  npcs: Array<{ name: string; description: string; voice_notes?: string }>;
  visual_assets?: DreamWeaverVisualAsset[];
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
  async getDraft(sessionId: string): Promise<DreamWeaverWorkspace> {
    const res = await apiClient.get<{ draft: DreamWeaverWorkspace }>(
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
