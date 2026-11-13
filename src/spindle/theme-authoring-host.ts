import { PERMISSION_DENIED_PREFIX } from 'lumiverse-spindle-types';
import {
  runThemeAuthoring,
  THEME_READ_OPERATIONS,
  THEME_WRITE_OPERATIONS,
} from '../services/theme-authoring.service';
import type { ThemeAuthoringWorkerMessage } from './theme-authoring-runtime';

interface ThemeAuthoringHostContext {
  resolveUser(userId?: string): string;
  canMutate(): boolean;
  post(message: { type: 'response'; requestId: string; result?: unknown; error?: string }): void;
}
export class ThemeAuthoringHost {
  private active = true;
  constructor(private readonly context: ThemeAuthoringHostContext) {}
  dispose(): void {
    this.active = false;
  }
  async handle(message: ThemeAuthoringWorkerMessage): Promise<void> {
    const context = this.context;
    try {
      if (!this.active) throw new Error('Theme service is stopped.');
      const userId = context.resolveUser(message.userId);
      if (!userId) throw new Error('userId is required for operator-scoped extensions');
      const operation = message.input?.operation;
      if (!THEME_READ_OPERATIONS.has(operation) && !THEME_WRITE_OPERATIONS.has(operation))
        throw new Error('Unknown theme operation.');
      const authorize = () => {
        if (!this.active) throw new Error('Theme service is stopped.');
        if (THEME_WRITE_OPERATIONS.has(operation) && !context.canMutate())
          throw new Error(
            `${PERMISSION_DENIED_PREFIX} app_manipulation: Theme changes require app_manipulation permission.`,
          );
      };
      authorize();
      const result = await runThemeAuthoring(userId, operation, message.input.args, authorize);
      context.post({ type: 'response', requestId: message.requestId, result });
    } catch (error) {
      context.post({
        type: 'response',
        requestId: message.requestId,
        error: error instanceof Error ? error.message : 'Theme operation failed.',
      });
    }
  }
}
