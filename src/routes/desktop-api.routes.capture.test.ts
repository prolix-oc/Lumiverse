import { afterEach, describe, expect, test } from "bun:test";
import sharp from "sharp";
import { DesktopCaptureBroker } from "../spindle/desktop-capture-broker";
import { createDesktopApiRoutes } from "./desktop-api.routes";

const brokers: DesktopCaptureBroker[] = [];
afterEach(() => { for (const broker of brokers.splice(0)) broker.dispose(); });

function fixture(clientId = "lumiverse-desktop") {
  const broker = new DesktopCaptureBroker();
  brokers.push(broker);
  const app = createDesktopApiRoutes({
    captureBroker: broker,
    verify: async (request) => {
      const authorization = request.headers.get("authorization");
      if (!authorization?.startsWith("Bearer ")) throw new Error("No native token");
      return { sub: authorization.slice(7), azp: clientId };
    },
    loadPrincipal: (userId) => ({ id: userId, name: userId, email: `${userId}@example.test`, username: userId, role: "user" }),
    getStatus: async () => ({}), getInstance: () => ({ id: "instance", name: "Instance" }),
  });
  async function register(userId = "alice") {
    const response = await app.request("/capture/devices", {
      method: "POST", headers: { authorization: `Bearer ${userId}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Native Desktop", platform: "linux", capabilities: { image: true, video: false, replay: false } }),
    });
    expect(response.status).toBe(200);
    return await response.json() as { device: { id: string }; transportToken: string };
  }
  return { broker, app, register };
}

describe("native-only desktop capture transport", () => {
  test("display metadata updates require the matching native account and lease", async () => {
    const setup = fixture();
    const native = await setup.register();
    const displays = ["a", "b", "c"].map((id, index) => ({ id: id.repeat(64), name: `Display ${index + 1}`, width: 1920, height: 1080, primary: index === 0 }));
    const endpoint = `/capture/devices/${native.device.id}/displays`;
    const body = JSON.stringify(displays);
    for (const headers of [{ authorization: "Bearer bob", "X-Lumiverse-Capture-Lease": native.transportToken }, { authorization: "Bearer alice", "X-Lumiverse-Capture-Lease": "forged" }]) {
      expect((await setup.app.request(endpoint, { method: "POST", headers, body })).status).toBe(401);
    }
    expect((await setup.app.request(endpoint, { method: "POST", headers: { authorization: "Bearer alice", "X-Lumiverse-Capture-Lease": native.transportToken }, body })).status).toBe(200);
    expect(setup.broker.listDevices("alice")[0].displays).toEqual(displays);
  });
  test("approval replies require the native account and matching lease and return only metadata", async () => {
    const setup = fixture();
    const native = setup.broker.register("alice", { name: "Desktop", platform: "macos", approvalStatus: true, capabilities: { image: true, video: false, replay: false } });
    const owner = { runtimeId: "runtime", extensionId: "extension", identifier: "test", name: "Test", userId: "alice" };
    const status = setup.broker.inspect(owner, { deviceId: native.device.id, kind: "image", connectionId: "connection" },
      { connectionId: "connection", revision: "revision", provider: "google", model: "vision", endpointOrigin: "provider-default" }, () => true);
    const command = setup.broker.poll("alice", native.device.id, native.transportToken)[0];
    const body = JSON.stringify({ requestId: command.requestId, approval: "paused", source: "unknown" });
    const endpoint = `/capture/devices/${native.device.id}/approval-status`;
    const wrongAccount = await setup.app.request(endpoint, { method: "POST", headers: { authorization: "Bearer bob", "X-Lumiverse-Capture-Lease": native.transportToken }, body });
    expect(wrongAccount.status).toBe(401);
    const response = await setup.app.request(endpoint, { method: "POST", headers: { authorization: "Bearer alice", "X-Lumiverse-Capture-Lease": native.transportToken }, body });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await status).toMatchObject({ approval: "paused", source: "unknown" });
  });
  test("does not accept an ordinary browser cookie or another OAuth client's token", async () => {
    const body = JSON.stringify({ name: "Native Desktop", platform: "linux", capabilities: { image: true, video: false, replay: false } });
    const browser = await fixture().app.request("/capture/devices", { method: "POST", headers: { cookie: "session=browser" }, body });
    expect(browser.status).toBe(401);
    const otherClient = await fixture("other-client").app.request("/capture/devices", { method: "POST", headers: { authorization: "Bearer alice" }, body });
    expect(otherClient.status).toBe(401);
  });

  test("requires both desktop authorization and a matching private device lease", async () => {
    const setup = fixture();
    const client = await setup.register();
    for (const headers of [
      { authorization: "Bearer alice" },
      { authorization: "Bearer alice", "X-Lumiverse-Capture-Lease": "forged" },
      { authorization: "Bearer bob", "X-Lumiverse-Capture-Lease": client.transportToken },
    ] as Array<Record<string, string>>) {
      const response = await setup.app.request(`/capture/devices/${client.device.id}/commands`, { headers });
      expect(response.status).toBe(401);
    }
  });

  test("delivers worker requests to the selected native device and accepts reviewed pixels privately", async () => {
    const setup = fixture();
    const client = await setup.register();
    const promise = setup.broker.request({ runtimeId: "runtime", extensionId: "extension", identifier: "example", name: "Example", userId: "alice" }, {
      deviceId: client.device.id, connectionId: "connection", purpose: "Describe selected content", kind: "image",
    }, { connectionId: "connection", revision: "revision", provider: "google", model: "vision", endpointOrigin: "https://model.example" }, () => true);
    void promise.catch(() => {});
    const headers = { authorization: "Bearer alice", "X-Lumiverse-Capture-Lease": client.transportToken };
    const poll = await setup.app.request(`/capture/devices/${client.device.id}/commands`, { headers });
    expect(poll.headers.get("cache-control")).toBe("no-store");
    const { commands } = await poll.json() as { commands: { requestId: string; extension: { id: string } }[] };
    expect(commands[0].extension.id).toBe("extension");
    const data = await sharp({ create: { width: 1, height: 1, channels: 4, background: "white" } }).png().toBuffer();
    const response = await setup.app.request(`/capture/devices/${client.device.id}/responses`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({
        requestId: commands[0].requestId, outcome: "approved", media: { mimeType: "image/png", data: data.toString("base64"), width: 1, height: 1 },
      }),
    });
    expect(response.status).toBe(200);
    expect(await promise).not.toHaveProperty("data");
    const replay = await setup.app.request(`/capture/devices/${client.device.id}/responses`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ requestId: commands[0].requestId, outcome: "denied" }),
    });
    expect(replay.status).toBe(404);
    const disconnect = await setup.app.request(`/capture/devices/${client.device.id}`, { method: "DELETE", headers });
    expect(disconnect.status).toBe(200);
    expect(setup.broker.listDevices("alice")).toEqual([]);
  });

  test("rejects oversized registration and invalid capabilities before allocating devices", async () => {
    const setup = fixture();
    const oversized = await setup.app.request("/capture/devices", { method: "POST", headers: { authorization: "Bearer alice" }, body: "a".repeat(1025) });
    expect(oversized.status).toBe(413);
    const forgedLength = await setup.app.request("/capture/devices", { method: "POST", headers: { authorization: "Bearer alice", "content-length": "1" }, body: "a".repeat(1025) });
    expect(forgedLength.status).toBe(413);
    const invalid = await setup.app.request("/capture/devices", { method: "POST", headers: { authorization: "Bearer alice" }, body: JSON.stringify({
      name: "Native", platform: "linux", capabilities: { image: true, video: false, replay: true },
    }) });
    expect(invalid.status).toBe(400);
    expect(setup.broker.listDevices("alice")).toEqual([]);
  });
});
