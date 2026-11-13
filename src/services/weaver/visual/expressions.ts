import type {
  WeaverVisualImageInputMechanism,
  WeaverVisualVariantDef,
} from "../../../types/weaver";

export const EXPRESSION_VARIANTS: readonly WeaverVisualVariantDef[] = [
  {
    id: "neutral",
    tags: "expressionless, neutral expression, closed mouth, relaxed",
    negative_tags: "smile, frown, blush, tears, open mouth",
    cues:
      "A calm, at-rest face: mouth closed and level, brows relaxed, eyes open with a soft, steady gaze.",
  },
  {
    id: "happy",
    tags: "smile, happy, cheerful",
    negative_tags: "tears, crying, angry, frown, sad",
    cues:
      "A genuine smile: the corners of the mouth raised, cheeks lifted, eyes gently narrowed with warmth, brows relaxed.",
  },
  {
    id: "sad",
    tags: "sad, frown, furrowed brow, downcast eyes",
    negative_tags: "tears, crying, sobbing, smile, open mouth",
    cues:
      "Clear sadness: the inner ends of the brows raised and drawn together, mouth corners turned down, eyelids heavy, gaze lowered. No tears.",
  },
  {
    id: "angry",
    tags: "angry, glaring, furrowed brow, frown",
    negative_tags: "smile, tears, crying, blush, shouting, open mouth",
    cues:
      "Open anger: brows pulled down and together, eyes narrowed into a hard glare, jaw set, mouth pressed thin.",
  },
  {
    id: "surprised",
    tags: "surprised, wide-eyed, raised eyebrows, parted lips",
    negative_tags: "smile, tears, screaming, scared",
    cues:
      "Sudden surprise: brows raised high, eyes wide open, lips parted in a small gasp.",
  },
  {
    id: "afraid",
    tags: "scared, fearful, wide-eyed, raised eyebrows, parted lips",
    negative_tags: "smile, blood, crying, screaming, motion lines, trembling",
    cues:
      "Visible fear: brows raised and drawn together, eyes wide with the upper lids lifted, lips parted and pulled back at the corners.",
  },
  {
    id: "disgust",
    tags: "disgust, frowning, narrowed eyes, wrinkled nose, wavy mouth",
    negative_tags: "smile, tears, vomit, tongue out",
    cues:
      "Plain disgust: nose wrinkled, upper lip raised, brows lowered, eyes narrowed, the head drawn back slightly.",
  },
  {
    id: "shy",
    tags: "embarrassed, blush, shy, averted eyes, looking away, wavy mouth",
    negative_tags: "tears, crying, full-face blush, smile, nosebleed",
    cues:
      "Shy embarrassment: a soft blush on the cheeks, gaze averted to the side and down, a small hesitant mouth, brows tilted up at the inner ends.",
  },
] as const;

export function resolveExpressionVariant(label: string): WeaverVisualVariantDef {
  const id = label.trim().toLowerCase();
  const def = EXPRESSION_VARIANTS.find((v) => v.id === id);
  if (def) return def;
  return {
    id,
    tags: id,
    cues: `An expression that reads clearly and unmistakably as ${id}, carried by the brows, eyes, and mouth.`,
  };
}

export function buildExpressionEditPrompt(variant: WeaverVisualVariantDef): string {
  return [
    `Edit this image: change the character's facial expression to ${variant.id}.`,
    variant.cues,
    "Keep everything else exactly as it is: the same character, face shape, hairstyle, clothing, accessories, pose, hands, camera framing, background, lighting, art style, line work, and color palette.",
    "Do not add, remove, or restyle anything outside the face. Do not add text, watermarks, speech bubbles, effects, or new objects.",
    "The result must read as the same artwork with only the expression changed.",
  ].join(" ");
}

export interface ExpressionTagPrompts {
  prompt: string;
  negative_prompt: string;
}

function joinTags(...parts: Array<string | undefined>): string {
  return parts
    .map((p) => p?.trim() ?? "")
    .filter(Boolean)
    .join(", ");
}

export function buildExpressionTagPrompts(
  variant: WeaverVisualVariantDef,
  basePrompt: string,
  baseNegative: string,
): ExpressionTagPrompts {
  return {
    prompt: joinTags(variant.tags, basePrompt),
    negative_prompt: joinTags(variant.negative_tags, baseNegative),
  };
}

export function composeExpressionPrompts(
  variant: WeaverVisualVariantDef,
  mechanism: WeaverVisualImageInputMechanism,
  basePrompt: string,
  baseNegative: string,
): ExpressionTagPrompts {
  if (mechanism === "edit") {
    return { prompt: buildExpressionEditPrompt(variant), negative_prompt: "" };
  }
  return buildExpressionTagPrompts(variant, basePrompt, baseNegative);
}
