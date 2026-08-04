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

# TLS 1.2 配置(PS 5.1 默认 TLS 1.0/1.1,GitCode HTTPS 需要 TLS 1.2)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# 防止 PowerShell 5.1 的 Invoke-WebRequest 进度条显著拖慢大文件下载
$ProgressPreference = 'SilentlyContinue'

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

function Download-WithProgress {
    param([string]$Url, [string]$Output)
    # Try BITS first — native progress bar, doesn't slow downloads
    if (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue) {
        try {
            Start-BitsTransfer -Source $Url -Destination $Output -ErrorAction Stop
            return
        } catch {
            Write-Host "BITS transfer failed, falling back to Invoke-WebRequest" -ForegroundColor Yellow
        }
    }
    # Fallback: Invoke-WebRequest (progress disabled for PS 5.1 speed)
    Invoke-WebRequest -Uri $Url -OutFile $Output -UseBasicParsing
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

# M1: Check if the target version is already installed; exit 0 if so
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
        Write-Host "Version $TargetVersion already installed, skipping" -ForegroundColor Cyan
        exit 0
    }
    Write-Host "Installed version: $installed." -ForegroundColor Cyan
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
    exit 0
}

# --- Discover version (skipped when -Binary is provided) ---
if ($Binary) {
    if (-not (Test-Path $Binary)) {
        Write-Error "Binary not found: $Binary"
        Write-Host "Please check the path and try again" -ForegroundColor Yellow
        exit 1
    }
    $tag = "local"
} else {
    # 版本优先级: -Version 参数 > $env:VERSION 环境变量 > 自动探测最新
    $tag = if (-not [string]::IsNullOrWhiteSpace($Version)) {
        $Version -replace '^v', ''
    } elseif (-not [string]::IsNullOrWhiteSpace($env:VERSION)) {
        $env:VERSION -replace '^v', ''
    } else {
        ""
    }

    if ([string]::IsNullOrWhiteSpace($tag)) {
        Write-Host "Fetching latest version from GitCode..." -ForegroundColor Cyan
        try {
            $tagsUrl = "$GitCodeApi/tags?per_page=100"
            $tagsResponse = Invoke-RestMethod -Uri $tagsUrl -Method Get -ErrorAction Stop
            $tag = $tagsResponse.name |
                Where-Object { $_ -match '^v?\d+\.\d+\.\d+$' } |
                ForEach-Object { $_ -replace '^v', '' } |
                Sort-Object { [version]$_ } -Descending |
                Select-Object -First 1
            if ([string]::IsNullOrWhiteSpace($tag)) {
                throw "No valid version tags found"
            }
            Write-Host "Latest version: $tag" -ForegroundColor Green
        } catch {
            Write-Error "Failed to fetch version info from GitCode: $_"
            Write-Host "Hint: Use -Version 0.1.4 to specify a version manually." -ForegroundColor Yellow
            exit 1
        }
    } else {
        Write-Host "Using specified version: $tag" -ForegroundColor Cyan
        # Verify the release exists
        $releaseUrl = "$GitCodeApi/releases/v$tag"
        try {
            $response = Invoke-WebRequest -Uri $releaseUrl -Method Head -UseBasicParsing -ErrorAction Stop
            if ($response.StatusCode -ne 200) { throw "HTTP $($response.StatusCode)" }
        } catch {
            Write-Error "Release v$tag not found: $_"
            Write-Host "Available releases: https://gitcode.com/$Repo/releases" -ForegroundColor Yellow
            exit 1
        }
    }

    # M1: Version skip check — only when NOT using -Binary
    Test-InstalledVersion $tag
}

# 全局 try/finally: 确保异常或 Ctrl+C 时清理 $tempFile 和 $stageDir
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
        Write-Host "Installing deveco from: $Binary" -ForegroundColor Cyan
        $versionDir = Join-Path $VersionsDir "local"
        $versionBinDir = Join-Path $versionDir "bin"
        if (-not (Test-Path $versionBinDir)) {
            New-Item -ItemType Directory -Path $versionBinDir -Force | Out-Null
        }
        $versionBin = Join-Path $versionBinDir "$AppName.exe"
        Copy-Item -Path $Binary -Destination $versionBin -Force
    } else {
        # --- Determine baseline vs AVX2 ---
        $useBaseline = $Baseline
        if (-not $useBaseline) {
            $useBaseline = -not (Test-Avx2)
            if ($useBaseline) {
                Write-Host "AVX2 not detected — using baseline variant." -ForegroundColor Yellow
            } else {
                Write-Host "AVX2 detected — using standard variant." -ForegroundColor Green
            }
        }

        # --- Construct asset name and download URL ---
        $assetName = "deveco-windows-x64"
        if ($useBaseline) { $assetName += "-baseline" }
        $assetName += ".zip"

        # GitCode attach_files download endpoint (aligned with bash script)
        $downloadUrl = "$GitCodeApi/releases/v$tag/attach_files/$assetName/download"

        # --- Download to temp file ---
        Write-Host "Downloading: $downloadUrl" -ForegroundColor Cyan
        $tempFile = [System.IO.Path]::GetTempFileName() + ".zip"
        try {
            Download-WithProgress -Url $downloadUrl -Output $tempFile
        } catch {
            Write-Error "Download failed: $_"
            Write-Host "Try downloading manually: $downloadUrl" -ForegroundColor Yellow
            if (Test-Path $tempFile) { Remove-Item $tempFile -Force }
            exit 1
        }

        # Verify download is not empty
        if (-not (Test-Path $tempFile) -or (Get-Item $tempFile).Length -eq 0) {
            Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
            Write-Error "Download failed — file is empty or missing"
            Write-Host "Check your network, or download manually from $downloadUrl" -ForegroundColor Yellow
            exit 1
        }

        # --- Extract to staging directory ---
        $stageDir = Join-Path $VersionsDir ".staging.$tag.$PID"
        $stageBinDir = Join-Path $stageDir "bin"
        if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
        New-Item -ItemType Directory -Path $stageBinDir -Force | Out-Null

        Write-Host "Extracting..." -ForegroundColor Cyan
        try {
            Expand-Archive -Path $tempFile -DestinationPath $stageDir -Force -ErrorAction Stop
        } catch {
            Write-Error "Extraction failed: $_"
            Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
            Remove-Item $stageDir -Recurse -Force -ErrorAction SilentlyContinue
            exit 1
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
            Write-Host "The package may be corrupted — try downloading again" -ForegroundColor Yellow
            exit 1
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
            Write-Host "Platform may be incompatible" -ForegroundColor Yellow
            exit 1
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
    if ($NoModifyPath) {
        Write-Host "Skipping PATH modification (-NoModifyPath)" -ForegroundColor Yellow
    } else {
        $pathEntry = $BinDir
        $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
        if (-not $currentPath) { $currentPath = "" }
        $pathEntries = $currentPath -split ";" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
        $alreadyInPath = $pathEntries | Where-Object { $_ -ieq $pathEntry }

        if ($alreadyInPath) {
            Write-Host "PATH already contains $pathEntry" -ForegroundColor Green
        } else {
            if ($currentPath) {
                $newPath = $currentPath.TrimEnd(";") + ";$pathEntry"
            } else {
                $newPath = $pathEntry
            }
            [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
            $env:Path += ";$pathEntry"
            Write-Host "Added $pathEntry to user PATH" -ForegroundColor Green
        }
    }

    # --- Success ---
    $devecoPath = $BinPath
    if ($Binary) {
        $versionOutput = $tag
    } else {
        $versionOutput = & $devecoPath --version 2>&1
    }
    Write-Host ""
    Write-Host "▃▃▃▃  ▃▃▃▃ ▃   ▃ ▃▃▃▃  ▃▃▃   ▃▃▃     ▃▃▃   ▃▃▃  ▃▃▃▃  ▃▃▃▃" -ForegroundColor Green
    Write-Host "▃   ▃ ▃    ▃   ▃ ▃    ▃   ▃ ▃   ▃   ▃   ▃ ▃   ▃ ▃   ▃ ▃   " -ForegroundColor Green
    Write-Host "▄   ▄ ▄▄▄▄ ▄   ▄ ▄▄▄▄ ▄     ▄   ▄   ▄     ▄   ▄ ▄   ▄ ▄▄▄▄" -ForegroundColor Green
    Write-Host "▅   ▅ ▅    ▅   ▅ ▅    ▅   ▅ ▅   ▅   ▅   ▅ ▅   ▅ ▅   ▅ ▅   " -ForegroundColor Green
    Write-Host "▆▆▆▆  ▆▆▆▆  ▆▆▆  ▆▆▆▆  ▆▆▆   ▆▆▆     ▆▆▆   ▆▆▆  ▆▆▆▆  ▆▆▆▆" -ForegroundColor Green
    Write-Host ""
    if ($tag -eq "local") {
        Write-Host "Local binary installed." -ForegroundColor Green
    } else {
        Write-Host "DevEco Code v$tag installed successfully!" -ForegroundColor Green
    }
    Write-Host "  Version:  $versionOutput" -ForegroundColor White
    Write-Host "  Location: $devecoPath" -ForegroundColor White
    Write-Host "  Note: Open a new terminal for PATH changes to take effect." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Get started:" -ForegroundColor Cyan
    Write-Host "  cd <project>  # Open your project directory" -ForegroundColor White
    Write-Host "  deveco        # Launch DevEco Code" -ForegroundColor White
    Write-Host ""
} finally {
    # 全局清理: 确保异常或 Ctrl+C 时清理临时文件
    if ($tempFile -and (Test-Path $tempFile)) { Remove-Item $tempFile -Force -ErrorAction SilentlyContinue }
    if ($stageDir -and (Test-Path $stageDir)) { Remove-Item $stageDir -Recurse -Force -ErrorAction SilentlyContinue }
}
