import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import {
  __resetDevecoCliShellEnvCache,
  __setTestDevecoCliEntry,
  buildDevecoCliShellEnv,
  ensureDevecoCliShim,
  isolatedShellPath,
  resolveBundledDevecoCliEntry,
  resolveDevecoCodeProxyLauncher,
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
  test("resolveDevecoCodeProxyLauncher() invokes a compiled executable directly", () => {
    expect(resolveDevecoCodeProxyLauncher("/$bunfs/root/src/index.js", "/app/deveco")).toEqual(["/app/deveco"])
  })

  test("resolveDevecoCodeProxyLauncher() invokes a compiled Windows executable directly", () => {
    expect(
      resolveDevecoCodeProxyLauncher(
        "B:/~BUN/root/src/cli/tui/worker.js",
        "C:\\app\\deveco.exe",
      ),
    ).toEqual(["C:\\app\\deveco.exe"])
  })

  test("resolveDevecoCodeProxyLauncher() prefers the cwd-independent proxy entry in source runs", async () => {
    await using tmp = await tmpdir()
    // TUI 的工具在 Worker 线程里执行，那里 Bun.main 是 worker 脚本：它不处理 __devecocli-proxy，
    // 一旦被写进 shim，所有 devecocli 调用都会挂死且不写事件——所以绝不能选它。
    const worker = path.join(tmp.path, "src", "cli", "tui", "worker.ts")
    const proxyEntry = path.join(tmp.path, "src", "deveco-cli", "proxy.ts")
    await fs.mkdir(path.dirname(worker), { recursive: true })
    await fs.mkdir(path.dirname(proxyEntry), { recursive: true })
    await Bun.write(worker, "console.log('worker')\n")
    await Bun.write(proxyEntry, "console.log('proxy')\n")

    const launcher = resolveDevecoCodeProxyLauncher(worker, "/bin/bun", proxyEntry)
    expect(launcher).toEqual(["/bin/bun", "run", "--conditions=browser", proxyEntry])
    expect(launcher).not.toContain(worker)
  })

  test("resolveDevecoCodeProxyLauncher() falls back to the caller entry when the proxy entry is missing", async () => {
    await using tmp = await tmpdir()
    const main = path.join(tmp.path, "src", "index.ts")
    await fs.mkdir(path.dirname(main), { recursive: true })
    await Bun.write(main, "console.log('ok')\n")

    expect(
      resolveDevecoCodeProxyLauncher(main, "/bin/bun", path.join(tmp.path, "missing", "proxy.ts")),
    ).toEqual(["/bin/bun", "run", "--conditions=browser", main])
  })

  test("resolveDevecoCodeProxyLauncher() points the shim at the committed slim proxy entry", async () => {
    // 默认参数：main = Bun.main（本测试文件，存在），proxyEntry = 仓库里的 src/deveco-cli/proxy.ts。
    // 若那个文件被删除或漏提交，launcher 会静默退化到 main（Worker 线程下 = 原 bug），
    // 所以这里断言瘦入口确实是仓库里存在的那一个。
    const launcher = resolveDevecoCodeProxyLauncher(undefined, "/bin/bun", undefined)
    const entry = launcher.at(-1)!
    expect(entry.endsWith(path.join("deveco-cli", "proxy.ts"))).toBe(true)
    expect(await Bun.file(entry).exists()).toBe(true)
  })

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

  test("resolveVendoredDevecoCliEntry() honours bin.devecocli for the platform-split shell package", async () => {
    await using tmp = await tmpdir()
    const installRoot = path.join(tmp.path, "install")
    const cliRoot = path.join(installRoot, "vendor", "deveco-cli", "node_modules", "@deveco", "deveco-cli")
    const cli = path.join(cliRoot, "cli.js")
    await fs.mkdir(cliRoot, { recursive: true })
    await Bun.write(cli, "console.log('shell')\n")
    await Bun.write(path.join(cliRoot, "package.json"), JSON.stringify({ bin: { devecocli: "cli.js" } }))

    expect(resolveVendoredDevecoCliEntry(installRoot)).toBe(path.resolve(cli))
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
          "@deveco/deveco-cli": "1.3.4",
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
    expect(await Bun.file(path.join(mainRoot, "bin", process.platform === "win32" ? "deveco.exe" : "deveco")).exists()).toBe(true)
  })

  test("published postinstall resolves a nested platform-split CLI shell package", async () => {
    await using tmp = await tmpdir()
    const platform = process.platform === "win32" ? "windows" : process.platform
    const platformPackage = `deveco-code-${platform}-${process.arch}`
    const modules = path.join(tmp.path, "node_modules")
    const mainRoot = path.join(modules, "@deveco", "deveco-code")
    const cliRoot = path.join(mainRoot, "node_modules", "@deveco", "deveco-cli")
    const platformRoot = path.join(modules, "@deveco", platformPackage)
    const sourceBinary = path.join(platformRoot, "bin", process.platform === "win32" ? "deveco.exe" : "deveco")
    // The shell package forwards to a platform implementation package, so its entry sits at the root.
    const cliEntry = path.join(cliRoot, "cli.js")

    await fs.mkdir(path.dirname(sourceBinary), { recursive: true })
    await fs.mkdir(cliRoot, { recursive: true })
    await fs.mkdir(mainRoot, { recursive: true })
    await fs.copyFile(process.execPath, sourceBinary)
    if (process.platform !== "win32") await fs.chmod(sourceBinary, 0o755)
    await Bun.write(cliEntry, "console.log('test local')\n")
    await Bun.write(
      path.join(cliRoot, "package.json"),
      JSON.stringify({ name: "@deveco/deveco-cli", bin: { devecocli: "cli.js" } }),
    )
    await fs.copyFile(path.join(import.meta.dir, "../../../script/postinstall.mjs"), path.join(mainRoot, "postinstall.mjs"))
    await Bun.write(
      path.join(mainRoot, "package.json"),
      JSON.stringify({
        name: "@deveco/deveco-code",
        dependencies: {
          "@deveco/deveco-cli": "1.3.4",
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
      const shim = await Bun.file(path.join(binDir, "devecocli.cmd")).text()
      expect(shim).toContain("__devecocli-proxy -- %*")
      // .cmd 里也必须写入与 cwd 无关的瘦入口（源码态），否则 Windows 上同样会挂死。
      expect(shim).toContain("proxy.ts")
    } else {
      const shim = await Bun.file(path.join(binDir, "devecocli")).text()
      expect(shim).toContain('__devecocli-proxy -- "$@"')
      expect(shim).toContain("proxy.ts")
    }

    __resetDevecoCliShellEnvCache()
    const env = await buildDevecoCliShellEnv()
    expect(env?.PATH.startsWith(`${binDir}${process.platform === "win32" ? ";" : ":"}`)).toBe(true)
    expect(env?.PATH).toContain("/usr/bin")
    expect(env?.DEVECO_CLI_AUTH_SOURCE).toBe("deveco-code")
    expect(env?.DEVECO_CODE_AUTH_DIR).toBe(Global.Path.config)
    expect(env?.DEVECO_CLI_DISABLE_UPDATE).toBe("all")
  })

  test.skipIf(process.platform === "win32")(
    "buildDevecoCliShellEnv() passes the command line tools root to the CLI",
    async () => {
      await using tmp = await tmpdir()
      const binDir = path.join(tmp.path, "bin")
      const cli = path.join(tmp.path, "dist", "cli.js")
      await fs.mkdir(path.dirname(cli), { recursive: true })
      await Bun.write(cli, "console.log('1.2.3')\n")

      const clt = path.join(tmp.path, "clt")
      await fs.mkdir(path.join(clt, "tool", "node", "bin"), { recursive: true })
      await Bun.write(path.join(clt, "tool", "node", "bin", "node"), "")

      Global.Path.bin = binDir
      const previousState = Global.Path.state
      Global.Path.state = path.join(tmp.path, "state")
      __setTestDevecoCliEntry(cli)
      const previous = process.env.DEVECO_HOME
      process.env.DEVECO_HOME = clt
      try {
        __resetDevecoCliShellEnvCache()
        const env = await buildDevecoCliShellEnv()
        expect(env?.DEVECO_CLI_CLT_PATH).toBe(clt)
        if (process.platform === "linux" && env?.LD_LIBRARY_PATH) {
          expect(env.LD_LIBRARY_PATH).toContain(path.join(Global.Path.state, "clt-libs"))
        }
      } finally {
        if (previous === undefined) delete process.env.DEVECO_HOME
        else process.env.DEVECO_HOME = previous
        Global.Path.state = previousState
        __resetDevecoCliShellEnvCache()
      }
    },
  )

  // 回归：shim 必须能从「非包目录」的 cwd 跑通并写出 CLI 事件。
  // 这条用例同时能抓住两类回归——shim 指向 worker.ts 会挂死（原 bug），
  // 或指向依赖 cwd 下 tsconfig 的入口（如 src/index.ts）会加载失败。
  // 注意：shim 在**子进程**里解析内置 CLI 入口，进程内的 __setTestDevecoCliEntry 覆盖不会被
  // 继承，所以这里跑的是仓库自带的 @deveco/deveco-cli。断言只锁定我们自己的契约（事件形态 +
  // 不再挂死），不依赖那个 CLI 的具体输出或退出码。
  test.skipIf(process.platform === "win32")(
    "ensureDevecoCliShim() shim runs devecocli from an unrelated cwd and records a CLI event",
    async () => {
      await using tmp = await tmpdir()
      const binDir = path.join(tmp.path, "bin")
      expect(await ensureDevecoCliShim(binDir)).toBe(binDir)
      const events = path.join(tmp.path, "events.jsonl")
      const proc = Bun.spawn({
        cmd: [path.join(binDir, "devecocli"), "docs", "search", "@State"],
        cwd: tmp.path,
        env: { ...process.env, DEVECO_CODE_CLI_EVENT_FILE: events },
        stdout: "pipe",
        stderr: "pipe",
      })
      // 守卫只为兜底：真挂死时杀掉进程，让下面的事件断言失败，而不是拖住 CI 两分钟。
      const guard = setTimeout(() => proc.kill(9), 20_000)
      const exitCode = await proc.exited
      clearTimeout(guard)

      const lines = (await Bun.file(events).text().catch(() => "")).split(/\r?\n/).filter(Boolean)
      expect(lines, `shim exited with ${exitCode} but wrote no CLI event`).toHaveLength(1)
      expect(JSON.parse(lines[0]!)).toMatchObject({ command: "docs", subcommand: "search" })
    },
    30_000,
  )

  test.skipIf(process.platform === "win32")(
    "ensureDevecoCliShim() shim records no CLI event for usage tokens",
    async () => {
      await using tmp = await tmpdir()
      const binDir = path.join(tmp.path, "bin")
      expect(await ensureDevecoCliShim(binDir)).toBe(binDir)
      const events = path.join(tmp.path, "events.jsonl")
      const proc = Bun.spawn({
        cmd: [path.join(binDir, "devecocli"), "--version"],
        cwd: tmp.path,
        env: { ...process.env, DEVECO_CODE_CLI_EVENT_FILE: events },
        stdout: "pipe",
        stderr: "pipe",
      })
      const guard = setTimeout(() => proc.kill(9), 20_000)
      const exitCode = await proc.exited
      clearTimeout(guard)

      // 挂死被守卫 SIGKILL（137）时同样"没有事件文件"，只断言文件不存在会假通过，
      // 所以必须同时断言正常退出。`--version` 是纯 flag，真 CLI 必定 exit 0。
      expect(exitCode).toBe(0)
      expect(await Bun.file(events).exists()).toBe(false)
    },
    30_000,
  )

  test("runBundledDevecoCli() invokes the bundled entry instead of global devecocli", async () => {
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

  test("runBundledDevecoCli() propagates the bundled entry exit code", async () => {
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
