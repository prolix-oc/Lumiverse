import { afterEach, expect, test } from 'bun:test';
import { interceptorPipeline } from './interceptor-pipeline';

afterEach(() => {
  interceptorPipeline.unregisterByExtension('required-test');
  interceptorPipeline.unregisterByExtension('following-test');
});

test('a required failed interceptor stops the pipeline before subsequent handlers', async () => {
  let following = 0;
  interceptorPipeline.register({ extensionId: 'required-test', priority: 1, required: true, handler: async () => { throw Error('Browser disconnected'); } });
  interceptorPipeline.register({ extensionId: 'following-test', priority: 2, handler: async messages => { following++; return { messages }; } });
  await expect(interceptorPipeline.run([], {})).rejects.toThrow('Browser disconnected');
  expect(following).toBe(0);
});

test('existing optional interceptors retain their failure policy', async () => {
  let following = 0;
  interceptorPipeline.register({ extensionId: 'required-test', priority: 1, handler: async () => { throw Error('Optional failure'); } });
  interceptorPipeline.register({ extensionId: 'following-test', priority: 2, handler: async messages => { following++; return { messages }; } });
  expect(await interceptorPipeline.run([], {})).toEqual({ messages: [], parameters: undefined });
  expect(following).toBe(1);
});

test('required interceptor timeouts stop the pipeline too', async () => {
  let signal!: AbortSignal;
  interceptorPipeline.register({ extensionId: 'required-test', priority: 1, required: true, resolveTimeoutMs: () => 5, handler: (_messages, _context, value) => { signal = value!; return new Promise(() => {}); } });
  await expect(interceptorPipeline.run([], {})).rejects.toThrow('timed out');
  expect(signal.aborted).toBe(true);
  expect(signal.reason.message).toContain('timed out');
});

test('generation cancellation reaches the suspended interceptor handler', async () => {
  const controller = new AbortController();
  let signal!: AbortSignal;
  interceptorPipeline.register({ extensionId: 'required-test', priority: 1, required: true, handler: (_messages, _context, value) => { signal = value!; return new Promise(() => {}); } });
  const pending = interceptorPipeline.run([], {}, undefined, controller.signal).catch(error => error);
  const reason = new Error('Generation stopped');
  controller.abort(reason);
  expect(await pending).toBe(reason);
  expect(signal.aborted).toBe(true);
  expect(signal.reason).toBe(reason);
});
