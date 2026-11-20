import { expect, spyOn, test } from 'bun:test';
import { eventBus } from '../ws/bus';
import { EventType } from '../ws/events';
import { clearAllPoolEntries, createPoolEntry, getPoolEntry, sweepPoolNow } from './generation-pool.service';

test('timeout recovery retains the initiating document on its terminal event', () => {
  const events: any[] = [];
  const emit = spyOn(eventBus, 'emit').mockImplementation((event, payload) => {
    if (event === EventType.GENERATION_ENDED) events.push(payload);
  });
  try {
    createPoolEntry({ generationId: 'origin-test', userId: 'owner', chatId: 'chat', generationType: 'normal',
      characterName: '', model: 'test', frontendSessionId: '0123456789abcdef0123456789abcdef' });
    getPoolEntry('origin-test')!.lastActivityAt = Date.now() - 61 * 60 * 1000;
    sweepPoolNow();
    expect(events).toHaveLength(1);
    expect(events[0].frontendSessionId).toBe('0123456789abcdef0123456789abcdef');
    expect(events[0].errorCode).toBe('generation_timeout');
  } finally { emit.mockRestore(); clearAllPoolEntries(); }
});
