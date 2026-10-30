/**
 * Generate NOTICE file for the project.
 *
 * Scans all installed packages in node_modules/.bun, matches them against
 * the direct dependencies listed in packages/opencode/package.json, and
 * produces a NOTICE file grouped by license type.
 *
 * Usage:
 *   bun run script/generate-notice.ts          # default: reads from node_modules/.bun
 *   bun run script/generate-notice.ts --output NOTICE
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MONOREPO_ROOT = join(import.meta.dir, "..", "..", "..")
const BUN_MODULES = join(MONOREPO_ROOT, "node_modules", ".bun")
const PACKAGE_JSON = join(import.meta.dir, "..", "package.json")
const OUTPUT = join(MONOREPO_ROOT, "NOTICE")

// Override licenses for packages whose npm metadata is missing or incorrect.
// Key = package name, Value = SPDX license identifier.
const LICENSE_OVERRIDES: Record<string, string> = {
  "@openauthjs/openauth": "MIT", // license not in npm tarball; repo is MIT
  arkanalyzer: "Apache-2.0", // npm license field empty; package LICENSE is Apache-2.0
}

// Workspace-internal packages (workspace:*) — skip these.
const WORKSPACE_SCOPE = ["@opencode-ai/plugin", "@opencode-ai/script", "@opencode-ai/sdk"]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PkgInfo {
  name: string
  version: string
  license: string
  publisher: string
  repository: string
}

function readJSON(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"))
}

/** Normalize license string (case, variants). */
function normalizeLicense(lic: string): string {
  if (lic.toLowerCase() === "apache-2.0") return "Apache-2.0"
  return lic
}

/** Extract publisher name from the "author" field. */
function extractAuthor(author: any): string {
  if (!author) return ""
  if (typeof author === "string") return author
  return author.name || ""
}

/** Extract repository URL from the "repository" field. */
function extractRepo(repo: any): string {
  if (!repo) return ""
  if (typeof repo === "string") return repo
  return repo.url || ""
}

/** Recursively find the package.json that has both name & version. */
function findPkgJson(dir: string): string | null {
  const nm = join(dir, "node_modules")
  if (!existsSync(nm)) return null
  const stack: string[] = [nm]
  while (stack.length) {
    const current = stack.pop()!
    try {
      const entries = readdirSync(current, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          stack.push(join(current, entry.name))
        } else if (entry.name === "package.json") {
          const fullPath = join(current, entry.name)
          try {
            const pkg = readJSON(fullPath)
            if (pkg.name && pkg.version) return fullPath
          } catch {
            // skip malformed
          }
        }
      }
    } catch {
      // permission error etc.
    }
    // don't recurse too deep
    if (current.split("/").length - nm.split("/").length > 5) continue
  }
  return null
}

// ---------------------------------------------------------------------------
// Collect all installed packages
// ---------------------------------------------------------------------------

function collectAllPackages(): Map<string, PkgInfo> {
  const packages = new Map<string, PkgInfo>()

  if (!existsSync(BUN_MODULES)) {
    console.error(`Error: ${BUN_MODULES} not found. Run "bun install" first.`)
    process.exit(1)
  }

  const entries = readdirSync(BUN_MODULES)
  for (const entry of entries) {
    const entryPath = join(BUN_MODULES, entry)
    const pkgJsonPath = findPkgJson(entryPath)
    if (!pkgJsonPath) continue

    try {
      const pkg = readJSON(pkgJsonPath)
      const name: string = pkg.name ?? ""
      const ver: string = pkg.version ?? ""
      if (!name || !ver) continue

      const licRaw: unknown = pkg.license ?? "UNKNOWN"
      let lic: string = "UNKNOWN"
      if (typeof licRaw === "object" && licRaw !== null && "type" in licRaw) lic = (licRaw as { type: string }).type
      else if (Array.isArray(licRaw)) lic = licRaw.join(" AND ")
      else if (typeof licRaw === "string") lic = licRaw

      const key = `${name}@${ver}`
      if (!packages.has(key)) {
        packages.set(key, {
          name,
          version: ver,
          license: normalizeLicense(lic),
          publisher: extractAuthor(pkg.author),
          repository: extractRepo(pkg.repository),
        })
      }
    } catch {
      // skip
    }
  }
  return packages
}

// ---------------------------------------------------------------------------
// Match direct dependencies
// ---------------------------------------------------------------------------

function getDirectDepSpecs(): Record<string, string> {
  const pkg = readJSON(PACKAGE_JSON)
  return (pkg.dependencies ?? {}) as Record<string, string>
}

/** Bare x.y.z or x.y.z-prerelease (no ^/~ range). */
function isExactVersionSpec(spec: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec)
}

/** Numeric semver compare (prerelease < release). Avoids string key bugs like "8.3.0" > "14.0.3". */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/)
    if (!m) return null
    return { major: +m[1]!, minor: +m[2]!, patch: +m[3]!, pre: m[4] ?? null }
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return a.localeCompare(b)
  if (pa.major !== pb.major) return pa.major - pb.major
  if (pa.minor !== pb.minor) return pa.minor - pb.minor
  if (pa.patch !== pb.patch) return pa.patch - pb.patch
  if (pa.pre === null && pb.pre !== null) return 1
  if (pa.pre !== null && pb.pre === null) return -1
  if (pa.pre && pb.pre) return pa.pre.localeCompare(pb.pre)
  return 0
}

/**
 * HomeGraph vendor tree as shipped into platform packages.
 * Source of truth: committed npm lock used by `vendor-homegraph.ts` (not bun node_modules).
 */
function collectHomegraphVendorFromLock(): PkgInfo[] {
  const lockPath = join(import.meta.dir, "homegraph-vendor-package-lock.json")
  if (!existsSync(lockPath)) {
    console.warn(`  Warning: ${lockPath} not found; homegraph vendor deps omitted from NOTICE`)
    return []
  }
  const lock = readJSON(lockPath) as {
    packages?: Record<string, { version?: string; license?: string }>
  }
  const out: PkgInfo[] = []
  const seen = new Set<string>()
  for (const [pathKey, meta] of Object.entries(lock.packages ?? {})) {
    if (!pathKey || !meta?.version) continue
    const name = pathKey.includes("/node_modules/")
      ? pathKey.slice(pathKey.lastIndexOf("/node_modules/") + "/node_modules/".length)
      : pathKey.replace(/^node_modules\//, "")
    if (!name) continue
    const key = `${name}@${meta.version}`
    if (seen.has(key)) continue
    seen.add(key)
    const override = LICENSE_OVERRIDES[name]
    const lic = override ?? meta.license ?? "UNKNOWN"
    out.push({
      name,
      version: meta.version,
      license: normalizeLicense(lic),
      publisher: "",
      repository: "",
    })
  }
  return out
}

function matchDirectDeps(
  allPkgs: Map<string, PkgInfo>,
  specs: Record<string, string>,
): Map<string, PkgInfo> {
  const result = new Map<string, PkgInfo>()

  for (const [depName, spec] of Object.entries(specs)) {
    if (WORKSPACE_SCOPE.includes(depName)) continue

    let best: PkgInfo | null = null
    // Prefer the version declared in package.json when it is an exact pin.
    if (isExactVersionSpec(spec)) {
      for (const info of allPkgs.values()) {
        if (info.name === depName && info.version === spec) {
          best = info
          break
        }
      }
    }
    if (!best) {
      for (const info of allPkgs.values()) {
        if (info.name !== depName) continue
        if (!best || compareVersions(info.version, best.version) > 0) best = info
      }
    }

    if (best) {
      const override = LICENSE_OVERRIDES[depName]
      if (override) best.license = normalizeLicense(override)
      result.set(`${best.name}@${best.version}`, best)
    } else {
      console.warn(`  Warning: ${depName} not found in node_modules`)
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Generate NOTICE content
// ---------------------------------------------------------------------------

function formatPkg(info: PkgInfo): string {
  const pub = info.publisher
  if (pub) {
    return `  - ${info.name} (${info.version}) - Copyright (c) ${pub}`
  }
  return `  - ${info.name} (${info.version})`
}

function generateNotice(deps: Map<string, PkgInfo>): string {
  const lines: string[] = []

  lines.push("NOTICE")
  lines.push("")
  lines.push("DevEco Code")
  lines.push("Copyright (c) 2025-present DevEco Code Contributors")
  lines.push("")
  lines.push("This project is licensed under the MIT License.")
  lines.push("")
  lines.push("===================================================================")
  lines.push("THIRD-PARTY SOFTWARE NOTICES AND INFORMATION")
  lines.push("===================================================================")
  lines.push("")
  lines.push("This project uses third-party software components. The following")
  lines.push("is a list of these components and their license information.")
  lines.push("")

  // Group by license
  const byLicense = new Map<string, PkgInfo[]>()
  for (const info of deps.values()) {
    const lic = info.license
    if (!byLicense.has(lic)) byLicense.set(lic, [])
    byLicense.get(lic)!.push(info)
  }

  // Desired order
  const order = ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC"]
  // Add any remaining license types
  for (const lic of byLicense.keys()) {
    if (!order.includes(lic)) order.push(lic)
  }

  const fullLicenseNames: Record<string, string> = {
    MIT: "MIT License",
    "Apache-2.0": "Apache License 2.0",
    "BSD-3-Clause": "BSD 3-Clause License",
    ISC: "ISC License",
  }

  let first = true
  for (const lic of order) {
    const pkgs = byLicense.get(lic)
    if (!pkgs?.length) continue

    if (!first) {
      lines.push("-------------------------------------------------------------------")
      lines.push("")
    }
    first = false

    const title = fullLicenseNames[lic] ?? lic
    lines.push(`${title}`)
    lines.push("")
    lines.push(`The following components are licensed under the ${title}:`)
    lines.push("")

    pkgs.sort((a, b) => a.name.localeCompare(b.name))
    for (const p of pkgs) {
      lines.push(formatPkg(p))
    }
    lines.push("")
  }

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const outputArg = process.argv.find((a) => a.startsWith("--output="))
  const outputPath = outputArg ? outputArg.split("=")[1] : OUTPUT

  console.log("Scanning installed packages...")
  const allPkgs = collectAllPackages()
  console.log(`  Found ${allPkgs.size} total packages`)

  console.log("Matching direct dependencies...")
  const directSpecs = getDirectDepSpecs()
  const matched = matchDirectDeps(allPkgs, directSpecs)
  console.log(`  Matched ${matched.size} / ${Object.keys(directSpecs).length} direct dependencies`)

  console.log("Matching HomeGraph vendor dependencies from package-lock...")
  const hgVendor = collectHomegraphVendorFromLock()
  // Same name+version: keep node_modules metadata (publisher). Else add lock entry.
  let added = 0
  for (const info of hgVendor) {
    const exists = [...matched.values()].some((p) => p.name === info.name && p.version === info.version)
    if (exists) continue
    matched.set(`${info.name}@${info.version}`, info)
    added++
  }
  console.log(`  Added ${added} homegraph vendor packages from lock (${hgVendor.length} in lock)`)

  console.log("Generating NOTICE...")
  const content = generateNotice(matched)
  writeFileSync(outputPath, content, "utf-8")
  console.log(`  Written to ${outputPath}`)

  // Summary
  const byLic = new Map<string, number>()
  for (const info of matched.values()) {
    byLic.set(info.license, (byLic.get(info.license) ?? 0) + 1)
  }
  console.log("\nLicense summary:")
  for (const [lic, count] of byLic) {
    console.log(`  ${lic}: ${count}`)
  }
  console.log(`  Total: ${matched.size}`)
}

main()
