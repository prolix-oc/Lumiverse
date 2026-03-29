# Creating Characters

Building a character from scratch gives you full control over how the AI portrays them.

---

## Creating a New Character

1. Open the **Character Browser** panel
2. Click **New Character**
3. Fill in the fields you want (only **Name** is required)
4. Optionally upload an avatar image
5. Click **Save**

---

## Field Guide

Here's how each field influences the AI's behavior:

### Name

The character's name as it appears in chat. This is also what macros like `{{char}}` resolve to. Keep it consistent — the AI uses this to know who it's speaking as.

### Description

The most important field for character definition. Include physical appearance, background, key personality traits, relationships, and anything the AI should always know about this character.

!!! tip "Be specific"
    Instead of "She is nice," try "She speaks softly and often pauses mid-sentence to choose her words carefully. She avoids conflict but has a sharp wit when comfortable."

### Personality

A focused summary of traits. Some people use this for a trait list (e.g., "curious, stubborn, secretly kind") while others write a brief paragraph. It's inserted separately from the description, so avoid repeating yourself.

### Scenario

Sets the scene. What's happening when the conversation starts? Where are the characters? What's the context? This field is great for establishing the "world" of the roleplay without cluttering the description.

### First Message

The character's opening line when you start a new chat. This is crucial — it sets the tone for the entire conversation. A well-written first message demonstrates the character's voice, establishes the setting, and gives you something to respond to.

!!! tip "Alternate greetings"
    You can add multiple first messages by clicking **Add Alternate Greeting**. When starting a new chat, you'll be asked which greeting to use. Great for different scenarios with the same character.

### Example Messages

Sample exchanges that show the AI *how* the character talks. Format them like this:

```
<START>
{{user}}: How are you today?
{{char}}: *adjusts glasses* Oh, you know. Same old existential dread, different Tuesday. *smirks* At least the coffee's decent.
```

Use `<START>` to separate different example conversations. These aren't included in the chat itself — they're training examples the AI references for tone and style.

### System Prompt

Direct instructions to the AI about how to play this character. Unlike the description (which is *about* the character), the system prompt tells the AI what to *do*.

Example: "Write in third person limited perspective. Include inner thoughts in italics. Keep responses between 2-4 paragraphs."

### Post-History Instructions

Similar to the system prompt, but injected *after* the chat history instead of before it. This is useful for reminders the AI should see right before generating its response.

### Creator Notes

Notes for other users (or yourself) about the character. These are **never sent to the AI** — they're purely informational. Use them for usage tips, recommended settings, or changelog notes.

### Tags

Labels for organizing your library. Add tags like "fantasy," "sci-fi," "male," "OC," etc. You can filter your Character Browser by tags.

---

## Uploading an Avatar

Click the avatar area in the character editor to upload an image. Supported formats: PNG, JPG, WebP, GIF. The image is stored in Lumiverse's image system with an auto-generated thumbnail.

---

## Duplicating a Character

Want to create a variant of an existing character? Click the **Duplicate** button on any character card. This creates a full copy with "(Copy)" appended to the name. Edit the copy without affecting the original.

---

## Exporting Characters

Share your characters by exporting them:

1. Open the character in the editor
2. Click **Export**
3. Choose a format:
    - **JSON** — Clean data file (smallest, universal)
    - **PNG** — Avatar image with embedded character data (most portable)
    - **CHARX** — Full bundle including expressions, alternate fields, and avatars (most complete)

PNG exports are the standard sharing format — they look like normal images but carry all the character data inside.
