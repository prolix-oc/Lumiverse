import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type Socket } from 'node:net';
import { Hono } from 'hono';
import { env } from '../../env';
import { persistUploadedArchive } from './import.service';
import { userDataRoutes } from '../../routes/user-data.routes';
import { isLargeUploadBodyLimitExemptPath } from '../../middleware/body-limit-exempt';
import { MAX_ACCOUNT_ARCHIVE_BYTES } from './archive-limits';

const originalDataDir = env.dataDir;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'lumiverse-archive-upload-'));
  (env as { dataDir: string }).dataDir = directory;
});
afterEach(() => {
  (env as { dataDir: string }).dataDir = originalDataDir;
  rmSync(directory, { recursive: true, force: true });
});

test.each([null, 6 * 1024 ** 3])('streams an archive with declared size %s without the old 5 GB quota', async (declaredSize) => {
  const chunks = [new Uint8Array([0x50]), new Uint8Array([0x4b, 0x03]), new Uint8Array([0x04, 1, 2, 3])];
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    const chunk = chunks.shift();
    if (chunk) controller.enqueue(chunk); else controller.close();
  } });
  const result = await persistUploadedArchive('owner', body, declaredSize);
  expect(readFileSync(result.path)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
});

test('large declared .lvbak uploads reach ZIP validation instead of returning 413', async () => {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('userId', 'owner'); await next(); });
  app.route('/api/v1/user-data', userDataRoutes);
  expect(isLargeUploadBodyLimitExemptPath('/api/v1/user-data/import', 'POST')).toBe(true);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await app.request('/api/v1/user-data/import', {
      method: 'POST', headers: { 'Content-Length': String(6 * 1024 ** 3), 'Content-Type': 'application/octet-stream' },
      body: 'This is not a ZIP file',
    });
    expect(response.status).toBe(415);
    expect((await response.json()).code).toBe('not_zip');
  }
});

test('Bun accepts a backup stream declaring more than 5 GB before reading the body', async () => {
  let received = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, maxRequestBodySize: MAX_ACCOUNT_ARCHIVE_BYTES,
    async fetch(request) {
      const first = await request.body!.getReader().read();
      received = first.value?.byteLength ?? 0;
      return new Response('accepted', { headers: { Connection: 'close' } });
    },
  });
  let socket: Socket | undefined;
  try {
    const status = await new Promise<string>((resolve, reject) => {
      socket = connect(server.port!, '127.0.0.1', () => {
        // Exercise Bun's upfront Content-Length check without allocating or
        // transferring a multi-gigabyte fixture. The server consumes one chunk.
        socket!.write(`POST /api/v1/user-data/import HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${6 * 1024 ** 3}\r\nConnection: close\r\n\r\nPK\x03\x04`);
      });
      socket.setTimeout(3000, () => reject(new Error('archive request timed out')));
      socket.once('error', reject);
      socket.once('data', data => resolve(data.toString().split('\r\n')[0]!));
    });
    expect(status).toBe('HTTP/1.1 200 OK');
    expect(received).toBe(4);
  } finally {
    socket?.destroy();
    server.stop(true);
  }
});
