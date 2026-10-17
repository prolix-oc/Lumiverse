import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as connections from "./decision-connections.service";
import * as secrets from "./secrets.service";
import * as images from "./images.service";
import { evaluateDecision } from "./decisions.service";
import { WorkerHostDecisionsApi } from "../spindle/worker-host-decisions-api";
import type { DecisionConnectionProfileDTO } from "../decision/contract";

const originalFetch = globalThis.fetch;
const spies: { mockRestore(): void }[] = [];
afterEach(() => { globalThis.fetch = originalFetch; for (const spy of spies.splice(0)) spy.mockRestore(); });
const profile = { id: "decision", name: "Decision", provider: "typesafe", api_url: "", model: "jev-preview", default_parameters: {} } as unknown as DecisionConnectionProfileDTO;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const input = { state: { page: "ref-page" }, assets: { "ref-page": { image_id: "stored" } }, questions: { face: { type: "box" as const, instructions: "the face in `page`" } } };

function setup() {
  const file = join(mkdtempSync(join(tmpdir(), "decision-images-")), "page.png");
  writeFileSync(file, png);
  spies.push(
    spyOn(connections, "getDefaultConnection").mockImplementation(() => profile as any),
    spyOn(secrets, "getSecret").mockImplementation(async () => "key"),
    spyOn(images, "getImageFilePath").mockImplementation(async (user, id) => user === "alice" && id === "stored" ? file : null),
  );
  const sent: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    sent.push({ headers: init.headers, body: JSON.parse(init.body) });
    return Response.json({ model: "jev-1.14.0", answers: { face: { type: "box", box: { top: 0, bottom: 1, left: 0, right: 1 }, confidence: 0.5 } } });
  }) as unknown as typeof fetch;
  return sent;
}

test("image_id assets resolve to the account's stored bytes", async () => {
  const sent = setup();
  await evaluateDecision("alice", input);
  expect(sent[0].body.assets).toEqual({ "ref-page": { type: "image", format: "png", data_base64: png.toString("base64") } });
  expect(sent[0].headers["TypeSafe-Danger-Zone-Images"]).toBe("true");
  await expect(evaluateDecision("bob", input)).rejects.toThrow("not found");
  expect(sent).toHaveLength(1);
});

test("worker image_id assets need the images permission", async () => {
  const sent = setup();
  const responses: any[] = [];
  let granted = ["decisions"];
  const api = new WorkerHostDecisionsApi({ hasPermission: (permission) => granted.includes(permission), resolveEffectiveUserId: () => "alice", enforceScopedUser: () => {}, postResponse: (response) => { responses.push(response); } });
  // The SDK wire type gains Box questions and assets with the package bump.
  await api.handle({ type: "decisions_evaluate", requestId: "denied", input: input as any });
  expect(responses.pop().error).toContain("images permission");
  expect(sent).toHaveLength(0);
  granted = ["decisions", "images"];
  await api.handle({ type: "decisions_evaluate", requestId: "granted", input: input as any });
  expect(responses.pop().result.answers.face.confidence).toBe(0.5);
});
