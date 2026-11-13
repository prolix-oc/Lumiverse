import { afterEach, expect, test } from 'bun:test';
import { contextHandlerChain } from './context-handler';

afterEach(() => {
  contextHandlerChain.unregisterByExtension('required-context');
  contextHandlerChain.unregisterByExtension('following-context');
});

test('a required context failure prevents subsequent handlers from sending an incomplete prompt', async () => {
  let following = 0;
  contextHandlerChain.register({ extensionId: 'required-context', priority: 1, required: true, handler: async () => { throw new Error('Browser disconnected'); } });
  contextHandlerChain.register({ extensionId: 'following-context', priority: 2, handler: async context => { following++; return context; } });
  await expect(contextHandlerChain.run({})).rejects.toThrow('Browser disconnected');
  expect(following).toBe(0);
});

test('optional context failures retain the original context', async () => {
  contextHandlerChain.register({ extensionId: 'required-context', priority: 1, handler: async () => { throw new Error('Optional failure'); } });
  const context = { chatId: 'chat' };
  expect(await contextHandlerChain.run(context)).toBe(context);
});

test('context timeout cancels the exact suspended operation', async () => {
  let signal!: AbortSignal;
  contextHandlerChain.register({ extensionId: 'required-context', priority: 1, required: true, timeoutMs: 5, handler: (_context, value) => { signal = value!; return new Promise(() => {}); } });
  await expect(contextHandlerChain.run({})).rejects.toThrow('timed out');
  expect(signal.aborted).toBe(true);
});

test('generation cancellation reaches the context handler', async () => {
  const controller = new AbortController();
  let signal!: AbortSignal;
  contextHandlerChain.register({ extensionId: 'required-context', priority: 1, handler: (_context, value) => { signal = value!; return new Promise(() => {}); } });
  const result = contextHandlerChain.run({}, undefined, controller.signal).catch(error => error);
  const reason = new Error('Generation stopped');
  controller.abort(reason);
  expect(await result).toBe(reason);
  expect(signal.reason).toBe(reason);
});
