# DevEco Code Windows Binary Installer
# Downloads pre-built deveco binary from GitCode Releases
#
# Usage:
#   irm https://raw.gitcode.com/openharmony-sig/deveco-code/raw/develop/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.gitcode.com/openharmony-sig/deveco-code/raw/develop/install.ps1))) -Version <version>
#   & ([scriptblock]::Create((irm https://raw.gitcode.com/openharmony-sig/deveco-code/raw/develop/install.ps1))) -Baseline
#   & ([scriptblock]::Create((irm https://raw.gitcode.com/openharmony-sig/deveco-code/raw/develop/install.ps1))) -Binary C:\path\to\deveco.exe
#   & ([scriptblock]::Create((irm https://raw.gitcode.com/openharmony-sig/deveco-code/raw/develop/install.ps1))) -NoModifyPath

[CmdletBinding()]
param(
    [string]$Version = "",
    [switch]$Baseline,
    [string]$Binary = "",
    [switch]$NoModifyPath,
    [switch]$NoAnalytics,
    [string]$InstallSource = "",
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

# Ensure console outputs Unicode characters correctly when a console is attached.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

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

# Installation telemetry contract.
$TelemetryEndpoint = "https://cn.devecostudio.huawei.com/codeGenie/cli/trace/upload"
$TelemetrySender = "deveco-cli"
$TelemetryMaxEvents = 200
$TelemetryMaxBytes = 1782579
$InstallerRevision = "install-telemetry-v1"
$script:TelemetryEnabled = $false
$script:TelemetryStarted = $false
$script:TelemetryFinalized = $false
$script:TelemetryEvents = $null
$script:TelemetryResult = "failure"
$script:TelemetryStage = "preflight"
$script:TelemetryErrorCode = "unknown"
$script:TelemetryWarningCode = $null
$script:TelemetryPathReached = $false
$script:TelemetryPathResult = "not_reached"
$script:TelemetrySkipReason = $null
$script:TelemetryStartedTarget = $null
$script:TelemetryDownloadStarted = $false
$script:TelemetryDownloadSent = $false
$script:TelemetryDownloadAttempts = 0
$script:TelemetryDownloadRounds = 0
$script:TelemetryDownloadDurationMs = 0
$script:TelemetryDownloadBytes = $null
$script:TelemetryInstallStopwatch = $null

function Get-InstallTelemetryEndpoint {
    if ($env:DEVECO_INSTALLER_TELEMETRY_ENDPOINT -match '^http://(127\.0\.0\.1|localhost|\[::1\]):\d+(/.*)?$') {
        return $env:DEVECO_INSTALLER_TELEMETRY_ENDPOINT
    }
    return $TelemetryEndpoint
}

function Add-InstallTelemetryEvent {
    param([string]$Action, [hashtable]$EventDetail)
    if (-not $script:TelemetryEnabled -or $script:TelemetryEvents.Count -ge $TelemetryMaxEvents) { return }
    $detail = @{
        trace_uuid = [guid]::NewGuid().ToString("D")
        session_id = $script:TelemetrySessionID
        event_detail = $EventDetail
    } | ConvertTo-Json -Compress -Depth 8
    [void]$script:TelemetryEvents.Add(@{
        action = $Action
        detail = $detail
        timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    })
}

function Send-InstallTelemetry {
    if (-not $script:TelemetryEnabled -or $script:TelemetryEvents.Count -eq 0) { return }
    $payload = ConvertTo-Json -InputObject @($script:TelemetryEvents) -Compress -Depth 10
    if ([System.Text.Encoding]::UTF8.GetByteCount($payload) -gt $TelemetryMaxBytes) { return }
    $client = $null
    $content = $null
    try {
        $endpoint = Get-InstallTelemetryEndpoint
        $handler = [System.Net.Http.HttpClientHandler]::new()
        $handler.UseCookies = $false
        $handler.UseDefaultCredentials = $false
        if ($handler.PSObject.Properties["ConnectTimeout"]) {
            $handler.ConnectTimeout = [TimeSpan]::FromSeconds(1)
        }
        if ($endpoint -match '^http://(127\.0\.0\.1|localhost|\[::1\]):') { $handler.UseProxy = $false }
        $client = [System.Net.Http.HttpClient]::new($handler)
        $client.Timeout = [TimeSpan]::FromSeconds(2)
        [void]$client.DefaultRequestHeaders.TryAddWithoutValidation("sender", $TelemetrySender)
        [void]$client.DefaultRequestHeaders.TryAddWithoutValidation("deviceid", $script:TelemetryInstallID)
        $content = [System.Net.Http.StringContent]::new($payload, [System.Text.Encoding]::UTF8, "application/json")
        $response = $client.PostAsync($endpoint, $content).GetAwaiter().GetResult()
        $response.Dispose()
    } catch {
        # Telemetry is best effort and must never affect installation.
    } finally {
        if ($content) { $content.Dispose() }
        if ($client) { $client.Dispose() }
    }
}

function Add-DownloadFinishedTelemetry {
    param([string]$Result, [string]$ErrorCode = "")
    if (-not $script:TelemetryDownloadStarted -or $script:TelemetryDownloadSent) { return }
    $script:TelemetryDownloadSent = $true
    $download = @{
        method = "httpclient"
        attempt_count = $script:TelemetryDownloadAttempts
        round_count = $script:TelemetryDownloadRounds
        duration_ms = [int64]$script:TelemetryDownloadDurationMs
    }
    if ($null -ne $script:TelemetryDownloadBytes) { $download.bytes = [int64]$script:TelemetryDownloadBytes }
    $detail = @{ schema_version = 1; result = $Result; download = $download }
    if ($ErrorCode) { $detail.error_code = $ErrorCode }
    Add-InstallTelemetryEvent -Action "DevEcoCodeDownloadFinished" -EventDetail $detail
}

function Complete-InstallTelemetry {
    if (-not $script:TelemetryStarted -or $script:TelemetryFinalized) { return }
    $script:TelemetryFinalized = $true
    if ($script:TelemetryDownloadStarted -and -not $script:TelemetryDownloadSent) {
        Add-DownloadFinishedTelemetry -Result "failure" -ErrorCode "download_http_error"
    }
    $detail = @{
        schema_version = 1
        result = $script:TelemetryResult
        duration_ms = [int64]$script:TelemetryInstallStopwatch.ElapsedMilliseconds
    }
    if ($tag -and $tag.Length -le 128 -and $tag -ne $script:TelemetryStartedTarget) {
        $detail.target_version = $tag
    }
    if ($script:TelemetryResult -eq "failure") {
        $detail.stage = $script:TelemetryStage
        $detail.error_code = $script:TelemetryErrorCode
    }
    if ($script:TelemetryWarningCode) { $detail.warning_code = $script:TelemetryWarningCode }
    if ($script:TelemetryResult -eq "skipped") { $detail.skip_reason = $script:TelemetrySkipReason }
    if ($script:TelemetryPathReached -and $script:TelemetryPathResult -ne "not_reached") {
        $detail.path_result = $script:TelemetryPathResult
    }
    Add-InstallTelemetryEvent -Action "DevEcoCodeInstallFinished" -EventDetail $detail
    Send-InstallTelemetry
}

function Start-InstallTelemetry {
    if ($NoAnalytics) { return }
    if ($env:DEVECO_TELEMETRY_DISABLED -in @("1", "true") -or $env:DO_NOT_TRACK -eq "1") { return }

    $stateHome = if ($env:XDG_STATE_HOME) { $env:XDG_STATE_HOME } else { Join-Path $env:USERPROFILE ".local\state" }
    $preferenceFile = Join-Path $stateHome "deveco\kv.json"
    if (Test-Path -LiteralPath $preferenceFile) {
        try {
            $preference = Get-Content -LiteralPath $preferenceFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $analyticsProperty = $preference.PSObject.Properties["analytics_enabled"]
            if ($analyticsProperty -and $analyticsProperty.Value -is [bool] -and -not $analyticsProperty.Value) { return }
        } catch { return }
    }

    $idDir = Join-Path $DataHome "deveco\analytics"
    $idFile = Join-Path $idDir "installer-install-id"
    $candidate = [guid]::NewGuid().ToString("D")
    $telemetryInstallID = $candidate
    $temporaryIDFile = $null
    try {
        New-Item -ItemType Directory -Path $idDir -Force -ErrorAction Stop | Out-Null
        if (-not (Test-Path -LiteralPath $idFile)) {
            try {
                $stream = [System.IO.File]::Open($idFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
                try {
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes("$candidate`r`n")
                    $stream.Write($bytes, 0, $bytes.Length)
                    $stream.Flush()
                } finally { $stream.Dispose() }
            } catch {}
        }
        $persistedID = (Get-Content -LiteralPath $idFile -Raw -Encoding UTF8).Trim()
        if ($persistedID -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$') {
            $temporaryIDFile = "$idFile.$PID.tmp"
            [System.IO.File]::WriteAllText($temporaryIDFile, "$candidate`r`n", [System.Text.UTF8Encoding]::new($false))
            Move-Item -LiteralPath $temporaryIDFile -Destination $idFile -Force -ErrorAction Stop
            $persistedID = $candidate
        }
        $telemetryInstallID = $persistedID
    } catch {} finally {
        if ($temporaryIDFile -and (Test-Path -LiteralPath $temporaryIDFile)) {
            Remove-Item -LiteralPath $temporaryIDFile -Force -ErrorAction SilentlyContinue
        }
    }
    $script:TelemetryInstallID = $telemetryInstallID -replace '-', ''

    $source = if ($InstallSource) { $InstallSource } elseif ($env:DEVECO_INSTALL_SOURCE) { $env:DEVECO_INSTALL_SOURCE } else { "direct-script-v1" }
    if ($source -notin @("direct-script-v1", "gitcode-raw-v1", "deveco-self-upgrade-v1", "unknown")) { $source = "unknown" }
    $script:TelemetrySessionID = [guid]::NewGuid().ToString("D")
    $script:TelemetryEvents = [System.Collections.ArrayList]::new()
    $script:TelemetryEnabled = $true
    $script:TelemetryStarted = $true
    $script:TelemetryInstallStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $cpuVariant = if ($Baseline) {
        "baseline"
    } else {
        try { if (Test-Avx2) { "avx2" } else { "baseline" } } catch { $null }
    }
    $osArch = switch ($env:PROCESSOR_ARCHITECTURE) {
        { $_ -in @("AMD64", "x86_64") } { "x64"; break }
        "ARM64" { "arm64"; break }
        default { "unknown" }
    }
    $eventDetail = @{
        schema_version = 1
        os_name = "Windows"
        os_version = [System.Environment]::OSVersion.Version.ToString()
        os_arch = $osArch
        installer = "powershell"
        shell_version = $PSVersionTable.PSVersion.ToString()
        installer_revision = $InstallerRevision
        installer_source_id = $source
        install_method = if ($Binary) { "local_binary" } else { "download" }
    }
    if ($cpuVariant) { $eventDetail.cpu_variant = $cpuVariant }
    if (Get-Command node -ErrorAction SilentlyContinue) {
        try {
            $nodeProbe = Invoke-NativeVersion -ExePath "node"
            $telemetryNodeMajor = 0
            if ($nodeProbe.ExitCode -eq 0 -and [int]::TryParse((($nodeProbe.Output -replace '^v', '') -split '\.')[0], [ref]$telemetryNodeMajor)) {
                $eventDetail.node_major = $telemetryNodeMajor
            }
        } catch {}
    }
    $requestedTarget = if ($Version) { $Version -replace '^v', '' } elseif ($env:VERSION) { $env:VERSION -replace '^v', '' } else { $null }
    if ($requestedTarget -and $requestedTarget.Length -le 128 -and $requestedTarget -match '^[0-9A-Za-z][0-9A-Za-z._+-]*$') {
        $script:TelemetryStartedTarget = $requestedTarget
        $eventDetail.target_version = $requestedTarget
    }
    Add-InstallTelemetryEvent -Action "DevEcoCodeInstallStarted" -EventDetail $eventDetail
}

function Show-Help {
    Write-Host "DevEco Code Windows Installer"
    Write-Host ""
    Write-Host "Usage: install.ps1 [options]"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -Version <version>   Install a specific version"
    Write-Host "  -Baseline            Force baseline variant (no AVX2)"
    Write-Host "  -Binary <path>       Install from a local binary instead of downloading"
    Write-Host "  -NoModifyPath        Don't modify user PATH"
    Write-Host "  -NoAnalytics         Disable installation telemetry for this run"
    Write-Host "  -InstallSource <id>  Set the installer source identifier"
    Write-Host "  -Help                Show this help message"
    Write-Host ""
    Write-Host "Environment:"
    Write-Host "  GITCODE_OWNER        GitCode repo owner (default: openharmony-sig)"
    Write-Host "  GITCODE_REPO         GitCode repo name (default: deveco-code)"
    Write-Host "  VERSION              Version to install (overridden by -Version)"
    Write-Host "  DEVECO_INSTALL_SOURCE Installer source identifier"
    Write-Host "  DEVECO_TELEMETRY_DISABLED Set to 1 or true to disable installation telemetry"
    Write-Host ""
    Write-Host "Examples:"
    Write-Host "  irm https://raw.gitcode.com/openharmony-sig/deveco-code/raw/develop/install.ps1 | iex"
    Write-Host "  & ([scriptblock]::Create((irm https://raw.gitcode.com/openharmony-sig/deveco-code/raw/develop/install.ps1))) -Version <version>"
    Write-Host "  & ([scriptblock]::Create((irm https://raw.gitcode.com/openharmony-sig/deveco-code/raw/develop/install.ps1))) -Binary C:\path\to\deveco.exe"
}

# Progress bar constants — 6-stop gradient (pink→purple→blue→cyan→mint→green), ━ / ─ box-drawing chars.
# Width 28, falls back to a hand-tuned 16-color mapping on Windows conhost / PowerShell 5.1.
# Throttle: render at most once per 1% increment, 100% always renders.
$ProgressBarWidth  = 28
$ProgressFillChar  = [char]0x2501   # ━ BOX DRAWINGS HEAVY HORIZONTAL
$ProgressEmptyChar = [char]0x2500   # ─ BOX DRAWINGS LIGHT HORIZONTAL

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
    $lastPercent = -1
    while (($bytesRead = $InputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $OutputStream.Write($buffer, 0, $bytesRead)
        $totalRead += $bytesRead
        if ($TotalBytes -gt 0) {
            $percent = [int][math]::Floor($totalRead * 100 / $TotalBytes)
            if ($percent -gt 100) { $percent = 100 }
            # 1%-granularity throttle: skip when same integer percent already rendered
            if ($percent -lt 100 -and $percent -eq $lastPercent) { continue }
            $lastPercent = $percent
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
    $client.Timeout = [TimeSpan]::FromMinutes(60)
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

function Download-WithRetry {
    param([string]$Url, [string]$Output, [int]$Attempts = 3)
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        if ($script:TelemetryDownloadStarted) { $script:TelemetryDownloadAttempts++ }
        $attemptStopwatch = if ($script:TelemetryDownloadStarted) { [System.Diagnostics.Stopwatch]::StartNew() } else { $null }
        try {
            Download-WithProgress -Url $Url -Output $Output
            if ($attemptStopwatch) {
                $attemptStopwatch.Stop()
                $script:TelemetryDownloadDurationMs += $attemptStopwatch.ElapsedMilliseconds
            }
            return
        } catch {
            if ($attemptStopwatch) {
                $attemptStopwatch.Stop()
                $script:TelemetryDownloadDurationMs += $attemptStopwatch.ElapsedMilliseconds
            }
            if ($attempt -eq $Attempts) { throw }
            Start-Sleep -Milliseconds (500 * $attempt)
        }
    }
}

function Invoke-NativeVersion {
    param([string]$ExePath)
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        return @{
            Output = ((@(& $ExePath --version 2>$null) -join "`n").Trim())
            ExitCode = $LASTEXITCODE
        }
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

function Publish-EnvironmentChange {
    $signature = '[DllImport("user32.dll", CharSet=CharSet.Auto, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'
    $type = Add-Type -MemberDefinition $signature -Name "DevEcoEnvironmentChange_$([guid]::NewGuid().ToString('N'))" -PassThru
    $result = [UIntPtr]::Zero
    [void]$type::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result)
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

function Test-InstallationComplete {
    param([string]$InstallRoot)
    return (Test-Path -LiteralPath (Join-Path $InstallRoot "bin\$AppName.exe") -PathType Leaf)
}

function Move-DirectoryWithRetry {
    param([string]$Source, [string]$Destination, [int]$Attempts = 8)
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            [System.IO.Directory]::Move($Source, $Destination)
            return
        } catch {
            if ($attempt -eq $Attempts) { throw }
            Start-Sleep -Milliseconds ([Math]::Min(250 * $attempt, 1000))
        }
    }
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

# Prefer a same-volume directory move, but tolerate security software briefly
# holding the freshly verified executable open. A copy fallback keeps installs
# working when the directory cannot be renamed at all.
function Publish-StagedInstallation {
    param([string]$StageDir, [string]$VersionDir)
    $versionRollback = $null
    if (Test-Path -LiteralPath $VersionDir) {
        $versionRollback = Join-Path $VersionsDir ".rollback.$(Split-Path $VersionDir -Leaf).$([guid]::NewGuid().ToString('N'))"
        Move-DirectoryWithRetry -Source $VersionDir -Destination $versionRollback
    }

    $moveError = $null
    try {
        Move-DirectoryWithRetry -Source $StageDir -Destination $VersionDir
    } catch {
        $moveError = $_
    }
    if (-not $moveError) {
        if ($versionRollback) { Remove-Item -LiteralPath $versionRollback -Recurse -Force -ErrorAction SilentlyContinue }
        return
    }

    Write-Host "${ansiMuted}The install directory is busy; finishing with a verified copy.${ansiReset}"
    try {
        New-Item -ItemType Directory -Path $VersionDir -Force -ErrorAction Stop | Out-Null
        Get-ChildItem -LiteralPath $StageDir -Force -ErrorAction Stop |
            Copy-Item -Destination $VersionDir -Recurse -Force -ErrorAction Stop
        if (-not (Test-InstallationComplete $VersionDir)) {
            throw "Copied installation is incomplete"
        }
        if ($versionRollback) { Remove-Item -LiteralPath $versionRollback -Recurse -Force -ErrorAction SilentlyContinue }
        return
    } catch {
        $copyError = $_
        Remove-Item -LiteralPath $VersionDir -Recurse -Force -ErrorAction SilentlyContinue
        if ($versionRollback -and (Test-Path -LiteralPath $versionRollback)) {
            try {
                Move-DirectoryWithRetry -Source $versionRollback -Destination $VersionDir
            } catch {
                throw "Could not publish '$StageDir'. Atomic move error: $($moveError.Exception.Message) Copy fallback error: $($copyError.Exception.Message) Rollback also failed: $($_.Exception.Message)"
            }
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
            $probe = Invoke-NativeVersion -ExePath $BinPath
            if ($probe.ExitCode -eq 0) { $launcherVersion = $probe.Output }
        } catch {}
    }

    if ((Test-Path -LiteralPath $versionDir -PathType Container) -and
        (Test-InstallationComplete $versionDir)) {
        $versionBin = Join-Path $versionDir "bin\$AppName.exe"
        $versionedVersion = $null
        try {
            $probe = Invoke-NativeVersion -ExePath $versionBin
            if ($probe.ExitCode -eq 0) { $versionedVersion = $probe.Output }
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
    $dirs = Get-ChildItem -LiteralPath $VersionsDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike '.*' } |
        Sort-Object {
            $parsed = $null
            if ([version]::TryParse(($_.Name -replace '-.*$',''), [ref]$parsed)) { $parsed } else { [version]"9999.0" }
        }
    if (-not $dirs -or $dirs.Count -le $VersionRetentionCount) { return }
    $currentVersion = $null
    if (Test-Path -LiteralPath $BinPath) {
        try {
            $probe = Invoke-NativeVersion -ExePath $BinPath
            if ($probe.ExitCode -eq 0) { $currentVersion = $probe.Output }
        } catch {}
    }
    $toDelete = $dirs | Where-Object { $_.Name -ne $currentVersion } |
        Select-Object -First ($dirs.Count - $VersionRetentionCount)
    foreach ($dir in $toDelete) {
        Remove-Item -LiteralPath $dir.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($Help) {
    Show-Help
    return
}

try { Start-InstallTelemetry } catch {
    $script:TelemetryEnabled = $false
    $script:TelemetryStarted = $false
}

trap {
    try { Complete-InstallTelemetry } catch {}
    break
}

$script:TelemetryStage = "preflight"
if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    $script:TelemetryErrorCode = "unsupported_os"
    throw "This installer supports Windows PowerShell only. On macOS, run the install script from Bash."
}

$nodeWarning = $true
if (Get-Command node -ErrorAction SilentlyContinue) {
    try {
        $probe = Invoke-NativeVersion -ExePath "node"
        $nodeMajor = 0
        if ($probe.ExitCode -eq 0 -and
            [int]::TryParse((($probe.Output -replace '^v', '') -split '\.')[0], [ref]$nodeMajor) -and
            $nodeMajor -ge 22) {
            $nodeWarning = $false
        }
    } catch {}
}

# --- Discover version (skipped when -Binary is provided) ---
$script:TelemetryStage = "version_resolution"
$script:TelemetryErrorCode = "unknown"
$installationState = "download"
$resolvedBinary = $null
if ($Binary) {
    $script:TelemetryStage = "package_validation"
    if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) {
        $script:TelemetryErrorCode = "invalid_argument"
        Write-Host "Please check the path and try again" -ForegroundColor DarkGray
        throw "Binary not found: $Binary"
    }
    $resolvedBinary = (Resolve-Path -LiteralPath $Binary).Path
    try {
        $probe = Invoke-NativeVersion -ExePath $resolvedBinary
        if ($probe.ExitCode -ne 0) { throw "deveco exited with code $($probe.ExitCode)" }
        $tag = $probe.Output
    } catch {
        throw "Cannot read version from local binary: $($_.Exception.Message)"
    }
    if ([string]::IsNullOrWhiteSpace($tag) -or $tag -notmatch '^[0-9A-Za-z][0-9A-Za-z._+-]*$') {
        $script:TelemetryErrorCode = "invalid_version"
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
                $script:TelemetryErrorCode = "release_not_found"
                throw "No release found"
            }
            if ($isPrerelease) {
                $script:TelemetryErrorCode = "release_prerelease"
                throw "Latest GitCode release is marked as prerelease"
            }
            Write-Host "${ansiOrange}Latest version: ${ansiReset}$tag"
        } catch {
            if ($script:TelemetryErrorCode -notin @("release_not_found", "release_prerelease")) {
                $script:TelemetryErrorCode = "release_query_failed"
            }
            Write-Host "Try: npm install -g @deveco/deveco-code" -ForegroundColor DarkGray
            throw "Failed to fetch version info from GitCode: $($_.Exception.Message)"
        }
    } else {
        Write-Host "Using specified version: $tag" -ForegroundColor DarkGray
        # Verify the release exists
        $releaseUrl = "$GitCodeApi/releases/v$tag"
        try {
            $response = Invoke-WebRequest -Uri $releaseUrl -Method Get -UseBasicParsing -ErrorAction Stop
            if ($response.StatusCode -ne 200) { throw "HTTP $($response.StatusCode)" }
        } catch {
            $script:TelemetryErrorCode = "release_not_found"
            Write-Host "Available releases: https://gitcode.com/$Repo/releases" -ForegroundColor DarkGray
            throw "Release v$tag not found: $($_.Exception.Message)"
        }
    }

    if ([string]::IsNullOrWhiteSpace($tag) -or $tag -notmatch '^[0-9A-Za-z][0-9A-Za-z._+-]*$') {
        $script:TelemetryErrorCode = "invalid_version"
        throw "Invalid release version: $tag"
    }

}

# Global try/finally: ensure temp file and staging dir are cleaned up on exception or Ctrl+C
$tempFile = $null
$stageDir = $null
$launcherStage = $null
$installMutex = $null
try {
    $script:TelemetryStage = "preflight"
    $installMutex = Enter-InstallMutex

    # --- Create versioned install directories ---
    if (-not (Test-Path -LiteralPath $VersionsDir)) {
        New-Item -ItemType Directory -Path $VersionsDir -Force -ErrorAction Stop | Out-Null
    }
    if (-not (Test-Path -LiteralPath $BinDir)) {
        New-Item -ItemType Directory -Path $BinDir -Force -ErrorAction Stop | Out-Null
    }
    Get-ChildItem -LiteralPath $VersionsDir -Directory -Force -Filter ".staging.*" -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
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
            Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction Stop
        }
        New-Item -ItemType Directory -Path $stageBinDir -Force -ErrorAction Stop | Out-Null
        $versionBin = Join-Path $stageBinDir "$AppName.exe"
        Copy-Item -LiteralPath $resolvedBinary -Destination $versionBin -Force -ErrorAction Stop

        $sourceRoot = if ((Split-Path (Split-Path $resolvedBinary -Parent) -Leaf) -ieq "bin") {
            Split-Path (Split-Path $resolvedBinary -Parent) -Parent
        } else {
            $null
        }
        if ($sourceRoot) {
            $sourceVendor = Join-Path $sourceRoot "vendor"
            if (Test-Path -LiteralPath $sourceVendor) {
                $vendorDestination = Join-Path $stageDir "vendor"
                if (Test-Path -LiteralPath $vendorDestination) {
                    Remove-Item -LiteralPath $vendorDestination -Recurse -Force -ErrorAction Stop
                }
                Copy-Item -LiteralPath $sourceVendor -Destination $vendorDestination -Recurse -Force -ErrorAction Stop
            }
            $sourceChangelog = Join-Path $sourceRoot "CHANGELOG.md"
            if (Test-Path -LiteralPath $sourceChangelog) {
                Copy-Item -LiteralPath $sourceChangelog -Destination (Join-Path $stageDir "CHANGELOG.md") -Force -ErrorAction Stop
            }
        }

        if (-not (Test-InstallationComplete $stageDir)) {
            $script:TelemetryErrorCode = "binary_missing"
            throw "Local build output is incomplete — deveco.exe is missing"
        }
        $probe = Invoke-NativeVersion -ExePath $versionBin
        $installedVersion = $probe.Output
        if ($probe.ExitCode -ne 0) { $script:TelemetryErrorCode = "binary_missing" }
        if ($installedVersion -ne $tag) { $script:TelemetryErrorCode = "version_mismatch" }
        if ($probe.ExitCode -ne 0) { throw "Installation verification failed — deveco could not run" }
        if ($installedVersion -ne $tag) { throw "Local binary version does not match. Expected $tag, got $installedVersion" }
        $script:TelemetryStage = "activate"
        $script:TelemetryErrorCode = "activation_failed"
        $launcherStage = Join-Path $BinDir ".$AppName.exe.$installID.new"
        Copy-Item -LiteralPath $versionBin -Destination $launcherStage -Force -ErrorAction Stop
        Publish-StagedInstallation -StageDir $stageDir -VersionDir $versionDir
        $versionBin = Join-Path $versionDir "bin\$AppName.exe"
    } elseif ($installationState -eq "download") {
        $script:TelemetryStage = "download"
        $script:TelemetryErrorCode = "download_http_error"
        Write-Host ""
        Write-Host "${ansiMuted}Installing ${ansiReset}deveco ${ansiMuted}version: ${ansiReset}$tag"

        if ($useBaseline) {
            Write-Host "Using baseline variant." -ForegroundColor DarkGray
        } else {
            Write-Host "Using AVX2 variant." -ForegroundColor DarkGray
        }

        # --- Download to temp file ---
        $tempFile = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName() + ".zip")
        if ($script:TelemetryEnabled) {
            $script:TelemetryDownloadStarted = $true
            $script:TelemetryDownloadRounds = 1
        }
        try {
            Download-WithRetry -Url $downloadUrl -Output $tempFile
        } catch {
            $script:TelemetryErrorCode = "download_http_error"
            Add-DownloadFinishedTelemetry -Result "failure" -ErrorCode "download_http_error"
            Write-Host "Try: npm install -g @deveco/deveco-code" -ForegroundColor DarkGray
            throw "Download failed: $($_.Exception.Message)"
        }

        # Verify download is not empty
        if (-not (Test-Path -LiteralPath $tempFile) -or (Get-Item -LiteralPath $tempFile).Length -eq 0) {
            $script:TelemetryErrorCode = "download_empty"
            Add-DownloadFinishedTelemetry -Result "failure" -ErrorCode "download_empty"
            Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
            Write-Host "Try again, or run: npm install -g @deveco/deveco-code" -ForegroundColor DarkGray
            throw "Download failed — file is empty or missing"
        }
        if ($script:TelemetryEnabled) { $script:TelemetryDownloadBytes = (Get-Item -LiteralPath $tempFile).Length }
        $script:TelemetryStage = "extract"
        $script:TelemetryErrorCode = "extract_failed"
        # --- Extract to staging directory ---
        $stageDir = Join-Path $VersionsDir ".staging.$tag.$installID"
        $stageBinDir = Join-Path $stageDir "bin"
        if (Test-Path -LiteralPath $stageDir) {
            Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction Stop
        }
        New-Item -ItemType Directory -Path $stageBinDir -Force -ErrorAction Stop | Out-Null

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
        $freshDownloadFailed = $false
        for ($extractAttempt = 1; $extractAttempt -le 2; $extractAttempt++) {
            if ($extractAttempt -gt 1) {
                Write-Host "${ansiMuted}Archive extraction failed; downloading a fresh copy.${ansiReset}"
                if ($script:TelemetryEnabled) { $script:TelemetryDownloadRounds++ }
                try {
                    Download-WithRetry -Url $downloadUrl -Output $tempFile
                    if ($script:TelemetryEnabled) { $script:TelemetryDownloadBytes = (Get-Item -LiteralPath $tempFile).Length }
                } catch {
                    $freshDownloadFailed = $true
                    $extractionError = $_
                    continue
                }
            }
            if (Test-Path -LiteralPath $stageDir) {
                Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
            }
            New-Item -ItemType Directory -Path $stageBinDir -Force -ErrorAction Stop | Out-Null
            try {
                [System.IO.Compression.ZipFile]::ExtractToDirectory($tempFile, $stageDir)
                $extractionError = $null
                break
            } catch {
                $extractionError = $_
                Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
        if ($extractionError) {
            if ($freshDownloadFailed) {
                $script:TelemetryStage = "download"
                $script:TelemetryErrorCode = "download_http_error"
                Add-DownloadFinishedTelemetry -Result "failure" -ErrorCode "download_http_error"
            } else {
                $script:TelemetryErrorCode = "extract_failed"
                Add-DownloadFinishedTelemetry -Result "success"
            }
            Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
            throw "Extraction failed after a fresh download: $($extractionError.Exception.Message)"
        }
        Add-DownloadFinishedTelemetry -Result "success"

        # --- Find binary and move to staging/bin/ ---
        $binarySrc = Join-Path $stageDir "$AppName.exe"
        if (-not (Test-Path -LiteralPath $binarySrc)) {
            $binarySrc = Join-Path $stageDir $AppName
        }
        if (-not (Test-Path -LiteralPath $binarySrc)) {
            $found = Get-ChildItem -LiteralPath $stageDir -Filter "$AppName.exe" -Recurse -File | Select-Object -First 1
            if (-not $found) {
                $found = Get-ChildItem -LiteralPath $stageDir -Filter $AppName -Recurse -File | Select-Object -First 1
            }
            if ($found) { $binarySrc = $found.FullName }
        }
        if (-not (Test-Path -LiteralPath $binarySrc)) {
            $script:TelemetryStage = "package_validation"
            $script:TelemetryErrorCode = "binary_missing"
            Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
            Write-Host "Try again, or run: npm install -g @deveco/deveco-code" -ForegroundColor DarkGray
            throw "Binary '$AppName' not found in archive"
        }

        # Move binary into staging/bin/ (normalize name to deveco.exe)
        $stageBin = Join-Path $stageBinDir "$AppName.exe"
        if ($binarySrc -ne $stageBin) {
            Move-Item -LiteralPath $binarySrc -Destination $stageBin -Force -ErrorAction Stop
        }

        # Fallback: search for vendor/ and CHANGELOG.md if not at stageDir root
        if (-not (Test-Path -LiteralPath (Join-Path $stageDir "vendor"))) {
            $vendorFound = Get-ChildItem -LiteralPath $stageDir -Directory -Filter "vendor" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($vendorFound) {
                Move-Item -LiteralPath $vendorFound.FullName -Destination (Join-Path $stageDir "vendor") -Force -ErrorAction Stop
            }
        }
        if (-not (Test-Path -LiteralPath (Join-Path $stageDir "CHANGELOG.md"))) {
            $changelog = Get-ChildItem -LiteralPath $stageDir -File -Filter "CHANGELOG.md" -Recurse -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -notmatch '\\bin\\' -and $_.FullName -notmatch '\\vendor\\' } |
                Select-Object -First 1
            if ($changelog) {
                Copy-Item -LiteralPath $changelog.FullName -Destination (Join-Path $stageDir "CHANGELOG.md") -Force -ErrorAction Stop
            }
        }

        if (-not (Test-InstallationComplete $stageDir)) {
            $script:TelemetryStage = "package_validation"
            $script:TelemetryErrorCode = "binary_missing"
            Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
            Write-Host "Try again, or run: npm install -g @deveco/deveco-code" -ForegroundColor DarkGray
            throw "Release archive is incomplete"
        }

        # --- Post-install smoke test ---
        $probe = Invoke-NativeVersion -ExePath $stageBin
        $installedVersion = $probe.Output
        if ($probe.ExitCode -ne 0) {
            $script:TelemetryStage = "package_validation"
            $script:TelemetryErrorCode = "binary_missing"
            Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
            Write-Host "Platform may be incompatible" -ForegroundColor DarkGray
            throw "Installation verification failed — deveco could not run"
        }
        if ($installedVersion -ne $tag) {
            $script:TelemetryStage = "package_validation"
            $script:TelemetryErrorCode = "version_mismatch"
            Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
            throw "Downloaded binary version $installedVersion does not match release v$tag. Try: npm install -g @deveco/deveco-code"
        }

        $script:TelemetryStage = "activate"
        $script:TelemetryErrorCode = "activation_failed"
        $launcherStage = Join-Path $BinDir ".$AppName.exe.$installID.new"
        Copy-Item -LiteralPath $stageBin -Destination $launcherStage -Force -ErrorAction Stop

        # --- Publish staging → version directory ---
        $versionDir = Join-Path $VersionsDir $tag
        Publish-StagedInstallation -StageDir $stageDir -VersionDir $versionDir

        $versionBin = Join-Path $versionDir "bin\$AppName.exe"
    } else {
        $versionDir = Join-Path $VersionsDir $tag
        $versionBin = Join-Path $versionDir "bin\$AppName.exe"
        if ($installationState -eq "repair") {
            $launcherStage = Join-Path $BinDir ".$AppName.exe.$installID.new"
            Copy-Item -LiteralPath $versionBin -Destination $launcherStage -Force -ErrorAction Stop
        }
        if ($installationState -eq "ready") {
            $script:TelemetryResult = "skipped"
            $script:TelemetrySkipReason = "already_installed"
        }
    }

    # --- Switch the pre-verified launcher with ordinary rollback ---
    $script:TelemetryStage = "activate"
    $script:TelemetryErrorCode = "activation_failed"
    if ($installationState -eq "ready" -and -not $Binary) {
        Write-Host "Keeping existing launcher binary" -ForegroundColor DarkGray
    } else {
        $oldName = if (Test-Path -LiteralPath $BinPath) { "$BinPath.old.$installID" } else { $null }
        $newLauncherPlaced = $false
        try {
            $replaced = $false
            if ($oldName) {
                try {
                    [System.IO.File]::Replace($launcherStage, $BinPath, $oldName, $true)
                    $replaced = $true
                } catch {
                    # Some filesystems and executable sharing modes do not support ReplaceFile.
                }
            }
            if (-not $replaced) {
                if ($oldName) {
                    Rename-Item -LiteralPath $BinPath -NewName (Split-Path $oldName -Leaf) -ErrorAction Stop
                }
                Move-Item -LiteralPath $launcherStage -Destination $BinPath -Force -ErrorAction Stop
            }
            $newLauncherPlaced = $true
            $launcherStage = $null
            if ($oldName) { Remove-Item -LiteralPath $oldName -Force -ErrorAction SilentlyContinue }
        } catch {
            $switchError = $_
            if ($newLauncherPlaced -and (Test-Path -LiteralPath $BinPath)) {
                try { Remove-Item -LiteralPath $BinPath -Force -ErrorAction Stop } catch {}
            }
            if ($oldName -and (Test-Path -LiteralPath $oldName)) {
                try {
                    Rename-Item -LiteralPath $oldName -NewName "$AppName.exe" -ErrorAction Stop
                } catch {
                    throw "Launcher activation failed: $($switchError.Exception.Message) Rollback also failed: $($_.Exception.Message) Previous launcher remains at '$oldName'."
                }
            }
            throw "Could not update '$BinPath'. Close running deveco processes and run the installer again. $($switchError.Exception.Message)"
        }
    }

    # --- Clean up stale .old.* files from previous installs ---
    Get-ChildItem -LiteralPath $BinDir -Filter "$AppName.exe.old.*" -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue

    # Keep the same bounded version history as the macOS installer.
    Cleanup-OldVersions

    # --- Add to user PATH (deduplicated, case-insensitive) ---
    $pathModified = $false
    $script:TelemetryStage = "path_update"
    $script:TelemetryErrorCode = "path_update_failed"
    $script:TelemetryPathReached = $true
    $script:TelemetryPathResult = "failure"
    if ($NoModifyPath) {
        $script:TelemetryPathResult = "disabled"
        Write-Host "Skipping PATH modification (-NoModifyPath)" -ForegroundColor DarkGray
    } else {
        $pathEntry = $BinDir
        $environmentKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
        if (-not $environmentKey) { throw "Could not open the user environment registry key" }
        try {
            $currentPath = ""
            $pathKind = [Microsoft.Win32.RegistryValueKind]::ExpandString
            if ($environmentKey.GetValueNames() -contains "Path") {
                $currentPath = [string]$environmentKey.GetValue(
                    "Path",
                    "",
                    [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
                )
                $pathKind = $environmentKey.GetValueKind("Path")
            }
            $pathEntries = $currentPath -split ";" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
            $alreadyInPath = $pathEntries | Where-Object {
                $_ -ieq $pathEntry -or ([Environment]::ExpandEnvironmentVariables($_) -ieq $pathEntry)
            }

            if ($alreadyInPath) {
                $script:TelemetryPathResult = "already_present"
                Write-Host "PATH already contains $pathEntry" -ForegroundColor DarkGray
            } else {
                $newPath = if ($currentPath) { $currentPath.TrimEnd(";") + ";$pathEntry" } else { $pathEntry }
                $environmentKey.SetValue("Path", $newPath, $pathKind)
                $env:Path += ";$pathEntry"
                try { Publish-EnvironmentChange } catch {}
                Write-Host "Added $pathEntry to user PATH" -ForegroundColor Green
                $pathModified = $true
                $script:TelemetryPathResult = "modified"
            }
        } finally {
            $environmentKey.Close()
        }
    }

    # --- Success ---
    if ($script:TelemetryResult -eq "failure") { $script:TelemetryResult = "success" }
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
        if (-not $script:TelemetryWarningCode) { $script:TelemetryWarningCode = "node_version_unsupported" }
        Write-Host 'WARNING:' -ForegroundColor Red
        Write-Host 'Node.js 22 or later is required.' -ForegroundColor Red
        Write-Host 'Without it, some DevEco Code features will not work.' -ForegroundColor Red
        Write-Host 'Install Node.js from https://nodejs.org/ and make sure "node" is available in your PATH.' -ForegroundColor Red
        Write-Host ""
    }
} finally {
    # Global cleanup: ensure temp files are removed on exception or Ctrl+C
    if ($tempFile -and (Test-Path -LiteralPath $tempFile)) { Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue }
    if ($stageDir -and (Test-Path -LiteralPath $stageDir)) { Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue }
    if ($launcherStage -and (Test-Path -LiteralPath $launcherStage)) { Remove-Item -LiteralPath $launcherStage -Force -ErrorAction SilentlyContinue }
    if ($installMutex) {
        try {
            [void]$installMutex.ReleaseMutex()
        } finally {
            $installMutex.Dispose()
        }
    }
    try { Complete-InstallTelemetry } catch {}
}
