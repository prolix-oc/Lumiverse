import { expect, test } from 'bun:test';
import { watchConnectionOrganization, type ConnectionOrganizationSnapshot } from './connection-organization';
const snapshot = (revision: string): ConnectionOrganizationSnapshot => ({ kind: 'llm', revision, connections: [], folders: [], recentConnectionIds: [] });
test('invalidation during initial read cannot deliver a stale snapshot', async () => {
  const pending: Array<(snapshot: ConnectionOrganizationSnapshot) => void> = [];
  const values: string[] = []; let refresh!: () => void; let detached = false;
  const stop = watchConnectionOrganization(() => new Promise(resolve => pending.push(resolve)), callback => {
    refresh = callback; return () => { detached = true; };
  }, value => values.push(value.revision));
  refresh(); pending.shift()!(snapshot('old')); await Bun.sleep(0);
  expect(values).toEqual([]);
  pending.shift()!(snapshot('new')); await Bun.sleep(0);
  expect(values).toEqual(['new']);
  refresh(); stop(); pending.shift()!(snapshot('after')); await Bun.sleep(0);
  expect(detached).toBe(true); expect(values).toEqual(['new']);
});
test('watch errors are isolated and later invalidations recover', async () => {
  let refresh!: () => void; let failed = true; let errors = 0; let delivered = 0;
  const stop = watchConnectionOrganization(async () => { if (failed) throw new Error('offline'); return snapshot('ok'); }, cb => { refresh = cb; return () => {}; },
    () => { delivered++; throw new Error('consumer'); }, () => { errors++; });
  await Bun.sleep(0); failed = false; refresh(); await Bun.sleep(0);
  expect(delivered).toBe(1); expect(errors).toBe(2); stop();
});
