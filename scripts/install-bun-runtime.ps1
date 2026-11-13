#Requires -Version 5.1

param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,

    [Parameter(Mandatory = $true)]
    [version]$MinimumVersion
)

$ErrorActionPreference = "Stop"
$previousBunInstall = $env:BUN_INSTALL

try {
    # Install beside the user's active Bun executable. Windows keeps a running
    # .exe locked, so an in-place `bun upgrade` cannot repair the runtime that
    # is currently supervising Lumiverse.
    $env:BUN_INSTALL = $InstallRoot
    $installerSource = Invoke-RestMethod -Uri "https://bun.sh/install.ps1"
    $installer = [scriptblock]::Create($installerSource)
    & $installer `
        -Version $MinimumVersion.ToString() `
        -NoPathUpdate `
        -NoRegisterInstallation `
        -NoCompletions

    $bunPath = Join-Path (Join-Path $InstallRoot "bin") "bun.exe"
    if (-not (Test-Path $bunPath -PathType Leaf)) {
        throw "The Bun installer did not create $bunPath"
    }

    $rawVersion = (& $bunPath --version | Select-Object -First 1).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "The installed Bun runtime could not be started (exit code $LASTEXITCODE)"
    }

    $installedVersion = [version](($rawVersion -split '-', 2)[0])
    if ($installedVersion -lt $MinimumVersion) {
        throw "The installed Bun $installedVersion is below the required $MinimumVersion"
    }
} finally {
    if ($null -eq $previousBunInstall) {
        Remove-Item Env:BUN_INSTALL -ErrorAction SilentlyContinue
    } else {
        $env:BUN_INSTALL = $previousBunInstall
    }
}
