import { expect, test } from "bun:test";
import { restoreDesktopCaptureConnection, type DesktopCaptureStatus } from "../src/desktop-capture";

const status: DesktopCaptureStatus = {
  enabled: false, origin: null, error: null,
  capabilities: { image: true, video: true, replay: false },
};

test("restores only the opted-in transport without replaying requests", async () => {
  const connections: string[] = [];
  await restoreDesktopCaptureConnection("https://instance", () => true, {
    status: async () => status,
    connect: async origin => { connections.push(origin); },
    disconnect: async () => { throw new Error("unexpected disconnect"); },
  });
  expect(connections).toEqual(["https://instance"]);
});

test("a selection change while reading status cannot reconnect the previous instance", async () => {
  let selected = true;
  await restoreDesktopCaptureConnection("https://previous", () => selected, {
    status: async () => { selected = false; return status; },
    connect: async () => { throw new Error("stale connection"); },
    disconnect: async () => { throw new Error("unexpected disconnect"); },
  });
});

test("Disable during native connection verification cancels only that origin", async () => {
  let wanted = true;
  const disconnected: string[] = [];
  await restoreDesktopCaptureConnection("https://previous", () => wanted, {
    status: async () => status,
    connect: async () => { wanted = false; },
    disconnect: async origin => { disconnected.push(origin); },
  });
  expect(disconnected).toEqual(["https://previous"]);
});

test("active transports and unsupported adapters are left alone", async () => {
  for (const snapshot of [
    { ...status, enabled: true, origin: "https://instance" },
    { ...status, disabledByUser: true },
    { ...status, capabilities: { ...status.capabilities, image: false } },
  ]) {
    await restoreDesktopCaptureConnection("https://instance", () => true, {
      status: async () => snapshot,
      connect: async () => { throw new Error("unexpected connection"); },
      disconnect: async () => { throw new Error("unexpected disconnect"); },
    });
  }
});
