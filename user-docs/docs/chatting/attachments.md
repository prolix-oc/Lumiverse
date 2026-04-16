# Attachments

You can send images and audio files alongside your messages. When the AI supports multimodal input (vision or audio), it can see and respond to your attachments.

---

## Sending an Attachment

1. Click the **Attachment** button in the input area (or drag a file into the chat)
2. Select an image or audio file
3. The attachment appears as a preview in the input area
4. Type your message (optional) and send

The attachment is uploaded to Lumiverse's image system and stored alongside the message.

---

## Supported Formats

| Type | Formats |
|------|---------|
| **Images** | PNG, JPG, WebP, GIF |
| **Audio** | WAV, MP3, and other common audio formats |

---

## How the AI Sees Attachments

When you send a message with an attachment, Lumiverse converts the file to base64 and includes it as multipart content in the prompt. The AI receives both the text and the media together.

!!! note "Model support"
    Not all AI models support vision or audio input. If your current model doesn't support it, the attachment is still saved with the message but may not influence the AI's response. Check your provider's model capabilities.

Provider-specific formatting is handled automatically:

- **OpenAI** — Uses `image_url` and `input_audio` content parts
- **Anthropic** — Uses `image` source blocks
- **Google** — Uses `inlineData` parts

---

## Viewing Attachments

Attachments appear inline in the message. Click on an image attachment to open it in the **Image Lightbox** for a full-size view.
