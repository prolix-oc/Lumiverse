---
title: Android / Termux Walkthrough
---

# Android / Termux Walkthrough

Use this walkthrough to run Lumiverse on your Android device. If Lumiverse already runs on a computer and you only want to use it from your phone, follow [Remote Access with Tailscale](tailscale.md) instead.

## 1. Install Termux

Install Termux from [F-Droid](https://f-droid.org/en/packages/com.termux/) or the [official Termux GitHub releases](https://github.com/termux/termux-app/releases). On the F-Droid page, **Download APK** installs Termux directly; installing the F-Droid client is optional.

Keep Termux and any Termux add-ons from the same distribution source. See the [Termux installation documentation](https://github.com/termux/termux-app#installation) for supported versions and source compatibility.

## 2. Update packages

Open Termux and run these commands one at a time. Wait for each command to finish before continuing.

```bash
pkg update
pkg upgrade
pkg install git nodejs-lts nano
```

Accept package installation prompts. If the mirror is unreachable, run `termux-change-repo`, choose a working mirror, and retry the update.

## 3. Download and start Lumiverse

```bash
cd ~
git clone https://github.com/prolix-oc/Lumiverse.git
cd Lumiverse
chmod +x start.sh
./start.sh
```

The launcher detects Termux, installs its runtime prerequisites, and checks the Bun execution path before setup. It also handles frontend native dependency repair. You do not need to install glibc manually before your first attempt.

Follow the setup wizard, then open `http://localhost:7860` in your Android browser. Use your chosen port if you changed it. Keep Termux running while using Lumiverse; Android battery restrictions can interrupt a background server.

Continue with [First Steps](first-steps.md) to connect an AI provider and import a character.

## 4. Open it again later

In Termux:

```bash
cd ~/Lumiverse
./start.sh
```

You do not need to clone again. For updates, use the [Operator Panel or command-line update flow](installation.md#updating).

## Optional: add launch shortcuts

If you use Termux's default Bash shell, open its configuration:

```bash
nano ~/.bashrc
```

Add these lines once:

```bash
alias lumi='cd ~/Lumiverse && ./start.sh'
alias lumiup='cd ~/Lumiverse && git pull --ff-only && ./start.sh -b'
```

Save with **Ctrl+X**, **Y**, then **Enter**, and reload:

```bash
source ~/.bashrc
```

Run `lumi` to start or `lumiup` to update and rebuild. Adjust the aliases if your checkout is elsewhere.

## If setup fails

See [Termux Troubleshooting](../reference/termux-troubleshooting.md) for runtime errors, build failures, the Ubuntu/proot-distro fallback, and reinstalling while preserving data.
