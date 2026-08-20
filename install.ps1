# DevEco Code Windows Binary Installer
# Downloads pre-built deveco binary from GitCode Releases
#
# Usage:
#   irm https://raw.gitcode.com/openharmony-sig/deveco-code/raw/develop/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.gitcode.com/openharmony-sig/deveco-code/raw/develop/install.ps1))) -Version 0.1.4
#   & ([scriptblock]::Create((irm https://raw.gitcode.com/openharmony-sig/deveco-code/raw/develop/install.ps1))) -Baseline
#   & ([scriptblock]::Create((irm https://raw.gitcode.com/openharmony-sig/deveco-code/raw/develop/install.ps1))) -Binary C:\path\to\deveco.exe
#   & ([scriptblock]::Create((irm https://raw.gitcode.com/openharmony-sig/deveco-code/raw/develop/install.ps1))) -NoModifyPath

[CmdletBinding()]
param(
    [string]$Version = "",
    [switch]$Baseline,
    [string]$Binary = "",
    [switch]$NoModifyPath,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

# TLS 1.2 config (PS 5.1 defaults to TLS 1.0/1.1; GitCode HTTPS requires TLS 1.2)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Windows PowerShell 5.1 does not automatically load the assembly that provides HttpClient.
if (-not ("System.Net.Http.HttpClient" -as [type])) {
    Add-Type -AssemblyName System.Net.Http -ErrorAction Stop
}

# Prevent Invoke-WebRequest progress bar from significantly slowing down large file downloads in PS 5.1
$ProgressPreference = 'SilentlyContinue'

# Ensure console outputs Unicode characters correctly (progress bar uses ━/─); does not affect ASCII text
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ANSI color codes shared with the macOS installer.
# Use [char]27 instead of `e — the latter only works in PS 7+, not in Windows default PS 5.1
$esc = [char]27
$ansiOrange = "${esc}[38;5;214m"
$ansiMuted  = "${esc}[0;2m"
$ansiReset  = "${esc}[0m"

$gitcodeOwner = if ($env:GITCODE_OWNER) { $env:GITCODE_OWNER } else { "openharmony-sig" }
$gitcodeRepo = if ($env:GITCODE_REPO) { $env:GITCODE_REPO } else { "deveco-code" }
$Repo = "$gitcodeOwner/$gitcodeRepo"
$GitCodeApi = "https://gitcode.com/api/v5/repos/$Repo"
$AppName = "deveco"
$DataHome = if ($env:XDG_DATA_HOME) { $env:XDG_DATA_HOME } else { Join-Path $env:USERPROFILE ".local\share" }
$VersionsDir = Join-Path $DataHome "deveco\versions"
$BinDir = Join-Path $env:USERPROFILE ".local\bin"
$BinPath = Join-Path $BinDir "$AppName.exe"
$VersionRetentionCount = 2

function Show-Help {
    Write-Host "DevEco Code Windows Installer"
    Write-Host ""
    Write-Host "Usage: install.ps1 [options]"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -Version <version>   Install a specific version (e.g., 0.1.4)"
    Write-Host "  -Baseline            Force baseline variant (no AVX2)"
    Write-Host "  -Binary <path>       Install from a local binary instead of downloading"
    Write-Host "  -NoModifyPath        Don't modify user PATH"
    Write-Host "  -Help                Show this help message"
    Write-Host ""
    Write-Host "Environment:"
    Write-Host "  GITCODE_OWNER        GitCode repo owner (default: openharmony-sig)"
    Write-Host "  GITCODE_REPO         GitCode repo name (default: deveco-code)"
    Write-Host "  VERSION              Version to install (overridden by -Version)"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  irm https://raw.gitcode.com/openharmony-sig/deveco-code/raw/develop/install.ps1 | iex"
    Write-Host "  & ([scriptblock]::Create((irm https://raw.gitcode.com/openharmony-sig/deveco-code/raw/develop/install.ps1))) -Version 0.1.4"
    Write-Host "  & ([scriptblock]::Create((irm https://raw.gitcode.com/openharmony-sig/deveco-code/raw/develop/install.ps1))) -Binary C:\path\to\deveco.exe"
}

function Write-InstallerError {
    param([string]$Message)
    Write-Host "[ERROR] $Message" -ForegroundColor Red
}

# Progress bar constants — 6-stop gradient (pink→purple→blue→cyan→mint→green), ━ / ─ box-drawing chars.
# Width 28, falls back to a hand-tuned 16-color mapping on Windows conhost / PowerShell 5.1.
# Throttle: render at most once per 1% increment, 100% always renders.
$ProgressBarWidth  = 28
$ProgressFillChar  = [char]0x2501   # ━ BOX DRAWINGS HEAVY HORIZONTAL
$ProgressEmptyChar = [char]0x2500   # ─ BOX DRAWINGS LIGHT HORIZONTAL
$ProgressLastPctInt = -1           # last rendered integer percent (1%-granularity throttle)

$ProgressGradientStops = @(
    @(255, 100, 200),  # pink-500
    @(200, 100, 255),  # purple-500
    @(100, 150, 255),  # blue-500
    @( 50, 200, 255),  # cyan-500
    @( 80, 255, 180),  # mint-500
    @(100, 255, 100)   # green-500
)

# Truecolor (24-bit) capability detection. Native support on Windows Terminal,
# PowerShell 7+ in a truecolor xterm, and ConEmu/Cmder with ANSI enabled.
$ProgressTrueColor = $false
if ($env:WT_SESSION)                                    { $ProgressTrueColor = $true }
elseif ($env:TERM -match 'truecolor|24bit')             { $ProgressTrueColor = $true }
elseif ($env:ConEmuANSI -eq 'ON')                       { $ProgressTrueColor = $true }

# Returns an ANSI escape for the cell at $Pos (0..1) along the gradient.
# Hand-tuned 16-color mapping for the AI palette avoids the RGB-nearest-neighbor
# pitfall where pink (236,72,153) is mis-bucketed as bright red (255,85,85).
function Get-ProgressGradientColor {
    param([double]$Pos, [bool]$TrueColor)
    $n = $ProgressGradientStops.Count - 1
    $idx = [Math]::Min($Pos * $n, $n - 0.001)
    $i = [int][Math]::Floor($idx)
    $t = $idx - $i
    $c1 = $ProgressGradientStops[$i]
    $c2 = $ProgressGradientStops[[Math]::Min($i + 1, $n)]
    $r = [int][Math]::Round($c1[0] + ($c2[0] - $c1[0]) * $t)
    $g = [int][Math]::Round($c1[1] + ($c2[1] - $c1[1]) * $t)
    $b = [int][Math]::Round($c1[2] + ($c2[2] - $c1[2]) * $t)
    if ($TrueColor) {
        return "${esc}[38;2;${r};${g};${b}m"
    }
    switch ([Math]::Min([int][Math]::Floor($Pos * 5), 4)) {
        0 { return "${esc}[95m" }   # bright magenta (pink stop)
        1 { return "${esc}[35m" }   # magenta (purple stop)
        2 { return "${esc}[34m" }   # blue (blue stop)
        3 { return "${esc}[36m" }   # cyan (cyan / mint stops)
        4 { return "${esc}[32m" }   # green (green stop)
        default { return "${esc}[95m" }
    }
}

# Renders the full bar (filled + empty) at $Percent completion.
function Format-UpgradeBar {
    param([double]$Percent, [bool]$TrueColor)
    $filled = [int][Math]::Round($ProgressBarWidth * $Percent / 100)
    if ($filled -gt $ProgressBarWidth) { $filled = $ProgressBarWidth }
    $sb = [System.Text.StringBuilder]::new()
    for ($i = 0; $i -lt $filled; $i++) {
        $pos = if ($filled -gt 1) { $i / ($ProgressBarWidth - 1) } else { 0.0 }
        [void]$sb.Append((Get-ProgressGradientColor -Pos $pos -TrueColor $TrueColor))
        [void]$sb.Append($ProgressFillChar)
    }
    [void]$sb.Append("${esc}[90m")
    [void]$sb.Append([string]::new($ProgressEmptyChar, $ProgressBarWidth - $filled))
    [void]$sb.Append("${esc}[0m")
    return $sb.ToString()
}

# Streams bytes from $InputStream to $OutputStream, rendering the progress bar
# at most once per 1% increment (and 100% always after the stream ends).
# Caller is responsible for disposing both streams.
function Copy-StreamWithProgress {
    param(
        [System.IO.Stream]$InputStream,
        [System.IO.Stream]$OutputStream,
        [long]$TotalBytes
    )
    $buffer = New-Object byte[] 65536
    $totalRead = 0
    while (($bytesRead = $InputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $OutputStream.Write($buffer, 0, $bytesRead)
        $totalRead += $bytesRead
        if ($TotalBytes -gt 0) {
            $percent = [int][math]::Floor($totalRead * 100 / $TotalBytes)
            if ($percent -gt 100) { $percent = 100 }
            # 1%-granularity throttle: skip when same integer percent already rendered
            if ($percent -lt 100 -and $percent -eq $ProgressLastPctInt) { continue }
            $ProgressLastPctInt = $percent
            $bar = Format-UpgradeBar -Percent $percent -TrueColor $ProgressTrueColor
            $pctText = "{0,3}" -f $percent
            Write-Host "`r${bar} ${pctText}%" -NoNewline
        }
    }
    if ($TotalBytes -gt 0 -and $totalRead -ne $TotalBytes) {
        throw "Download ended after $totalRead of $TotalBytes bytes"
    }
    if ($TotalBytes -gt 0) {
        $bar = Format-UpgradeBar -Percent 100 -TrueColor $ProgressTrueColor
        Write-Host "`r${bar} 100%"
    } else {
        Write-Host ""
    }
}

# NOTE: This function uses Task.Result for synchronous waiting, which can deadlock in
# PowerShell ISE (STA apartment). For interactive installation, always run from
# powershell.exe (MTA) or pwsh. See https://github.com/openharmony-sig/deveco-code/issues
# for the full install pattern.
function Download-WithProgress {
    param([string]$Url, [string]$Output)
    # Stream the response directly so every successful download reports the same
    # gradient progress as the macOS installer. BITS cannot expose progress when
    # Start-BitsTransfer is used synchronously, which made the bar disappear.
    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromMinutes(10)
    $totalBytes = 0
    try {
        $response = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
        try {
            [void]$response.EnsureSuccessStatusCode()
            # Normalize Content-Length: treat $null and -1 ("unknown" from chunked encoding) as 0
            $contentLength = $response.Content.Headers.ContentLength
            if ($contentLength -and $contentLength -gt 0) { $totalBytes = $contentLength }
            # Safe .Result: ResponseHeadersRead guarantees stream is available at this point
            $inputStream = $response.Content.ReadAsStreamAsync().Result
            try {
                $fileStream = [System.IO.File]::Create($Output)
                try {
                    Copy-StreamWithProgress -InputStream $inputStream -OutputStream $fileStream -TotalBytes $totalBytes
                } finally {
                    $fileStream.Dispose()
                }
            } finally {
                # Explicit dispose is defensive; $response.Dispose() below would also dispose this
                $inputStream.Dispose()
            }
        } finally {
            $response.Dispose()
        }
    } finally {
        $client.Dispose()
    }
}

# L1: Use PID-suffixed class name to avoid same-session type conflicts
function Test-Avx2 {
    $className = "Avx2Check_$PID"
    $type = $className -as [type]
    if ($type) {
        return $type::IsProcessorFeaturePresent(40)
    }
    $sig = '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(int feature);'
    $type = Add-Type -MemberDefinition $sig -Name $className -PassThru
    return $type::IsProcessorFeaturePresent(40)
}

function Get-DevecoCliEntry {
    param([string]$InstallRoot)
    $vendorRoot = Join-Path $InstallRoot "vendor\deveco-cli"
    if (-not (Test-Path -LiteralPath $vendorRoot -PathType Container)) { return $null }
    $entry = Get-ChildItem -LiteralPath $vendorRoot -Filter "cli.js" -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '[\\/]dist[\\/]cli\.js$' } |
        Select-Object -First 1
    if ($entry) { return $entry.FullName }
    return $null
}

function Test-InstallationComplete {
    param([string]$InstallRoot)
    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot "bin\$AppName.exe") -PathType Leaf)) { return $false }
    if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot "CHANGELOG.md") -PathType Leaf)) { return $false }
    return -not [string]::IsNullOrWhiteSpace((Get-DevecoCliEntry $InstallRoot))
}

function Test-InstallationCompleteWithRetry {
    param([string]$InstallRoot, [int]$Attempts = 3)
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        if (Test-InstallationComplete $InstallRoot) { return $true }
        if ($attempt -lt $Attempts) { Start-Sleep -Milliseconds (250 * $attempt) }
    }
    return $false
}

function Invoke-FileOperation {
    param(
        [string]$Description,
        [scriptblock]$Operation,
        [int]$Attempts = 5
    )
    $lastError = $null
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            return (& $Operation)
        } catch {
            $lastError = $_
        }
        if ($attempt -lt $Attempts) {
            Start-Sleep -Milliseconds ([Math]::Min(250 * $attempt, 1500))
        }
    }
    throw "$Description failed after $Attempts attempts: $($lastError.Exception.Message)"
}

function Wait-InstallMutex {
    param([System.Threading.Mutex]$Mutex, [int]$Milliseconds)
    try {
        return $Mutex.WaitOne($Milliseconds)
    } catch [System.Threading.AbandonedMutexException] {
        return $true
    }
}

function Enter-InstallMutex {
    # The SID keeps users isolated; Global makes the lock span console, RDP, and
    # service sessions without requiring administrator privileges for a mutex.
    $name = "Global\DevEcoCodeInstaller-$([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)"
    $mutex = [System.Threading.Mutex]::new($false, $name)
    if (Wait-InstallMutex -Mutex $mutex -Milliseconds 0) { return $mutex }

    Write-Host "${ansiMuted}Another deveco installation is running; waiting for it to finish.${ansiReset}"
    if (Wait-InstallMutex -Mutex $mutex -Milliseconds 900000) { return $mutex }

    $mutex.Dispose()
    throw "Timed out waiting for another deveco installation to finish"
}

function New-StagedLauncher {
    param([string]$Source, [string]$Destination)
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "Launcher source disappeared before staging: $Source"
    }
    $sourceHash = Invoke-FileOperation -Description "Hash launcher source '$Source'" -Operation {
        (Get-FileHash -LiteralPath $Source -Algorithm SHA256 -ErrorAction Stop).Hash
    }
    Invoke-FileOperation -Description "Stage launcher '$Source' to '$Destination'" -Operation {
        Copy-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop
    }
    $destinationHash = Invoke-FileOperation -Description "Hash staged launcher '$Destination'" -Operation {
        (Get-FileHash -LiteralPath $Destination -Algorithm SHA256 -ErrorAction Stop).Hash
    }
    if ($sourceHash -ne $destinationHash) {
        throw "Staged launcher failed SHA-256 verification"
    }
    return $sourceHash
}

# Windows security software can briefly hold newly extracted executables open.
# Prefer an atomic directory rename, retry transient locks, then fall back to a
# validated copy so installation is not blocked indefinitely by the directory handle.
function Publish-StagedInstallation {
    param([string]$StageDir, [string]$VersionDir)
    $versionRollback = $null
    if (Test-Path -LiteralPath $VersionDir) {
        $versionRollback = Join-Path $VersionsDir ".rollback.$(Split-Path $VersionDir -Leaf).$([guid]::NewGuid().ToString('N'))"
        Invoke-FileOperation -Description "Back up existing version directory '$VersionDir'" -Operation {
            [System.IO.Directory]::Move($VersionDir, $versionRollback)
        }
    }

    $moveError = $null
    try {
        Invoke-FileOperation -Description "Publish staged installation '$StageDir' to '$VersionDir'" -Operation {
            [System.IO.Directory]::Move($StageDir, $VersionDir)
        }
    } catch {
        $moveError = $_
    }
    if (-not $moveError) {
        if (Test-InstallationCompleteWithRetry $VersionDir) {
            if ($versionRollback) { Remove-Item -LiteralPath $versionRollback -Recurse -Force -ErrorAction SilentlyContinue }
            return
        }
        Remove-Item -LiteralPath $VersionDir -Recurse -Force -ErrorAction SilentlyContinue
        if ($versionRollback -and (Test-Path -LiteralPath $versionRollback)) {
            [System.IO.Directory]::Move($versionRollback, $VersionDir)
        }
        throw "Published installation is incomplete; security software may have quarantined one of its files"
    }

    Write-Host "${ansiMuted}The install directory is busy; finishing with a verified copy.${ansiReset}"
    try {
        Invoke-FileOperation -Description "Create version directory '$VersionDir'" -Operation {
            New-Item -ItemType Directory -Path $VersionDir -Force -ErrorAction Stop | Out-Null
        }
        Invoke-FileOperation -Description "Copy staged installation '$StageDir' to '$VersionDir'" -Operation {
            Get-ChildItem -LiteralPath $StageDir -Force -ErrorAction Stop |
                Copy-Item -Destination $VersionDir -Recurse -Force -ErrorAction Stop
        }
        if (-not (Test-InstallationCompleteWithRetry $VersionDir)) {
            throw "Copied installation is incomplete"
        }
        Remove-Item -LiteralPath $StageDir -Recurse -Force -ErrorAction SilentlyContinue
        if ($versionRollback) { Remove-Item -LiteralPath $versionRollback -Recurse -Force -ErrorAction SilentlyContinue }
    } catch {
        $copyError = $_
        Remove-Item -LiteralPath $VersionDir -Recurse -Force -ErrorAction SilentlyContinue
        if ($versionRollback -and (Test-Path -LiteralPath $versionRollback)) {
            try {
                [System.IO.Directory]::Move($versionRollback, $VersionDir)
            } catch {}
        }
        throw "Could not publish '$StageDir'. Atomic move error: $($moveError.Exception.Message) Copy fallback error: $($copyError.Exception.Message)"
    }
}

# Check versioned files and launcher independently so an interrupted launcher
# switch can be repaired without downloading and extracting the release again.
function Get-InstallationState {
    param([string]$TargetVersion)
    $versionDir = Join-Path $VersionsDir $TargetVersion
    $launcherVersion = $null
    if (Test-Path -LiteralPath $BinPath -PathType Leaf) {
        try {
            $launcherVersion = ((@(& $BinPath --version 2>$null) -join "`n").Trim())
        } catch {}
    }

    if ((Test-Path -LiteralPath $versionDir -PathType Container) -and
        (Test-InstallationCompleteWithRetry $versionDir)) {
        $versionBin = Join-Path $versionDir "bin\$AppName.exe"
        $versionedVersion = $null
        try {
            $versionedVersion = ((@(& $versionBin --version 2>$null) -join "`n").Trim())
        } catch {}
        if ($versionedVersion -eq $TargetVersion) {
            if ($launcherVersion -eq $TargetVersion) {
                Write-Host "Version $TargetVersion already installed, skipping" -ForegroundColor DarkGray
                return "ready"
            }
            Write-Host "Version $TargetVersion already downloaded; repairing launcher" -ForegroundColor DarkGray
            return "repair"
        }
    }

    if ($launcherVersion) {
        Write-Host "Installed version: $launcherVersion." -ForegroundColor DarkGray
    }
    if (Test-Path -LiteralPath $versionDir) {
        Write-Host "Version $TargetVersion is incomplete, repairing installation" -ForegroundColor DarkGray
    }
    return "download"
}

function Cleanup-OldVersions {
    if ($VersionRetentionCount -le 0) { return }
    $dirs = Get-ChildItem -Path $VersionsDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike '.*' -and $_.Name -match '^\d' } |
        Sort-Object { [version]($_.Name -replace '-.*$','') } -ErrorAction SilentlyContinue
    if (-not $dirs -or $dirs.Count -le $VersionRetentionCount) { return }
    # NOTE: Use 2>$null (not 2>&1 |) to avoid $LASTEXITCODE reset in PS 5.1
    # and to exclude stderr noise (e.g. "Bun v1.3.14") that confuses the regex.
    $currentVersion = $null
    if (Test-Path $BinPath) {
        try {
            $currentVersion = ((@(& $BinPath --version 2>$null) -join "`n").Trim())
        } catch {}
    }
    $toDelete = $dirs | Where-Object { $_.Name -ne $currentVersion } |
        Select-Object -First ($dirs.Count - $VersionRetentionCount)
    foreach ($dir in $toDelete) {
        Remove-Item -Path $dir.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($Help) {
    Show-Help
    return
}

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    Write-InstallerError "This installer supports Windows PowerShell only. On macOS, run the install script from Bash."
    throw "Unsupported operating system"
}

$nodeWarning = $true
if (Get-Command node -ErrorAction SilentlyContinue) {
    $nodeVersion = ((@(& node --version 2>$null) -join "`n").Trim()) -replace '^v', ''
    $nodeMajor = 0
    if ($LASTEXITCODE -eq 0 -and
        [int]::TryParse(($nodeVersion -split '\.')[0], [ref]$nodeMajor) -and
        $nodeMajor -ge 22) {
        $nodeWarning = $false
    }
}

# --- Discover version (skipped when -Binary is provided) ---
$installationState = "download"
$resolvedBinary = $null
if ($Binary) {
    if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) {
        Write-InstallerError "Binary not found: $Binary"
        Write-Host "Please check the path and try again" -ForegroundColor DarkGray
        throw "Installer failed"
    }
    $resolvedBinary = (Resolve-Path -LiteralPath $Binary).Path
    try {
        $tag = ((@(& $resolvedBinary --version 2>$null) -join "`n").Trim())
    } catch {
        throw "Cannot read version from local binary"
    }
    if ([string]::IsNullOrWhiteSpace($tag) -or $tag -notmatch '^[0-9A-Za-z][0-9A-Za-z._+-]*$') {
        throw "Local binary returned an invalid version: $tag"
    }
} else {
    # Version priority: -Version param > $env:VERSION env var > auto-detect latest
    $tag = if (-not [string]::IsNullOrWhiteSpace($Version)) {
        $Version -replace '^v', ''
    } elseif (-not [string]::IsNullOrWhiteSpace($env:VERSION)) {
        $env:VERSION -replace '^v', ''
    } else {
        ""
    }

    if ([string]::IsNullOrWhiteSpace($tag)) {
        try {
            # Fetch latest stable release from GitCode releases API (mirrors GitHub /releases/latest).
            # Pull the response as raw text and extract tag_name / prerelease with regex
            # (no Invoke-RestMethod JSON parsing, matches upstream opencode's installer).
            $releaseUrl = "$GitCodeApi/releases/latest"
            $releaseJson = (Invoke-WebRequest -Uri $releaseUrl -Method Get -UseBasicParsing -ErrorAction Stop).Content
            if ($releaseJson -match '"tag_name"\s*:\s*"v?([^"]+)"') {
                $tag = ($Matches[1] -replace '^v', '')
            }
            $isPrerelease = $releaseJson -match '"prerelease"\s*:\s*true'
            if ([string]::IsNullOrWhiteSpace($tag)) {
                throw "No release found"
            }
            if ($isPrerelease) {
                throw "Latest GitCode release is marked as prerelease"
            }
            Write-Host "${ansiOrange}Latest version: ${ansiReset}$tag"
        } catch {
            Write-InstallerError "Failed to fetch version info from GitCode: $_"
            Write-Host "Hint: Use -Version 0.1.4 to specify a version manually." -ForegroundColor DarkGray
            throw "Installer failed"
        }
    } else {
        Write-Host "Using specified version: $tag" -ForegroundColor DarkGray
        # Verify the release exists
        $releaseUrl = "$GitCodeApi/releases/v$tag"
        try {
            $response = Invoke-WebRequest -Uri $releaseUrl -Method Get -UseBasicParsing -ErrorAction Stop
            if ($response.StatusCode -ne 200) { throw "HTTP $($response.StatusCode)" }
        } catch {
            Write-InstallerError "Release v$tag not found: $_"
            Write-Host "Available releases: https://gitcode.com/$Repo/releases" -ForegroundColor DarkGray
            throw "Installer failed"
        }
    }

    if ([string]::IsNullOrWhiteSpace($tag) -or $tag -notmatch '^[0-9A-Za-z][0-9A-Za-z._+-]*$') {
        throw "Invalid release version: $tag"
    }

}

# Global try/finally: ensure temp file and staging dir are cleaned up on exception or Ctrl+C
$tempFile = $null
$stageDir = $null
$launcherStage = $null
$launcherHash = $null
$installMutex = $null
try {
    $installMutex = Enter-InstallMutex

    # --- Create versioned install directories ---
    if (-not (Test-Path $VersionsDir)) {
        Invoke-FileOperation -Description "Create versions directory '$VersionsDir'" -Operation {
            New-Item -ItemType Directory -Path $VersionsDir -Force -ErrorAction Stop | Out-Null
        }
    }
    if (-not (Test-Path $BinDir)) {
        Invoke-FileOperation -Description "Create launcher directory '$BinDir'" -Operation {
            New-Item -ItemType Directory -Path $BinDir -Force -ErrorAction Stop | Out-Null
        }
    }
    $installID = [guid]::NewGuid().ToString("N")

    if (-not $Binary) {
        $useBaseline = $Baseline
        if (-not $useBaseline) {
            try {
                $useBaseline = -not (Test-Avx2)
            } catch {
                $useBaseline = $true
                Write-Host "AVX2 detection failed — using baseline variant." -ForegroundColor DarkGray
            }
        }
        $assetName = "deveco-windows-x64"
        if ($useBaseline) { $assetName += "-baseline" }
        $assetName += ".zip"
        $downloadUrl = "$GitCodeApi/releases/v$tag/attach_files/$assetName/download"
        $installationState = Get-InstallationState -TargetVersion $tag
    }

    if ($Binary) {
        # --- Binary install — stage the binary and adjacent runtime resources ---
        Write-Host ""
        Write-Host "${ansiMuted}Installing ${ansiReset}deveco ${ansiMuted}from: ${ansiReset}$Binary"
        $versionDir = Join-Path $VersionsDir $tag
        $stageDir = Join-Path $VersionsDir ".staging.$tag.$installID"
        $stageBinDir = Join-Path $stageDir "bin"
        if (Test-Path -LiteralPath $stageDir) {
            Invoke-FileOperation -Description "Remove stale staging directory '$stageDir'" -Operation {
                Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction Stop
            }
        }
        Invoke-FileOperation -Description "Create staging directory '$stageBinDir'" -Operation {
            New-Item -ItemType Directory -Path $stageBinDir -Force -ErrorAction Stop | Out-Null
        }
        $versionBin = Join-Path $stageBinDir "$AppName.exe"
        Invoke-FileOperation -Description "Copy local binary '$resolvedBinary' to '$versionBin'" -Operation {
            Copy-Item -LiteralPath $resolvedBinary -Destination $versionBin -Force -ErrorAction Stop
        }

        $sourceRoot = Split-Path (Split-Path $resolvedBinary -Parent) -Parent
        $sourceVendor = Join-Path $sourceRoot "vendor"
        if (Test-Path $sourceVendor) {
            $vendorDestination = Join-Path $stageDir "vendor"
            Invoke-FileOperation -Description "Copy local runtime resources from '$sourceVendor'" -Operation {
                if (Test-Path -LiteralPath $vendorDestination) {
                    Remove-Item -LiteralPath $vendorDestination -Recurse -Force -ErrorAction Stop
                }
                Copy-Item -LiteralPath $sourceVendor -Destination $vendorDestination -Recurse -Force -ErrorAction Stop
            }
        } else {
            throw "No adjacent vendor directory found. Use a complete build output containing vendor/deveco-cli."
        }
        $sourceChangelog = Join-Path $sourceRoot "CHANGELOG.md"
        if (Test-Path $sourceChangelog) {
            Invoke-FileOperation -Description "Copy local changelog '$sourceChangelog'" -Operation {
                Copy-Item -LiteralPath $sourceChangelog -Destination (Join-Path $stageDir "CHANGELOG.md") -Force -ErrorAction Stop
            }
        }

        if (-not (Test-InstallationComplete $stageDir)) {
            throw "Local build output is incomplete — bundled @deveco/deveco-cli runtime or CHANGELOG.md is missing"
        }
        $installedVersion = ((@(& $versionBin --version 2>$null) -join "`n").Trim())
        if ($LASTEXITCODE -ne 0) { throw "Installation verification failed — deveco could not run" }
        if ($installedVersion -ne $tag) { throw "Local binary version changed during installation" }
        $launcherStage = Join-Path $BinDir ".$AppName.exe.$installID.new"
        $launcherHash = New-StagedLauncher -Source $versionBin -Destination $launcherStage
        Publish-StagedInstallation -StageDir $stageDir -VersionDir $versionDir
        $versionBin = Join-Path $versionDir "bin\$AppName.exe"
    } elseif ($installationState -eq "download") {
        Write-Host ""
        Write-Host "${ansiMuted}Installing ${ansiReset}deveco ${ansiMuted}version: ${ansiReset}$tag"

        if ($useBaseline) {
            Write-Host "Using baseline variant." -ForegroundColor DarkGray
        } else {
            Write-Host "Using AVX2 variant." -ForegroundColor DarkGray
        }

        # --- Download to temp file ---
        $tempFile = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName() + ".zip")
        try {
            Invoke-FileOperation -Description "Download release archive '$assetName'" -Attempts 3 -Operation {
                Download-WithProgress -Url $downloadUrl -Output $tempFile
            }
        } catch {
            Write-InstallerError "Download failed: $_"
            Write-Host "Try downloading manually: $downloadUrl" -ForegroundColor DarkGray
            if (Test-Path $tempFile) { Remove-Item $tempFile -Force }
            throw "Installer failed"
        }

        # Verify download is not empty
        if (-not (Test-Path $tempFile) -or (Get-Item $tempFile).Length -eq 0) {
            Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
            Write-InstallerError "Download failed — file is empty or missing"
            Write-Host "Check your network, or download manually from $downloadUrl" -ForegroundColor DarkGray
            throw "Installer failed"
        }
        # --- Extract to staging directory ---
        $stageDir = Join-Path $VersionsDir ".staging.$tag.$installID"
        $stageBinDir = Join-Path $stageDir "bin"
        if (Test-Path -LiteralPath $stageDir) {
            Invoke-FileOperation -Description "Remove stale staging directory '$stageDir'" -Operation {
                Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction Stop
            }
        }
        Invoke-FileOperation -Description "Create staging directory '$stageBinDir'" -Operation {
            New-Item -ItemType Directory -Path $stageBinDir -Force -ErrorAction Stop | Out-Null
        }

        # Avoid the noisy Expand-Archive progress UI in Windows PowerShell and PowerShell 7.
        if (-not ("System.IO.Compression.ZipFile" -as [type])) {
            $compressionAssembly = if ($PSVersionTable.PSVersion.Major -ge 6) {
                "System.IO.Compression.ZipFile"
            } else {
                "System.IO.Compression.FileSystem"
            }
            Add-Type -AssemblyName $compressionAssembly -ErrorAction Stop
        }
        $extractionError = $null
        for ($extractAttempt = 1; $extractAttempt -le 2; $extractAttempt++) {
            if ($extractAttempt -gt 1) {
                Write-Host "${ansiMuted}Archive extraction failed; downloading a fresh copy.${ansiReset}"
                try {
                    Download-WithProgress -Url $downloadUrl -Output $tempFile
                } catch {
                    $extractionError = $_
                    continue
                }
            }
            if (Test-Path -LiteralPath $stageDir) {
                Remove-Item $stageDir -Recurse -Force -ErrorAction SilentlyContinue
            }
            New-Item -ItemType Directory -Path $stageBinDir -Force -ErrorAction Stop | Out-Null
            try {
                [System.IO.Compression.ZipFile]::ExtractToDirectory($tempFile, $stageDir)
                $extractionError = $null
                break
            } catch {
                $extractionError = $_
                Remove-Item $stageDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
        if ($extractionError) {
            Write-InstallerError "Extraction failed after a fresh download: $extractionError"
            Remove-Item $stageDir -Recurse -Force -ErrorAction SilentlyContinue
            throw "Installer failed"
        }

        # --- Find binary and move to staging/bin/ ---
        $binarySrc = Join-Path $stageDir "$AppName.exe"
        if (-not (Test-Path $binarySrc)) {
            $binarySrc = Join-Path $stageDir $AppName
        }
        if (-not (Test-Path $binarySrc)) {
            $found = Get-ChildItem -Path $stageDir -Filter "$AppName.exe" -Recurse -File | Select-Object -First 1
            if (-not $found) {
                $found = Get-ChildItem -Path $stageDir -Filter $AppName -Recurse -File | Select-Object -First 1
            }
            if ($found) { $binarySrc = $found.FullName }
        }
        if (-not (Test-Path $binarySrc)) {
            Remove-Item $stageDir -Recurse -Force -ErrorAction SilentlyContinue
            Write-InstallerError "Binary '$AppName' not found in archive"
            Write-Host "The package may be corrupted — try downloading again" -ForegroundColor DarkGray
            throw "Installer failed"
        }

        # Move binary into staging/bin/ (normalize name to deveco.exe)
        $stageBin = Join-Path $stageBinDir "$AppName.exe"
        if ($binarySrc -ne $stageBin) {
            Invoke-FileOperation -Description "Move extracted launcher '$binarySrc' to '$stageBin'" -Operation {
                Move-Item -LiteralPath $binarySrc -Destination $stageBin -Force -ErrorAction Stop
            }
        }

        # Fallback: search for vendor/ and CHANGELOG.md if not at stageDir root
        if (-not (Test-Path (Join-Path $stageDir "vendor"))) {
            $vendorFound = Get-ChildItem -Path $stageDir -Directory -Filter "vendor" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($vendorFound) {
                Invoke-FileOperation -Description "Move extracted runtime resources '$($vendorFound.FullName)'" -Operation {
                    Move-Item -LiteralPath $vendorFound.FullName -Destination (Join-Path $stageDir "vendor") -Force -ErrorAction Stop
                }
            }
        }
        if (-not (Test-Path (Join-Path $stageDir "CHANGELOG.md"))) {
            $changelog = Get-ChildItem -Path $stageDir -File -Filter "CHANGELOG.md" -Recurse -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -notmatch '\\bin\\' -and $_.FullName -notmatch '\\vendor\\' } |
                Select-Object -First 1
            if ($changelog) {
                Invoke-FileOperation -Description "Copy extracted changelog '$($changelog.FullName)'" -Operation {
                    Copy-Item -LiteralPath $changelog.FullName -Destination (Join-Path $stageDir "CHANGELOG.md") -Force -ErrorAction Stop
                }
            }
        }

        if (-not (Test-InstallationComplete $stageDir)) {
            Remove-Item $stageDir -Recurse -Force -ErrorAction SilentlyContinue
            Write-InstallerError "Release archive is incomplete"
            Write-Host "The bundled @deveco/deveco-cli runtime or CHANGELOG.md is missing" -ForegroundColor DarkGray
            throw "Installer failed"
        }

        # --- Post-install smoke test ---
        # NOTE: Avoid 2>&1 | Out-Null which resets $LASTEXITCODE to 0 in PS 5.1
        $installedVersion = ((@(& $stageBin --version 2>$null) -join "`n").Trim())
        if ($LASTEXITCODE -ne 0) {
            Remove-Item $stageDir -Recurse -Force -ErrorAction SilentlyContinue
            Write-InstallerError "Installation verification failed — deveco could not run"
            Write-Host "Platform may be incompatible" -ForegroundColor DarkGray
            throw "Installer failed"
        }
        if ($installedVersion -ne $tag) {
            Remove-Item $stageDir -Recurse -Force -ErrorAction SilentlyContinue
            Write-InstallerError "Downloaded binary version $installedVersion does not match release v$tag"
            throw "Installer failed"
        }

        $launcherStage = Join-Path $BinDir ".$AppName.exe.$installID.new"
        $launcherHash = New-StagedLauncher -Source $stageBin -Destination $launcherStage

        # --- Publish staging → version directory ---
        $versionDir = Join-Path $VersionsDir $tag
        Publish-StagedInstallation -StageDir $stageDir -VersionDir $versionDir

        $versionBin = Join-Path $versionDir "bin\$AppName.exe"
    } else {
        $versionDir = Join-Path $VersionsDir $tag
        $versionBin = Join-Path $versionDir "bin\$AppName.exe"
        if ($installationState -eq "repair") {
            $launcherStage = Join-Path $BinDir ".$AppName.exe.$installID.new"
            $launcherHash = New-StagedLauncher -Source $versionBin -Destination $launcherStage
        }
    }

    # --- Switch the pre-verified launcher with ordinary rollback ---
    if ($installationState -eq "ready" -and -not $Binary) {
        Write-Host "Keeping existing launcher binary" -ForegroundColor DarkGray
    } else {
        $oldName = if (Test-Path -LiteralPath $BinPath) { "$BinPath.old.$installID" } else { $null }
        $newLauncherPlaced = $false
        try {
            $replaced = $false
            if ($oldName) {
                try {
                    Invoke-FileOperation -Description "Atomically replace launcher '$BinPath'" -Operation {
                        [System.IO.File]::Replace($launcherStage, $BinPath, $oldName, $true)
                    }
                    $replaced = $true
                } catch {
                    # Some filesystems and executable sharing modes do not support ReplaceFile.
                }
            }
            if (-not $replaced) {
                if ($oldName) {
                    Invoke-FileOperation -Description "Back up current launcher '$BinPath'" -Operation {
                        Rename-Item -LiteralPath $BinPath -NewName (Split-Path $oldName -Leaf) -ErrorAction Stop
                    }
                }
                Invoke-FileOperation -Description "Activate staged launcher '$launcherStage'" -Operation {
                    Move-Item -LiteralPath $launcherStage -Destination $BinPath -Force -ErrorAction Stop
                }
            }
            $newLauncherPlaced = $true
            $launcherStage = $null
            $installedLauncherHash = Invoke-FileOperation -Description "Verify installed launcher '$BinPath'" -Operation {
                (Get-FileHash -LiteralPath $BinPath -Algorithm SHA256 -ErrorAction Stop).Hash
            }
            if ($launcherHash -ne $installedLauncherHash) {
                throw "Installed launcher failed SHA-256 verification"
            }
            if ($oldName) { Remove-Item -LiteralPath $oldName -Force -ErrorAction SilentlyContinue }
        } catch {
            $switchError = $_
            if ($newLauncherPlaced -and (Test-Path -LiteralPath $BinPath)) {
                try {
                    Invoke-FileOperation -Description "Remove failed launcher '$BinPath'" -Operation {
                        Remove-Item -LiteralPath $BinPath -Force -ErrorAction Stop
                    }
                } catch {}
            }
            if ($oldName -and (Test-Path -LiteralPath $oldName)) {
                try {
                    Invoke-FileOperation -Description "Restore previous launcher '$oldName'" -Operation {
                        Rename-Item -LiteralPath $oldName -NewName "$AppName.exe" -ErrorAction Stop
                    }
                } catch {
                    throw "Launcher activation failed: $($switchError.Exception.Message) Rollback also failed: $($_.Exception.Message) Previous launcher remains at '$oldName'."
                }
            }
            throw "Could not update '$BinPath'. Close running deveco processes and run the installer again. $($switchError.Exception.Message)"
        }
    }

    # --- Clean up stale .old.* files from previous installs ---
    Get-ChildItem -Path $BinDir -Filter "$AppName.exe.old.*" -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue

    # Keep the same bounded version history as the macOS installer.
    Cleanup-OldVersions

    # --- Add to user PATH (deduplicated, case-insensitive) ---
    $pathModified = $false
    if ($NoModifyPath) {
        Write-Host "Skipping PATH modification (-NoModifyPath)" -ForegroundColor DarkGray
    } else {
        $pathEntry = $BinDir
        $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
        if (-not $currentPath) { $currentPath = "" }
        $pathEntries = $currentPath -split ";" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
        $alreadyInPath = $pathEntries | Where-Object { $_ -ieq $pathEntry }

        if ($alreadyInPath) {
            Write-Host "PATH already contains $pathEntry" -ForegroundColor DarkGray
        } else {
            if ($currentPath) {
                $newPath = $currentPath.TrimEnd(";") + ";$pathEntry"
            } else {
                $newPath = $pathEntry
            }
            [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
            $env:Path += ";$pathEntry"
            Write-Host "Added $pathEntry to user PATH" -ForegroundColor Green
            $pathModified = $true
        }
    }

    # --- Success ---
    Write-Host ""
    Write-Host "▃▃▃▃  ▃▃▃▃ ▃   ▃ ▃▃▃▃  ▃▃▃   ▃▃▃     ▃▃▃   ▃▃▃  ▃▃▃▃  ▃▃▃▃"
    Write-Host "▃   ▃ ▃    ▃   ▃ ▃    ▃   ▃ ▃   ▃   ▃   ▃ ▃   ▃ ▃   ▃ ▃   "
    Write-Host "▄   ▄ ▄▄▄▄ ▄   ▄ ▄▄▄▄ ▄     ▄   ▄   ▄     ▄   ▄ ▄   ▄ ▄▄▄▄"
    Write-Host "▅   ▅ ▅    ▅   ▅ ▅    ▅   ▅ ▅   ▅   ▅   ▅ ▅   ▅ ▅   ▅ ▅   "
    Write-Host "▆▆▆▆  ▆▆▆▆  ▆▆▆  ▆▆▆▆  ▆▆▆   ▆▆▆     ▆▆▆   ▆▆▆  ▆▆▆▆  ▆▆▆▆"
    Write-Host ""
    if ($Binary) {
        Write-Host "${ansiMuted}Local binary installed.${ansiReset}"
    } else {
        Write-Host "${ansiMuted}v$tag installed.${ansiReset}"
    }

    if ($pathModified) {
        Write-Host ""
        Write-Host "${ansiOrange}Note: Open a new terminal for PATH changes to take effect.${ansiReset}"
    }

    Write-Host ""
    Write-Host "${ansiMuted}Get started:${ansiReset}"
    Write-Host ""
    Write-Host "cd <project>  " -NoNewline
    Write-Host "${ansiMuted}# Open your project directory${ansiReset}"
    Write-Host "deveco        " -NoNewline
    Write-Host "${ansiMuted}# Launch DevEco Code${ansiReset}"
    Write-Host ""

    if ($nodeWarning) {
        Write-Host 'WARNING:' -ForegroundColor Red
        Write-Host 'Node.js 22 or later is required.' -ForegroundColor Red
        Write-Host 'Without it, some DevEco Code features will not work.' -ForegroundColor Red
        Write-Host 'Install Node.js from https://nodejs.org/ and make sure "node" is available in your PATH.' -ForegroundColor Red
        Write-Host ""
    }
} catch {
    $installError = $_
    Write-Host "[DEVECO_INSTALL_ERROR] $($installError.Exception.Message)"
    throw $installError
} finally {
    # Global cleanup: ensure temp files are removed on exception or Ctrl+C
    if ($tempFile -and (Test-Path $tempFile)) { Remove-Item $tempFile -Force -ErrorAction SilentlyContinue }
    if ($stageDir -and (Test-Path $stageDir)) { Remove-Item $stageDir -Recurse -Force -ErrorAction SilentlyContinue }
    if ($launcherStage -and (Test-Path $launcherStage)) { Remove-Item $launcherStage -Force -ErrorAction SilentlyContinue }
    if ($installMutex) {
        try {
            [void]$installMutex.ReleaseMutex()
        } finally {
            $installMutex.Dispose()
        }
    }
}
