import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

for (const mode of ['worker', 'process'] as const) test(`resolved lore query survives ${mode} transport`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spindle-lore-query-'));
  const entry = join(directory, 'backend.mjs');
  await Bun.write(entry, `const rows = await spindle.world_books.resolveForChat('chat', {userId:'owner',reserveTokens:4});
    spindle.sendToFrontend({rows},'owner');`);
  const done = Promise.withResolvers<any>();
  let send!: (message: unknown) => void;
  const rows = [{ content: 'Resolved', role: 'assistant' }];
  const receive = (message: any) => {
    if (message.type === 'permissions_get_granted') send({ type: 'response', requestId: message.requestId, result: ['world_books'] });
    else if (message.type === 'world_books_resolve_for_chat') {
      try {
        expect(message).toMatchObject({ chatId: 'chat', userId: 'owner', reserveTokens: 4 });
        send({ type: 'response', requestId: message.requestId, result: rows });
      } catch (error) { done.reject(error); }
    } else if (message.type === 'frontend_message') done.resolve(message.payload);
    else if (message.type === 'log' && message.level === 'error') done.reject(new Error(message.message));
  };
  const runtime = join(import.meta.dir, 'worker-runtime.ts');
  let worker: Worker | undefined, child: ReturnType<typeof Bun.spawn> | undefined;
  if (mode === 'worker') { worker = new Worker(runtime); worker.onmessage = event => receive(event.data); send = message => worker!.postMessage(message); }
  else { child = Bun.spawn([process.execPath, runtime], { stdout: 'ignore', stderr: 'pipe', ipc: receive }); send = message => child!.send(message); }
  const timer = setTimeout(() => done.reject(new Error('Lore query timed out')), 5000);
  try {
    send({ type: 'init', manifest: { identifier: 'lore_query', entry_backend: pathToFileURL(entry).href, permissions: ['world_books'] }, storagePath: directory });
    expect(await done.promise).toEqual({ rows });
  } finally {
    clearTimeout(timer); worker?.terminate();
    if (child) { child.kill(); await child.exited; }
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
