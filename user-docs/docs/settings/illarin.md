---
title: Illarin
---

# Illarin

Illarin connects to your Lumiverse installation so you can send characters, world books, presets, themes, packs, and Spindle extensions directly to it.

---

## Connecting Your Installation

1. Open **Settings > Illarin**
2. Confirm the **Illarin URL** (default: `https://illarin.com`) and give your instance a name (e.g. "Home PC")
3. Click **Link**

How the link completes depends on where you're browsing from:

- **Same machine** (you opened Lumiverse on `localhost`): Lumiverse shows a verification code and opens the Illarin approval screen in a new browser tab. Type the displayed code on that page before approving. If your browser blocks the tab, use the **Open Illarin approval page** link next to the code; keep Settings open so you can see the code.
- **Another device** (phone, tablet, or another computer on your network): Lumiverse opens Illarin's verification page and shows a **device code**. Sign in and type the code. If the page is blocked, use the verification link shown beside the code.

!!! warning "Only trust codes you requested"
    Never enter a linking code you did not start yourself. The approval page must show the exact same code as your settings panel. If it doesn't, decline.

### Permissions

Lumiverse requests two optional permissions. Both start unchecked on Illarin's approval screen; choose which to grant:

- **work:receive** — lets works you send from Illarin arrive in this installation, including extensions when extension installation is available.
- **library:sync** — reports installed Illarin presets and extensions and their release numbers to your Illarin account so it can detect updates. Declining this does not prevent receiving works.

You can change grants in your Illarin account settings without reconnecting. Click **Refresh permissions** in Lumiverse after changing them. If a needed grant is turned off, collection stops rather than retrying a forbidden request.

---

## Connection Status

The Illarin settings panel shows:

- The installation name and server-assigned connected app ID
- The permissions last granted by Illarin
- The reported app version

Access credentials rotate automatically; nothing to maintain. Temporary network
or Illarin service failures leave the saved link in place and retry later. Only
an expired/rejected credential or an uncertain refresh outcome requires connecting again.

## Extensions

Owners and admins can receive Spindle extensions sent from Illarin. The first install is **disabled**; review and approve all permissions it requests in **Extensions** before its first run. Updates keep the extension's enabled state, previously granted permissions, and stored data. New permissions require a separate approval. A send cannot overwrite an extension from a different Illarin work or another source; remove the other extension yourself if you want to install it instead. A takedown notice is shown on the extension and does not disable it automatically.

Extension creators can publish an archive on Illarin, then optionally connect a public GitHub repository using a `.illarin-proof` file on its default branch. Illarin imports eligible GitHub releases and serves the archive unchanged; publishing never grants an app permission to install or run it. See Illarin's **Extension publishing** guide for release-source and prerelease options.

## Preset Updates

Sending a newer release of an installed Illarin preset updates the same preset in place. Your sampler overrides, custom request body, and compatible prompt-variable selections are retained. Bundled regexes from older releases remain disabled in folders marked with their release number; sending the same release again replaces only that release's regexes.

Illarin's release number tracks updates independently of the preset creator's version label. Lumiverse displays both when they differ. With **library:sync** enabled, preset installs, updates, and removals are reported for your connected installation.

---

## Unlinking

Click **Unlink from Illarin** to remove this installation's credentials locally.

Unlinking is local-only: also open your Illarin account settings and revoke the matching connected app by its server-assigned ID and displayed names.

---

## Privacy

Credentials are encrypted at rest and sent only to the exact Illarin server you connected. They are excluded from exports and backups. Illarin library reports contain installed work IDs and versions, not chats or messages; you can decline `library:sync` independently of receiving works.

Do not run two copies of one Lumiverse data directory at the same time, including while upgrading: they could both try to rotate the same refresh token. If you clone an installation, disconnect Illarin in the clone before using it and connect the clone independently.
