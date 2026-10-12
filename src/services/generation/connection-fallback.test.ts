import { describe, expect, test } from 'bun:test';
import type { StreamChunk } from '../../llm/types';
import { withConnectionFallback } from './connection-fallback';

async function* stream(chunks: StreamChunk[], error?: Error): AsyncGenerator<StreamChunk, void, unknown> {
  yield* chunks;
  if (error) throw error;
}
async function collect(source: AsyncGenerator<StreamChunk, void, unknown>) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}
const failure = new Error('Provider unavailable');
const signal = () => new AbortController().signal;

describe('connection fallback', () => {
  test('uses the primary on success without resolving fallback', async () => {
    const chunks = [{ token: 'Primary' }];
    expect(await collect(withConnectionFallback(stream(chunks), async () => { throw new Error('Unexpected retry'); }, signal()))).toEqual(chunks);
  });
  test('retries an empty failed stream once', async () => {
    let retries = 0;
    const result = await collect(withConnectionFallback(stream([{ token: '' }], failure), async () => {
      retries++;
      return stream([{ token: 'Fallback' }]);
    }, signal()));
    expect(result.at(-1)?.token).toBe('Fallback');
    expect(retries).toBe(1);
  });
  test('propagates fallback failure without another retry', async () => {
    const second = new Error('Fallback failed');
    await expect(collect(withConnectionFallback(stream([], failure), async () => stream([], second), signal()))).rejects.toBe(second);
  });
  test('preserves the original failure if fallback was removed', async () => {
    await expect(collect(withConnectionFallback(stream([], failure), async () => null, signal()))).rejects.toBe(failure);
  });
  for (const chunk of [
    { token: 'Partial' }, { token: '', reasoning: 'Thinking' },
    { token: '', tool_calls: [{ call_id: 'call', name: 'lookup', args: {} }] },
    { token: '', finish_reason: 'stop' },
  ] as StreamChunk[]) {
    test(`does not retry after output: ${JSON.stringify(chunk)}`, async () => {
      let retries = 0;
      await expect(collect(withConnectionFallback(stream([chunk], failure), async () => { retries++; return null; }, signal()))).rejects.toBe(failure);
      expect(retries).toBe(0);
    });
  }
  test('does not retry a stopped request or AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    let retries = 0;
    const fallback = async () => { retries++; return null; };
    await expect(collect(withConnectionFallback(stream([], failure), fallback, controller.signal))).rejects.toBe(failure);
    const aborted = new DOMException('Stopped', 'AbortError');
    await expect(collect(withConnectionFallback(stream([], aborted), fallback, signal()))).rejects.toBe(aborted);
    expect(retries).toBe(0);
  });
  test('a stop during fallback resolution prevents its provider request', async () => {
    const controller = new AbortController();
    let called = false;
    const next = async function* () { called = true; yield { token: 'Backup' }; };
    await expect(collect(withConnectionFallback(stream([], failure), async () => {
      controller.abort();
      return next();
    }, controller.signal))).rejects.toThrow();
    expect(called).toBe(false);
  });
});
