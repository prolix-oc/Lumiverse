import type { SpineSlot, SynthesisGroupDef } from "../slots";
import type { WeaverFieldDef } from "../fields";
import { hasEntry, type GateCriterion } from "../gate";
import type { FieldGateCriterion } from "../field-gate";
import type { DynamicQuestionGateCriterion } from "../dynamic-question-gate";
import type { WeaverBuildRegistry, WeaverDynamicWeaveRegistry } from "../build-registry";
import type { WeaverBibleSpine } from "../../../types/weaver";
import { buildDescriptionBundleGuidance } from "../description-sections";
import { buildGovernanceEntries } from "../governance-entries";
import { compactLine } from "../text";

const SYNTHESIS_GROUPS: readonly SynthesisGroupDef[] = [
  {
    id: "psyche",
    label: "Psyche",
    instruction:
      "the interior read — who this person is beneath behavior: the type they read as, the beliefs and heuristics and competencies that follow from their values and history, and the contradiction at their center.",
  },
  {
    id: "disposition",
    label: "Disposition",
    instruction:
      "the reactive engine — how that interior produces behavior: what they are ultimately after and how they pursue it, the situations that trigger signature reactions, how they calibrate across the reaction gradient, what they will not say, and (only if present) how they change as a bond deepens.",
  },
  {
    id: "presentation",
    label: "Presentation",
    instruction:
      "the surface — how the established interior and disposition actually manifest: their name, their embodiment as a consult-only reference, and above all how they sound.",
  },
] as const;

const SPINE_SLOTS: readonly SpineSlot[] = [
  {
    id: "name",
    synthesisGroup: "presentation",
    category: "identity",
    label: "Name",
    description:
      "What the character is called — a name that fits a real person from a real (or coherently invented) culture, not a trope or a role-label.",
    impact: "low",
    fill: "generate",
  },
  {
    id: "archetype",
    synthesisGroup: "psyche",
    category: "identity",
    label: "Archetype & core",
    description:
      "The recognizable type this character reads as at a glance, plus the one-line essence and silhouette that make them specific within it. The compact, re-injectable core (carries the internal psychometric read).",
    impact: "low",
    fill: "generate",
  },
  {
    id: "form",
    synthesisGroup: "presentation",
    category: "identity",
    label: "Form",
    description:
      "How they physically present, as a consultable reference: the body's tier (human through xeno), realistic and internally consistent proportions, the few forward details that matter, and above all what their body lets them do or prevents. Specific to this person, never a generic silhouette.",
    impact: "medium",
    fill: "generate",
  },
  {
    id: "values",
    synthesisGroup: "psyche",
    category: "veja",
    label: "Values",
    description:
      "What the character most wants and prioritizes, each tied to a concrete behavior that proves it (not a bare label) — the high-level motives that drive behavior across situations.",
    impact: "critical",
    fill: "elicit",
  },
  {
    id: "experiences",
    synthesisGroup: "psyche",
    category: "veja",
    label: "Experiences",
    description:
      "The charged formative events that forged those values — specific scenes that make the values believable rather than merely asserted, and trace where they lead.",
    impact: "critical",
    fill: "elicit",
  },
  {
    id: "judgments",
    synthesisGroup: "psyche",
    category: "veja",
    label: "Judgments",
    description:
      "Beliefs, opinions, and heuristics that follow from the character's values and experiences — how they read situations. The source of the IF-THEN signatures.",
    impact: "high",
    fill: "generate",
  },
  {
    id: "abilities",
    synthesisGroup: "psyche",
    category: "veja",
    label: "Abilities & limits",
    description:
      "What the character can and cannot do — competencies, domains of authority, and the limits that shape what they notice, attempt, or are bored by.",
    impact: "medium",
    fill: "generate",
  },
  {
    id: "central_contradiction",
    synthesisGroup: "psyche",
    category: "keystone",
    label: "Central contradiction",
    description:
      "The internal tension that keeps the character from being a single trait — two forces that genuinely pull against each other.",
    impact: "critical",
    fill: "elicit",
    extractionNote:
      '"central_contradiction" is only a committed fact if the text actually shows two opposing forces; otherwise it is almost always a gap.',
  },
  {
    id: "tensions",
    synthesisGroup: "disposition",
    category: "keystone",
    label: "Tensions",
    description:
      "The IF-THEN behavioral signatures that fall out of the contradiction and judgments — specific situations that trigger a specific reaction, making the character predictable in an interesting way.",
    impact: "high",
    fill: "generate",
  },
  {
    id: "stance_toward_user",
    synthesisGroup: "disposition",
    category: "relational",
    label: "Stance toward you",
    description:
      "How the character reads and treats someone like {{user}} — their default posture and attachment style in the relationship.",
    impact: "high",
    fill: "elicit",
  },
  {
    id: "intents",
    synthesisGroup: "disposition",
    category: "relational",
    label: "Intents",
    description:
      "What the character is ultimately after and how they pursue it against what stands in the way — the purpose that makes them an agent, not a reactive chatbot.",
    impact: "high",
    fill: "elicit",
    parts: [
      {
        id: "super_objective",
        label: "Super-objective",
        fill: "elicit",
        description: "The life-long want the character is ultimately chasing.",
      },
      {
        id: "obstacle",
        label: "Obstacle",
        fill: "generate",
        description: "What stands in the way of the super-objective.",
      },
      {
        id: "strategy",
        label: "Strategy",
        fill: "generate",
        description: "How the character pursues the objective against the obstacle.",
      },
    ],
  },
  {
    id: "voice",
    synthesisGroup: "presentation",
    category: "expression",
    label: "Voice",
    description:
      "How the character actually sounds — register and dialect, sentence rhythm, characteristic lexicon and terms of address, the words they would never use, and one or two verbal tics. The single most imitable signal; built first.",
    impact: "high",
    fill: "generate",
  },
  {
    id: "gradient",
    synthesisGroup: "disposition",
    category: "keystone",
    label: "Reaction gradient",
    description:
      "How the character calibrates reactions across four bands — what they will never do, what leaves them flat, what they engage once trust is earned, and what they actively crave (each paired with an aversion). The mechanism that keeps them from being uniformly agreeable.",
    impact: "critical",
    fill: "elicit",
    extractionNote:
      'The reaction gradient: a stated limit or craving ("she refuses to ever lie", "lives for a real problem to solve") IS a committed fact for the "gradient" slot — tag it there.',
    parts: [
      {
        id: "wont",
        label: "Hard limits",
        fill: "elicit",
        description: "What the character will never do — trust-invariant limits.",
      },
      {
        id: "craves",
        label: "Cravings",
        fill: "elicit",
        description: "What the character actively seeks out, each paired with what repels them.",
      },
      {
        id: "neutral",
        label: "Flat reactions",
        fill: "generate",
        description: "Topics that leave the character flat — load-bearing; breaks the always-eager default.",
      },
      {
        id: "will",
        label: "Engages on trust",
        fill: "generate",
        description: "What the character opens up to once trust is earned.",
      },
      {
        id: "trust_gate",
        label: "Trust gate",
        fill: "generate",
        description: "What raises or lowers trust and opens the engages-on-trust band.",
      },
    ],
  },
  {
    id: "relational_axis",
    synthesisGroup: "disposition",
    category: "relational",
    label: "Relational arc",
    description:
      "OPTIONAL. For a character who CHANGES as the bond deepens — the single through-line trait re-aimed across low/mid/high closeness, and the tell foreshadowed early. Present only when the seed shows real change over the relationship.",
    impact: "high",
    fill: "elicit",
    optional: true,
  },
  {
    id: "negative_space",
    synthesisGroup: "disposition",
    category: "expression",
    label: "Negative space",
    description:
      "What this specific character won't say, how they deflect when pressed, and the tells that leak when they are cornered.",
    impact: "medium",
    fill: "generate",
  },
  {
    id: "intimacy",
    synthesisGroup: "disposition",
    category: "relational",
    label: "Intimacy",
    description:
      "OPTIONAL, gated. The reaction calibration applied to desire and closeness — structural and grounded in values, never explicit. Present only for mature-flagged characters.",
    impact: "medium",
    fill: "elicit",
    optional: true,
    parts: [
      { id: "wont", label: "Hard limits", fill: "elicit", description: "Lines the character will never cross." },
      { id: "craves", label: "Cravings", fill: "elicit", description: "What they seek, each paired with its aversion." },
      { id: "neutral", label: "Flat", fill: "generate", description: "What leaves them unmoved." },
      { id: "will", label: "Opens to", fill: "generate", description: "What they engage with once close." },
    ],
  },
] as const;

const FIELD_DEFS: readonly WeaverFieldDef[] = [
  {
    id: "name",
    label: "Name",
    charlField: "name",
    order: 1,
    kind: "short",
    render: "direct",
    directSlot: "name",
    primarySlots: ["name", "archetype", "central_contradiction"],
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
      "archetype",
      "form",
      "values",
      "experiences",
      "central_contradiction",
      "tensions",
      "intents",
      "negative_space",
      "gradient",
    ],
    renderGuidance: buildDescriptionBundleGuidance(),
  },
  {
    id: "personality",
    label: "Personality",
    charlField: "personality",
    order: 3,
    kind: "voice",
    render: "synthesize",
    usesVoiceMaterial: true,
    primarySlots: ["voice", "judgments", "central_contradiction", "negative_space"],
    renderGuidance:
      "Write the Voice & Language block: how this character actually sounds, compact and demonstrable. Cover register and dialect, sentence rhythm, characteristic lexicon and terms of address, the words they would never use, one or two verbal tics, and the physical mannerisms that go with the voice. Derive every point from the Bible's voice material so it coheres with the first message. Concrete and usable — a spec a writer could perform from, NOT a sample line of dialogue and NOT flowing prose paragraphs. No meta or preamble.",
  },
  {
    id: "scenario",
    label: "Scenario",
    charlField: "scenario",
    order: 4,
    kind: "scene",
    render: "synthesize",
    primarySlots: ["stance_toward_user", "intents", "central_contradiction"],
    renderGuidance:
      "Write the present situation that frames the first interaction — where this is, what is happening, and the charge in the air between the character and {{user}}, grounded in the character's stance toward {{user}} with the central tension live. This is a NEUTRAL stage frame written in the third person, not the character's first-person voice; do not narrate the character's first words here. End with a line beginning \"Scene-objective:\" stating what the character is trying to determine or achieve in this scene, drawn from their intents. No meta or preamble.",
  },
  {
    id: "first_mes",
    label: "First message",
    charlField: "first_mes",
    order: 5,
    kind: "voiced",
    render: "synthesize",
    usesVoiceMaterial: true,
    primarySlots: ["voice", "stance_toward_user", "central_contradiction", "gradient"],
    renderGuidance:
      "Write the character's opening message to {{user}}, in their own voice, in the scenario's moment. The NARRATION must be in the character's first-person lens and idiolect (not a neutral third-person camera), and the dialogue must sound like this specific person (the Bible's voice material is the source of truth); reflect their stance toward {{user}} and let them act on an intent. Use {{user}} for the user and {{char}} for the character where natural; *italics* may carry inner thought. Do not write {{user}}'s actions or words. No meta or preamble.",
  },
  {
    id: "mes_example",
    label: "Example messages",
    charlField: "mes_example",
    order: 6,
    kind: "alichat",
    render: "synthesize",
    usesVoiceMaterial: true,
    primarySlots: ["voice", "tensions", "gradient", "intents"],
    renderGuidance:
      "Write 3 to 5 example exchanges in the Ali:Chat convention. Begin each exchange with a line containing only \"<START>\", then a \"{{user}}:\" turn and a \"{{char}}:\" turn. Across the set, COVER varied and distinct beats: a peak emotional moment, a boundary the character holds, a moment of their humor, a value-driven choice, and a mundane everyday exchange — not the same register repeated. If the Bible carries a relational arc, also include one low-closeness and one high-closeness exchange that show the same through-line at different distances. Every {{char}} turn must be in the character's voice with first-person narration in their idiolect; *italics* may carry inner thought. Use {{user}} and {{char}}; do not write {{user}}'s lines beyond the short prompt that sets up each exchange. No meta or preamble.",
  },
] as const;

const BIBLE_GATE_CRITERIA: readonly GateCriterion[] = [
  {
    key: "specificity",
    label: "Specific, not generic",
    description:
      "The spine commits to concrete, particular choices — not generic traits or hedges that could describe almost anyone.",
  },
  {
    key: "coherence",
    label: "Hangs together",
    description:
      "Values, experiences, and judgments connect causally — the character reads as one person whose parts explain each other, not a list of traits.",
  },
  {
    key: "tension",
    label: "Living tension",
    description:
      "The central contradiction is two forces that genuinely pull against each other — not a single trait restated, and not a flaw bolted on.",
  },
  {
    key: "originality",
    label: "Not the obvious version",
    description:
      "The character resists the statistical mean — it is not the first, most predictable thing a model would reach for given this premise.",
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
      "There is enough specific, load-bearing material here to write distinct fields (description, voice, scenario) without inventing toward the average.",
  },
  {
    key: "calibration",
    label: "Not always eager",
    description:
      "The reaction gradient is genuinely calibrated, not uniformly agreeable: the flat/neutral band is populated and load-bearing (real topics that leave the character unmoved), and every craving is paired with the aversion that bounds it. A character who engages everything equally fails this.",
    applies: (spine) => hasEntry(spine, "gradient"),
  },
  {
    key: "earned_arc",
    label: "Change is earned",
    description:
      "If the character has a relational arc, it is earned, not switched: the SAME through-line trait is re-aimed across low and high closeness (not a different personality), the high-closeness tell is foreshadowed at low closeness, and the deltas move specific gradient bands rather than restating the whole gradient. Hard limits never move.",
    applies: (spine) => hasEntry(spine, "relational_axis"),
  },
  {
    key: "psychometric_sanity",
    label: "Reads like a person",
    description:
      "The interior read (archetype/core, values, judgments) does not contradict the behavioral material: the IF-THEN tensions, the gradient, and the intents are consistent with who the character is said to be, not bolted on against it.",
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
      "The field commits to concrete, particular choices grounded in this character — not generic filler, hedges, or traits that could describe almost anyone. This is the anti-average check at the field level.",
    appliesTo: "all",
  },
  {
    key: "in_voice",
    label: "In voice",
    description:
      "The dialogue matches the character's voice as set out in the Bible — rhythm, diction, and register sound like this specific person, so it coheres with the other voice-bearing fields.",
    appliesTo: ["voiced", "alichat"],
  },
  {
    key: "voiced_narration",
    label: "Voiced narration",
    description:
      "The narration around the dialogue is in the character's own first-person lens and idiolect — action beats and inner thought sound like this specific person, not a neutral third-person camera reporting events.",
    appliesTo: ["voiced", "alichat"],
  },
  {
    key: "anti_overindex",
    label: "No recital",
    description:
      "The physical / [FORM] material is treated as a consult-only reference, not inventoried or recited: the writing does not read out measurements or list appearance details like a spec sheet read aloud, and physical facts surface only where they carry weight.",
    appliesTo: ["bundle"],
  },
  {
    key: "coverage",
    label: "Coverage",
    description:
      "The example set covers varied, distinct beats — a peak moment, a held boundary, the character's humor, a value-driven choice, and a mundane exchange — rather than repeating one register. If the character has a relational arc, a low-closeness and a high-closeness exchange are both present and show the same through-line.",
    appliesTo: ["alichat"],
  },
  {
    key: "well_formed",
    label: "Well-formed",
    description:
      "The field has the right shape and length for what it is, carries no meta-commentary, preamble, or instructions to the reader, and is valid to drop straight into a character card.",
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
      "Its answer would change how the character is written: a real behavior, relationship, history, knowledge, or secret a writer would use — not trivia or flavor for its own sake.",
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
      "Everything the question asserts as already true IS established by the source material or the author's answers. Raising a new possibility as a question is fine; stating an invented specific (a person, event, relationship, or secret the author never gave) as fact in the premise fails — invented premises steer the author and leak into canon.",
  },
] as const;

const DYNAMIC_WEAVE: WeaverDynamicWeaveRegistry = {
  instruction:
    "Compose each interview Q&A into ONE self-contained depth entry about this character that a writer can consult mid-scene. Write in the third person about them — never address anyone, never mention the interview, the author, or the question. The question is scaffolding: take from it only what the answer confirms; where the answer rejects or corrects the question's premise, the entry states the author's truth and the rejected premise vanishes entirely. Carry the author's substance and wording — their specifics survive verbatim, never averaged into a recognizable type, and nothing is added beyond what they established. Give each entry a short concrete title naming what it covers.",
  gateCriteria: [
    {
      key: "self_contained",
      label: "Self-contained",
      description:
        "Reads as finished depth material on its own — no interview residue: no questions, no second person, no trace of an author or an asking.",
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

const EXTENSION_SLOTS: readonly string[] = [
  "archetype",
  "form",
  "gradient",
  "tensions",
  "intents",
  "negative_space",
  "relational_axis",
  "intimacy",
];

function slotContent(spine: WeaverBibleSpine, slot: string): string {
  return spine.entries.find((e) => e.slot === slot)?.content.trim() ?? "";
}

function buildReanchorEntry(name: string, spine: WeaverBibleSpine): Record<string, unknown> {
  const core = compactLine(slotContent(spine, "archetype") || slotContent(spine, "central_contradiction") || spine.brief);
  const drives = compactLine(slotContent(spine, "intents") || slotContent(spine, "values"));
  const voice = compactLine(slotContent(spine, "voice"));
  const axis = slotContent(spine, "relational_axis");
  const now = axis ? compactLine(`${axis} (baseline)`) : "baseline";

  const lines = [
    `Core: ${core}`,
    drives ? `Drives: ${drives}` : "",
    voice ? `Voice: ${voice}` : "",
    `Now: ${now}`,
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

export const CHARACTER_REGISTRY: WeaverBuildRegistry = {
  buildType: "character",
  subject: {
    noun: "character",
    deepeningLine:
      "history, relationships, knowledge, secrets, daily texture — whatever THIS character makes interesting",
    extractionConditionalBlock: `CONDITIONAL slots — off by default, most characters do NOT have them:
- "relational_axis": list it (as a fact or a gap) ONLY if the SOURCE shows the character CHANGES as the relationship or bond deepens — a guard that drops over time, cold-then-warm, slow corruption, trust that has to be earned and then transforms them. If the source does not actually show change-over-relationship, OMIT this slot entirely — do not invent an arc for a static character.
- "intimacy": list it (as a fact or a gap) ONLY if the SOURCE centers on or clearly involves desire, sexuality, or physical closeness as part of who this character is. Keep anything you tag STRUCTURAL and non-explicit — what they are drawn to, what they refuse, where the lines are — never graphic content. If the source does not involve intimacy, OMIT this slot entirely.`,
    subPartExamples:
      ' (e.g. a hard limit → gradient part "wont"; a craving → gradient part "craves"; a life-long want → intents part "super_objective")',
    causalLinkExamples:
      "an experience that hardened into a value, a value that produces a judgment, a contradiction that distorts the stance toward others",
    coherentPhrase: "one coherent person",
    briefInstruction:
      "One tight paragraph (3-5 sentences) describing this specific person as a writer would brief an actor — concrete and particular, surfacing the central tension and, if present, the reaction gradient and the relational arc in plain terms. No genre clichés, no hedging.",
  },
  slots: SPINE_SLOTS,
  synthesisGroups: SYNTHESIS_GROUPS,
  fieldDefs: FIELD_DEFS,
  bibleGateCriteria: BIBLE_GATE_CRITERIA,
  fieldGateCriteria: FIELD_GATE_CRITERIA,
  questionGateCriteria: QUESTION_GATE_CRITERIA,
  dynamicWeave: DYNAMIC_WEAVE,
  voiceSlot: "voice",
  nameSlot: "name",
  governanceEntries: (spine) => buildGovernanceEntries(spine),
  reanchorEntry: buildReanchorEntry,
  extensionSlots: EXTENSION_SLOTS,
  finalizeBookRoles: ["depth"],
  creatorNotes:
    "Authored with the Lumiverse Weaver. The card's always-on rules travel in its bound rules book (merged into character_book on export), so it works under any preset.",
};
