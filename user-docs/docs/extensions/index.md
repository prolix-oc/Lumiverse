# Extensions

Lumiverse supports extensions through **Spindle**, an isolated extension system. Extensions can add new features, modify behavior, and integrate with external services.

---

## What Extensions Can Do

- Add custom panels and UI widgets
- Define new macros for use in presets
- Intercept and modify prompts before they reach the AI
- Listen to events (messages, generation, etc.)
- Store data persistently
- Access the generation pipeline
- Create custom council tools
- Apply theme overrides
- Send notifications

---

## Installing Extensions

!!! warning "Trust model"
    Extensions run code on your server. Only install extensions from sources you trust. Installing an extension is equivalent to running arbitrary code on your machine.

1. Open the **Spindle Panel**
2. Click **Install Extension**
3. Provide the extension source (URL or local path)
4. Review the requested **permissions**
5. Click **Install**

Extensions are **disabled by default** after installation. You must explicitly enable them.

---

## Managing Extensions

From the Spindle Panel:

- **Enable/Disable** — Toggle extensions on and off
- **Configure** — Adjust extension-specific settings
- **Permissions** — Review and manage what the extension can access
- **Uninstall** — Remove the extension and its data

---

## Permissions

Extensions request specific permissions for what they can access:

| Permission | What It Grants |
|------------|---------------|
| **Storage** | Read/write persistent file storage |
| **Generation** | Access to the LLM generation pipeline |
| **Characters** | Read/write character data |
| **Chats** | Read/write chat data |
| **World Books** | Read/write world book data |
| **Regex Scripts** | Read/write regex scripts (find/replace rules) |
| **Personas** | Read/write persona data |
| **CORS Proxy** | Make HTTP requests through the server |
| **Interceptor** | Modify prompts before generation |
| **Context Handler** | Provide additional context to generations |
| **Chat Mutation** | Add/edit/delete messages in chats |
| **Push Notification** | Send push notifications |
| **Image Gen** | Access the image generation pipeline |
| **App Manipulation** | Apply theme overrides and UI changes |

Privileged permissions (CORS proxy, generation, interceptor, etc.) require admin approval.

---

## Extension UI

Extensions can add UI elements in several places:

- **Drawer panels** — Full panels in the sidebar
- **Dock widgets** — Small widgets docked to the screen edges
- **Float widgets** — Floating elements anywhere on screen
- **Input actions** — Buttons in the chat input area
- **App mounts** — Full-page or embedded views

---

## For Developers

If you want to build your own extensions, see the [Developer Docs](https://docs.lumiverse.chat){:target="_blank"} for the complete Spindle API reference, including backend APIs, frontend APIs, and example extensions.
