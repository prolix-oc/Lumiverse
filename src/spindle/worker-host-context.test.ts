import { afterEach, expect, test } from 'bun:test';
import type { ExtensionInfo, SpindleManifest } from 'lumiverse-spindle-types';
import { WorkerHost } from './worker-host';
import { contextHandlerChain } from './context-handler';

const extensionId = 'context-boundary-test';
afterEach(() => contextHandlerChain.unregisterByExtension(extensionId));

function fixture(required: boolean) {
  const host = new WorkerHost(extensionId, {
    identifier: extensionId, name: extensionId, interceptorTimeoutMs: 1000,
  } as SpindleManifest, {
    id: extensionId, identifier: extensionId, name: extensionId, version: '0.0.0',
    author: '', description: '', github: '', homepage: '', permissions: [],
    granted_permissions: [], enabled: true, installed_at: 0, updated_at: 0,
    has_frontend: false, has_backend: false, status: 'stopped',
    metadata: { install_scope: 'user', installed_by_user_id: 'user' },
  } satisfies ExtensionInfo);
  const posted: any[] = [];
  const internal = host as unknown as {
    hasPermission(permission: string): boolean;
    handleMessage(message: unknown): void;
    pendingRequests: Map<string, unknown>;
    runtime: { mode: string; pid: null; postMessage(message: unknown): void; terminate(): void };
  };
  internal.hasPermission = () => true;
  internal.runtime = { mode: 'worker', pid: null, postMessage: message => { posted.push(message); }, terminate() {} };
  internal.handleMessage({ type: 'register_context_handler', registrationId: 'registered', priority: 1, timeoutMs: 1000, required });
  return { internal, posted };
}

test('a required worker error rejects generation instead of returning the original prompt', async () => {
  const { internal, posted } = fixture(true);
  const pending = contextHandlerChain.run({ text: 'unprocessed' }, 'user').catch(error => error);
  const request = posted.find(message => message.type === 'context_handler_request');
  expect(request).toBeDefined();
  internal.handleMessage({ type: 'context_handler_result', requestId: request.requestId, registrationId: 'registered', context: request.context, error: 'Browser disconnected' });
  expect((await pending as Error).message).toBe('Browser disconnected');
});

test('legacy registrations keep the previous optional worker failure behavior', async () => {
  const { internal, posted } = fixture(false);
  const messages = [{ role: 'user' as const, content: 'unprocessed' }];
  const pending = contextHandlerChain.run(messages, 'user');
  const request = posted.find(message => message.type === 'context_handler_request');
  internal.handleMessage({ type: 'context_handler_result', requestId: request.requestId, registrationId: 'registered', context: messages, error: 'Optional failure' });
  expect((await pending)).toEqual(messages);
});

test('an empty worker error still rejects a required context handler', async () => {
  const { internal, posted } = fixture(true);
  const pending = contextHandlerChain.run({}, 'user').catch(error => error);
  const request = posted.find(message => message.type === 'context_handler_request');
  internal.handleMessage({ type: 'context_handler_result', requestId: request.requestId, context: {}, error: '' });
  expect(await pending).toBeInstanceOf(Error);
});

test('replacing a context handler does not change a pending invocation failure policy', async () => {
  const { internal, posted } = fixture(true);
  const pending = contextHandlerChain.run({}, 'user').catch(error => error);
  const request = posted.find(message => message.type === 'context_handler_request');
  internal.handleMessage({ type: 'register_context_handler', priority: 1, required: false });
  internal.handleMessage({ type: 'context_handler_result', requestId: request.requestId, context: {}, error: 'Original required failure' });
  expect((await pending as Error).message).toBe('Original required failure');
});

test('a reply arriving during request delivery cannot be lost before registration', async () => {
  const { internal } = fixture(true);
  internal.runtime.postMessage = (raw) => {
    const message = raw as any;
    if (message.type === 'context_handler_request') internal.handleMessage({
      type: 'context_handler_result', requestId: message.requestId, registrationId: message.registrationId,
      context: {}, error: 'Immediate worker failure',
    });
  };
  expect((await contextHandlerChain.run({}, 'user').catch(error => error) as Error).message).toBe('Immediate worker failure');
});

test('cancellation sends an abort to the exact worker invocation and ignores a late result', async () => {
  const { internal, posted } = fixture(true);
  const controller = new AbortController();
  const pending = contextHandlerChain.run({}, 'user', controller.signal).catch(error => error);
  const request = posted.find(message => message.type === 'context_handler_request');
  const reason = new Error('Stopped');
  controller.abort(reason);
  expect(await pending).toBe(reason);
  expect(posted.filter(message => message.type === 'context_handler_abort')).toEqual([
    { type: 'context_handler_abort', requestId: request.requestId, reason: 'Stopped' },
  ]);
  expect(() => internal.handleMessage({ type: 'context_handler_result', requestId: request.requestId, registrationId: 'registered', context: {}, error: 'late' })).not.toThrow();
});

test('the context deadline rejects and releases a worker invocation that never replies', async () => {
  const { internal, posted } = fixture(true);
  await expect(contextHandlerChain.run({}, 'user')).rejects.toThrow('timed out');
  expect(internal.pendingRequests.size).toBe(0);
  expect(posted.filter(message => message.type === 'context_handler_abort')).toHaveLength(1);
});
