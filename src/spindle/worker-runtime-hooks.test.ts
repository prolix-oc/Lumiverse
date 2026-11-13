import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('worker hooks preserve thrown values and propagate cancellation across the process boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spindle-hook-test-'));
  const entry = join(directory, 'backend.mjs');
  await Bun.write(entry, `
    async function handle(context, signal) {
      if (context.wait) {
        spindle.sendToFrontend({ waiting: context.id });
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        throw signal.reason;
      }
      throw context.failure;
    }
    spindle.registerMacroInterceptor(async (ctx) => ({ text: ctx.template, touchedVars: [ctx.sourceOwner.extensionIdentifier] }), 42, { handlesOwnedSources: true });
    spindle.registerContextHandler(handle, 100, { required: true });
    spindle.registerInterceptor((_messages, context) => handle(context, context.signal), { required: true });
    spindle.onFrontendMessage((payload, userId, frontendSessionId) => {
      spindle.sendToFrontend(payload, userId, { frontendSessionId });
    });
  `);
  const received: any[] = [];
  const listeners = new Set<() => void>();
  const worker = Bun.spawn([process.execPath, join(import.meta.dir, 'worker-runtime.ts')], {
    stdout: 'ignore', stderr: 'pipe',
    ipc(message: any, child) {
      if (message.type === 'permissions_get_granted') {
        child.send({ type: 'response', requestId: message.requestId, result: ['context_handler', 'interceptor'] });
      }
      received.push(message);
      for (const listener of listeners) listener();
    },
  });
  function waitFor(predicate: (message: any) => boolean): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error('Worker did not deliver the expected hook response'));
      }, 2_000);
      const check = () => {
        const message = received.find(predicate);
        if (!message) return;
        clearTimeout(timer);
        listeners.delete(check);
        resolve(message);
      };
      listeners.add(check);
      check();
    });
  }
  try {
    worker.send({ type: 'init', manifest: { identifier: 'hook-test', entry_backend: pathToFileURL(entry).href }, storagePath: directory });
    await waitFor(message => message.message === '__worker_ready__');
    expect(received.find(message => message.type === 'register_macro_interceptor')).toMatchObject({ priority: 42, handlesOwnedSources: true });
    worker.send({ type: 'macro_interceptor_request', requestId: 'owned-macro', ctx: { template: '{{setvar::x::1}}', sourceOwner: { extensionIdentifier: 'hook-test' } } });
    expect((await waitFor(message => message.type === 'macro_interceptor_result' && message.requestId === 'owned-macro')).result)
      .toEqual({ text: '{{setvar::x::1}}', touchedVars: ['hook-test'] });
    const registration = received.find(message => message.type === 'register_interceptor');
    expect(registration.required).toBe(true);
    expect(received.find(message => message.type === 'register_context_handler').required).toBe(true);
    worker.send({ type: 'frontend_message', userId: 'owner', frontendSessionId: '0123456789abcdef0123456789abcdef', payload: { echo: true } });
    expect(await waitFor(message => message.type === 'frontend_message' && message.payload.echo)).toMatchObject({
      userId: 'owner', frontendSessionId: '0123456789abcdef0123456789abcdef', payload: { echo: true },
    });
    for (const kind of ['context_handler', 'intercept']) {
      for (const failure of [null, undefined, '', 'failure', false, 0]) {
        const requestId = crypto.randomUUID();
        worker.send({ type: `${kind}_request`, requestId, registrationId: registration.registrationId, messages: [], context: { failure } });
        const response = await waitFor(message => message.type === `${kind}_result` && message.requestId === requestId);
        expect(response.error).toBe(String(failure));
      }
      const requestId = crypto.randomUUID();
      worker.send({ type: `${kind}_request`, requestId, registrationId: registration.registrationId, messages: [], context: { wait: true, id: requestId } });
      await waitFor(message => message.type === 'frontend_message' && message.payload.waiting === requestId);
      worker.send({ type: `${kind}_abort`, requestId, registrationId: registration.registrationId, reason: 'Cancelled by test' });
      const response = await waitFor(message => message.type === `${kind}_result` && message.requestId === requestId);
      expect(response.error).toBe('Cancelled by test');
    }
  } finally {
    worker.kill();
    await worker.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
