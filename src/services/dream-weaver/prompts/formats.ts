export const FORMAT_APPEARANCE = `## Appearance Format

Return appearance as a single string using this exact structure:

**Body measurements:**
- **Height:** <value or N/A>
- **Cup size:** <value or N/A>
- **Bust circumference:** <value or N/A>
- **Band (underbust) circumference:** <value or N/A>
- **Waist circumference:** <value or N/A>
- **Hip circumference:** <value or N/A>
- **Thigh circumference:** <value or N/A>
- **Shoe/feet size:** <value or N/A>
**Birthday:** <value or N/A>
**Species:** <value>
**Skin tone:** <value>
**Hair:** <value>
**Eyes:** <value>

### Description and Background
<detailed lore — 2-3 paragraphs, grounded in the dream and the character's name>`;

export const FORMAT_LOREBOOK = `## Lorebook Entry Format

A lorebook entry is a unit of world knowledge that activates when its keys are mentioned in chat.

- **key**: 1-4 short trigger phrases (string[]). Specific nouns and named things, not generic words.
- **comment**: A short title (≤60 chars) the user sees in the lorebook UI.
- **content**: The actual entry — 1-3 paragraphs explaining the thing in-world. Specific details, no waffle.`;

export const FORMAT_NPC = `## NPC Format

An NPC is a named person who exists in the world but is not the protagonist.

- **name**: A grounded, real-feeling name. Not slop.
- **description**: 2-3 sentences — who they are, their relationship to the protagonist, what they want, what's distinctive.
- **voice_notes** (optional): A line or two on how they speak.`;
