---
title: Attachments
---

# Attachments

You can send images, audio, and video files alongside your messages. When your provider and model support the attachment's input type, the AI can respond to its contents.

---

## Sending an Attachment

1. Click the **Attachment** button in the input area (or drag a file into the chat)
2. Select an image, audio, or video file
3. The attachment appears as a preview in the input area
4. Type your message (optional) and send

The attachment is uploaded to Lumiverse's image system and stored alongside the message.

---

## Supported Formats

| Type | Formats |
|------|---------|
| **Images** | PNG, JPG, WebP, GIF |
| **Audio** | WAV, MP3, AIFF, AAC, OGG, FLAC |
| **Video** | MP4, MPEG, MOV, WebM, and other formats supported by your provider and model |

---

## How the AI Sees Attachments

When you send a message with an attachment, Lumiverse converts the file to base64 and includes it as multipart content in the prompt. The AI receives both the text and the media together.

!!! note "Model support"
    Not all AI models support image, audio, or video input. Check your provider's model capabilities; unsupported attachments may cause a request error or may not influence the AI's response.

For **OpenRouter image attachments**, select a model whose input modalities include **image**. OpenRouter documents PNG, JPEG, WebP, and GIF input. The number and size of images allowed can vary by model and upstream provider. See [OpenRouter's image input guide](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding).

For **OpenRouter audio attachments**, select a model whose input modalities include **audio**. The selected model and upstream provider must support the uploaded audio format; not every audio-capable model accepts every format. See [OpenRouter's audio input guide](https://openrouter.ai/docs/guides/overview/multimodal/audio).

For **OpenRouter video attachments**, select a model whose input modalities include **video**. OpenRouter documents MP4, MPEG, MOV, and WebM video input; individual models and providers can impose additional format, size, and duration limits. Lumiverse sends uploaded videos directly with the request using base64 encoding. See [OpenRouter's video input guide](https://openrouter.ai/docs/guides/overview/multimodal/videos).

Provider-specific formatting is handled automatically:

- **OpenAI** — Uses `image_url` and `input_audio` content parts
- **OpenRouter** — Uses `image_url`, `input_audio`, and `video_url` content parts
- **Anthropic** — Uses `image` source blocks
- **Google** — Uses `inlineData` parts

---

## Viewing Attachments

Attachments appear inline in the message. Click on an image attachment to open it in the **Image Lightbox** for a full-size view.
