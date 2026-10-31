import type { WorkerToHost } from 'lumiverse-spindle-types';
import { runThemeReferences } from '../services/theme-reference.service';

export async function handleThemeReferences(
  message: Extract<WorkerToHost, { type: 'theme_references' }>,
  post: (response: { type: 'response'; requestId: string; result?: unknown; error?: string }) => void,
): Promise<void> {
  try {
    const result = await runThemeReferences(message.input?.operation, message.input?.args);
    post({ type: 'response', requestId: message.requestId, result });
  } catch (error) {
    post({
      type: 'response',
      requestId: message.requestId,
      error: error instanceof Error ? error.message : 'Theme reference lookup failed.',
    });
  }
}
