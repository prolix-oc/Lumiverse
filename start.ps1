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
    migrate-st      - Run SillyTavern migration helper

.PARAMETER Build
    Rebuild the frontend before starting the backend

.PARAMETER FrontendPath
    Path to frontend directory (default: ./frontend)

.PARAMETER NoRunner
    Start without the visual terminal runner
#>

param(
    [ValidateSet("all", "build-only", "backend-only", "dev", "setup", "reset-password", "migrate-st")]
    [string]$Mode = "all",

    [Alias("b")]
    [switch]$Build,

    [Alias("m")]
    [switch]$MigrateST,

    [string]$FrontendPath,

    [switch]$NoRunner
)

$ErrorActionPreference = "Stop"

# ─── Helpers ─────────────────────────────────────────────────────────────────

function Write-Info  { param([string]$Msg) Write-Host "[info]  $Msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$Msg) Write-Host "[ok]    $Msg" -ForegroundColor Green }
function Write-Warn  { param([string]$Msg) Write-Host "[warn]  $Msg" -ForegroundColor Yellow }
function Write-Err   { param([string]$Msg) Write-Host "[error] $Msg" -ForegroundColor Red }

# ─── Resolve paths ───────────────────────────────────────────────────────────

$BackendDir  = $PSScriptRoot

if (-not $FrontendPath) { $FrontendPath = Join-Path $BackendDir "frontend" }

# ─── Ensure Bun is installed ────────────────────────────────────────────────

function Ensure-Bun {
    $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
    if ($bunCmd) {
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
    # The installer updates the user-level PATH but the current process
    # still has the stale copy.  Refresh it, then fall back to known
    # default install locations if Get-Command still can't find bun.

    # Pull in the freshly-updated user PATH so this session sees bun
    $machinePath = [Environment]::GetEnvironmentVariable("PATH", "Machine")
    $userPath    = [Environment]::GetEnvironmentVariable("PATH", "User")
    $env:PATH    = "$userPath;$machinePath"

    # Also explicitly prepend the default install bin directory
    $bunInstall = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $env:USERPROFILE ".bun" }
    $bunBin = Join-Path $bunInstall "bin"
    if (Test-Path $bunBin) {
        $env:PATH = "$bunBin;$env:PATH"
    }

    $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
    if ($bunCmd) {
        $version = & bun --version
        Write-Ok "Bun $version installed successfully"
        return
    }

    # Last resort: check default install locations directly
    $tryPaths = @(
        (Join-Path $bunInstall "bin" "bun.exe"),
        (Join-Path $env:USERPROFILE ".bun" "bin" "bun.exe")
    )
    foreach ($tryPath in $tryPaths) {
        if (Test-Path $tryPath) {
            $version = & $tryPath --version
            Write-Ok "Bun $version installed (using direct path: $tryPath)"
            $env:PATH = "$(Split-Path $tryPath);$env:PATH"
            return
        }
    }

    Write-Err "Bun installation failed. Please install manually: https://bun.sh"
    exit 1
}

# ─── First-run setup wizard ─────────────────────────────────────────────────

function Invoke-SetupIfNeeded {
    $identityFile = Join-Path $BackendDir "data\lumiverse.identity"
    $envFile = Join-Path $BackendDir ".env"

    if (-not (Test-Path $identityFile) -or -not (Test-Path $envFile)) {
        Write-Info "First run detected - launching setup wizard..."
        Write-Host ""
        Install-Deps $BackendDir "backend"
        Push-Location $BackendDir
        try { & bun run scripts/setup-wizard.ts } finally { Pop-Location }
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

function Install-Deps {
    param([string]$Dir, [string]$Name)

    Write-Info "Installing $Name dependencies..."
    Push-Location $Dir
    try { & bun install } finally { Pop-Location }
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

    # Clear Bun transpiler cache to avoid stale bytecode after updates
    & bun --clear-cache 2>$null

    $env:FRONTEND_DIR = $frontendDist
    Load-EnvFile

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
                & bun run dev
            } else {
                & bun run start
            }
        } finally { Pop-Location }
    }
}

# ─── Main ────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "Lumiverse - Launcher" -ForegroundColor White
Write-Host ""

Ensure-Bun

# Allow -MigrateST switch as shorthand for -Mode migrate-st
if ($MigrateST) { $Mode = "migrate-st" }

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
}
