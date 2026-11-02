import sharp from "sharp";
import type { DecisionEvaluationInput, DecisionImageAsset, DecisionQuestion, DecisionResult } from "../decision/contract";
import { DecisionValidationError } from "../decision/validation";
import { ProviderRequestError } from "../utils/provider-errors";
import * as directGeneration from "./generation/direct-generation";
import { evaluateDecision } from "./decisions.service";
import * as characters from "./characters.service";
import * as images from "./images.service";
import type { Character } from "../types/character";

/**
 * Auto-assign character cards to folders with a Decision model that can read
 * images (TypeSafe's jev behind the images opt-in, OpenRouter's liquid/d1 and
 * liquid/d1-ultra, or a TypeSafe-compatible custom endpoint).
 *
 * Each card's avatar is sent as an `assets` image referenced from `state`, one
 * Choice question per card whose options are the existing folders plus new
 * folder candidates — the candidates come from an LLM connection first, then
 * the caller, then the cards' own tags — and an explicit "leave uncategorized".
 * Choosing a candidate records it in `newFolders` so the caller can create it.
 *
 * Providers that refuse image input (TypeSafe answers503 "Image processing is
 * unavailable") are retried once without the avatars, so a failed image pass
 * never leaves the library unsorted.
 */
const AVATAR_SIZE = 384;
/**
 * liquid/d1 and liquid/d1-ultra accept at most 8 images per request, so every
 * batch — with or without an avatar — stays within that ceiling.
 */
const IMAGE_BATCH = 8;
const MAX_CARDS = 500;
/**
 * Choice criteria allow 2–255 options: folders + candidates + "no folder".
 * Candidates are capped so the folder list can never push past the ceiling.
 */
const MAX_FOLDERS = 240;
const MAX_CANDIDATES = 10;
const NO_FOLDER_KEY = "__no_folder__";
const MAX_FOLDER_NAME = 48;
const FOLDER_PROPOSAL_TIMEOUT_MS = 30_000;
/** Cards beyond this are summarized for the LLM; the Decision still sees all. */
const PROPOSAL_CARD_LIMIT = 60;

export interface AutoFolderAssignment {
  id: string;
  /** Existing folder name, a name listed in `newFolders`, or "" for uncategorized. */
  folder: string;
}

export interface AutoFolderResult {
  assignments: AutoFolderAssignment[];
  skipped: Array<{ id: string; reason: string }>;
  /** Folder names the model chose that do not exist yet; applying creates them. */
  newFolders: string[];
  /** True when avatars were dropped after the provider refused image input. */
  imagesSkipped: boolean;
  model: string;
  usage?: DecisionResult["usage"];
}

export interface AutoFolderInput {
  ids: string[];
  folders: string[];
  /** Extra new-folder names offered to the model, on top of the derived ones. */
  new_folder_candidates?: string[];
  /** LLM connection used to propose new folder names; the active one if omitted. */
  llm_connection_id?: string;
  /** Set false to skip the LLM proposal pass (candidates still come from tags). */
  propose_new_folders?: boolean;
  connection_id?: string;
}

/** Avoid colliding with a real folder the user happened to name like the sentinel. */
function noFolderKey(folders: string[]): string {
  let key = NO_FOLDER_KEY;
  while (folders.includes(key)) key += "_";
  return key;
}

/** Bounded card text: the full description lives in the character itself. */
function excerpt(value: string, max = 480): string {
  const text = (value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizeFolderName(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_FOLDER_NAME);
}

/** Trim, collapse whitespace, and de-duplicate a caller-supplied folder list. */
function uniqueFolderNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const name = normalizeFolderName(entry);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Normalize an avatar to a JPEG the providers will accept: TypeSafe rejects
 * anything outside 280–1568 px per side, and every image counts against the
 * per-request patch and byte budgets. Returns null for missing or unreadable
 * avatars so the card is still filed from its text.
 */
async function loadAvatarJpeg(userId: string, imageId: string | null): Promise<Buffer | null> {
  if (!imageId) return null;
  try {
    const path = await images.getImageFilePath(userId, imageId);
    if (!path) return null;
    const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
    if (bytes.length === 0) return null;
    return await sharp(bytes)
      .rotate()
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "attention" })
      .jpeg({ quality: 78 })
      .toBuffer();
  } catch {
    return null;
  }
}

/** Read a JSON array out of an LLM reply that may be fenced or chatty. */
function parseFolderNameList(content: string): string[] {
  const match = (content || "").match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

/**
 * Ask an LLM connection for new folder names that suit these cards. Any
 * failure (no connection, no key, timeout, unparseable reply) yields an empty
 * list so the caller falls back to tag-derived candidates.
 */
async function proposeFolderNames(
  userId: string,
  cards: Character[],
  existing: string[],
  connectionId: string | undefined,
): Promise<string[]> {
  const lines = cards.slice(0, PROPOSAL_CARD_LIMIT).map((card) =>
    `- ${excerpt(card.name, 60)} | tags: ${(card.tags || []).join(", ") || "none"} | ${excerpt(card.description || card.personality, 140)}`,
  );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Folder proposal timed out")),
    FOLDER_PROPOSAL_TIMEOUT_MS,
  );
  try {
    const response = await directGeneration.quietGenerate(
      userId,
      {
        messages: [
          {
            role: "system",
            content:
              "You name folders for a library of character cards. Reply with ONLY a JSON array of short folder names (one to three words each). No markdown fences, no commentary.",
          },
          {
            role: "user",
            content: `Existing folders: ${existing.join(", ") || "none"}.\nPropose up to ${MAX_CANDIDATES} NEW folder names that would best sort these cards. Never repeat an existing folder.\nCards:\n${lines.join("\n")}`,
          },
        ],
        ...(connectionId ? { connection_id: connectionId } : {}),
        signal: controller.signal,
      },
      { origin: { kind: "sidecar", name: "Character Folders", operation: "propose folder names" } },
    );
    return parseFolderNameList(response.content || "");
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * True when the provider refused the request because of its images rather
 * than because the request itself was wrong — TypeSafe answers 503 "Image
 * processing is unavailable" for accounts or models without image support.
 */
function isImageInputRefused(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/image processing is unavailable|image input (?:is )?(?:unavailable|unsupported|not supported)/i.test(message)) {
    return true;
  }
  const status = error instanceof ProviderRequestError ? error.status : undefined;
  return status === 503 && /image/i.test(message);
}

export async function autoAssignFolders(userId: string, input: AutoFolderInput): Promise<AutoFolderResult> {
  const ids = [...new Set(input.ids)].filter((id) => typeof id === "string" && id.trim()).slice(0, MAX_CARDS);
  if (ids.length === 0) throw new DecisionValidationError("ids must contain character ids");

  const existingFolders = uniqueFolderNames(input.folders);
  if (existingFolders.length > MAX_FOLDERS) throw new DecisionValidationError(`Auto-assign supports at most ${MAX_FOLDERS} folders`);

  const found = characters.getCharactersByIds(userId, ids);
  const cards = ids.map((id) => found.get(id)).filter((card): card is Character => !!card);
  if (cards.length === 0) throw new DecisionValidationError("No matching characters found");

  // New folder candidates: LLM proposal first, then caller-supplied names,
  // then the cards' own tags, which always work without an LLM connection.
  const taken = new Set(existingFolders.map((folder) => folder.toLowerCase()));
  const candidates: string[] = [];
  const addCandidate = (raw: unknown) => {
    if (candidates.length >= MAX_CANDIDATES) return;
    const name = normalizeFolderName(raw);
    if (!name) return;
    const key = name.toLowerCase();
    if (taken.has(key)) return;
    taken.add(key);
    candidates.push(name);
  };

  if (input.propose_new_folders !== false) {
    for (const name of await proposeFolderNames(userId, cards, existingFolders, input.llm_connection_id)) {
      addCandidate(name);
    }
  }
  if (Array.isArray(input.new_folder_candidates)) {
    for (const name of input.new_folder_candidates) addCandidate(name);
  }
  const tagCounts = new Map<string, { name: string; count: number }>();
  for (const card of cards) {
    for (const tag of card.tags || []) {
      const name = normalizeFolderName(tag);
      if (!name) continue;
      const key = name.toLowerCase();
      if (taken.has(key)) continue;
      const entry = tagCounts.get(key);
      if (entry) entry.count += 1;
      else tagCounts.set(key, { name, count: 1 });
    }
  }
  for (const entry of [...tagCounts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))) {
    addCandidate(entry.name);
  }

  if (existingFolders.length === 0 && candidates.length === 0) {
    throw new DecisionValidationError("Create at least one folder before auto-assigning cards");
  }

  const keepFolderKey = noFolderKey([...existingFolders, ...candidates]);
  const criteria: Record<string, string> = Object.create(null);
  for (const folder of existingFolders) criteria[folder] = `Existing folder "${folder}"`;
  for (const candidate of candidates) {
    criteria[candidate] = `New folder "${candidate}" that does not exist yet — picking it creates the folder`;
  }
  criteria[keepFolderKey] = "Leave this card uncategorized (no folder)";

  const assignments: AutoFolderAssignment[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const newFolders = new Set<string>();
  const candidateSet = new Set(candidates);
  const criteriaKeys = new Set(Object.keys(criteria));
  let imagesSkipped = false;
  let model = "";
  let usage: DecisionResult["usage"];

  for (let offset = 0; offset < cards.length; offset += IMAGE_BATCH) {
    const batch = cards.slice(offset, offset + IMAGE_BATCH);
    const avatars = await Promise.all(batch.map((card) => loadAvatarJpeg(userId, card.image_id)));

    const buildEvaluation = (withImages: boolean): DecisionEvaluationInput => {
      const state: string[] = [
        "You sort character cards into folders. For every card, choose the single folder that best fits it.",
        existingFolders.length ? `Existing folders: ${existingFolders.join(", ")}.` : "There are no existing folders yet.",
        candidates.length
          ? `New folders you may create by choosing them: ${candidates.join(", ")}.`
          : "",
      ].filter(Boolean);
      const questions: Record<string, DecisionQuestion> = Object.create(null);
      const assets: Record<string, DecisionImageAsset> = Object.create(null);

      for (const [index, card] of batch.entries()) {
        // The reference lives in `state` only: Liquid's decision models reject
        // image placeholders inside question instructions or criteria.
        const reference = `avatar-${card.id}`;
        const avatar = avatars[index];
        if (withImages && avatar) {
          state.push(`Card ${card.id}: its avatar is the image "${reference}".`);
          assets[reference] = { type: "image", format: "jpg", data_base64: avatar.toString("base64") };
        } else if (withImages) {
          state.push(`Card ${card.id}: this card has no avatar image.`);
        }
        state.push(
          `Card ${card.id} — name: ${card.name}; tags: ${card.tags.length ? card.tags.join(", ") : "none"}; description: ${excerpt(card.description || card.personality)}`,
        );
        // Question ids stay unique across batches so answers can never be read
        // back against the wrong card.
        questions[`card_${offset + index}`] = {
          type: "choice",
          instructions: `Pick the folder that best fits the character card named "${excerpt(card.name, 120)}" (Card ${card.id}), judging from its avatar, name, tags and description.`,
          criteria,
        };
      }

      return {
        state,
        questions,
        ...(withImages && Object.keys(assets).length ? { assets } : {}),
        ...(input.connection_id ? { connection_id: input.connection_id } : {}),
      };
    };

    const hasImages = avatars.some((avatar) => !!avatar);
    let result: DecisionResult;
    try {
      result = await evaluateDecision(userId, buildEvaluation(hasImages));
    } catch (error) {
      if (!hasImages || !isImageInputRefused(error)) throw error;
      // The provider cannot take images for this account or model: file the
      // cards from their names, tags and descriptions instead of failing.
      imagesSkipped = true;
      result = await evaluateDecision(userId, buildEvaluation(false));
    }
    model = result.model;
    if (result.usage) usage = result.usage;

    for (const [index, card] of batch.entries()) {
      const answer = result.answers[`card_${offset + index}`];
      const choice = answer?.type === "choice" ? answer.choice : undefined;
      if (!choice) {
        skipped.push({ id: card.id, reason: "The decision model returned no folder for this card" });
        continue;
      }
      if (choice !== keepFolderKey && !criteriaKeys.has(choice)) {
        skipped.push({ id: card.id, reason: `The decision model returned an unknown folder "${choice}"` });
        continue;
      }
      const folder = choice === keepFolderKey ? "" : choice;
      if (folder && candidateSet.has(folder)) newFolders.add(folder);
      assignments.push({ id: card.id, folder });
    }
  }

  return {
    assignments,
    skipped,
    newFolders: [...newFolders],
    imagesSkipped,
    model,
    ...(usage ? { usage } : {}),
  };
}
