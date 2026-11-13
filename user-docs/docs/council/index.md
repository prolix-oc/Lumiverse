---
title: Council
---

# Council

The **Council** is Lumiverse's multi-persona deliberation system. Before the AI generates a response, a panel of AI personas can analyze the scene, suggest directions, and provide guidance — all feeding into the final output.

**Lumia** refers to the AI personas that make up the council. Each Lumia has a defined personality, behavior, and set of tools it can use.

## Navigating Council

Open **Council** in the drawer. Its three internal tabs are **Setup · Feedback · OOC**; each keeps its own scroll position as you switch between them.

| Tab | What it does |
|-----|--------------|
| **Setup** | Enable Council, choose its profile or loadout, select Lumia, configure the sidecar and tool mode, and add members with their tool assignments and context settings. **+ Create tool** opens the tool editor directly; **Open Workshop** opens the general asset workshop. |
| **Feedback** | Review the latest Council tool results grouped by member, including completion status and duration. A green dot on the tab means Council is enabled and feedback is active. During execution it shows a spinner; after tools return results it shows their count. An enabled Council with no results yet shows a waiting state. |
| **OOC** | Enable out-of-character comments and choose their display style and interval. When comments are disabled, this tab explains what they do. OOC comments appear alongside the story; Feedback contains tool execution results. |

Start in **Setup**, switch to **Feedback** to inspect what your members' tools returned during generation, and use **OOC** to configure commentary in chat. Council needs participating members with assigned tools to produce tool feedback.

**Composition** is a separate drawer destination for Loom Content, Sovereign Hand, and Context Filters. These configure the broader generation prompt and are available independently of Council. **Creator Workshop** and **Pack Browser** also remain independently accessible.

---

## How It Works

When council mode is enabled:

1. You send a message
2. Before the main AI generates, each council member **deliberates**
3. Members can run **tools** (analyze characters, suggest plot twists, check pacing, etc.)
4. Their insights are compiled into a **deliberation block**
5. The deliberation block is injected into the main prompt
6. The main AI generates its response with the council's guidance

Think of it as giving the AI a team of advisors who consult before every reply.

---

## Council vs. Group Chat

| Feature | Council | Group Chat |
|---------|---------|------------|
| **Who speaks** | Only the main character responds | Multiple characters take turns |
| **Deliberation** | Members advise behind the scenes | Characters speak publicly |
| **Tools** | Members can use specialized analysis tools | No tool access |
| **Visibility** | Users can see deliberation but characters don't | All messages are visible |

---

## Chimera Mode

An alternative to traditional council — instead of separate members advising, Chimera mode **fuses** the selected Lumia definitions into a single blended persona. The AI responds as a synthesis of all selected styles rather than receiving separate advice.

---

## Quick Links

| Guide | What You'll Learn |
|-------|-------------------|
| [Setting Up Council](setting-up-council.md) | Configure members and their roles |
| [Council Tools](council-tools.md) | What tools are available and how they work |
| [OOC Comments](../chatting/ooc.md) | Enable and style commentary alongside the story |
