import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorldInfoInterceptorChain } from './world-info-interceptor';

for (const mode of ['worker', 'process'] as const) test(`local candidates and same-callback votes survive ${mode} transport`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spindle-local-lore-'));
  const entry = join(directory, 'backend.mjs');
  await Bun.write(entry, `spindle.registerWorldInfoInterceptor(ctx => ({
    additionalEntries: [{ id:'local', world_book_id:'ignored', comment:'Local', content:'raw', key:[], keysecondary:[],
      disabled:false, constant:true, extensions:{}, position:0, depth:0, role:'assistant', priority:100,
      probability:100, use_probability:false, automation_id:null, selective:false, selective_logic:0,
      group_name:'',group_override:false,group_weight:1,match_whole_words:false,case_sensitive:false,use_regex:false,
      prevent_recursion:false,exclude_recursion:false,delay_until_recursion:false,exclude_greeting:true,
      scan_depth:null,order_value:100,sticky:0,cooldown:0,delay:0 }],
    mutated:[{id:'local',content:'resolved',outputOrder:'insertion'}], captured:['local']
  }),100);`);
  const registered = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<any>();
  let send!: (message: unknown) => void;
  const receive = (message: any) => {
    if (message.type === 'permissions_get_granted') send({ type: 'response', requestId: message.requestId, result: ['generation'] });
    else if (message.type === 'register_world_info_interceptor') registered.resolve();
    else if (message.type === 'world_info_interceptor_result') reply.resolve(message.result);
    else if (message.type === 'log' && message.level === 'error') { registered.reject(new Error(message.message)); reply.reject(new Error(message.message)); }
  };
  const runtime = join(import.meta.dir, 'worker-runtime.ts');
  let worker: Worker | undefined, child: ReturnType<typeof Bun.spawn> | undefined;
  if (mode === 'worker') { worker = new Worker(runtime); worker.onmessage = event => receive(event.data); send = message => worker!.postMessage(message); }
  else { child = Bun.spawn([process.execPath, runtime], { stdout: 'ignore', stderr: 'pipe', ipc: receive }); send = message => child!.send(message); }
  const timer = setTimeout(() => { registered.reject(new Error('Registration timed out')); reply.reject(new Error('World info timed out')); }, 5000);
  void reply.promise.catch(() => {});
  try {
    send({ type: 'init', manifest: { identifier: 'local_lore', entry_backend: pathToFileURL(entry).href, permissions: ['generation'] }, storagePath: directory });
    await registered.promise;
    const chain = new WorldInfoInterceptorChain();
    chain.register({ extensionId: 'installation', priority: 100, handler: async ctx => {
      send({ type: 'world_info_interceptor_request', requestId: 'query', ctx }); return reply.promise;
    } });
    const result = await chain.run([], { chatId: 'chat', characterId: 'character', chatMetadata: {}, messages: [], chatTurn: 0,
      activationSettings: { globalScanDepth: null, maxRecursionPasses: 3 } });
    const id = JSON.stringify(['spindle', 'installation', 'chat', 'local']);
    expect(result.entries).toMatchObject([{ id, content: 'resolved', role: 'assistant' }]);
    expect([...result.captureRequests.get('installation')!]).toEqual([id]);
    expect(result.insertionOrderByEntryId.get(id)).toBe('installation');
  } finally {
    clearTimeout(timer); worker?.terminate();
    if (child) { child.kill(); await child.exited; }
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
