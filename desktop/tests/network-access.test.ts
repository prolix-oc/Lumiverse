import { expect, test } from "bun:test";
import { changeNetworkAccess } from "../src/network-access";

function fixture(running: boolean, failure?: "save" | "stop" | "start") {
  const calls: string[] = [];
  const options = {
    enabled: true, running,
    save: async (enabled: boolean) => {
      calls.push(`save:${enabled}`);
      if (failure === "save") throw new Error("Cannot save settings");
      return { configured: true, enabled, host: enabled ? "::" : "127.0.0.1", overridden: false };
    },
    stop: async () => { calls.push("stop"); if (failure === "stop") throw new Error("Cannot stop server"); },
    start: async () => { calls.push("start"); if (failure === "start") throw new Error("Cannot start server"); },
  };
  return { calls, options };
}

test("a running server restarts only after the listener setting is saved", async () => {
  const f = fixture(true);
  expect((await changeNetworkAccess(f.options)).enabled).toBe(true);
  expect(f.calls).toEqual(["save:true", "stop", "start"]);
});

test("disabling access while stopped never starts a server", async () => {
  const f = fixture(false);
  expect((await changeNetworkAccess({ ...f.options, enabled: false })).enabled).toBe(false);
  expect(f.calls).toEqual(["save:false"]);
});

test("a failed save leaves the running server alone", async () => {
  const f = fixture(true, "save");
  await expect(changeNetworkAccess(f.options)).rejects.toThrow("Cannot save settings");
  expect(f.calls).toEqual(["save:true"]);
});

test("a failed shutdown never starts a second server", async () => {
  const f = fixture(true, "stop");
  await expect(changeNetworkAccess(f.options)).rejects.toThrow("Cannot stop server");
  expect(f.calls).toEqual(["save:true", "stop"]);
});

test("a restart failure reaches the tray's error handler", async () => {
  const f = fixture(true, "start");
  await expect(changeNetworkAccess(f.options)).rejects.toThrow("Cannot start server");
  expect(f.calls).toEqual(["save:true", "stop", "start"]);
});
