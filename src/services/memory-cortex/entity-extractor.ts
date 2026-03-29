/**
 * Memory Cortex — Heuristic entity extraction.
 *
 * Tier 1: No sidecar needed. Combines:
 *   1. Known character name matching (from chat participants)
 *   2. Existing entity graph alias matching
 *   3. Capitalized proper noun detection (NER-lite)
 *   4. Contextual type inference from surrounding text
 *
 * Sidecar extraction (Tier 2) is handled in salience-sidecar.ts which returns
 * entities as part of its structured extraction — that data flows into the
 * entity graph via the ingestion pipeline in index.ts.
 */

import type { EntityType, ExtractedEntity, MentionRole, MemoryEntity } from "./types";

// ─── Common Words Filter ───────────────────────────────────────
// Words that appear capitalized at sentence starts but aren't entities

const COMMON_WORDS = new Set([
  "the", "and", "but", "for", "not", "you", "all", "can", "her", "was",
  "one", "our", "out", "are", "has", "his", "how", "its", "may", "new",
  "now", "old", "see", "way", "who", "did", "got", "let", "say", "she",
  "too", "use", "just", "then", "than", "them", "been", "have", "many",
  "some", "time", "very", "when", "come", "could", "make", "like", "back",
  "only", "long", "much", "after", "also", "made", "well", "before",
  "should", "still", "great", "while", "never", "where", "might",
  "every", "under", "night", "right", "place", "think", "again",
  "small", "found", "those", "between", "thought", "looked", "seemed",
  "would", "there", "their", "about", "which", "could", "other", "first",
  "being", "hand", "hands", "eyes", "head", "face", "voice", "words",
  "here", "with", "what", "this", "that", "from", "will", "more", "been",
  "said", "each", "tell", "does", "three", "want", "into", "year",
  "your", "them", "know", "take", "people", "into", "over", "such",
  "look", "world", "still", "last", "point", "feel", "high", "left",
  "name", "good", "gave", "most", "away", "another", "need", "house",
  "both", "nothing", "something", "everything", "anything", "everyone",
  "someone", "because", "through", "though", "really", "always",
]);

// ─── Type Inference ────────────────────────────────────────────

// ─── Character Detection (Direct Adjacency Only) ──────────────
// Character verbs appear EVERYWHERE in roleplay prose. A 200-char window
// around any name will almost certainly contain "walked", "looked", etc.
// So we ONLY use direct name-verb adjacency — never broad window scanning.

const CHARACTER_VERB_SRC = "said|spoke|whispered|laughed|nodded|walked|stood|sat|ran|looked|smiled|frowned|sighed|cried|shouted|muttered|replied|asked|answered|gazed|glanced|stared|turned|shook|shrugged|grinned|scoffed|snapped|murmured|breathed|called|growled|hissed|chuckled|exclaimed|demanded|continued|paused|hesitated|blinked|waved|leaned|knelt|bowed|shifted|shivered|winced|squinted|tilted|crossed|uncrossed|straightened";

/**
 * Check if a name is directly associated with a character verb or interaction.
 * Uses strict adjacency — not broad window proximity.
 */
/** Personal nouns that follow a character's possessive: "Name's eyes/voice/hand" */
const CHAR_POSSESSIVE_NOUNS = /\b(eyes?|ears?|voice|hands?|fingers?|arms?|legs?|feet|face|lips?|mouth|teeth|jaw|brow|hair|head|shoulder|chest|back|heart|gaze|smile|grin|frown|expression|tone|breath|words?|thoughts?|mind|soul|body|stance|posture|shadow|silhouette|reflection|name|attention)\b/i;

function hasCharacterSignal(name: string, content: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // 1. Name followed by verb — BUT guard against prepositional attachment.
  //    "Milena said" ✓, "from Sixth Street shifted" ✗ (verb belongs to earlier subject)
  //    Check: if a preposition immediately precedes the name, the verb isn't the name's.
  const nameVerbMatch = new RegExp(`(?:^|[^a-z])(\\w*)\\s+${escaped}\\s+(${CHARACTER_VERB_SRC})\\b`, "i").exec(content);
  if (nameVerbMatch) {
    const wordBefore = (nameVerbMatch[1] || "").toLowerCase();
    const PREPOSITIONS = new Set(["from", "in", "at", "to", "toward", "through", "across", "near", "by", "of", "into", "onto", "within", "beyond", "outside", "inside", "between", "around", "along", "past", "over", "under", "above", "below"]);
    if (!PREPOSITIONS.has(wordBefore)) return true;
  }

  // 2. Verb followed by name: "said Milena", "whispered Piper"
  if (new RegExp(`\\b(?:${CHARACTER_VERB_SRC})\\s+${escaped}`, "i").test(content)) return true;

  // 3. Possessive form — ONLY with personal/body nouns, not architectural ones.
  //    "Melina's eyes" ✓ (character), "New Eridu's spires" ✗ (location)
  const possMatch = new RegExp(`${escaped}[''\u2019]s\\s+(\\w+)`, "i").exec(content);
  if (possMatch) {
    const wordAfter = possMatch[1].toLowerCase();
    // a) Personal/body noun: "Melina's eyes"
    if (CHAR_POSSESSIVE_NOUNS.test(wordAfter)) return true;
    // b) Contraction: "Melina's had" (= Melina has had), "Melina's been", "Melina's gone"
    //    These are character actions disguised as possessives
    if (/^(had|been|gone|got|gotten|done|always|never|already|just|still|not|being|going|coming|trying|looking|getting|making|having|taking|running|sitting|standing|waiting|sleeping)$/i.test(wordAfter)) return true;
  }

  // 3b. Comparative possessive: "harder than Melina's had" — Name's in comparison = character
  if (new RegExp(`(?:than|like|as)\\s+${escaped}[''\u2019]s`, "i").test(content)) return true;

  // 4. Interaction prepositions: "talk to [Name]", "ask [Name]", "tell [Name]"
  if (new RegExp(`\\b(?:talk|speak|spoke|listen)(?:s|ed|ing)?\\s+to\\s+${escaped}\\b`, "i").test(content)) return true;
  if (new RegExp(`\\b(?:ask|tell|told|show|gave|give|handed|thank|thanked|greet|greeted|hugged|kissed|punched|grabbed|helped)(?:s|ed|ing)?\\s+${escaped}\\b`, "i").test(content)) return true;

  // 5. "Name and I" / "Name and [pronoun]" — coordinated agents
  if (new RegExp(`${escaped}\\s+and\\s+(?:I|me|we|he|she|they)\\b`, "i").test(content)) return true;

  // 6. "care of Name" / "waiting for Name" — object of concern
  if (new RegExp(`\\b(?:care of|waiting for|looking for|worried about|afraid of)\\s+${escaped}\\b`, "i").test(content)) return true;

  // 6b. Identity statements: "his name is Prolix", "I'm Prolix", "they call me Prolix"
  //     Unambiguous character signal — someone IS this name.
  if (new RegExp(`\\bname\\s+is\\s+${escaped}\\b`, "i").test(content)) return true;
  if (new RegExp(`\\b(?:I'm|I am|they call me|known as|called)\\s+${escaped}\\b`, "i").test(content)) return true;
  if (new RegExp(`\\byes\\s+(?:THAT|that)\\s+${escaped}\\b`, "i").test(content)) return true;

  // 7. Vocative address — TIGHT patterns only:
  //    a) Comma-name-comma isolation: ", Caesar, " (classic vocative)
  //    b) Quote-start vocative: '"Caesar, she's' (name at start of dialogue after quote)
  //    c) Sentence-start vocative: ". Caesar, she's" (name at start of new sentence)
  //    NOT: "Canal District, and" (location mid-sentence in dialogue)
  const vocativeFollowers = "(?:she|he|they|it|I|we|you|what|where|how|why|do|don|please|listen|look|stop|wait|help|come|go|run|tell|no|yes)";
  // Comma-name-comma: ", Caesar, I told you"
  if (new RegExp(`,\\s*${escaped}\\s*,`, "i").test(content)) return true;
  // Quote-start: '"Caesar, she's' — name within first 30 chars of a quote, followed by pronoun/verb
  if (new RegExp(`[""\u201C]\\s*${escaped}\\s*,\\s*${vocativeFollowers}`, "i").test(content)) return true;
  // After sentence end + name + comma + pronoun: ". Caesar, she's"
  if (new RegExp(`[.!?]\\s+${escaped}\\s*,\\s*${vocativeFollowers}`, "i").test(content)) return true;

  return false;
}

// ─── Location Detection (Suffix + Phrase Based) ────────────────
// Locations are identified by:
//   1. Name contains a location suffix: "Sixth Street", "Janus Quarter", "Dustwell flats"
//   2. Locative construction around the name: "here in X", "across the X", "life in X"

const LOCATION_SUFFIXES = /\b(street|avenue|road|lane|boulevard|highway|drive|way|alley|path|trail|plaza|square|quarter|district|ward|precinct|sector|zone|block|harbor|port|bridge|gate|tower|peak|mount|mountain|valley|plains?|flats?|heights?|hills?|ridge|creek|river|lake|bay|coast|shore|marsh|woods?|grove|fields?|garden|park|station|terminal|market|bazaar|crossing|junction|pass|gorge|cavern|hollow|den|burrow|outpost|settlement|enclave|citadel|fortress|keep|spire)\b/i;

const LOCATION_PLACE_NOUNS = /\b(city|town|village|forest|mountain|castle|tavern|inn|kingdom|realm|dungeon|cave|tower|temple|shrine|port|harbor|island|continent|district|ruins|province|territory|region|country|empire|republic|settlement|colony|camp|base|headquarters|warehouse|factory|clinic|hospital|academy|school|prison|arena|colosseum|cathedral|monastery|library)\b/i;

/**
 * Check if a name itself contains or is followed by a location suffix.
 * "Sixth Street" → true. "Dustwell flats" → true. "Janus Quarter" → true.
 */
function hasLocationSuffix(name: string, content: string): boolean {
  // Check the name itself
  if (LOCATION_SUFFIXES.test(name)) return true;

  // Check if the word immediately after the name is a location suffix
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`${escaped}\\s+${LOCATION_SUFFIXES.source}`, "i").test(content)) return true;

  return false;
}

/**
 * Check for locative phrase constructions around the name.
 * "here in New Eridu" → true. "across the Dustwell flats" → true.
 * "arrived at Thornhaven" → true. "back in the Pale" → true.
 */
function hasLocationPhrase(name: string, content: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Locative constructions: "here in X", "back in X", "life in X", "live in X"
  if (new RegExp(`\\b(?:here|there|back|life|live[ds]?|born|raised|grew up)\\s+(?:in|at)\\s+(?:the\\s+)?${escaped}`, "i").test(content)) return true;

  // Movement to/from location: "arrived at X", "traveled to X", "left X", "fled X"
  if (new RegExp(`\\b(?:arrived?|traveled?|journey(?:ed)?|headed|went|go(?:ing)?|return(?:ed)?|fled|left|departed|sailed|flew|drove|walked)\\s+(?:to|from|toward|into|through|across|for)\\s+(?:the\\s+)?${escaped}`, "i").test(content)) return true;

  // Directional: "across the X", "through the X", "beyond the X"
  if (new RegExp(`\\b(?:across|through|beyond|outside|inside|beneath|above|around)\\s+(?:the\\s+)?${escaped}`, "i").test(content)) return true;

  // "the streets/walls/gates of X" — part-of-location construction
  if (new RegExp(`\\b(?:streets?|walls?|gates?|outskirts|edge|heart|center|depths?|borders?|lights?|spires?|skyline|rooftops?|towers?|buildings?)\\s+of\\s+(?:the\\s+)?${escaped}`, "i").test(content)) return true;

  // Possessive + architectural/geographic noun: "New Eridu's spires", "Ashenmere's walls"
  if (new RegExp(`${escaped}[''\u2019]s\\s+(?:central\\s+)?(?:streets?|walls?|gates?|spires?|skyline|towers?|rooftops?|district|quarter|outskirts|borders?|docks?|harbor|port|market|square|plaza|bridge|cathedral|palace|keep|lights?|buildings?|slums?|alleys?|sewers?)`, "i").test(content)) return true;

  return false;
}

// ─── Faction/Org Detection ─────────────────────────────────────

const FACTION_NOUNS = /\b(guild|order|clan|army|church|council|brotherhood|faction|legion|alliance|empire|republic|syndicate|sect|cult|house|dynasty|tribe|fellowship|corporation|company|agency|bureau|department|division|force|squad|unit|organization|group|collective|cartel|network)\b/i;

/** Collective prefixes that indicate a faction: "Sons of X", "Knights of X" */
const FACTION_PREFIX = /\b(sons?|daughters?|brothers?|sisters?|children|knights?|lords?|order|house|clan|guild|brotherhood|sisterhood|followers?|servants?|heirs?)\s+of\b/i;

/** Business/company suffixes: "X Housekeeping", "X Industries", "X Security" */
const BUSINESS_SUFFIXES = /\b(housekeeping|industries|incorporated|inc|corp|corporation|ltd|llc|security|sec|logistics|solutions|services|enterprises|systems|technologies|tech|tek|labs?|group|holdings|partners|associates|consulting|productions?|studios?|works|foundry|forge|agency|express|transport|co|med|ops|dynamics|robotics|pharma|bio)\b/i;

/**
 * Check for faction/organization signals.
 */
function hasFactionSignal(name: string, content: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Name contains a faction noun directly
  if (FACTION_NOUNS.test(name)) return true;

  // Name has a business/company suffix: "Victoria Housekeeping", "Apex Security"
  if (BUSINESS_SUFFIXES.test(name)) return true;

  // CamelCase component check: \b boundaries don't fire inside CamelCase words.
  // "PubSec" → split into ["Pub", "Sec"] → test "Sec" against suffixes without \b
  const camelParts = name.match(/[A-Z][a-z]*/g);
  if (camelParts && camelParts.length >= 2) {
    const lastPart = camelParts[camelParts.length - 1].toLowerCase();
    if (/^(housekeeping|industries|inc|corp|corporation|security|sec|logistics|solutions|services|tech|tek|labs?|ops|med|dynamics|robotics|pharma|bio|works|forge|net|link|sys|soft|ware|guard|watch|corps|force)$/.test(lastPart)) return true;
  }

  // Collective prefix IN the name: "Sons of Calydon", "Knights of the Rose"
  if (FACTION_PREFIX.test(name)) return true;

  // Collective prefix BEFORE the captured name: "Sons of [Calydon]"
  // The name itself is "Calydon" but it was captured after "Sons of"
  if (new RegExp(`${FACTION_PREFIX.source}\\s+(?:the\\s+)?${escaped}`, "i").test(content)) return true;

  // Institutional reference: "friends at X", "contact in X", "works for X"
  if (new RegExp(`\\b(?:friends?|contacts?|people|agents?|officers?|members?|works?|worked|employed)\\s+(?:at|in|from|with|for)\\s+(?:the\\s+)?${escaped}`, "i").test(content)) return true;

  // "X agent/officer/member/roster/personnel"
  if (new RegExp(`${escaped}\\s+(?:agent|officer|member|operative|enforcer|soldier|guard|patrol|roster|personnel|employee|staff)`, "i").test(content)) return true;

  // "X van/truck/vehicle" — organizational vehicle (not the entity itself)
  if (new RegExp(`${escaped}\\s+(?:van|truck|vehicle|car|cruiser|ship|vessel)\\b`, "i").test(content)) return true;

  return false;
}

// ─── Character Title Detection ─────────────────────────────────

/** Titles/roles that when capitalized indicate a specific character */
const CHARACTER_TITLES = /^(the\s+)?(Mayor|Captain|General|Admiral|Commander|Lieutenant|Sergeant|Doctor|Professor|Chancellor|Governor|Senator|President|Director|Chief|Sheriff|Marshal|Inspector|Detective|Judge|Priest|Bishop|Pope|King|Queen|Prince|Princess|Emperor|Empress|Duke|Duchess|Baron|Count|Countess|Lord|Lady|Sir|Dame|Elder|Warden|Keeper|Master|Mistress)\b/i;

/**
 * Check if a name is a capitalized title used as a character reference.
 * "the Mayor" → character. "the Captain" → character.
 */
function isTitledCharacter(name: string): boolean {
  return CHARACTER_TITLES.test(name);
}

// ─── Item/Vehicle Detection ────────────────────────────────────

const ITEM_NOUNS = /\b(sword|ring|amulet|potion|book|scroll|key|artifact|weapon|armor|shield|staff|wand|gem|stone|crystal|necklace|bracelet|dagger|bow|arrow|cloak|robe|helm|crown|blade|pistol|rifle|gun|chip|drive|device|implant|serum|vial|flask|orb|pendant|token|badge|medal|relic|truck|van|car|ship|vessel|motorcycle|bike|mech|drone|bot|robot)\b/i;

/**
 * Check for item/vehicle signals: "drives the X", "wielding X", "X's engine"
 */
function hasItemSignal(name: string, content: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Vehicle verbs: "drives/rides/piloted the X"
  if (new RegExp(`\\b(?:drives?|drove|rides?|rode|pilots?|piloted|steers?|steered|boards?|boarded|aboard)\\s+(?:the\\s+)?${escaped}`, "i").test(content)) return true;

  // Weapon verbs: "wielding/drew/sheathed the X"
  if (new RegExp(`\\b(?:wielding|wielded|drew|draw|sheathed?|holstered?|fired|swung|brandished?)\\s+(?:the\\s+)?${escaped}`, "i").test(content)) return true;

  // Possessive mechanical: "X's engine/hull/blade/handle"
  if (new RegExp(`${escaped}[''\u2019]s\\s+(?:engine|hull|blade|handle|grip|barrel|trigger|hilt|deck|cockpit|wheel|controls?)`, "i").test(content)) return true;

  // Item nouns in the name
  if (ITEM_NOUNS.test(name)) return true;

  return false;
}

// ─── Event Detection ───────────────────────────────────────────

const EVENT_PATTERNS = /\b(war of|battle of|siege of|fall of|rise of|the great|the last|ceremony|ritual|festival|coronation|treaty|pact|massacre|incident|uprising|revolution|catastrophe|awakening)\b/i;

// ─── Master Type Inference ─────────────────────────────────────

/**
 * Infer entity type using a layered strategy:
 *
 *   Layer 1 — Name-specific signals (structural patterns on the name + immediate context):
 *     a) Character: verb adjacency, interaction prepositions, titled references
 *     b) Location: name suffix, locative phrases
 *     c) Faction: collective prefixes, business suffixes, institutional references
 *     d) Item: vehicle/weapon verbs, mechanical possessives
 *
 *   Layer 2 — Broad window scan (200-char context):
 *     Faction/item/event nouns and location place nouns.
 *     CHARACTER IS EXCLUDED — character verbs are too ubiquitous in prose.
 *
 *   Layer 3 — Default: "concept"
 */
function inferEntityType(name: string, context: string): EntityType {
  // Layer 1a: Character — direct verb/interaction adjacency or titled reference
  if (hasCharacterSignal(name, context)) return "character";
  if (isTitledCharacter(name)) return "character";

  // Layer 1b: Location — suffix on name or locative phrase construction
  if (hasLocationSuffix(name, context)) return "location";
  if (hasLocationPhrase(name, context)) return "location";

  // Layer 1c: Faction/org — collective prefix, business suffix, institutional reference
  if (hasFactionSignal(name, context)) return "faction";

  // Layer 1d: Item/vehicle — vehicle/weapon verbs, mechanical possessives
  if (hasItemSignal(name, context)) return "item";

  // Layer 2: Broad 200-char window for remaining types (NOT character)
  const idx = context.toLowerCase().indexOf(name.toLowerCase());
  if (idx !== -1) {
    const start = Math.max(0, idx - 200);
    const end = Math.min(context.length, idx + name.length + 200);
    const surroundings = context.slice(start, end);

    // Location place nouns in window
    if (LOCATION_PLACE_NOUNS.test(surroundings)) return "location";
    // Faction nouns in window
    if (FACTION_NOUNS.test(surroundings)) return "faction";
    // Item nouns in window — but ONLY if:
    //   - No faction signal (roster near "Sons of Calydon" shouldn't make it an item)
    //   - Name doesn't appear inside dialogue (a person being addressed ≠ an item)
    const nameInDialogue = new RegExp(`[""\u201C][^""\u201D]*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^""\u201D]*[""\u201D]`, "i").test(context);
    if (ITEM_NOUNS.test(surroundings) && !FACTION_NOUNS.test(surroundings) && !FACTION_PREFIX.test(surroundings) && !nameInDialogue) return "item";
    // Event patterns in window
    if (EVENT_PATTERNS.test(surroundings)) return "event";
  }

  return "concept";
}

/**
 * Infer mention role from how the name appears in context.
 */
function inferMentionRole(name: string, content: string): MentionRole {
  // Build a pattern that checks what follows the name
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Subject: name followed by a verb
  if (new RegExp(`${escaped}\\s+(said|spoke|walked|stood|looked|smiled|nodded|ran|turned|drew|raised|stepped|reached|held|took|placed|pulled|pushed|felt|saw|heard|knew|thought|decided|watched)`, "i").test(content)) {
    return "subject";
  }

  // Referenced: mentioned in past tense or possessive context without being present
  if (new RegExp(`(remember(?:ed)?|mention(?:ed)?|spoke of|told .* about|heard of|known as)\\s+.*${escaped}`, "i").test(content)) {
    return "referenced";
  }

  // Object: name preceded by a preposition or verb directed at them
  if (new RegExp(`(to|at|toward|for|with|against|beside|near)\\s+${escaped}`, "i").test(content)) {
    return "object";
  }

  return "present";
}

// ─── Alias Resolution (Tier 1) ────────────────────────────────
// Prevents duplicate entities from nicknames, first names, honorific titles,
// and pet names. Builds a lookup from known entities + character names.

/** Honorific/title prefixes that can wrap a known entity name */
const HONORIFIC_PREFIX_RE = /^(?:the\s+)?(?:Captain|General|Admiral|Commander|Lieutenant|Sergeant|Doctor|Professor|Chancellor|Governor|Senator|President|Director|Chief|Sheriff|Marshal|Inspector|Detective|Judge|Priest|Bishop|Pope|King|Queen|Prince|Princess|Emperor|Empress|Duke|Duchess|Baron|Baroness|Count|Countess|Lord|Lady|Sir|Dame|Elder|Warden|Keeper|Master|Mistress|Father|Mother|Brother|Sister|Uncle|Aunt|Grandma|Grandpa|Granny|Grandmother|Grandfather|Old|Young|Little|Big|Mister|Mr|Mrs|Ms|Miss|Madame|Madam)\s+/i;

/**
 * Build a lookup map: lowercase alias/variant → canonical entity name.
 * Includes:
 *   - Explicit entity aliases from the graph
 *   - Implicit first-name aliases for multi-word names ("Pulchra" → "Pulchra Fellini")
 *   - Character participant names
 */
function buildAliasLookup(
  knownEntities: MemoryEntity[],
  characterNames: string[],
): Map<string, string> {
  const map = new Map<string, string>();

  // Character names as canonical
  for (const name of characterNames) {
    if (name.length < 2) continue;
    map.set(name.toLowerCase(), name);
    // Multi-word: first word is an implicit alias (if ≥3 chars to avoid "Al" for "Al Capone")
    const parts = name.split(/\s+/);
    if (parts.length > 1 && parts[0].length >= 3 && !map.has(parts[0].toLowerCase())) {
      map.set(parts[0].toLowerCase(), name);
    }
    // Also last name as implicit alias (covers surname references)
    const lastName = parts[parts.length - 1];
    if (parts.length > 1 && lastName.length >= 3 && !map.has(lastName.toLowerCase())) {
      map.set(lastName.toLowerCase(), name);
    }
  }

  // Known graph entities: canonical + explicit aliases + implicit first/last name
  for (const entity of knownEntities) {
    map.set(entity.name.toLowerCase(), entity.name);
    for (const alias of entity.aliases) {
      map.set(alias.toLowerCase(), entity.name);
    }
    const parts = entity.name.split(/\s+/);
    if (parts.length > 1 && parts[0].length >= 3 && !map.has(parts[0].toLowerCase())) {
      map.set(parts[0].toLowerCase(), entity.name);
    }
    const lastName = parts[parts.length - 1];
    if (parts.length > 1 && lastName.length >= 3 && !map.has(lastName.toLowerCase())) {
      map.set(lastName.toLowerCase(), entity.name);
    }
  }

  return map;
}

/**
 * Try to resolve a discovered name to an existing canonical entity.
 * Returns the canonical name if the input is an alias, or null if
 * the input is already canonical / unknown.
 *
 * Checks: direct alias match, then honorific-stripped match.
 */
function resolveToCanonical(name: string, aliasLookup: Map<string, string>): string | null {
  const lower = name.toLowerCase();

  // Direct alias match (but not if it maps to itself — already canonical)
  const canonical = aliasLookup.get(lower);
  if (canonical && canonical.toLowerCase() !== lower) return canonical;

  // Honorific/title prefix strip: "Captain Melina" → "Melina" → lookup
  const stripped = name.replace(HONORIFIC_PREFIX_RE, "").trim();
  if (stripped.length >= 2 && stripped.toLowerCase() !== lower) {
    const strippedCanonical = aliasLookup.get(stripped.toLowerCase());
    if (strippedCanonical) return strippedCanonical;
  }

  return null;
}

// ─── Main Extraction ───────────────────────────────────────────

/**
 * Extract entities from a chunk of narrative text using heuristic methods.
 *
 * @param content - Sanitized chunk content
 * @param knownEntities - Existing entity graph for this chat
 * @param characterNames - Names of chat participants (character + persona)
 * @param whitelist - Custom proper nouns to never filter (e.g., "The Pale", "Binding")
 * @param minConfidence - Minimum confidence to include a new entity (default: 0.0)
 * @returns Array of extracted entities with confidence scores
 */
export function extractEntitiesHeuristic(
  content: string,
  knownEntities: MemoryEntity[],
  characterNames: string[],
  whitelist: string[] = [],
  minConfidence: number = 0,
): Array<ExtractedEntity & { mentionRole: MentionRole }> {
  // Build effective common words set (subtract whitelist entries)
  const effectiveCommon = new Set(COMMON_WORDS);
  for (const w of whitelist) {
    effectiveCommon.delete(w.toLowerCase());
  }
  const found = new Map<string, ExtractedEntity & { mentionRole: MentionRole }>();

  // Build alias → canonical name lookup for deduplication across all stages
  const aliasLookup = buildAliasLookup(knownEntities, characterNames);

  // 1. Match known character names from chat participants (highest confidence)
  for (const name of characterNames) {
    if (name.length < 2) continue;
    const key = name.toLowerCase();
    if (content.includes(name)) {
      if (!found.has(key)) {
        found.set(key, {
          name,
          type: "character",
          aliases: [],
          confidence: 1.0,
          mentionRole: inferMentionRole(name, content),
        });
      }
    } else {
      // Multi-word names: also check first name / last name as implicit alias
      // "Pulchra Fellini" not in text, but "Pulchra" is → still counts as this character
      const parts = name.split(/\s+/);
      for (const part of parts) {
        if (part.length >= 3 && content.includes(part) && !found.has(key)) {
          found.set(key, {
            name, // canonical full name
            type: "character",
            aliases: [],
            confidence: 0.85,
            mentionRole: inferMentionRole(part, content),
          });
          break;
        }
      }
    }
  }

  // 2. Match existing graph entities (canonical name + aliases)
  for (const entity of knownEntities) {
    const names = [entity.name, ...entity.aliases];
    for (const alias of names) {
      if (alias.length < 3) continue;
      if (content.toLowerCase().includes(alias.toLowerCase())) {
        const key = entity.name.toLowerCase();
        if (!found.has(key)) {
          found.set(key, {
            name: entity.name,
            type: entity.entityType,
            aliases: entity.aliases.filter((n) => n !== entity.name),
            confidence: 0.9,
            mentionRole: inferMentionRole(entity.name, content),
          });
        }
        break;
      }
    }
  }

  // 3. Capitalized proper nouns not already matched (NER-lite)
  //    Pattern: Multi-word capitalized sequences OR single capitalized words
  //    appearing 2+ times that aren't at sentence starts
  const properNounPattern = /(?<=[.!?""]\s+\S+\s+|[:;]\s*|—\s*|\n\S+\s+)[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+){0,2}/g;
  const matches: string[] = content.match(properNounPattern) ?? [];

  // ── Substring suppression set ──
  // Multi-word and CamelCase captures suppress their component words from
  // standard noun counting. "PubSec" suppresses "Pub". "Sons of Calydon" suppresses "Sons".
  const suppressedSubstrings = new Set<string>();

  // CamelCase compound words: "PubSec", "NetWatch", "CorpoZone", "SteelTusk"
  const camelCasePattern = /\b([A-Z][a-z]+(?:[A-Z][a-z]*)+)\b/g;
  const camelMatches = content.match(camelCasePattern) ?? [];
  for (const m of camelMatches) {
    const key = m.toLowerCase();
    if (!found.has(key) && !effectiveCommon.has(key)) {
      found.set(key, {
        name: m,
        type: inferEntityType(m, content),
        aliases: [],
        confidence: 0.65,
        mentionRole: inferMentionRole(m, content),
      });
      // Suppress component words: "PubSec" → suppress "Pub", "Sec"
      for (const part of m.match(/[A-Z][a-z]*/g) ?? []) {
        if (part.length >= 2) suppressedSubstrings.add(part.toLowerCase());
      }
    }
  }

  // Multi-word proper nouns with "New/Old/Fort/Mount/Saint/San" prefix
  const prefixedPlacePattern = /\b((?:New|Old|Fort|Mount|Saint|San|Port|East|West|North|South|Upper|Lower|Greater|Lesser|Grand)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g;
  const prefixedMatches = content.match(prefixedPlacePattern) ?? [];
  for (const m of prefixedMatches) {
    const key = m.toLowerCase();
    if (!found.has(key) && !effectiveCommon.has(key)) {
      found.set(key, {
        name: m,
        type: inferEntityType(m, content),
        aliases: [],
        confidence: 0.65,
        mentionRole: "present",
      });
      // Suppress component words: "New Eridu" → suppress "Eridu"
      for (const word of m.split(/\s+/)) {
        if (word.length >= 3 && /^[A-Z]/.test(word)) suppressedSubstrings.add(word.toLowerCase());
      }
    }
  }

  // Collective group names: "Sons of Calydon", "Knights of the Rose"
  const collectivePattern = /\b((?:Sons?|Daughters?|Brothers?|Sisters?|Children|Knights?|Lords?|Order|House|Clan|Guild|Brotherhood|Sisterhood|Followers?|Servants?|Heirs?)\s+of\s+(?:the\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g;
  const collectiveMatches = content.match(collectivePattern) ?? [];
  for (const m of collectiveMatches) {
    const key = m.toLowerCase();
    if (!found.has(key)) {
      found.set(key, {
        name: m,
        type: "faction",
        aliases: [],
        confidence: 0.8,
        mentionRole: "present",
      });
      // Suppress all capitalized component words
      for (const word of m.split(/\s+/)) {
        if (/^[A-Z]/.test(word) && word.toLowerCase() !== "of" && word.toLowerCase() !== "the") {
          suppressedSubstrings.add(word.toLowerCase());
        }
      }
    }
  }

  // Also catch capitalized words in dialogue attribution
  const dialogueNames = content.match(/[""\u201C][^""\u201D]*[""\u201D]\s*(?:said|replied|whispered|murmured|asked|exclaimed|shouted)\s+([A-Z][a-z]+)/g) ?? [];
  for (const match of dialogueNames) {
    const name = match.match(/([A-Z][a-z]+)\s*$/)?.[1];
    if (name) matches.push(name);
  }

  // ── Adjective filter ──
  // Capitalized words directly before common physical/descriptive nouns are
  // likely adjectives, not entities: "Sandy fur", "Golden hair", "Dark eyes"
  const ADJECTIVE_FOLLOWERS = /\b(fur|hair|skin|eyes?|face|cloth|cloak|mane|pelt|scales?|feathers?|wings?|tail|ears?|nose|lips?|teeth|claws?|paws?|muzzle|coat|hide|wool|beard|brow|lashes|complexion)\b/i;

  // Count occurrences of standard proper nouns
  const nounCounts = new Map<string, number>();
  for (const noun of matches) {
    const normalized = noun.trim();
    const key = normalized.toLowerCase();
    // Skip if already found, common word, suppressed by multi-word capture, or adjective usage
    if (found.has(key) || effectiveCommon.has(key) || suppressedSubstrings.has(key)) continue;
    // Adjective check: "Sandy fur" — word followed by physical noun
    const afterNoun = content.slice(content.indexOf(normalized) + normalized.length).match(/^\s+(\w+)/);
    if (afterNoun && ADJECTIVE_FOLLOWERS.test(afterNoun[1])) continue;
    nounCounts.set(normalized, (nounCounts.get(normalized) || 0) + 1);
  }

  // Require 2+ occurrences for STANDARD proper nouns
  for (const [noun, count] of nounCounts) {
    if (count >= 2) {
      const key = noun.toLowerCase();
      if (!found.has(key)) {
        found.set(key, {
          name: noun,
          type: inferEntityType(noun, content),
          aliases: [],
          confidence: 0.4 + Math.min(0.4, count * 0.1),
          mentionRole: inferMentionRole(noun, content),
        });
      }
    }
  }

  // 4. Preposition patterns: "the/in/at/from [Proper Noun]"
  //    IMPORTANT: prepositions appear with characters constantly in narrative
  //    ("turned to Milena", "looked at Prolix"). We use the full inferEntityType
  //    pipeline which checks character signals before defaulting.
  // Capture group handles: standard "Sixth Street", CamelCase "PubSec", multi-word "New Eridu"
  const prepMatches = content.match(
    /(?:the|in|at|from|to|toward|through|across|within|beyond|outside|inside)\s+([A-Z][a-z]+(?:[A-Z][a-z]*)*(?:\s+[A-Z][a-z]+(?:[A-Z][a-z]*)*){0,2})/g,
  ) || [];
  for (const match of prepMatches) {
    const name = match.replace(/^(?:the|in|at|from|to|toward|through|across|within|beyond|outside|inside)\s+/, "");
    const key = name.toLowerCase();
    // Skip if: already found, common word, suppressed by multi-word capture, or adjective usage
    if (found.has(key) || effectiveCommon.has(key) || suppressedSubstrings.has(key) || name.length <= 2) continue;
    // Adjective check: "the Sandy fur" — skip if followed by physical noun
    const nameIdx = content.indexOf(name);
    if (nameIdx >= 0) {
      const afterName = content.slice(nameIdx + name.length).match(/^\s+(\w+)/);
      if (afterName && ADJECTIVE_FOLLOWERS.test(afterName[1])) continue;
    }
    {
      const type = inferEntityType(name, content);
      found.set(key, {
        name,
        type,
        aliases: [],
        confidence: type === "character" ? 0.7 : 0.5,
        mentionRole: type === "character" ? inferMentionRole(name, content) : "present",
      });
    }
  }

  // ── Final pass: alias resolution ──
  // Merge any entities from stages 3-4 that are actually aliases of known entities.
  // "Pulchra" discovered in stage 3 → resolves to "Pulchra Fellini" from stage 1/2.
  // "Captain Melina" → strip honorific → "Melina" → resolves to known entity.
  const resolved = new Map<string, ExtractedEntity & { mentionRole: MentionRole }>();

  for (const [key, entity] of found) {
    const canonical = resolveToCanonical(entity.name, aliasLookup);
    const finalKey = canonical ? canonical.toLowerCase() : key;
    const finalName = canonical || entity.name;

    if (!resolved.has(finalKey)) {
      // Use the canonical name but keep the discovered entity's type if it was from a stage 1/2 match,
      // or look up the known entity type for alias-resolved entries
      const knownEntity = canonical ? knownEntities.find((e) => e.name.toLowerCase() === finalKey) : null;
      resolved.set(finalKey, {
        ...entity,
        name: finalName,
        type: knownEntity ? knownEntity.entityType : entity.type,
        aliases: knownEntity ? knownEntity.aliases : entity.aliases,
        confidence: canonical ? Math.max(entity.confidence, 0.85) : entity.confidence,
      });
    } else {
      // Merge into existing: keep the higher confidence entry, prefer subject role
      const existing = resolved.get(finalKey)!;
      if (entity.confidence > existing.confidence) {
        resolved.set(finalKey, { ...entity, name: finalName, confidence: entity.confidence });
      }
      if (entity.mentionRole === "subject" && existing.mentionRole !== "subject") {
        existing.mentionRole = "subject";
      }
    }
  }

  // Apply minimum confidence filter
  const results = [...resolved.values()];
  if (minConfidence > 0) {
    return results.filter((e) => e.confidence >= minConfidence);
  }
  return results;
}

/**
 * Extract a brief excerpt showing how an entity appears in the content.
 * Returns up to 120 characters of surrounding context.
 */
export function extractMentionExcerpt(
  entityName: string,
  content: string,
  maxLength = 120,
): string | null {
  const idx = content.toLowerCase().indexOf(entityName.toLowerCase());
  if (idx === -1) return null;

  const contextStart = Math.max(0, idx - 40);
  const contextEnd = Math.min(content.length, idx + entityName.length + 40);

  let excerpt = content.slice(contextStart, contextEnd).trim();
  if (contextStart > 0) excerpt = "..." + excerpt;
  if (contextEnd < content.length) excerpt = excerpt + "...";

  if (excerpt.length > maxLength) {
    excerpt = excerpt.slice(0, maxLength - 3) + "...";
  }

  return excerpt;
}
