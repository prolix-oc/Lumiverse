import sharp from "sharp";
import type { DecisionEvaluationInput, DecisionImageAsset, DecisionQuestion, DecisionResult } from "../decision/contract";
import { DecisionValidationError } from "../decision/validation";
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
 * Choice question per card whose options are the existing folders.
 */
const AVATAR_SIZE = 384;
/**
 * liquid/d1 and liquid/d1-ultra accept at most 8 images per request, so every
 * batch — with or without an avatar — stays within that ceiling.
 */
const IMAGE_BATCH = 8;
const MAX_CARDS = 500;
/** Choice criteria allow 2–255 options; one slot is reserved for "no folder". */
const MAX_FOLDERS = 254;
const NO_FOLDER_KEY = "__no_folder__";

export interface AutoFolderAssignment {
  id: string;
  folder: string;
}

export interface AutoFolderResult {
  assignments: AutoFolderAssignment[];
  skipped: Array<{ id: string; reason: string }>;
  model: string;
  usage?: DecisionResult["usage"];
}

export interface AutoFolderInput {
  ids: string[];
  folders: string[];
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

export async function autoAssignFolders(userId: string, input: AutoFolderInput): Promise<AutoFolderResult> {
  const ids = [...new Set(input.ids)].filter((id) => typeof id === "string" && id.trim()).slice(0, MAX_CARDS);
  if (ids.length === 0) throw new DecisionValidationError("ids must contain character ids");

  const folders = [...new Set(input.folders.map((folder) => String(folder).trim()).filter(Boolean))];
  if (folders.length === 0) throw new DecisionValidationError("Create at least one folder before auto-assigning cards");
  if (folders.length > MAX_FOLDERS) throw new DecisionValidationError(`Auto-assign supports at most ${MAX_FOLDERS} folders`);

  const found = characters.getCharactersByIds(userId, ids);
  const cards = ids.map((id) => found.get(id)).filter((card): card is Character => !!card);
  if (cards.length === 0) throw new DecisionValidationError("No matching characters found");

  const keepFolderKey = noFolderKey(folders);
  const criteria: Record<string, string> = Object.create(null);
  for (const folder of folders) criteria[folder] = `Folder "${folder}"`;
  criteria[keepFolderKey] = "Leave this card uncategorized (no folder)";

  const assignments: AutoFolderAssignment[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  let model = "";
  let usage: DecisionResult["usage"];

  for (let offset = 0; offset < cards.length; offset += IMAGE_BATCH) {
    const batch = cards.slice(offset, offset + IMAGE_BATCH);
    const state: string[] = [
      "You sort character cards into folders. For every card, choose the single folder that best fits it.",
      `Existing folders: ${folders.join(", ")}.`,
    ];
    const questions: Record<string, DecisionQuestion> = Object.create(null);
    const assets: Record<string, DecisionImageAsset> = Object.create(null);

    for (const [index, card] of batch.entries()) {
      // The reference lives in `state` only: Liquid's decision models reject
      // image placeholders inside question instructions or criteria.
      const reference = `avatar-${card.id}`;
      const avatar = await loadAvatarJpeg(userId, card.image_id);
      if (avatar) {
        state.push(`Card ${card.id}: its avatar is the image "${reference}".`);
        assets[reference] = { type: "image", format: "jpg", data_base64: avatar.toString("base64") };
      } else {
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

    const evaluation: DecisionEvaluationInput = {
      state,
      questions,
      ...(Object.keys(assets).length ? { assets } : {}),
      ...(input.connection_id ? { connection_id: input.connection_id } : {}),
    };
    const result = await evaluateDecision(userId, evaluation);
    model = result.model;
    if (result.usage) usage = result.usage;

    for (const [index, card] of batch.entries()) {
      const answer = result.answers[`card_${offset + index}`];
      const choice = answer?.type === "choice" ? answer.choice : undefined;
      if (!choice) {
        skipped.push({ id: card.id, reason: "The decision model returned no folder for this card" });
        continue;
      }
      assignments.push({ id: card.id, folder: choice === keepFolderKey ? "" : choice });
    }
  }

  return { assignments, skipped, model, ...(usage ? { usage } : {}) };
}
