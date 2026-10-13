import type { GenerationParameters } from "../../llm/types";

export function injectConnectionMetadataFlags(
  connection: { provider: string; metadata?: Record<string, any> },
  params: GenerationParameters,
  chatId?: string,
): void {
  if (connection.metadata?.use_responses_api) {
    params.use_responses_api = true;
  }

  if (connection.provider !== "openrouter") return;
  if (connection.metadata?.openrouter) {
    params._openrouter = connection.metadata.openrouter;
  }

  // Keep OpenRouter's sticky-routing session scoped to one chat and preserve
  // any caller-provided session or cache key.
  if (
    chatId
    && params.session_id === undefined
    && params.prompt_cache_key === undefined
  ) {
    params.session_id = `lumiverse:${chatId}`;
  }
}
