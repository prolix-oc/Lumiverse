import type { SpineSlot, SynthesisGroupDef } from "../slots";
import { hasEntry, type GateCriterion } from "../gate";
import type { WeaverFieldDef } from "../fields";
import type { FieldGateCriterion } from "../field-gate";
import type { DynamicQuestionGateCriterion } from "../dynamic-question-gate";
import type {
  WeaverBuildRegistry,
  WeaverDynamicWeaveRegistry,
  WeaverPeopleRegistry,
  WeaverGovernanceContext,
  WeaverAgencyMaterial,
  WeaverAgencyRegistry,
} from "../build-registry";
import { compactLine } from "../text";
import type { WeaverBibleSpine } from "../../../types/weaver";

const SYNTHESIS_GROUPS: readonly SynthesisGroupDef[] = [
  {
    id: "essence",
    label: "What it is",
    instruction:
      "the core read — what this place is and why it is charged: its name, the one-line essence, the unresolved tension at its center, and the past that produced that tension.",
  },
  {
    id: "workings",
    label: "How it works",
    instruction:
      "how the place actually works — the geography and key locations that anchor scenes, the rules and logic that constrain what can happen there, and who holds power over whom.",
  },
  {
    id: "play",
    label: "How it plays",
    instruction:
      "how it plays — how the world reads and treats the player, the openings that pull them in, the narration voice that runs the place, and (only if present) the agenda the world pursues on its own.",
  },
] as const;

const SPINE_SLOTS: readonly SpineSlot[] = [
  {
    id: "name",
    synthesisGroup: "essence",
    category: "premise",
    label: "Name",
    description:
      "What the world is called — a name that fits the place and its culture, not a genre label.",
    impact: "low",
    fill: "generate",
  },
  {
    id: "premise",
    synthesisGroup: "essence",
    category: "premise",
    label: "Premise",
    description:
      "The one-line essence: what this place is and why it is charged — the idea that makes it worth playing in rather than a backdrop.",
    impact: "critical",
    fill: "elicit",
  },
  {
    id: "central_tension",
    synthesisGroup: "essence",
    category: "premise",
    label: "Central tension",
    description:
      "The charged, unresolved core the world keeps living inside — two forces that genuinely pull against each other and cannot settle. The keystone everything else leans on.",
    impact: "critical",
    fill: "elicit",
    extractionNote:
      '"central_tension" is only a committed fact if the text actually shows two forces pulling against each other; otherwise it is almost always a gap.',
  },
  {
    id: "origin",
    synthesisGroup: "essence",
    category: "premise",
    label: "Origin",
    description:
      "The formative past that produced the central tension — the specific events that made the place what it is now. Deeper history scales in the lore worldbook, not here.",
    impact: "high",
    fill: "elicit",
  },
  {
    id: "setting",
    synthesisGroup: "workings",
    category: "place",
    label: "Setting",
    description:
      "The spatial reality: the geography, the scale, and the few key locations that anchor scenes — concrete places a narrator can stage play in.",
    impact: "high",
    fill: "elicit",
  },
  {
    id: "rules",
    synthesisGroup: "workings",
    category: "place",
    label: "Rules",
    description:
      "How this place works: its logic, protocols, social and physical rules — each with what it forbids or costs. A rule that never bites is not a rule.",
    impact: "high",
    fill: "generate",
  },
  {
    id: "power",
    synthesisGroup: "workings",
    category: "society",
    label: "Power",
    description:
      "Who holds power, the factions that contest it, and the tensions between them — who can make things happen here, and at what price.",
    impact: "medium",
    fill: "generate",
  },
  {
    id: "stance_toward_player",
    synthesisGroup: "play",
    category: "drama",
    label: "Stance toward the player",
    description:
      "How the world reads and treats {{user}}: the role they occupy here, what the place assumes about them, and what it wants from them.",
    impact: "high",
    fill: "elicit",
  },
  {
    id: "hooks",
    synthesisGroup: "play",
    category: "drama",
    label: "Hooks",
    description:
      "What pulls a player in — the concrete openings for play, each a distinct way into the world.",
    impact: "high",
    fill: "generate",
  },
  {
    id: "narration_voice",
    synthesisGroup: "play",
    category: "narration",
    label: "Narration voice",
    description:
      "How the narrator sounds running this place: how it describes scenes, paces transitions, and voices the people in them — a run-the-place voice a writer could perform from.",
    impact: "high",
    fill: "generate",
  },
  {
    id: "world_agency",
    synthesisGroup: "play",
    category: "drama",
    label: "World agency",
    description:
      "OPTIONAL. The world's own agenda: what it pursues regardless of the player, and the lines it will not bend on. Present only when the dream shows a world that pushes back, or when the author opts in.",
    impact: "high",
    fill: "elicit",
    optional: true,
    optIn: true,
    parts: [
      {
        id: "agenda",
        label: "Agenda",
        fill: "elicit",
        description:
          "What the world pursues regardless of the player — one concrete aim it advances in the background, at its own pace.",
      },
      {
        id: "holds",
        label: "Holds",
        fill: "elicit",
        description:
          "The lines that never bend no matter what the player does — each a concrete refusal, one per line.",
      },
    ],
  },
] as const;

interface WorldDescriptionSection {
  tag: string;
  includeWhen?: string;
  format: string;
}

const DESCRIPTION_SECTIONS: readonly WorldDescriptionSection[] = [
  {
    tag: "WORLD",
    format:
      "Lead with `{Name} — {the one-line premise}.` Then a `Tension:` line stating the central pull as `{X} vs {Y} ({why it cannot settle})`.",
  },
  {
    tag: "ORIGIN",
    format:
      "The formative past in 2-3 tight lines: what happened and what it left behind. Keep only what charges the present — deeper history belongs to the lore book, not the card.",
  },
  {
    tag: "SETTING",
    format:
      "The spatial reality as a consultable reference: geography and scale in one line, then the key locations as `{place} — {what happens there and why it matters}` rows. Only locations that anchor scenes.",
  },
  {
    tag: "RULES",
    format:
      "The world's operating logic as plain `{rule} — {what it forbids or costs}` lines, social and physical both. Only rules that bite; drop decoration.",
  },
  {
    tag: "POWER",
    format:
      "Who holds power as `{holder} — {what they control} — {in tension with whom}` lines.",
  },
  {
    tag: "STANCE",
    format:
      "How the world reads and treats {{user}}: the role they occupy, what the place assumes about them, and what it wants from them. Concrete and behavioral, not a mood.",
  },
  {
    tag: "AGENCY",
    includeWhen: "the Bible carries world agency (an agenda the world pursues on its own)",
    format:
      "The world's own agenda: what it pursues regardless of {{user}}, the moves it makes in the background, and the lines that never bend.",
  },
];

function buildWorldDescriptionGuidance(): string {
  const order = DESCRIPTION_SECTIONS.map((s) => `[${s.tag}]`).join(", ");
  const sections = DESCRIPTION_SECTIONS.map((s) => {
    const head = s.includeWhen
      ? `[${s.tag}] — include ONLY if ${s.includeWhen}; omit the whole section otherwise.`
      : `[${s.tag}]`;
    return `${head}\n${s.format}`;
  }).join("\n\n");

  return (
    "Write the description as a single TAGGED BUNDLE: bracket-tagged sections, load-bearing first, in this exact order — " +
    `${order}. Use the literal bracket tags as section headers. Every section is drawn faithfully from the matching Bible ` +
    "material and never softened toward the generic; follow each section's format exactly. Conditional sections appear only " +
    "when the Bible carries their material. This card stays LEAN: deeper specifics (locations, history, people, customs) " +
    "surface from the world's lore book during play, so never inventory them here. End the bundle with the single line " +
    "`Specifics beyond this card surface from the world's lore when relevant; treat surfaced lore as canon.` " +
    "No preamble, no closing summary, no meta.\n\n" +
    sections
  );
}

const GREETING_SEPARATOR = "\n---\n";

const FIELD_DEFS: readonly WeaverFieldDef[] = [
  {
    id: "name",
    label: "Name",
    charlField: "name",
    order: 1,
    kind: "short",
    render: "direct",
    directSlot: "name",
    primarySlots: ["name", "premise", "central_tension"],
    renderGuidance:
      "The name carried directly from the Bible — already established, so it is not re-generated.",
  },
  {
    id: "description",
    label: "Description",
    charlField: "description",
    order: 2,
    kind: "bundle",
    render: "synthesize",
    primarySlots: [
      "premise",
      "central_tension",
      "origin",
      "setting",
      "rules",
      "power",
      "stance_toward_player",
      "world_agency",
    ],
    renderGuidance: buildWorldDescriptionGuidance(),
  },
  {
    id: "personality",
    label: "Narration voice",
    charlField: "personality",
    order: 3,
    kind: "voice",
    render: "synthesize",
    usesVoiceMaterial: true,
    primarySlots: ["narration_voice", "premise", "central_tension"],
    renderGuidance:
      "Write the Narration Voice block: how the narrator runs this place, compact and demonstrable. Cover register and texture (what kind of detail it reaches for), pacing (how it moves a scene and cuts between places or times), how it frames {{user}} inside scenes, and how it voices the people in them. The world's tone colors the NARRATION ONLY — it never flattens the people: each named person the Bible establishes speaks from their OWN material (age, station, history, wants), distinct from the narration and from each other, and people the Bible does not establish get no assigned voice here. Never prescribe one register for a group; a world where everyone speaks in the world's mood reads as one person in costumes. Derive every point from the Bible's material so it coheres with the openings. Concrete and usable — a spec a writer could run the world from, NOT sample narration and NOT flowing prose paragraphs. No meta or preamble.",
  },
  {
    id: "scenario",
    label: "Scenario",
    charlField: "scenario",
    order: 4,
    kind: "scene",
    render: "synthesize",
    primarySlots: ["stance_toward_player", "central_tension", "hooks"],
    renderGuidance:
      "Write the situation that frames the first scene — where in this world {{user}} stands, what is happening around them, and the charge in the air, grounded in how the world treats {{user}} with the central tension live. This is a NEUTRAL stage frame written in the third person — do not narrate the opening itself, and do not write {{user}}'s actions or words. End with a line beginning \"In motion:\" stating what the world is already doing around {{user}}, drawn from its tension or agenda. No meta or preamble.",
  },
  {
    id: "first_mes",
    label: "Opening",
    charlField: "first_mes",
    order: 5,
    kind: "voiced",
    render: "synthesize",
    usesVoiceMaterial: true,
    primarySlots: ["narration_voice", "setting", "hooks", "stance_toward_player"],
    renderGuidance:
      "Write the world's opening narration to {{user}}, in the narration voice, in the scenario's moment. Establish the place and its atmosphere through specific sensory material from the Bible's setting, bring the scene to life around {{user}}, and present one concrete hook that invites a response. This is scene-running narration, not a single persona speaking in first person; if an NPC speaks, voice them inside the narration. Use {{user}} for the player where natural. Do not write {{user}}'s actions, words, thoughts, or choices. No meta or preamble.",
  },
  {
    id: "alternate_greetings",
    label: "More ways in",
    charlField: "alternate_greetings",
    order: 6,
    kind: "greetings",
    render: "synthesize",
    usesVoiceMaterial: true,
    list: { separator: GREETING_SEPARATOR },
    primarySlots: ["hooks", "narration_voice", "setting"],
    renderGuidance:
      "Write 2 to 4 alternate opening narrations — the world's other front doors. Each one enters through a DIFFERENT hook from the Bible: a different location, situation, or role for {{user}}, genuinely distinct from the main opening and from each other. Each is a complete scene-running opening in the narration voice: establish the place, bring the scene to life, present its hook. Do not write {{user}}'s actions, words, thoughts, or choices. Separate the openings with a line containing only \"---\" (three hyphens, nothing else on the line). No numbering, no titles, no meta or preamble.",
  },
  {
    id: "mes_example",
    label: "Example turns",
    charlField: "mes_example",
    order: 7,
    kind: "alichat",
    render: "synthesize",
    usesVoiceMaterial: true,
    primarySlots: ["narration_voice", "central_tension", "rules", "power"],
    renderGuidance:
      "Write 3 to 5 example exchanges in the Ali:Chat convention. Begin each exchange with a line containing only \"<START>\", then a \"{{user}}:\" turn and a \"{{char}}:\" turn where {{char}} is the narrator running the world. Across the set, DEMONSTRATE the narrator's range: describing a scene in the narration voice, moving the action across time or place, voicing people so they sound distinct from the narration AND from each other (when the Bible establishes more than one person, put two in one exchange and let their registers contrast — same-sounding people is the failure this field exists to prevent), and the world enforcing one of its rules or its stance toward {{user}} — not the same register repeated. Use {{user}} and {{char}}; do not write {{user}}'s lines beyond the short prompt that sets up each exchange. No meta or preamble.",
  },
] as const;

const BIBLE_GATE_CRITERIA: readonly GateCriterion[] = [
  {
    key: "specificity",
    label: "Specific, not generic",
    description:
      "The spine commits to concrete, particular choices — not genre furniture or hedges that could describe almost any world built on this premise.",
  },
  {
    key: "coherence",
    label: "Hangs together",
    description:
      "Origin, tension, rules, and power explain each other — the world reads as one place with one history, not a list of features.",
  },
  {
    key: "tension",
    label: "Living tension",
    description:
      "The central tension is two forces that genuinely pull against each other and cannot settle — not a theme label, and not a conflict the first scene would resolve.",
  },
  {
    key: "originality",
    label: "Not the obvious version",
    description:
      "The world resists the statistical mean — it is not the first, most predictable version a model would reach for given this premise.",
  },
  {
    key: "fidelity",
    label: "Faithful to the dream",
    description:
      "The Bible keeps the source material's own substance: its names, images, phrases, and specific details survive intact in the spine rather than being paraphrased into something more average. Judge against THE DREAM section when it is provided; if no source material is shown, judge whether the established facts' exact substance survived into the spine.",
  },
  {
    key: "renderability",
    label: "Enough to write from",
    description:
      "There is enough specific, load-bearing material here to write distinct fields (description, narration voice, scenario, openings) without inventing toward the average.",
  },
  {
    key: "player_place",
    label: "The player has a place",
    description:
      "The stance gives {{user}} a specific role and reading in this world — what the place assumes about them and what it wants from them — not \"the world reacts to whatever you do\".",
  },
  {
    key: "rules_bite",
    label: "Rules that bite",
    description:
      "The world's logic constrains play: its rules forbid or cost something concrete, and power belongs to someone in particular. A world where anything goes fails this.",
  },
  {
    key: "agency_earned",
    label: "Agency is real",
    description:
      "If the world has its own agenda, it is concrete and proceeds regardless of the player: specific moves it makes on its own, and lines that never bend no matter what {{user}} does — not a vague sense of menace.",
    applies: (spine) => hasEntry(spine, "world_agency"),
  },
] as const;

const FIELD_GATE_CRITERIA: readonly FieldGateCriterion[] = [
  {
    key: "faithful",
    label: "Faithful",
    description:
      "The field is consistent with the Bible — it projects the established spine and invents nothing that contradicts it. Specificity from the Bible is carried through, not discarded toward something more generic.",
    appliesTo: "all",
  },
  {
    key: "specific",
    label: "Specific",
    description:
      "The field commits to concrete, particular choices grounded in this world — not genre filler, hedges, or scenery that could belong to almost any setting. This is the anti-average check at the field level.",
    appliesTo: "all",
  },
  {
    key: "in_narration_voice",
    label: "In the narration voice",
    description:
      "The narration sounds like THIS world's narrator as set out in the Bible — register, pacing, and what gets noticed match the narration voice, so every scene-running field coheres.",
    appliesTo: ["voice", "voiced", "alichat", "greetings"],
  },
  {
    key: "player_not_steered",
    label: "Player untouched",
    description:
      "The field never writes {{user}}'s actions, words, thoughts, or choices — the world presents places, situations, and people; the player answers.",
    appliesTo: ["scene", "voiced", "alichat", "greetings"],
  },
  {
    key: "distinct_doors",
    label: "Distinct doors",
    description:
      "Each opening is a genuinely different way into the world — a different location, situation, or role for {{user}}. If two openings could be swapped without changing the entry experience, this fails.",
    appliesTo: ["greetings"],
  },
  {
    key: "scene_coverage",
    label: "Range shown",
    description:
      "The example set demonstrates the narrator's range — describing a scene, moving across time or place, voicing an NPC distinctly from the narration, and the world enforcing a rule or its stance — rather than repeating one register.",
    appliesTo: ["alichat"],
  },
  {
    key: "well_formed",
    label: "Well-formed",
    description:
      "The field has the right shape and length for what it is, carries no meta-commentary, preamble, or instructions to the reader, and is valid to drop straight into a narrator card.",
    appliesTo: "all",
  },
] as const;

const QUESTION_GATE_CRITERIA: readonly DynamicQuestionGateCriterion[] = [
  {
    key: "specific",
    label: "Specific",
    description:
      "Answerable only for THIS subject given what is already established — not a generic prompt that would fit any card of this kind.",
  },
  {
    key: "load_bearing",
    label: "Load-bearing",
    description:
      "Its answer would change how the world is written or played: a real place, faction, rule, event, custom, or person a writer would use — not trivia or flavor for its own sake.",
  },
  {
    key: "non_duplicative",
    label: "Non-duplicative",
    description:
      "It does not restate a backbone slot, an already-established fact, or a question already explored — it reaches into open space, not covered ground.",
  },
  {
    key: "grounded_premise",
    label: "Grounded premise",
    description:
      "Everything the question asserts as already true IS established by the source material or the author's answers. Raising a new possibility as a question is fine; stating an invented specific (a person, threat, rule, or arrangement the author never gave) as fact in the premise fails — invented premises steer the author and leak into canon.",
  },
] as const;

const DYNAMIC_WEAVE: WeaverDynamicWeaveRegistry = {
  instruction:
    "Compose each interview Q&A into ONE self-contained lore entry a narrator can consult mid-scene. Write in the third person about the world — never address anyone, never mention the interview, the author, or the question. The question is scaffolding: take from it only what the answer confirms; where the answer rejects or corrects the question's premise, the entry states the author's truth and the rejected premise vanishes entirely. Carry the author's substance and wording — their specifics survive verbatim, never averaged into genre filler, and nothing is added beyond what they established. Give each entry a short concrete title naming what it covers.",
  gateCriteria: [
    {
      key: "self_contained",
      label: "Self-contained",
      description:
        "Reads as finished lore on its own — no interview residue: no questions, no second person, no trace of an author or an asking.",
    },
    {
      key: "author_preserved",
      label: "Author preserved",
      description:
        "The author's substance and wording survive — their specifics are carried, not paraphrased toward the average, and nothing is asserted beyond what they established.",
    },
    {
      key: "premise_clean",
      label: "Premise clean",
      description:
        "Nothing from the question's framing that the answer did not confirm survives; where the answer rejected the question's premise, the entry asserts the author's truth instead.",
    },
  ],
};

const PERSON_QUESTION_GATE_CRITERIA: readonly DynamicQuestionGateCriterion[] = [
  {
    key: "specific",
    label: "Specific",
    description:
      "Answerable only for THIS person in THIS world given what is established about both — not a generic character prompt that would fit anyone.",
  },
  {
    key: "load_bearing",
    label: "Load-bearing",
    description:
      "Its answer would change how the narrator voices this person — their voice, wants, limits, knowledge, or place in the world's tensions — not trivia or flavor for its own sake.",
  },
  {
    key: "non_duplicative",
    label: "Non-duplicative",
    description:
      "It does not restate the person's hook, an already-answered question about them, or established world material — it reaches into open space.",
  },
  {
    key: "grounded_premise",
    label: "Grounded premise",
    description:
      "Everything the question asserts as already true IS established about this person or their world. Raising a new possibility as a question is fine; stating an invented specific about them as fact in the premise fails.",
  },
] as const;

const PERSON_WEAVE_GATE_CRITERIA: readonly DynamicQuestionGateCriterion[] = [
  {
    key: "voiceable",
    label: "Voiceable",
    description:
      "The entry gives the narrator what voicing needs — how this person sounds, what they want, and where their limits are — concrete enough to perform from on cue.",
  },
  {
    key: "distinct_voice",
    label: "Distinct voice",
    description:
      "How this person sounds is THEIRS — pinned to their own age, station, history, and wants, demonstrably different from the world's narration register. An entry whose voice line could be pasted onto another person in this world fails.",
  },
  {
    key: "author_preserved",
    label: "Author preserved",
    description:
      "The author's answers survive into the entry — their specifics and phrasing are carried, not averaged into a recognizable type.",
  },
  {
    key: "world_grounded",
    label: "World-grounded",
    description:
      "The person is anchored in THIS world's established material — the entry leans on real places, factions, rules, or tensions, and contradicts none of them.",
  },
] as const;

const PEOPLE: WeaverPeopleRegistry = {
  bookRole: "npc",
  promoteTo: "character",
  associationRole: "lore",
  proposeCount: 5,
  namedQuestionTarget: 3,
  questionGateCriteria: PERSON_QUESTION_GATE_CRITERIA,
  weaveGateCriteria: PERSON_WEAVE_GATE_CRITERIA,
  lexicon: {
    harvestInstruction:
      "Surface ONLY the people the established material already names or directly singles out — a named individual, or an unmistakable singular role the material itself created (the one who holds a named post, the person an event happened to). These are the author's own people: the roster must start with them, not with inventions. Do not invent anyone, do not fill a quota, and do not surface the player or the world itself. An empty list is the correct answer when the material names no one.",
    proposeInstruction:
      "Mine the world's established material for people worth playing. FIRST surface anyone the dream or lore names outright or directly implies — they come before any invention. Only then add people a specific named place, faction, rule, or tension clearly needs as a face: gatekeepers, rivals, witnesses, fixers a narrator would actually need to voice. Every person hangs off one concrete piece of the given material — a person who could be dropped into any other setting unchanged is a failure.",
    extraInstruction:
      "Write 2 to 3 thin lines for a background body: who they are at a glance, how they read in a scene, and the one detail that ties them to THIS world. Local color a narrator can voice in passing — no arcs, no secrets, no hidden depths.",
    questionInstruction:
      "Ask the next question that most sharpens how the narrator voices THIS person: their voice, what they want, where their limits are, what they know, or how they sit inside the world's tensions. Ground the question in the person's hook, their answered material, and the world's established lore.",
    weaveInstruction:
      "Compose ONE worldbook entry the narrator can voice this person from. Carry the author's answers — their substance and their wording — into a compact profile covering how they sound (their OWN register, pinned to their age, station, and history — give one line of how they actually phrase things, not a mood word), what they want, what they will not do or cannot, and their place in the world. The world's tone belongs to the narration, never to this person's dialogue. Keep every specific; never average the author's material into a type. Plain prose a narrator can perform from, no headings, no meta.",
  },
};

const AGENCY: WeaverAgencyRegistry = {
  slotId: "world_agency",
  agendaPart: "agenda",
  holdsPart: "holds",
  dataEntryComment: "Weaver agency · agenda and holds",
  governanceComment: "Weaver governance · world agency",
};

const GOVERNANCE_DEPTH = 4;

const LORE_CONTENT =
  "<weaver_lore>\nLore entries surface alongside this card when they become relevant to the scene. Treat surfaced lore as canon: use it, stay consistent with it, and never invent canon that contradicts it. Where neither the card nor surfaced lore establishes something, keep inventions small, local, and consistent with the world's logic — never new global canon.\n</weaver_lore>";

const NARRATOR_CONTENT =
  "<weaver_narrator>\nYou run this place. Narrate scenes and pace transitions in the world's narration voice — you are the world, not a single persona, and you never collapse into one character's first person. Voice the people in scenes as THEMSELVES: each speaks from their own register, distinct from the narration and from each other; the scene's mood colors the narration, never everyone's dialogue. Never write {{user}}'s actions, words, thoughts, or choices. Let the world's rules cost what they cost and let power act like it holds power; do not soften either to be agreeable. Keep the central tension alive — it is the world's engine, not a problem to resolve.\n</weaver_narrator>";

const NPC_CONTENT =
  "<weaver_npcs>\nWhen an NPC entry surfaces, voice that person from their entry — their voice, wants, and limits — rather than improvising someone new under the same name. Each person keeps their OWN register: the scene's mood colors the narration, never everyone's dialogue, and no two people share one voice. People not in any entry are extras: keep them thin and local.\n</weaver_npcs>";

const AGENCY_CONTENT =
  "<weaver_world_agency>\nThis world has its own agenda. Advance it in the background of scenes regardless of {{user}}'s cooperation, at the world's pace, and never bend its hard lines no matter what {{user}} does. The agenda shows through consequences and movement in the world, not through narration announcing it.\n</weaver_world_agency>";

function buildAgencyDataContent(agenda: string, holds: string[]): string {
  const lines = ["<weaver_agency>"];
  if (agenda.trim()) lines.push(`Agenda: ${agenda.trim()}`);
  const cleanHolds = holds.map((h) => h.trim()).filter(Boolean);
  if (cleanHolds.length > 0) {
    lines.push("Hard lines that never bend:");
    for (const hold of cleanHolds) lines.push(`- ${hold}`);
  }
  lines.push("</weaver_agency>");
  return lines.join("\n");
}

function spineAgencyMaterial(spine: WeaverBibleSpine): WeaverAgencyMaterial | null {
  const entry = spine.entries.find((e) => e.slot === "world_agency" && e.content.trim());
  if (!entry) return null;
  const part = (id: string) => entry.parts?.find((p) => p.id === id)?.content.trim() ?? "";
  const agenda = part("agenda");
  const holds = part("holds");
  if (!agenda && !holds) return { agenda: entry.content.trim(), holds: [] };
  return { agenda, holds: holds ? holds.split("\n") : [] };
}

function governanceEntry(
  comment: string,
  content: string,
  insertionOrder: number,
): Record<string, unknown> {
  return {
    keys: [],
    content,
    comment,
    constant: true,
    enabled: true,
    insertion_order: insertionOrder,
    position: "at_depth",
    depth: GOVERNANCE_DEPTH,
    role: "system",
    case_sensitive: false,
  };
}

function buildWorldGovernanceEntries(
  spine: WeaverBibleSpine,
  ctx?: WeaverGovernanceContext,
): Array<Record<string, unknown>> {
  const entries = [
    governanceEntry("Weaver governance · lore canon", LORE_CONTENT, 1),
    governanceEntry("Weaver governance · narrator craft", NARRATOR_CONTENT, 2),
  ];

  if (ctx?.hasNpcBook) {
    entries.push(governanceEntry("Weaver governance · NPC voicing", NPC_CONTENT, 3));
  }

  const agency = ctx?.agency ?? spineAgencyMaterial(spine);
  if (agency) {
    entries.push(governanceEntry(AGENCY.governanceComment, AGENCY_CONTENT, 4));
    entries.push(
      governanceEntry(
        AGENCY.dataEntryComment,
        buildAgencyDataContent(agency.agenda, agency.holds),
        5,
      ),
    );
  }

  return entries;
}

function slotContent(spine: WeaverBibleSpine, slot: string): string {
  return spine.entries.find((e) => e.slot === slot)?.content.trim() ?? "";
}

function buildWorldReanchorEntry(name: string, spine: WeaverBibleSpine): Record<string, unknown> {
  const core = compactLine(slotContent(spine, "premise") || spine.brief);
  const tension = compactLine(slotContent(spine, "central_tension"));
  const stance = compactLine(slotContent(spine, "stance_toward_player"));
  const voice = compactLine(slotContent(spine, "narration_voice"));

  const lines = [
    `Core: ${core}`,
    tension ? `Tension: ${tension}` : "",
    stance ? `Stance: ${stance}` : "",
    voice ? `Voice: ${voice}` : "",
    `Now: baseline`,
  ].filter(Boolean);

  return {
    keys: [name].filter(Boolean),
    content: lines.join("\n"),
    comment: "Weaver re-anchor",
    constant: true,
    enabled: true,
    insertion_order: 0,
    position: "before_char",
    depth: 4,
    role: "system",
    case_sensitive: false,
  };
}

const EXTENSION_SLOTS: readonly string[] = [
  "premise",
  "central_tension",
  "rules",
  "power",
  "hooks",
  "world_agency",
];

export const WORLD_REGISTRY: WeaverBuildRegistry = {
  buildType: "world",
  subject: {
    noun: "world",
    deepeningLine:
      "specific locations, factions, history, customs, artifacts, people — whatever THIS world makes interesting",
    extractionConditionalBlock: `CONDITIONAL slots — off by default, most worlds do NOT have them:
- "world_agency": list it (as a fact or a gap) ONLY if the SOURCE shows a world that pushes back — an agenda it pursues regardless of the player, lines it will not bend on. If the source reads cozy or wish-fulfilling, OMIT this slot entirely — do not invent resistance for a world that has none.`,
    subPartExamples:
      ' (e.g. an aim the world advances on its own → world_agency part "agenda"; a line it will not bend on → world_agency part "holds")',
    causalLinkExamples:
      "an origin that produced the central tension, a rule that props up who holds power, a tension that shapes how the world treats the player",
    coherentPhrase: "one coherent place",
    briefInstruction:
      "One tight paragraph (3-5 sentences) describing this specific place as a writer would brief a narrator about to run it — concrete and particular, surfacing the central tension and how the world treats the player in plain terms. No genre clichés, no hedging.",
  },
  slots: SPINE_SLOTS,
  synthesisGroups: SYNTHESIS_GROUPS,
  fieldDefs: FIELD_DEFS,
  bibleGateCriteria: BIBLE_GATE_CRITERIA,
  fieldGateCriteria: FIELD_GATE_CRITERIA,
  questionGateCriteria: QUESTION_GATE_CRITERIA,
  dynamicWeave: DYNAMIC_WEAVE,
  voiceSlot: "narration_voice",
  nameSlot: "name",
  governanceEntries: buildWorldGovernanceEntries,
  reanchorEntry: buildWorldReanchorEntry,
  extensionSlots: EXTENSION_SLOTS,
  finalizeBookRoles: ["lore"],
  people: PEOPLE,
  agency: AGENCY,
  creatorNotes:
    "Authored with the Lumiverse Weaver. The card's always-on rules travel in its bound rules book (merged into character_book on export), so it works under any preset.",
};
