import { getActiveFrontendSession } from "./frontend-session";
import { expect, test } from 'bun:test';
import { readFrontendSessionId, registerFrontendSession, sendToFrontendSession, frontendPresenceKey } from './frontend-session';
import { eventBus } from '../ws/bus';

test('missing browser routing remains explicit for server initiated generation', () => {
  expect(readFrontendSessionId(undefined)).toBeUndefined();
});

test('session delivery is isolated by both authenticated user and document', () => {
  const id = '0123456789abcdef0123456789abcdef';
  const otherId = '1123456789abcdef0123456789abcdef';
  const received: string[] = [];
  let closed = 0;
  const remove = registerFrontendSession('owner', id, { send: value => received.push(value), close() {}, closed: () => { closed++; } });
  try {
    expect(sendToFrontendSession('other', id, {})).toBe(false);
    expect(sendToFrontendSession('owner', otherId, {})).toBe(false);
    expect(sendToFrontendSession('owner', id, { value: 1 })).toBe(true);
    expect(received).toEqual(['{"value":1}']);
    remove();
    remove();
    expect(closed).toBe(1);
    expect(sendToFrontendSession('owner', id, {})).toBe(false);
    const replacement = registerFrontendSession('owner', id, { send: value => received.push(value), close() {}, closed() {} });
    remove();
    expect(sendToFrontendSession('owner', id, { value: 2 })).toBe(true);
    replacement();
  } finally { remove(); }
});

test('a reconnect replaces a half-open transport without closing the document session', () => {
  const id = '3123456789abcdef0123456789abcdef';
  const received: string[] = [];
  let closed = 0, replaced = 0;
  let removeOld!: () => void;
  removeOld = registerFrontendSession('owner', id, {
    send: () => received.push('old'), closed: () => { closed++; },
    close: () => { replaced++; removeOld(); },
  });
  let removeNew: (() => void) | undefined;
  try {
    removeNew = registerFrontendSession('owner', id, {
      send: () => received.push('new'), closed: () => { closed++; }, close() {},
    });
    expect(replaced).toBe(1);
    expect(closed).toBe(0);
    expect(sendToFrontendSession('owner', id, {})).toBe(true);
    expect(received).toEqual(['new']);
    removeOld();
    expect(sendToFrontendSession('owner', id, {})).toBe(true);
    removeNew();
    expect(closed).toBe(1);
    expect(sendToFrontendSession('owner', id, {})).toBe(false);
  } finally { removeNew?.(); removeOld(); }
});

test('closed session transport never falls back to another document', () => {
  const id = '2123456789abcdef0123456789abcdef';
  const remove = registerFrontendSession('owner', id, { send() { throw new Error('Disconnected'); }, close() {}, closed() {} });
  try { expect(sendToFrontendSession('owner', id, {})).toBe(false); }
  finally { remove(); }
});

test('frontend routing identifiers accept only one complete document identifier', () => {
  const value = '0123456789abcdef0123456789abcdef';
  expect(readFrontendSessionId(value)).toBe(value);
  for (const invalid of ['', value + '0', value.slice(1), 'other-user', ' ' + value, value.toUpperCase()]) {
    expect(() => readFrontendSessionId(invalid)).toThrow('Invalid frontend session identifier');
  }
});

test('two documents sharing authentication retain both state event subscriptions', () => {
  const first = { readyState: 1, subscribe() {}, unsubscribe() {} } as any;
  const second = { readyState: 1, subscribe() {}, unsubscribe() {} } as any;
  const before = eventBus.clientCount;
  const firstKey = frontendPresenceKey('same-login', '0123456789abcdef0123456789abcdef');
  const secondKey = frontendPresenceKey('same-login', '1123456789abcdef0123456789abcdef');
  try {
    eventBus.addClient(first, 'owner', firstKey);
    eventBus.addClient(second, 'owner', secondKey);
    expect(eventBus.clientCount).toBe(before + 2);
    eventBus.setUserVisibility('owner', firstKey, true);
    eventBus.setUserVisibility('owner', secondKey, false);
    expect(eventBus.isUserVisible('owner')).toBe(true);
  } finally { eventBus.removeClient(first); eventBus.removeClient(second); }
});

test("execution owner selection excludes widgets, isolates accounts, and does not reroute pinned work", () => {
  const sent: string[] = [];
  const a = "a".repeat(32), b = "b".repeat(32), widget = "c".repeat(32);
  const register = (id: string, executionOwner = true) => registerFrontendSession("election", id, {
    executionOwner, send: () => { sent.push(id); }, close() {}, closed() {},
  });
  const removeA = register(a);
  const pinned = getActiveFrontendSession("election")!;
  const removeB = register(b);
  const removeWidget = register(widget, false);
  try {
    expect(getActiveFrontendSession("election")).toBe(b);
    expect(getActiveFrontendSession("different-user")).toBeUndefined();
    expect(sendToFrontendSession("election", pinned, {})).toBe(true);
    expect(sent).toEqual([a]);
    removeA();
    expect(sendToFrontendSession("election", pinned, {})).toBe(false);
    expect(sent).toEqual([a]);
    removeB();
    expect(getActiveFrontendSession("election")).toBeUndefined();
  } finally { removeA(); removeB(); removeWidget(); }
});
