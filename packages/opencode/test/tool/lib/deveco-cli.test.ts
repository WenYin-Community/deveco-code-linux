import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import {
  __resetDevecoCliShellEnvCache,
  __setTestDevecoCliEntry,
  buildDevecoCliBuildArgs,
  buildDevecoCliLogArgs,
  buildDevecoCliRunArgs,
  buildDevecoCliStartAppCommands,
  buildDevecoCliShellEnv,
  devecoCliListContainsTarget,
  ensureDevecoCliShim,
  isolatedShellPath,
  resolveBundledDevecoCliEntry,
  resolveInstalledDevecoCliEntry,
  resolveInstalledDevecoCliEntryFromExecutable,
  resolveLocalBuildDevecoCliEntry,
  resolveVendoredDevecoCliEntry,
  runBundledDevecoCli,
} from "../../../src/tool/lib/deveco-cli"
import { tmpdir } from "../../fixture/fixture"

const originalBin = Global.Path.bin
const originalData = Global.Path.data
const originalPath = process.env.PATH

afterEach(async () => {
  Global.Path.bin = originalBin
  Global.Path.data = originalData
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  __setTestDevecoCliEntry(undefined)
  __resetDevecoCliShellEnvCache()
})

describe("deveco-cli runtime", () => {
  test("resolveBundledDevecoCliEntry() uses test entry override", async () => {
    await using tmp = await tmpdir()
    const cli = path.join(tmp.path, "dist", "cli.js")
    await fs.mkdir(path.dirname(cli), { recursive: true })
    await Bun.write(cli, "console.log('ok')\n")

    __setTestDevecoCliEntry(cli)
    expect(resolveBundledDevecoCliEntry()).toBe(path.resolve(cli))
  })

  test("resolveBundledDevecoCliEntry() uses the shared versioned resource root", async () => {
    await using tmp = await tmpdir()
    const cli = path.join(
      tmp.path,
      "versions",
      "local",
      "vendor",
      "deveco-cli",
      "node_modules",
      "@deveco",
      "deveco-cli",
      "dist",
      "cli.js",
    )
    await fs.mkdir(path.dirname(cli), { recursive: true })
    await Bun.write(cli, "console.log('versioned')\n")
    Global.Path.data = tmp.path

    expect(resolveBundledDevecoCliEntry()).toBe(path.resolve(cli))
  })

  test("resolveInstalledDevecoCliEntry() only accepts an absolute local marker", async () => {
    await using tmp = await tmpdir()
    const installRoot = path.join(tmp.path, "install")
    const marker = path.join(installRoot, "vendor", ".deveco-cli-entry")
    const cli = path.join(installRoot, "node_modules", "@deveco", "deveco-cli", "dist", "cli.js")
    await fs.mkdir(path.dirname(marker), { recursive: true })
    await fs.mkdir(path.dirname(cli), { recursive: true })
    await Bun.write(cli, "console.log('local')\n")

    await Bun.write(marker, `${cli}\n`)
    expect(resolveInstalledDevecoCliEntry(installRoot)).toBe(path.resolve(cli))

    await Bun.write(marker, "devecocli\n")
    expect(resolveInstalledDevecoCliEntry(installRoot)).toBeUndefined()
  })

  test("resolveInstalledDevecoCliEntry() falls back to vendor/deveco-cli for curl/irm layout", async () => {
    await using tmp = await tmpdir()
    const installRoot = path.join(tmp.path, "install")
    const cli = path.join(installRoot, "vendor", "deveco-cli", "node_modules", "@deveco", "deveco-cli", "dist", "cli.js")
    await fs.mkdir(path.dirname(cli), { recursive: true })
    await Bun.write(cli, "console.log('vendored')\n")

    expect(resolveVendoredDevecoCliEntry(installRoot)).toBe(path.resolve(cli))
    expect(resolveInstalledDevecoCliEntry(installRoot)).toBe(path.resolve(cli))
  })

  test("resolveInstalledDevecoCliEntry() prefers absolute marker over vendor layout", async () => {
    await using tmp = await tmpdir()
    const installRoot = path.join(tmp.path, "install")
    const markerCli = path.join(installRoot, "node_modules", "@deveco", "deveco-cli", "dist", "cli.js")
    const vendorCli = path.join(
      installRoot,
      "vendor",
      "deveco-cli",
      "node_modules",
      "@deveco",
      "deveco-cli",
      "dist",
      "cli.js",
    )
    const marker = path.join(installRoot, "vendor", ".deveco-cli-entry")
    await fs.mkdir(path.dirname(markerCli), { recursive: true })
    await fs.mkdir(path.dirname(vendorCli), { recursive: true })
    await fs.mkdir(path.dirname(marker), { recursive: true })
    await Bun.write(markerCli, "console.log('marker')\n")
    await Bun.write(vendorCli, "console.log('vendor')\n")
    await Bun.write(marker, `${markerCli}\n`)

    expect(resolveInstalledDevecoCliEntry(installRoot)).toBe(path.resolve(markerCli))
  })

  test("resolveInstalledDevecoCliEntry() never searches PATH for a global CLI", async () => {
    await using tmp = await tmpdir()
    const globalDir = path.join(tmp.path, "global")
    await fs.mkdir(globalDir, { recursive: true })
    await Bun.write(path.join(globalDir, process.platform === "win32" ? "devecocli.cmd" : "devecocli"), "")
    process.env.PATH = globalDir

    expect(resolveInstalledDevecoCliEntry(path.join(tmp.path, "install"))).toBeUndefined()
  })

  test("resolveLocalBuildDevecoCliEntry() finds the package-local dependency", async () => {
    await using tmp = await tmpdir()
    const packageRoot = path.join(tmp.path, "packages", "opencode")
    const executable = path.join(packageRoot, "dist", "deveco-windows-x64", "bin", "deveco.exe")
    const cli = path.join(packageRoot, "node_modules", "@deveco", "deveco-cli", "dist", "cli.js")
    await fs.mkdir(path.dirname(executable), { recursive: true })
    await fs.mkdir(path.dirname(cli), { recursive: true })
    await Bun.write(executable, "")
    await Bun.write(cli, "console.log('local build')\n")

    expect(resolveLocalBuildDevecoCliEntry(executable)).toBe(path.resolve(cli))
  })

  test("resolveInstalledDevecoCliEntryFromExecutable() resolves an npm executable symlink", async () => {
    await using tmp = await tmpdir()
    const installRoot = path.join(tmp.path, "lib", "node_modules", "@deveco", "deveco-code")
    const realBin = path.join(installRoot, "bin", "deveco.exe")
    const cli = path.join(installRoot, "node_modules", "@deveco", "deveco-cli", "dist", "cli.js")
    const marker = path.join(installRoot, "vendor", ".deveco-cli-entry")

    await fs.mkdir(path.dirname(realBin), { recursive: true })
    await fs.mkdir(path.dirname(cli), { recursive: true })
    await fs.mkdir(path.dirname(marker), { recursive: true })
    await Bun.write(realBin, "")
    await Bun.write(cli, "console.log('nested')\n")
    await Bun.write(marker, `${cli}\n`)

    expect(resolveInstalledDevecoCliEntryFromExecutable(realBin)).toBe(path.resolve(cli))
    if (process.platform !== "win32") {
      const linkBin = path.join(tmp.path, "bin", "deveco")
      await fs.mkdir(path.dirname(linkBin), { recursive: true })
      await fs.symlink(realBin, linkBin)
      expect(resolveInstalledDevecoCliEntryFromExecutable(linkBin)).toBe(path.resolve(cli))
    }
  })

  test("published postinstall records the installed local dependency", async () => {
    await using tmp = await tmpdir()
    const platform = process.platform === "win32" ? "windows" : process.platform
    const platformPackage = `deveco-code-${platform}-${process.arch}`
    const modules = path.join(tmp.path, "node_modules", "@deveco")
    const mainRoot = path.join(modules, "deveco-code")
    const cliRoot = path.join(modules, "deveco-cli")
    const platformRoot = path.join(modules, platformPackage)
    const sourceBinary = path.join(platformRoot, "bin", process.platform === "win32" ? "deveco.exe" : "deveco")
    const cliEntry = path.join(cliRoot, "dist", "cli.js")

    await fs.mkdir(path.dirname(sourceBinary), { recursive: true })
    await fs.mkdir(path.dirname(cliEntry), { recursive: true })
    await fs.mkdir(mainRoot, { recursive: true })
    await fs.copyFile(process.execPath, sourceBinary)
    if (process.platform !== "win32") await fs.chmod(sourceBinary, 0o755)
    await Bun.write(cliEntry, "console.log('local')\n")
    await Bun.write(path.join(cliRoot, "package.json"), JSON.stringify({ name: "@deveco/deveco-cli" }))
    await fs.copyFile(path.join(import.meta.dir, "../../../script/postinstall.mjs"), path.join(mainRoot, "postinstall.mjs"))
    await Bun.write(
      path.join(mainRoot, "package.json"),
      JSON.stringify({
        name: "@deveco/deveco-code",
        dependencies: {
          "@deveco/deveco-cli": "1.0.0",
        },
        optionalDependencies: {
          [`@deveco/${platformPackage}`]: "1.0.0",
        },
      }),
    )
    await Bun.write(
      path.join(platformRoot, "package.json"),
      JSON.stringify({ name: `@deveco/${platformPackage}`, version: "1.0.0" }),
    )

    const proc = Bun.spawn({
      cmd: [process.execPath, path.join(mainRoot, "postinstall.mjs")],
      cwd: mainRoot,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stderr] = await Promise.all([proc.exited, Bun.readableStreamToText(proc.stderr)])
    expect(exitCode, stderr).toBe(0)

    const marker = await fs.readFile(path.join(mainRoot, "vendor", ".deveco-cli-entry"), "utf8")
    expect(marker.trim()).toBe(cliEntry)
    const platformMarker = await fs.readFile(path.join(platformRoot, "vendor", ".deveco-cli-entry"), "utf8")
    expect(platformMarker.trim()).toBe(cliEntry)
    expect(await Bun.file(path.join(mainRoot, "bin", "deveco.exe")).exists()).toBe(true)
  })

  test("published postinstall resolves a nested npm-aliased CLI dependency", async () => {
    await using tmp = await tmpdir()
    const platform = process.platform === "win32" ? "windows" : process.platform
    const platformPackage = `deveco-code-${platform}-${process.arch}`
    const modules = path.join(tmp.path, "node_modules")
    const mainRoot = path.join(modules, "@deveco", "deveco-code")
    const cliRoot = path.join(mainRoot, "node_modules", "@deveco", "deveco-cli")
    const platformRoot = path.join(modules, "@deveco", platformPackage)
    const sourceBinary = path.join(platformRoot, "bin", process.platform === "win32" ? "deveco.exe" : "deveco")
    const cliEntry = path.join(cliRoot, "dist", "cli.js")

    await fs.mkdir(path.dirname(sourceBinary), { recursive: true })
    await fs.mkdir(path.dirname(cliEntry), { recursive: true })
    await fs.mkdir(mainRoot, { recursive: true })
    await fs.copyFile(process.execPath, sourceBinary)
    if (process.platform !== "win32") await fs.chmod(sourceBinary, 0o755)
    await Bun.write(cliEntry, "console.log('test local')\n")
    await Bun.write(path.join(cliRoot, "package.json"), JSON.stringify({ name: "@deveco-test/deveco-cli" }))
    await fs.copyFile(path.join(import.meta.dir, "../../../script/postinstall.mjs"), path.join(mainRoot, "postinstall.mjs"))
    await Bun.write(
      path.join(mainRoot, "package.json"),
      JSON.stringify({
        name: "@deveco/deveco-code",
        dependencies: {
          "@deveco/deveco-cli": "npm:@deveco-test/deveco-cli@1.0.0",
        },
        optionalDependencies: {
          [`@deveco/${platformPackage}`]: "1.0.0",
        },
      }),
    )
    await Bun.write(
      path.join(platformRoot, "package.json"),
      JSON.stringify({ name: `@deveco/${platformPackage}`, version: "1.0.0" }),
    )

    const proc = Bun.spawn({
      cmd: [process.execPath, path.join(mainRoot, "postinstall.mjs")],
      cwd: mainRoot,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stderr] = await Promise.all([proc.exited, Bun.readableStreamToText(proc.stderr)])
    expect(exitCode, stderr).toBe(0)

    const marker = await fs.readFile(path.join(mainRoot, "vendor", ".deveco-cli-entry"), "utf8")
    expect(marker.trim()).toBe(cliEntry)
    const platformMarker = await fs.readFile(path.join(platformRoot, "vendor", ".deveco-cli-entry"), "utf8")
    expect(platformMarker.trim()).toBe(cliEntry)
  })

  test("ensureDevecoCliShim() writes shim and buildDevecoCliShellEnv() prepends PATH", async () => {
    await using tmp = await tmpdir()
    const binDir = path.join(tmp.path, "bin")
    const cli = path.join(tmp.path, "dist", "cli.js")
    await fs.mkdir(path.dirname(cli), { recursive: true })
    await Bun.write(cli, "console.log('1.2.3')\n")

    Global.Path.bin = binDir
    __setTestDevecoCliEntry(cli)
    process.env.PATH = "/usr/bin"

    const shimDir = await ensureDevecoCliShim(binDir)
    expect(shimDir).toBe(binDir)

    const marker = await fs.readFile(path.join(binDir, ".deveco-cli-path"), "utf8")
    expect(marker.trim()).toBe(path.resolve(cli))

    if (process.platform === "win32") {
      expect(await Bun.file(path.join(binDir, "devecocli.cmd")).exists()).toBe(true)
    } else {
      expect(await Bun.file(path.join(binDir, "devecocli")).exists()).toBe(true)
    }

    __resetDevecoCliShellEnvCache()
    const env = await buildDevecoCliShellEnv()
    expect(env?.PATH.startsWith(`${binDir}${process.platform === "win32" ? ";" : ":"}`)).toBe(true)
    expect(env?.PATH).toContain("/usr/bin")
    expect(env?.DEVECO_CLI_AUTH_SOURCE).toBe("deveco-code")
    expect(env?.DEVECO_CODE_AUTH_DIR).toBe(Global.Path.config)
    expect(env?.DEVECO_CLI_DISABLE_UPDATE).toBe("all")
  })

  test("buildDevecoCliBuildArgs() maps skill-aligned build options", () => {
    expect(buildDevecoCliBuildArgs({})).toEqual(["build"])
    expect(buildDevecoCliBuildArgs({ clean: true })).toEqual(["build", "clean"])
    expect(buildDevecoCliBuildArgs({ modules: ["entry", "library@phone"] })).toEqual([
      "build",
      "--modules",
      "entry",
      "library@phone",
    ])
    expect(buildDevecoCliBuildArgs({ product: "oversea", build_mode: "release" })).toEqual([
      "build",
      "--product",
      "oversea",
      "--build-mode",
      "release",
    ])
  })

  test("buildDevecoCliRunArgs() maps start_app options and always skips build", () => {
    expect(buildDevecoCliRunArgs({ device: " 127.0.0.1:5555 " })).toEqual([
      "run",
      "--skip-build",
      "--device",
      "127.0.0.1:5555",
    ])
    expect(
      buildDevecoCliRunArgs({
        device: "Phone",
        module: "entry",
        target: "default",
        ability: "EntryAbility",
      }),
    ).toEqual([
      "run",
      "--skip-build",
      "--device",
      "Phone",
      "--module",
      "entry@default",
      "--ability",
      "EntryAbility",
    ])
    expect(buildDevecoCliRunArgs({ device: "Phone", target: "tablet" })).toContain("entry@tablet")
  })

  test("buildDevecoCliStartAppCommands() prepares device discovery", () => {
    expect(buildDevecoCliStartAppCommands({})).toEqual([
      ["device", "list"],
      ["emulator", "list"],
    ])
    expect(buildDevecoCliStartAppCommands({ hvd: "   " })).toEqual([
      ["device", "list"],
      ["emulator", "list"],
    ])
    expect(buildDevecoCliStartAppCommands({ hvd: "Phone", module: "entry" })).toEqual([["device", "list"]])
  })

  test("devecoCliListContainsTarget() detects device and emulator names", () => {
    const output = ["Name                Status", "HarmonyOS Phone     stopped", "127.0.0.1:5555      running"].join("\n")
    expect(devecoCliListContainsTarget(output, "HarmonyOS Phone")).toBe(true)
    expect(devecoCliListContainsTarget(output, "127.0.0.1:5555")).toBe(true)
    expect(devecoCliListContainsTarget(output, "Missing Phone")).toBe(false)
    expect(devecoCliListContainsTarget(output, "   ")).toBe(false)
  })

  test("buildDevecoCliLogArgs() maps hdc_log collection options", () => {
    expect(buildDevecoCliLogArgs({})).toEqual(["log"])
    expect(
      buildDevecoCliLogArgs({
        device: " 127.0.0.1:5555 ",
        keyword: " [DEBUG] ",
        tail: 2000,
      }),
    ).toEqual([
      "log",
      "--device",
      "127.0.0.1:5555",
      "--keyword",
      "[DEBUG]",
      "--tail",
      "2000",
    ])
  })

  test("runBundledDevecoCli() invokes bundled shim instead of global devecocli", async () => {
    await using tmp = await tmpdir()
    const binDir = path.join(tmp.path, "bin")
    const cli = path.join(tmp.path, "dist", "cli.js")
    await fs.mkdir(path.dirname(cli), { recursive: true })
    await Bun.write(
      cli,
      `const args = process.argv.slice(2).join(" ")
console.log("bundled:" + args)
console.log("auth:" + process.env.DEVECO_CLI_AUTH_SOURCE + ":" + process.env.DEVECO_CODE_AUTH_DIR)
console.log("disable-update:" + process.env.DEVECO_CLI_DISABLE_UPDATE)
`,
    )

    Global.Path.bin = binDir
    __setTestDevecoCliEntry(cli)
    __resetDevecoCliShellEnvCache()

    const result = await runBundledDevecoCli(["build", "--product", "default"], tmp.path)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("bundled:build --product default")
    expect(result.stdout).toContain(`auth:deveco-code:${Global.Path.config}`)
    expect(result.stdout).toContain("disable-update:all")
  })

  test("runBundledDevecoCli() propagates non-zero exit code through shim", async () => {
    await using tmp = await tmpdir()
    const binDir = path.join(tmp.path, "bin")
    const cli = path.join(tmp.path, "dist", "cli.js")
    await fs.mkdir(path.dirname(cli), { recursive: true })
    await Bun.write(
      cli,
      `console.error("build failed")
process.exit(1)
`,
    )

    Global.Path.bin = binDir
    __setTestDevecoCliEntry(cli)
    __resetDevecoCliShellEnvCache()

    const result = await runBundledDevecoCli(["build"], tmp.path)
    expect(result.exitCode).toBe(1)
    expect(result.stderr.trim()).toBe("build failed")
  })

  test("isolatedShellPath() shadows global devecocli without removing its Node directory", async () => {
    await using tmp = await tmpdir()
    const shimDir = path.join(tmp.path, "shim")
    const globalDir = path.join(tmp.path, "global")
    await fs.mkdir(shimDir, { recursive: true })
    await fs.mkdir(globalDir, { recursive: true })
    await Bun.write(path.join(shimDir, process.platform === "win32" ? "devecocli.cmd" : "devecocli"), "")
    await Bun.write(path.join(globalDir, process.platform === "win32" ? "devecocli.cmd" : "devecocli"), "")
    await Bun.write(path.join(globalDir, process.platform === "win32" ? "node.exe" : "node"), "")

    const sep = process.platform === "win32" ? ";" : ":"
    const other = path.join(tmp.path, "other")
    const isolated = isolatedShellPath(`${globalDir}${sep}${other}`, shimDir)

    expect(isolated.startsWith(`${shimDir}${sep}`)).toBe(true)
    expect(isolated).toContain(other)
    expect(isolated).toContain(globalDir)
  })
})
