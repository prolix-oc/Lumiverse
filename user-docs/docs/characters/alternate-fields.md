# Alternate Fields & Avatars

Sometimes you want a character to behave differently depending on the context — a different personality for a comedy scenario, a different description after a time skip, or a different avatar for a costume change. Alternate fields and avatars let you create these variants without duplicating the entire character.

---

## Alternate Fields

Alternate fields let you create multiple versions of a character's **description**, **personality**, and **scenario** fields. You can then select which version to use on a per-chat basis.

### Creating Alternate Fields

1. Open the character editor
2. Click on the field you want to create a variant for (description, personality, or scenario)
3. Click **Add Variant**
4. Give the variant a label (e.g., "Post-Timeskip," "Comedy Mode," "Dark Timeline")
5. Write the alternate content
6. Save the character

You can create as many variants as you want for each field.

### Using Alternate Fields in Chat

1. Open a chat with the character
2. Click the **Alternate Fields** button in the input area action bar
3. Select which variant to use for each field
4. Your selection applies to this chat only — other chats with the same character keep their own selections

When an alternate field is active, it replaces the character's base field content during prompt assembly. The macros `{{description}}`, `{{personality}}`, and `{{scenario}}` resolve to the selected variant instead of the default.

---

## Alternate Avatars

Give your character multiple avatar options — different outfits, different art styles, or different phases of the story.

### Adding Alternate Avatars

1. Open the character editor
2. Go to the avatar section
3. Click **Add Alternate Avatar**
4. Upload an image and give it a label
5. Repeat for as many variants as you want

### Switching Avatars in Chat

1. In an active chat, click the character's portrait or the avatar switcher
2. Choose from the available avatars
3. The avatar changes for this chat only

The selected avatar is stored per-chat, so different conversations can show different looks for the same character.

---

## How It Works Behind the Scenes

- Alternate fields are stored in the character's extensions data — no extra database tables needed
- Per-chat selections are stored in the chat's metadata
- During prompt assembly, selected variants override the base fields before macros are resolved
- When exporting as CHARX, all alternate fields and avatars are included in the `lumiverse_modules.json` bundle
