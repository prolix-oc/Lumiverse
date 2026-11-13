import { getConnectionOrganization, watchUserConnectionOrganization } from '../services/connection-organization.service';
import type { OrganizationHostMessage, OrganizationWorkerMessage } from './connection-organization-contract';

/** Owns subscriptions for exactly one extension runtime. */
export class ConnectionOrganizationHost {
  private watches = new Map<string, () => void>();
  constructor(private readonly context: {
    resolveUser(userId?: string): string;
    post(message: OrganizationHostMessage | { type: 'response'; requestId: string; result?: unknown; error?: string }): void;
  }) {}
  handle(message: OrganizationWorkerMessage): void {
    if (message.type === 'connection_organization_unwatch') {
      this.watches.get(message.subscriptionId)?.();
      this.watches.delete(message.subscriptionId);
      return;
    }
    try {
      const userId = this.context.resolveUser(message.options?.userId);
      if (!userId) throw Object.assign(new Error(), { code: 'USER_CONTEXT_REQUIRED' });
      const kind = message.options?.kind;
      if (message.type === 'connection_organization_get') {
        this.context.post({ type: 'response', requestId: message.requestId, result: getConnectionOrganization(userId, kind) });
      } else {
        if (typeof message.subscriptionId !== 'string' || !message.subscriptionId || message.subscriptionId.length > 128
          || this.watches.has(message.subscriptionId) || this.watches.size >= 64)
          throw Object.assign(new Error(), { code: 'CONNECTION_WATCH_LIMIT' });
        const stop = watchUserConnectionOrganization(userId, kind,
          snapshot => this.context.post({ type: 'connection_organization_snapshot', subscriptionId: message.subscriptionId, snapshot }),
          () => this.context.post({ type: 'connection_organization_snapshot', subscriptionId: message.subscriptionId, error: 'CONNECTION_ORGANIZATION_READ_FAILED' }));
        this.watches.set(message.subscriptionId, stop);
        this.context.post({ type: 'response', requestId: message.requestId, result: null });
      }
    } catch (error) {
      const code = (error as { code?: string })?.code;
      this.context.post({ type: 'response', requestId: message.requestId,
        error: ['USER_CONTEXT_REQUIRED', 'CONNECTION_KIND_INVALID', 'CONNECTION_WATCH_LIMIT'].includes(code ?? '')
          ? code : 'CONNECTION_ORGANIZATION_READ_FAILED' });
    }
  }
  dispose(): void { for (const stop of this.watches.values()) stop(); this.watches.clear(); }
}
