import { assertOrganizationKind, organizationError, type ConnectionOrganizationError } from '../shared/connection-organization';
import type { BackendOrganizationAPI, OrganizationHostMessage, OrganizationWorkerMessage } from './connection-organization-contract';

export function createOrganizationRuntime(transport: {
  request(message: Exclude<OrganizationWorkerMessage, { type: 'connection_organization_unwatch' }>): Promise<unknown>;
  send(message: OrganizationWorkerMessage): void;
}) {
  const listeners = new Map<string, { handler: Parameters<BackendOrganizationAPI['watch']>[1]; onError: (error: ConnectionOrganizationError) => void }>();
  const api: BackendOrganizationAPI = {
    async get(options) {
      assertOrganizationKind(options?.kind);
      try { return await transport.request({ type: 'connection_organization_get', requestId: crypto.randomUUID(), options }) as Awaited<ReturnType<BackendOrganizationAPI['get']>>; }
      catch (error) { throw organizationError(error); }
    },
    watch(options, handler, onError = error => console.error('[connection-organization]', error)) {
      assertOrganizationKind(options?.kind);
      if (typeof handler !== 'function') throw new TypeError('A watch handler is required');
      const subscriptionId = crypto.randomUUID();
      const stop = () => {
        if (!listeners.delete(subscriptionId)) return;
        transport.send({ type: 'connection_organization_unwatch', subscriptionId });
      };
      listeners.set(subscriptionId, { handler, onError });
      void transport.request({ type: 'connection_organization_watch', requestId: crypto.randomUUID(), subscriptionId, options })
        .catch(error => {
          if (!listeners.has(subscriptionId)) return;
          stop();
          try { onError(organizationError(error)); } catch { /* Consumer isolation. */ }
        });
      return stop;
    },
  };
  return { api, receive(message: OrganizationHostMessage) {
    const listener = listeners.get(message.subscriptionId);
    if (!listener) return;
    try {
      if (message.error) listener.onError(organizationError(new Error(message.error)));
      else if (message.snapshot) listener.handler(message.snapshot);
    } catch { /* Consumer isolation. */ }
  }, dispose() { for (const subscriptionId of listeners.keys()) transport.send({ type: 'connection_organization_unwatch', subscriptionId }); listeners.clear(); } };
}
