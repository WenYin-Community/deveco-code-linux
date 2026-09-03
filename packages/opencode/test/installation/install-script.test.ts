import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const install = path.resolve(import.meta.dir, "../../../..", "install")
const installPs1 = path.resolve(import.meta.dir, "../../../..", "install.ps1")

describe("bash install script", () => {
  test("help exits successfully before install directories are initialized", async () => {
    const proc = Bun.spawn(["bash", install, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      Bun.readableStreamToText(proc.stdout),
      Bun.readableStreamToText(proc.stderr),
      proc.exited,
    ])

    expect(exitCode).toBe(0)
    expect(stdout).toContain("DevEco Code Installer")
    expect(stderr).not.toContain("unbound variable")
  })

  test("local binary install carries adjacent runtime resources atomically", async () => {
    await using tmp = await tmpdir()
    const artifact = path.join(tmp.path, "artifact")
    const binary = path.join(artifact, "bin", "deveco")
    const devecoCli = path.join(
      artifact,
      "vendor",
      "deveco-cli",
      "node_modules",
      "@deveco",
      "deveco-cli",
      "dist",
      "cli.js",
    )
    await fs.mkdir(path.dirname(binary), { recursive: true })
    await fs.mkdir(path.join(artifact, "vendor", "fixture"), { recursive: true })
    await fs.mkdir(path.dirname(devecoCli), { recursive: true })
    await Bun.write(binary, '#!/bin/sh\n[ "$1" = "--version" ] && echo local-test\n')
    await fs.chmod(binary, 0o755)
    await Bun.write(devecoCli, "console.log('deveco-cli')\n")
    await Bun.write(path.join(artifact, "vendor", "fixture", "runtime.txt"), "runtime\n")
    await Bun.write(path.join(artifact, "CHANGELOG.md"), "# Changes\n")

    const proc = Bun.spawn(["bash", install, "--binary", binary, "--no-modify-path"], {
      env: {
        ...process.env,
        DEVECO_TELEMETRY_DISABLED: "1",
        HOME: tmp.path,
        XDG_DATA_HOME: path.join(tmp.path, ".local", "share"),
        SHELL: "/bin/zsh",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stderr, exitCode] = await Promise.all([Bun.readableStreamToText(proc.stderr), proc.exited])
    expect(exitCode, stderr).toBe(0)

    const root = path.join(tmp.path, ".local", "share", "deveco", "versions", "local-test")
    expect(await fs.readFile(path.join(root, "vendor", "fixture", "runtime.txt"), "utf8")).toBe("runtime\n")
    expect(await fs.readFile(path.join(root, "CHANGELOG.md"), "utf8")).toBe("# Changes\n")
    expect(await fs.realpath(path.join(tmp.path, ".local", "bin", "deveco"))).toBe(path.join(root, "bin", "deveco"))
  })

  test("rejects non-macOS hosts before installing", async () => {
    await using tmp = await tmpdir()
    const fakeBin = path.join(tmp.path, "bin")
    const uname = path.join(fakeBin, "uname")
    await fs.mkdir(fakeBin, { recursive: true })
    await Bun.write(uname, "#!/bin/sh\necho Linux\n")
    await fs.chmod(uname, 0o755)

    const proc = Bun.spawn(["bash", install, "--no-modify-path"], {
      env: { ...process.env, HOME: tmp.path, PATH: `${fakeBin}:${process.env.PATH}`, SHELL: "/bin/zsh" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stderr, exitCode] = await Promise.all([Bun.readableStreamToText(proc.stderr), proc.exited])

    expect(exitCode).toBe(1)
    expect(stderr).toContain("This installer supports macOS only")
  })

  test("does not infer runtime resources beside an arbitrary local binary", async () => {
    await using tmp = await tmpdir()
    const artifact = path.join(tmp.path, "artifact")
    const binary = path.join(artifact, "deveco")
    await fs.mkdir(path.dirname(binary), { recursive: true })
    await fs.mkdir(path.join(tmp.path, "vendor"), { recursive: true })
    await Bun.write(binary, '#!/bin/sh\n[ "$1" = "--version" ] && echo local-test\n')
    await Bun.write(path.join(tmp.path, "vendor", "unrelated.txt"), "unrelated\n")
    await Bun.write(path.join(tmp.path, "CHANGELOG.md"), "# Unrelated\n")
    await fs.chmod(binary, 0o755)
    const proc = Bun.spawn(["bash", install, "--binary", binary, "--no-modify-path"], {
      env: {
        ...process.env,
        DEVECO_TELEMETRY_DISABLED: "1",
        HOME: tmp.path,
        XDG_DATA_HOME: path.join(tmp.path, ".local", "share"),
        SHELL: "/bin/zsh",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stderr, exitCode] = await Promise.all([Bun.readableStreamToText(proc.stderr), proc.exited])

    expect(exitCode, stderr).toBe(0)
    expect(await fs.realpath(path.join(tmp.path, ".local", "bin", "deveco"))).toBe(
      path.join(tmp.path, ".local", "share", "deveco", "versions", "local-test", "bin", "deveco"),
    )
    const root = path.join(tmp.path, ".local", "share", "deveco", "versions", "local-test")
    expect(await fs.stat(path.join(root, "vendor")).then(() => true, () => false)).toBe(false)
    expect(await fs.stat(path.join(root, "CHANGELOG.md")).then(() => true, () => false)).toBe(false)
  })

  test("installs successfully and warns when Node.js is older than the deveco-cli requirement", async () => {
    await using tmp = await tmpdir()
    const fakeBin = path.join(tmp.path, "bin")
    const node = path.join(fakeBin, "node")
    const artifact = path.join(tmp.path, "artifact")
    const binary = path.join(artifact, "bin", "deveco")
    const devecoCli = path.join(
      artifact,
      "vendor",
      "deveco-cli",
      "node_modules",
      "@deveco",
      "deveco-cli",
      "dist",
      "cli.js",
    )
    await fs.mkdir(fakeBin, { recursive: true })
    await fs.mkdir(path.dirname(binary), { recursive: true })
    await fs.mkdir(path.dirname(devecoCli), { recursive: true })
    await Bun.write(node, "#!/bin/sh\necho v16.20.0\n")
    await fs.chmod(node, 0o755)
    await Bun.write(binary, '#!/bin/sh\n[ "$1" = "--version" ] && echo local-test\n')
    await fs.chmod(binary, 0o755)
    await Bun.write(devecoCli, "console.log('deveco-cli')\n")
    await Bun.write(path.join(artifact, "CHANGELOG.md"), "# Changes\n")

    const proc = Bun.spawn(["bash", install, "--binary", binary, "--no-modify-path"], {
      env: {
        ...process.env,
        DEVECO_TELEMETRY_DISABLED: "1",
        HOME: tmp.path,
        XDG_DATA_HOME: path.join(tmp.path, ".local", "share"),
        PATH: `${fakeBin}:${process.env.PATH}`,
        SHELL: "/bin/zsh",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, exitCode] = await Promise.all([Bun.readableStreamToText(proc.stdout), proc.exited])

    expect(exitCode).toBe(0)
    expect(stdout).toContain("Node.js 22 or later is required.")
    expect(stdout).toContain("Without it, some DevEco Code features will not work.")
    expect(stdout).toContain(
      'Install Node.js from https://nodejs.org/ and make sure "node" is available in your PATH.',
    )
  })
})

describe("PowerShell install script", () => {
  test("omits the UTF-8 BOM so irm iex can parse the parameter block", async () => {
    const script = await fs.readFile(installPs1)

    expect(Array.from(script.subarray(0, 3))).not.toEqual([0xef, 0xbb, 0xbf])
  })

  test("does not emit the successful HTTP response before download progress", async () => {
    const script = await fs.readFile(installPs1, "utf8")

    expect(script).toContain("[void]$response.EnsureSuccessStatusCode()")
    expect(script).not.toContain('Write-Error "')
  })

  test("loads HttpClient support before downloading on Windows PowerShell 5.1", async () => {
    const script = await fs.readFile(installPs1, "utf8")

    expect(script).toContain("Add-Type -AssemblyName System.Net.Http -ErrorAction Stop")
    expect(script.indexOf("Add-Type -AssemblyName System.Net.Http -ErrorAction Stop")).toBeLessThan(
      script.indexOf("[System.Net.Http.HttpClient]::new()"),
    )
  })

  test("extracts archives without progress UI on PowerShell 5 and 7", async () => {
    const script = await fs.readFile(installPs1, "utf8")

    expect(script).not.toContain("Expand-Archive -LiteralPath")
    expect(script).toContain('$PSVersionTable.PSVersion.Major -ge 6')
    expect(script).toContain('"System.IO.Compression.ZipFile"')
    expect(script).toContain('"System.IO.Compression.FileSystem"')
    expect(script).toContain("Add-Type -AssemblyName $compressionAssembly -ErrorAction Stop")
    expect(script).toContain("[System.IO.Compression.ZipFile]::ExtractToDirectory($tempFile, $stageDir)")
    expect(script.match(/Download-WithRetry -Url \$downloadUrl -Output \$tempFile/g)).toHaveLength(2)
  })

  test("serializes installation before inspecting or mutating shared paths", async () => {
    const script = await fs.readFile(installPs1, "utf8")
    const critical = script.slice(script.indexOf("$installMutex = Enter-InstallMutex"))

    expect(script).toContain("[System.Threading.Mutex]::new")
    expect(script).toContain('"Global\\DevEcoCodeInstaller-')
    expect(critical.indexOf("$installMutex = Enter-InstallMutex")).toBeLessThan(
      critical.indexOf("$installationState = Get-InstallationState -TargetVersion $tag"),
    )
    expect(script).toContain("[void]$installMutex.ReleaseMutex()")
  })

  test("stages the launcher before publishing the version directory", async () => {
    const script = await fs.readFile(installPs1, "utf8")
    const downloadInstall = script.slice(
      script.indexOf('} elseif ($installationState -eq "download") {'),
      script.indexOf("# --- Switch the pre-verified launcher with ordinary rollback ---"),
    )

    expect(
      downloadInstall.indexOf("Copy-Item -LiteralPath $stageBin -Destination $launcherStage"),
    ).toBeGreaterThan(-1)
    expect(
      downloadInstall.indexOf("Copy-Item -LiteralPath $stageBin -Destination $launcherStage"),
    ).toBeLessThan(
      downloadInstall.indexOf("Publish-StagedInstallation -StageDir $stageDir"),
    )
    expect(script).toContain("Move-Item -LiteralPath $launcherStage -Destination $BinPath")
    expect(script).not.toContain("Copy-Item -Path $versionBin -Destination $BinPath")
  })

  test("retries busy version directories and falls back to a verified copy", async () => {
    const script = await fs.readFile(installPs1, "utf8")

    expect(script).toContain("function Publish-StagedInstallation")
    expect(script).toContain("function Move-DirectoryWithRetry")
    expect(script).toContain("[int]$Attempts = 8")
    expect(script).toContain("Move-DirectoryWithRetry -Source $StageDir -Destination $VersionDir")
    expect(script).toContain("Move-DirectoryWithRetry -Source $versionRollback -Destination $VersionDir")
    expect(script).toContain("Get-ChildItem -LiteralPath $StageDir -Force -ErrorAction Stop")
    expect(script).toContain("Copy-Item -Destination $VersionDir -Recurse -Force -ErrorAction Stop")
    expect(script).toContain("if (-not (Test-InstallationComplete $VersionDir))")
    expect(script).toContain("Atomic move error: $($moveError.Exception.Message)")
    expect(script).toContain("Copy fallback error: $($copyError.Exception.Message)")
    expect(script).toContain('-Filter ".staging.*"')
    expect(script).toContain('return "repair"')
    expect(script).not.toContain("function Invoke-FileOperation")
    expect(script).not.toContain("function Test-InstallationCompleteWithRetry")
    expect(script).not.toContain("Get-FileHash")
    expect(script).not.toContain("SHA-256")
    expect(script).toContain('(Split-Path $resolvedBinary -Parent) -Leaf) -ieq "bin"')
  })

  test("bounds download and publish retries and uses ordinary launcher rollback", async () => {
    const script = await fs.readFile(installPs1, "utf8")

    expect(script).toContain("function Download-WithRetry")
    expect(script).toContain("[int]$Attempts = 3")
    expect(script).toContain("[System.IO.File]::Replace")
    expect(script).toContain("Close running deveco processes and run the installer again")
    expect(script).not.toContain("InstallTransaction")
    expect(script).not.toContain("Start-PendingLauncherActivation")
    expect(script).not.toContain("activation-pending")
    expect(script).not.toContain(`Remove existing version directory '$VersionDir'`)
  })

  test("probes native versions safely under the installer error policy", async () => {
    const script = await fs.readFile(installPs1, "utf8")

    expect(script).toContain("function Invoke-NativeVersion")
    expect(script).toContain('$ErrorActionPreference = "Continue"')
    expect(script).toContain("ExitCode = $LASTEXITCODE")
    expect(script.match(/--version 2>\$null/g)).toHaveLength(1)
  })

  test("preserves expandable user PATH entries when adding the launcher", async () => {
    const script = await fs.readFile(installPs1, "utf8")

    expect(script).toContain("DoNotExpandEnvironmentNames")
    expect(script).toContain('$environmentKey.SetValue("Path", $newPath, $pathKind)')
    expect(script).toContain("Publish-EnvironmentChange")
    expect(script).not.toContain('[Environment]::SetEnvironmentVariable("Path"')
  })

  test("keeps compatibility fallbacks small and non-fatal", async () => {
    const script = await fs.readFile(installPs1, "utf8")

    expect(script).toContain("[TimeSpan]::FromMinutes(60)")
    expect(script).toContain("try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}")
    expect(script).toContain("[version]::TryParse")
  })

  test("accepts legacy version directories and matches macOS retention", async () => {
    const script = await fs.readFile(installPs1, "utf8")

    expect(script).not.toContain(".deveco-install.json")
    expect(script).toContain("function Test-InstallationComplete")
    expect(script).not.toContain("Get-DevecoCliEntry")
    expect(script).not.toContain("bundled @deveco/deveco-cli runtime or CHANGELOG.md")
    expect(script).not.toContain("$_.Name -match '^\\d'")
    expect(script).toContain("$VersionRetentionCount = 2")
  })

  test("keeps the logo and avoids duplicate spacing before getting started", async () => {
    const script = await fs.readFile(installPs1, "utf8")

    expect(script).toContain('Write-Host "▃▃▃▃  ▃▃▃▃')
    expect(script).not.toContain(
      'Write-Host ""\n    Write-Host ""\n    Write-Host "${ansiMuted}Get started:${ansiReset}"',
    )
  })

  const powerShell = process.platform === "win32" ? (Bun.which("pwsh") ?? Bun.which("powershell.exe")) : undefined

  test.skipIf(!powerShell)("installs and replaces a local binary on Windows", async () => {
    await using tmp = await tmpdir()
    const artifact = path.join(tmp.path, "artifact")
    const binary = path.join(artifact, "bin", "deveco.exe")
    const cli = path.join(artifact, "vendor", "deveco-cli", "dist", "cli.js")
    const data = path.join(tmp.path, "data")
    const profile = path.join(tmp.path, "profile")
    const env = { ...process.env, DEVECO_TELEMETRY_DISABLED: "1", USERPROFILE: profile, XDG_DATA_HOME: data }
    await fs.mkdir(path.dirname(binary), { recursive: true })
    await fs.mkdir(path.dirname(cli), { recursive: true })
    await fs.copyFile(process.execPath, binary)
    await Bun.write(cli, "console.log('deveco-cli')\n")
    await Bun.write(path.join(artifact, "CHANGELOG.md"), "# Changes\n")

    const run = () =>
      Bun.spawn(
        [
          powerShell!,
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          installPs1,
          "-Binary",
          binary,
          "-NoModifyPath",
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      )
    const installOnce = async () => {
      const proc = run()
      const [stdout, stderr, exit] = await Promise.all([
        Bun.readableStreamToText(proc.stdout),
        Bun.readableStreamToText(proc.stderr),
        proc.exited,
      ])
      expect(exit, `${stdout}\n${stderr}`).toBe(0)
    }
    await installOnce()

    const launcher = path.join(profile, ".local", "bin", "deveco.exe")
    await fs.appendFile(binary, "overwrite-test")
    const expectedHash = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(binary).arrayBuffer())
      .digest("hex")
      .toUpperCase()
    await installOnce()
    expect(
      new Bun.CryptoHasher("sha256")
        .update(await Bun.file(launcher).arrayBuffer())
        .digest("hex")
      .toUpperCase(),
    ).toBe(expectedHash)
    expect(await fs.stat(launcher).then((item) => item.isFile())).toBe(true)
    expect(await fs.stat(path.join(data, "deveco", "versions", Bun.version, "CHANGELOG.md"))).toBeDefined()
  })
})
