---
title: Termux Troubleshooting
---

# Termux Troubleshooting

Start with the [Android / Termux walkthrough](../getting-started/android-installation.md). Run commands one at a time and keep the first error message: it helps distinguish runtime problems from a failed frontend build.

## Package or mirror errors

In Termux, run `termux-change-repo`, select a working mirror, then retry:

```bash
pkg update
pkg upgrade
```

Use a consistent Termux installation source and avoid mixing add-ons from different sources. See the [official installation documentation](https://github.com/termux/termux-app#installation).

## Bun, glibc, or "Bad system call" errors

The current launcher installs `glibc-repo`, `glibc-runner`, and `proot`, validates Bun's execution path, and attempts a runtime rebuild when needed. Update your checkout and retry its normal path first:

```bash
cd ~/Lumiverse
git pull --ff-only
./start.sh -b
```

If Git reports local modifications, inspect them with `git status` and `git diff`. Preserve edits before resolving the update; `git reset --hard` is not a general repair command.

If the package installation itself failed, retry the packages in base Termux:

```bash
pkg install glibc-repo
pkg update
pkg install glibc-runner proot
cd ~/Lumiverse
./start.sh -b
```

If runtime or setup errors persist, try the Ubuntu fallback below. PRoot supplies a Linux userland but still uses your Android kernel, so it cannot resolve every device restriction.

## Sharp cannot load the android-arm64 runtime

Native Android Bun needs an Android Sharp binding; the standard Linux packages use a different C library. The launcher now downloads a version-matched Sharp/libvips engine from an immutable Lumiverse release, verifies its archive and libraries, and tests image processing before marking backend dependencies installed. The same preflight runs before server startup and during Termux updates, including updates with unchanged package manifests.

After updating to a revision containing this fix, restart normally:

```bash
cd ~/Lumiverse
git pull --ff-only
./start.sh -b
```

The first launch needs access to GitHub release downloads. Native libraries are cached under `vendor/sharp-android/`, outside `node_modules`, and damaged or missing files are downloaded again. A checksum or download failure stops dependency validation with the actual error; it does not require removing your data or lockfiles. Ubuntu/PRoot runtimes continue to use the standard Linux Sharp package.

## Ubuntu / proot-distro fallback

These steps create a separate Lumiverse install inside Ubuntu. They do not automatically move data from your existing Termux checkout.

### 1. Install Ubuntu from base Termux

```bash
pkg install proot-distro
proot-distro install ubuntu
proot-distro login ubuntu
```

Current PRoot-Distro also supports an explicit image tag such as `ubuntu:24.04`; check its [installation reference](https://github.com/termux/proot-distro#quick-start) if your version uses image tags. If Ubuntu is already installed, use `proot-distro login ubuntu` without reinstalling it.

### 2. Install and launch inside Ubuntu

After entering Ubuntu:

```bash
apt update
apt install -y git curl ca-certificates unzip nodejs npm
cd ~
git clone https://github.com/prolix-oc/Lumiverse.git
cd Lumiverse
chmod +x start.sh
./start.sh
```

Follow setup and open `http://localhost:7860` in your Android browser. Use a different configured port if applicable. Stop any old Termux server first so the two installs do not compete for the same port.

### 3. Return later

From base Termux:

```bash
proot-distro login ubuntu
cd ~/Lumiverse
./start.sh
```

Use `exit` to leave Ubuntu after stopping the server. Paths such as `~/Lumiverse` refer to the home folder of the environment you are currently in.

## Apache Arrow, Rollup, or Rolldown build failures

The launcher already repairs Termux frontend native bindings with npm and clears the Bun install cache during its Termux dependency flow. First retry the updated launcher with `./start.sh -b` and inspect the error.

For a broken dependency installation, the launcher's cleanup mode removes **both backend and frontend lockfiles and node_modules**, then reinstalls backend dependencies. Use it only after preserving any intentional lockfile changes:

```bash
cd ~/Lumiverse
./start.sh --kill-pkgs
./start.sh -b
```

This leaves your data directory in place, but dependency versions may be resolved again. An Apache Arrow/backend error may have a different cause from a frontend binding error; keep the failing package name and terminal output when asking for help.

## Reinstall while preserving your data

Stop Lumiverse first. The following example assumes the default `~/Lumiverse/data` directory. If `.env` sets `DATA_DIR`, locate and back up that actual directory instead. Run these steps in the environment that owns the install: base Termux or Ubuntu.

### 1. Back up and inspect

Create a new backup folder rather than merging into an older backup:

```bash
cd ~
mkdir ~/lumi-backup
cp -a ~/Lumiverse/data ~/lumi-backup/data
cp -a ~/Lumiverse/.env ~/lumi-backup/.env
ls -la ~/lumi-backup/data
```

If `mkdir` reports that the folder exists, choose another unused name and use it in every following command. Confirm the copy completed and the backup contains your database, assets, and `lumiverse.identity`; do not continue with an incomplete backup. Back up custom files outside `data/` separately. The `.env` copy preserves configuration such as custom data paths and explicit encryption settings.

### 2. Keep the old checkout and clone afresh

Before moving the old checkout, run `git branch --show-current` inside it and note the branch. Use the same branch in the new checkout before restoring data, so reinstalling does not accidentally downgrade a staging database to main.

```bash
cd ~
mv ~/Lumiverse ~/Lumiverse-old
git clone https://github.com/prolix-oc/Lumiverse.git
cd ~/Lumiverse
```

Use an unused name for `Lumiverse-old`. Keeping the old checkout gives you a recovery copy while you verify the new install.

The fresh clone starts on `main`. If your old install used `staging`, run `git switch staging` in the new checkout before continuing.

### 3. Restore before starting

For the default data location:

```bash
cp -a ~/lumi-backup/data ~/Lumiverse/data
cp -a ~/lumi-backup/.env ~/Lumiverse/.env
chmod +x start.sh
./start.sh -b
```

For a custom `DATA_DIR`, restore to that configured location instead. Do not run a fresh setup over your restored account. Sign in and confirm your characters, chats, settings, and connections before removing either recovery copy. Keep an independent backup afterward.

For account archives and moving data between running installs, see [Data Portability](../data-portability/index.md). For phone access or PWA issues, see [Remote Access with Tailscale](../getting-started/tailscale.md#troubleshooting).
