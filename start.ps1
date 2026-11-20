#Requires -Version 5.1
<#
.SYNOPSIS
    Lumiverse Launcher (Windows)

.DESCRIPTION
    Start backend and serve pre-built frontend (default).
    Use -Build to rebuild the frontend before starting.

.PARAMETER Mode
    all          - Start backend, serve pre-built frontend (default)
    build-only   - Build frontend only
    backend-only - Start backend only, skip frontend serving
    dev          - Start backend in watch mode
    setup           - Run setup wizard only
    reset-password  - Reset owner account password
    edit-env        - Edit the .env file ($env:VISUAL/$env:EDITOR, else Notepad)
    migrate-st      - Run SillyTavern migration helper
    kill-pkgs       - Nuke lockfiles + node_modules, reinstall backend deps
    install-desktop - Build/install Tauri desktop app and create launcher shortcuts

.PARAMETER Build
    Rebuild the frontend before starting the backend

.PARAMETER KillPkgs
    Nuke lockfiles and node_modules, then reinstall backend dependencies

.PARAMETER EditEnv
    Open the .env file in an editor ($env:VISUAL/$env:EDITOR if set, else Notepad)

.PARAMETER InstallDesktop
    Build and install the Tauri desktop app for the current user. Automatically
    installs the minimal stable Rust toolchain when cargo is not present.

.PARAMETER FrontendPath
    Path to frontend directory (default: ./frontend)

.PARAMETER NoRunner
    Start without the visual terminal runner

.PARAMETER SafeTheme
    Suppress custom CSS and component overrides for emergency recovery

.PARAMETER UpgradeBun
    Upgrade Bun to the latest stable release before continuing

.PARAMETER UpgradeBunCanary
    Upgrade Bun to the latest canary build before continuing

.NOTES
    Bun versions older than 1.4.4 are automatically upgraded to latest stable.
#>

param(
    [ValidateSet("all", "build-only", "backend-only", "dev", "setup", "reset-password", "edit-env", "migrate-st", "kill-pkgs", "install-desktop")]
    [string]$Mode = "all",

    [Alias("b")]
    [switch]$Build,

    [Alias("m")]
    [switch]$MigrateST,

    [string]$FrontendPath,

    [switch]$NoRunner,

    [switch]$SafeTheme,

    [Alias("k")]
    [switch]$KillPkgs,

    [switch]$EditEnv,

    [Alias("Desktop")]
    [switch]$InstallDesktop,

    [switch]$UpgradeBun,

    [switch]$UpgradeBunCanary
)

$ErrorActionPreference = "Stop"
$MinimumBunVersion = [version]"1.4.4"

# ─── Helpers ─────────────────────────────────────────────────────────────────

function Write-Info  { param([string]$Msg) Write-Host "[info]  $Msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$Msg) Write-Host "[ok]    $Msg" -ForegroundColor Green }
function Write-Warn  { param([string]$Msg) Write-Host "[warn]  $Msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$Msg) Write-Host "[error] $Msg" -ForegroundColor Red }

# ─── Resolve paths ───────────────────────────────────────────────────────────

$BackendDir  = $PSScriptRoot

if (-not $FrontendPath) { $FrontendPath = Join-Path $BackendDir "frontend" }

# ─── Protect Windows system directories ────────────────────────────────────

function Test-IsPathWithinDirectory {
    param([string]$Path, [string]$Directory)

    try {
        $normalizedPath = [IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
        $normalizedDirectory = [IO.Path]::GetFullPath($Directory).TrimEnd([char[]]@('\', '/'))
    } catch {
        return $false
    }

    if ([string]::Equals($normalizedPath, $normalizedDirectory, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }

    return $normalizedPath.StartsWith(
        $normalizedDirectory + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase
    )
}

function Assert-SafeFirstRunLocation {
    $dataDir = if ($env:DATA_DIR) { $env:DATA_DIR } else { Join-Path $BackendDir "data" }
    $identityFile = Join-Path $dataDir "lumiverse.identity"
    $credentialsFile = Join-Path $dataDir "owner.credentials"

    # Existing installations remain runnable; this guard only prevents a new
    # installation from writing dependencies and application data to System32.
    if ((Test-Path $identityFile) -and (Test-Path $credentialsFile)) { return }

    $windowsDirectory = if ($env:SystemRoot) { $env:SystemRoot } else { $env:WINDIR }
    if (-not $windowsDirectory) { return }

    $system32Directory = Join-Path $windowsDirectory "System32"
    if (-not (Test-IsPathWithinDirectory $BackendDir $system32Directory)) { return }

    $suggestedRoot = if ($env:USERPROFILE) {
        Join-Path $env:USERPROFILE "Lumiverse"
    } else {
        "a user-owned folder outside $windowsDirectory"
    }

    Write-Host ""
    Write-Err "First-time installation stopped: Lumiverse cannot be installed inside $system32Directory."
    Write-Err "Move this repository to $suggestedRoot, then run .\start.ps1 again."
    Write-Host ""
    exit 1
}

# ─── Ensure Bun is installed ────────────────────────────────────────────────

function Find-Bun {
    if (Get-Command bun -ErrorAction SilentlyContinue) { return $true }

    $bunInstall = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $env:USERPROFILE ".bun" }
    $defaultBunBin = Join-Path (Join-Path $env:USERPROFILE ".bun") "bin"
    foreach ($tryPath in @(
        (Join-Path (Join-Path $bunInstall "bin") "bun.exe"),
        (Join-Path $defaultBunBin "bun.exe")
    )) {
        if (Test-Path $tryPath) {
            $env:PATH = "$(Split-Path $tryPath);$env:PATH"
            return $true
        }
    }
    return $false
}

function Add-RegisteredPath {
    $machinePath = [Environment]::GetEnvironmentVariable("PATH", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    $env:PATH = (@($env:PATH, $userPath, $machinePath) | Where-Object { $_ }) -join ";"
}

function Ensure-Bun {
    if (Find-Bun) {
        $version = & bun --version
        Write-Ok "Bun $version found"
        return
    }

    Add-RegisteredPath
    if (Find-Bun) {
        $version = & bun --version
        Write-Ok "Bun $version found"
        return
    }

    Write-Warn "Bun not found. Installing..."

    # ── Install Bun ──────────────────────────────────────────────────────
    # Piping directly to iex (irm ... | iex) breaks the installer's
    # param() block — $Version and other parameters never bind, which
    # can abort the install entirely.  Wrapping in a scriptblock via
    # & { ... } lets PowerShell parse param() correctly.
    try {
        iex "& {$(irm https://bun.sh/install.ps1)}"
    } catch {
        Write-Err "Bun installation failed: $_"
        Write-Err "Please install manually: https://bun.sh"
        exit 1
    }

    # ── Make bun available in this session ────────────────────────────────
    Add-RegisteredPath
    if (Find-Bun) {
        $version = & bun --version
        Write-Ok "Bun $version installed successfully"
        return
    }

    Write-Err "Bun installation failed. Please install manually: https://bun.sh"
    exit 1
}

# ─── Bun channel upgrade (optional) ─────────────────────────────────────────
# Honors -UpgradeBun / -UpgradeBunCanary. Runs after Ensure-Bun so the binary
# exists; `bun upgrade [--canary|--stable]` swaps the binary in-place.
function Invoke-BunUpgrade {
    param([ValidateSet("stable", "canary")][string]$Channel)

    # Windows PowerShell 5 turns redirected native stderr into error records.
    # Bun writes normal upgrade progress there, so temporarily allow those
    # records through and decide success from the native process exit code.
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & bun upgrade "--$Channel" 2>&1 | ForEach-Object { Write-Host $_ }
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    if ($exitCode -ne 0) {
        throw "bun upgrade exited with code $exitCode"
    }
}

function Update-BunChannel {
    if (-not $UpgradeBun -and -not $UpgradeBunCanary) { return }

    $before = try { & bun --version } catch { "unknown" }

    if ($UpgradeBunCanary) {
        Write-Info "Upgrading Bun to latest canary (current: $before)..."
        try {
            Invoke-BunUpgrade "canary"
        } catch {
            Write-Err "Bun canary upgrade failed: $_"
            Write-Warn "Continuing with the existing $before binary."
            return
        }
    } else {
        Write-Info "Upgrading Bun to latest stable (current: $before)..."
        # --stable is a no-op for users already on stable but forces a switch
        # back from canary for anyone who previously opted in.
        try {
            Invoke-BunUpgrade "stable"
        } catch {
            Write-Err "Bun stable upgrade failed: $_"
            Write-Warn "Continuing with the existing $before binary."
            return
        }
    }

    $after = try { & bun --version } catch { "unknown" }
    Write-Ok "Bun upgraded: $before -> $after"
}

function Get-BunSemanticVersion {
    try {
        $raw = (& bun --version | Select-Object -First 1).Trim()
        return [version](($raw -split '-', 2)[0])
    } catch {
        return $null
    }
}

function Install-LumiverseBunRuntime {
    $runtimeBase = if ($env:LOCALAPPDATA) {
        Join-Path $env:LOCALAPPDATA "Lumiverse\runtimes"
    } else {
        Join-Path $BackendDir "data\.bun-runtime"
    }
    $runtimeRoot = Join-Path $runtimeBase "bun-$MinimumBunVersion"
    $installer = Join-Path $BackendDir "scripts\install-bun-runtime.ps1"

    & $installer -InstallRoot $runtimeRoot -MinimumVersion $MinimumBunVersion
    $runtime = Join-Path (Join-Path $runtimeRoot "bin") "bun.exe"
    if (-not (Test-Path $runtime -PathType Leaf)) {
        throw "The fallback Bun runtime was not installed at $runtime"
    }

    # Force every later bare `bun` invocation in this launcher to use the
    # validated side-by-side executable rather than an older PATH/npm shim.
    $env:LUMIVERSE_BUN_EXECUTABLE = $runtime
    $env:PATH = "$(Split-Path $runtime);$env:PATH"
    Set-Alias -Name bun -Value $runtime -Scope Script -Force
}

function Ensure-MinimumBunVersion {
    $current = Get-BunSemanticVersion
    if ($current -and $current -ge $MinimumBunVersion) { return }

    $display = if ($current) { $current.ToString() } else { "unknown" }
    Write-Warn "Bun $display is below Lumiverse's minimum $MinimumBunVersion."
    Write-Info "Automatically upgrading Bun to the latest stable release..."
    try {
        Invoke-BunUpgrade "stable"
    } catch {
        Write-Err "Automatic Bun upgrade failed: $_"
    }

    $current = Get-BunSemanticVersion
    if ($current -and $current -ge $MinimumBunVersion) {
        Write-Ok "Bun $current satisfies the minimum supported version"
        return
    }

    # A running Bun process locks bun.exe on Windows, and npm-launched scripts
    # may upgrade a temporary shim instead of the executable the next launch
    # resolves. Install a versioned runtime beside it and select that exact path.
    Write-Warn "The in-place Bun upgrade did not provide the required runtime."
    Write-Info "Installing Lumiverse's side-by-side Bun $MinimumBunVersion runtime..."
    try {
        Install-LumiverseBunRuntime
    } catch {
        Write-Err "Fallback Bun installation failed: $_"
    }

    $current = Get-BunSemanticVersion
    if ($current -and $current -ge $MinimumBunVersion) {
        Write-Ok "Bun $current satisfies the minimum supported version"
        return
    }

    $display = if ($current) { $current.ToString() } else { "unknown" }
    Write-Err "Bun $display is still below the required $MinimumBunVersion."
    Write-Err "Install the latest stable Bun release from https://bun.sh, then retry."
    exit 1
}

# ─── First-run setup wizard ─────────────────────────────────────────────────

function Invoke-SetupIfNeeded {
    $dataDir = if ($env:DATA_DIR) { $env:DATA_DIR } else { Join-Path $BackendDir "data" }
    $identityFile = Join-Path $dataDir "lumiverse.identity"
    $credentialsFile = Join-Path $dataDir "owner.credentials"

    # A migrated data folder is already set up even if .env was not copied.
    # The backend can fall back to defaults for missing .env values.
    if (-not (Test-Path $identityFile) -or -not (Test-Path $credentialsFile)) {
        Write-Info "First run detected - launching setup wizard..."
        Write-Host ""
        Install-Deps $BackendDir "backend"
        Push-Location $BackendDir
        try {
            $env:DATA_DIR = $dataDir
            & bun run scripts/setup-wizard.ts
        } finally { Pop-Location }

        if (-not (Test-Path $identityFile) -or -not (Test-Path $credentialsFile)) {
            Write-Err "Setup wizard did not create the required identity and owner credentials."
            Write-Err "Files expected at: $identityFile and $credentialsFile"
            Write-Err "Try running the wizard manually: bun run setup"
            exit 1
        }
    }
}

function Invoke-Setup {
    Install-Deps $BackendDir "backend"
    Push-Location $BackendDir
    try { & bun run scripts/setup-wizard.ts } finally { Pop-Location }
}

function Invoke-ResetPassword {
    Install-Deps $BackendDir "backend"
    Write-Info "Launching password reset..."
    Push-Location $BackendDir
    try { & bun run reset-password } finally { Pop-Location }
}

function Invoke-MigrateST {
    Install-Deps $BackendDir "backend"
    Write-Info "Launching SillyTavern migration helper..."
    Push-Location $BackendDir
    try { & bun run migrate:st } finally { Pop-Location }
}

function Invoke-EditEnv {
    # No dep install - edit-env.ts only uses Bun built-ins + local ui/input
    # helpers, so it's a quick hop to the editor (handy before first setup).
    Push-Location $BackendDir
    try { & bun run scripts/edit-env.ts } finally { Pop-Location }
}

# ─── Kill packages (nuke + reinstall) ──────────────────────────────────────

function Invoke-KillPkgs {
    Write-Warn "Removing lockfiles and node_modules..."

    $paths = @(
        (Join-Path $BackendDir "bun.lock"),
        (Join-Path $FrontendPath "bun.lock")
    )
    foreach ($p in $paths) {
        if (Test-Path $p) { Remove-Item $p -Force }
    }

    $dirs = @(
        (Join-Path $BackendDir "node_modules"),
        (Join-Path $FrontendPath "node_modules")
    )
    foreach ($d in $dirs) {
        if (Test-Path $d) { Remove-Item $d -Recurse -Force }
    }

    Write-Ok "Cleaned lockfiles and node_modules from backend and frontend"

    Install-Deps $BackendDir "backend"
    Write-Ok "Backend dependencies reinstalled (frontend deps will install on next build)"
}

# ─── Load .env into current process ─────────────────────────────────────────

function Load-EnvFile {
    $envFile = Join-Path $BackendDir ".env"
    if (-not (Test-Path $envFile)) { return }

    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line -match '^([^=]+)=(.*)$') {
            [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], "Process")
        }
    }
}

# ─── Install dependencies ───────────────────────────────────────────────────

function Invoke-BunDependencyInstall {
    param([string]$Dir)

    Push-Location $Dir
    try {
        # Bun's default Windows backend hardlinks packages out of its cache.
        # Filesystem filters (notably sync providers and antivirus) can make
        # that operation report success while leaving empty package folders.
        # copyfile is slower, but gives Windows installations ordinary files.
        & bun install --backend=copyfile
        $exitCode = $LASTEXITCODE
    } finally { Pop-Location }

    if ($exitCode -ne 0) {
        throw "bun install exited with code $exitCode"
    }
}

function Test-DependencyLoad {
    param([string]$Dir, [string]$Name)

    if ($Name -eq "backend") {
        $probeScript = "await import('better-auth'); await import('@better-auth/oauth-provider'); await import('./src/services/databank/web-page-parser.ts'); await import('./src/utils/remote-image-page.ts')"
    } elseif ($Name -eq "frontend") {
        # Exercise the browser-facing import that reaches Better Auth's
        # transitive core files. A package.json-only check misses partial
        # package extraction such as a missing dist/context/global.mjs.
        $probeScript = "await import('@better-auth/oauth-provider/client')"
    } else {
        return [pscustomobject]@{ Success = $true; Output = "" }
    }

    $previousErrorActionPreference = $ErrorActionPreference
    Push-Location $Dir
    try {
        # PowerShell 5 promotes redirected native stderr to error records. Keep
        # collecting it for the diagnostic, but judge success by the exit code.
        $ErrorActionPreference = "Continue"
        $output = (& bun -e $probeScript 2>&1 | Out-String).Trim()
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
        $ErrorActionPreference = $previousErrorActionPreference
    }

    return [pscustomobject]@{
        Success = ($exitCode -eq 0)
        Output  = $output
    }
}

function Install-Deps {
    param([string]$Dir, [string]$Name)

    Write-Info "Installing $Name dependencies..."
    Invoke-BunDependencyInstall $Dir

    if ($Name -in @("backend", "frontend")) {
        $probe = Test-DependencyLoad $Dir $Name
        if (-not $probe.Success) {
            Write-Warn "$Name dependency validation failed; clearing the package cache and performing a clean copy-based reinstall..."
            try { & bun pm cache rm 2>&1 | Out-Null } catch { }
            $nodeModules = Join-Path $Dir "node_modules"
            if (Test-Path $nodeModules) {
                Remove-Item $nodeModules -Recurse -Force
            }

            Invoke-BunDependencyInstall $Dir
            $probe = Test-DependencyLoad $Dir $Name
            if (-not $probe.Success) {
                Write-Err "$Name dependencies are still unreadable after a clean copy-based reinstall."
                if ($probe.Output) { Write-Err $probe.Output }
                Write-Err "Check Windows Defender/antivirus quarantine history and filesystem sync software for blocked package files."
                exit 1
            }
            Write-Ok "$Name dependency tree repaired"
        }
    }

    Write-Ok "$Name dependencies installed"
}

# ─── Build frontend ─────────────────────────────────────────────────────────

function Build-Frontend {
    if (-not (Test-Path $FrontendPath)) {
        Write-Err "Frontend directory not found at: $FrontendPath"
        Write-Err "Pass -FrontendPath to specify the correct location."
        exit 1
    }

    Install-Deps $FrontendPath "frontend"

    Write-Info "Building frontend..."
    Push-Location $FrontendPath
    try { & bun run build } finally { Pop-Location }

    $distDir = Join-Path $FrontendPath "dist"
    Write-Ok "Frontend built -> $distDir"
}

# ─── Start backend ──────────────────────────────────────────────────────────

function Start-Backend {
    $frontendDist = ""
    $distDir = Join-Path $FrontendPath "dist"

    if ($Mode -ne "dev" -and (Test-Path $distDir)) {
        $frontendDist = $distDir
        Write-Info "Serving frontend from: $frontendDist"
    } elseif ($Mode -ne "dev") {
        Write-Warn "No frontend build found. Backend will start without serving frontend."
        Write-Warn "Run './start.ps1 -Mode build-only' first, or use default mode to build + start."
    }

    Install-Deps $BackendDir "backend"

    # Clear Bun install cache to avoid stale tarballs after updates.
    # Bun writes its `.env` autoload notice to stderr; PowerShell promotes any
    # native stderr write to a NativeCommandError, so merge streams and discard.
    try { & bun pm cache rm 2>&1 | Out-Null } catch { }

    $env:FRONTEND_DIR = $frontendDist
    Load-EnvFile
    if ($SafeTheme) {
        $env:LUMIVERSE_SAFE_THEME = "true"
        Write-Warn "Safe theme mode enabled: custom CSS and component overrides are suppressed"
    }

    # smol (low-memory GC mode) defaults on; operators disable it persistently
    # via LUMIVERSE_SMOL=false in .env (survives auto-updates, unlike bunfig.toml).
    # The visual runner applies this itself in scripts/runner/server-manager.ts;
    # this only covers the plain (no-runner) launch below.
    $smolArgs = @("--smol")
    $smolVal = if ($env:LUMIVERSE_SMOL) { $env:LUMIVERSE_SMOL.Trim().ToLower() } else { "" }
    if ($smolVal -in @("false", "0", "off", "no")) { $smolArgs = @() }

    # Decide: visual runner or plain process
    $isTTY = [Environment]::UserInteractive -and -not $NoRunner
    if ($isTTY) {
        $runnerArgs = @("run", "scripts/runner.ts")
        if ($Mode -eq "dev") { $runnerArgs += @("--", "--dev") }
        Push-Location $BackendDir
        try { & bun @runnerArgs } finally { Pop-Location }
    } else {
        $port = if ($env:PORT) { $env:PORT } else { "7860" }
        Write-Host ""
        Write-Host "Starting Lumiverse Backend on port $port..." -ForegroundColor White
        Write-Host ""

        Push-Location $BackendDir
        try {
            if ($Mode -eq "dev") {
                & bun @smolArgs --watch src/index.ts
            } else {
                & bun @smolArgs src/index.ts
            }
        } finally { Pop-Location }
    }
}

# ─── Main ────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "Lumiverse - Launcher" -ForegroundColor White
Write-Host ""

# Load configuration before first-run checks. DATA_DIR is intentionally read
# before setup detection so a source checkout can use an external persistent
# data directory instead of silently creating a new empty ./data directory.
Load-EnvFile

Assert-SafeFirstRunLocation
Ensure-Bun
Update-BunChannel
Ensure-MinimumBunVersion

# Allow switches as shorthand for -Mode
if ($MigrateST) { $Mode = "migrate-st" }
if ($KillPkgs)  { $Mode = "kill-pkgs" }
if ($EditEnv)   { $Mode = "edit-env" }
if ($InstallDesktop) { $Mode = "install-desktop" }

switch ($Mode) {
    "all" {
        Invoke-SetupIfNeeded
        if ($Build) {
            Build-Frontend
        }
        Start-Backend
    }
    "build-only" {
        Build-Frontend
    }
    "backend-only" {
        Invoke-SetupIfNeeded
        Start-Backend
    }
    "dev" {
        Invoke-SetupIfNeeded
        Start-Backend
    }
    "setup" {
        Invoke-Setup
    }
    "reset-password" {
        Invoke-ResetPassword
    }
    "migrate-st" {
        Invoke-MigrateST
    }
    "edit-env" {
        Invoke-EditEnv
    }
    "kill-pkgs" {
        Invoke-KillPkgs
    }
    "install-desktop" {
        Push-Location $BackendDir
        try {
            & bun run desktop:install
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        } finally { Pop-Location }
    }
}
