import fs from "fs/promises"
import fsSync from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { Global } from "@opencode-ai/core/global"
import { resolveInstallRoot } from "@opencode-ai/core/installation/vendor-path"

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
}

function pathSep() {
  return process.platform === "win32" ? ";" : ":"
}

function exists(file: string) {
  return fsSync.existsSync(file)
}

export function resolveVendoredDevecoCliEntry(installRoot: string): string | undefined {
  const vendorRoot = path.join(installRoot, "vendor", VENDOR_CLI_DIRNAME)
  const nested = [
    path.join(vendorRoot, "node_modules", "@deveco", "deveco-cli", "dist", "cli.js"),
    path.join(vendorRoot, "node_modules", "@deveco-test", "deveco-cli", "dist", "cli.js"),
    path.join(vendorRoot, "dist", "cli.js"),
  ]
  for (const candidate of nested) {
    if (exists(candidate)) return path.resolve(candidate)
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
  const entry = path.join(packageRoot, "node_modules", ...PACKAGE_NAME.split("/"), "dist", "cli.js")
  return exists(entry) ? path.resolve(entry) : undefined
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
    const entry = path.join(current, "node_modules", ...PACKAGE_NAME.split("/"), "dist", "cli.js")
    if (exists(entry)) return path.resolve(entry)
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
  return `'${input.replaceAll("'", `'"'"'`)}'`
}

function windowsArg(input: string) {
  return `"${input.replaceAll('"', '""')}"`
}

export function resolveDevecoCodeProxyLauncher(main = Bun.main, executable = process.execPath) {
  // Bun exposes an embedded entry under /$bunfs in compiled binaries; the executable must re-enter itself directly.
  if (main.startsWith("/$bunfs/")) return [executable]
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

async function prepareBundledDevecoCli(): Promise<{ cli: string; env: DevecoCliShellEnv } | null> {
  const shimDir = await ensureDevecoCliShim()
  const entry = resolveBundledDevecoCliEntry()
  if (!shimDir || !entry) return null

  const pathValue = isolatedShellPath(process.env.PATH || process.env.Path, shimDir)
  const env: DevecoCliShellEnv = {
    PATH: pathValue,
    DEVECO_CLI_AUTH_SOURCE: "deveco-code",
    DEVECO_CODE_AUTH_DIR: Global.Path.config,
    DEVECO_CLI_DISABLE_UPDATE: "all",
  }
  if (process.platform === "win32") {
    env.Path = pathValue
  }

  return { cli: devecoCliShimPath(shimDir), env }
}

function devecoCliEnv(): DevecoCliShellEnv {
  const pathValue = process.env.PATH || process.env.Path || ""
  const env: DevecoCliShellEnv = {
    PATH: pathValue,
    DEVECO_CLI_AUTH_SOURCE: "deveco-code",
    DEVECO_CODE_AUTH_DIR: Global.Path.config,
  }
  if (process.platform === "win32") env.Path = pathValue
  return env
}

export function buildDevecoCliBuildArgs(input: {
  clean?: boolean
  product?: string
  modules?: readonly string[]
  build_mode?: string
}): string[] {
  if (input.clean) return ["build", "clean"]

  const args = ["build"]
  const product = input.product?.trim()
  const buildMode = input.build_mode?.trim()
  const modules = (input.modules ?? []).map((item) => item.trim()).filter(Boolean)

  if (product) args.push("--product", product)
  if (modules.length > 0) args.push("--modules", ...modules)
  if (buildMode) args.push("--build-mode", buildMode)
  return args
}

export function buildDevecoCliRunArgs(input: {
  device: string
  ability?: string
  module?: string
  target?: string
}): string[] {
  const args = ["run", "--skip-build", "--device", input.device.trim()]
  const module = input.module?.trim()
  const target = input.target?.trim()
  const ability = input.ability?.trim()

  if (module || target) {
    args.push("--module", target ? `${module || "entry"}@${target}` : module!)
  }
  if (ability) args.push("--ability", ability)
  return args
}

export function buildDevecoCliStartAppCommands(input: {
  hvd?: string | null
  ability?: string | null
  module?: string | null
  target?: string | null
}): string[][] {
  const device = input.hvd?.trim()
  if (!device) {
    return [
      ["device", "list"],
      ["emulator", "list"],
    ]
  }

  return [["device", "list"]]
}

export function devecoCliListContainsTarget(output: string, target: string): boolean {
  const normalizedTarget = target.trim()
  if (!normalizedTarget) return false
  return output
    .split(/\r?\n/)
    .some((line) => line.includes(normalizedTarget))
}

export function buildDevecoCliLogArgs(input: {
  device?: string
  keyword?: string
  tail?: number
}): string[] {
  const args = ["log"]
  const device = input.device?.trim()
  const keyword = input.keyword?.trim()

  if (device) args.push("--device", device)
  if (keyword) args.push("--keyword", keyword)
  if (input.tail !== undefined) args.push("--tail", String(input.tail))
  return args
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
      ...devecoCliEnv(),
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
