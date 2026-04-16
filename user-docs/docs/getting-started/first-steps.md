# First Steps

This guide walks you through everything you need to go from a fresh install to your first conversation.

---

## Step 1: Create a Connection

A **connection** tells Lumiverse which AI provider and model to use. You need at least one.

1. Open the **Connection Manager** panel (plug icon in the sidebar)
2. Click **New Connection**
3. Fill in:
    - **Name** — A label for your reference (e.g., "My Claude Sonnet")
    - **Provider** — Pick your AI provider from the dropdown
    - **Model** — Select or type the model name
    - **API Key** — Paste your API key (stored encrypted, never visible again)
4. Click **Save**
5. Set it as the **default** connection if it's your primary one

!!! tip "Multiple connections"
    You can create as many connections as you want — different providers, different models, different API keys. Switch between them at any time.

---

## Step 2: Import a Character

Characters are the AI personas you chat with. The fastest way to get started is importing one.

1. Open the **Character Browser** panel (people icon in the sidebar)
2. Click the **Import** button
3. Choose one of:
    - **File upload** — Drag in a `.png` (character card), `.json`, or `.charx` file
    - **Import from URL** — Paste a link from Chub.ai, JanitorAI, or a direct file URL
4. The character appears in your browser, ready to chat

You can also [create a character from scratch](../characters/creating-characters.md) if you prefer.

---

## Step 3: Start a Chat

1. Click on a character in the Character Browser
2. Click **New Chat** (or just click the character card — it opens a chat automatically)
3. The character's greeting message appears
4. Type your message in the input area at the bottom and press **Enter** (or click the send button)

That's it — you're chatting!

---

## Step 4: Create a Persona (Optional)

A **persona** represents *you* in the conversation. Without one, the AI only knows your username. A persona adds a description the AI can reference.

1. Open the **Persona** panel (user icon in the sidebar)
2. Click **New Persona**
3. Fill in a name and description for your character
4. Optionally upload an avatar
5. Set it as your **default** persona

Your persona's name replaces `{{user}}` in prompts, and the description is available via `{{persona}}`.

---

## What to Explore Next

Now that you're chatting, here are features worth exploring:

- **[Swipes](../chatting/messages-and-swipes.md)** — Don't like a response? Swipe to generate a new one
- **[Presets](../presets/index.md)** — Customize how prompts are assembled and what the AI "sees"
- **[World Books](../world-books/index.md)** — Add lore that activates when keywords come up in chat
- **[Themes](../customization/themes.md)** — Change the look and feel of the interface
- **[Group Chats](../chatting/group-chats.md)** — Chat with multiple characters at once
