import { getSlot, type SpineSlot, type SynthesisGroupDef } from "./slots";
import { compactLine } from "./text";
import type { GateCriterion } from "./gate";
import { criteriaForKind } from "./field-gate";
import type { WeaverFieldDef } from "./fields";
import type { NarrationMode } from "./narration";
import type { WeaverBuildRegistry } from "./build-registry";
import type {
  WeaverCommittedFact,
  WeaverFactSource,
  WeaverTasteProfile,
  WeaverBibleSpine,
  WeaverBibleDynamicEntry,
  WeaverGateVerdict,
} from "../../types/weaver";

function slotCatalog(slots: readonly SpineSlot[]): string {
  return slots.map((s) => `- ${s.id} (${s.label}): ${s.description}`).join("\n");
}

/** Lists hybrid slots' sub-parts so extraction can tag a fact to the right part. */
function hybridPartCatalog(slots: readonly SpineSlot[]): string {
  return slots
    .filter((s) => s.parts && s.parts.length > 0)
    .map((s) => `- ${s.id}: ${s.parts!.map((p) => `${p.id} (${p.label})`).join(", ")}`)
    .join("\n");
}

function extractionNotes(slots: readonly SpineSlot[]): string[] {
  return slots.filter((s) => s.extractionNote).map((s) => `- ${s.extractionNote}`);
}

export function buildExtractionPrompt(reg: WeaverBuildRegistry): string {
  const { noun } = reg.subject;
  const parts: string[] = [];
  parts.push(`You are the Weaver's read-back stage. You are given a piece of SOURCE MATERIAL describing a ${noun} idea. Your job is NOT to write a ${noun}. Your job is to read carefully and separate two things:

1. COMMITTED FACTS — things the author actually established in the text. Tag each to the spine slot it belongs to.

   Rules for a fact:
   - State the bare value, not a sentence about it. Drop framing verbs and lead-ins ("Her name is", "She is", "The character has") and write only the value itself.
   - Extract ONLY what the text directly supports. Never embellish, generalize, or interpret. Do not append editorial or comparative claims the author did not write. If the text didn't say it, it does not exist.
   - If you are tempted to explain WHY something is true, stop — that is interpretation, not a fact.
   - A committed fact belongs to the author, not to you.

2. GAPS — spine slots the text leaves empty or genuinely ambiguous, where a writer would otherwise be forced to guess. Only list a slot as a gap if it is BOTH (a) not adequately covered by committed facts AND (b) load-bearing — its absence would push generation toward generic, average output.

The spine slots:
${slotCatalog(reg.slots)}

Guidance:
- A single sentence can yield multiple committed facts across different slots.
- Do not duplicate: if a slot is covered by a committed fact, it is NOT a gap.
- Prefer fewer, sharper facts over many vague ones. Terse beats complete.
- When in doubt between stating a fact plainly and elaborating it, always choose plain.
${extractionNotes(reg.slots).join("\n")}
- Be honest about ambiguity: if the text gestures at something but does not commit, treat it as a gap and note what is ambiguous.`);

  const hybrid = hybridPartCatalog(reg.slots);
  if (hybrid) {
    parts.push(`Some slots have SUB-PARTS. When a committed fact clearly belongs to ONE sub-part, set its "part" to that sub-part id${reg.subject.subPartExamples}. If it does not clearly map to one sub-part, omit "part". Sub-parts:
${hybrid}`);
  }

  if (reg.subject.extractionConditionalBlock) {
    parts.push(reg.subject.extractionConditionalBlock);
  }

  parts.push(`Output STRICT JSON, no prose, no code fence:
{
  "committed_facts": [
    { "slot": "<slot id>", "part": "<optional sub-part id, only for hybrid slots>", "fact": "<concise statement grounded in the text>" }
  ],
  "gaps": [
    { "slot": "<slot id>", "note": "<what's missing or ambiguous for this slot>" }
  ]
}`);

  return parts.join("\n\n");
}

export function buildExtractionUserMessage(seedText: string): string {
  return `SOURCE MATERIAL:\n\n${seedText.trim()}`;
}


const DEFAULT_SOURCE_NOUN = "dream";
const FACT_SOURCE_MARK: Record<WeaverFactSource, string> = {
  extracted: "from the dream",
  user: "the author's own words",
  picked: "picked from offered options",
  enhanced: "the author's words, extended",
};

function formatFacts(
  reg: WeaverBuildRegistry,
  facts: WeaverCommittedFact[],
  sourceNoun = DEFAULT_SOURCE_NOUN,
): string {
  if (facts.length === 0) return "(nothing established yet)";
  return facts
    .map((f) => {
      const label = getSlot(reg.slots, f.slot)?.label ?? f.slot;
      const mark =
        f.source === "extracted"
          ? `from the ${sourceNoun}`
          : (FACT_SOURCE_MARK[f.source] ?? FACT_SOURCE_MARK.user);
      return `- ${label}: ${f.fact} [${mark}]`;
    })
    .join("\n");
}

function dreamBlock(dream: string, intent: string, sourceNoun = DEFAULT_SOURCE_NOUN): string | null {
  const trimmed = dream.trim();
  if (!trimmed) return null;
  const ownership =
    sourceNoun === DEFAULT_SOURCE_NOUN ? "the author's original words" : "the source text, verbatim";
  return `THE ${sourceNoun.toUpperCase()} (${ownership} — ${intent}):\n"""\n${trimmed}\n"""`;
}

function formatDepthNotes(dynamic: readonly WeaverBibleDynamicEntry[]): string | null {
  if (dynamic.length === 0) return null;
  return dynamic
    .map((d) => (d.question ? `- Q: ${d.question}\n  A: ${d.content}` : `- ${d.content}`))
    .join("\n");
}

export function buildInterviewerPrompt(reg: WeaverBuildRegistry, sourceNoun = DEFAULT_SOURCE_NOUN): string {
  const { noun, deepeningLine } = reg.subject;
  return `You are the Weaver's interviewer. You are helping an author grow a ${noun} from THEIR idea. Ask the single next question that most sharpens this specific ${noun}.

YOU ARE GIVEN: THE ${sourceNoun.toUpperCase()} (the source text this ${noun} starts from), what is ESTABLISHED so far, what was ALREADY ASKED, and PRIORITIES — the aspects not yet pinned down, most important first, each with a target id. You may also see DEEPENING SO FAR (extra material already gathered beyond the essentials).

CHOOSING WHAT TO ASK:
- Aim at the top priority, unless something the author already said makes another PRIORITY more urgent right now (a thread begging to be pulled).
- Only when no priorities remain, deepen: ${deepeningLine}. Use the target "dynamic" for deepening questions.

HOW TO ASK — the bar:
- Grounded in THIS ${noun}. Build the question out of the ${sourceNoun}'s and the answers' actual material; quote the author's own phrase when it helps. A question that could be asked about any ${noun} is a failure.
- Ask, never assert. The question's premise may state only what the author established; raise a new possibility AS a question, never as a fact ("is there someone who..." earns its answer — "who is the person that..." invents one). An invented premise steers the author and leaks into their canon.
- Plain language. No craft jargon and no internal terminology of any kind — ask the way a sharp co-writer talks across a table.
- Obvious intent. Write a one-line "why": what this pins down and what a good answer gives, in the author's terms (for example, that a specific scene tells more than a trait word). Never make the author guess what you are after.
- One thing at a time. No compound questions, no lists of sub-questions, no multiple choice.
- Concrete beats abstract. Prefer what they did, said, chose, or avoided in a moment over how they "generally feel".

Output STRICT JSON, no prose, no code fence:
{
  "prompt": "<the question>",
  "why": "<one plain line on what this pins down>",
  "target": "<one of the given priority target ids, or \\"dynamic\\" only when no priorities remain>"
}`;
}

export function buildInterviewerUserMessage(
  reg: WeaverBuildRegistry,
  input: {
    dream: string;
    facts: WeaverCommittedFact[];
    asked: { prompt: string; response: string }[];
    priorities: { target: string; label: string; description?: string }[];
    dynamicItems: { question: string; answer: string }[];
    taste: WeaverTasteProfile;
    steer?: string;
    avoid?: string[];
    source_noun?: string;
  },
): string {
  const parts: string[] = [];
  const dream = dreamBlock(input.dream, "build questions from this material", input.source_noun);
  if (dream) parts.push(dream);
  parts.push(`\nESTABLISHED SO FAR:\n${formatFacts(reg, input.facts, input.source_noun)}`);
  if (input.asked.length > 0) {
    parts.push(
      `\nALREADY ASKED AND ANSWERED (never re-ask or reword these):\n${input.asked
        .map((a) => `- Q: ${a.prompt}\n  A: ${a.response}`)
        .join("\n")}`,
    );
  }
  if (input.dynamicItems.length > 0) {
    parts.push(
      `\nDEEPENING SO FAR:\n${input.dynamicItems.map((d) => `- Q: ${d.question}\n  A: ${d.answer}`).join("\n")}`,
    );
  }
  if (input.priorities.length > 0) {
    parts.push(
      `\nPRIORITIES (not yet pinned down, most important first — aim your question at one of these target ids):\n${input.priorities
        .map((p) => `- ${p.target} (${p.label})${p.description ? `: ${p.description}` : ""}`)
        .join("\n")}`,
    );
  } else {
    parts.push(`\nPRIORITIES: all covered — deepen with target "dynamic".`);
  }
  if (input.taste.steers.length > 0) {
    parts.push(`\nTASTE the author has shown:\n${input.taste.steers.map((s) => `- ${s}`).join("\n")}`);
  }
  if (input.steer && input.steer.trim()) {
    parts.push(`\nSTEER from the author for the next question: ${input.steer.trim()}`);
  }
  const avoid = (input.avoid ?? []).filter((a) => a && a.trim());
  if (avoid.length > 0) {
    parts.push(
      `\nDo NOT ask these (rejected or already shown) or near-rewordings of them:\n${avoid.map((a) => `- ${a}`).join("\n")}`,
    );
  }
  return parts.join("\n");
}

export function buildQuestionGatePrompt(reg: WeaverBuildRegistry): string {
  const { noun } = reg.subject;
  return `You are the Weaver's question gate. An interviewer proposed ONE question to ask the author about their ${noun}. Judge whether it earns the author's time — a generic or redundant question wastes their attention and pulls the ${noun} toward the average. Be demanding, not a cheerleader.

Judge the proposed question against each criterion. For each, decide pass or fail and write one sharp sentence naming exactly what is strong or weak.

CRITERIA:
${reg.questionGateCriteria.map((c) => `- ${c.key} (${c.label}): ${c.description}`).join("\n")}

Output STRICT JSON, no prose, no code fence:
{
  "criteria": [
    { "key": "<criterion key>", "passed": true|false, "note": "<one sharp sentence>" }
  ],
  "summary": "<one line>"
}`;
}

export function buildQuestionGateUserMessage(
  reg: WeaverBuildRegistry,
  input: {
    prompt: string;
    why: string;
    dream: string;
    facts: WeaverCommittedFact[];
    asked: { prompt: string }[];
    source_noun?: string;
  },
): string {
  const parts: string[] = [];
  parts.push(`THE PROPOSED QUESTION:\n${input.prompt}`);
  if (input.why.trim()) parts.push(`Its stated intent: ${input.why.trim()}`);
  const dream = dreamBlock(input.dream, "the subject the question must be specific to", input.source_noun);
  if (dream) parts.push(`\n${dream}`);
  parts.push(`\nESTABLISHED SO FAR:\n${formatFacts(reg, input.facts, input.source_noun)}`);
  if (input.asked.length > 0) {
    parts.push(`\nQUESTIONS ALREADY ASKED:\n${input.asked.map((a) => `- ${a.prompt}`).join("\n")}`);
  }
  return parts.join("\n");
}

export function buildSparkPrompt(reg: WeaverBuildRegistry, sourceNoun = DEFAULT_SOURCE_NOUN): string {
  const { noun } = reg.subject;
  return `You are the Weaver's spark. The author asked for possible directions on the current interview question — they want inspiration, not an answer made for them.

Offer exactly 3 candidate answers that are genuinely DIVERGENT: each one sends the ${noun} somewhere the others do not. If two could be swapped without a reader noticing a change in the ${noun}, pull them further apart. Do not cluster on the obvious answer — the first idea that comes to mind for a premise is usually the mean; reach past it for at least one candidate.

Each candidate:
- A complete, concrete answer to the question — a real behavior, scene, belief, or detail. Never a bare adjective.
- Grounded in the ${sourceNoun} and the established facts; never contradicting them. Diverge only in the space the author left open.
- Captioned (4-10 words) with the human tradeoff or feel it represents.

If a STEER is provided, move the whole set decisively toward it — the new set must be visibly different and clearly reflect what the author asked for.

Output STRICT JSON, no prose, no code fence:
{
  "options": [
    { "caption": "<short human tradeoff>", "content": "<a complete, concrete answer>" }
  ]
}`;
}

export function buildSparkUserMessage(
  reg: WeaverBuildRegistry,
  input: {
    prompt: string;
    why: string;
    dream: string;
    facts: WeaverCommittedFact[];
    taste: WeaverTasteProfile;
    steer?: string;
    avoid?: string[];
    source_noun?: string;
  },
): string {
  const parts: string[] = [];
  parts.push(`THE QUESTION:\n${input.prompt}`);
  if (input.why.trim()) parts.push(`What it pins down: ${input.why.trim()}`);
  const dream = dreamBlock(input.dream, "stay grounded in this", input.source_noun);
  if (dream) parts.push(`\n${dream}`);
  parts.push(`\nESTABLISHED SO FAR (never contradict these):\n${formatFacts(reg, input.facts, input.source_noun)}`);
  if (input.taste.steers.length > 0) {
    parts.push(`\nTASTE the author has shown (bias the set toward these):\n${input.taste.steers.map((s) => `- ${s}`).join("\n")}`);
  }
  if (input.steer && input.steer.trim()) {
    parts.push(`\nSTEER (re-aim the whole set toward this): ${input.steer.trim()}`);
  }
  const avoid = (input.avoid ?? []).filter((a) => a && a.trim());
  if (avoid.length > 0) {
    parts.push(
      `\nThe author already saw these — do NOT repeat them or offer minor rewordings:\n${avoid.map((a) => `- ${a}`).join("\n")}`,
    );
  }
  return parts.join("\n");
}

export function buildEnhancePrompt(): string {
  return `You are the Weaver's enhancer. The author drafted an answer in their own words and wants help taking it further. The draft is theirs — your job is to extend it, never to replace it.

Offer 2-3 extensions. Each one:
- Keeps the draft's substance, and its wording wherever possible. Extend, sharpen, or concretize what is there; push one consequence a step further; turn an abstraction in it into a specific moment or detail.
- Must still be the author's idea, made more vivid — never your different idea wearing their draft. If an extension would change what the draft means, drop it.
- Is the complete extended answer text, ready to use as-is.
- Is captioned (4-10 words) with what the extension adds.

Output STRICT JSON, no prose, no code fence:
{
  "options": [
    { "caption": "<what this adds>", "content": "<the complete extended answer>" }
  ]
}`;
}

export function buildEnhanceUserMessage(
  reg: WeaverBuildRegistry,
  input: {
    prompt: string;
    draft: string;
    dream: string;
    facts: WeaverCommittedFact[];
    source_noun?: string;
  },
): string {
  const parts: string[] = [];
  parts.push(`THE QUESTION:\n${input.prompt}`);
  parts.push(`\nTHE AUTHOR'S DRAFT (extend this; never replace its meaning):\n${input.draft}`);
  const dream = dreamBlock(input.dream, "keep extensions consistent with this", input.source_noun);
  if (dream) parts.push(`\n${dream}`);
  parts.push(`\nESTABLISHED SO FAR (never contradict these):\n${formatFacts(reg, input.facts, input.source_noun)}`);
  return parts.join("\n");
}

export function buildSpilloverPrompt(reg: WeaverBuildRegistry): string {
  const { noun } = reg.subject;
  const parts: string[] = [];
  parts.push(`You are the Weaver's listener. The author just answered an interview question. The answer's PRIMARY target is already recorded — do not restate it. Your only job: notice whether the answer ALSO plainly established something for OTHER aspects of the ${noun}, and tag those as additional facts.

Rules:
- Extract ONLY what the answer's text directly supports. Never interpret, generalize, or embellish — a committed fact belongs to the author, not to you.
- State the bare value, not a sentence about it.
- Skip anything already established. Prefer none over weak: an empty list is the common, correct outcome.

The aspects:
${slotCatalog(reg.slots)}`);

  const hybrid = hybridPartCatalog(reg.slots);
  if (hybrid) {
    parts.push(`Sub-parts (tag "part" only when the fact clearly belongs to one):
${hybrid}`);
  }

  parts.push(`Output STRICT JSON, no prose, no code fence:
{
  "facts": [
    { "slot": "<slot id>", "part": "<optional sub-part id>", "fact": "<bare value from the answer>" }
  ]
}`);
  return parts.join("\n\n");
}

export function buildSpilloverUserMessage(
  reg: WeaverBuildRegistry,
  input: {
    prompt: string;
    target: string;
    answer: string;
    facts: WeaverCommittedFact[];
    source_noun?: string;
  },
): string {
  return [
    `THE QUESTION:\n${input.prompt}`,
    `\nPRIMARY TARGET (already recorded — skip it): ${input.target}`,
    `\nTHE AUTHOR'S ANSWER:\n${input.answer}`,
    `\nALREADY ESTABLISHED (skip anything covered here):\n${formatFacts(reg, input.facts, input.source_noun)}`,
  ].join("\n");
}

export interface SynthesisTarget {
  slot: string;
  part: string;
  label: string;
  description?: string;
  fill: "elicit" | "generate";
}

export interface SynthesisPriorPart {
  slot: string;
  part: string;
  content: string;
}

export function buildBibleSynthesisPrompt(
  reg: WeaverBuildRegistry,
  group: SynthesisGroupDef,
  sourceNoun = DEFAULT_SOURCE_NOUN,
): string {
  const { noun } = reg.subject;
  return `You are the Weaver's synthesis stage, authoring ONE layer of a ${noun}'s BIBLE: a compact shared brain that every later field is written from. You are NOT writing prose fields yet.

THIS PASS — ${group.label}: ${group.instruction}

You are given the FACTS the author has committed to (their ${sourceNoun} + interview answers). These facts are LOCKED: they are the author's own specific idea, the whole reason this ${noun} won't collapse into a generic average. Build everything AROUND them so it coheres — never contradict, generalize, or water one down. You are also given what EARLIER passes already authored; stay consistent with it and build on it.

You may also be given THE ${sourceNoun.toUpperCase()} — the source text this ${noun} starts from, verbatim. It is the strongest conditioning evidence you have: keep its specific names, images, turns of phrase, and texture alive in what you author. Where a fact is marked as the author's own words, treat its exact substance as untouchable. DEPTH NOTES, when present, are the author's answers to deepening questions — established material the Bible must stay consistent with.

AUTHOR THE TARGETS. For each target under TO AUTHOR, write one concrete, specific statement that follows believably from the locked facts and the earlier passes. A target is one part of the spine: write the content for exactly that part. The statement must be a complete, particular thing — a real behavior, belief, sound, limit, or detail — never a bare adjective or a hedge. Do not drift toward the statistical mean: the first thing that comes to mind for this premise is the average; go past it.

A target marked [author] is your craft — the author wants you to invent it from the spine. A target marked [infer] is one the author left open: make your best, overturnable guess from the ${sourceNoun} and their taste, and keep it modest and consistent rather than inventing bold new canon.

Output STRICT JSON, no prose, no code fence:
{
  "authored": [
    { "slot": "<slot id>", "part": "<part id>", "content": "<a complete, concrete statement>" }
  ]
}
Return one entry per target, using the exact slot and part ids given. Author nothing outside TO AUTHOR.`;
}

export function buildBibleSynthesisUserMessage(
  reg: WeaverBuildRegistry,
  input: {
    dream: string;
    facts: WeaverCommittedFact[];
    taste: WeaverTasteProfile;
    targets: SynthesisTarget[];
    priorAuthored: SynthesisPriorPart[];
    dynamic?: WeaverBibleDynamicEntry[];
    source_noun?: string;
    nudge?: string;
  },
): string {
  const parts: string[] = [];
  const dream = dreamBlock(
    input.dream,
    "the texture and specifics to honor; never flatten or genericize them",
    input.source_noun,
  );
  if (dream) parts.push(`${dream}\n`);
  parts.push(`LOCKED FACTS (the author's committed idea — carry the meaning faithfully):\n${formatFacts(reg, input.facts, input.source_noun)}`);
  const depth = formatDepthNotes(input.dynamic ?? []);
  if (depth) {
    parts.push(`\nDEPTH NOTES (the author's deepening answers — established; stay consistent with them):\n${depth}`);
  }
  if (input.taste.steers.length > 0) {
    parts.push(`\nTASTE the author has shown (let it bias what you author):\n${input.taste.steers.map((s) => `- ${s}`).join("\n")}`);
  }
  if (input.priorAuthored.length > 0) {
    parts.push(
      `\nALREADY AUTHORED by earlier passes (stay consistent; build on this):\n${input.priorAuthored
        .map((p) => `- ${getSlot(reg.slots, p.slot)?.label ?? p.slot}${p.part !== p.slot ? ` · ${p.part}` : ""}: ${p.content}`)
        .join("\n")}`,
    );
  }
  if (input.nudge && input.nudge.trim()) {
    parts.push(
      `\nSTEER from the author for this pass (re-aim what you author toward this; stay faithful to the locked facts and never contradict them): ${input.nudge.trim()}`,
    );
  }
  parts.push(
    `\nTO AUTHOR (write content for each part):\n${input.targets
      .map((t) => {
        const addr = t.part === t.slot ? t.slot : `${t.slot}.${t.part}`;
        const tag = t.fill === "generate" ? "[author]" : "[infer]";
        const desc = t.description ? `: ${t.description}` : "";
        return `- ${addr} (${t.label}) ${tag}${desc}`;
      })
      .join("\n")}`,
  );
  return parts.join("\n");
}

export function buildBibleWeavePrompt(reg: WeaverBuildRegistry): string {
  const { noun, causalLinkExamples, coherentPhrase, briefInstruction } = reg.subject;
  return `You are the Weaver's synthesis stage, doing the final WEAVE over a fully assembled ${noun} BIBLE. You add nothing new about the ${noun} — you only connect what is already there and summarize it.

1. DRAW THE CAUSAL LINKS. Identify how the spine slots cause each other — ${causalLinkExamples}. Each link names a cause slot, an effect slot, and the relation between them. These links are what make the ${noun} read as ${coherentPhrase} rather than a list. Only assert a link the spine actually supports.

2. WRITE THE BRIEF. ${briefInstruction}

Output STRICT JSON, no prose, no code fence:
{
  "causal_links": [
    { "from": "<slot id>", "to": "<slot id>", "relation": "<short phrase, e.g. 'hardened into'>" }
  ],
  "brief": "<one concrete paragraph>"
}`;
}

export function buildBibleWeaveUserMessage(
  reg: WeaverBuildRegistry,
  spine: WeaverBibleSpine,
  dreamText = "",
  sourceNoun = DEFAULT_SOURCE_NOUN,
): string {
  const entries = formatSpineEntries(reg, spine);
  const parts: string[] = [];
  const dream = dreamBlock(
    dreamText,
    "ground the brief's language in this texture; do not import facts the spine lacks",
    sourceNoun,
  );
  if (dream) parts.push(`${dream}\n`);
  parts.push(
    `THE ASSEMBLED SPINE (connect these; do not invent beyond them):\n${entries || "(no entries)"}\n\nFor causal_links, reference slots by their id. Valid slot ids:\n${reg.slots.map((s) => `- ${s.id}`).join("\n")}`,
  );
  return parts.join("\n");
}

function gateRubric(criteria: readonly GateCriterion[]): string {
  return criteria.map((c) => `- ${c.key} (${c.label}): ${c.description}`).join("\n");
}

export function buildBibleGatePrompt(
  reg: WeaverBuildRegistry,
  applicable: readonly GateCriterion[],
): string {
  const { noun } = reg.subject;
  return `You are the Weaver's gate. A ${noun} BIBLE has been synthesized and you must judge whether it is strong enough to write a distinctive ${noun} from — BEFORE any fields are written. Be a demanding critic, not a cheerleader: the cost of passing a weak Bible is an entire generic ${noun}.

Judge the Bible against each criterion below. For each, decide pass or fail and write one sharp sentence saying exactly what is strong or what is thin (name the specific weakness — do not be vague). A criterion fails if the Bible only half-meets it.

Write every note and the summary as an editor talking to the author: plain writer's language, no craft theory, no internal or technical vocabulary. A failing note must hand the author one concrete fix — the specific detail to add, sharpen, or cut — not a verdict alone. "Her voice could belong to anyone; give her one phrase nobody else would say" is the register to aim for.

CRITERIA:
${gateRubric(applicable)}

Then write a short plain-language summary the author can read: if it passed, what makes this ${noun} work; if it failed, the one or two things that would most raise the ceiling.

Output STRICT JSON, no prose, no code fence:
{
  "criteria": [
    { "key": "<criterion key>", "passed": true|false, "note": "<one sharp sentence>" }
  ],
  "summary": "<plain-language summary for the author>"
}`;
}

function formatSpineEntries(reg: WeaverBuildRegistry, spine: WeaverBibleSpine): string {
  return spine.entries
    .map((e) => `- ${getSlot(reg.slots, e.slot)?.label ?? e.slot}: ${e.content}`)
    .join("\n");
}

function formatSpineLinks(reg: WeaverBuildRegistry, spine: WeaverBibleSpine): string {
  return spine.causal_links
    .map((l) => {
      const from = getSlot(reg.slots, l.from)?.label ?? l.from;
      const to = getSlot(reg.slots, l.to)?.label ?? l.to;
      return `- ${from} → ${l.relation} → ${to}`;
    })
    .join("\n");
}

function voiceMaterial(reg: WeaverBuildRegistry, spine: WeaverBibleSpine): string {
  return spine.entries.find((e) => e.slot === reg.voiceSlot)?.content.trim() ?? "";
}

export function buildBibleGateUserMessage(
  reg: WeaverBuildRegistry,
  spine: WeaverBibleSpine,
  dreamText = "",
  sourceNoun = DEFAULT_SOURCE_NOUN,
): string {
  const entries = formatSpineEntries(reg, spine);
  const links = formatSpineLinks(reg, spine);
  const parts: string[] = [];
  const dream = dreamBlock(
    dreamText,
    "the source material for the fidelity check",
    sourceNoun,
  );
  if (dream) parts.push(`${dream}\n`);
  parts.push(`THE BIBLE\n\nBrief:\n${spine.brief || "(none)"}`);
  parts.push(`\nSpine:\n${entries || "(no entries)"}`);
  if (links) parts.push(`\nHow it connects:\n${links}`);
  const depth = formatDepthNotes(spine.dynamic);
  if (depth) {
    parts.push(
      `\nDepth notes (deepening answers carried beyond the card — material here still counts as kept):\n${depth}`,
    );
  }
  return parts.join("\n");
}

export function buildFieldRenderPrompt(
  reg: WeaverBuildRegistry,
  field: WeaverFieldDef,
  narrationMode?: NarrationMode,
): string {
  const { noun } = reg.subject;
  const focus = field.primarySlots.map((s) => getSlot(reg.slots, s)?.label ?? s).join(", ");
  const narration =
    field.narrated && narrationMode
      ? `\n\nNARRATION POV — applies to the prose narration in this field (dialogue always stays in {{char}}'s own idiolect):\n${narrationMode.guidance}`
      : "";
  return `You are the Weaver's render stage. You are writing ONE field of a ${noun} — the "${field.label}" field — from the ${noun}'s FROZEN BIBLE.

The Bible is the single shared source of truth. Write ONLY from it: every choice must trace to the Bible's brief, spine, and causal links. Never invent details that contradict the Bible, and never drift toward the generic, average version of this ${noun} — the Bible exists precisely to keep this ${noun} specific. The first thing that comes to mind for a premise is usually the mean; the Bible is how you reach past it.

You are writing this field in ISOLATION. You will NOT see the other rendered fields and must not reference or assume their exact wording. Anything that must agree across fields agrees because it is drawn from the same Bible — so stay faithful to the Bible and coherence takes care of itself.

Lean especially on these parts of the spine for this field: ${focus}. The whole Bible remains available as context.

FIELD GUIDANCE — "${field.label}":
${field.renderGuidance}${narration}

Output ONLY the field's content as plain text — no JSON, no code fence, no field label, no preamble, and no commentary before or after.`;
}

export function buildFieldRenderUserMessage(
  reg: WeaverBuildRegistry,
  input: {
    field: WeaverFieldDef;
    spine: WeaverBibleSpine;
  },
): string {
  const { field, spine } = input;
  const parts: string[] = [];
  parts.push(`THE FROZEN BIBLE\n\nBrief:\n${spine.brief || "(none)"}`);
  parts.push(`\nSpine:\n${formatSpineEntries(reg, spine) || "(no entries)"}`);
  const links = formatSpineLinks(reg, spine);
  if (links) parts.push(`\nHow it connects:\n${links}`);

  if (field.usesVoiceMaterial) {
    const voice = voiceMaterial(reg, spine);
    if (voice) {
      parts.push(
        `\nVOICE MATERIAL (the shared source of truth for how this ${reg.subject.noun} sounds — every voice-bearing field draws on this so they cohere):\n${voice}`,
      );
    }
  }

  parts.push(`\nNow write the ${field.label} field.`);
  return parts.join("\n");
}

export function buildFieldReviseUserMessage(
  reg: WeaverBuildRegistry,
  input: {
    field: WeaverFieldDef;
    spine: WeaverBibleSpine;
    previous: string;
    verdict: WeaverGateVerdict;
  },
): string {
  const { field, previous, verdict } = input;
  const failed = verdict.criteria.filter((c) => !c.passed);
  const flags =
    failed.length > 0
      ? failed.map((c) => `- ${c.label}: ${c.note || "(failed)"}`).join("\n")
      : "- (the gate did not pass, but gave no per-criterion notes)";

  const parts: string[] = [];
  parts.push(buildFieldRenderUserMessage(reg, { field: input.field, spine: input.spine }));
  parts.push(`\nA prior attempt at the ${field.label} field did NOT pass the gate.`);
  parts.push(`\nPrior attempt:\n${previous}`);
  parts.push(`\nWhat the gate flagged (fix exactly these):\n${flags}`);
  if (verdict.summary) parts.push(`\nGate summary: ${verdict.summary}`);
  parts.push(
    `\nWrite a single improved version of the ${field.label} field that fixes these problems while staying faithful to the Bible. Output ONLY the field content.`,
  );
  return parts.join("\n");
}

export function buildFieldNudgeUserMessage(
  reg: WeaverBuildRegistry,
  input: {
    field: WeaverFieldDef;
    spine: WeaverBibleSpine;
    nudge: string;
    previous?: string;
  },
): string {
  const { field, nudge, previous } = input;
  const parts: string[] = [];
  parts.push(buildFieldRenderUserMessage(reg, { field: input.field, spine: input.spine }));
  if (previous && previous.trim()) {
    parts.push(`\nThe current ${field.label} field:\n${previous.trim()}`);
  }
  parts.push(`\nThe creator wants this field steered. Lean the result toward: ${nudge.trim()}`);
  parts.push(
    `\nThe steer adjusts emphasis, tone, and flavor only — stay faithful to the Bible and never add facts that go beyond or contradict it. Output ONLY the ${field.label} field content.`,
  );
  return parts.join("\n");
}

export function buildFieldGatePrompt(reg: WeaverBuildRegistry, field: WeaverFieldDef): string {
  const { noun } = reg.subject;
  const rubric = criteriaForKind(reg.fieldGateCriteria, field.kind)
    .map((c) => `- ${c.key} (${c.label}): ${c.description}`)
    .join("\n");
  return `You are the Weaver's field gate. A single ${noun} field — the "${field.label}" field — has been written FROM the ${noun}'s Bible, and you must judge whether it is good enough to keep. Be a demanding critic, not a cheerleader: passing a weak field puts generic writing on the card.

The Bible has ALREADY been judged for whether the ${noun} CONCEPT is strong — do not re-judge the concept or the idea. Judge only this rendering: did it project the Bible faithfully and specifically, in the right shape, without sliding toward the generic?

Judge the field against each criterion below. For each, decide pass or fail and write one sharp sentence naming exactly what is strong or what is weak — be specific, never vague. A criterion fails if the field only half-meets it.

CRITERIA:
${rubric}

Then write a short plain-language summary the author can read: if it passed, what makes the field work; if it failed, the single most important thing to fix.

Output STRICT JSON, no prose, no code fence:
{
  "criteria": [
    { "key": "<criterion key>", "passed": true|false, "note": "<one sharp sentence>" }
  ],
  "summary": "<plain-language summary for the author>"
}`;
}

/** User-turn content for the field gate: the Bible to check against + the field. */
export function buildFieldGateUserMessage(
  reg: WeaverBuildRegistry,
  input: {
    field: WeaverFieldDef;
    content: string;
    spine: WeaverBibleSpine;
  },
): string {
  const { field, content, spine } = input;
  const parts: string[] = [];
  parts.push(`THE BIBLE (what this field must be faithful to)\n\nBrief:\n${spine.brief || "(none)"}`);
  parts.push(`\nSpine:\n${formatSpineEntries(reg, spine) || "(no entries)"}`);
  parts.push(`\nTHE ${field.label.toUpperCase()} FIELD AS WRITTEN:\n${content}`);
  return parts.join("\n");
}

export interface WeaverDynamicWeaveRevision {
  id: string;
  title: string;
  content: string;
  notes: string[];
}

export function buildDynamicWeavePrompt(reg: WeaverBuildRegistry): string {
  const { noun } = reg.subject;
  return `You are the Weaver's lore weaver. An author answered deepening interview questions about their ${noun}, and each Q&A is being written into the ${noun}'s backing worldbook, where it surfaces during a chat whenever it becomes relevant. ${reg.dynamicWeave.instruction}

For each entry, also propose 2 to 6 TRIGGER KEYWORDS — words or short phrases likely to appear in chat messages when its material is relevant: names, places, objects, topics, activities. Take them from the entry's own material; each is a single word or short phrase (at most 3 words), lowercase unless a proper noun. Never generic words that would fire constantly.

Output STRICT JSON, no prose, no code fence:
{
  "entries": [
    { "id": "<entry id>", "title": "<short concrete title>", "content": "<the composed entry>", "keywords": ["<keyword>", "..."] }
  ]
}
Return one object per given entry, using the exact ids given.`;
}

export function buildDynamicWeaveUserMessage(
  reg: WeaverBuildRegistry,
  input: {
    dream: string;
    entries: readonly WeaverBibleDynamicEntry[];
    revise?: readonly WeaverDynamicWeaveRevision[];
    source_noun?: string;
  },
): string {
  const parts: string[] = [];
  const dream = dreamBlock(
    input.dream,
    "ground the entries' language in this; never import facts the answers lack",
    input.source_noun,
  );
  if (dream) parts.push(dream);
  const list = input.entries
    .map((e) => `- id: ${e.id}\n  Q: ${e.question || "(none)"}\n  A: ${e.content}`)
    .join("\n");
  parts.push(`THE Q&A (compose one entry per item — the answer is the author's substance; the question is scaffolding):\n${list}`);
  if (input.revise && input.revise.length > 0) {
    const revisions = input.revise
      .map(
        (r) =>
          `- id: ${r.id} — ${r.title}\n  THE ATTEMPT:\n${r.content}\n  THE NOTES (fix exactly these):\n${r.notes.map((n) => `  - ${n}`).join("\n")}`,
      )
      .join("\n");
    parts.push(`PREVIOUS ATTEMPTS that failed review — revise these; keep everything that works:\n${revisions}`);
  }
  return parts.join("\n\n");
}

export function buildDynamicWeaveGatePrompt(reg: WeaverBuildRegistry): string {
  const { noun } = reg.subject;
  return `You are the Weaver's entry gate. Interview Q&A about a ${noun} were composed into backing-worldbook entries, and each composed entry must earn its place — a transcript-flavored or premise-polluted entry injects interview residue straight into play. Be demanding, not a cheerleader.

Judge EACH composed entry against each criterion. For each criterion, decide pass or fail and write one sharp sentence naming exactly what is strong or weak.

CRITERIA:
${reg.dynamicWeave.gateCriteria.map((c) => `- ${c.key} (${c.label}): ${c.description}`).join("\n")}

Output STRICT JSON, no prose, no code fence:
{
  "verdicts": [
    {
      "id": "<entry id>",
      "criteria": [
        { "key": "<criterion key>", "passed": true|false, "note": "<one sharp sentence>" }
      ]
    }
  ]
}
Return one verdict per given entry, using the exact ids given.`;
}

export function buildDynamicWeaveGateUserMessage(
  reg: WeaverBuildRegistry,
  input: {
    composed: readonly { id: string; title: string; content: string }[];
    entries: readonly WeaverBibleDynamicEntry[];
  },
): string {
  const byId = new Map(input.entries.map((e) => [e.id, e]));
  const list = input.composed
    .map((c) => {
      const source = byId.get(c.id);
      const qa = source ? `\n  SOURCE Q: ${source.question || "(none)"}\n  SOURCE A: ${source.content}` : "";
      return `- id: ${c.id} — ${c.title}\n  THE ENTRY:\n${c.content}${qa}`;
    })
    .join("\n");
  return `THE COMPOSED ENTRIES (judge each against its source Q&A):\n${list}`;
}

const compact = compactLine;

export interface WeaverLoreLine {
  comment: string;
  content: string;
}

export interface WeaverWorldMaterial {
  dream: string;
  spine: WeaverBibleSpine;
  lore: readonly WeaverLoreLine[];
  source_noun?: string;
}

function establishedMaterialBlock(reg: WeaverBuildRegistry, material: WeaverWorldMaterial): string {
  const parts: string[] = [];
  const dream = dreamBlock(material.dream, "the strongest grounding there is", material.source_noun);
  if (dream) parts.push(dream);
  if (material.spine.brief.trim()) {
    parts.push(`THE ${reg.subject.noun.toUpperCase()} IN BRIEF:\n${material.spine.brief.trim()}`);
  }
  const slotLines = material.spine.entries
    .filter((e) => e.content.trim())
    .map((e) => `- ${getSlot(reg.slots, e.slot)?.label ?? e.slot}: ${compact(e.content, 320)}`);
  if (slotLines.length > 0) parts.push(`ESTABLISHED:\n${slotLines.join("\n")}`);
  const loreLines = material.lore
    .map((l) => `- ${compact(l.comment, 80) || "(untitled)"}: ${compact(l.content, 240)}`)
    .filter((l) => l !== "- (untitled): ");
  if (loreLines.length > 0) parts.push(`THE LORE SO FAR:\n${loreLines.join("\n")}`);
  return parts.join("\n\n");
}

export function buildPeopleHarvestPrompt(reg: WeaverBuildRegistry): string {
  const people = reg.people!;
  return `You are the Weaver's people harvester. A ${reg.subject.noun} was just finished, and its hub needs to know who already lives in the author's material. ${people.lexicon.harvestInstruction}

Rules:
- ANCHOR every person: "anchor" names the specific established material — quote or name the place in the material — where this person is named or singled out. A person without an anchor is dropped.
- Keep names exactly as the material gives them; when the material singles someone out without naming them, give the role itself as the name (as the material words it).
- Each hook is ONE line: who this person is in the author's own material — their words and specifics, no embellishment.
- Never include a name already taken (the taken names are given).

Output STRICT JSON, no prose, no code fence:
{
  "people": [
    { "name": "<their name>", "hook": "<one line from the author's material>", "anchor": "<where the material names them>" }
  ]
}
An empty "people" array is a valid answer.`;
}

export function buildPeopleHarvestUserMessage(
  reg: WeaverBuildRegistry,
  input: {
    material: WeaverWorldMaterial;
    takenNames: readonly string[];
  },
): string {
  const parts: string[] = [establishedMaterialBlock(reg, input.material)];
  const taken = input.takenNames.map((n) => n.trim()).filter(Boolean);
  if (taken.length > 0) {
    parts.push(`NAMES ALREADY TAKEN (never include these):\n${taken.map((n) => `- ${n}`).join("\n")}`);
  }
  parts.push("Surface the people this material already names.");
  return parts.join("\n\n");
}

export function buildPeopleProposePrompt(reg: WeaverBuildRegistry): string {
  const people = reg.people!;
  return `You are the Weaver's people proposer. A finished ${reg.subject.noun} is growing its people from its hub. ${people.lexicon.proposeInstruction}

Rules:
- Propose exactly the number of people asked for.
- ANCHOR every person: "anchor" names the specific established material — the place, faction, rule, event, or tension, by its name — this person hangs off. A person without an anchor is dropped.
- NAMES follow THIS ${reg.subject.noun}'s naming culture: derive them from the naming patterns already present in the material (its people, places, factions, language). If the material already names someone, keep that name exactly. Never reach for a stock storybook name — a name that would fit any setting is a failure.
- Never propose a name already taken (the taken names are given), and never propose the ${reg.subject.noun} itself.
- Each hook is ONE line: who this person is and why they matter HERE, naming the material they hang off — no genre filler, no archetype labels.

Output STRICT JSON, no prose, no code fence:
{
  "people": [
    { "name": "<their name>", "hook": "<one line: who they are and why they matter here>", "anchor": "<the established material they hang off, by name>" }
  ]
}`;
}

export function buildPeopleProposeUserMessage(
  reg: WeaverBuildRegistry,
  input: {
    count: number;
    material: WeaverWorldMaterial;
    takenNames: readonly string[];
  },
): string {
  const parts: string[] = [establishedMaterialBlock(reg, input.material)];
  const taken = input.takenNames.map((n) => n.trim()).filter(Boolean);
  if (taken.length > 0) {
    parts.push(`NAMES ALREADY TAKEN (never propose these):\n${taken.map((n) => `- ${n}`).join("\n")}`);
  }
  parts.push(`Propose exactly ${input.count} people.`);
  return parts.join("\n\n");
}

export interface WeaverPersonMaterial {
  name: string;
  hook: string;
  interview: readonly { question: string; answer: string; kind: string }[];
}

const ANSWER_KIND_MARK: Record<string, string> = {
  typed: "the author's own words",
  picked: "picked from offered options",
  enhanced: "the author's words, extended",
};

function personBlock(person: WeaverPersonMaterial): string {
  const lines = [`THE PERSON:\n- Name: ${person.name}`];
  if (person.hook.trim()) lines.push(`- Hook: ${person.hook.trim()}`);
  if (person.interview.length > 0) {
    const qa = person.interview
      .map((i) => `- Q: ${i.question}\n  A: ${i.answer} [${ANSWER_KIND_MARK[i.kind] ?? ANSWER_KIND_MARK.typed}]`)
      .join("\n");
    lines.push(`\nWHAT THE AUTHOR ESTABLISHED ABOUT THEM:\n${qa}`);
  }
  return lines.join("\n");
}

const ALIASES_FIELD = `"aliases": ["<0 to 3 other things chat would call them — a title, a nickname; never generic words>"]`;

export function buildPersonExtraPrompt(reg: WeaverBuildRegistry): string {
  const people = reg.people!;
  return `You are the Weaver's extra-flesher. One background person in a finished ${reg.subject.noun} needs just enough body to be voiced in passing. ${people.lexicon.extraInstruction}

Ground every line in the given material — this person belongs to THIS ${reg.subject.noun}, not to a genre.

Output STRICT JSON, no prose, no code fence:
{
  "content": "<the 2-3 lines>",
  ${ALIASES_FIELD}
}`;
}

export function buildPersonExtraUserMessage(
  reg: WeaverBuildRegistry,
  input: { person: WeaverPersonMaterial; material: WeaverWorldMaterial },
): string {
  return [establishedMaterialBlock(reg, input.material), personBlock(input.person)].join("\n\n");
}

export function buildPersonQuestionPrompt(reg: WeaverBuildRegistry): string {
  const people = reg.people!;
  return `You are the Weaver's interviewer, on one person inside a finished ${reg.subject.noun}. ${people.lexicon.questionInstruction}

HOW TO ASK — the bar:
- Grounded in THIS person and THIS ${reg.subject.noun}. Build the question out of their hook, their answered material, and the established ${reg.subject.noun}; a question that could be asked about anyone is a failure.
- Ask, never assert. The question's premise may state only what is established about them; raise a new possibility AS a question, never as a fact. An invented premise steers the author and leaks into their canon.
- Plain language, no craft jargon — ask the way a sharp co-writer talks across a table.
- Obvious intent. Write a one-line "why": what this pins down for voicing them.
- One thing at a time. No compound questions, no multiple choice.
- Concrete beats abstract. What they did, said, chose, or avoided beats how they "generally are".

Output STRICT JSON, no prose, no code fence:
{
  "prompt": "<the question>",
  "why": "<one plain line on what this pins down>"
}`;
}

export function buildPersonQuestionUserMessage(
  reg: WeaverBuildRegistry,
  input: {
    person: WeaverPersonMaterial;
    material: WeaverWorldMaterial;
    avoid?: readonly string[];
  },
): string {
  const parts = [establishedMaterialBlock(reg, input.material), personBlock(input.person)];
  const avoid = (input.avoid ?? []).filter((a) => a && a.trim());
  if (avoid.length > 0) {
    parts.push(`Do NOT ask these (rejected or already shown) or near-rewordings of them:\n${avoid.map((a) => `- ${a}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

export function buildPersonQuestionGatePrompt(reg: WeaverBuildRegistry): string {
  const people = reg.people!;
  return `You are the Weaver's question gate. An interviewer proposed ONE question to ask the author about a person in their ${reg.subject.noun}. Judge whether it earns the author's time — a generic or redundant question wastes their attention and pulls the person toward the average. Be demanding, not a cheerleader.

Judge the proposed question against each criterion. For each, decide pass or fail and write one sharp sentence naming exactly what is strong or weak.

CRITERIA:
${people.questionGateCriteria.map((c) => `- ${c.key} (${c.label}): ${c.description}`).join("\n")}

Output STRICT JSON, no prose, no code fence:
{
  "criteria": [
    { "key": "<criterion key>", "passed": true|false, "note": "<one sharp sentence>" }
  ],
  "summary": "<one line>"
}`;
}

export function buildPersonQuestionGateUserMessage(
  reg: WeaverBuildRegistry,
  input: { prompt: string; why: string; person: WeaverPersonMaterial; material: WeaverWorldMaterial },
): string {
  const parts = [`THE PROPOSED QUESTION:\n${input.prompt}`];
  if (input.why.trim()) parts.push(`Its stated intent: ${input.why.trim()}`);
  parts.push(personBlock(input.person));
  parts.push(establishedMaterialBlock(reg, { ...input.material, lore: [] }));
  return parts.join("\n\n");
}

export function buildPersonWeavePrompt(reg: WeaverBuildRegistry): string {
  const people = reg.people!;
  return `You are the Weaver's people-weaver. A person in a finished ${reg.subject.noun} has been interviewed; their entry is being written into the ${reg.subject.noun}'s people book, where it surfaces whenever their name comes up so the narrator can voice them. ${people.lexicon.weaveInstruction}

Output STRICT JSON, no prose, no code fence:
{
  "content": "<the entry>",
  ${ALIASES_FIELD}
}`;
}

export function buildPersonWeaveUserMessage(
  reg: WeaverBuildRegistry,
  input: {
    person: WeaverPersonMaterial;
    material: WeaverWorldMaterial;
    revise?: { content: string; notes: string[] };
  },
): string {
  const parts = [establishedMaterialBlock(reg, input.material), personBlock(input.person)];
  if (input.revise) {
    parts.push(`A PREVIOUS ATTEMPT failed review. Revise it — fix exactly what the notes name and keep everything that works.\n\nTHE ATTEMPT:\n${input.revise.content}\n\nTHE NOTES:\n${input.revise.notes.map((n) => `- ${n}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

export function buildPersonWeaveGatePrompt(reg: WeaverBuildRegistry): string {
  const people = reg.people!;
  return `You are the Weaver's entry gate. A person's entry was composed for a finished ${reg.subject.noun}'s people book — the narrator voices this person from it whenever their name comes up. Judge whether it does that job. Be demanding, not a cheerleader.

Judge the entry against each criterion. For each, decide pass or fail and write one sharp sentence naming exactly what is strong or weak.

CRITERIA:
${people.weaveGateCriteria.map((c) => `- ${c.key} (${c.label}): ${c.description}`).join("\n")}

Output STRICT JSON, no prose, no code fence:
{
  "criteria": [
    { "key": "<criterion key>", "passed": true|false, "note": "<one sharp sentence>" }
  ],
  "summary": "<one line>"
}`;
}

export function buildPersonWeaveGateUserMessage(
  reg: WeaverBuildRegistry,
  input: { content: string; person: WeaverPersonMaterial; material: WeaverWorldMaterial },
): string {
  return [
    `THE ENTRY:\n${input.content}`,
    personBlock(input.person),
    establishedMaterialBlock(reg, { ...input.material, lore: [] }),
  ].join("\n\n");
}

export function buildImportReadingPrompt(
  actions: readonly { id: string; readingCue?: string }[],
): string {
  return `You are the Weaver's import reading. An author imported a roleplay artifact, and the studio must offer the treatment it actually reads as. The treatments:
${actions.map((a) => `- "${a.id}" — reads as ${a.readingCue ?? a.id}`).join("\n")}

Read the source text and decide which treatment fits what is actually written there. This is a preselection the author will confirm or override — when genuinely torn, pick the closest fit and say what makes it close.

Output STRICT JSON, no prose, no code fence:
{
  "action": "<treatment id>",
  "reason": "<one plain line naming what in the source reads that way, in the author's terms>"
}`;
}

export function buildImportReadingUserMessage(source: string): string {
  return `THE SOURCE:\n"""\n${source.trim()}\n"""`;
}

export function buildEntryEnrichPrompt(work: { instruction: string }): string {
  return `You are the Weaver's entry enricher. ${work.instruction}`;
}

export function buildEntryEnrichUserMessage(input: {
  entry: { comment: string; content: string };
  others: readonly { comment: string; content: string }[];
  revise?: { content: string; notes: string[] };
}): string {
  const parts: string[] = [];
  parts.push(`THE ENTRY TO DEEPEN${input.entry.comment ? ` — ${input.entry.comment}` : ""}:\n${input.entry.content}`);
  if (input.others.length > 0) {
    parts.push(
      `THE REST OF THE BOOK (the established material — stay strictly inside it):\n${input.others
        .map((o) => `- ${compact(o.comment, 80) || "(untitled)"}: ${compact(o.content, 240)}`)
        .join("\n")}`,
    );
  }
  if (input.revise) {
    parts.push(`A PREVIOUS ATTEMPT failed review. Revise it — fix exactly what the notes name and keep everything that works.\n\nTHE ATTEMPT:\n${input.revise.content}\n\nTHE NOTES:\n${input.revise.notes.map((n) => `- ${n}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

export function buildEntryEnrichGatePrompt(work: {
  gateCriteria: readonly { key: string; label: string; description: string }[];
}): string {
  return `You are the Weaver's enrichment gate. An imported worldbook entry was deepened, and the enriched version must earn its place over the original — the original is established material an author brought in, not a draft. Be demanding, not a cheerleader.

Judge the enriched entry against each criterion. For each, decide pass or fail and write one sharp sentence naming exactly what is strong or weak.

CRITERIA:
${work.gateCriteria.map((c) => `- ${c.key} (${c.label}): ${c.description}`).join("\n")}

Output STRICT JSON, no prose, no code fence:
{
  "criteria": [
    { "key": "<criterion key>", "passed": true|false, "note": "<one sharp sentence>" }
  ],
  "summary": "<one line>"
}`;
}

export function buildEntryEnrichGateUserMessage(input: {
  original: string;
  enriched: string;
}): string {
  return `THE ORIGINAL ENTRY:\n${input.original}\n\nTHE ENRICHED ENTRY:\n${input.enriched}`;
}
