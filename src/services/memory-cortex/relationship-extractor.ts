/**
 * Memory Cortex — Heuristic relationship extraction.
 *
 * Detects relationships between entities by analyzing verb-mediated patterns,
 * relational nouns, terms of address, and emotional co-occurrence within
 * chunk content. No sidecar LLM needed.
 *
 * Strategy:
 *   For each PAIR of known entities in a chunk:
 *     1. Check verb-mediated patterns: "Name1 [verb] Name2"
 *     2. Check relational nouns: "Name1's [relation]" near Name2
 *     3. Check coordinated action: "Name1 and Name2 [verb] together"
 *     4. Check terms of address: "'sweetheart,' Name1 said to Name2"
 *     5. Fallback: co-occurrence with emotional chunk context
 */

import type { RelationType, EmotionalTag } from "./types";

// ─── Types ─────────────────────────────────────────────────────

export interface HeuristicRelationship {
  source: string;
  target: string;
  type: RelationType;
  label: string;
  sentiment: number;
  confidence: number;
}

// ─── Verb Dictionaries ─────────────────────────────────────────
// Each category maps verbs to relationship type + sentiment + label

interface VerbSignal {
  type: RelationType;
  sentiment: number;
  label: string;
}

const DIRECTED_VERB_PATTERNS: Array<{ pattern: RegExp; signal: VerbSignal }> = [
  // Intimate/romantic
  { pattern: /\b(kissed|embraced|caressed|held\s+close|cuddled|nuzzled)\b/i, signal: { type: "lover", sentiment: 0.8, label: "romantic" } },
  { pattern: /\b(loves?|adore[ds]?|cherish(?:ed|es)?)\b/i, signal: { type: "lover", sentiment: 0.7, label: "deep affection" } },

  // Protective/care
  { pattern: /\b(protected|shielded|guarded|defended|saved|rescued|healed|treated|bandaged|carried)\b/i, signal: { type: "ally", sentiment: 0.6, label: "protector" } },
  { pattern: /\b(comforted|consoled|reassured|soothed|calmed)\b/i, signal: { type: "ally", sentiment: 0.5, label: "emotional support" } },

  // Cooperative
  { pattern: /\b(helped|aided|assisted|supported|backed|covered|joined|accompanied|followed)\b/i, signal: { type: "ally", sentiment: 0.4, label: "cooperative" } },
  { pattern: /\b(trusts?|trusted|relied?\s+on|counts?\s+on|counted\s+on|believes?\s+in|believed\s+in)\b/i, signal: { type: "ally", sentiment: 0.5, label: "trust" } },

  // Shared experience / companionship
  { pattern: /\b(walked\s+(?:with|beside|alongside)|traveled\s+with|sat\s+(?:beside|next\s+to|with)|ate\s+with|drank\s+with|shared\s+(?:a\s+)?(?:meal|drink|fire|camp|tent|room|bed))\b/i, signal: { type: "ally", sentiment: 0.3, label: "companionship" } },
  { pattern: /\b(waited\s+for|watched\s+over|stayed\s+(?:with|by|beside)|kept\s+(?:company|watch|vigil))\b/i, signal: { type: "ally", sentiment: 0.4, label: "devotion" } },

  // Conversational reciprocity
  { pattern: /\b(told|explained\s+to|confided\s+in|warned|informed|assured|reassured|convinced)\b/i, signal: { type: "ally", sentiment: 0.3, label: "communication" } },
  { pattern: /\b(asked|questioned|interrogated|demanded\s+(?:of|from)|confronted)\b/i, signal: { type: "custom", sentiment: 0.0, label: "inquiry" } },

  // Forgiveness/reconciliation
  { pattern: /\b(forgave|forgiven|apologized\s+to|made\s+(?:amends|peace)\s+with|reconciled\s+with)\b/i, signal: { type: "ally", sentiment: 0.5, label: "reconciliation" } },

  // Hostile/violent
  { pattern: /\b(attacked|struck|hit|punched|kicked|stabbed|shot|slashed|tackled|shoved)\b/i, signal: { type: "enemy", sentiment: -0.8, label: "violent" } },
  { pattern: /\b(killed|murdered|slain|executed|assassinated|destroyed)\b/i, signal: { type: "enemy", sentiment: -1.0, label: "lethal" } },
  { pattern: /\b(threatened|intimidated|cornered|ambushed|hunted)\b/i, signal: { type: "enemy", sentiment: -0.6, label: "threatening" } },

  // Betrayal
  { pattern: /\b(betrayed|double-crossed|backstabbed|deceived|tricked|manipulated|used)\b/i, signal: { type: "enemy", sentiment: -0.9, label: "betrayal" } },

  // Tension/conflict (not full hostility)
  { pattern: /\b(argued\s+with|confronted|challenged|accused|blamed|suspected|distrusted)\b/i, signal: { type: "rival", sentiment: -0.4, label: "tension" } },
  { pattern: /\b(glared\s+at|snarled\s+at|snapped\s+at|shouted\s+at|yelled\s+at)\b/i, signal: { type: "rival", sentiment: -0.5, label: "hostility" } },

  // Hierarchical
  { pattern: /\b(commanded|ordered|instructed|directed|assigned|dispatched)\b/i, signal: { type: "serves", sentiment: 0.1, label: "commands" } },
  { pattern: /\b(obeyed|served|reported\s+to|answered\s+to|bowed\s+(?:to|before))\b/i, signal: { type: "serves", sentiment: 0.1, label: "serves" } },

  // Teaching/mentoring
  { pattern: /\b(taught|trained|mentored|guided|showed|explained\s+to|lectured)\b/i, signal: { type: "mentor", sentiment: 0.3, label: "teacher" } },

  // Fear
  { pattern: /\b(fears?|feared|dreads?|dreaded|was\s+afraid\s+of|cowered?\s+(?:from|before)|flinch(?:ed|es)?\s+(?:from|at))\b/i, signal: { type: "fears", sentiment: -0.3, label: "fears" } },
];

// ─── Relational Noun Patterns ──────────────────────────────────
// "Melina's brother", "her mentor", "his rival"

const RELATIONAL_NOUNS: Array<{ pattern: RegExp; type: RelationType; sentiment: number }> = [
  // Family
  { pattern: /\b(father|mother|parent|dad|mom|papa|mama)\b/i, type: "parent", sentiment: 0.3 },
  { pattern: /\b(son|daughter|child|kid|offspring)\b/i, type: "child", sentiment: 0.3 },
  { pattern: /\b(brother|sister|sibling|twin)\b/i, type: "sibling", sentiment: 0.3 },

  // Romantic
  { pattern: /\b(partner|lover|husband|wife|spouse|boyfriend|girlfriend|fiancée?|beloved|sweetheart|darling)\b/i, type: "lover", sentiment: 0.7 },

  // Professional/hierarchical
  { pattern: /\b(mentor|teacher|master|instructor|sensei|coach)\b/i, type: "mentor", sentiment: 0.3 },
  { pattern: /\b(student|apprentice|protégée?|pupil|trainee)\b/i, type: "child", sentiment: 0.2 },
  { pattern: /\b(boss|commander|captain|superior|leader|chief)\b/i, type: "serves", sentiment: 0.1 },

  // Social
  { pattern: /\b(friend|companion|comrade|buddy|pal|confidant|ally|partner-in-crime)\b/i, type: "ally", sentiment: 0.5 },
  { pattern: /\b(rival|nemesis|adversary|opponent|competitor|antagonist)\b/i, type: "rival", sentiment: -0.3 },
  { pattern: /\b(enemy|foe|threat)\b/i, type: "enemy", sentiment: -0.6 },
];

// ─── Terms of Endearment/Hostility ─────────────────────────────

const ENDEARMENT_TERMS = /\b(sweetheart|darling|honey|love|dear|babe|baby|gorgeous|beautiful|handsome|sunshine|angel|princess|prince|my\s+love|my\s+dear)\b/i;
const HOSTILITY_TERMS = /\b(bastard|traitor|coward|fool|idiot|scum|monster|freak|rat|snake|worm|liar|murderer|thief|criminal)\b/i;

// ─── Main Extraction ───────────────────────────────────────────

/**
 * Extract relationships between entities found in a chunk.
 *
 * @param content - Sanitized chunk content
 * @param entityNames - Names of entities found in THIS chunk (already extracted)
 * @param emotionalTags - Emotional tags from salience scoring (for co-occurrence sentiment)
 * @returns Array of heuristic relationships
 */
export function extractRelationshipsHeuristic(
  content: string,
  entityNames: string[],
  emotionalTags: EmotionalTag[] = [],
): HeuristicRelationship[] {
  if (entityNames.length < 2) return [];

  const relationships: HeuristicRelationship[] = [];
  const seen = new Set<string>(); // Deduplicate "A→B type" combos

  // For each ordered pair of entities
  for (let i = 0; i < entityNames.length; i++) {
    for (let j = 0; j < entityNames.length; j++) {
      if (i === j) continue;
      const source = entityNames[i];
      const target = entityNames[j];

      // 1. Verb-mediated: "Source [verb] Target" or "Source [verb] ... Target"
      const verbRels = detectVerbMediated(source, target, content);
      for (const rel of verbRels) {
        const key = `${source}→${target}:${rel.type}`;
        if (!seen.has(key)) {
          seen.add(key);
          relationships.push(rel);
        }
      }

      // 2. Relational nouns: "Source's [relation]" or "Target's [relation]" nearby
      if (i < j) { // Only process each pair once — function checks both directions
        const nounRels = detectRelationalNouns(source, target, content);
        for (const rel of nounRels) {
          const key = `${rel.source}→${rel.target}:${rel.type}`;
          if (!seen.has(key)) {
            seen.add(key);
            relationships.push(rel);
          }
        }
      }
    }
  }

  // 3. Coordinated agents: "Name1 and Name2" — check surrounding verbs
  for (let i = 0; i < entityNames.length; i++) {
    for (let j = i + 1; j < entityNames.length; j++) {
      const coordRel = detectCoordinatedAction(entityNames[i], entityNames[j], content);
      if (coordRel) {
        const key = `${coordRel.source}→${coordRel.target}:${coordRel.type}`;
        if (!seen.has(key)) {
          seen.add(key);
          relationships.push(coordRel);
        }
      }
    }
  }

  // 4. Terms of endearment/hostility in dialogue near two names
  for (let i = 0; i < entityNames.length; i++) {
    for (let j = 0; j < entityNames.length; j++) {
      if (i === j) continue;
      const termRel = detectTermsOfAddress(entityNames[i], entityNames[j], content);
      if (termRel) {
        const key = `${termRel.source}→${termRel.target}:${termRel.type}`;
        if (!seen.has(key)) {
          seen.add(key);
          relationships.push(termRel);
        }
      }
    }
  }

  // 5. Physical proximity / shared space
  for (let i = 0; i < entityNames.length; i++) {
    for (let j = i + 1; j < entityNames.length; j++) {
      const proxRel = detectPhysicalProximity(entityNames[i], entityNames[j], content);
      if (proxRel) {
        const key = `${proxRel.source}→${proxRel.target}:${proxRel.type}`;
        if (!seen.has(key)) {
          seen.add(key);
          relationships.push(proxRel);
        }
      }
    }
  }

  // 6. Emotional co-occurrence fallback
  // If two entities appear together and we have strong emotional tags but no
  // explicit verb pattern, infer a weak relationship from the emotional context
  if (relationships.length === 0 && entityNames.length >= 2 && emotionalTags.length > 0) {
    const coRel = inferFromEmotionalContext(entityNames[0], entityNames[1], emotionalTags);
    if (coRel) relationships.push(coRel);
  }

  return relationships;
}

// ─── Detection Functions ───────────────────────────────────────

function detectVerbMediated(
  source: string,
  target: string,
  content: string,
): HeuristicRelationship[] {
  const results: HeuristicRelationship[] = [];
  const srcEsc = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tgtEsc = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  for (const { pattern, signal } of DIRECTED_VERB_PATTERNS) {
    // "Source [verb] Target" — tight window (0-2 words between verb and target)
    // to avoid cross-entity false positives in multi-entity scenes.
    const directPattern = new RegExp(
      `${srcEsc}\\s+${pattern.source}\\s+(?:\\w+\\s+){0,2}${tgtEsc}`,
      "i",
    );
    if (directPattern.test(content)) {
      results.push({
        source,
        target,
        type: signal.type,
        label: signal.label,
        sentiment: signal.sentiment,
        confidence: 0.75,
      });
      continue;
    }

    // "Source [verb] ... [preposition] Target" — verb + prep + target
    const prepPattern = new RegExp(
      `${srcEsc}\\s+${pattern.source}\\s+(?:\\w+\\s+){0,6}(?:to|at|for|from|with|against|toward|before|after)\\s+(?:\\w+\\s+){0,2}${tgtEsc}`,
      "i",
    );
    if (prepPattern.test(content)) {
      results.push({
        source,
        target,
        type: signal.type,
        label: signal.label,
        sentiment: signal.sentiment,
        confidence: 0.6,
      });
    }
  }

  return results;
}

function detectRelationalNouns(
  name1: string,
  name2: string,
  content: string,
): HeuristicRelationship[] {
  const results: HeuristicRelationship[] = [];

  // Check BOTH directions: "name1's [relation]" near name2,
  // AND "name2's [relation]" near name1.
  const pairs: [string, string][] = [[name1, name2], [name2, name1]];

  for (const [possessor, other] of pairs) {
    const escPoss = possessor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    for (const { pattern, type, sentiment } of RELATIONAL_NOUNS) {
      // "Possessor's [relation]" near Other
      const possPattern = new RegExp(
        `${escPoss}[''\u2019]s\\s+${pattern.source}`,
        "i",
      );
      if (possPattern.test(content)) {
        const matchIdx = content.search(possPattern);
        if (matchIdx >= 0) {
          const searchWindow = content.slice(Math.max(0, matchIdx - 40), matchIdx + 80);
          if (searchWindow.toLowerCase().includes(other.toLowerCase())) {
            const nounMatch = content.match(possPattern);
            const relNoun = nounMatch ? nounMatch[0].split(/[''\u2019]s\s+/)[1] : type;
            results.push({
              source: other,   // Other IS Possessor's [relation]
              target: possessor,
              type,
              label: relNoun?.toLowerCase() || type,
              sentiment,
              confidence: 0.7,
            });
          }
        }
      }

      // "[relation] of Possessor" near Other
      const ofPattern = new RegExp(
        `\\b${pattern.source}\\s+of\\s+${escPoss}`,
        "i",
      );
      if (ofPattern.test(content)) {
        const matchIdx = content.search(ofPattern);
        if (matchIdx >= 0) {
          const searchWindow = content.slice(Math.max(0, matchIdx - 40), matchIdx + 80);
          if (searchWindow.toLowerCase().includes(other.toLowerCase())) {
            results.push({
              source: other,
              target: possessor,
              type,
              label: type,
              sentiment,
              confidence: 0.65,
            });
          }
        }
      }
    }
  }

  return results;
}

function detectCoordinatedAction(
  name1: string,
  name2: string,
  content: string,
): HeuristicRelationship | null {
  const esc1 = name1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const esc2 = name2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // "Name1 and Name2 [verb] together" / "Name1 and Name2 fought side by side"
  const togetherPattern = new RegExp(
    `${esc1}\\s+and\\s+${esc2}\\s+\\w+(?:\\s+\\w+){0,3}\\s*(?:together|side by side|in unison|as one)`,
    "i",
  );
  if (togetherPattern.test(content)) {
    return {
      source: name1, target: name2,
      type: "ally", label: "fight together", sentiment: 0.5, confidence: 0.65,
    };
  }

  // "Name1 and Name2" + cooperative verb nearby
  const coordPattern = new RegExp(`${esc1}\\s+and\\s+${esc2}`, "i");
  if (coordPattern.test(content)) {
    const matchIdx = content.search(coordPattern);
    const window = content.slice(matchIdx, matchIdx + 120);
    if (/\b(fought|traveled|escaped|worked|planned|agreed|decided|ran|fled|hid|searched|explored)\b/i.test(window)) {
      return {
        source: name1, target: name2,
        type: "ally", label: "coordinated action", sentiment: 0.3, confidence: 0.5,
      };
    }
  }

  return null;
}

/** Indicators that an endearment is being used mockingly/sarcastically */
const MOCKING_CONTEXT = /\b(mock(?:ing|ingly)?|sarcas(?:m|tic(?:ally)?)|dryly?|contempt(?:uous(?:ly)?)?|sneer(?:ed|ing)?|taunt(?:ed|ing)?|cruel(?:ly)?|cold(?:ly)?|venom(?:ous)?|bitter(?:ly)?|hiss(?:ed)?|spat)\b/i;

function detectTermsOfAddress(
  speaker: string,
  target: string,
  content: string,
): HeuristicRelationship | null {
  const spkEsc = speaker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tgtEsc = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Speaker says endearment — tight scoping to prevent false positives.
  // Only matches if target appears within 100 chars FORWARD of the
  // dialogue+speaker attribution (no backward scan).
  const speakerDialogue = new RegExp(
    `[""\u201C][^""\u201D]*${ENDEARMENT_TERMS.source}[^""\u201D]*[""\u201D][^.]{0,15}${spkEsc}`,
    "i",
  );
  if (speakerDialogue.test(content)) {
    const matchIdx = content.search(speakerDialogue);
    const match = content.match(speakerDialogue);
    const matchEnd = matchIdx + (match?.[0]?.length || 0);

    // Forward-only window: from dialogue start to 80 chars past the speaker name
    const window = content.slice(matchIdx, Math.min(content.length, matchEnd + 80));

    // If the speaker has a specific addressee ("said to Pul", "told Pul"),
    // only that entity qualifies as target — prevents leaking to nearby entities.
    // If the speaker has a specific addressee ("said to Pul", "called at Kael"),
    // only that entity qualifies as target.
    const specificAddressee = window.match(
      new RegExp(`${spkEsc}\\s+(?:said|told|whispered|called|murmured|spoke)\\s+(?:\\w+\\s+){0,3}(?:to|at)\\s+(\\w+)`, "i"),
    );
    if (specificAddressee) {
      if (specificAddressee[1].toLowerCase() !== target.split(/\s+/)[0].toLowerCase()) return null;
    }

    if (window.toLowerCase().includes(target.toLowerCase())) {
      const isMocking = MOCKING_CONTEXT.test(window);
      return {
        source: speaker, target,
        type: isMocking ? "enemy" : "lover",
        label: isMocking ? "mocking endearment" : "endearment",
        sentiment: isMocking ? -0.4 : 0.6,
        confidence: 0.5,
      };
    }
  }

  // Speaker says hostility near target — same tight forward-only scoping
  const hostileDialogue = new RegExp(
    `[""\u201C][^""\u201D]*${HOSTILITY_TERMS.source}[^""\u201D]*[""\u201D][^.]{0,15}${spkEsc}`,
    "i",
  );
  if (hostileDialogue.test(content)) {
    const matchIdx = content.search(hostileDialogue);
    const match = content.match(hostileDialogue);
    const matchEnd = matchIdx + (match?.[0]?.length || 0);

    const window = content.slice(matchIdx, Math.min(content.length, matchEnd + 80));

    // Same specific-addressee check for hostility
    const specificAddressee = window.match(
      new RegExp(`${spkEsc}\\s+(?:shouted|snarled|yelled|screamed|spat|hissed|snapped)\\s+(?:at\\s+)?(\\w+)`, "i"),
    );
    if (specificAddressee) {
      if (specificAddressee[1].toLowerCase() !== target.split(/\s+/)[0].toLowerCase()) return null;
    }

    if (window.toLowerCase().includes(target.toLowerCase())) {
      return {
        source: speaker, target,
        type: "enemy", label: "hostile address", sentiment: -0.5, confidence: 0.45,
      };
    }
  }

  return null;
}

/** Detect physical proximity and shared-space patterns between two entities */
function detectPhysicalProximity(
  name1: string,
  name2: string,
  content: string,
): HeuristicRelationship | null {
  const esc1 = name1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const esc2 = name2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // "Name1 ... beside/next to/near ... Name2" (within 80 chars)
  const proximityPattern = new RegExp(
    `${esc1}.{0,60}\\b(?:beside|next\\s+to|near|across\\s+from|facing|opposite|behind|alongside)\\b.{0,20}${esc2}`,
    "i",
  );
  if (proximityPattern.test(content)) {
    // Check if the proximity context has positive or negative tone
    const matchIdx = content.search(proximityPattern);
    const window = content.slice(matchIdx, matchIdx + 150);
    const hasPositive = /\b(smile|laugh|warm|gentle|soft|comfort|peace|quiet|calm)\b/i.test(window);
    const hasNegative = /\b(tense|glare|cold|hostile|anger|avoid|wary|stiff)\b/i.test(window);

    return {
      source: name1, target: name2,
      type: hasNegative ? "rival" : "ally",
      label: "proximity",
      sentiment: hasNegative ? -0.2 : hasPositive ? 0.3 : 0.1,
      confidence: 0.35,
    };
  }

  // Both names in a dialogue exchange (one speaks, other responds within 200 chars)
  const dialogueExchange = new RegExp(
    `[""\u201C][^""\u201D]+[""\u201D][^""\u201C]{0,60}${esc1}.{0,120}[""\u201C][^""\u201D]+[""\u201D][^""\u201C]{0,60}${esc2}`,
    "i",
  );
  const reverseExchange = new RegExp(
    `[""\u201C][^""\u201D]+[""\u201D][^""\u201C]{0,60}${esc2}.{0,120}[""\u201C][^""\u201D]+[""\u201D][^""\u201C]{0,60}${esc1}`,
    "i",
  );
  if (dialogueExchange.test(content) || reverseExchange.test(content)) {
    return {
      source: name1, target: name2,
      type: "custom",
      label: "conversation",
      sentiment: 0.1,
      confidence: 0.3,
    };
  }

  return null;
}

function inferFromEmotionalContext(
  name1: string,
  name2: string,
  emotionalTags: EmotionalTag[],
): HeuristicRelationship | null {
  // Map emotional tags to weak relationship inferences
  const tagMap: Partial<Record<EmotionalTag, { type: RelationType; sentiment: number; label: string }>> = {
    intimacy: { type: "lover", sentiment: 0.3, label: "shared intimacy" },
    grief: { type: "ally", sentiment: 0.2, label: "shared grief" },
    tension: { type: "rival", sentiment: -0.2, label: "tension" },
    betrayal: { type: "enemy", sentiment: -0.4, label: "betrayal context" },
    joy: { type: "ally", sentiment: 0.2, label: "shared joy" },
    fury: { type: "rival", sentiment: -0.3, label: "anger context" },
  };

  for (const tag of emotionalTags) {
    const inference = tagMap[tag];
    if (inference) {
      return {
        source: name1,
        target: name2,
        type: inference.type,
        label: inference.label,
        sentiment: inference.sentiment,
        confidence: 0.3, // Low — purely contextual
      };
    }
  }

  return null;
}
