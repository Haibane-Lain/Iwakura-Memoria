<#
.SYNOPSIS
    Detect, download and install everything the Iwakura Memoria installer build
    needs: the Python venv + pip deps, the Node side (root + Electron deps),
    the bundled LanguageTool, WordNet and a Temurin JRE.

.DESCRIPTION
    Idempotent. Each artifact is only downloaded when it is missing (checked by
    its marker files) or when -Force is given. Downloads land in
    scripts\build\_cache\ so a rebuild is instant, and every archive is verified
    against the sha256 pinned in toolchain.json before it is extracted.

    Paths may contain spaces and apostrophes; every path is passed with
    -LiteralPath and never re-parsed as a command string.

.PARAMETER Force
    Re-download and re-extract every artifact (wipes the existing directories).

.PARAMETER Offline
    Never touch the network. Fails fast, naming what is missing.

.PARAMETER Only
    Comma-separated subset of: python,node,languagetool,wordnet,jre.
    Default: all of them.

.PARAMETER LogPath
    Optional file to append the prep log to (build.bat passes build-run.log).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build\prepare.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build\prepare.ps1 -Only wordnet,jre -Force
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$Offline,
    [string]$Only = "",
    [string]$LogPath = ""
)

$ErrorActionPreference = "Stop"
# Invoke-WebRequest / Expand-Archive progress bars make large downloads crawl.
$ProgressPreference = "SilentlyContinue"

$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$CacheDir = Join-Path $PSScriptRoot "_cache"

function Write-Log([string]$Message, [string]$Color) {
    Write-Host "[prepare] $Message" -ForegroundColor $Color
    if ($LogPath) {
        Add-Content -LiteralPath $LogPath -Value "[prepare] $Message" -Encoding UTF8 -ErrorAction SilentlyContinue
    }
}
function Write-Info([string]$Message) { Write-Log $Message "Cyan" }
function Write-Ok([string]$Message) { Write-Log $Message "Green" }
function Write-Warn([string]$Message) { Write-Log $Message "Yellow" }
function Fail([string]$Message) {
    Write-Log "ERROR: $Message" "Red"
    exit 1
}

# --- config -----------------------------------------------------------------

$ConfigPath = Join-Path $PSScriptRoot "toolchain.json"
if (-not (Test-Path -LiteralPath $ConfigPath)) { Fail "toolchain.json not found next to prepare.ps1" }
$Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json

# Env overrides (a URL override without an explicit hash disables verification,
# so a custom mirror or a bumped version can be used without editing the file).
function Apply-UrlOverride($Item, [string]$UrlVar, [string]$ShaVar) {
    $url = [Environment]::GetEnvironmentVariable($UrlVar)
    if ($url) {
        $Item.url = $url
        $sha = [Environment]::GetEnvironmentVariable($ShaVar)
        $Item.sha256 = if ($sha) { $sha } else { "" }
        Write-Warn "$UrlVar override in effect for $($Item.dir)"
    }
}
Apply-UrlOverride $Config.languagetool "IWAKURA_LT_URL" "IWAKURA_LT_SHA256"
Apply-UrlOverride $Config.wordnet "IWAKURA_DICT_URL" "IWAKURA_DICT_SHA256"
Apply-UrlOverride $Config.jre "IWAKURA_JRE_URL" "IWAKURA_JRE_SHA256"
if ($env:IWAKURA_LT_VERSION) { $Config.languagetool.version = $env:IWAKURA_LT_VERSION }
if ($env:IWAKURA_JRE_VERSION) { $Config.jre.version = $env:IWAKURA_JRE_VERSION }

if (-not (Test-Path -LiteralPath $CacheDir)) { New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null }

# --- primitives -------------------------------------------------------------

function Invoke-Download([string]$Url, [string]$Destination) {
    $parent = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        # curl ships with Windows 10 1803+ and is far faster than Invoke-WebRequest
        # for a 250 MB archive; --fail turns an HTTP error into a nonzero exit.
        & $curl.Source -L --fail --retry 3 --retry-delay 2 -o $Destination $Url
        if ($LASTEXITCODE -ne 0) { throw "download failed (curl exit $LASTEXITCODE): $Url" }
    } else {
        try {
            $client = New-Object System.Net.WebClient
            $client.DownloadFile($Url, $Destination)
        } finally {
            if ($client) { $client.Dispose() }
        }
    }
    if (-not (Test-Path -LiteralPath $Destination)) { throw "download produced no file: $Url" }
}

function Test-Sha256([string]$Path, [string]$Expected) {
    if ([string]::IsNullOrWhiteSpace($Expected)) { return $true }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    return $actual -eq $Expected.ToLowerInvariant()
}

function Expand-Archive-Into([string]$Archive, [string]$Destination) {
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
    if ($tar) {
        # Windows' bundled bsdtar extracts both .zip and .tar.gz, and is much
        # faster than Expand-Archive on the large LanguageTool zip.
        & $tar.Source -xf $Archive -C $Destination
        if ($LASTEXITCODE -eq 0) { return }
        Write-Warn "tar failed (exit $LASTEXITCODE); falling back to Expand-Archive"
    }
    if ($Archive.ToLowerInvariant().EndsWith(".zip")) {
        Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
    } else {
        throw "cannot extract $Archive - tar.exe is unavailable and it is not a .zip"
    }
}

function Get-ExtractedRoot([string]$TempDir, $Item, [string]$Label) {
    $root = Join-Path $TempDir $Item.extractedRoot
    if (Test-Path -LiteralPath $root) { return $root }
    $tops = @(Get-ChildItem -LiteralPath $TempDir -Directory -Force)
    if ($tops.Count -eq 1) { return $tops[0].FullName }
    if (Test-Path -LiteralPath (Join-Path $TempDir "bin\java.exe")) { return $TempDir }
    Fail "could not locate the extracted root for $Label inside $TempDir"
}

function Get-OrFetch {
    param($Item, [string]$Label, [ValidateSet("rename", "flatten")][string]$MoveMode)

    $target = Join-Path $RepoRoot $Item.dir
    $missing = @()
    foreach ($marker in $Item.markers) {
        if (-not (Test-Path -LiteralPath (Join-Path $target $marker))) { $missing += $marker }
    }

    if ($missing.Count -eq 0 -and -not $Force) {
        Write-Ok "$Label present at $($Item.dir) ($($Item.markers -join ', '))"
        return
    }

    if ($Offline) {
        Fail "$Label is missing ($($missing -join ', ')) at $($Item.dir) and -Offline was set.`n         Re-run without -Offline to fetch it."
    }

    Write-Info "$Label not found - downloading $($Item.version)..."
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }

    $archive = Join-Path $CacheDir $Item.archive
    $needDownload = $Force -or -not (Test-Path -LiteralPath $archive)
    if (-not $needDownload -and -not (Test-Sha256 $archive $Item.sha256)) {
        Write-Warn "cached $($Item.archive) failed its checksum - re-downloading"
        Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
        $needDownload = $true
    }
    if ($needDownload) {
        Invoke-Download $Item.url $archive
        if (-not (Test-Sha256 $archive $Item.sha256)) {
            Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
            Fail "$Label download failed its sha256 check.`n         expected $($Item.sha256)`n         file     $archive"
        }
        if ($Item.sha256) { Write-Ok "$Label archive verified ($($Item.archive))" }
    }

    $temp = Join-Path $CacheDir "_extract"
    Write-Info "extracting $($Item.archive)..."
    Expand-Archive-Into $archive $temp
    $source = Get-ExtractedRoot $temp $Item $Label

    if ($MoveMode -eq "flatten") {
        New-Item -ItemType Directory -Force -Path $target | Out-Null
        Get-ChildItem -LiteralPath $source -Force | ForEach-Object {
            Move-Item -LiteralPath $_.FullName -Destination $target -Force
        }
    } else {
        Move-Item -LiteralPath $source -Destination $target -Force
    }
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue

    foreach ($marker in $Item.markers) {
        if (-not (Test-Path -LiteralPath (Join-Path $target $marker))) {
            Fail "$Label extracted but $marker is missing at $($Item.dir)"
        }
    }
    Write-Ok "$Label ready at $($Item.dir)"
}

# --- steps ------------------------------------------------------------------

function Ensure-Python {
    Write-Info "checking Python..."
    $venvDir = Join-Path $RepoRoot ".venv"
    $venvPython = Join-Path $venvDir "Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $venvPython)) {
        if ($Offline) { Fail ".venv is missing and -Offline was set." }
        Write-Info "creating .venv..."
        $launcher = Get-Command py -ErrorAction SilentlyContinue
        if ($launcher) {
            & $launcher.Source -3 -m venv $venvDir
        } else {
            $python = Get-Command python -ErrorAction SilentlyContinue
            if (-not $python) {
                Fail "Python 3.10+ not found. Install it from https://www.python.org/downloads/windows/ and re-run."
            }
            & $python.Source -m venv $venvDir
        }
        if (-not (Test-Path -LiteralPath $venvPython)) { Fail "failed to create .venv" }
    } else {
        Write-Ok ".venv present"
    }

    Write-Info "installing Python requirements (requirements.txt + requirements-dev.txt)..."
    & $venvPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { Fail "pip upgrade failed" }
    & $venvPython -m pip install -r (Join-Path $RepoRoot "requirements.txt") -r (Join-Path $RepoRoot "requirements-dev.txt")
    if ($LASTEXITCODE -ne 0) { Fail "pip install failed" }
    Write-Ok "Python requirements installed"
}

function Test-NodeVersion([string]$Raw) {
    $parts = $Raw.Trim().TrimStart("v").Split(".")
    $major = [int]$parts[0]
    $minor = if ($parts.Count -gt 1) { [int]$parts[1] } else { 0 }
    $patch = if ($parts.Count -gt 2) { [int]$parts[2] } else { 0 }
    if ($major -ge 26) { return $true }
    if ($major -eq 24 -and ($minor -gt 15 -or ($minor -eq 15 -and $patch -ge 0))) { return $true }
    if ($major -eq 22 -and ($minor -gt 22 -or ($minor -eq 22 -and $patch -ge 2))) { return $true }
    return $false
}

function Install-NodeModules([string]$Directory) {
    $nodeModules = Join-Path $Directory "node_modules"
    if ((Test-Path -LiteralPath $nodeModules) -and -not $Force) {
        Write-Ok "node_modules present in $Directory"
        return
    }
    if ($Offline) { Fail "node_modules is missing in $Directory and -Offline was set." }
    $label = Split-Path -Leaf $Directory
    Write-Info "installing npm dependencies in $label..."
    Push-Location -LiteralPath $Directory
    try {
        if (Test-Path -LiteralPath (Join-Path $Directory "package-lock.json")) {
            & npm ci
        } else {
            & npm install
        }
        if ($LASTEXITCODE -ne 0) { throw "npm failed in $Directory" }
    } finally {
        Pop-Location
    }
    Write-Ok "npm dependencies installed in $label"
}

function Ensure-Node {
    Write-Info "checking Node.js..."
    $node = Get-Command node -ErrorAction SilentlyContinue
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $node -or -not $npm) {
        Fail "Node.js/npm not found. Install Node 22.22.2+, 24.15+, or >= 26 from https://nodejs.org/ and re-run."
    }
    $raw = (& $node.Source --version).Trim()
    if (-not (Test-NodeVersion $raw)) {
        Fail "Node $raw is too old; this project needs 22.22.2+, 24.15+, or >= 26 (see package.json engines)."
    }
    Write-Ok "Node $raw"
    Install-NodeModules $RepoRoot
    Install-NodeModules (Join-Path $RepoRoot "electron")
}

function Invoke-JavaVersion([string]$JavaExe) {
    # java -version prints to stderr; capture both streams directly so a
    # nonzero exit surfaces instead of throwing under $ErrorActionPreference=Stop.
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $JavaExe
    $startInfo.Arguments = "-version"
    $startInfo.RedirectStandardError = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::Start($startInfo)
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    return @{ Code = $process.ExitCode; Text = "$stdout$stderr" }
}

function Assert-JavaVersion([string]$JavaExe, [int]$MinMajor) {
    $result = Invoke-JavaVersion $JavaExe
    if ($result.Code -ne 0) { Fail "the bundled Java at $JavaExe did not run (exit $($result.Code))" }
    $match = [regex]::Match($result.Text, 'version "(\d+)')
    if (-not $match.Success) { Write-Warn "could not parse the bundled java -version output"; return }
    $major = [int]$match.Groups[1].Value
    if ($major -lt $MinMajor) { Fail "the bundled Java is $major, but LanguageTool needs $MinMajor+" }
    Write-Ok "bundled Java $major at $JavaExe"
}

# --- run --------------------------------------------------------------------

$allSteps = @("python", "node", "languagetool", "wordnet", "jre")
$wanted = if ([string]::IsNullOrWhiteSpace($Only)) {
    $allSteps
} else {
    @($Only.Split(",") | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
}
$unknown = @($wanted | Where-Object { $allSteps -notcontains $_ })
if ($unknown.Count -gt 0) { Fail "-Only has unknown step(s): $($unknown -join ', ')" }

Write-Info "preparing build dependencies in $RepoRoot"
if ($wanted -contains "python") { Ensure-Python }
if ($wanted -contains "node") { Ensure-Node }
if ($wanted -contains "languagetool") {
    Get-OrFetch $Config.languagetool "LanguageTool $($Config.languagetool.version)" "rename"
}
if ($wanted -contains "wordnet") {
    Get-OrFetch $Config.wordnet "WordNet $($Config.wordnet.version)" "rename"
}
if ($wanted -contains "jre") {
    Get-OrFetch $Config.jre "Temurin JRE $($Config.jre.version)" "flatten"
    Assert-JavaVersion (Join-Path $RepoRoot "$($Config.jre.dir)\bin\java.exe") ([int]$Config.jre.minMajor)
}

Write-Host ""
Write-Ok "all build dependencies are ready."
