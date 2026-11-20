import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeDatabase, getDb, initDatabase } from '../db/connection';
import { putSetting } from '../services/settings.service';
import { ConnectionOrganizationHost } from './connection-organization-host';
import { createOrganizationRuntime } from './connection-organization-runtime';
beforeEach(async () => {
  closeDatabase(); initDatabase(':memory:'); getDb().run('PRAGMA foreign_keys = OFF');
  getDb().run(await Bun.file(new URL('../db/baseline.sql', import.meta.url)).text());
  for (const [id, user] of [['a', 'alice'], ['b', 'alice'], ['secret', 'bob']])
    getDb().query('INSERT INTO connection_profiles (id,user_id,name,provider) VALUES (?,?,?,?)').run(id, user, id, 'openai');
});
afterEach(() => closeDatabase());

test('backend runtime and host preserve scope, initial delivery and unsubscribe-before-ack', async () => {
  const responses = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const runtime = createOrganizationRuntime({ request(message) {
    return new Promise((resolve, reject) => { responses.set(message.requestId, { resolve, reject }); host.handle(message); });
  }, send(message) { host.handle(message); } });
  const host = new ConnectionOrganizationHost({ resolveUser: () => 'alice', post(message) {
    if (message.type === 'connection_organization_snapshot') runtime.receive(message);
    else {
      const response = responses.get(message.requestId)!; responses.delete(message.requestId);
      if (message.error) response.reject(new Error(message.error)); else response.resolve(message.result);
    }
  } });
  const snapshot = await runtime.api.get({ kind: 'llm', userId: 'bob' });
  expect(snapshot.connections.map(p => p.id)).toEqual(['a', 'b']);
  let calls = 0;
  runtime.api.watch({ kind: 'llm' }, () => { calls++; })();
  await Bun.sleep(25); expect(calls).toBe(0);
  runtime.api.watch({ kind: 'llm' }, () => { calls++; });
  await Bun.sleep(25); expect(calls).toBe(1);
  host.dispose(); putSetting('alice', 'activeProfileId', 'a'); await Bun.sleep(25);
  expect(calls).toBe(1); runtime.dispose();
});

