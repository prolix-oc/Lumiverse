# Expressions

Expressions are visual emotion sprites that change dynamically as the conversation progresses. When enabled, the character's portrait updates to reflect their current mood — smiling when happy, frowning when upset, blushing when embarrassed.

---

## How It Works

1. You upload a set of labeled images (e.g., "happy," "sad," "angry," "neutral")
2. After each AI response, a lightweight sidecar LLM call analyzes the conversation
3. It picks the expression that best matches the character's current emotional state
4. The portrait panel updates to show that expression

The detection happens automatically in the background — you don't need to do anything during the conversation.

---

## Setting Up Expressions

### Upload a ZIP

The easiest method — prepare a ZIP file with images named after emotions:

```
expressions.zip
├── neutral.png
├── happy.png
├── sad.png
├── angry.png
├── surprised.png
├── embarrassed.png
└── thinking.png
```

1. Open the character editor
2. Go to the **Expressions** tab
3. Click **Import ZIP**
4. Select your ZIP file

The filenames (minus the extension) become the expression labels.

### Map from Gallery

If your expression images are already uploaded to Lumiverse's image system:

1. Open the **Expressions** tab in the character editor
2. Click **From Gallery**
3. Map each gallery image to an expression label

### Manual Setup

Add expressions one at a time:

1. Open the **Expressions** tab
2. Click **Add Expression**
3. Upload an image and give it a label

---

## Expression Config

| Setting | Description |
|---------|-------------|
| **Enabled** | Toggle expressions on/off for this character |
| **Default Expression** | Which expression to show when no detection has run yet (usually "neutral") |

---

## Expression Labels

You can use any label names you want. Common ones include:

`neutral` `happy` `sad` `angry` `surprised` `embarrassed` `thinking` `smirk` `scared` `confused` `excited` `blushing` `crying` `laughing` `serious` `flirty` `annoyed` `worried`

Use labels that match how your character naturally emotes. You don't need dozens — even 4-6 well-chosen expressions create a lively portrait.

---

## Detection Modes

Expression detection is controlled by the `expressionDetection` setting:

| Mode | Behavior |
|------|----------|
| **Auto** | Uses the sidecar connection to detect expressions after each generation |
| **Council** | Expression detection runs as a council tool (when council is active) |
| **Off** | No automatic detection — expressions stay on the default |

---

## Tips

!!! tip "Use transparent PNGs"
    Expression images with transparent backgrounds look best — they overlay cleanly on the portrait panel regardless of the theme.

!!! tip "Keep it lightweight"
    Expression detection uses a small, fast sidecar LLM call. It adds minimal latency to generation, but if you want to eliminate it entirely, set detection to "Off."

!!! tip "Group chats"
    Each character in a group chat can have their own expression set. The portrait panel shows the currently focused character's expression.
