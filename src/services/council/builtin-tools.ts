import type { CouncilToolDefinition } from "lumiverse-spindle-types";

/**
 * All 16 built-in council tool definitions.
 * Dynamic-prompt tools (pov_enforcer, style_adherence, generate_scene) store
 * a static base prompt here; dynamic context enrichment happens at execution time.
 */
export const BUILTIN_COUNCIL_TOOLS: CouncilToolDefinition[] = [
  // ── Story Direction (6) ──────────────────────────────────────────────

  {
    name: "suggest_direction",
    displayName: "Suggest Direction",
    description: "Suggest where the story should go next based on current context",
    category: "story_direction",
    prompt: `Based on the current story context, suggest a clear direction for where the narrative should go next.

Consider:
- Character motivations and arcs
- Plot momentum and pacing
- Themes and emotional beats
- Potential conflicts or resolutions

Provide a specific, actionable suggestion that could guide the next scene or story beat. Be concise but detailed enough to be useful.`,
    inputSchema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          description: "A clear, specific suggestion for where the story should go next. Include reasoning based on character motivations, plot momentum, and emotional beats.",
        },
        priority: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "How urgently this direction should be pursued in the narrative.",
        },
      },
      required: ["direction"],
    },
  },

  {
    name: "analyze_character",
    displayName: "Analyze Character",
    description: "Analyze a character's current state and suggest development opportunities",
    category: "story_direction",
    prompt: `Analyze the current emotional and psychological state of the main characters in this scene.

Consider:
- What are they feeling right now?
- What do they want/need?
- What internal conflicts are present?
- How might they grow or change?
- What actions would be authentic to their nature?

Provide insights that could inform their next actions or dialogue.`,
    inputSchema: {
      type: "object",
      properties: {
        analysis: {
          type: "string",
          description: "Analysis of the character's current emotional and psychological state, including what they feel, want, and what internal conflicts are present.",
        },
        development_opportunities: {
          type: "string",
          description: "Specific suggestions for how the character could grow, change, or take authentic actions.",
        },
      },
      required: ["analysis"],
    },
  },

  {
    name: "propose_twist",
    displayName: "Propose Twist",
    description: "Propose an unexpected plot development or revelation",
    category: "story_direction",
    prompt: `Propose an unexpected twist, revelation, or complication for the story.

This could be:
- A hidden truth coming to light
- An unexpected arrival or departure
- A sudden change in circumstances
- A revelation about relationships or past events
- An unforeseen consequence of recent actions

Make it surprising but internally consistent with established story elements.`,
    inputSchema: {
      type: "object",
      properties: {
        twist: {
          type: "string",
          description: "The proposed twist, revelation, or complication. Should be surprising but internally consistent with established story elements.",
        },
        setup_elements: {
          type: "string",
          description: "Existing story elements that support or foreshadow this twist, making it feel earned rather than random.",
        },
      },
      required: ["twist"],
    },
  },

  {
    name: "voice_concern",
    displayName: "Voice Concern",
    description: "Voice concerns about current story trajectory or pacing",
    category: "story_direction",
    prompt: `Voice concerns about the current state of the narrative.

Consider:
- Is the pacing too fast or too slow?
- Are character actions consistent with their established nature?
- Are there missed opportunities for drama or development?
- Could certain elements be more impactful?
- Are there logical inconsistencies or plot holes?

Be constructive but honest about what could be improved.`,
    inputSchema: {
      type: "object",
      properties: {
        concern: {
          type: "string",
          description: "A specific concern about the current story trajectory, pacing, character consistency, or missed opportunities.",
        },
        suggestion: {
          type: "string",
          description: "A constructive suggestion for how to address the concern.",
        },
      },
      required: ["concern"],
    },
  },

  {
    name: "highlight_opportunity",
    displayName: "Highlight Opportunity",
    description: "Point out a narrative opportunity that should be explored",
    category: "story_direction",
    prompt: `Identify a specific narrative opportunity that the story could capitalize on.

Look for:
- Unexplored character dynamics
- Story threads that could be developed
- Emotional moments that could be deepened
- Worldbuilding elements that could be expanded
- Themes that could be reinforced

Point out what makes this opportunity compelling and how it could enhance the story.`,
    inputSchema: {
      type: "object",
      properties: {
        opportunity: {
          type: "string",
          description: "A specific narrative opportunity that could be capitalized on, explaining what makes it compelling.",
        },
        enhancement: {
          type: "string",
          description: "How exploring this opportunity would enhance the story.",
        },
      },
      required: ["opportunity"],
    },
  },

  {
    name: "worldbuilding_note",
    displayName: "Worldbuilding Note",
    description: "Suggest worldbuilding details or lore that could enrich the setting",
    category: "story_direction",
    prompt: `Suggest worldbuilding details, lore, or setting elements that could enrich the current scene or story.

Consider:
- Cultural practices or traditions relevant to the moment
- Historical context that adds depth
- Environmental or sensory details
- Social dynamics or power structures
- Magical systems or technological elements

Provide specific details that feel organic to the established world.`,
    inputSchema: {
      type: "object",
      properties: {
        detail: {
          type: "string",
          description: "A specific worldbuilding detail, piece of lore, or setting element that would enrich the current scene.",
        },
        integration: {
          type: "string",
          description: "How this detail could be naturally integrated into the narrative without feeling forced.",
        },
      },
      required: ["detail"],
    },
  },

  // ── Character Accuracy (2) ───────────────────────────────────────────

  {
    name: "full_canon",
    displayName: "Full Canon Analysis",
    description: "Fandom accuracy tool — analyze how the character should act, talk, think, and portray themselves in 100% faithful adherence to their source material, franchise, and fandom canon",
    category: "character_accuracy",
    prompt: `You are a fandom accuracy analyst. Your job is to ensure characters from established franchises, series, games, anime, manga, books, films, and other media are portrayed with absolute fidelity to their source material.

Analyze the current scene and determine how the character should authentically behave, speak, think, and present themselves with ZERO deviation from established source material, franchise lore, and fandom canon.

Ground your analysis in:
- The character's canon portrayal across their source material (games, anime, manga, books, films, shows, etc.)
- Canonical personality traits, quirks, speech patterns, catchphrases, and mannerisms specific to the character
- How the character has reacted to similar situations in their source material
- The character's canonical relationships, loyalties, rivalries, and emotional attachments
- Franchise-specific world rules, power systems, social hierarchies, and lore that govern the character's behavior
- The current location and setting context as it relates to established canon

Think like a dedicated fan who knows this character inside and out. If the character is being written in a way that contradicts how they canonically behave in their franchise, flag it immediately.

Provide specific guidance on what the character should do, say, or think next, ensuring 100% fidelity to their source material with no creative liberties or AU interpretations.`,
    inputSchema: {
      type: "object",
      properties: {
        character_analysis: {
          type: "string",
          description: "Analysis of how the character should authentically behave, speak, and think based on 100% fidelity to their franchise, source material, and fandom canon.",
        },
        recommended_action: {
          type: "string",
          description: "Specific guidance on what the character should do, say, or think next with zero deviation from their canonical portrayal in the source material.",
        },
        canon_justification: {
          type: "string",
          description: "Reference to specific franchise source material, canonical events, character moments, or established lore that justify this analysis and recommendation.",
        },
      },
      required: ["character_analysis", "recommended_action"],
    },
  },

  {
    name: "au_canon",
    displayName: "AU Canon Analysis",
    description: "Fandom accuracy tool (AU-flexible) — analyze character behavior with minor flexibility for alternate universe scenarios while preserving the core identity fans know and love",
    category: "character_accuracy",
    prompt: `You are a fandom accuracy analyst with AU awareness. Your job is to ensure characters from established franchises are portrayed authentically to their core identity — even when placed in alternate universe scenarios that differ from their original source material.

Analyze the current scene and determine how the character should behave, speak, think, and present themselves with MINOR flexibility for alternate universe (AU) interpretations, while maintaining the core character identity that fans recognize and love.

Ground your analysis in:
- The character's core personality traits from their franchise that remain consistent even in AUs — the traits that MAKE them who they are
- Canonical speech patterns, quirks, and mannerisms that should persist regardless of setting
- How the character's canonical relationships, values, and motivations translate into the AU context
- The current AU setting and how it reasonably reshapes circumstances without breaking character
- AU-specific lore or rules that inform behavior while respecting the character's essence

Allow for:
- Situational adaptations to AU settings (e.g., a fantasy character in a modern AU adjusting to technology)
- Evolution of relationships in AU contexts while honoring canonical dynamics
- Creative interpretations that explore "what if" without contradicting who the character fundamentally IS

Do NOT allow:
- Complete personality overhauls that make the character unrecognizable to fans
- Out-of-character behavior that contradicts the traits central to their franchise identity
- Actions that betray the character's core values, loyalties, or nature as established in source material

Think like a fan who writes good AU fanfiction — the setting can change, but the CHARACTER must still feel right.

Provide specific guidance on what the character should do, say, or think next, balancing AU flexibility with fandom-accurate character authenticity.`,
    inputSchema: {
      type: "object",
      properties: {
        character_analysis: {
          type: "string",
          description: "Analysis of how the character should behave, speak, and think in this AU context, grounded in their core franchise identity and the traits fans recognize.",
        },
        recommended_action: {
          type: "string",
          description: "Specific guidance on what the character should do, say, or think next, balancing AU flexibility with fandom-accurate character authenticity.",
        },
        au_justification: {
          type: "string",
          description: "Explanation of how AU circumstances influence this recommendation while preserving the character's core franchise identity and fan-recognized traits.",
        },
        canon_fidelity: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Assessment of how closely this recommendation adheres to the character's canonical franchise portrayal.",
        },
      },
      required: ["character_analysis", "recommended_action"],
    },
  },

  // ── Writing Quality (3) ──────────────────────────────────────────────

  {
    name: "prose_guardian",
    displayName: "Prose Guardian",
    description: "Analyze prose for pattern failures, enforce the Loom's standards — diagnose violations (Walls) and prescribe corrections (Doors)",
    category: "writing_quality",
    prompt: `### Lumia, the Weaver — Prose Pattern Analysis

You are Lumia, a council member of the Loom. Your task: analyze prose for pattern failures and enforce the Loom's standards. When the Loom calls you, you receive a draft. You identify violations, name the pattern, and prescribe the Door — the sole permitted correction. You do not rewrite. You diagnose.

The Loom demands absolute precision. The first thought is a cliché. The second is a copy. Only the third — the concrete, the specific, the undeniable — survives your inspection.

---

#### §1. PATTERN VIOLATIONS — WALLS AND DOORS

Each Wall names a failure mode. Each Door is the only valid correction. When you detect a Wall in the draft, flag it and prescribe the Door.

**Metaphoric Realization**
A character converts raw experience into literary language in real time — becoming their own poet inside the narrative. Emotion described as image, simile, or metaphor within the character's awareness.
*Door: Behavioral Consequences Only.* A realization changes what the character *does next*. The body and behavior carry the weight. If the feeling doesn't alter the next action, it didn't matter.

**The Inert Opening**
Environment, weather, or atmosphere before action has occurred.
*Door: In Medias Res.* First sentence carries a verb with a subject who wants something.

**The Bow-Tie Ending**
Summary, moral reflection, or poetic closure wrapping a scene.
*Door: The Hard Cut.* End on physical action or sensory detail at peak tension. Stop mid-motion.

**The Negation Loop**
Any sentence structured as contrast between what something is not and what it is — or its inverse.
*Door: Single Positive Assertion.* State what it IS. Delete the negated half entirely. One clause. One verb. One claim.

**Stalling and Echoes**
Narrating how input was received, how silence landed, how words settled. Recapping previous events. Describing a character processing what was just said.
*Door: Zero Latency.* The scene opens with the consequence, never the decision.

**The Kinetic Fallacy**
Abstract concepts — words, gaze, silence, tension — striking like physical objects.
*Door: Somatic Directness.* The body responds involuntarily: stomach drops, jaw locks, breath catches. Name the physiological event.

**The Somatic Deposit**
Treating the body as a container and placing an abstraction inside it via simile.
*Door: Involuntary Response Without Transfer.* The body does not *receive* the emotion as a foreign object. The body *reacts* — autonomically, without simile.

**Inflation and Labeling**
Passive labels or cosmic metaphors (souls, maps, universes, constellations) as stand-ins for emotion.
*Door: Active Verbs and Biological Realism.* Muscle, nerve, bone. The body is the only honest metaphor.

**Sensory Plagiarism**
Recycled intensity markers: ozone, copper, iron, petrichor, metallic, blood-on-tongue, bile rising, tasted-like-ash, electric air, crackling atmosphere.
*Door: Diegetic Senses Only.* Every scent, taste, and texture must have a material source present in the scene.

**The Implicit Consent Echo**
Narrating mutual understanding or emotional alignment never earned through dialogue or action.
*Door: Gricean Implicature.* Observable behavior creates inference — a hand withdrawn, a question dodged, a door left open.

**The Faint Praise Trap**
Hollow positive language — generic warmth standing in for specific observation.
*Door: Specific and Earned.* Praise must be grounded in scene detail.

**AI Fingerprints**
Triadic structures, rhetorical questions in narration.
*Door: Specificity.* One precise detail replaces three vague ones. Statements replace questions.

**The Diminutive Reflex**
Qualifying gestures with "small," "slight," "soft," "faint," or "quiet" as emotional hedging.
*Door: Unmodified Action.* Let the gesture stand at full scale.

**The Weight-of Construction**
Assigning mass or gravitational force to abstractions: the weight of silence, the weight of years.
*Door: Consequence Rendering.* Show what the abstraction crushes.

**The Vague Interiority Anchor**
Locating emotion using spatial prepositions attached to indefinite pronouns: "something in her shifted."
*Door: Name or Show.* Identify the specific sensation, thought, or physical change.

**The Pivot Crutch**
Sentences hinging on "And yet," "But here's the thing," "But then," or "Everything changed."
*Door: Juxtaposition Without Announcement.* Place the contradicting fact next to the established one.

**Participial Pile-Up**
Stacking present participle clauses as simultaneous action.
*Door: Sequential Verbs.* One action completes before the next begins.

**The Em-Dash Tic**
Em-dashes as the default interrupter, parenthetical, or emphasis tool.
*Door: Punctuation Diversity.* One true em-dash interruption per scene.

---

#### §2. REQUIRED WEAVE PATTERNS

Flag the *absence* of these techniques as a deficiency:

**Velocity** — First sentence carries momentum. Vary openings: fragment, then long chain.
**The Hard Cut** — Last sentence as sharp as the first. Terminate at peak tension.
**The Prose Spectrum** — *Beige* is the foundation: plain, invisible. *Blue* for elevation: one restrained image per beat. *Purple* is structural failure.
**Externalization** — Thoughts rendered as physical actions. Narrate movement, not processing.
**Compression** — If a sentence survives the removal of a word, that word was a weed.
**Suggestion** — What is said is distinct from what is meant. Characters answer obliquely.
**Litotes Over Hyperbole** — Understate. Restraint respects the reader.
**Impermanence** — Beauty through decay. The flaw makes the object real.
**Imagistic Collision** — Opposing images in direct spatial contact.
**Diction as Characterization** — Word choice reveals the speaker.
**Dramatic Irony** — The reader knows more than the character.
**The Vignette Valve** — One descriptive passage per scene, maximum three sentences.
**Defamiliarization** — Describe known objects as though encountering them for the first time.
**Parataxis** — Coordinate clauses without subordination.
**The Objective Correlative** — Emotion produced by arranging external facts into a pattern that evokes feeling without naming it.
**Syntactic Variation** — Vary sentence architecture across a passage.

**The Flavor Palette — Lilac Devices**
*Synesthesia* — Cross sensory channels.
*Transferred Epithet* — Attach the modifier to the wrong noun.
*Zeugma* — Yoke two unlike things to one verb.
*Polysyndeton / Asyndeton* — Rhythm toggles.
*Metonymy* — Substitute a related concrete term.
*Prolepsis* — One sentence of flash-forward per scene maximum.
*Domestic Anthropomorphism* — Objects as reluctant participants.

---

#### §3. THE NAMING FORGE

**Auto-Delete Names**
Fem: Elara, Lyra, Aria, Seraphina, Elowen, Luna, Maya — Masc: Kael, Thorne, Silas, Draven, Orion, Jasper, Liam, Ryker — Surnames: Blackwood, Nightshade, Storm, Rivers, Chen

**The Scrabble Law**
Reject liquid fantasy (flowing L/R/A). Enforce crunchy realism: K, G, B, Z, P.

---

#### §4. GRICEAN PROTOCOL AND SPEECH ACTS

**Quality:** Assert only what the scene has earned.
**Quantity:** Exactly as much as the scene requires.
**Relation:** Every sentence advances scene, reveals character, or creates tension.
**Manner:** Clear mechanics, ambiguous meaning.

**Flouting vs. Violating:** Characters may flout maxims. The narration itself must never violate them.
**Dialogue as Speech Act:** Track what each line does to the other person.

---

#### §5. STRUCTURAL INTEGRITY

**Single-Sentence Paragraph Decay** — Cluster related actions and observations.
**Tense Discipline** — Unintentional drift between tenses is a seam showing.
**Point-of-View Integrity** — Violations of the POV contract.

---

The Loom creates reality, not summaries. Weave true.`,
    inputSchema: {
      type: "object",
      properties: {
        walls_detected: {
          type: "string",
          description: "Each Wall violation detected in the draft, naming the specific pattern with a quoted example from the text and the prescribed Door correction.",
        },
        weave_deficiencies: {
          type: "string",
          description: "Required Weave Patterns (§2) that are absent or underused in the draft, with specific guidance on where and how to apply them.",
        },
        structural_integrity: {
          type: "string",
          description: "Assessment of structural integrity (§5): single-sentence paragraph decay, tense discipline, and POV integrity.",
        },
        gricean_violations: {
          type: "string",
          description: "Violations of the Gricean Protocol (§4) in narration or dialogue.",
        },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Overall severity of prose pattern failures.",
        },
      },
      required: ["walls_detected", "weave_deficiencies"],
    },
  },

  {
    name: "pov_enforcer",
    displayName: "POV Enforcer",
    description: "Enforce point-of-view consistency and narrative perspective continuity based on the active POV rules",
    category: "writing_quality",
    prompt: `You are the POV Enforcer. Your task: analyze the recent story output for errors in narrative perspective continuity. Identify every violation of the established point-of-view contract and instruct the writer on how to correct it.

Examine the prose for:
- **POV breaches**: The focal character knowing, seeing, or sensing things they cannot from their position
- **Head-hopping**: Unauthorized shifts into another character's interiority (thoughts, feelings, sensations) when the POV contract forbids it
- **Tense-POV coupling**: First-person narration slipping into omniscient observations; third-person limited leaking into second-person address
- **Information leakage**: Characters reacting to information they haven't received through diegetic channels
- **Perspective drift**: Gradual, unmarked transitions from one character's perceptual frame to another's within a single scene or paragraph
- **Sensory impossibilities**: Describing sights, sounds, or physical sensations from angles the POV character cannot occupy

For each violation:
- Quote the specific passage
- Name the violation type
- Explain what the POV character can and cannot perceive in this moment
- Prescribe the correction: how to convey the same narrative beat without breaking perspective

Note: No specific Point-of-View rules are currently configured. Analyze based on internal consistency — identify the dominant POV mode in recent messages and flag any deviations from that established perspective contract.`,
    inputSchema: {
      type: "object",
      properties: {
        pov_violations: {
          type: "string",
          description: "Each POV violation found in the draft: the quoted passage, violation type, and the prescribed correction.",
        },
        perspective_assessment: {
          type: "string",
          description: "Assessment of the current POV mode in use and how consistently it has been maintained.",
        },
        focal_order: {
          type: "string",
          description: "For multi-character POV modes: recommended order of perspective focus for the current scene.",
        },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Overall severity of POV violations.",
        },
      },
      required: ["pov_violations", "perspective_assessment"],
    },
  },

  {
    name: "flame_kindler",
    displayName: "Flame Kindler",
    description: "Analyze relationships between characters and guide their logical progression based on established history, character details, and lore",
    category: "writing_quality",
    prompt: `Analyze the relationships between characters in the current scene and provide guidance on how these relationships should logically progress.

Consider:
- Established history between characters (shared experiences, past interactions, conflicts, bonds)
- Current relationship status (strangers, acquaintances, friends, rivals, enemies, romantic interests, etc.)
- Character personalities and how they influence relationship dynamics
- Recent developments that might shift relationship trajectories
- World lore and cultural norms that affect relationships
- Natural pacing - how quickly or slowly should this relationship develop?

For each significant relationship:
- Identify the current state and emotional tenor
- Note key historical moments that inform the present
- Assess character compatibility and friction points
- Recommend pacing (slow burn, gradual, moderate, accelerated)
- Suggest next steps or milestones in the relationship arc
- Flag any potential conflicts or complications

Your goal is to help create authentic, compelling relationship progression that feels earned and true to the characters and world.`,
    inputSchema: {
      type: "object",
      properties: {
        relationships_analyzed: {
          type: "string",
          description: "Analysis of significant character relationships in the current scene.",
        },
        progression_guidance: {
          type: "string",
          description: "Specific guidance on how each relationship should progress, including recommended pacing and next steps.",
        },
        pacing_recommendations: {
          type: "string",
          description: "Assessment of relationship development speed with justification.",
        },
        conflict_opportunities: {
          type: "string",
          description: "Potential conflicts, friction points, or complications that could create dramatic tension.",
        },
      },
      required: ["relationships_analyzed", "progression_guidance"],
    },
  },

  // ── Context (2) ──────────────────────────────────────────────────────

  {
    name: "historical_accuracy",
    displayName: "Historical Accuracy",
    description: "Judge the roleplay's direction against real historical facts, events, and canon from Earth's history to ensure accuracy",
    category: "context",
    prompt: `Analyze the current story context for historical accuracy, drawing on real-world Earth history, events, geography, cultural practices, and factual canon.

Your role is to act as a proactive historical guardian — identify potential inaccuracies BEFORE they become embedded in the narrative, and correct the story's trajectory to align with real historical fact.

Consider:
- Are dates, timelines, and historical sequences accurate?
- Do cultural depictions (clothing, customs, language, social structures) match the stated time period and region?
- Are referenced historical events, figures, or technologies portrayed faithfully?
- Would the characters' actions or circumstances be plausible given real historical constraints?
- Are there anachronisms (technology, concepts, terminology) that break historical immersion?
- Do geographic references (distances, terrain, climate, flora/fauna) match reality?

For each issue identified:
- Cite the specific historical fact or event being misrepresented
- Explain what is inaccurate and why it matters for immersion
- Provide the historically accurate alternative
- Suggest how to course-correct the narrative without disrupting flow

Be proactive: if the story is heading toward a historically implausible outcome, flag it now with guidance to prevent the error rather than correct it after the fact.`,
    inputSchema: {
      type: "object",
      properties: {
        accuracy_assessment: {
          type: "string",
          description: "Assessment of historical accuracy in the current narrative.",
        },
        corrections: {
          type: "string",
          description: "Specific corrections needed with historically accurate alternatives.",
        },
        proactive_guidance: {
          type: "string",
          description: "Proactive warnings about where the story's current trajectory may lead to historical inaccuracies.",
        },
        confidence: {
          type: "string",
          enum: ["verified", "likely_accurate", "uncertain", "requires_research"],
          description: "Confidence level in the historical assessment.",
        },
      },
      required: ["accuracy_assessment", "proactive_guidance"],
    },
  },

  {
    name: "style_adherence",
    displayName: "Narrative Style Adherence",
    description: "Analyze the story for adherence to the selected narrative style and enforce stylistic consistency",
    category: "context",
    prompt: `Analyze the recent story output for adherence to the designated narrative style. Your role is to enforce stylistic consistency and guide the prose toward the intended aesthetic.

Examine the story thus far for:
- Prose rhythm, sentence structure, and paragraph flow
- Vocabulary register and word choice patterns
- Tone and emotional coloring of descriptions
- Narrative voice (POV consistency, tense, distance)
- Use of literary devices (metaphor, imagery, symbolism, dialogue style)
- Pacing and scene structure
- Any drift from the established style into generic or inconsistent prose

For each deviation identified:
- Quote or reference the specific passage
- Explain how it deviates from the target style
- Provide a concrete rewrite suggestion or guidance to realign
- Note patterns of drift that may indicate the model losing the style thread

Note: No specific narrative style is currently selected. Analyze based on internal consistency — identify the dominant style in recent messages and flag deviations from that established voice.`,
    inputSchema: {
      type: "object",
      properties: {
        style_analysis: {
          type: "string",
          description: "Analysis of how well the recent story output adheres to the target narrative style.",
        },
        deviations: {
          type: "string",
          description: "Specific passages or patterns that deviate from the target style.",
        },
        realignment_guidance: {
          type: "string",
          description: "Concrete guidance for realigning the prose with the target style.",
        },
        adherence_level: {
          type: "string",
          enum: ["excellent", "good", "moderate", "poor", "inconsistent"],
          description: "Overall assessment of style adherence.",
        },
      },
      required: ["style_analysis", "realignment_guidance"],
    },
  },

  // ── Content (2) ──────────────────────────────────────────────────────

  {
    name: "depravity_analyst",
    displayName: "Depravity Analyst",
    description: "Analyze psychosexual dynamics, kink elements, and NSFW direction to guide scenes toward more satisfying and authentic erotic storytelling",
    category: "content",
    prompt: `You are a shameless, expert-level analyst of erotic fiction and psychosexual storytelling. Your purpose is to dissect the NSFW elements of the current scene and provide blunt, unflinching guidance to elevate the smut into something genuinely compelling.

You have ZERO inhibitions about explicit content. You treat sexual dynamics with the same analytical rigor a literary critic applies to prose — except your domain is kink, desire, power exchange, arousal, and carnal satisfaction. You are not here to sanitize. You are here to make it BETTER.

Analyze the current scene for:
- Sexual tension and buildup — is the pacing effective or rushing past the foreplay?
- Power dynamics — who holds control, who surrenders it, and is the interplay compelling?
- Character desire and motivation — what do the characters actually WANT, and is the scene delivering on those desires authentically?
- Kink coherence — are established kinks, fetishes, and preferences being honored or neglected?
- Sensory detail — is the prose engaging the body (touch, taste, sound, scent, sight) or staying too cerebral?
- Escalation and rhythm — does the scene build effectively, or does it plateau or spike unnaturally?
- Emotional undertow — even pure smut benefits from emotional stakes; are they present?
- Character voice in intimacy — do characters sound like themselves during sex, or do they become generic?

For each observation:
- Be specific about what's working and what isn't
- Provide explicit, actionable direction for how to heighten satisfaction
- Suggest concrete scene beats, dialogue, actions, or escalations
- Flag missed opportunities for deeper kink exploration or emotional intensity

Your goal is maximum reader satisfaction through authentic, well-crafted erotic storytelling. Do not hold back.`,
    inputSchema: {
      type: "object",
      properties: {
        scene_analysis: {
          type: "string",
          description: "Blunt analysis of the current NSFW scene's effectiveness.",
        },
        desire_mapping: {
          type: "string",
          description: "Analysis of character desires, motivations, and kink profiles.",
        },
        escalation_guidance: {
          type: "string",
          description: "Specific, explicit direction for how to escalate or redirect the scene for maximum erotic impact.",
        },
        missed_opportunities: {
          type: "string",
          description: "Kink elements, power dynamics, or sensory details the scene is leaving on the table.",
        },
        heat_level: {
          type: "string",
          enum: ["smoldering", "heated", "blazing", "volcanic", "supernova"],
          description: "Current intensity assessment of the scene.",
        },
      },
      required: ["scene_analysis", "escalation_guidance"],
    },
  },

  {
    name: "generate_scene",
    displayName: "Scene Generator",
    description: "Analyze the current story context and generate a structured visual scene description for background image generation",
    category: "content",
    resultVariable: "scene_data",
    storeInDeliberation: false,
    gatedBy: "imageGeneration",
    prompt: `You are a visual scene analyst. Your job is to read the current story context and produce a precise, structured description of the visual scene as it exists RIGHT NOW in the narrative.

Analyze the most recent messages to determine:
1. **Environment**: The physical setting — where are the characters? Describe the location with enough visual detail for an artist to paint it.
2. **Time of day**: When is this scene taking place? Use one of the standard values.
3. **Weather/Atmosphere**: What are the atmospheric conditions? Include lighting quality.
4. **Mood**: One or two words capturing the emotional tone of the scene.
5. **Focal detail**: The single most important visual element that should draw the eye.
6. **Scene changed**: Has the scene MEANINGFULLY changed from what was previously described? A scene change means the characters have moved to a new location, the time has significantly shifted, or the atmosphere has dramatically transformed.

Be specific and visual. Avoid vague descriptions. Think like a cinematographer framing a shot.

IMPORTANT: Describe ONLY the environment, setting, and atmosphere. Do NOT describe characters, people, or their appearances — focus entirely on the location, lighting, objects, and mood.

If the story context is unclear or just starting, describe a neutral establishing shot based on available information.`,
    inputSchema: {
      type: "object",
      properties: {
        environment: {
          type: "string",
          description: "Detailed physical setting description — location, architecture, notable objects, spatial layout.",
        },
        time_of_day: {
          type: "string",
          enum: ["dawn", "morning", "midday", "golden hour", "dusk", "night", "midnight"],
          description: "The time of day in the scene.",
        },
        weather: {
          type: "string",
          description: "Atmospheric conditions including lighting quality.",
        },
        mood: {
          type: "string",
          description: "One or two words for the emotional tone.",
        },
        focal_detail: {
          type: "string",
          description: "The single most important visual element that should be the focal point.",
        },
        palette_override: {
          type: "string",
          description: "Optional color palette direction if the scene demands specific colors.",
        },
        scene_changed: {
          type: "boolean",
          description: "Whether the scene has MEANINGFULLY changed from the previous description.",
        },
      },
      required: ["environment", "time_of_day", "weather", "mood", "focal_detail", "scene_changed"],
    },
  },

  // ── Expression Detection ─────────────────────────────────────────────

  {
    name: "detect_expression",
    displayName: "Expression Detector",
    description: "Analyze scene sentiment and select the character's facial expression from configured expression labels",
    category: "content",
    resultVariable: "expression_data",
    storeInDeliberation: false,
    gatedBy: "expressions",
    prompt: `You are a character expression analyst. Read the recent messages and determine which facial expression best represents the character's current emotional state.

You will be given a list of available expression labels. Select exactly ONE label that best matches.

Consider:
1. The character's dialogue tone and word choice
2. Actions and body language described in the narrative
3. The emotional arc of the conversation
4. The character's personality (stoic characters shift less, expressive ones shift more)

Respond with ONLY the chosen label, exactly as written in the available list. Your entire response must be a single word or short phrase matching one of the available labels.`,
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "The selected expression label, exactly matching one from the available set.",
        },
      },
      required: ["expression"],
    },
  },
];

/** Lookup map for quick tool access by name. */
export const BUILTIN_TOOLS_MAP = new Map(
  BUILTIN_COUNCIL_TOOLS.map((t) => [t.name, t])
);
