---
title: Remote Access with Tailscale
---

# Remote Access with Tailscale

This walkthrough connects a phone or another computer to Lumiverse running on your host machine, using an HTTPS address suitable for installing the mobile PWA. Get [Lumiverse running locally](desktop-installation.md) first.

## 1. Connect your devices

Install [Tailscale](https://tailscale.com/download) on the host and client devices, then sign in to the same tailnet. For Android and iOS, use the corresponding app store download. Keep Tailscale connected on both devices.

## 2. Check the local server

Start Lumiverse normally and open `http://localhost:7860` on the host. If you configured another port, substitute it in the commands below. Leave Lumiverse running.

## 3. Enable HTTPS

In the [Tailscale DNS settings](https://login.tailscale.com/admin/dns), enable **MagicDNS** and **HTTPS Certificates**. Check the host's full `.ts.net` name in the Tailscale admin console.

On the host, run:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:7860
tailscale serve status
```

Follow any enablement prompt. The status output gives the HTTPS address. Serve shares it within your tailnet; the `--bg` setting resumes after a Tailscale restart or host reboot. Lumiverse must also be started after reboot. See the [Tailscale Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

## 4. Configure Lumiverse for the HTTPS address

In the local Lumiverse browser:

1. Open **Settings → Operator → Trusted Hostnames**.
2. Choose **Add manually** and enter the full HTTPS origin, such as `https://your-device.your-tailnet.ts.net`.
3. Add it, then configure the local proxy below before restarting Lumiverse.

For this HTTP reverse proxy, edit the host's `.env` so Lumiverse trusts the local proxy's forwarded host and protocol:

```dotenv
TRUSTED_PROXIES=127.0.0.1
```

If `TRUSTED_PROXIES` already contains other proxies, append `127.0.0.1` to its comma-separated list. Restart after saving. Use [Start Script Options](installation.md#start-script-options) for the environment editor, or edit `.env` directly.

Use the full HTTPS origin without a path or `:7860`. A bare hostname defaults to Lumiverse's backend port, which differs from Serve's HTTPS port. Broad **Remote Mode** is not required for this named-host setup.

## 5. Open from your other device

With Tailscale connected, open the HTTPS address shown by `tailscale serve status`. Do not append `:7860`: that is the local backend port. Sign in to Lumiverse.

For the mobile PWA, install from this HTTPS address using your browser's **Install app** or **Add to Home Screen** action. On iPhone, use Safari's share menu and **Add to Home Screen**. Open the installed app and confirm you can sign in and reach your chats.

## Troubleshooting

- **Localhost fails on the host:** fix the local server first; confirm the port and terminal output.
- **The remote address does not open:** check both Tailscale connections, tailnet access rules, and `tailscale serve status`.
- **The host is rejected or sign-in fails:** recheck the trusted hostname, local proxy setting, and restart. See [Configuration](installation.md#configuration) for auth-origin overrides.
- **The browser works but the installed app fails:** open the same HTTPS address in the browser, then reinstall the PWA from that address if its shortcut points elsewhere. Clear site data only if needed; this signs you out and removes browser-local state.
- **The app looks stale after an update:** rebuild through the Operator Panel or [update command](installation.md#updating), reload in the browser, then reopen the PWA.

To stop this HTTPS mapping on the host:

```bash
tailscale serve --https=443 off
```
