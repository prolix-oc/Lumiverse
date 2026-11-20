import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as connections from "./decision-connections.service";
import * as secrets from "./secrets.service";
import * as images from "./images.service";
import { evaluateDecision } from "./decisions.service";
import { WorkerHostDecisionsApi } from "../spindle/worker-host-decisions-api";
import type { DecisionBox, DecisionConnectionProfileDTO, SpindleDecisionsAPI } from "../decision/contract";
import { DECISION_IMAGE_MAX_BYTES } from "../decision/validation";

const originalFetch = globalThis.fetch;
const spies: { mockRestore(): void }[] = [];
const directories: string[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const profile = { id: "decision", name: "Decision", provider: "typesafe", api_url: "", model: "jev-preview", default_parameters: {} } as unknown as DecisionConnectionProfileDTO;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const input = { state: { page: "ref-page" }, assets: { "ref-page": { image_id: "stored" } }, questions: { face: { type: "box" as const, instructions: "the face in `page`" } } };

function setup(size = png.length) {
  const directory = mkdtempSync(join(tmpdir(), "decision-images-"));
  directories.push(directory);
  const file = join(directory, "page.png");
  writeFileSync(file, png);
  truncateSync(file, size);
  const imageLookup = spyOn(images, "getImageFilePath").mockImplementation(async (user, id) => user === "alice" && id === "stored" ? file : null);
  spies.push(
    spyOn(connections, "getDefaultConnection").mockImplementation(() => profile as any),
    spyOn(secrets, "getSecret").mockImplementation(async () => "key"),
    imageLookup,
  );
  const sent: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    sent.push({ headers: init.headers, body: JSON.parse(init.body) });
    return Response.json({ model: "jev-1.14.0", answers: { face: { type: "box", box: { top: 0, bottom: 1, left: 0, right: 1 }, confidence: 0.5 } } });
  }) as unknown as typeof fetch;
  return { sent, imageLookup, file };
}

test("image_id assets resolve to the account's stored bytes", async () => {
  const { sent } = setup();
  await evaluateDecision("alice", input);
  expect(sent[0].body.assets).toEqual({ "ref-page": { type: "image", format: "png", data_base64: png.toString("base64") } });
  expect(sent[0].headers["TypeSafe-Danger-Zone-Images"]).toBe("true");
  await expect(evaluateDecision("bob", input)).rejects.toThrow("not found");
  expect(sent).toHaveLength(1);
});

test("worker image_id assets need the images permission", async () => {
  const { sent } = setup();
  const responses: any[] = [];
  let granted = ["decisions"];
  const api = new WorkerHostDecisionsApi({ hasPermission: (permission) => granted.includes(permission), resolveEffectiveUserId: () => "alice", enforceScopedUser: () => {}, postResponse: (response) => { responses.push(response); } });
  await api.handle({ type: "decisions_evaluate", requestId: "denied", input });
  expect(responses.pop().error).toContain("images permission");
  expect(sent).toHaveLength(0);
  granted = ["decisions", "images"];
  await api.handle({ type: "decisions_evaluate", requestId: "granted", input });
  expect(responses.pop().result.answers.face.confidence).toBe(0.5);
});

test("the SDK evaluate contract accepts stored and inline images and infers Box answers", async () => {
  const { sent } = setup();
  const evaluate: SpindleDecisionsAPI["evaluate"] = (value, options) => evaluateDecision("alice", value, options?.signal);
  const result = await evaluate({
    ...input,
    state: ["ref-page", "ref-inline"],
    assets: { ...input.assets, "ref-inline": { format: "png", data_base64: png.toString("base64") } },
  });
  const box: DecisionBox = result.answers.face.box;
  expect(box).toEqual({ top: 0, bottom: 1, left: 0, right: 1 });
  expect(sent[0].body.assets["ref-inline"].data_base64).toBe(png.toString("base64"));
});

test("rejects repeated stored images as soon as the shared budget is exceeded", async () => {
  const { sent, imageLookup } = setup(12 * 1024 * 1024);
  const refs = Array.from({ length: 16 }, (_, i) => `ref-${i}`);
  const assets = Object.fromEntries(refs.map((ref) => [ref, { image_id: "stored" }]));
  await expect(evaluateDecision("alice", { ...input, state: refs, assets })).rejects.toThrow("Decision images exceed 20 MiB");
  expect(imageLookup).toHaveBeenCalledTimes(2);
  expect(sent).toHaveLength(0);
});

test("reserves inline image bytes before reading stored images in any order", async () => {
  const { sent, imageLookup, file } = setup(12 * 1024 * 1024);
  const originalFile = Bun.file(file);
  const read = spyOn(originalFile, "slice");
  spies.push(read, spyOn(Bun, "file").mockReturnValue(originalFile));
  const assets = {
    "ref-page": { image_id: "stored" },
    "ref-inline": { format: "png" as const, data_base64: "A".repeat(12 * 1024 * 1024) },
  };
  await expect(evaluateDecision("alice", { ...input, state: Object.keys(assets), assets })).rejects.toThrow("Decision images exceed 20 MiB");
  expect(imageLookup).toHaveBeenCalledTimes(1);
  expect(read).not.toHaveBeenCalled();
  expect(sent).toHaveLength(0);
});

test("bounds file reads if the image grows after the size check", async () => {
  const { sent, file } = setup(DECISION_IMAGE_MAX_BYTES + 1024);
  const growingFile = Bun.file(file);
  const read = spyOn(growingFile, "slice");
  spies.push(read, spyOn(Bun, "file").mockReturnValue({
    size: png.length,
    slice: (start: number, end: number) => growingFile.slice(start, end),
  } as ReturnType<typeof Bun.file>));
  await expect(evaluateDecision("alice", input)).rejects.toThrow("Decision images exceed 20 MiB");
  expect(read).toHaveBeenCalledWith(0, DECISION_IMAGE_MAX_BYTES + 1);
  expect(sent).toHaveLength(0);
});

test("cancellation during lookup stops before reading or resolving more images", async () => {
  const { sent, imageLookup, file } = setup();
  const controller = new AbortController();
  imageLookup.mockImplementation(async () => { controller.abort(); return file; });
  const open = spyOn(Bun, "file");
  spies.push(open);
  const assets = { "ref-page": { image_id: "stored" }, "ref-next": { image_id: "stored" } };
  await expect(evaluateDecision("alice", { ...input, state: Object.keys(assets), assets }, controller.signal)).rejects.toThrow("cancelled");
  expect(imageLookup).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalled();
  expect(sent).toHaveLength(0);
});

test("a deadline during lookup stops further image work", async () => {
  const { sent, imageLookup, file } = setup();
  const controller = new AbortController();
  imageLookup.mockImplementation(async () => { controller.abort(); return file; });
  spies.push(spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal));
  const assets = { "ref-page": { image_id: "stored" }, "ref-next": { image_id: "stored" } };
  await expect(evaluateDecision("alice", { ...input, state: Object.keys(assets), assets })).rejects.toThrow("timed out after 30 seconds");
  expect(imageLookup).toHaveBeenCalledTimes(1);
  expect(sent).toHaveLength(0);
});

test("preserves prototype-named asset references during stored-image resolution", async () => {
  const { sent } = setup();
  const assets = Object.fromEntries([["__proto__", { image_id: "stored" }]]);
  await evaluateDecision("alice", { ...input, state: "__proto__", assets });
  expect(Object.keys(sent[0].body.assets)).toEqual(["__proto__"]);
  expect(sent[0].body.assets.__proto__.data_base64).toBe(png.toString("base64"));
});
