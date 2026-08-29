#!/usr/bin/env bun
/**
 * Download vendored ripgrep binaries to .build-cache/.
 *
 * Run automatically via `bun install` (postinstall hook),
 * or manually: `bun run script/postinstall.ts`
 *
 * Idempotent — skips download when the binary already exists in .build-cache.
 *
 * Ripgrep is fetched from the npm registry as the per-platform
 * `@vscode/ripgrep-<platform>` packages, so it follows NPM_CONFIG_REGISTRY
 * (CI sets the Huawei mirror, which is already reachable for `bun install`)
 * and never depends on GitHub or a third-party GitHub proxy.
 *
 * Environment:
 * - NPM_CONFIG_REGISTRY — npm registry base (default: https://registry.npmjs.org).
 * - RIPGREP_NPM_VERSION — @vscode/ripgrep package version (default: 1.18.0, bundles rg 15.0.0).
 * - HTTPS_PROXY / HTTP_PROXY — when set, download uses `undici` + EnvHttpProxyAgent.
 */

import fs from "fs"
import path from "path"
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "fs"
import { spawnSync } from "child_process"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

// --- Config ---

// @vscode/ripgrep publishes one npm package per platform; each tarball ships
// `package/bin/rg` (or `package/bin/rg.exe` on Windows). 1.18.0 bundles ripgrep 15.0.0.
const RG_NPM_VERSION = process.env.RIPGREP_NPM_VERSION || "1.18.0"
const registryBase = (process.env.NPM_CONFIG_REGISTRY || "https://registry.npmjs.org").replace(/\/$/, "")

const cacheDir = path.join(dir, ".build-cache")
const rgCacheDir = path.join(cacheDir, "ripgrep")

const supportedPlatforms = new Set(["darwin-arm64", "darwin-x64", "win32-x64"])

// npm package + binary name per platform. Tarball layout: package/bin/<binary>.
const rgNpmMap: Record<string, { pkg: string; binary: string }> = {
  "darwin-arm64": { pkg: "@vscode/ripgrep-darwin-arm64", binary: "rg" },
  "darwin-x64":   { pkg: "@vscode/ripgrep-darwin-x64",   binary: "rg" },
  "win32-x64":    { pkg: "@vscode/ripgrep-win32-x64",    binary: "rg.exe" },
}

// --- Download helpers ---

function proxyEnvSet(): boolean {
  const v = (s: string | undefined) => (s ?? "").trim()
  return !!(v(process.env.HTTPS_PROXY) || v(process.env.HTTP_PROXY) || v(process.env.ALL_PROXY))
}

async function fetchWithProxy(url: string): Promise<Response> {
  if (proxyEnvSet()) {
    // @ts-ignore — undici is bundled by Bun at runtime
    const { EnvHttpProxyAgent, fetch: undiciFetch } = await import("undici")
    return (await undiciFetch(url, {
      redirect: "follow",
      dispatcher: new EnvHttpProxyAgent(),
    })) as unknown as Response
  }
  return await fetch(url, { redirect: "follow" })
}

async function downloadBuffer(url: string): Promise<Buffer> {
  const response = await fetchWithProxy(url)
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText} (${url})`)
  }
  return Buffer.from(await response.arrayBuffer())
}

// Tarball URL for a scoped npm package, e.g.
// <registry>/@vscode/ripgrep-darwin-arm64/-/ripgrep-darwin-arm64-1.18.0.tgz
function npmTarballUrl(pkgName: string, version: string): string {
  const unscoped = pkgName.replace(/^@[^/]+\//, "")
  return `${registryBase}/${pkgName}/-/${unscoped}-${version}.tgz`
}

// --- Ripgrep ---

async function downloadRipgrep(platform: string) {
  const info = rgNpmMap[platform]
  if (!info) return

  const cachePath = path.join(rgCacheDir, platform, info.binary)
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) {
    return
  }

  const url = npmTarballUrl(info.pkg, RG_NPM_VERSION)
  console.log(`  Downloading rg for ${platform} from npm...`)

  const cacheSubDir = path.join(rgCacheDir, platform)
  mkdirSync(cacheSubDir, { recursive: true })

  const buffer = await downloadBuffer(url)
  console.log(`  Downloaded ${Math.round(buffer.length / 1024)} KB`)

  const tmpDir = path.join(cacheSubDir, ".tmp-download")
  fs.rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  try {
    const archivePath = path.join(tmpDir, "ripgrep.tgz")
    writeFileSync(archivePath, buffer)
    // npm tarballs are gzip+tar and always lay out the binary at package/bin/<binary>.
    const result = spawnSync("tar", ["xzf", archivePath, "-C", tmpDir], { stdio: "pipe" })
    if (result.status !== 0) {
      throw new Error(`tar extract failed: ${result.stderr?.toString()}`)
    }
    const extracted = path.join(tmpDir, "package", "bin", info.binary)
    if (!fs.existsSync(extracted)) {
      throw new Error(`Binary ${info.binary} not found in npm tarball`)
    }
    fs.rmSync(cachePath, { force: true })
    renameSync(extracted, cachePath)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  if (!platform.startsWith("win32")) {
    chmodSync(cachePath, 0o755)
  }
  console.log(`  Cached rg for ${platform}`)
}

// --- Main ---

const platforms = Array.from(supportedPlatforms)

console.log(`Downloading vendored binaries from npm... (${platforms.join(", ")})`)
for (const platform of platforms) {
  await downloadRipgrep(platform).catch((e) => console.log(`  Failed to download rg for ${platform}: ${e.message}`))
}

console.log("Done.")
