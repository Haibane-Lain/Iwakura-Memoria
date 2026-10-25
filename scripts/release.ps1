<#
.SYNOPSIS
    Cut an Iwakura Memoria release: bump both package versions, commit, tag and
    (optionally) push the tag that starts the GitHub Actions release build.

.DESCRIPTION
    The tag is the release switch. The workflow requires the tag to match
    electron/package.json exactly, builds the installer and creates a DRAFT
    GitHub release. Publish that draft after downloading and smoke-testing it.

    Run from anywhere; the script locates the repository relative to itself.

.PARAMETER Version
    Semantic version without a leading "v", for example 0.2.1.

.PARAMETER Push
    Push main and the new tag. Without this the commit and tag stay local, so
    the release can be reviewed first.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release.ps1 -Version 0.2.1 -Push
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Version,

    [switch]$Push
)

$ErrorActionPreference = "Stop"

function Fail([string]$Message) {
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

function Invoke-Git {
    param([string[]]$Arguments, [switch]$AllowFailure)
    & git @Arguments
    if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) {
        Fail "git $($Arguments -join ' ') failed (exit $LASTEXITCODE)"
    }
}

$version = $Version.Trim().TrimStart("v")
if ($version -notmatch '^\d+\.\d+\.\d+$') {
    Fail "Version must look like 0.2.1 (got '$Version')."
}

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
Push-Location -LiteralPath $repo
try {
    $branch = & git rev-parse --abbrev-ref HEAD
    if ($LASTEXITCODE -ne 0) { Fail "not a git checkout" }
    $branch = $branch.Trim()
    if ($branch -ne "main") {
        Fail "releases are cut from main (current branch: $branch)."
    }

    $dirty = (& git status --porcelain)
    if ($LASTEXITCODE -ne 0) { Fail "git status failed" }
    if ($dirty) {
        Fail "the working tree is not clean; commit or stash your changes first.`n$dirty"
    }

    & git rev-parse -q --verify "refs/tags/v$version" | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Fail "tag v$version already exists."
    }

    $rootVersion = (Get-Content -LiteralPath "package.json" -Raw | ConvertFrom-Json).version
    $electronVersion = (Get-Content -LiteralPath "electron\package.json" -Raw | ConvertFrom-Json).version

    Write-Host "[release] target version: $version" -ForegroundColor Cyan
    if ($rootVersion -ne $version) {
        Write-Host "[release] bumping the root package..." -ForegroundColor Cyan
        npm version $version --no-git-tag-version | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail "npm version failed at the repository root" }
    }
    if ($electronVersion -ne $version) {
        Write-Host "[release] bumping electron/package.json..." -ForegroundColor Cyan
        npm --prefix electron version $version --no-git-tag-version | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail "npm version failed in electron/" }
    }

    $versionChanges = (& git status --porcelain)
    if ($LASTEXITCODE -ne 0) { Fail "git status failed after versioning" }
    if ($versionChanges) {
        Invoke-Git -Arguments @("add", "package.json", "package-lock.json", "electron/package.json", "electron/package-lock.json")
        Invoke-Git -Arguments @("commit", "-m", "release: v$version")
    } else {
        Write-Host "[release] package manifests are already at $version; tagging the current commit." -ForegroundColor Cyan
    }
    Invoke-Git -Arguments @("tag", "-a", "v$version", "-m", "Iwakura Memoria v$version")

    if ($Push) {
        Write-Host "[release] pushing main and v$version..." -ForegroundColor Cyan
        Invoke-Git -Arguments @("push", "origin", "main")
        Invoke-Git -Arguments @("push", "origin", "v$version")
        Write-Host "[release] tag pushed. Watch the Release workflow, then test and publish the draft." -ForegroundColor Green
    } else {
        Write-Host "[release] commit and tag v$version created locally." -ForegroundColor Green
        Write-Host "          Review it, then run:" -ForegroundColor Yellow
        Write-Host "            git push origin main" -ForegroundColor Yellow
        Write-Host "            git push origin v$version" -ForegroundColor Yellow
    }
} finally {
    Pop-Location
}
