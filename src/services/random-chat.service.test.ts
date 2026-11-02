import { afterEach, expect, spyOn, test } from "bun:test";
import * as characters from "./characters.service";
import * as settings from "./settings.service";
import * as connections from "./decision-connections.service";
import * as secrets from "./secrets.service";
import { pickRandomCharacter } from "./random-chat.service";
import type { DecisionConnectionProfileDTO } from "../decision/contract";
import type { CharacterSummary } from "../types/character";

const originalFetch = globalThis.fetch;
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const profile = {
  id: "decision", name: "Decision", provider: "typesafe", api_url: "", model: "jev-latest", default_parameters: {},
} as unknown as DecisionConnectionProfileDTO;

function summary(id: string, name: string, tags: string[], description: string): CharacterSummary {
  return {
    id, name, tags, description, preview_description: description,
    creator: "", folder: "", image_id: null, library_scope: "private",
    created_at: 0, updated_at: 0, has_alternate_greetings: false,
  } as unknown as CharacterSummary;
}

test("the random-chat pick carries tags, descriptions and favorites to the decision model", async () => {
  const all = [
    summary("c1", "Pirate", ["adventure", "sea"], "Swashbuckling high-seas adventure"),
    summary("c2", "Detective", ["mystery"], "Noir murder mystery in a rainy city"),
    summary("c3", "Chef", ["slice-of-life"], "Cosy kitchen drama"),
  ];
  spies.push(
    spyOn(characters, "listCharacterSummaries").mockReturnValue({ data: all, total: all.length, limit: 1000, offset: 0 } as any),
    spyOn(settings, "getSetting").mockImplementation((_userId, key) => (key === "favorites" ? { key, value: ["c3"], updated_at: 0 } : null) as any),
    spyOn(connections, "getDefaultConnection").mockImplementation(() => profile as any),
    spyOn(secrets, "getSecret").mockImplementation(async () => "key"),
  );

  let sent: any;
  globalThis.fetch = (async (_url: any, init: any) => {
    sent = JSON.parse(init.body);
    return Response.json({
      model: "jev-latest",
      // c0 is always the favorite, which chooseCandidates ranks first.
      answers: { pick: { type: "choice", choice: "c0", confidence: 1, probabilities: { c0: 1, c1: 0, c2: 0 } } },
      usage: { input_tokens: 12, output_tokens: 1 },
    });
  }) as unknown as typeof fetch;

  const pick = await pickRandomCharacter("alice", { hint: "something nautical" });

  expect(pick).toEqual({
    character_id: "c3",
    character_name: "Chef",
    model: "jev-latest",
    usage: { input_tokens: 12, output_tokens: 1 },
  });

  const state = JSON.parse(sent.state);
  expect(state.guidance).toBe("something nautical");
  // The favorite is ranked first so the model always sees the user's likes.
  expect(state.characters[0]).toMatchObject({ key: "c0", name: "Chef", favorite: true });
  expect(state.likes.favorite_characters).toEqual(["Chef"]);
  expect(state.characters).toHaveLength(3);
  // What they roleplay travels with each candidate (the rest are shuffled).
  const detective = state.characters.find((card: { name: string }) => card.name === "Detective");
  expect(detective.description).toContain("murder mystery");

  const criteria = sent.questions.pick.criteria;
  expect(Object.keys(criteria)).toEqual(["c0", "c1", "c2"]);
  expect(criteria.c0).toContain("★ favorite");
  expect(Object.values(criteria as Record<string, string>).some((value) => value.includes("mystery"))).toBe(true);
});

test("a library with no characters never calls the provider", async () => {
  spies.push(
    spyOn(characters, "listCharacterSummaries").mockReturnValue({ data: [], total: 0, limit: 1000, offset: 0 } as any),
    spyOn(settings, "getSetting").mockReturnValue(null as any),
    spyOn(connections, "getDefaultConnection").mockImplementation(() => profile as any),
    spyOn(secrets, "getSecret").mockImplementation(async () => "key"),
  );
  let fetches = 0;
  globalThis.fetch = (async () => { fetches += 1; return Response.json({}); }) as unknown as typeof fetch;

  await expect(pickRandomCharacter("alice")).rejects.toThrow("No characters to pick from");
  expect(fetches).toBe(0);
});
