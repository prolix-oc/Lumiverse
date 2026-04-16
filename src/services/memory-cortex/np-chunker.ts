/**
 * Memory Cortex — NP Chunker for Phase 1 entity discovery.
 *
 * Simple English noun phrase chunker — one linear pass, O(n).
 * Detects entity candidates in memory chunks that aren't in the existing registry.
 *
 * PHASE 1 ONLY. Do NOT run on Phase 2 (live message processing).
 * Phase 1 is server-side and amortized — the compute cost is acceptable.
 *
 * Based on: Grosz, Joshi & Weinstein (1995) Centering Theory,
 * Dunietz & Gillick (2014) entity salience features.
 */

import type { NPCandidate } from "./types";

// ─── Closed-Class Exclusion Set ───────────────────────────────
// Determiners, prepositions, conjunctions, auxiliaries, common stopwords.
// These words BREAK an NP accumulation — they cannot be part of a proper noun.

const CLOSED_CLASS = new Set([
  // Determiners
  "the", "a", "an", "this", "that", "these", "those", "my", "your", "his", "her",
  "their", "its", "our", "some", "any", "all", "both", "each", "every", "no",
  // Prepositions
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "up", "about",
  "into", "through", "during", "before", "after", "above", "below", "between",
  "under", "over", "near", "upon", "within", "without", "toward", "towards",
  "against", "among", "across", "along", "behind", "beside", "beyond",
  // Auxiliaries / be / have / do
  "is", "was", "are", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "could", "should", "may", "might",
  "shall", "must", "can",
  // Conjunctions
  "and", "but", "or", "nor", "so", "yet", "because", "although", "if", "when",
  "then", "than", "as", "also", "just", "not", "very", "too", "more", "most",
  // Common pronouns
  "i", "me", "we", "us", "you", "he", "him", "she", "it", "they", "them",
  "who", "whom", "which", "what", "where", "how", "why",
  // Common adverbs / filler
  "here", "there", "now", "only", "still", "already", "even", "once", "never",
  "always", "often", "again", "perhaps", "maybe", "quite", "rather", "really",
  "well", "back", "away", "down", "out", "off",
  // Common verbs (not useful as NP heads)
  "said", "went", "came", "got", "made", "took", "knew", "thought", "looked",
  "seemed", "felt", "told", "asked", "let", "began", "kept", "left",
  // Contractions (pronoun + auxiliary) — normalized to standard apostrophe
  "i'm", "i've", "i'll", "i'd", "he's", "she's", "it's", "we're", "they're",
  "you're", "we've", "they've", "you've", "he'd", "she'd", "we'd", "they'd",
  "you'd", "won't", "can't", "don't", "doesn't", "didn't", "couldn't",
  "wouldn't", "shouldn't", "isn't", "aren't", "wasn't", "weren't",
  "hasn't", "haven't", "hadn't", "let's", "that's", "there's", "here's",
  "what's", "who's", "how's", "where's", "when's",
]);

// ─── Common English Words ─────────────────────────────────────
// Words that appear capitalized in roleplay prose (dialogue boundaries,
// emphasis, after em-dashes/colons) but are NOT proper nouns.
// Used as a POST-FILTER on single-word NP candidates.
// Organised by part of speech for maintainability.

const COMMON_ENGLISH = new Set([
  // ── Verbs (base, past, gerund, 3rd-person) ──
  // Gerunds / present participles
  "having", "being", "going", "coming", "getting", "making", "taking",
  "seeing", "looking", "saying", "doing", "running", "walking", "talking",
  "trying", "asking", "telling", "leaving", "sitting", "standing",
  "feeling", "thinking", "waiting", "watching", "holding", "pulling",
  "pushing", "reaching", "climbing", "falling", "turning", "moving",
  "opening", "closing", "breaking", "cutting", "setting", "putting",
  "fighting", "growing", "leading", "rising", "dying", "lying", "flying",
  "working", "playing", "living", "killing", "speaking", "reading",
  "writing", "driving", "paying", "spending", "building", "sending",
  "wearing", "buying", "meaning", "meeting", "showing", "winning",
  "losing", "serving", "sleeping", "breathing", "following",
  // Past tense / past participles
  "turned", "walked", "looked", "started", "stopped", "opened", "closed",
  "moved", "pulled", "pushed", "dropped", "picked", "placed", "reached",
  "stepped", "climbed", "slurred", "mumbled", "whispered", "shouted",
  "screamed", "laughed", "smiled", "frowned", "nodded", "shrugged",
  "grabbed", "slammed", "stumbled", "shivered", "trembled", "collapsed",
  "continued", "replied", "answered", "noticed", "realized", "decided",
  "appeared", "remained", "finished", "returned", "glanced", "stared",
  "managed", "expected", "supposed", "happened", "allowed", "believed",
  "caused", "changed", "considered", "covered", "created", "crossed",
  "destroyed", "discovered", "entered", "escaped", "explained", "failed",
  "followed", "forced", "gathered", "handled", "helped", "ignored",
  "imagined", "included", "insisted", "intended", "involved", "joined",
  "landed", "lasted", "learned", "lifted", "loaded", "marked", "missed",
  "offered", "ordered", "passed", "performed", "pointed", "pressed",
  "produced", "promised", "provided", "raised", "received", "refused",
  "released", "removed", "repeated", "revealed", "rolled", "rushed",
  "searched", "settled", "shared", "shifted", "slipped", "solved",
  "spent", "spread", "survived", "suspected", "touched", "treated",
  "trusted", "twisted", "warned", "wrapped",
  // Base / present tense verbs
  "set", "sets", "put", "puts", "run", "runs", "see", "sees", "seen",
  "go", "goes", "gone", "leave", "leaves", "give", "gives", "given",
  "take", "takes", "taken", "come", "comes", "find", "finds", "found",
  "want", "wants", "need", "needs", "know", "knows", "think", "thinks",
  "turn", "turns", "start", "starts", "move", "moves", "try", "tries",
  "call", "calls", "hold", "holds", "stand", "stands", "hear", "hears",
  "bring", "brings", "sit", "sits", "keep", "keeps", "watch", "watches",
  "cut", "hit", "hurt", "cost", "shut", "split", "cast", "beat",
  "bet", "bid", "burst", "rid", "seek", "shed", "spit", "quit",
  "accept", "avoid", "bear", "blame", "burn", "catch", "check",
  "claim", "contain", "count", "cover", "create", "cross", "demand",
  "deny", "describe", "destroy", "display", "doubt", "drag", "draw",
  "dress", "drive", "earn", "enjoy", "enter", "escape", "exist",
  "expect", "explain", "explore", "express", "extend", "fail", "fear",
  "fight", "fill", "fix", "float", "force", "gain", "gather", "grant",
  "grow", "handle", "hang", "hate", "hide", "imagine", "include",
  "insist", "intend", "involve", "join", "judge", "jump", "kick",
  "lack", "land", "last", "launch", "lead", "lift", "link", "load",
  "lose", "love", "manage", "mark", "match", "matter", "miss", "mount",
  "note", "notice", "obtain", "occur", "offer", "operate", "order",
  "own", "pass", "pause", "perform", "permit", "pour", "pray",
  "prepare", "press", "prevent", "produce", "promise", "protect",
  "prove", "provide", "pull", "push", "raise", "read", "receive",
  "refuse", "release", "remove", "repeat", "replace", "report",
  "represent", "request", "require", "resist", "resolve", "respond",
  "restore", "reveal", "risk", "roll", "rush", "save", "search",
  "seek", "select", "sell", "send", "serve", "settle", "share",
  "shift", "shoot", "sign", "sink", "sleep", "slide", "slip", "smell",
  "solve", "sort", "spare", "spend", "spin", "spread", "steal",
  "store", "strike", "struggle", "suffer", "suggest", "supply",
  "survive", "suspect", "sweep", "swing", "teach", "tear", "test",
  "throw", "touch", "trade", "train", "transfer", "travel", "treat",
  "trust", "twist", "urge", "warn", "waste", "wear", "win", "wonder",
  "wrap",
  // Roleplay action verbs (base forms — stem checker catches -ing/-ed variants)
  "advance", "announce", "approach", "arrive", "beg", "bow", "charge",
  "choke", "clench", "clutch", "collapse", "compromise", "confuse",
  "cough", "crouch", "curse", "devastate",
  "dare", "dash", "disappear", "emerge", "embrace", "exhaust",
  "flinch", "gasp", "gaze", "gesture", "glare", "grasp", "groan",
  "growl", "grunt", "hesitate", "hiss", "howl", "kneel", "lunge",
  "march", "moan", "mutter", "nod", "pace", "peer", "plead", "plunge",
  "point", "pounce", "recover", "recoil", "retreat", "roam", "scan",
  "scatter", "scowl", "scream", "seize", "shatter", "shout", "shriek",
  "shudder", "slam", "snarl", "snatch", "sneer", "sob", "sprint",
  "stagger", "stomp", "stumble", "surrender", "swear", "tense",
  "tremble", "vanish", "wander", "weep", "wince", "yell",
  // ── Expletives / interjections ──
  "fuck", "shit", "damn", "hell", "crap", "bloody", "bastard", "bitch",
  "god", "christ", "jesus", "ugh", "hmm", "huh", "wow", "oh", "ah",
  "okay", "ok", "yeah", "yes", "yep", "nah", "nope", "no",
  // ── Adjectives ──
  "able", "actual", "afraid", "alive", "alone", "angry", "aware",
  "bad", "bare", "basic", "big", "bitter", "blind", "bold", "brave",
  "brief", "broad", "broken", "busy", "calm", "capable", "careful",
  "central", "certain", "cheap", "chief", "civil", "clean", "clear",
  "close", "cold", "comfortable", "common", "complete", "complex",
  "conscious", "considerable", "constant", "cool", "correct", "critical",
  "cruel", "curious", "current", "dangerous", "dark", "dead", "dear",
  "decent", "deep", "definite", "delicate", "desperate", "different",
  "difficult", "dim", "dirty", "distinct", "double", "dramatic",
  "dry", "due", "dull", "eager", "early", "easy", "effective",
  "elaborate", "empty", "endless", "enormous", "enough", "entire",
  "essential", "evil", "exact", "excellent", "exciting", "existing",
  "expensive", "extra", "extreme", "faint", "fair", "false", "familiar",
  "famous", "fat", "favorite", "fierce", "final", "fine", "firm",
  "fit", "flat", "fond", "foolish", "foreign", "formal", "former",
  "fortunate", "free", "fresh", "friendly", "frightened", "front",
  "full", "funny", "general", "generous", "gentle", "genuine", "glad",
  "golden", "good", "gorgeous", "grand", "grateful", "grave", "gray",
  "great", "green", "grey", "grim", "gross", "guilty", "handsome",
  "happy", "hard", "harsh", "healthy", "heavy", "helpful", "hidden",
  "high", "honest", "horrible", "hostile", "hot", "huge", "human",
  "humble", "hungry", "ideal", "ill", "immediate", "immense",
  "important", "impossible", "impressive", "incredible", "independent",
  "indirect", "individual", "inevitable", "initial", "inner", "innocent",
  "intense", "internal", "joint", "keen", "key", "kind", "known",
  "large", "last", "late", "latter", "lean", "legal", "less", "likely",
  "limited", "little", "live", "living", "local", "lonely", "long",
  "loose", "lost", "loud", "lovely", "low", "lucky", "mad", "main",
  "major", "massive", "mature", "mean", "mere", "mild", "military",
  "minimal", "minor", "miserable", "moderate", "modest", "moral",
  "multiple", "mutual", "naked", "narrow", "nasty", "natural", "neat",
  "necessary", "negative", "nervous", "new", "nice", "noble", "normal",
  "numerous", "obvious", "odd", "official", "old", "open", "opposite",
  "ordinary", "original", "other", "outer", "overall", "own",
  "painful", "pale", "partial", "particular", "passive", "past",
  "patient", "peculiar", "perfect", "permanent", "personal", "physical",
  "plain", "pleasant", "plenty", "polite", "political", "poor",
  "popular", "positive", "possible", "potential", "powerful", "practical",
  "precious", "precise", "present", "previous", "primary", "prime",
  "principal", "prior", "private", "probable", "profound", "prominent",
  "proper", "proud", "public", "pure", "quick", "quiet", "radical",
  "random", "rapid", "rare", "raw", "ready", "real", "reasonable",
  "recent", "red", "regular", "relative", "relevant", "reluctant",
  "remarkable", "remote", "responsible", "rich", "rigid", "romantic",
  "rough", "round", "royal", "rude", "rural", "sacred", "sad", "safe",
  "savage", "scared", "secondary", "secret", "secure", "sensitive",
  "separate", "serious", "severe", "shallow", "sharp", "sheer",
  "short", "sick", "significant", "silent", "silly", "similar",
  "simple", "single", "slight", "slim", "slow", "small", "smooth",
  "social", "soft", "solid", "sorry", "sour", "spare", "special",
  "specific", "splendid", "stable", "standard", "steady", "steep",
  "stiff", "straight", "strange", "strict", "strong", "subsequent",
  "substantial", "subtle", "successful", "sudden", "sufficient",
  "suitable", "super", "sure", "suspicious", "sweet", "swift", "tall",
  "temporary", "tender", "terrible", "thick", "thin", "tight", "tiny",
  "tired", "total", "tough", "tremendous", "true", "typical", "ugly",
  "ultimate", "unable", "uncertain", "uncomfortable", "unique",
  "unlikely", "unnecessary", "unusual", "upper", "upset", "urban",
  "urgent", "useful", "usual", "vague", "valuable", "various", "vast",
  "violent", "visible", "vital", "vivid", "vulnerable", "warm", "weak",
  "wealthy", "weird", "whole", "wide", "wild", "willing", "wise",
  "worth", "wrong", "young",
  // ── Adverbs ──
  "almost", "already", "anyway", "apparently", "barely", "basically",
  "carefully", "certainly", "clearly", "closely", "completely",
  "constantly", "currently", "deeply", "definitely", "deliberately",
  "desperately", "directly", "easily", "entirely", "especially",
  "essentially", "eventually", "exactly", "extremely", "fairly",
  "finally", "firmly", "fortunately", "frequently", "fully", "gently",
  "gradually", "greatly", "hardly", "heavily", "highly", "honestly",
  "hopefully", "immediately", "incredibly", "indeed", "initially",
  "instead", "lately", "likely", "literally", "mainly", "merely",
  "mostly", "naturally", "nearly", "necessarily", "normally",
  "obviously", "occasionally", "officially", "originally", "otherwise",
  "particularly", "perfectly", "personally", "physically", "possibly",
  "precisely", "presumably", "previously", "primarily", "privately",
  "probably", "promptly", "properly", "purely", "quickly", "quietly",
  "rapidly", "rarely", "readily", "recently", "regularly",
  "relatively", "reluctantly", "repeatedly", "roughly", "scarcely",
  "seemingly", "seriously", "severely", "sharply", "shortly",
  "significantly", "silently", "similarly", "simply", "slightly",
  "slowly", "softly", "solely", "somehow", "specifically", "steadily",
  "strictly", "strongly", "subsequently", "suddenly", "supposedly",
  "surely", "thoroughly", "together", "totally", "truly", "typically",
  "ultimately", "undoubtedly", "unfortunately", "usually", "utterly",
  "virtually", "widely",
  // ── Common nouns (not entity-like) ──
  "act", "age", "air", "amount", "area", "arm", "art", "attempt",
  "attention", "balance", "ball", "band", "bank", "base", "basis",
  "bed", "bit", "block", "blow", "board", "body", "bone", "book",
  "border", "bottom", "box", "brain", "break", "breath", "burden",
  "car", "card", "care", "case", "cause", "center", "chance",
  "character", "charge", "choice", "circle", "class", "code", "color",
  "comfort", "command", "comment", "community", "company", "concern",
  "condition", "conflict", "connection", "consequence", "contact",
  "content", "context", "control", "corner", "cost", "count", "couple",
  "course", "court", "cover", "crew", "crowd", "cry", "damage",
  "deal", "death", "debt", "degree", "demand", "desire", "detail",
  "difference", "direction", "distance", "door", "doubt", "dream",
  "dress", "drink", "drop", "duty", "edge", "effort", "element",
  "emotion", "end", "energy", "engine", "entry", "evidence", "example",
  "exception", "exchange", "exercise", "experience", "expression",
  "extent", "eye", "face", "fact", "failure", "faith", "fear",
  "feature", "figure", "fire", "flash", "floor", "flow", "focus",
  "food", "foot", "force", "form", "fortune", "frame", "front",
  "fuel", "function", "fund", "future", "game", "gap", "gift",
  "glass", "goal", "gold", "grace", "grade", "grain", "grass", "grip",
  "ground", "growth", "guard", "guess", "habit", "half", "handle",
  "harm", "heat", "height", "hit", "hole", "hope", "horse", "host",
  "hunt", "idea", "image", "impact", "income", "increase",
  "influence", "instance", "interest", "issue", "item", "job", "joke",
  "journey", "judgment", "kind", "knowledge", "labor", "land",
  "language", "laugh", "law", "layer", "lead", "length", "lesson",
  "letter", "level", "lie", "life", "light", "limit", "line", "link",
  "list", "load", "lock", "look", "loss", "lot", "luck", "lunch",
  "machine", "manner", "mass", "master", "material", "matter", "meal",
  "measure", "medium", "meeting", "message", "method", "mind", "mine",
  "mirror", "mistake", "mix", "model", "moment", "mood", "motion",
  "mouth", "movement", "murder", "music", "mystery", "nature", "nerve",
  "news", "noise", "note", "notice", "notion", "number", "object",
  "occasion", "offer", "opinion", "opportunity", "option", "origin",
  "outcome", "pace", "pack", "pain", "pair", "part", "passage",
  "past", "path", "pattern", "peace", "period", "person", "phase",
  "picture", "piece", "pile", "pitch", "plan", "plate", "play",
  "pleasure", "plot", "pocket", "poem", "point", "portion", "position",
  "post", "potential", "pound", "power", "practice", "presence",
  "pressure", "price", "pride", "principle", "prize", "problem",
  "process", "product", "profit", "progress", "promise", "proof",
  "proportion", "prospect", "protest", "pull", "purpose", "push",
  "quality", "quarter", "question", "race", "range", "rank", "rate",
  "ratio", "reaction", "reality", "reason", "record", "reference",
  "regard", "region", "relation", "release", "relief", "remark",
  "repeat", "reply", "report", "request", "respect", "response",
  "rest", "result", "return", "reward", "ring", "rise", "risk",
  "rock", "role", "root", "round", "route", "row", "rule", "rush",
  "sale", "sample", "scale", "scene", "scope", "screen", "search",
  "season", "seat", "section", "sense", "series", "service", "session",
  "shape", "share", "shift", "shock", "shot", "show", "side", "sight",
  "sign", "signal", "silence", "silver", "site", "size", "skill",
  "skin", "sleep", "slip", "smell", "smile", "smoke", "snap",
  "solution", "sort", "soul", "source", "speech", "speed", "spirit",
  "split", "sport", "spot", "spread", "spring", "staff", "stage",
  "stand", "standard", "star", "start", "state", "status", "step",
  "stick", "stock", "stop", "store", "storm", "story", "strain",
  "stream", "strength", "stress", "stretch", "strike", "string",
  "stroke", "structure", "struggle", "study", "stuff", "style",
  "subject", "success", "sum", "support", "surface", "surprise",
  "survey", "system", "table", "target", "task", "taste", "tax",
  "team", "test", "text", "theme", "theory", "thing", "threat",
  "throw", "tie", "tip", "title", "tone", "tool", "top", "touch",
  "tour", "track", "tradition", "traffic", "trail", "train", "trap",
  "treat", "trend", "trial", "trick", "trip", "trouble", "truth",
  "type", "unit", "use", "value", "variety", "version", "victim",
  "view", "violence", "vision", "visit", "voice", "volume", "walk",
  "wall", "watch", "wave", "way", "wealth", "weight", "wish",
  "wonder", "wood", "word", "work", "world", "wound",
]);

// ─── Title / Rank / Honorific Prefixes ────────────────────────
// When one of these words appears at a clause boundary followed by a title-cased
// word, include BOTH in the NP. This preserves identity-carrying titles that
// distinguish between entities sharing the same surname.

const TITLE_PREFIXES = new Set([
  // Military / law enforcement
  "agent", "officer", "private", "corporal", "sergeant", "lieutenant",
  "captain", "major", "colonel", "general", "admiral", "commander",
  "commodore", "marshal", "constable", "deputy", "sheriff", "inspector",
  "detective", "chief", "ensign", "cadet",
  // Nobility / royalty
  "king", "queen", "prince", "princess", "emperor", "empress",
  "duke", "duchess", "baron", "baroness", "count", "countess",
  "lord", "lady", "sir", "dame", "knight", "squire",
  // Religious
  "father", "mother", "brother", "sister", "priest", "bishop",
  "cardinal", "pope", "reverend", "pastor", "elder", "abbot", "abbess",
  // Academic / professional
  "doctor", "professor", "chancellor", "dean", "judge", "senator",
  "governor", "president", "director", "minister", "ambassador",
  "councilor", "secretary", "chairman", "chairwoman", "nurse",
  // Honorifics (full + abbreviated forms)
  "mr", "mrs", "ms", "miss", "mister", "madame", "madam",
  "dr", "prof", "sgt", "lt", "cpt", "cpl", "pvt", "gen",
  "col", "cmdr", "adm", "rev", "gov", "sen",
  // Fantasy / RPG
  "master", "mistress", "warden", "keeper", "guardian", "sentinel",
  "ranger", "scout", "champion", "overlord", "archon",
]);

/** Suffixes that follow a name and carry identity (generational, professional) */
const NAME_SUFFIXES = new Set(["jr", "sr", "esq"]);

// ─── Suffix Patterns ──────────────────────────────────────────
// Morphological patterns that strongly indicate a word is NOT a proper noun.
// Applied to single-word candidates that weren't caught by COMMON_ENGLISH.

/** Adjective/adverb/abstract noun suffixes — applied at ≥6 chars */
const NOT_PROPER_NOUN_SUFFIX = /(?:ly|ness|ment|ful|less|ously|ively|ably|ibly|ally)$/;

/**
 * Check if a word ending in -ing or -ed is an inflected form of a common word.
 * Uses stem extraction + cross-inflection lookup against COMMON_ENGLISH.
 *
 * Verb forms are rejected when the stem is a known common word.
 * Surnames ending in -ing/-ed are preserved when the stem is NOT a common word.
 */
function isInflectedCommonWord(lower: string): boolean {
  if (lower.endsWith("ing") && lower.length >= 7) {
    const stem = lower.slice(0, -3);
    if (COMMON_ENGLISH.has(stem)) return true;           // walk → known
    if (COMMON_ENGLISH.has(stem + "e")) return true;     // danc → dance
    if (COMMON_ENGLISH.has(stem + "ed")) return true;    // scream → screamed
    if (COMMON_ENGLISH.has(stem + "s")) return true;     // scream → screams
    // Doubled consonant: running → runn → run
    if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
      const short = stem.slice(0, -1);
      if (COMMON_ENGLISH.has(short)) return true;
      if (COMMON_ENGLISH.has(short + "ed")) return true;
    }
    return false;
  }

  if (lower.endsWith("ed") && lower.length >= 7) {
    const stem = lower.slice(0, -2);
    if (COMMON_ENGLISH.has(stem)) return true;           // climb → known
    if (COMMON_ENGLISH.has(stem + "e")) return true;     // creat → create
    if (COMMON_ENGLISH.has(stem + "ing")) return true;   // climb → climbing
    if (COMMON_ENGLISH.has(stem + "s")) return true;     // climb → climbs
    // Doubled consonant: stopped → stopp → stop
    if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2]) {
      const short = stem.slice(0, -1);
      if (COMMON_ENGLISH.has(short)) return true;
      if (COMMON_ENGLISH.has(short + "ing")) return true;
    }
    // -ied → -y: carried → carri → carry
    if (lower.endsWith("ied")) {
      if (COMMON_ENGLISH.has(lower.slice(0, -3) + "y")) return true;
    }
    return false;
  }

  return false;
}

// ─── Verb Markers ─────────────────────────────────────────────
// Crude but domain-appropriate for subject-position detection in English SVO

const VERB_MARKERS = /(?:ing|ed|es|s)\b/;

// ─── NP Chunker ───────────────────────────────────────────────

/**
 * Extract noun phrase candidates from tokenized text.
 * Uses a closed-class exclusion set, capitalization heuristics,
 * and cross-chunk lowercase occurrence analysis.
 *
 * Strategy:
 *   - Build a set of all words that appear in lowercase → these are common words
 *   - Skip closed-class words (determiners, prepositions, etc.)
 *   - Treat clause boundaries (quotes, em-dashes, colons) as unreliable caps
 *   - Only title-cased mid-clause words start/extend NPs
 *   - Post-filter: reject common English words, suffix patterns, garbage
 *
 * @param tokens - Whitespace-split tokens from the chunk
 * @returns Array of NP candidate strings
 */
export function extractNPCandidates(tokens: string[]): string[] {
  // ── Pre-scan: build a set of words that appear in lowercase form ──
  // If a word appears lowercase ANYWHERE in the chunk, it's a common English
  // word — the capitalized occurrence is just clause-initial or emphatic.
  // Proper nouns only ever appear capitalized; common words appear in both forms.
  const lowercaseWords = new Set<string>();
  for (const t of tokens) {
    const c = t
      .replace(/[.,;:!?"''"\u201C\u201D\u2018\u2019()\[\]{}]+$/g, "")
      .replace(/[''\u2019]s$/i, "");
    // Original token starts with lowercase letter → record as common word
    if (c && /^[a-z]/.test(c)) {
      lowercaseWords.add(c.toLowerCase());
    }
  }

  const candidates: string[] = [];
  let current: string[] = [];
  // When a title lookahead succeeds, the name
  // that follows must be force-included even though "Mrs." ends with a period
  // that makes the next token look like a clause-start.
  let forceIncludeNext = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // Strip leading quotes, trailing punctuation, and possessive 's.
    // Leading quotes stripped so dialogue-initial words like "Captain are
    // recognized as title-cased. Possessive stripped to yield canonical form
    // (the canonical name, not a variant). Raw token still used for clause detection.
    const cleaned = token
      .replace(/^["""\u201C\u201D''\u2018\u2019]+/, "")
      .replace(/[.,;:!?"''"\u201C\u201D\u2018\u2019()\[\]{}]+$/g, "")
      .replace(/[''\u2019]s$/i, "");
    if (!cleaned) {
      forceIncludeNext = false;
      if (current.length > 0) {
        candidates.push(current.join(" "));
        current = [];
      }
      continue;
    }

    // Normalize apostrophes for closed-class lookup
    const lower = cleaned.toLowerCase().replace(/[\u2018\u2019\u02BC\u0060\u00B4\u2032'']/g, "'");

    if (CLOSED_CLASS.has(lower)) {
      forceIncludeNext = false;
      if (current.length > 0) {
        candidates.push(current.join(" "));
        current = [];
      }
      continue;
    }

    // ── Clause/sentence boundary detection ──
    // Capitalization after these boundaries is unreliable (structural, not semantic).
    // Uses raw token (not cleaned) so quote markers are still visible.
    const prevToken = tokens[i - 1] ?? "";
    const isClauseStart = i === 0
      || /[.!?]\s*$/.test(prevToken)              // sentence-ending punctuation
      || /[—–]\s*$/.test(prevToken)                // em-dash (clause boundary)
      || /:\s*$/.test(prevToken)                   // colon
      || /[""\u201C\u201D]\s*$/.test(prevToken)    // after closing/opening quote
      || /^[""\u201C]/.test(token);                // token starts with opening quote

    // ── Comma boundary ──
    // Commas separate noun phrases in English. If the previous raw token ends
    // with a comma, flush the accumulated NP — commas delimit noun phrases.
    if (current.length > 0 && /,[^a-zA-Z]*$/.test(prevToken)) {
      candidates.push(current.join(" "));
      current = [];
    }

    // ── Force-include after title/suffix lookahead ──
    // When a title prefix (e.g., "Mrs.") was included in the previous iteration,
    // the NEXT token is the name — include it regardless of clause-start status.
    // "Mrs." ends with "." which makes "Smith" look like a sentence start, but
    // the title lookahead already confirmed it's a title+name pair.
    if (forceIncludeNext) {
      forceIncludeNext = false;
      if (/^[A-Z][a-z]/.test(cleaned)) {
        current.push(cleaned);
        continue;
      }
      // Not title-cased — fall through to normal handling
    }

    // ── Title-cased mid-clause words qualify as proper noun candidates ──
    // Must be title-cased (uppercase + lowercase). ALL-CAPS = emphasis, not a name.
    if (!isClauseStart && /^[A-Z][a-z]/.test(cleaned)) {
      current.push(cleaned);
      // Title abbreviation lookahead: "Mrs." / "Dr." / "Prof." end with a period
      // that makes the NEXT token falsely appear to be a clause start. When this
      // word is a known title and the raw token ends with ".", force-include the
      // following name so abbreviated titles and their names stay together.
      if (TITLE_PREFIXES.has(lower) && /\.$/.test(token)) {
        forceIncludeNext = true;
      }
      continue;
    }

    // ── Clause-initial lookahead: title prefixes and name suffixes ──
    // At clause boundaries, capitalization is normally unreliable. BUT two
    // patterns justify inclusion:
    //   1. Known title/rank + proper noun → title-name pair
    //   2. Proper noun + generational suffix → name-suffix pair
    // Always flush accumulated NP first — clause start = new phrase.
    if (isClauseStart && /^[A-Z][a-z]/.test(cleaned)) {
      if (current.length > 0) {
        candidates.push(current.join(" "));
        current = [];
      }
      const nextCleaned = peekNextCleaned(tokens, i);
      const nextLower = nextCleaned.toLowerCase();

      // Pattern 1: Title prefix + proper noun
      if (TITLE_PREFIXES.has(lower) && /^[A-Z][a-z]/.test(nextCleaned)) {
        current.push(cleaned);
        forceIncludeNext = true;
        continue;
      }

      // Pattern 2: Name + generational suffix (Jr, Sr, Esq)
      if (!COMMON_ENGLISH.has(lower) && !lowercaseWords.has(lower) && NAME_SUFFIXES.has(nextLower)) {
        current.push(cleaned);
        forceIncludeNext = true;
        continue;
      }
    }

    // Anything else (clause-start, all-caps, lowercase) flushes the current NP
    if (current.length > 0) {
      candidates.push(current.join(" "));
      current = [];
    }
  }

  if (current.length > 0) {
    candidates.push(current.join(" "));
  }

  // Deduplicate, filter, and validate quality
  const unique = [...new Set(candidates)].filter((c) => c.length > 1);
  return unique.filter((c) => isValidNPCandidate(c, lowercaseWords));
}

/** Peek at the next token's cleaned form (for lookahead without advancing the index). */
function peekNextCleaned(tokens: string[], i: number): string {
  const next = tokens[i + 1];
  if (!next) return "";
  return next
    .replace(/^["""\u201C\u201D''\u2018\u2019]+/, "")
    .replace(/[.,;:!?"''"\u201C\u201D\u2018\u2019()\[\]{}]+$/g, "");
}

/**
 * Validate that an NP candidate is a plausible proper noun, not a common word or garbage.
 *
 * Multi-layered filtering:
 *   1. Structural: no brackets/special chars, max 5 words, min 3 chars for single words
 *   2. Lowercase cross-reference: if the word appears lowercase in the same chunk, reject
 *   3. Dictionary: check against COMMON_ENGLISH (~700 common words)
 *   4. Suffix: morphological patterns that indicate adjective/adverb/abstract noun
 */
function isValidNPCandidate(candidate: string, lowercaseWords: Set<string>): boolean {
  // ── Structural checks ──
  if (/[\[\]{}|<>#@\\~`]/.test(candidate)) return false;
  if (/^[-—–\s_.]+$/.test(candidate)) return false;
  if (/^[A-Z]\d/.test(candidate) && candidate.length <= 3) return false;

  const words = candidate.split(/\s+/);
  if (words.length > 5) return false;

  // ── Single-word validation (most false positives are single words) ──
  if (words.length === 1) {
    // Must be ≥3 characters
    if (candidate.length < 3) return false;

    const lower = candidate.toLowerCase();

    // Strongest filter: if this word appears in lowercase form elsewhere in the
    // chunk, it's a common English word. Proper nouns are ALWAYS capitalized.
    if (lowercaseWords.has(lower)) return false;

    // Comprehensive dictionary check
    if (COMMON_ENGLISH.has(lower)) return false;

    // Suffix-based backup for words not in the dictionary
    // Only for words ≥6 chars to avoid rejecting short names (e.g., "Lily" = 4 chars)
    if (candidate.length >= 6 && NOT_PROPER_NOUN_SUFFIX.test(lower)) return false;

    // Stem-based verb inflection filter — rejects -ing/-ed words whose stem is
    // a known common word, while preserving surnames whose stems aren't common words
    if (isInflectedCommonWord(lower)) return false;
  }

  return true;
}

/**
 * Detect subject-position NP for Centering Theory Cb scoring.
 * English SVO: first NP before a verb-marker = subject ~85% of declarative sentences.
 *
 * @param tokens - Whitespace-split tokens
 * @param npCandidates - Already-extracted NP candidates
 * @returns The subject-position NP, or null
 */
export function detectSubjectPosition(
  tokens: string[],
  npCandidates: string[],
): string | null {
  if (npCandidates.length === 0) return null;

  // Find first verb-marker token
  const firstVerbIdx = tokens.findIndex((t) => {
    const lower = t.toLowerCase().replace(/[^a-z]/g, "");
    return !CLOSED_CLASS.has(lower) && VERB_MARKERS.test(lower);
  });

  if (firstVerbIdx === -1) return npCandidates[0];

  // Return whichever candidate appears first (before the verb marker)
  // Since NP candidates are in order, the first one is the subject in SVO
  return npCandidates[0];
}

/**
 * Tokenize text for NP chunking.
 * Handles roleplay-style formatting: strips HTML tags, asterisks, bracket artifacts, etc.
 */
export function tokenizeForNPChunker(content: string): string[] {
  // Strip HTML tags
  let cleaned = content.replace(/<[^>]+>/g, " ");
  // Strip roleplay action markers
  cleaned = cleaned.replace(/\*+/g, " ");
  // Strip chunk format prefix: [CHARACTER | Name]:
  cleaned = cleaned.replace(/^\s*\[(?:CHARACTER|USER)\s*\|\s*[^\]]*\]\s*:\s*/i, "");
  // Strip bracket content and orphaned brackets — proper nouns don't live in brackets
  cleaned = cleaned.replace(/\[[^\]]*\]/g, " ");
  cleaned = cleaned.replace(/[\[\]]/g, "");
  // Strip sequences of dashes/special chars (e.g., "---", "===")
  cleaned = cleaned.replace(/[-—–=]{2,}/g, " ");
  // Normalize apostrophes to standard single quote for contraction matching
  cleaned = cleaned.replace(/[\u2018\u2019\u02BC\u0060\u00B4\u2032'']/g, "'");
  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  return cleaned.split(" ").filter(Boolean);
}

/**
 * Full NP extraction pipeline for a memory chunk.
 * Returns candidate NPs with subject-position tagging.
 *
 * Integration: Run on each new chunk during Phase 1. For each candidate:
 *   1. resolveCanonicalId() — if it resolves, skip (known entity)
 *   2. If no resolution, create provisional entity
 *   3. Provisional entities promoted after ≥2 chunks corroborate
 */
export function extractNPsFromChunk(content: string): NPCandidate[] {
  const tokens = tokenizeForNPChunker(content);
  const candidates = extractNPCandidates(tokens);
  const subject = detectSubjectPosition(tokens, candidates);

  return candidates.map((text) => ({
    text,
    isSubjectPosition: text === subject,
  }));
}
