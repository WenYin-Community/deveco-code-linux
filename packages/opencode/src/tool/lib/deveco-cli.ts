import fs from "fs/promises"
import fsSync from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { Global } from "@opencode-ai/core/global"
import { resolveInstallRoot } from "@opencode-ai/core/installation/vendor-path"
import { findDevEcoHome, isCltLayout } from "./env"

const PACKAGE_NAME = "@deveco/deveco-cli"
const INSTALL_ENTRY_MARKER = ".deveco-cli-entry"
const VENDOR_CLI_DIRNAME = "deveco-cli"
const PATH_MARKER = ".deveco-cli-path"
const SHIM_NAME = "devecocli"

export type DevecoCliShellEnv = {
  PATH: string
  Path?: string
  DEVECO_CLI_AUTH_SOURCE: "deveco-code"
  DEVECO_CODE_AUTH_DIR: string
  /** Bundled CLI must not self-update or show upgrade banners. */
  DEVECO_CLI_DISABLE_UPDATE: "all"
  /** Command Line Tools root; the CLI does not discover it from PATH. */
  DEVECO_CLI_CLT_PATH?: string
  /** Extra library dir for CLT binaries that need libbz2.so.1.0. */
  LD_LIBRARY_PATH?: string
}

function pathSep() {
  return process.platform === "win32" ? ";" : ":"
}

function exists(file: string) {
  return fsSync.existsSync(file)
}

/**
 * The CLI entry moved between layouts: bundled builds ship `dist/cli.js`, while the
 * platform-split shell package declares `bin.devecocli` at the package root.
 */
function resolveDevecoCliEntryInPackage(packageRoot: string): string | undefined {
  const manifestPath = path.join(packageRoot, "package.json")
  const bin = exists(manifestPath) ? JSON.parse(fsSync.readFileSync(manifestPath, "utf8")).bin : undefined
  const declared = typeof bin === "string" ? bin : bin?.[SHIM_NAME]
  const candidates = [
    declared ? path.join(packageRoot, declared) : undefined,
    path.join(packageRoot, "dist", "cli.js"),
  ].filter((candidate): candidate is string => candidate !== undefined)
  const entry = candidates.find(exists)
  return entry ? path.resolve(entry) : undefined
}

export function resolveVendoredDevecoCliEntry(installRoot: string): string | undefined {
  const vendorRoot = path.join(installRoot, "vendor", VENDOR_CLI_DIRNAME)
  const nested = [path.join(vendorRoot, "node_modules", ...PACKAGE_NAME.split("/")), vendorRoot]
  for (const candidate of nested) {
    const entry = resolveDevecoCliEntryInPackage(candidate)
    if (entry) return entry
  }
  return undefined
}

export function resolveInstalledDevecoCliEntry(installRoot: string): string | undefined {
  // npm installs: prefer absolute marker written by postinstall (stable, unchanged).
  const marker = path.join(installRoot, "vendor", INSTALL_ENTRY_MARKER)
  try {
    const entry = fsSync.readFileSync(marker, "utf8").trim()
    if (path.isAbsolute(entry) && exists(entry)) return path.resolve(entry)
  } catch {
    // fall through to vendor layout (curl/irm)
  }

  // curl/irm (and platform packages that ship vendor/deveco-cli): convention path.
  return resolveVendoredDevecoCliEntry(installRoot)
}

export function resolveInstalledDevecoCliEntryFromExecutable(executable: string): string | undefined {
  let resolved = path.resolve(executable)
  try {
    resolved = fsSync.realpathSync(resolved)
  } catch {
    // Keep the original path when execPath cannot be resolved.
  }
  return resolveInstalledDevecoCliEntry(path.resolve(path.dirname(resolved), ".."))
}

export function resolveLocalBuildDevecoCliEntry(executable: string): string | undefined {
  const packageRoot = path.resolve(path.dirname(executable), "..", "..", "..")
  return resolveDevecoCliEntryInPackage(path.join(packageRoot, "node_modules", ...PACKAGE_NAME.split("/")))
}

let testEntryOverride: string | undefined

export function __setTestDevecoCliEntry(entry: string | undefined) {
  testEntryOverride = entry
}

export function resolveBundledDevecoCliEntry(): string | undefined {
  if (testEntryOverride && exists(testEntryOverride)) return path.resolve(testEntryOverride)

  const installed = resolveInstalledDevecoCliEntry(resolveInstallRoot())
  if (installed) return installed

  const localBuild = resolveLocalBuildDevecoCliEntry(process.execPath)
  if (localBuild) return localBuild

  // Development only: resolve the declared local dependency from this checkout.
  let current = path.dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const entry = resolveDevecoCliEntryInPackage(path.join(current, "node_modules", ...PACKAGE_NAME.split("/")))
    if (entry) return entry
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  return undefined
}

function normalizePathKey(dir: string) {
  const resolved = path.resolve(dir)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

export function isolatedShellPath(current: string | undefined, shimDir: string) {
  const sep = pathSep()
  const shimKey = normalizePathKey(shimDir)
  // Prepending the local shim is enough to shadow a global devecocli.
  // Keep the remaining directories because one may also provide node itself.
  const filtered: string[] = [shimDir]
  const seen = new Set<string>([shimKey])

  for (const part of (current ?? "").split(sep).filter(Boolean)) {
    const key = normalizePathKey(part)
    if (seen.has(key)) continue
    seen.add(key)
    filtered.push(part)
  }

  return filtered.join(sep)
}

function unixArg(input: string) {
  return "'" + input.replaceAll("'", "'\"'\"'") + "'"
}

function windowsArg(input: string) {
  return `"${input.replaceAll('"', '""')}"`
}

// 开发态下 shim 应重入的入口：一个只加载 devecocli 代理的瘦入口。
// 不能用 Bun.main：TUI 的工具在 Worker 线程里执行，那里 Bun.main 是 cli/tui/worker.ts，
// 它不处理 __devecocli-proxy（会把 worker 起起来并挂死），于是所有 devecocli 调用都不写事件。
// 也不能用 src/index.ts：它会拉入 TUI 的 .tsx，依赖 cwd 下的 tsconfig，换目录即加载失败。
const PROXY_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../deveco-cli/proxy.ts")

export function resolveDevecoCodeProxyLauncher(
  main = Bun.main,
  executable = process.execPath,
  proxyEntry = PROXY_ENTRY,
) {
  // 编译产物：入口嵌在 /$bunfs（Windows 为 ~BUN/root），直接重入自身。
  // 放在最前是防御性的：bunfs 里并不存在 .ts 源文件，后面的判断本会得出同一个结果，
  // 但显式短路更清楚，也不依赖 fs 在虚拟文件系统上的行为。
  if (main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/i.test(main)) return [executable]
  // 开发态：优先用与 cwd 无关的瘦入口（见 src/deveco-cli/proxy.ts）。
  if (exists(proxyEntry) && /\.[cm]?[jt]s$/i.test(proxyEntry)) {
    return [executable, "run", "--conditions=browser", proxyEntry]
  }
  // 兜底：瘦入口缺失时沿用调用方进程的入口（例如非编译的 bun build 产物形态）。
  if (exists(main) && /\.[cm]?[jt]s$/i.test(main)) {
    return [executable, "run", "--conditions=browser", main]
  }
  return [executable]
}

function unixShimContents(launcher: readonly string[]) {
  return `#!/usr/bin/env sh
exec ${launcher.map(unixArg).join(" ")} __devecocli-proxy -- "$@"
`
}

function windowsShimContents(launcher: readonly string[]) {
  return `@ECHO OFF\r\nSETLOCAL\r\n${launcher.map(windowsArg).join(" ")} __devecocli-proxy -- %*\r\nENDLOCAL & exit /b %ERRORLEVEL%\r\n`
}

async function shimNeedsUpdate(binDir: string, entry: string, launcher: readonly string[]) {
  const marker = path.join(binDir, PATH_MARKER)
  try {
    const current = (await fs.readFile(marker, "utf8")).trim()
    if (current !== entry) return true
  } catch {
    return true
  }

  const shimPath = path.join(binDir, process.platform === "win32" ? `${SHIM_NAME}.cmd` : SHIM_NAME)
  const expected = process.platform === "win32" ? windowsShimContents(launcher) : unixShimContents(launcher)
  try {
    const current = await fs.readFile(shimPath, "utf8")
    return current !== expected
  } catch {
    return true
  }
}

export async function ensureDevecoCliShim(binDir = Global.Path.bin): Promise<string | undefined> {
  const entry = resolveBundledDevecoCliEntry()
  if (!entry) return undefined
  const launcher = resolveDevecoCodeProxyLauncher()

  await fs.mkdir(binDir, { recursive: true })

  if (!(await shimNeedsUpdate(binDir, entry, launcher))) {
    return binDir
  }

  await fs.writeFile(path.join(binDir, PATH_MARKER), `${entry}\n`, "utf8")

  if (process.platform === "win32") {
    await fs.writeFile(path.join(binDir, `${SHIM_NAME}.cmd`), windowsShimContents(launcher), "utf8")
  } else {
    const shimPath = path.join(binDir, SHIM_NAME)
    await fs.writeFile(shimPath, unixShimContents(launcher), "utf8")
    await fs.chmod(shimPath, 0o755)
  }

  return binDir
}

export async function buildDevecoCliShellEnv(): Promise<DevecoCliShellEnv | null> {
  const prepared = await prepareBundledDevecoCli()
  return prepared?.env ?? null
}

let shellEnvReady: Promise<DevecoCliShellEnv | null> | undefined

export function ensureDevecoCliShellEnv() {
  shellEnvReady ??= buildDevecoCliShellEnv()
  return shellEnvReady
}

export function __resetDevecoCliShellEnvCache() {
  shellEnvReady = undefined
}

function devecoCliShimPath(shimDir: string) {
  return path.join(shimDir, process.platform === "win32" ? `${SHIM_NAME}.cmd` : SHIM_NAME)
}

// Fedora/RHEL ship libbz2.so.1 while the bundled Emulator links against
// libbz2.so.1.0. Provide a compat symlink instead of modifying the CLT install.
function cltLibraryPath() {
  if (process.platform !== "linux") return undefined
  const source = [
    "/lib64/libbz2.so.1.0.8",
    "/usr/lib64/libbz2.so.1.0.8",
    "/lib64/libbz2.so.1",
    "/usr/lib64/libbz2.so.1",
  ].find(exists)
  if (!source) return undefined
  const dir = path.join(Global.Path.state, "clt-libs")
  fsSync.mkdirSync(dir, { recursive: true })
  const link = path.join(dir, "libbz2.so.1.0")
  if (!exists(link)) {
    try {
      fsSync.symlinkSync(source, link)
    } catch {
      return undefined
    }
  }
  return dir
}

async function applyCltEnv(env: DevecoCliShellEnv): Promise<DevecoCliShellEnv> {
  const home = await findDevEcoHome()
  if (!home || !isCltLayout(home)) return env
  env.DEVECO_CLI_CLT_PATH = home
  const libDir = cltLibraryPath()
  if (libDir) {
    env.LD_LIBRARY_PATH = [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(pathSep())
  }
  return env
}

async function prepareBundledDevecoCli(): Promise<{ cli: string; env: DevecoCliShellEnv } | null> {
  const shimDir = await ensureDevecoCliShim()
  const entry = resolveBundledDevecoCliEntry()
  if (!shimDir || !entry) return null

  const pathValue = isolatedShellPath(process.env.PATH || process.env.Path, shimDir)
  const env = await applyCltEnv({
    PATH: pathValue,
    DEVECO_CLI_AUTH_SOURCE: "deveco-code",
    DEVECO_CODE_AUTH_DIR: Global.Path.config,
    DEVECO_CLI_DISABLE_UPDATE: "all",
  })
  if (process.platform === "win32") {
    env.Path = pathValue
  }

  return { cli: devecoCliShimPath(shimDir), env }
}

async function devecoCliEnv(): Promise<DevecoCliShellEnv> {
  const pathValue = process.env.PATH || process.env.Path || ""
  const env = await applyCltEnv({
    PATH: pathValue,
    DEVECO_CLI_AUTH_SOURCE: "deveco-code",
    DEVECO_CODE_AUTH_DIR: Global.Path.config,
    DEVECO_CLI_DISABLE_UPDATE: "all",
  })
  if (process.platform === "win32") env.Path = pathValue
  return env
}

export async function runBundledDevecoCli(
  args: string[],
  cwd: string,
  options: { skipVersionCheck?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const entry = resolveBundledDevecoCliEntry()
  if (!entry) {
    throw new Error("Local deveco-cli dependency is not available. Reinstall deveco-code.")
  }

  const proc = Bun.spawn({
    cmd: ["node", entry, ...args],
    cwd,
    env: {
      ...process.env,
      ...(await devecoCliEnv()),
      ...(options.skipVersionCheck ? { DEVECO_CLI_SKIP_VERSION_CHECK: "1" } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout ? Bun.readableStreamToText(proc.stdout) : Promise.resolve(""),
    proc.stderr ? Bun.readableStreamToText(proc.stderr) : Promise.resolve(""),
    proc.exited,
  ])

  return { stdout, stderr, exitCode }
}
