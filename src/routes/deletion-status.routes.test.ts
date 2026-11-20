import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import { closeDatabase, getDb, initDatabase } from '../db/connection';
import { imagesRoutes } from './images.routes';
import { eventBus } from '../ws/bus';
import { EventType } from '../ws/events';

const app = new Hono();
app.use('*', async (c, next) => { c.set('userId', 'owner'); await next(); });
app.route('/images', imagesRoutes);
let id: string;
beforeEach(async () => {
  closeDatabase();
  const db = initDatabase(':memory:');
  db.exec(await Bun.file(new URL('../db/baseline.sql', import.meta.url)).text());
  db.exec(`INSERT INTO "user" (id, name, email) VALUES ('owner', 'Owner', 'owner@test'), ('other', 'Other', 'other@test')`);
  id = crypto.randomUUID();
  db.query("INSERT INTO images (id, user_id, filename, original_filename) VALUES (?, 'owner', 'missing.png', 'missing.png')").run(id);
});
afterEach(() => closeDatabase());

test('image deletion confirms a committed row and exposes uncached owner-scoped state', async () => {
  const emit = spyOn(eventBus, 'emit');
  try {
    const response = await app.request(`/images/${id}`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, deleted: true, id, status: 'completed' });
    expect(getDb().query('SELECT id FROM images WHERE id = ?').get(id)).toBeNull();
    expect(emit.mock.calls.filter(([type]) => type === EventType.IMAGE_DELETED).map(([, payload]) => payload.id)).toEqual([id]);
    const status = await app.request(`/images/${id}/deletion-status`);
    expect(status.headers.get('Cache-Control')).toBe('no-store');
    expect(await status.json()).toEqual({ id, deleted: true, status: 'completed' });
  } finally { emit.mockRestore(); }
});

test('retained images and failed transactions never publish completion', async () => {
  const db = getDb();
  db.query("INSERT INTO characters (id, user_id, name, image_id) VALUES ('character', 'owner', 'Character', ?)").run(id);
  const emit = spyOn(eventBus, 'emit');
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const retained = await app.request(`/images/${id}?unused=true`, { method: 'DELETE' });
    expect(await retained.json()).toEqual({ success: true, deleted: false, id, status: 'retained' });
    db.exec("CREATE TRIGGER reject_image_delete BEFORE DELETE ON images BEGIN SELECT RAISE(ABORT, 'delete failed'); END");
    expect((await app.request(`/images/${id}`, { method: 'DELETE' })).status).toBe(500);
    expect(await (await app.request(`/images/${id}/deletion-status`)).json()).toEqual({ id, deleted: false, status: 'present' });
    expect(emit.mock.calls.filter(([type]) => type === EventType.IMAGE_DELETED)).toHaveLength(0);
    db.query("INSERT INTO images (id, user_id, filename, original_filename) VALUES ('other-image', 'other', 'missing.png', 'missing.png')").run();
    expect(await (await app.request('/images/other-image/deletion-status')).json()).toMatchObject({ deleted: true });
    expect(db.query("SELECT id FROM images WHERE id = 'other-image'").get()).not.toBeNull();
  } finally { emit.mockRestore(); log.mockRestore(); }
});
