export * as HarmonyProject from "./harmony-project"

import fs from "node:fs"
import path from "node:path"

// ─── Harmony project helpers ────────────────────────────────
// Shared detection of HarmonyOS projects and bundleName
// extraction from AppScope/app.json5. Used by the analytics
// collectors, the UI verification tool, and the hdc guard
// (bundle allowlist validation).

function exists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

export function isHarmonyProject(projectRoot: string): boolean {
  return (
    exists(path.join(projectRoot, "AppScope", "app.json5")) ||
    (exists(path.join(projectRoot, "build-profile.json5")) &&
      (exists(path.join(projectRoot, "oh-package.json5")) || exists(path.join(projectRoot, "oh-package.json"))))
  )
}

// Returns the project's bundleName, or "" when the path is not a
// Harmony project, app.json5 is missing, or parsing fails.
// Callers that must fail closed on a missing bundleName should
// treat "" as "unknown" and deny/ask accordingly.
export function readBundleName(projectPath: string): string {
  if (!isHarmonyProject(projectPath)) return ""
  const appJson5Path = path.join(projectPath, "AppScope", "app.json5")
  if (!exists(appJson5Path)) return ""
  try {
    const raw = fs.readFileSync(appJson5Path, "utf8")
    const cleaned = raw
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/,(\s*[}\]])/g, "$1")
    const parsed = JSON.parse(cleaned) as Record<string, unknown>
    const app = typeof parsed.app === "object" && parsed.app !== null ? (parsed.app as Record<string, unknown>) : undefined
    return typeof app?.bundleName === "string" ? app.bundleName : ""
  } catch {
    return ""
  }
}
