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

# Prevent Invoke-WebRequest progress bar from significantly slowing down large file downloads in PS 5.1
$ProgressPreference = 'SilentlyContinue'

# Ensure console outputs Unicode characters correctly (progress bar uses ━/─); does not affect ASCII text
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ANSI color codes for the gradient progress bar and muted text.
# Use [char]27 instead of `e — the latter only works in PS 7+, not in Windows default PS 5.1
$esc = [char]27
$ansiOrange = "${esc}[38;5;214m"
$ansiReset  = "${esc}[0m"

$gitcodeOwner = if ($env:GITCODE_OWNER) { $env:GITCODE_OWNER } else { "openharmony-sig" }
$gitcodeRepo = if ($env:GITCODE_REPO) { $env:GITCODE_REPO } else { "deveco-code" }
$Repo = "$gitcodeOwner/$gitcodeRepo"
$GitCodeApi = "https://gitcode.com/api/v5/repos/$Repo"
$AppName = "deveco"
$VersionsDir = Join-Path $env:USERPROFILE ".local\share\deveco\versions"
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
    # Try BITS first — native, fast, no visible progress in PS console
    if (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue) {
        try {
            Start-BitsTransfer -Source $Url -Destination $Output -ErrorAction Stop
            return
        } catch {
            Write-Host "BITS transfer failed ($($_.Exception.Message)), falling back to streaming download" -ForegroundColor DarkGray
        }
    }
    # Fallback: streaming download with progress bar (PowerShell 5.1 Invoke-WebRequest progress is too slow)
    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromMinutes(10)
    $totalBytes = 0
    try {
        $response = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
        try {
            $response.EnsureSuccessStatusCode()
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

# M1: Check if the target version is already installed; return true if so
function Test-InstalledVersion {
    param([string]$TargetVersion)
    if (-not (Test-Path $BinPath)) { return }
    try {
        $installed = (& $BinPath --version 2>$null) -join "`n"
    } catch {
        return
    }
    $installed = $installed.Trim()
    if (-not $installed) { return }
    if ($installed -eq $TargetVersion) {
        Write-Host "Version $TargetVersion already installed, skipping" -ForegroundColor DarkGray
        return $true
    }
    Write-Host "Installed version: $installed." -ForegroundColor DarkGray
    return $false
}

function Cleanup-OldVersions {
    $dirs = Get-ChildItem -Path $VersionsDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike '.*' -and $_.Name -match '^\d' } |
        Sort-Object { [version]($_.Name -replace '-.*$','') } -ErrorAction SilentlyContinue
    if (-not $dirs -or $dirs.Count -le $VersionRetentionCount) { return }
    # NOTE: Use 2>$null (not 2>&1 |) to avoid $LASTEXITCODE reset in PS 5.1
    # and to exclude stderr noise (e.g. "Bun v1.3.14") that confuses the regex.
    $currentVersion = $null
    if (Test-Path $BinPath) {
        try {
            $lines = @(& $BinPath --version 2>$null)
            if ($lines[0] -match '(\d+\.\d+\.\d+)') { $currentVersion = $Matches[1] }
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

# --- Discover version (skipped when -Binary is provided) ---
if ($Binary) {
    if (-not (Test-Path $Binary)) {
        Write-Error "Binary not found: $Binary"
        Write-Host "Please check the path and try again" -ForegroundColor DarkGray
        throw "Installer failed"
    }
    $tag = "local"
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
            Write-Host "Latest version: " -ForegroundColor Green -NoNewline
            Write-Host $tag
        } catch {
            Write-Error "Failed to fetch version info from GitCode: $_"
            Write-Host "Hint: Use -Version 0.1.4 to specify a version manually." -ForegroundColor DarkGray
            throw "Installer failed"
        }
    } else {
        Write-Host "Using specified version: $tag" -ForegroundColor DarkGray
        # Verify the release exists
        $releaseUrl = "$GitCodeApi/releases/v$tag"
        try {
            $response = Invoke-WebRequest -Uri $releaseUrl -Method Head -UseBasicParsing -ErrorAction Stop
            if ($response.StatusCode -ne 200) { throw "HTTP $($response.StatusCode)" }
        } catch {
            Write-Error "Release v$tag not found: $_"
            Write-Host "Available releases: https://gitcode.com/$Repo/releases" -ForegroundColor DarkGray
            throw "Installer failed"
        }
    }

    # M1: Version skip check — only when NOT using -Binary
    if (Test-InstalledVersion $tag) { return }
}

# Global try/finally: ensure temp file and staging dir are cleaned up on exception or Ctrl+C
$tempFile = $null
$stageDir = $null
try {
    # --- Create versioned install directories ---
    if (-not (Test-Path $VersionsDir)) {
        New-Item -ItemType Directory -Path $VersionsDir -Force | Out-Null
    }
    if (-not (Test-Path $BinDir)) {
        New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    }

    if ($Binary) {
        # --- Binary install — copy local binary to versioned dir ---
        Write-Host ""
        Write-Host "Installing deveco from: $Binary" -ForegroundColor DarkGray
        $versionDir = Join-Path $VersionsDir "local"
        $versionBinDir = Join-Path $versionDir "bin"
        if (-not (Test-Path $versionBinDir)) {
            New-Item -ItemType Directory -Path $versionBinDir -Force | Out-Null
        }
        $versionBin = Join-Path $versionBinDir "$AppName.exe"
        Copy-Item -Path $Binary -Destination $versionBin -Force
    } else {
        Write-Host ""
        Write-Host "Installing deveco version: $tag" -ForegroundColor DarkGray

        # --- Determine baseline vs AVX2 ---
        $useBaseline = $Baseline
        if (-not $useBaseline) {
            $useBaseline = -not (Test-Avx2)
            if ($useBaseline) {
                Write-Host "AVX2 not detected — using baseline variant." -ForegroundColor DarkGray
            } else {
                Write-Host "AVX2 detected — using standard variant." -ForegroundColor DarkGray
            }
        }

        # --- Construct asset name and download URL ---
        $assetName = "deveco-windows-x64"
        if ($useBaseline) { $assetName += "-baseline" }
        $assetName += ".zip"

        # GitCode attach_files download endpoint (aligned with bash script)
        $downloadUrl = "$GitCodeApi/releases/v$tag/attach_files/$assetName/download"

        # --- Download to temp file ---
        $tempFile = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName() + ".zip")
        try {
            Download-WithProgress -Url $downloadUrl -Output $tempFile
        } catch {
            Write-Error "Download failed: $_"
            Write-Host "Try downloading manually: $downloadUrl" -ForegroundColor DarkGray
            if (Test-Path $tempFile) { Remove-Item $tempFile -Force }
            throw "Installer failed"
        }

        # Verify download is not empty
        if (-not (Test-Path $tempFile) -or (Get-Item $tempFile).Length -eq 0) {
            Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
            Write-Error "Download failed — file is empty or missing"
            Write-Host "Check your network, or download manually from $downloadUrl" -ForegroundColor DarkGray
            throw "Installer failed"
        }

        # --- Extract to staging directory ---
        $stageDir = Join-Path $VersionsDir ".staging.$tag.$PID"
        $stageBinDir = Join-Path $stageDir "bin"
        if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
        New-Item -ItemType Directory -Path $stageBinDir -Force | Out-Null

        try {
            Expand-Archive -Path $tempFile -DestinationPath $stageDir -Force -ErrorAction Stop
        } catch {
            Write-Error "Extraction failed: $_"
            Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
            Remove-Item $stageDir -Recurse -Force -ErrorAction SilentlyContinue
            throw "Installer failed"
        } finally {
            Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
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
            Write-Error "Binary '$AppName' not found in archive"
            Write-Host "The package may be corrupted — try downloading again" -ForegroundColor DarkGray
            throw "Installer failed"
        }

        # Move binary into staging/bin/ (normalize name to deveco.exe)
        $stageBin = Join-Path $stageBinDir "$AppName.exe"
        if ($binarySrc -ne $stageBin) {
            Move-Item -Path $binarySrc -Destination $stageBin -Force
        }

        # Fallback: search for vendor/ and CHANGELOG.md if not at stageDir root
        if (-not (Test-Path (Join-Path $stageDir "vendor"))) {
            $vendorFound = Get-ChildItem -Path $stageDir -Directory -Filter "vendor" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($vendorFound) {
                Move-Item -Path $vendorFound.FullName -Destination (Join-Path $stageDir "vendor") -Force
            }
        }
        if (-not (Test-Path (Join-Path $stageDir "CHANGELOG.md"))) {
            $changelog = Get-ChildItem -Path $stageDir -File -Filter "CHANGELOG.md" -Recurse -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -notmatch '\\bin\\' -and $_.FullName -notmatch '\\vendor\\' } |
                Select-Object -First 1
            if ($changelog) {
                Copy-Item -Path $changelog.FullName -Destination (Join-Path $stageDir "CHANGELOG.md") -Force
            }
        }

        # --- Atomic switch: staging → version directory ---
        $versionDir = Join-Path $VersionsDir $tag
        if (Test-Path $versionDir) { Remove-Item $versionDir -Recurse -Force }
        Move-Item -Path $stageDir -Destination $versionDir

        $versionBin = Join-Path $versionDir "bin\$AppName.exe"

        # --- Post-install smoke test ---
        # NOTE: Avoid 2>&1 | Out-Null which resets $LASTEXITCODE to 0 in PS 5.1
        & $versionBin --version 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Remove-Item $versionDir -Recurse -Force -ErrorAction SilentlyContinue
            Write-Error "Installation verification failed — deveco could not run"
            Write-Host "Platform may be incompatible" -ForegroundColor DarkGray
            throw "Installer failed"
        }
    }

    # --- Windows rename-then-copy + rollback (aligned with Claude Code) ---
    if (Test-Path $BinPath) {
        $oldName = "$BinPath.old.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
        $oldLeaf = Split-Path $oldName -Leaf
        Rename-Item -Path $BinPath -NewName $oldLeaf
        try {
            Copy-Item -Path $versionBin -Destination $BinPath -Force
            # SHA-256 verification after copy
            $expected = (Get-FileHash -Path $versionBin -Algorithm SHA256).Hash
            $actual = (Get-FileHash -Path $BinPath -Algorithm SHA256).Hash
            if ($expected -ne $actual) {
                throw "SHA-256 verification failed after copy"
            }
            Remove-Item -Path $oldName -Force -ErrorAction SilentlyContinue
        } catch {
            # Rollback: restore the old binary
            if (Test-Path $oldName) {
                if (Test-Path $BinPath) { Remove-Item $BinPath -Force -ErrorAction SilentlyContinue }
                Rename-Item -Path $oldName -NewName "$AppName.exe"
            }
            throw
        }
    } else {
        Copy-Item -Path $versionBin -Destination $BinPath -Force
    }

    # --- Clean up stale .old.* files from previous installs ---
    Get-ChildItem -Path $BinDir -Filter "$AppName.exe.old.*" -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue

    # --- Clean up old versions (keep $VersionRetentionCount) ---
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
    if ($tag -eq "local") {
        Write-Host "Local binary installed." -ForegroundColor DarkGray
    } else {
        Write-Host "v$tag installed." -ForegroundColor DarkGray
    }

    if ($pathModified) {
        Write-Host "${ansiOrange}Note: Open a new terminal for PATH changes to take effect.${ansiReset}"
        Write-Host ""
    }

    Write-Host ""
    Write-Host "Get started:" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "cd <project>  " -NoNewline
    Write-Host "# Open your project directory" -ForegroundColor DarkGray
    Write-Host "deveco        " -NoNewline
    Write-Host "# Launch DevEco Code" -ForegroundColor DarkGray
    Write-Host ""
} finally {
    # Global cleanup: ensure temp files are removed on exception or Ctrl+C
    if ($tempFile -and (Test-Path $tempFile)) { Remove-Item $tempFile -Force -ErrorAction SilentlyContinue }
    if ($stageDir -and (Test-Path $stageDir)) { Remove-Item $stageDir -Recurse -Force -ErrorAction SilentlyContinue }
}
