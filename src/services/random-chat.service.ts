import type { DecisionEvaluationInput, DecisionQuestion, DecisionResult } from "../decision/contract";
import { DecisionValidationError } from "../decision/validation";
import { evaluateDecision } from "./decisions.service";
import * as characters from "./characters.service";
import * as settings from "./settings.service";
import type { CharacterSummary } from "../types/character";

/**
 * Start a new chat by asking a Decision model which character to play.
 *
 * The candidate list carries what the pick should be based on: the card's type
 * (tags), what it roleplays (description), and the user's likes (their
 * favorited characters and the tags those share).
 */
/** Choice criteria allow at most 255 options; keep headroom for long tag lists. */
const MAX_CANDIDATES = 200;
const MAX_DESCRIPTION = 480;
const MAX_HINT = 400;

export interface RandomChatPick {
  character_id: string;
  character_name: string;
  model: string;
  usage?: DecisionResult["usage"];
}

export interface RandomChatInput {
  connection_id?: string;
  hint?: string;
}

function readFavoriteIds(userId: string): Set<string> {
  const value = settings.getSetting(userId, "favorites")?.value;
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0));
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function excerpt(value: string, max = MAX_DESCRIPTION): string {
  const text = (value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Favorites come first so "my likes" always reach the model, then a random
 * sample of the rest fills the 255-option Choice cap on large libraries.
 */
function chooseCandidates(all: CharacterSummary[], favorites: Set<string>): CharacterSummary[] {
  const liked = all.filter((card) => favorites.has(card.id));
  const others = shuffle(all.filter((card) => !favorites.has(card.id)));
  return [...liked, ...others].slice(0, MAX_CANDIDATES);
}

/** Tags shared by the favorited cards — the strongest "likes" signal. */
function likedTags(all: CharacterSummary[], favorites: Set<string>): string[] {
  const counts = new Map<string, number>();
  for (const card of all) {
    if (!favorites.has(card.id)) continue;
    for (const tag of card.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([tag]) => tag);
}

export async function pickRandomCharacter(userId: string, input: RandomChatInput = {}): Promise<RandomChatPick> {
  const favorites = readFavoriteIds(userId);
  const all = characters.listCharacterSummaries(userId, { limit: 1000, offset: 0 }, {}).data;
  if (all.length === 0) throw new DecisionValidationError("No characters to pick from");

  const candidates = chooseCandidates(all, favorites);
  const state = JSON.stringify({
    task: "Pick exactly one character to start a new roleplay chat with.",
    ...(input.hint ? { guidance: excerpt(input.hint, MAX_HINT) } : {}),
    likes: {
      favorite_characters: candidates.filter((card) => favorites.has(card.id)).map((card) => card.name),
      favorite_tags: likedTags(all, favorites),
    },
    characters: candidates.map((card, index) => ({
      key: `c${index}`,
      name: card.name,
      tags: card.tags,
      favorite: favorites.has(card.id),
      description: excerpt(card.preview_description || card.description),
    })),
  });

  const criteria: Record<string, string> = Object.create(null);
  candidates.forEach((card, index) => {
    const tags = card.tags.slice(0, 8).join(", ");
    criteria[`c${index}`] = [
      card.name,
      tags ? `tags: ${tags}` : "",
      favorites.has(card.id) ? "★ favorite" : "",
    ].filter(Boolean).join(" — ");
  });

  const questions: Record<string, DecisionQuestion> = {
    pick: {
      type: "choice",
      instructions: [
        "Choose the single character that best matches the user's likes and the kind of roleplay they are in the mood for.",
        "Prefer favorited characters and their tags when they fit, but pick any candidate that fits the guidance better.",
        "Every candidate's key, name, tags and description are listed in the state.",
      ].join(" "),
      criteria,
    },
  };

  const evaluation: DecisionEvaluationInput = {
    state,
    questions,
    ...(input.connection_id ? { connection_id: input.connection_id } : {}),
  };
  const result = await evaluateDecision(userId, evaluation);
  const answer = result.answers.pick;
  const choice = answer?.type === "choice" ? answer.choice : undefined;
  const index = choice ? Number.parseInt(choice.slice(1), 10) : Number.NaN;
  const picked = Number.isInteger(index) && index >= 0 && index < candidates.length ? candidates[index] : undefined;
  if (!picked) throw new DecisionValidationError("The decision model did not pick a character");

  return {
    character_id: picked.id,
    character_name: picked.name,
    model: result.model,
    ...(result.usage ? { usage: result.usage } : {}),
  };
}
