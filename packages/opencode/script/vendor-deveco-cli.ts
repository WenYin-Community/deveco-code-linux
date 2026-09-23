#!/usr/bin/env bun
/**
 * Per-target vendor of @deveco/deveco-cli for curl/irm zip artifacts.
 * Installs with bun --os/--cpu matching the build target (not the host),
 * caches under .build-cache/deveco-cli/<os>-<cpu>/, then copies into dist vendor/.
 */
import { $ } from "bun"
import fs from "fs"
import path from "path"

export const DEVECO_CLI_VENDOR_DIRNAME = "deveco-cli"

const PACKAGE_NAMES = ["@deveco/deveco-cli", "@deveco-test/deveco-cli"] as const
const PACKAGE_JSON_NAME = "@deveco/deveco-cli"

/** Known platform-specific packages some cli versions pull in (install only for current target). */
const DEVECO_CLI_RIPGREP_BY_TARGET = [
  { name: "@vscode/ripgrep-darwin-arm64", os: "darwin", cpu: "arm64" },
  { name: "@vscode/ripgrep-darwin-x64", os: "darwin", cpu: "x64" },
  { name: "@vscode/ripgrep-win32-x64", os: "win32", cpu: "x64" },
] as const

export type DevecoCliVendorTarget = {
  os: "darwin" | "linux" | "win32"
  arch: "arm64" | "x64"
}

function registryArgs(): string[] {
  const registry = (process.env.NPM_REGISTRY ?? "").trim()
  return registry ? [`--registry=${registry.replace(/\/$/, "")}`] : []
}

export function resolveDevecoCliEntry(packageRoot: string): string {
  return path.join(packageRoot, "dist", "cli.js")
}

export function resolveVendoredDevecoCliEntry(vendorRoot: string): string | undefined {
  for (const name of PACKAGE_NAMES) {
    const candidate = path.join(vendorRoot, "node_modules", ...name.split("/"), "dist", "cli.js")
    if (fs.existsSync(candidate)) return candidate
  }
  const direct = resolveDevecoCliEntry(vendorRoot)
  if (fs.existsSync(direct)) return direct
  return undefined
}

export function findVendoredDevecoCliEntry(installRoot: string): string | undefined {
  const vendorRoot = path.join(installRoot, "vendor", DEVECO_CLI_VENDOR_DIRNAME)
  const entry = resolveVendoredDevecoCliEntry(vendorRoot)
  return entry ? path.resolve(entry) : undefined
}

async function readPackageVersion(packageRoot: string): Promise<string> {
  const pkg = JSON.parse(await fs.promises.readFile(path.join(packageRoot, "package.json"), "utf8")) as {
    version?: string
  }
  return pkg.version ?? "unknown"
}

function packageRootInVendor(vendorRoot: string): string | undefined {
  for (const name of PACKAGE_NAMES) {
    const candidate = path.join(vendorRoot, "node_modules", ...name.split("/"))
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate
  }
  if (fs.existsSync(path.join(vendorRoot, "package.json")) && fs.existsSync(resolveDevecoCliEntry(vendorRoot))) {
    return vendorRoot
  }
  return undefined
}

function dirSizeBytes(root: string): number {
  let total = 0
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        total += fs.statSync(full).size
      } catch {
        // ignore
      }
    }
  }
  return total
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function targetRipgrepSpec(target: DevecoCliVendorTarget) {
  return DEVECO_CLI_RIPGREP_BY_TARGET.find((item) => item.os === target.os && item.cpu === target.arch)
}

function hasPackage(vendorRoot: string, name: string) {
  return fs.existsSync(path.join(vendorRoot, "node_modules", ...name.split("/"), "package.json"))
}

async function readOptionalDependencyNames(cliPackageRoot: string): Promise<string[]> {
  const pkg = JSON.parse(await fs.promises.readFile(path.join(cliPackageRoot, "package.json"), "utf8")) as {
    optionalDependencies?: Record<string, string>
  }
  return Object.keys(pkg.optionalDependencies ?? {})
}

function readInstalledRipgrepVersion(vendorRoot: string): string | undefined {
  const candidates = [
    path.join(vendorRoot, "node_modules", "@vscode", "ripgrep", "package.json"),
    ...PACKAGE_NAMES.map((name) =>
      path.join(vendorRoot, "node_modules", ...name.split("/"), "node_modules", "@vscode", "ripgrep", "package.json"),
    ),
  ]
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as { version?: string }
    if (pkg.version) return pkg.version
  }
  return undefined
}

async function ensureTargetRipgrep(vendorRoot: string, target: DevecoCliVendorTarget) {
  const spec = targetRipgrepSpec(target)
  if (!spec) return
  if (hasPackage(vendorRoot, spec.name)) return

  // Only install when the tree already references ripgrep somehow (legacy cli layouts).
  const rgVersion = readInstalledRipgrepVersion(vendorRoot)
  if (!rgVersion && !(await optionalDepsMentionRipgrep(vendorRoot))) return

  const version = rgVersion ?? "1.18.0"
  console.log(`  Installing ${spec.name}@${version} for ${target.os}-${target.arch}...`)
  await $`bun add --production --os=${spec.os} --cpu=${spec.cpu} ${registryArgs()} ${`${spec.name}@${version}`}`.cwd(
    vendorRoot,
  )
  if (!hasPackage(vendorRoot, spec.name)) {
    throw new Error(`Failed to install platform package ${spec.name} for ${target.os}-${target.arch}`)
  }
}

async function optionalDepsMentionRipgrep(vendorRoot: string) {
  const root = packageRootInVendor(vendorRoot)
  if (!root) return false
  const names = await readOptionalDependencyNames(root)
  return names.some((name) => name.includes("ripgrep"))
}

async function writeVendorPackageJson(destRoot: string, version: string) {
  await fs.promises.writeFile(
    path.join(destRoot, "package.json"),
    JSON.stringify(
      {
        name: "deveco-cli-vendor",
        private: true,
        dependencies: {
          [PACKAGE_JSON_NAME]: version,
        },
      },
      null,
      2,
    ),
  )
}

async function installDevecoCliVendor(destRoot: string, version: string, target: DevecoCliVendorTarget) {
  await fs.promises.rm(destRoot, { recursive: true, force: true })
  await fs.promises.mkdir(destRoot, { recursive: true })
  await writeVendorPackageJson(destRoot, version)

  console.log(`  bun install --production --os=${target.os} --cpu=${target.arch} @deveco/deveco-cli@${version}`)
  await $`bun install --production --os=${target.os} --cpu=${target.arch} ${registryArgs()}`.cwd(destRoot)

  const entry = resolveVendoredDevecoCliEntry(destRoot)
  if (!entry) {
    throw new Error(`deveco-cli entry not found after install for ${target.os}-${target.arch}`)
  }

  const cliRoot = packageRootInVendor(destRoot)
  if (!cliRoot) {
    throw new Error(`deveco-cli package root missing after install for ${target.os}-${target.arch}`)
  }

  // Ensure optionalDependencies declared for this package that match target naming are present when possible.
  const optionalNames = await readOptionalDependencyNames(cliRoot)
  for (const name of optionalNames) {
    if (hasPackage(destRoot, name)) continue
    // Best-effort: try installing with target os/cpu; ignore failures for unrelated optionals.
    try {
      console.log(`  Ensuring optional ${name} for ${target.os}-${target.arch}...`)
      await $`bun add --production --os=${target.os} --cpu=${target.arch} ${registryArgs()} ${name}`.cwd(destRoot)
    } catch (error) {
      console.log(`  optional ${name} skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  await ensureTargetRipgrep(destRoot, target)

  if (!resolveVendoredDevecoCliEntry(destRoot)) {
    throw new Error(`deveco-cli entry missing after platform dependency pass for ${target.os}-${target.arch}`)
  }
}

export async function ensureDevecoCliCached(opts: {
  version: string
  cacheDir: string
  target: DevecoCliVendorTarget
  offline?: boolean
}) {
  const key = `${opts.target.os}-${opts.target.arch}`
  const dest = path.join(opts.cacheDir, DEVECO_CLI_VENDOR_DIRNAME, key)
  const marker = path.join(dest, ".version")
  const entry = resolveVendoredDevecoCliEntry(dest)

  if (fs.existsSync(marker) && entry) {
    const current = (await fs.promises.readFile(marker, "utf8")).trim()
    if (current === opts.version) {
      console.log(`  deveco-cli@${opts.version} already cached for ${key}`)
      return { dest, version: opts.version, bytes: dirSizeBytes(dest) }
    }
  }

  if (opts.offline) {
    throw new Error(
      `Offline vendor cache miss for deveco-cli@${opts.version} (${key}). Run the normal source setup before building the plugin.`,
    )
  }

  console.log(`  Caching deveco-cli@${opts.version} for ${key}...`)
  await installDevecoCliVendor(dest, opts.version, opts.target)
  await fs.promises.writeFile(marker, `${opts.version}\n`, "utf8")
  const bytes = dirSizeBytes(dest)
  console.log(`  Cached deveco-cli@${opts.version} for ${key} (${formatBytes(bytes)})`)
  return { dest, version: opts.version, bytes }
}

export async function bundleDevecoCliVendor(opts: {
  version: string
  cacheDir: string
  vendorDir: string
  target: DevecoCliVendorTarget
  offline?: boolean
}) {
  const cache = await ensureDevecoCliCached({
    version: opts.version,
    cacheDir: opts.cacheDir,
    target: opts.target,
    offline: opts.offline,
  })

  await fs.promises.rm(opts.vendorDir, { recursive: true, force: true })
  await fs.promises.mkdir(path.dirname(opts.vendorDir), { recursive: true })
  await fs.promises.cp(cache.dest, opts.vendorDir, { recursive: true })

  const entry = resolveVendoredDevecoCliEntry(opts.vendorDir)
  if (!entry) {
    throw new Error(`Bundled deveco-cli missing entry at ${opts.vendorDir}`)
  }

  const bytes = dirSizeBytes(opts.vendorDir)
  console.log(
    `  Bundled deveco-cli@${cache.version} for ${opts.target.os}-${opts.target.arch} -> ${opts.vendorDir} (${formatBytes(bytes)})`,
  )
  return { entry, version: cache.version, bytes }
}

export function resolveDevecoCliVersionFromPackageJson(pkg: {
  dependencies?: Record<string, string>
}): string {
  const raw = pkg.dependencies?.[PACKAGE_JSON_NAME]
  if (!raw) {
    throw new Error(`Missing dependency "${PACKAGE_JSON_NAME}" in package.json`)
  }
  // Support "1.2.2" and "npm:@deveco-test/deveco-cli@1.3.0-Test.12"
  const npmAlias = raw.match(/@([^@]+)$/)
  if (raw.startsWith("npm:") && npmAlias) return npmAlias[1]
  return raw
}

export async function readInstalledDevecoCliVersion(packageDir: string): Promise<string | undefined> {
  for (const name of PACKAGE_NAMES) {
    const candidate = path.join(packageDir, "node_modules", ...name.split("/"), "package.json")
    if (!fs.existsSync(candidate)) continue
    return readPackageVersion(path.dirname(candidate))
  }
  return undefined
}
