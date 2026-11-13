import { afterEach, expect, test } from 'bun:test';
import type { ExtensionInfo, SpindleManifest } from 'lumiverse-spindle-types';
import { WorkerHost } from './worker-host';
import { interceptorPipeline } from './interceptor-pipeline';
import { INTERNAL_PRESET_METADATA_KEY } from './preset-metadata-context';

const extensionId = 'interceptor-boundary-test';
afterEach(() => interceptorPipeline.unregisterByExtension(extensionId));

function fixture(required: boolean, identifier = extensionId) {
  const host = new WorkerHost(extensionId, {
    identifier, name: extensionId, interceptorTimeoutMs: 1000,
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
  internal.handleMessage({ type: 'register_interceptor', registrationId: 'registered', priority: 1, required });
  return { internal, posted };
}

test('the worker receives the preset id and only its own manifest-keyed preset metadata', async () => {
  const { internal, posted } = fixture(false, 'preset_scope_test');
  const shared = {
    chatId: 'chat', presetId: 'preset-1',
    [INTERNAL_PRESET_METADATA_KEY]: {
      preset_scope_test: { chatRanges: [{ start: -4, end: 0 }] },
      [extensionId]: { keyedBy: 'extension row id' },
      other_extension: { secret: 'other' },
    },
  };
  const pending = interceptorPipeline.run([], shared, 'user');
  const request = posted.find(message => message.type === 'intercept_request');
  expect(request.context.presetId).toBe('preset-1');
  expect(request.context.presetMetadata).toEqual({ chatRanges: [{ start: -4, end: 0 }] });
  expect(request.context).not.toHaveProperty(INTERNAL_PRESET_METADATA_KEY);
  expect(JSON.stringify(request.context)).not.toContain('other');
  request.context.presetMetadata.chatRanges[0].start = 99;
  expect(shared[INTERNAL_PRESET_METADATA_KEY].preset_scope_test.chatRanges[0].start).toBe(-4);
  internal.handleMessage({ type: 'intercept_result', requestId: request.requestId, registrationId: 'registered', messages: [] });
  await pending;
});

test('the worker receives a null preset id and no metadata when no preset was resolved', async () => {
  const { internal, posted } = fixture(false, 'preset_scope_test');
  const pending = interceptorPipeline.run([], { chatId: 'chat', presetId: null }, 'user');
  const request = posted.find(message => message.type === 'intercept_request');
  expect(request.context.presetId).toBeNull();
  expect(request.context.presetMetadata).toBeUndefined();
  internal.handleMessage({ type: 'intercept_result', requestId: request.requestId, registrationId: 'registered', messages: [] });
  await pending;
});

test('a required worker error rejects generation instead of returning the original prompt', async () => {
  const { internal, posted } = fixture(true);
  const pending = interceptorPipeline.run([{ role: 'user', content: 'unprocessed' }], {}, 'user').catch(error => error);
  const request = posted.find(message => message.type === 'intercept_request');
  expect(request).toBeDefined();
  internal.handleMessage({ type: 'intercept_result', requestId: request.requestId, registrationId: 'registered', messages: request.messages, error: 'Browser disconnected' });
  expect((await pending).message).toBe('Browser disconnected');
});

test('legacy registrations keep the previous optional worker failure behavior', async () => {
  const { internal, posted } = fixture(false);
  const messages = [{ role: 'user' as const, content: 'unprocessed' }];
  const pending = interceptorPipeline.run(messages, {}, 'user');
  const request = posted.find(message => message.type === 'intercept_request');
  internal.handleMessage({ type: 'intercept_result', requestId: request.requestId, registrationId: 'registered', messages, error: 'Optional failure' });
  expect((await pending).messages).toEqual(messages);
});

test('an empty worker error still rejects a required interceptor', async () => {
  const { internal, posted } = fixture(true);
  const pending = interceptorPipeline.run([], {}, 'user').catch(error => error);
  const request = posted.find(message => message.type === 'intercept_request');
  internal.handleMessage({ type: 'intercept_result', requestId: request.requestId, registrationId: 'registered', messages: [], error: '' });
  expect(await pending).toBeInstanceOf(Error);
});

test('replacing an interceptor does not change a pending invocation failure policy', async () => {
  const { internal, posted } = fixture(true);
  const pending = interceptorPipeline.run([], {}, 'user').catch(error => error);
  const request = posted.find(message => message.type === 'intercept_request');
  internal.handleMessage({ type: 'register_interceptor', registrationId: 'registered', priority: 1, required: false });
  internal.handleMessage({ type: 'intercept_result', requestId: request.requestId, registrationId: 'registered', messages: [], error: 'Original required failure' });
  expect((await pending).message).toBe('Original required failure');
});

test('a reply arriving during request delivery cannot be lost before registration', async () => {
  const { internal } = fixture(true);
  internal.runtime.postMessage = (raw) => {
    const message = raw as any;
    if (message.type === 'intercept_request') internal.handleMessage({
      type: 'intercept_result', requestId: message.requestId, registrationId: message.registrationId,
      messages: [], error: 'Immediate worker failure',
    });
  };
  expect((await interceptorPipeline.run([], {}, 'user').catch(error => error)).message).toBe('Immediate worker failure');
});

test('worker delivery failure releases the pending interceptor immediately', async () => {
  const { internal } = fixture(true);
  internal.runtime.postMessage = () => { throw new Error('Worker closed'); };
  expect((await interceptorPipeline.run([], {}, 'user').catch(error => error)).message).toBe('Extension worker stopped');
  expect(internal.pendingRequests.size).toBe(0);
});

test('cancellation sends an abort to the exact worker invocation and ignores a late result', async () => {
  const { internal, posted } = fixture(true);
  const controller = new AbortController();
  const pending = interceptorPipeline.run([], {}, 'user', controller.signal).catch(error => error);
  const request = posted.find(message => message.type === 'intercept_request');
  const reason = new Error('Stopped');
  controller.abort(reason);
  expect(await pending).toBe(reason);
  expect(posted.filter(message => message.type === 'intercept_abort')).toEqual([
    { type: 'intercept_abort', requestId: request.requestId, registrationId: 'registered', reason: 'Stopped' },
  ]);
  expect(() => internal.handleMessage({ type: 'intercept_result', requestId: request.requestId, registrationId: 'registered', messages: [], error: 'late' })).not.toThrow();
});

test('the interceptor deadline rejects and releases a worker invocation that never replies', async () => {
  const { internal, posted } = fixture(true);
  await expect(interceptorPipeline.run([], {}, 'user')).rejects.toThrow('timed out');
  expect(internal.pendingRequests.size).toBe(0);
  expect(posted.filter(message => message.type === 'intercept_abort')).toHaveLength(1);
});
