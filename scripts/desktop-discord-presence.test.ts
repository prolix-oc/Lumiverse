import { describe, expect, test } from "bun:test";
import { createDiscordPresenceRefreshQueue } from "../desktop/src/discord-presence";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("desktop Discord presence refresh queue", () => {
  test("fetches the latest chat after a switch during an in-flight poll", async () => {
    const first = deferred<void>();
    const oldChat = { chatId: "old", model: "model-a", totalTokens: 10, messageCount: 2 };
    const newChat = { chatId: "new", model: "model-b", totalTokens: 80, messageCount: 9 };
    let current = oldChat;
    const sent: typeof oldChat[] = [];
    let polls = 0;
    const refresh = createDiscordPresenceRefreshQueue(async () => {
      const snapshot = current;
      if (++polls === 1) await first.promise;
      sent.push(snapshot);
      return "ok";
    });

    const polling = refresh();
    current = newChat;
    const switched = refresh();
    const switchedAgain = refresh();
    expect(polls).toBe(1);
    first.resolve();
    await Promise.all([polling, switched, switchedAgain]);

    expect(polls).toBe(2);
    expect(sent.at(-1)).toEqual(newChat);
    await refresh();
    expect(polls).toBe(3);
  });

  test("a switch to the landing page replaces chat activity after the pending poll", async () => {
    const first = deferred<void>();
    let current: { chatId: string | null; characterCount?: number } = { chatId: "chat" };
    const sent: typeof current[] = [];
    const refresh = createDiscordPresenceRefreshQueue(async () => {
      const snapshot = current;
      if (sent.length === 0 && snapshot.chatId) await first.promise;
      sent.push(snapshot);
      return "ok";
    });
    const pending = refresh();
    current = { chatId: null, characterCount: 3 };
    const cleared = refresh();
    first.resolve();
    await Promise.all([pending, cleared]);
    expect(sent).toEqual([{ chatId: "chat" }, { chatId: null, characterCount: 3 }]);
  });

  test("returns the latest authentication outcome to callers sharing a poll", async () => {
    const first = deferred<void>();
    let polls = 0;
    const refresh = createDiscordPresenceRefreshQueue(async () => {
      if (++polls === 1) {
        await first.promise;
        return "ok";
      }
      return "needs-auth";
    });
    const pending = refresh();
    const next = refresh();
    first.resolve();
    expect(await pending).toBe("needs-auth");
    expect(await next).toBe("needs-auth");
  });

  test("a failed refresh does not prevent subsequent chat switches from polling", async () => {
    let polls = 0;
    const refresh = createDiscordPresenceRefreshQueue(async () => {
      if (++polls === 1) throw new Error("IPC unavailable");
      return "ok";
    });
    await expect(refresh()).rejects.toThrow("IPC unavailable");
    expect(await refresh()).toBe("ok");
    expect(polls).toBe(2);
  });
});
