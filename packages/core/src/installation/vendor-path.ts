import fs from "fs"
import path from "path"
import { Global } from "../global"
import { InstallationVersion } from "./version"

/**
 * Resolve the install resource root for bundled resources (vendor/, CHANGELOG.md).
 *
 * Priority: versioned install dir (build-time known) → package dir (npm/dev) → fallback.
 */
function resolveResourceRoot(): string {
  const execDir = path.dirname(process.execPath)
  const direct = path.join(execDir, "..")

  // 1) Versioned install — known at build time, no heuristics needed.
  if (InstallationVersion !== "local") {
    const versionedRoot = path.join(Global.Path.data, "versions", InstallationVersion)
    if (fs.existsSync(versionedRoot)) return versionedRoot
  }

  // 2) Package directory itself (npm install, dev mode).
  if (
    fs.existsSync(path.join(direct, "bin")) &&
    fs.existsSync(path.join(direct, "vendor"))
  )
    return direct

  // 3) Fallback
  return direct
}

export function resolveVendorDir(): string {
  return path.join(resolveResourceRoot(), "vendor")
}

export function resolveInstallRoot(): string {
  return resolveResourceRoot()
}
