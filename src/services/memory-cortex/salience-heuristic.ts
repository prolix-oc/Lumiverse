/**
 * Memory Cortex — Heuristic salience scoring.
 *
 * Zero-cost importance scoring using pattern matching. No API calls, no sidecar.
 * Runs inline during chunk ingestion to produce a 0.0–1.0 salience score
 * along with emotional tags and narrative flags.
 *
 * v2: Addresses community feedback:
 *   - Narrative density signals (dialogue between named characters, emotional verbs)
 *   - Sarcasm/negation detection to prevent false emotional tagging
 *   - Salience floor for fact-dense or lore-critical chunks
 *   - Reduced combat/action bias — quiet scenes scored more fairly
 */

import type { EmotionalTag, NarrativeFlag, SalienceResult } from "./types";

// ─── Pattern Dictionaries ──────────────────────────────────────

const INTENSITY_MARKERS = {
  punctuation: /[!?]{2,}|\.{3,}/g,
  capsWords: /\b[A-Z]{3,}\b/g,
  emphasis: /\*[^*]+\*|_[^_]+_/g,
};

const EMOTIONAL_PATTERNS: Record<EmotionalTag, RegExp[]> = {
  grief: [
    /\b(sob(?:bed|bing|s)?|cr(?:ied|ying|y)|weep(?:ing|s)?|tears?|mourn(?:ing|ed)?|loss|gone forever|dead|died|funeral|griev(?:ed|ing))\b/i,
  ],
  joy: [
    /\b(laugh(?:ed|ing|s)?|smile[ds]?|grin(?:ned|ning)?|happy|happily|celebrate[ds]?|cheer(?:ed|ing)?|delight(?:ed)?|elated|beaming)\b/i,
  ],
  tension: [
    /\b(sword|blade|fight(?:ing)?|battle|attack(?:ed|ing)?|defend(?:ed|ing)?|threat(?:en)?|danger(?:ous)?|flee(?:ing)?|clash(?:ed)?|blood)\b/i,
  ],
  dread: [
    /\b(fear(?:ed|ful)?|dread(?:ed)?|horror|terror|scream(?:ed|ing)?|dark(?:ness)?|shadow(?:s)?|creep(?:ing)?|shudder(?:ed)?|chill)\b/i,
  ],
  intimacy: [
    /\b(kiss(?:ed)?|embrace[ds]?|hold(?:ing)?\s+(?:close|tight)|touch(?:ed)?|caress(?:ed)?|love[ds]?|tender(?:ly)?|gentle|gently|warmth)\b/i,
  ],
  betrayal: [
    /\b(betray(?:ed|al)?|lied|lies|deceiv(?:ed|ing)|traitor|backstab(?:bed)?|trust.*broken|double.?cross|treacher(?:y|ous))\b/i,
  ],
  revelation: [
    /\b(reveal(?:ed|ing|s)?|secret|truth|discover(?:ed|y)?|realize[ds]?|confess(?:ed|ion)?|unveil(?:ed)?|uncover(?:ed)?|hidden)\b/i,
  ],
  resolve: [
    /\b(swear|swore|vow(?:ed)?|promise[ds]?|oath|pledge[ds]?|commit(?:ted)?|determined|resolve[ds]?|steel(?:ed)?)\b/i,
  ],
  humor: [
    /\b(joke[ds]?|funny|hilarious|chuckle[ds]?|snicker(?:ed)?|witty|prank|tease[ds]?|smirk(?:ed)?|absurd)\b/i,
  ],
  melancholy: [
    /\b(melan?chol(?:y|ic)|wistful(?:ly)?|nostalgic?|sigh(?:ed|ing)?|lonely|loneliness|ache[ds]?|bittersweet|forlorn)\b/i,
  ],
  awe: [
    /\b(awe(?:d|some|struck)?|marvel(?:ed|ous)?|wonder(?:ed|ous)?|magnificent|breathtaking|stunning|majestic|glorious)\b/i,
  ],
  fury: [
    /\b(fury|furious(?:ly)?|rage[ds]?|wrath|enraged|snarl(?:ed)?|roar(?:ed)?|seethe[ds]?|livid|incensed)\b/i,
  ],
};

const NARRATIVE_FLAG_PATTERNS: Record<NarrativeFlag, RegExp[]> = {
  first_meeting: [
    /\b(first time|never seen|who are you|introduce[ds]?|stranger|new(?:comer|arrival)|met for the first)\b/i,
  ],
  death: [
    /\b(die[ds]?|dead|death|kill(?:ed|ing|s)?|slain|perish(?:ed)?|lifeless|corpse|murder(?:ed)?|fallen)\b/i,
  ],
  promise: [
    /\b(promise[ds]?|swear|swore|vow(?:ed)?|oath|pledge[ds]?|word of honor|give.*my word)\b/i,
  ],
  confession: [
    /\b(confess(?:ed|ion)?|admit(?:ted)?|truth is|I need to tell you|secret(?:ly)?|I['']ve been hiding|come clean)\b/i,
  ],
  departure: [
    /\b(goodbye|farewell|leave[ds]?|depart(?:ed|ure)?|gone|never see.*again|parting|set off|journey)\b/i,
  ],
  transformation: [
    /\b(transform(?:ed|ation)?|changed|become|evolve[ds]?|awaken(?:ed|ing)?|power(?:s)?.*unlock|metamorphos[ie]s?)\b/i,
  ],
  battle: [
    /\b(battle|war|siege|assault|charge[ds]?|clash(?:ed)?|armies|troops|reinforcement|victory|defeat)\b/i,
  ],
  discovery: [
    /\b(discover(?:ed|y)?|found|unearth(?:ed)?|stumbl(?:ed)? upon|ancient|artifact|map|clue|treasure)\b/i,
  ],
  reunion: [
    /\b(reunion|reunite[ds]?|together again|returned|back again|long time|missed you|found (?:you|each other))\b/i,
  ],
  loss: [
    /\b(lost|lose|losing|stolen|taken|gone|vanish(?:ed)?|disappear(?:ed)?|ruin(?:ed)?|destroy(?:ed)?)\b/i,
  ],
};

// ─── Sarcasm & Negation Detection ──────────────────────────────

/** Words that negate the emotional meaning of nearby keywords */
const NEGATION_WORDS = /\b(not|n't|never|hardly|barely|scarcely|no|neither|nor|without)\b/i;

/** Patterns suggesting sarcasm or irony */
const SARCASM_INDICATORS = [
  /\b(oh\s+how\s+\w+|oh\s+great|oh\s+wonderful|oh\s+joy|how\s+delightful|what\s+a\s+surprise)\b/i,
  /\b[A-Z]{4,}\b.*\b(obviously|clearly|definitely|totally|absolutely|surely)\b/i, // "WONDERFUL, obviously"
  /[""\u201C][^""\u201D]*\b(wonderful|great|fantastic|amazing|thrilled|delighted|lovely|perfect|terrific)\b[^""\u201D]*[""\u201D]/i, // Emotional words IN dialogue are often sarcastic
];

/**
 * Check if an emotional keyword match is likely negated or sarcastic.
 * Returns true if the match should be discounted.
 */
function isNegatedOrSarcastic(keyword: string, content: string): boolean {
  // Check for negation within 5 words before the keyword
  const idx = content.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx === -1) return false;

  const prefixStart = Math.max(0, idx - 50);
  const prefix = content.slice(prefixStart, idx);

  // Negation check: "not happy", "wasn't thrilled", "hardly wonderful"
  if (NEGATION_WORDS.test(prefix)) return true;

  // Check for sarcasm indicators in the surrounding sentence
  const sentenceStart = Math.max(0, content.lastIndexOf(".", idx - 1) + 1);
  const sentenceEnd = content.indexOf(".", idx);
  const sentence = content.slice(sentenceStart, sentenceEnd > idx ? sentenceEnd : idx + 60);

  if (SARCASM_INDICATORS.some((p) => p.test(sentence))) return true;

  // ALL-CAPS emotional words in dialogue are often sarcastic: "SO thrilled"
  const capsPrefix = content.slice(Math.max(0, idx - 20), idx);
  if (/\b[A-Z]{2,}\s*$/.test(capsPrefix)) return true;

  return false;
}

// ─── Narrative Density Signals ─────────────────────────────────
// These detect "quiet" scenes that are important despite lacking loud keywords

/** Verbs indicating internal experience — the markers of character-driven writing */
const INTERNAL_EXPERIENCE_VERBS = /\b(felt|realized|understood|decided|wondered|remembered|recognized|noticed|sensed|knew|believed|wished|regretted|considered|pondered|chose|accepted|acknowledged|feared)\b/i;

/** Scene transitions and atmospheric setting — markers of intentional scene craft */
const SCENE_CRAFT_MARKERS = /\b(silence|quietly|slowly|pause[ds]?|hesitat(?:ed|ion|ing)|moment|long\s+(?:pause|silence|moment)|without\s+(?:a\s+)?word|looked\s+away|turned\s+away|didn['']t\s+(?:look|speak|say|respond|answer|reply))\b/i;

/** Dialogue that carries weight through its structure, not its keywords */
const WEIGHTED_DIALOGUE_PATTERNS = [
  /[""\u201C][^""\u201D]{1,30}[""\u201D]\s*(?:,?\s*(?:she|he|they)\s+(?:said|whispered|murmured)\s+(?:softly|quietly|finally|at\s+last))/i, // Short, weighted dialogue
  /(?:didn['']t\s+(?:say\s+anything|respond|answer|reply)|said\s+nothing|remained\s+silent|the\s+silence\s+(?:stretched|grew|hung|between))/i, // Meaningful silence
  /[""\u201C]\.{3}[""\u201D]/i, // Trailing off in dialogue: "..."
];

/** Lore-density markers: content that establishes world facts */
const LORE_DENSITY_MARKERS = [
  /\b(according to|the (?:law|rule|custom|tradition|prophecy|legend) (?:of|says|states))\b/i,
  /\b(alliance|treaty|agreement|pact|contract|decree|edict)\s+(?:between|with|of)\b/i,
  /\b((?:was|is|has been)\s+(?:known as|called|named|titled))\b/i,
  /\b(heir|successor|predecessor|ancestor|lineage|bloodline|dynasty)\b/i,
];

// ─── Scoring Engine ────────────────────────────────────────────

/**
 * Score a chunk of narrative text using heuristic pattern matching.
 * Returns a 0.0–1.0 score plus emotional/narrative metadata.
 */
export function scoreChunkHeuristic(content: string): SalienceResult {
  const words = content.split(/\s+/);
  const wordCount = words.length;

  let score = 0;

  // Base score from length (longer = more likely important, diminishing returns)
  score += Math.min(0.15, wordCount / 800);

  // ── Dialogue density ──
  const dialogueMatches = content.match(/[""\u201C][^""\u201D]+[""\u201D]|[「][^」]+[」]/g) || [];
  const hasDialogue = dialogueMatches.length > 0;
  if (hasDialogue) {
    score += 0.06 * Math.min(1, dialogueMatches.length / 4);
  }

  // ── Action/narration markers ──
  const actionMarkers = content.match(/\*[^*]{10,}\*/g) || [];
  const hasAction = actionMarkers.length > 0;
  if (hasAction) score += 0.04;

  // ── Internal thought markers (expanded) ──
  const hasInternalThought = INTERNAL_EXPERIENCE_VERBS.test(content);
  if (hasInternalThought) score += 0.06; // Boosted from 0.04 — quiet introspection matters

  // ── Narrative density: scene craft and subtlety ──
  // These signals detect well-crafted quiet scenes that lack dramatic keywords
  const hasSceneCraft = SCENE_CRAFT_MARKERS.test(content);
  if (hasSceneCraft) score += 0.06;

  const weightedDialogueCount = WEIGHTED_DIALOGUE_PATTERNS.filter((p) => p.test(content)).length;
  if (weightedDialogueCount > 0) score += 0.05 * Math.min(1, weightedDialogueCount);

  // ── Lore density: world-building and political content ──
  const loreDensityCount = LORE_DENSITY_MARKERS.filter((p) => p.test(content)).length;
  if (loreDensityCount > 0) score += 0.06 * Math.min(1, loreDensityCount);

  // ── Intensity markers (reduced weight vs. v1 — less combat bias) ──
  const intensityScore =
    ((content.match(INTENSITY_MARKERS.punctuation) || []).length) * 0.015 +
    ((content.match(INTENSITY_MARKERS.capsWords) || []).length) * 0.01 +
    ((content.match(INTENSITY_MARKERS.emphasis) || []).length) * 0.01;
  score += Math.min(0.10, intensityScore); // Capped lower than v1

  // ── Emotional tags with sarcasm/negation filtering ──
  const emotionalTags: EmotionalTag[] = [];
  for (const [tag, patterns] of Object.entries(EMOTIONAL_PATTERNS)) {
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        // Check if this specific match is negated or sarcastic
        const keyword = match[1] || match[0];
        if (!isNegatedOrSarcastic(keyword, content)) {
          emotionalTags.push(tag as EmotionalTag);
          score += 0.04; // Slightly reduced per-tag weight
        }
        break;
      }
    }
  }

  // ── Narrative flags ──
  const narrativeFlags: NarrativeFlag[] = [];
  for (const [flag, patterns] of Object.entries(NARRATIVE_FLAG_PATTERNS)) {
    if (patterns.some((p) => p.test(content))) {
      narrativeFlags.push(flag as NarrativeFlag);
      score += 0.06; // Slightly reduced from 0.07
    }
  }

  // ── Complexity bonuses ──
  // Multiple emotional signals indicate a complex, layered scene
  if (emotionalTags.length >= 3) score += 0.08;
  if (narrativeFlags.length >= 2) score += 0.06;

  // Mixed dialogue + introspection = character development (high value)
  if (hasDialogue && hasInternalThought) score += 0.05;
  // Scene craft + dialogue = deliberate, weighted scene
  if (hasSceneCraft && hasDialogue) score += 0.04;

  return {
    score: Math.min(1.0, score),
    source: "heuristic",
    emotionalTags,
    statusChanges: [],
    narrativeFlags,
    hasDialogue,
    hasAction,
    hasInternalThought,
    wordCount,
  };
}

/**
 * Detect the dominant emotional tones in a text snippet.
 * Used at query time to build the emotional context for associative recall.
 * Includes sarcasm filtering.
 */
export function detectEmotionalTags(content: string): EmotionalTag[] {
  const tags: EmotionalTag[] = [];
  for (const [tag, patterns] of Object.entries(EMOTIONAL_PATTERNS)) {
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        const keyword = match[1] || match[0];
        if (!isNegatedOrSarcastic(keyword, content)) {
          tags.push(tag as EmotionalTag);
        }
        break;
      }
    }
  }
  return tags;
}
