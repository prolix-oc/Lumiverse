/**
 * Memory Cortex — Heuristic salience scoring.
 *
 * Zero-cost importance scoring using multi-layered pattern matching.
 * No API calls, no sidecar. Runs inline during chunk ingestion.
 *
 * v3: Strengthened emotional and semantic analysis:
 *   - Multi-word emotional phrase detection (compound expressions)
 *   - Intensity modifier system (deeply, barely, etc.)
 *   - Character-agency emotional actions (who does the feeling)
 *   - Dialogue content analysis (what's said in quotes)
 *   - Temporal milestone detection (first time, finally, never again)
 *   - Status-quo disruption markers (suddenly, but then)
 *   - Emotional polarity shift detection (mixed emotions = high salience)
 *   - Commitment/decision language in dialogue
 *   - Information density scoring (proper nouns, new facts)
 */

import type { EmotionalTag, NarrativeFlag, SalienceResult } from "./types";

// ─── Intensity Modifiers ───────────────────────────────────────
// Applied to emotional keywords within ~40 chars to scale their weight.

const INTENSIFIERS = /\b(deeply|utterly|completely|absolutely|profoundly|overwhelmingly|desperately|fiercely|painfully|unbearably|incredibly|terribly|violently|wildly|passionately|bitterly|crushingly|agonizingly|intensely|hopelessly|impossibly)\b/i;
const DIMINISHERS = /\b(slightly|barely|hardly|somewhat|a\s+little|faintly|mildly|vaguely|almost|sort\s+of|kind\s+of|half-heartedly)\b/i;

function getIntensityModifier(keyword: string, content: string): number {
  const idx = content.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx === -1) return 1.0;
  const prefix = content.slice(Math.max(0, idx - 40), idx);
  if (INTENSIFIERS.test(prefix)) return 1.5;
  if (DIMINISHERS.test(prefix)) return 0.6;
  return 1.0;
}

// ─── Pattern Dictionaries ──────────────────────────────────────

const INTENSITY_MARKERS = {
  punctuation: /[!?]{2,}|\.{3,}/g,
  capsWords: /\b[A-Z]{3,}\b/g,
  emphasis: /\*[^*]+\*|_[^_]+_/g,
};

/**
 * Expanded emotional patterns. Each category has compound phrases FIRST
 * (higher confidence, more specific) then single-word fallbacks.
 * First match in each category is used.
 */
const EMOTIONAL_PATTERNS: Record<EmotionalTag, RegExp[]> = {
  grief: [
    // Compound grief: physical responses, guilt, compound loss
    /\b(couldn['']t\s+(?:stop\s+crying|bear\s+it|take\s+it|face\s+(?:it|them|her|him))|broken\s+(?:heart|inside|apart)|lost\s+(?:everything|all\s+hope|the\s+will))\b/i,
    /\b(trembl(?:ed|ing)\s+(?:lip|voice|hands?)|choked?\s+(?:up|back\s+(?:a\s+)?(?:sob|tears?))|voice\s+(?:broke|cracked|faltered)|eyes?\s+(?:stung|burned|welled))\b/i,
    /\b(guilt(?:y|ily)?|remorse(?:ful)?|regret(?:ted|ful)?|ashamed?|should(?:n['']t)?\s+have|my\s+fault|blame[ds]?\s+(?:myself|herself|himself))\b/i,
    /\b(sob(?:bed|bing|s)?|cr(?:ied|ying|y)|weep(?:ing|s)?|tears?\s+(?:fell|streamed|rolled)|mourn(?:ing|ed)?|griev(?:ed|ing)|funeral|gone\s+forever|never\s+(?:coming\s+back|see\s+(?:them|her|him)\s+again))\b/i,
    // Single-word fallback
    /\b(tears?|loss|mourning|grief|sorrow(?:ful)?|heartbreak|devastat(?:ed|ing)|bereav(?:ed|ement)|anguish)\b/i,
  ],
  joy: [
    // Compound joy: overwhelming happiness, relief, triumph
    /\b(couldn['']t\s+(?:help\s+(?:but\s+)?(?:smile|laugh|grin)|stop\s+(?:smiling|laughing|grinning)|contain\s+(?:her|his|their)\s+(?:excitement|joy))|heart\s+(?:soared|swelled|sang|leapt)|burst(?:ing)?\s+with\s+(?:joy|happiness|laughter))\b/i,
    /\b(wave\s+of\s+relief|sigh(?:ed)?\s+(?:with|in)\s+relief|finally\s+(?:safe|free|over|done|home)|weight\s+(?:lifted|off\s+(?:her|his|their)\s+(?:shoulders|chest)))\b/i,
    /\b(eyes?\s+(?:lit\s+up|sparkled|shone|brightened)|face\s+(?:lit\s+up|brightened|broke\s+into)|warm(?:th)?\s+(?:spread|filled|bloomed|flooded))\b/i,
    // Single-word fallback
    /\b(laugh(?:ed|ing|s|ter)?|smile[ds]?|grin(?:ned|ning)?|happy|happily|celebrate[ds]?|cheer(?:ed|ing)?|delight(?:ed)?|elated|beaming|ecstatic|jubilant|overjoyed|thrilled|radiant|bliss(?:ful)?)\b/i,
  ],
  tension: [
    // Compound tension: physiological anxiety, suspense, uncertainty
    /\b(heart\s+(?:pounded|raced|hammered|thudded|skipped)|pulse\s+(?:quickened|raced|spiked)|held\s+(?:(?:her|his|their)\s+)?breath|stomach\s+(?:churned|knotted|dropped|sank|tightened))\b/i,
    /\b(hands?\s+(?:shook|trembled|clenched|tightened)|every\s+(?:nerve|muscle|instinct)|on\s+(?:edge|guard|alert|high\s+alert)|couldn['']t\s+(?:shake|ignore)\s+(?:the\s+)?(?:feeling|sense))\b/i,
    /\b(something\s+(?:was\s+wrong|felt\s+off|wasn['']t\s+right|moved|shifted)|sense[ds]?\s+(?:something|danger|a\s+(?:presence|threat))|too\s+quiet|air\s+(?:grew\s+(?:heavy|thick|still)))\b/i,
    // Single-word fallback
    /\b(sword|blade|fight(?:ing)?|battle|attack(?:ed|ing)?|defend(?:ed|ing)?|threat(?:en(?:ed|ing)?)?|danger(?:ous)?|flee(?:ing)?|clash(?:ed)?|blood|tense|wary|cautious|anxious|uneasy|nervous)\b/i,
  ],
  dread: [
    // Compound dread: creeping fear, doom, paranoia
    /\b(cold\s+(?:crept|ran|settled|seeped)\s+(?:through|down|over|into)|blood\s+(?:ran\s+cold|froze|drained)|pit\s+(?:in|of)\s+(?:(?:her|his|their)\s+)?stomach|skin\s+(?:crawled|prickled))\b/i,
    /\b(something\s+(?:dark|terrible|unspeakable|ancient)|couldn['']t\s+(?:move|breathe|scream|look\s+away)|felt?\s+(?:(?:her|his|their)\s+)?(?:legs?|body)\s+(?:go\s+(?:weak|numb)|freeze))\b/i,
    /\b((?:watched|watching|eyes?)\s+from\s+(?:the\s+)?(?:shadows?|dark(?:ness)?|behind)|(?:followed|following|stalking)\s+(?:them|her|him|closely|silently))\b/i,
    // Single-word fallback
    /\b(fear(?:ed|ful)?|dread(?:ed)?|horror|terror|scream(?:ed|ing)?|dark(?:ness)?|shadow(?:s)?|creep(?:ing)?|shudder(?:ed)?|chill(?:ed|ing)?|haunt(?:ed|ing)?|nightmar(?:e|ish)|ominous)\b/i,
  ],
  intimacy: [
    // Compound intimacy: vulnerability, trust, physical closeness
    /\b(let\s+(?:her|his|their)\s+guard\s+down|opened?\s+up\s+(?:to|about)|trusted?\s+(?:(?:her|him|them)\s+)?(?:with|enough|completely)|showed?\s+(?:(?:her|his|their)\s+)?(?:vulnerability|weakness|true\s+(?:self|feelings)))\b/i,
    /\b(leaned?\s+(?:into|against|closer|(?:her|his|their)\s+(?:shoulder|chest|side))|rested?\s+(?:(?:her|his|their)\s+)?head\s+(?:on|against)|hands?\s+(?:found|intertwined|clasped|entwined)|pulled?\s+(?:(?:her|him|them)\s+)?(?:close|closer|into))\b/i,
    /\b(eyes?\s+(?:met|locked|held|searched|softened)|gazed?\s+(?:at|into)\s+(?:(?:her|his|their)\s+)?(?:eyes?|face)|brushed?\s+(?:(?:a\s+)?(?:strand|hair|tears?|thumb)\s+(?:from|across|against)))\b/i,
    // Single-word fallback
    /\b(kiss(?:ed)?|embrace[ds]?|hold(?:ing)?\s+(?:close|tight)|caress(?:ed)?|love[ds]?|tender(?:ly)?|gentle|gently|warmth|intimate(?:ly)?|affection(?:ate)?|nuzzle[ds]?|cuddle[ds]?)\b/i,
  ],
  betrayal: [
    // Compound betrayal: broken trust, deception discovered
    /\b(how\s+could\s+(?:you|they|she|he)|all\s+(?:a\s+)?(?:lie|lies|a\s+ruse|an\s+act)|behind\s+(?:(?:my|our|their)\s+)?back|played?\s+(?:me|us|them)\s+(?:for\s+)?(?:a\s+fool)?)\b/i,
    /\b(trust\s+(?:was\s+)?(?:broken|shattered|destroyed|gone|misplaced)|never\s+(?:trust|believe)\s+(?:(?:you|them|her|him)\s+)?again|everything\s+(?:was\s+)?a\s+lie)\b/i,
    /\b(working\s+(?:for|with)\s+(?:the\s+)?(?:enemy|them\s+all\s+along)|secret(?:ly)?\s+(?:plotting|planned|reported|working|allied)|knew?\s+all\s+along)\b/i,
    // Single-word fallback
    /\b(betray(?:ed|al)?|lied|lies|deceiv(?:ed|ing)|traitor(?:ous)?|backstab(?:bed)?|double[.-]?cross(?:ed)?|treacher(?:y|ous)|sell\s*out|sold\s*out|two-faced)\b/i,
  ],
  revelation: [
    // Compound revelation: realization, shock, epiphany
    /\b(the\s+truth\s+(?:was|is|hit|came|dawned)|everything\s+(?:made\s+sense|clicked|fell\s+into\s+place)|eyes?\s+(?:widened|went\s+wide|grew\s+wide)|suddenly\s+(?:understood|realized|knew|saw|it\s+hit))\b/i,
    /\b(couldn['']t\s+believe|jaw\s+(?:dropped|fell)|froze?\s+(?:in\s+(?:place|shock|surprise))|stunned?\s+(?:into\s+)?silence|caught\s+off\s+guard|hit\s+(?:her|him|them)\s+like)\b/i,
    /\b(that['']s\s+(?:why|how|what)|so\s+that['']s?\s+(?:why|what|how)|you\s+mean|it\s+(?:was\s+)?(?:you|them|her|him)\s+(?:all\s+along|this\s+whole\s+time))\b/i,
    // Single-word fallback
    /\b(reveal(?:ed|ing|s)?|secret|truth|discover(?:ed|y)?|realize[ds]?|confess(?:ed|ion)?|unveil(?:ed)?|uncover(?:ed)?|hidden|epiphany|bombshell|shocking)\b/i,
  ],
  resolve: [
    // Compound resolve: physical determination, acceptance, decision
    /\b(set\s+(?:(?:her|his|their)\s+)?jaw|squared?\s+(?:(?:her|his|their)\s+)?shoulders|stood?\s+(?:(?:her|his|their)\s+)?ground|no\s+(?:more|turning\s+back|going\s+back|other\s+(?:way|choice))|enough\s+(?:is\s+enough|of\s+this))\b/i,
    /\b(accepted?\s+(?:it|the\s+truth|(?:her|his|their)\s+fate)|let(?:ting)?\s+go\s+(?:of)?|time\s+to\s+(?:move\s+on|end\s+this|finish\s+(?:it|this))|made?\s+(?:(?:her|his|their)\s+)?(?:peace|decision|choice))\b/i,
    /\b(this\s+ends?\s+(?:now|here|today)|(?:I|we)\s+(?:have|need)\s+to\s+(?:do\s+this|try|go|act|finish)|whatever\s+(?:it\s+takes|happens|the\s+cost))\b/i,
    // Single-word fallback
    /\b(swear|swore|vow(?:ed)?|promise[ds]?|oath|pledge[ds]?|commit(?:ted)?|determined|resolve[ds]?|steel(?:ed)?|decided?|chose|unwavering)\b/i,
  ],
  humor: [
    // Compound humor: suppressed laughter, dry wit, absurdity
    /\b(couldn['']t\s+(?:help\s+(?:but\s+)?laugh|keep\s+a\s+straight\s+face|resist\s+(?:a\s+)?(?:smile|grin))|burst(?:ing)?\s+(?:out\s+)?laughing|tried?\s+(?:not\s+)?to\s+(?:laugh|smile|grin))\b/i,
    /\b(dry(?:ly)?\s+(?:said|remarked|noted|observed|replied|added)|raised?\s+(?:an?\s+)?(?:eyebrow|brow)|with\s+(?:a\s+)?(?:smirk|wink|grin|wry\s+smile)|rolled?\s+(?:(?:her|his|their)\s+)?eyes?)\b/i,
    /\b(the\s+absurdity|of\s+all\s+(?:the|things)|only\s+(?:you|she|he)|(?:you['']re|that['']s)\s+(?:not\s+)?(?:serious|kidding|joking))\b/i,
    // Single-word fallback
    /\b(joke[ds]?|funny|hilarious|chuckle[ds]?|snicker(?:ed)?|witty|prank|tease[ds]?|smirk(?:ed|ing)?|absurd|ridiculous|laughable|comic(?:al)?|sarcas(?:m|tic))\b/i,
  ],
  melancholy: [
    // Compound melancholy: longing, nostalgia, emotional distance
    /\b(stared?\s+(?:out\s+(?:the\s+)?window|into\s+(?:the\s+)?(?:distance|nothing|space|fire|void))|lost\s+in\s+(?:thought|memories|the\s+past)|ache[ds]?\s+(?:for|with|in)\s+(?:(?:her|his|their)\s+)?(?:chest|heart))\b/i,
    /\b(longed?\s+(?:for|to)|yearned?\s+(?:for|to)|wished?\s+(?:(?:she|he|they)\s+)?could|missed?\s+(?:(?:her|him|them|it|those)\s+)?(?:terribly|so\s+much|dearly)|if\s+only)\b/i,
    /\b(used\s+to\s+(?:be|laugh|smile|come\s+here)|remember\s+when|those\s+days\s+(?:were|are)\s+(?:gone|over)|things?\s+(?:were|was)\s+(?:different|simpler|better)\s+(?:then|before))\b/i,
    // Single-word fallback
    /\b(melan?chol(?:y|ic)|wistful(?:ly)?|nostalgic?|sigh(?:ed|ing)?|lonely|loneliness|bittersweet|forlorn|somber|hollow(?:ness)?|pensive|regretful)\b/i,
  ],
  awe: [
    // Compound awe: breathtaking moments, scale, transcendence
    /\b(took?\s+(?:(?:her|his|their)\s+)?breath\s+away|couldn['']t\s+(?:look\s+away|tear\s+(?:(?:her|his|their)\s+)?(?:eyes?|gaze)\s+(?:away|from))|words?\s+(?:failed|escaped|couldn['']t\s+describe))\b/i,
    /\b(felt?\s+(?:so\s+)?(?:small|insignificant|humbled?)|beyond\s+(?:comprehension|imagination|words|anything)|like\s+nothing\s+(?:(?:she|he|they)['']d\s+)?(?:ever\s+)?(?:seen|experienced|imagined))\b/i,
    /\b(stretched?\s+(?:to\s+)?(?:the\s+)?(?:horizon|infinity|forever)|towered?\s+(?:over|above)|seemed?\s+to\s+(?:glow|shimmer|pulse|hum|radiate))\b/i,
    // Single-word fallback
    /\b(awe(?:d|some|struck)?|marvel(?:ed|ous)?|wonder(?:ed|ous)?|magnificent|breathtaking|stunning|majestic|glorious|spectacular|extraordinary|sublime)\b/i,
  ],
  fury: [
    // Compound fury: physical rage, contempt, explosion
    /\b((?:fists?|hands?|jaw|teeth)\s+(?:clenched|tightened|balled|ground|gritted)|seeing?\s+red|blood\s+(?:boiled|ran\s+hot)|shook?\s+with\s+(?:rage|anger|fury)|barely\s+(?:contain(?:ed)?|controlled?|restrain(?:ed)?)\s+(?:(?:her|his|their)\s+)?(?:rage|anger|fury|temper))\b/i,
    /\b(disgust(?:ed|ing)?|contempt(?:uous)?|repuls(?:ed|ive)|revuls(?:ed|ion)|spat\s+(?:at|on|the\s+words?)|looked?\s+(?:down\s+(?:at|on|upon)|with\s+(?:contempt|disdain|disgust|loathing)))\b/i,
    /\b(wanted?\s+to\s+(?:scream|hit|break|destroy|kill)|slammed?\s+(?:(?:her|his|their)\s+)?(?:fist|hand|palm)\s+(?:on|against|into)|voice\s+(?:rose|raised|shook|thundered|boomed))\b/i,
    // Single-word fallback
    /\b(fury|furious(?:ly)?|rage[ds]?|wrath|enraged|snarl(?:ed)?|roar(?:ed)?|seethe[ds]?|livid|incensed|vengeful|vengeance|hatred|wrathful)\b/i,
  ],
};

const NARRATIVE_FLAG_PATTERNS: Record<NarrativeFlag, RegExp[]> = {
  first_meeting: [
    /\b(first time|never (?:seen|met)|who are you|introduce[ds]?|stranger|new(?:comer|arrival)|met for the first)\b/i,
  ],
  death: [
    /\b(die[ds]?|dead|death|kill(?:ed|ing|s)?|slain|perish(?:ed)?|lifeless|corpse|murder(?:ed)?|fallen|final\s+breath|last\s+breath)\b/i,
  ],
  promise: [
    /\b(promise[ds]?|swear|swore|vow(?:ed)?|oath|pledge[ds]?|word of honor|give.*my word|(?:I|we)\s+will\s+(?:come\s+back|return|find\s+you|wait|remember))\b/i,
  ],
  confession: [
    /\b(confess(?:ed|ion)?|admit(?:ted)?|truth is|I need to tell you|secret(?:ly)?|I['']ve been hiding|come clean|there['']s something\s+(?:I|you)\s+(?:need|should))\b/i,
  ],
  departure: [
    /\b(goodbye|farewell|leave[ds]?|depart(?:ed|ure)?|gone|never see.*again|parting|set off|journey|heading\s+(?:out|off)|time\s+(?:to\s+)?go)\b/i,
  ],
  transformation: [
    /\b(transform(?:ed|ation)?|changed|become|evolve[ds]?|awaken(?:ed|ing)?|power(?:s)?.*unlock|metamorphos[ie]s?|no\s+longer\s+the\s+same|a\s+different\s+(?:person|being))\b/i,
  ],
  battle: [
    /\b(battle|war|siege|assault|charge[ds]?|clash(?:ed)?|armies|troops|reinforcement|victory|defeat|skirmish|warfare)\b/i,
  ],
  discovery: [
    /\b(discover(?:ed|y)?|found|unearth(?:ed)?|stumbl(?:ed)? upon|ancient|artifact|map|clue|treasure|hidden\s+(?:passage|room|door|chamber))\b/i,
  ],
  reunion: [
    /\b(reunion|reunite[ds]?|together again|returned|back again|long time|missed you|found (?:you|each other)|it['']s\s+(?:really\s+)?(?:you|them|her|him))\b/i,
  ],
  loss: [
    /\b(lost|lose|losing|stolen|taken|gone|vanish(?:ed)?|disappear(?:ed)?|ruin(?:ed)?|destroy(?:ed)?|can['']t\s+find|nowhere\s+to\s+be\s+(?:found|seen))\b/i,
  ],
};

// ─── Sarcasm & Negation Detection ──────────────────────────────

const NEGATION_WORDS = /\b(not|n't|never|hardly|barely|scarcely|no|neither|nor|without)\b/i;

const SARCASM_INDICATORS = [
  /\b(oh\s+how\s+\w+|oh\s+great|oh\s+wonderful|oh\s+joy|how\s+delightful|what\s+a\s+surprise)\b/i,
  /\b[A-Z]{4,}\b.*\b(obviously|clearly|definitely|totally|absolutely|surely)\b/i,
  /[""\u201C][^""\u201D]*\b(wonderful|great|fantastic|amazing|thrilled|delighted|lovely|perfect|terrific)\b[^""\u201D]*[""\u201D]/i,
];

function isNegatedOrSarcastic(keyword: string, content: string): boolean {
  const idx = content.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx === -1) return false;

  const prefixStart = Math.max(0, idx - 50);
  const prefix = content.slice(prefixStart, idx);
  if (NEGATION_WORDS.test(prefix)) return true;

  const sentenceStart = Math.max(0, content.lastIndexOf(".", idx - 1) + 1);
  const sentenceEnd = content.indexOf(".", idx);
  const sentence = content.slice(sentenceStart, sentenceEnd > idx ? sentenceEnd : idx + 60);
  if (SARCASM_INDICATORS.some((p) => p.test(sentence))) return true;

  const capsPrefix = content.slice(Math.max(0, idx - 20), idx);
  if (/\b[A-Z]{2,}\s*$/.test(capsPrefix)) return true;

  return false;
}

// ─── Narrative Density Signals ─────────────────────────────────

const INTERNAL_EXPERIENCE_VERBS = /\b(felt|realized|understood|decided|wondered|remembered|recognized|noticed|sensed|knew|believed|wished|regretted|considered|pondered|chose|accepted|acknowledged|feared|hoped|dreamed|imagined|questioned|doubted)\b/i;

const SCENE_CRAFT_MARKERS = /\b(silence|quietly|slowly|pause[ds]?|hesitat(?:ed|ion|ing)|moment|long\s+(?:pause|silence|moment)|without\s+(?:a\s+)?word|looked\s+away|turned\s+away|didn['']t\s+(?:look|speak|say|respond|answer|reply))\b/i;

const WEIGHTED_DIALOGUE_PATTERNS = [
  /[""\u201C][^""\u201D]{1,30}[""\u201D]\s*(?:,?\s*(?:she|he|they)\s+(?:said|whispered|murmured)\s+(?:softly|quietly|finally|at\s+last))/i,
  /(?:didn['']t\s+(?:say\s+anything|respond|answer|reply)|said\s+nothing|remained\s+silent|the\s+silence\s+(?:stretched|grew|hung|between))/i,
  /[""\u201C]\.{3}[""\u201D]/i,
];

const LORE_DENSITY_MARKERS = [
  /\b(according to|the (?:law|rule|custom|tradition|prophecy|legend) (?:of|says|states))\b/i,
  /\b(alliance|treaty|agreement|pact|contract|decree|edict)\s+(?:between|with|of)\b/i,
  /\b((?:was|is|has been)\s+(?:known as|called|named|titled))\b/i,
  /\b(heir|successor|predecessor|ancestor|lineage|bloodline|dynasty)\b/i,
];

// ─── NEW: Temporal Milestone Markers ───────────────────────────
// Phrases that signal a moment of narrative consequence

const MILESTONE_MARKERS = [
  /\b(for the (?:first|last) time|never (?:before|again)|once and for all|from (?:this|that) day)\b/i,
  /\b(everything (?:changed|would (?:never|change))|nothing (?:would (?:ever )?be|was ever) the same)\b/i,
  /\b(finally|at last|after (?:all (?:this|that) time|so long|everything)|in the end|the moment (?:had|has) (?:come|arrived))\b/i,
  /\b(point of no return|no (?:going|turning) back|too late (?:to|for)|there was no (?:stopping|undoing))\b/i,
];

// ─── NEW: Status-Quo Disruption ────────────────────────────────
// Signals that the narrative shifts — something changes

const DISRUPTION_MARKERS = [
  /\b(suddenly|but then|however|until|unexpectedly|without warning|out of nowhere|in (?:an|that) instant)\b/i,
  /\b(everything (?:changed|stopped|went (?:dark|silent|still|wrong))|the world (?:shifted|tilted|crumbled|spun))\b/i,
  /\b(that['']s when|then (?:it|she|he|they|everything)|and then|just (?:then|as))\b/i,
];

// ─── NEW: Dialogue Content Scoring ─────────────────────────────
// Analyzes what is said inside quotes for semantic weight

function scoreDialogueContent(content: string): number {
  const dialogueBlocks = content.match(/[""\u201C][^""\u201D]+[""\u201D]|[「][^」]+[」]/g) || [];
  if (dialogueBlocks.length === 0) return 0;

  let score = 0;

  for (const block of dialogueBlocks) {
    const text = block.slice(1, -1); // Strip quotes

    // Questions = information exchange or confrontation
    if (/\?/.test(text)) score += 0.015;

    // Short impactful lines (<20 chars): "I know.", "No.", "I'm sorry.", "Run."
    if (text.length < 25 && text.length > 1) score += 0.01;

    // Commitment/promise language
    if (/\b(I (?:will|won['']t|promise|swear)|you have my word|on my (?:life|honor))\b/i.test(text)) score += 0.04;

    // Revelation in dialogue
    if (/\b(I (?:need to|have to|should) tell you|the truth is|(?:you|I) (?:should|need to) know|there['']s something|it['']s (?:not|about))\b/i.test(text)) score += 0.035;

    // Emotional declarations
    if (/\b(I (?:love|hate|trust|forgive|can['']t forgive|miss|need) you|don['']t (?:leave|go|die)|stay (?:with me|here)|come (?:back|home))\b/i.test(text)) score += 0.04;

    // Decision/agency language
    if (/\b(I(?:['']ve| have)? (?:decided|chosen|made up my mind)|we (?:have to|must|need to|should)|it['']s (?:time|over|done|decided))\b/i.test(text)) score += 0.03;

    // Name-calling or direct address with emotional weight
    if (/\b(you (?:bastard|traitor|coward|liar|monster|fool)|how (?:dare|could) you)\b/i.test(text)) score += 0.025;
  }

  return Math.min(0.15, score);
}

// ─── NEW: Character-Agency Emotional Detection ─────────────────
// Characters performing emotional actions are more salient than environment

const CHARACTER_EMOTION_VERBS = /\b(cried|wept|screamed|laughed|smiled|trembled|shuddered|flinched|stared|froze|gasped|sighed|sobbed|grinned|blushed|paled|glared|winced|groaned|whimpered|beamed|flinched|recoiled|tensed|relaxed|brightened|darkened|softened|hardened|wavered|steadied|faltered|choked)\b/i;

function scoreCharacterAgency(content: string): number {
  // Match "[Name] [emotion_verb]" — a named character doing something emotional
  const matches = content.match(/\b[A-Z][a-z]+\s+(?:cried|wept|screamed|laughed|smiled|trembled|shuddered|flinched|froze|gasped|sighed|sobbed|grinned|blushed|paled|glared|winced|groaned|whimpered|beamed|flinched|recoiled|tensed|choked)\b/g) || [];

  // Also match "[pronoun] [emotion_verb]" preceded by a name in the same sentence
  const pronounMatches = content.match(/\b(?:she|he|they)\s+(?:cried|wept|screamed|laughed|smiled|trembled|shuddered|flinched|froze|gasped|sighed|sobbed|grinned|blushed|paled|glared|winced|groaned|whimpered|beamed|recoiled|tensed|choked)\b/gi) || [];

  const totalAgency = matches.length + pronounMatches.length * 0.6;
  return Math.min(0.10, totalAgency * 0.025);
}

// ─── NEW: Information Density ──────────────────────────────────
// High proper noun density = world-building or multi-character interaction

function scoreInformationDensity(content: string): number {
  const words = content.split(/\s+/);
  if (words.length < 10) return 0;

  // Count distinct proper nouns (capitalized words not at sentence start)
  const properNouns = new Set<string>();
  for (let i = 1; i < words.length; i++) {
    const word = words[i].replace(/[^a-zA-Z]/g, "");
    if (word.length >= 2 && /^[A-Z][a-z]/.test(word) && words[i - 1] !== ".") {
      properNouns.add(word.toLowerCase());
    }
  }

  // High proper noun density = information-rich scene
  const density = properNouns.size / words.length;
  return Math.min(0.08, density * 1.5);
}

// ─── NEW: Emotional Polarity Detection ─────────────────────────
// Mixed emotional polarity (both positive and negative in one chunk)
// signals complexity and high salience

const POSITIVE_TAGS: Set<EmotionalTag> = new Set(["joy", "intimacy", "resolve", "humor", "awe"]);
const NEGATIVE_TAGS: Set<EmotionalTag> = new Set(["grief", "dread", "betrayal", "fury"]);
// tension, revelation, melancholy are ambiguous/neutral

function detectPolarityMix(tags: EmotionalTag[]): number {
  let pos = 0, neg = 0;
  for (const tag of tags) {
    if (POSITIVE_TAGS.has(tag)) pos++;
    if (NEGATIVE_TAGS.has(tag)) neg++;
  }
  // Both positive and negative present = emotional complexity
  if (pos > 0 && neg > 0) return 0.08;
  return 0;
}

// ─── Scoring Engine ────────────────────────────────────────────

export function scoreChunkHeuristic(content: string): SalienceResult {
  const words = content.split(/\s+/);
  const wordCount = words.length;

  let score = 0;

  // ── Base score from length (diminishing returns) ──
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

  // ── Internal thought markers ──
  const hasInternalThought = INTERNAL_EXPERIENCE_VERBS.test(content);
  if (hasInternalThought) score += 0.06;

  // ── Narrative density: scene craft and subtlety ──
  if (SCENE_CRAFT_MARKERS.test(content)) score += 0.05;

  const weightedDialogueCount = WEIGHTED_DIALOGUE_PATTERNS.filter((p) => p.test(content)).length;
  if (weightedDialogueCount > 0) score += 0.05 * Math.min(1, weightedDialogueCount);

  // ── Lore density ──
  const loreDensityCount = LORE_DENSITY_MARKERS.filter((p) => p.test(content)).length;
  if (loreDensityCount > 0) score += 0.05 * Math.min(1, loreDensityCount);

  // ── Intensity markers (reduced — less combat/action bias) ──
  const intensityScore =
    ((content.match(INTENSITY_MARKERS.punctuation) || []).length) * 0.012 +
    ((content.match(INTENSITY_MARKERS.capsWords) || []).length) * 0.008 +
    ((content.match(INTENSITY_MARKERS.emphasis) || []).length) * 0.008;
  score += Math.min(0.08, intensityScore);

  // ── NEW: Dialogue content analysis ──
  score += scoreDialogueContent(content);

  // ── NEW: Character-agency emotional actions ──
  score += scoreCharacterAgency(content);

  // ── NEW: Information density ──
  score += scoreInformationDensity(content);

  // ── NEW: Temporal milestones ──
  const milestoneCount = MILESTONE_MARKERS.filter((p) => p.test(content)).length;
  if (milestoneCount > 0) score += 0.06 * Math.min(1, milestoneCount);

  // ── NEW: Status-quo disruption ──
  const disruptionCount = DISRUPTION_MARKERS.filter((p) => p.test(content)).length;
  if (disruptionCount > 0) score += 0.04 * Math.min(1, disruptionCount);

  // ── Emotional tags with sarcasm/negation filtering + intensity ──
  const emotionalTags: EmotionalTag[] = [];
  let emotionalWeight = 0;

  for (const [tag, patterns] of Object.entries(EMOTIONAL_PATTERNS)) {
    for (let pi = 0; pi < patterns.length; pi++) {
      const match = content.match(patterns[pi]);
      if (match) {
        const keyword = match[1] || match[0];
        if (!isNegatedOrSarcastic(keyword, content)) {
          emotionalTags.push(tag as EmotionalTag);

          // Compound phrases (earlier patterns) get higher weight than single-word
          const baseWeight = pi < patterns.length - 1 ? 0.05 : 0.035;
          const intensityMod = getIntensityModifier(keyword, content);
          emotionalWeight += baseWeight * intensityMod;
        }
        break;
      }
    }
  }
  score += emotionalWeight;

  // ── Narrative flags ──
  const narrativeFlags: NarrativeFlag[] = [];
  for (const [flag, patterns] of Object.entries(NARRATIVE_FLAG_PATTERNS)) {
    if (patterns.some((p) => p.test(content))) {
      narrativeFlags.push(flag as NarrativeFlag);
      score += 0.06;
    }
  }

  // ── Complexity bonuses ──
  if (emotionalTags.length >= 3) score += 0.07;
  if (narrativeFlags.length >= 2) score += 0.06;

  // Mixed dialogue + introspection = character development
  if (hasDialogue && hasInternalThought) score += 0.05;
  // Scene craft + dialogue = deliberate weighted scene
  if (SCENE_CRAFT_MARKERS.test(content) && hasDialogue) score += 0.04;

  // ── NEW: Emotional polarity mix = complexity ──
  score += detectPolarityMix(emotionalTags);

  // ── NEW: Milestone + emotional = pivotal moment ──
  if (milestoneCount > 0 && emotionalTags.length > 0) score += 0.05;

  // ── NEW: Disruption + narrative flag = climactic event ──
  if (disruptionCount > 0 && narrativeFlags.length > 0) score += 0.04;

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
 * Detect dominant emotional tones in a text snippet.
 * Used at query time for associative recall. Includes sarcasm filtering
 * and returns tags ordered by confidence (compound match > single-word).
 */
export function detectEmotionalTags(content: string): EmotionalTag[] {
  const tags: Array<{ tag: EmotionalTag; confidence: number }> = [];

  for (const [tag, patterns] of Object.entries(EMOTIONAL_PATTERNS)) {
    for (let pi = 0; pi < patterns.length; pi++) {
      const match = content.match(patterns[pi]);
      if (match) {
        const keyword = match[1] || match[0];
        if (!isNegatedOrSarcastic(keyword, content)) {
          // Earlier pattern = higher confidence (compound > single-word)
          const confidence = pi < patterns.length - 1 ? 0.8 : 0.5;
          const intensityMod = getIntensityModifier(keyword, content);
          tags.push({ tag: tag as EmotionalTag, confidence: confidence * intensityMod });
        }
        break;
      }
    }
  }

  // Sort by confidence descending
  tags.sort((a, b) => b.confidence - a.confidence);
  return tags.map((t) => t.tag);
}
