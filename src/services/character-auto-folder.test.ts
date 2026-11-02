import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import * as characters from "./characters.service";
import * as connections from "./decision-connections.service";
import * as secrets from "./secrets.service";
import * as images from "./images.service";
import * as directGeneration from "./generation/direct-generation";
import { autoAssignFolders } from "./character-auto-folder.service";
import { DecisionConnectionNotFoundError } from "./decisions.service";
import type { DecisionConnectionProfileDTO } from "../decision/contract";
import type { Character } from "../types/character";

const originalFetch = globalThis.fetch;
const spies: { mockRestore(): void }[] = [];
const directories: string[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const profile = {
  id: "decision", name: "Decision", provider: "openrouter", api_url: "", model: "liquid/d1-ultra", default_parameters: {},
} as unknown as DecisionConnectionProfileDTO;

function fakeCharacter(index: number, imageId: string | null, tags: string[] = ["fantasy"]): Character {
  return {
    id: `card-${index}`,
    name: `Card ${index}`,
    image_id: imageId,
    description: `A character number ${index}`,
    personality: "",
    tags,
    folder: "",
  } as unknown as Character;
}

/** Answer every Choice question with a valid probability distribution. */
function stubFetch(choiceFor: (questionId: string, keys: string[]) => string, sent: unknown[]) {
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries<any>(body.questions)) {
      const keys = Object.keys(question.criteria);
      const choice = choiceFor(id, keys);
      answers[id] = {
        type: "choice",
        choice,
        confidence: 1,
        probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
      };
    }
    return Response.json({ model: "liquid/d1-ultra", answers, usage: { input_tokens: 42, output_tokens: 3 } });
  }) as unknown as typeof fetch;
}

test("auto-assign batches cards, sends avatars as referenced assets, and maps answers back", async () => {
  const directory = mkdtempSync(join(tmpdir(), "auto-folder-"));
  directories.push(directory);
  const avatarPath = join(directory, "avatar.png");
  writeFileSync(avatarPath, await sharp({ create: { width: 64, height: 64, channels: 3, background: "#3366ff" } }).png().toBuffer());

  const cards = Array.from({ length: 10 }, (_, index) => fakeCharacter(index, index === 0 ? "image-1" : null));
  spies.push(
    spyOn(characters, "getCharactersByIds").mockImplementation(() => new Map(cards.map((card) => [card.id, card]))),
    spyOn(connections, "getDefaultConnection").mockImplementation(() => profile as any),
    spyOn(secrets, "getSecret").mockImplementation(async () => "key"),
    spyOn(images, "getImageFilePath").mockImplementation(async () => avatarPath),
  );

  // The first card is left uncategorized; every other card goes to a folder.
  const sent: any[] = [];
  stubFetch((questionId, keys) => (questionId === "card_0" ? "__no_folder__" : keys[0]), sent);

  const result = await autoAssignFolders("alice", {
    ids: cards.map((card) => card.id),
    folders: ["Heroes", "Villains"],
    propose_new_folders: false,
  });

  // 10 cards at 8 images per request (the liquid/d1 ceiling) = two requests.
  expect(sent).toHaveLength(2);
  expect(Object.keys(sent[0].questions)).toHaveLength(8);
  expect(Object.keys(sent[1].questions)).toHaveLength(2);
  expect(sent.every((body) => body.model === "liquid/d1-ultra")).toBe(true);

  // Only the first card has an avatar, and its reference is substituted from state.
  expect(Object.keys(sent[0].assets)).toEqual(["avatar-card-0"]);
  expect(sent[0].assets["avatar-card-0"].format).toBe("jpg");
  expect(sent[0].state.some((line: string) => line.includes("its avatar is the image \"avatar-card-0\"."))).toBe(true);
  expect(sent[1].assets).toBeUndefined();

  // Criteria are the folders, new-folder candidates from the cards' tags, and
  // an explicit "leave uncategorized" option.
  expect(Object.keys(sent[0].questions.card_0.criteria)).toEqual(["Heroes", "Villains", "fantasy", "__no_folder__"]);

  expect(result.model).toBe("liquid/d1-ultra");
  expect(result.usage).toEqual({ input_tokens: 42, output_tokens: 3 });
  expect(result.skipped).toEqual([]);
  expect(result.newFolders).toEqual([]);
  expect(result.imagesSkipped).toBe(false);
  expect(result.assignments).toHaveLength(10);
  expect(result.assignments[0]).toEqual({ id: "card-0", folder: "" });
  expect(new Set(result.assignments.slice(1).map((assignment) => assignment.folder))).toEqual(new Set(["Heroes"]));
});

test("auto-assign retries without images when the provider refuses image input", async () => {
  const directory = mkdtempSync(join(tmpdir(), "auto-folder-images-"));
  directories.push(directory);
  const avatarPath = join(directory, "avatar.png");
  writeFileSync(avatarPath, await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ff6633" } }).png().toBuffer());

  const cards = [fakeCharacter(0, "image-1"), fakeCharacter(1, "image-2")];
  spies.push(
    spyOn(characters, "getCharactersByIds").mockImplementation(() => new Map(cards.map((card) => [card.id, card]))),
    spyOn(connections, "getDefaultConnection").mockImplementation(() => profile as any),
    spyOn(secrets, "getSecret").mockImplementation(async () => "key"),
    spyOn(images, "getImageFilePath").mockImplementation(async () => avatarPath),
  );

  const sent: any[] = [];
  let calls = 0;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: "Image processing is unavailable" } }), { status: 503 });
    }
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries<any>(body.questions)) {
      const keys = Object.keys(question.criteria);
      answers[id] = {
        type: "choice",
        choice: keys[0],
        confidence: 1,
        probabilities: Object.fromEntries(keys.map((key) => [key, key === keys[0] ? 1 : 0])),
      };
    }
    return Response.json({ model: "liquid/d1-ultra", answers, usage: { input_tokens: 6, output_tokens: 2 } });
  }) as unknown as typeof fetch;

  const result = await autoAssignFolders("alice", {
    ids: ["card-0", "card-1"],
    folders: ["Heroes"],
    propose_new_folders: false,
  });

  // The first request carried both avatars; the retry dropped them entirely.
  expect(sent).toHaveLength(2);
  expect(Object.keys(sent[0].assets)).toHaveLength(2);
  expect(sent[1].assets).toBeUndefined();
  expect(sent[1].state.some((line: string) => line.includes("its avatar is the image"))).toBe(false);
  expect(result.imagesSkipped).toBe(true);
  expect(result.assignments).toEqual([
    { id: "card-0", folder: "Heroes" },
    { id: "card-1", folder: "Heroes" },
  ]);
});

test("auto-assign offers LLM-proposed folder names and records the new ones the model picks", async () => {
  const cards = [fakeCharacter(0, null), fakeCharacter(1, null)];
  spies.push(
    spyOn(characters, "getCharactersByIds").mockImplementation(() => new Map(cards.map((card) => [card.id, card]))),
    spyOn(connections, "getDefaultConnection").mockImplementation(() => profile as any),
    spyOn(secrets, "getSecret").mockImplementation(async () => "key"),
    spyOn(directGeneration, "quietGenerate").mockImplementation(
      async () => ({ content: 'Here you go:\n["Mystery", "Heroes"]' }) as any,
    ),
  );

  const sent: any[] = [];
  // The model picks the proposed "Mystery" folder for the first card.
  stubFetch((questionId, keys) => (questionId === "card_0" ? "Mystery" : keys[0]), sent);

  const result = await autoAssignFolders("alice", { ids: ["card-0", "card-1"], folders: ["Heroes", "Villains"] });

  // "Heroes" was already a folder, so only "Mystery" is offered as new; the
  // cards' own tags are still offered alongside the LLM proposal.
  expect(Object.keys(sent[0].questions.card_0.criteria)).toEqual(["Heroes", "Villains", "Mystery", "fantasy", "__no_folder__"]);
  expect(result.newFolders).toEqual(["Mystery"]);
  expect(result.assignments[0]).toEqual({ id: "card-0", folder: "Mystery" });
  expect(result.assignments[1]).toEqual({ id: "card-1", folder: "Heroes" });
});

test("auto-assign falls back to tag-derived folders when the LLM proposal fails", async () => {
  const cards = [fakeCharacter(0, null, []), fakeCharacter(1, null, ["noir", "noir", "fantasy"])];
  spies.push(
    spyOn(characters, "getCharactersByIds").mockImplementation(() => new Map(cards.map((card) => [card.id, card]))),
    spyOn(connections, "getDefaultConnection").mockImplementation(() => profile as any),
    spyOn(secrets, "getSecret").mockImplementation(async () => "key"),
    spyOn(directGeneration, "quietGenerate").mockImplementation(async () => {
      throw new Error("No connection profile found. Create one first.");
    }),
  );

  const sent: any[] = [];
  stubFetch((_questionId, keys) => keys[0], sent);

  const result = await autoAssignFolders("alice", { ids: ["card-0", "card-1"], folders: ["Heroes"] });

  // "noir" appears twice across the cards, so it is offered before "fantasy".
  expect(Object.keys(sent[0].questions.card_0.criteria)).toEqual(["Heroes", "noir", "fantasy", "__no_folder__"]);
  expect(result.assignments[0]).toEqual({ id: "card-0", folder: "Heroes" });
});

test("auto-assign refuses to run without folders or matching characters", async () => {
  const untagged = fakeCharacter(0, null, []);
  spies.push(
    spyOn(characters, "getCharactersByIds").mockImplementation(() => new Map([["card-0", untagged]])),
    spyOn(connections, "getDefaultConnection").mockImplementation(() => profile as any),
    spyOn(secrets, "getSecret").mockImplementation(async () => "key"),
    spyOn(directGeneration, "quietGenerate").mockImplementation(async () => ({ content: "[]" }) as any),
  );
  let fetches = 0;
  globalThis.fetch = (async () => { fetches += 1; return Response.json({}); }) as unknown as typeof fetch;

  await expect(autoAssignFolders("alice", { ids: ["card-0"], folders: [] }))
    .rejects.toThrow("at least one folder");
  await expect(autoAssignFolders("alice", { ids: [], folders: ["Heroes"] })).rejects.toThrow("character ids");
  expect(fetches).toBe(0);
});

test("auto-assign surfaces a missing default decision connection as a 404-class error", async () => {
  spies.push(
    spyOn(connections, "getDefaultConnection").mockImplementation(() => null),
    spyOn(secrets, "getSecret").mockImplementation(async () => "key"),
  );
  spies.push(spyOn(characters, "getCharactersByIds").mockImplementation(() => new Map([["card-0", fakeCharacter(0, null)]])));
  globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;

  await expect(autoAssignFolders("alice", { ids: ["card-0"], folders: ["Heroes"], propose_new_folders: false }))
    .rejects.toBeInstanceOf(DecisionConnectionNotFoundError);
});
