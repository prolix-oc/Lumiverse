---
title: Troubleshooting
---

# Troubleshooting

Solutions to common issues you might encounter.

---

## Connection Issues

### "Invalid API key"

- Double-check your API key — copy it fresh from your provider's dashboard
- Make sure you're using the right key for the right provider
- API keys are per-connection — check that the correct connection is selected

### "Connection test failed"

- Verify the API URL is correct for your provider
- Check if your provider has an outage
- If using a custom endpoint, make sure the server is running and reachable
- Try the Models button — if it returns models, the connection works

### "Model not found"

- The model name must match exactly what the provider expects
- Use the Models button to see available models and copy the correct name
- Some models require specific API tiers or access approval

---

## Generation Issues

### Inspect the provider request

Open **Settings → Account** and enable **Recent generation requests**. Lumiverse keeps your last 20 outgoing generation attempts, including requests that fail. Chat requests do not automatically retry provider failures; retry manually when you are ready. Expand a row to see the finalized provider request and response, its source, the time it was sent, and the HTTP status. Use **Copy JSON** or **Copy response** to copy each displayed body. Streaming responses are combined into one JSON body after the response ends, including text, tool calls, usage, and provider error details. Interrupted responses are marked as partial.

Tracking starts disabled and belongs to your account. Other users, including admins and operators, cannot access your history through the app. API keys and credential fields are redacted from both bodies before records are retained. Failed attempts include the provider error payload when received; connection failures show the transport error.

Chat completions, Loom rebuilds, Memory Cortex extraction and summaries, embeddings, and image generation do not automatically resend failed provider requests. Configured fallback connections remain available, with one attempt per connection. Council retains its existing sidecar retry behavior. Interrupted Edit-and-Send dispatches preserve saved output or finish as failed; they are not replayed automatically after a restart.

Records stay in server memory and are cleared when tracking is disabled or the server restarts. **Clear** removes existing records while keeping tracking enabled. The oldest record is discarded when a new request exceeds the 20-entry limit. Each body has an 8 MiB retention limit. Oversized or unsafe bodies are marked unavailable. Error bodies may be partial when the provider reader reaches its existing size limit; tracking does not continue reading an abandoned response.

### AI responses are empty or cut off

- Check your **max tokens** setting — it might be too low
- Some models have minimum token requirements
- If using continue, the model may think the response is already complete

### AI is ignoring my instructions

- Use **Dry Run** to see what the AI actually receives
- Check that your preset blocks are enabled
- Verify macros are resolving correctly
- The instruction might be too far back in the context — try moving it closer (lower depth)

### AI is repeating itself

- Increase **frequency penalty** or **presence penalty** in sampler settings
- Lower the **temperature** slightly
- Check for duplicate content in your world book entries

### Responses are too short / too long

- Adjust **max tokens** in sampler settings
- Add explicit length instructions in your preset blocks (e.g., "Write 2-4 paragraphs")
- Use the **continue** feature if a response ends too soon

---

## World Book Issues

### Entries aren't activating

- Check that the world book is attached (to the character, persona, or global list)
- Verify keywords match what's being said in the chat (check case sensitivity)
- Use **Dry Run** to see the world info stats — it shows which entries activated and why
- Check **scan depth** — the keyword might be mentioned too far back
- Make sure the entry isn't disabled or on cooldown

### Too many entries activating

- Use **selective logic** with secondary keywords to narrow activation
- Increase **scan depth** to limit how far back keywords are checked
- Set entry **priorities** and use budget limits
- Use **groups** so only one entry from a set activates

---

## Performance Issues

### App feels slow

- In the desktop app, set **Rendering** to **Efficiency** in the Theme panel. This disables both the native window blur and in-page glass blur.
- On Wayland, try disabling **Blur background** under **Use translucent desktop background**. Blur intensity is chosen by the compositor, so selecting a lower intensity in Lumiverse does not reduce the Linux rendering cost.
- Disable **glass effects** in the Theme panel (backdrop-filter can be GPU-intensive)
- Reduce the number of messages loaded per page
- Close unused panels
- Clear old chats if you have thousands

### Large world books are slow

- Consider vectorizing entries instead of relying on keyword scanning
- Use budget limits to cap the number of active entries
- Increase min priority to filter out low-importance entries

---

## Data Issues

### Lost my API keys after reinstalling

- API keys are encrypted using the `data/lumiverse.identity` file
- If you lost this file, stored keys cannot be recovered — you'll need to re-enter them
- Always back up the entire `data/` directory

### Can't log in

Reset your password from the command line:

```bash
bun run reset-password
```

---

## Installation and Mobile Issues

- **Termux runtime, setup, or build failures:** see [Termux Troubleshooting](termux-troubleshooting.md) for recovery, the Ubuntu fallback, and reinstalling with a backup.
- **Remote access or installed PWA problems:** see [Remote Access with Tailscale](../getting-started/tailscale.md#troubleshooting).

---

## Getting Help

If you're stuck:

1. Check the **Diagnostics** tab in Settings for system health info
2. Use **Dry Run** to inspect what the AI sees
3. Check the World Book Diagnostics for activation issues
4. Review the browser console (F12) for frontend errors
5. Check the server logs in the terminal where Lumiverse is running
