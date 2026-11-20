import { expect, spyOn, test } from 'bun:test';
import type { ExtensionInfo, SpindleManifest } from 'lumiverse-spindle-types';
import { WorkerHost } from './worker-host';
import { registerFrontendSession } from './frontend-session';
import { eventBus } from '../ws/bus';
import { EventType } from '../ws/events';

for (const scope of ['user', 'operator'] as const) {
  test(`${scope} extension document delivery preserves user scope and never falls back to broadcast`, () => {
    const host = new WorkerHost('routing-test', { identifier: 'routing-test' } as SpindleManifest, {
      id: 'routing-test', identifier: 'routing-test', name: 'Test', version: '0.0.0', author: '',
      description: '', github: '', homepage: '', permissions: [], granted_permissions: [],
      enabled: true, installed_at: 0, updated_at: 0, has_frontend: false, has_backend: false,
      status: 'stopped', metadata: { install_scope: scope, installed_by_user_id: 'owner' },
    } satisfies ExtensionInfo);
    const internal = host as unknown as { handleMessage(message: unknown): void; postToWorker(message: unknown): void };
    const posted: unknown[] = [], received: Record<string, any[]> = { owner: [], other: [] };
    internal.postToWorker = message => { posted.push(message); };
    const emit = spyOn(eventBus, 'emit').mockImplementation(() => {});
    const id = '0123456789abcdef0123456789abcdef';
    const removers = ['owner', 'other'].map(userId => registerFrontendSession(userId, id, {
      send: value => received[userId]!.push(JSON.parse(value)), close() {}, closed() {},
    }));
    try {
      internal.handleMessage({ type: 'frontend_message', userId: 'other', frontendSessionId: id, payload: 'hello' });
      const target = scope === 'user' ? 'owner' : 'other';
      expect(received[target]).toHaveLength(1);
      expect(received[target]![0].payload.data).toBe('hello');
      expect(received[scope === 'user' ? 'other' : 'owner']).toEqual([]);
      const missing = '1123456789abcdef0123456789abcdef';
      internal.handleMessage({ type: 'frontend_message', userId: 'other', frontendSessionId: missing, payload: 'missing' });
      expect(posted).toEqual([{ type: 'event', event: EventType.FRONTEND_SESSION_CLOSED, userId: target, payload: { frontendSessionId: missing } }]);
      expect(emit).not.toHaveBeenCalled();
      internal.handleMessage({ type: 'frontend_message', userId: 'other', payload: 'legacy' });
      expect(emit).toHaveBeenCalledWith(EventType.SPINDLE_FRONTEND_MSG, expect.objectContaining({ data: 'legacy' }), target);
      host.sendFrontendMessage('incoming', 'owner', id);
      expect(posted.at(-1)).toEqual({ type: 'frontend_message', payload: 'incoming', userId: 'owner', frontendSessionId: id });
    } finally { removers.forEach(remove => remove()); emit.mockRestore(); }
  });
}
