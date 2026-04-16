# Setting Up Council

This guide walks you through configuring the council for AI-assisted deliberation.

---

## Enabling Council Mode

1. Open the **Council** panel (or find it in Settings)
2. Toggle **Council Mode** on
3. Add members (you need at least one)

---

## Adding Members

Each council member is based on a **Lumia item** from an installed pack.

1. Click **Add Member**
2. Select a Lumia from your installed packs
3. Configure the member:

| Setting | Description |
|---------|-------------|
| **Role** | A label for this member's function (e.g., "Story Architect," "Dialogue Coach") |
| **Tools** | Which council tools this member can use |
| **Chance** | Probability (0-100) this member participates in each deliberation |

### Chance

Setting chance below 100% adds variety — not every member speaks on every turn. A member with 70% chance participates roughly 7 out of 10 generations.

- **100%** — Always participates
- **50-80%** — Regular participant with natural variation
- **20-40%** — Occasional contributor
- **0%** — Effectively disabled without removing

---

## Sidecar Connection

Council tools need an AI model to run their analysis. This is the **sidecar connection** — a separate model (usually smaller and cheaper) used for background tasks.

Configure the sidecar in:
- **Sidecar Settings** in the Settings panel
- Or legacy: **Council Settings > Tools Settings > Sidecar**

!!! tip "Use a fast, cheap model"
    The sidecar handles quick analysis tasks, not full creative writing. A smaller model (like Haiku, Flash, or GPT-4o-mini) works well and keeps costs low.

---

## Council Without Tools

Council mode works even without assigning any tools. In this case, members engage in **pure self-debate** — they deliberate and discuss among themselves, providing general narrative guidance without structured tool outputs.

---

## Multiple Members

You can add multiple council members, each with different Lumia personas and tool assignments:

- **Story Architect** — Uses direction and pacing tools
- **Dialogue Coach** — Uses dialogue refinement tools
- **Sensitivity Reader** — Uses content safety tools
- **World Builder** — Uses scene and description tools

Each member brings their own perspective based on their Lumia's personality and assigned tools.

---

## Viewing Deliberation

After a generation completes, you can view the council's deliberation in the message metadata. This shows what each member analyzed, what tools they ran, and what guidance they provided.

The `{{lumiaCouncilDeliberation}}` macro contains the full deliberation results, which are injected into the prompt for the main generation.
