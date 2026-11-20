---
title: Desktop Installation Walkthrough
---

# Desktop Installation Walkthrough

This walkthrough takes you from installing Git to opening Lumiverse on Windows or macOS. For Linux, Docker, and the full configuration reference, see [Installation](installation.md). For Android, use the [Termux walkthrough](android-installation.md).

For the bundled native desktop app, download the matching installer from the
[official releases](https://github.com/prolix-oc/Lumiverse/releases) and follow
[Experimental Lumiverse Desktop](desktop-tray.md). Bundled releases include the
server and Bun and offer built-in, existing-checkout and remote HTTPS choices.
Linux releases are AppImages.

The walkthrough below installs a **source checkout** and opens it in your web
browser. That path installs Bun and dependencies and keeps its server data in
the checkout unless configured otherwise. It can also be selected later under
Desktop's **Browser → Instance Connection… → Existing checkout**.

## 1. Install Git

=== "Windows"

    Open **PowerShell** in Windows Terminal. Use PowerShell throughout this walkthrough.

    ```powershell
    winget install --id Git.Git -e --source winget
    ```

    If `winget` is unavailable, download the installer from [Git for Windows](https://gitforwindows.org/).

    Close PowerShell completely, reopen it, and check:

    ```powershell
    git --version
    ```

=== "macOS"

    Open **Terminal** and check:

    ```bash
    git --version
    ```

    If Git is missing, install Apple's command-line tools and wait for installation to finish:

    ```bash
    xcode-select --install
    ```

    Run `git --version` again before continuing.

## 2. Choose a folder and download Lumiverse

Choose a folder you own and can write to. Keep the checkout out of Windows system folders such as `C:\Windows\System32`. The commands below create a `Lumiverse` folder inside your home folder.

=== "Windows"

    ```powershell
    Set-Location $HOME
    git clone https://github.com/prolix-oc/Lumiverse.git
    Set-Location Lumiverse
    ```

=== "macOS"

    ```bash
    cd ~
    git clone https://github.com/prolix-oc/Lumiverse.git
    cd Lumiverse
    ```

If you already have a checkout, open your terminal in that folder instead of cloning again.

## 3. Start Lumiverse

=== "Windows"

    If PowerShell blocks script execution, run:

    ```powershell
    Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
    ```

    Then launch from the Lumiverse folder:

    ```powershell
    .\start.ps1
    ```

=== "macOS"

    ```bash
    chmod +x start.sh
    ./start.sh
    ```

The launcher installs Bun if needed, installs dependencies, and opens the first-run setup wizard. Follow its prompts to create your owner account and configure the server. Leave the terminal running while using Lumiverse.

## 4. Open Lumiverse

Open `http://localhost:7860` in your browser. If you selected a different port during setup, use that port instead. Sign in with the account you created, then follow [First Steps](first-steps.md) to connect an AI provider and start a chat.

## Open it again later

Open a terminal in the same Lumiverse folder and run the same start command. You do not need to clone again or repeat setup.

On Windows, you can also save this as `Start Lumiverse.bat`. It assumes the home-folder location used above; change the path if you installed elsewhere.

```bat
@echo off
cd /d "%USERPROFILE%\Lumiverse" || exit /b 1
powershell -File .\start.ps1
pause
```

For an optional tray application, see [Experimental Lumiverse Desktop](desktop-tray.md).

## Update, migrate, or try staging

- [Updating Lumiverse](installation.md#updating) covers the Operator Panel and terminal commands.
- [Migrating from SillyTavern](installation.md#migrating-from-sillytavern) covers importing your existing characters, chats, world books, and personas.
- [Switching Branches](installation.md#switching-branches) explains the stable `main` branch and optional `staging` preview.
- [Start Script Options](installation.md#start-script-options) lists build, setup, password-reset, and other launcher options.
