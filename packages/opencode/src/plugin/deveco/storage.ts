import fs from "fs"
import path from "path"
import { LocalCrypto } from "@/security/local-crypto"
import { Global } from "@opencode-ai/core/global"
import { logError } from "./log"

export function authFilePath() {
  return path.join(Global.Path.data, "auth.json")
}

export function loadDevecoAuthEntry(): Record<string, unknown> | undefined {
  try {
    if (!fs.existsSync(authFilePath())) return
    const raw = JSON.parse(fs.readFileSync(authFilePath(), "utf-8")) as Record<string, unknown>
    const data = LocalCrypto.decryptAuthData(raw) as Record<string, unknown>
    const entry = data.deveco
    if (typeof entry === "object" && entry !== null) return entry as Record<string, unknown>
  } catch {
  }
}

export async function saveAuthToDisk(key: string, info: Record<string, unknown> | null, expectedAccess?: string) {
  try {
    let data: Record<string, unknown> = {}
    if (fs.existsSync(authFilePath())) {
      data = LocalCrypto.decryptAuthData(JSON.parse(fs.readFileSync(authFilePath(), "utf8")) as Record<string, unknown>)
    }
    if (expectedAccess !== undefined) {
      const current = data[key]
      if (typeof current !== "object" || current === null || !("access" in current) || current.access !== expectedAccess) {
        throw new Error("HUAWEI credentials changed while refreshing; discarded the old result")
      }
    }
    if (info === null) {
      delete data[key]
    } else {
      // Shallow merge to preserve fields (e.g. isRealName) not included by every caller
      const existing = data[key]
      data[key] = typeof existing === "object" && existing !== null ? { ...existing as Record<string, unknown>, ...info } : info
    }
    const dir = path.dirname(authFilePath())
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const encrypted = LocalCrypto.encryptAuthData(data)
    // Write to .tmp then rename for atomic persistence; prevents corrupt auth.json on crash
    const tmpPath = `${authFilePath()}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 })
    fs.renameSync(tmpPath, authFilePath())
  } catch (err) {
    logError("failed to save auth to disk", { service: "deveco", key, error: err instanceof Error ? err.message : String(err) })
    throw err
  }
}

export function loadAccessTokenFromDisk(): string {
  const deveco = loadDevecoAuthEntry()
  if (deveco?.type === "oauth" && typeof deveco.access === "string") return deveco.access
  return ""
}

/**
 * Check whether auth.json has a deveco OAuth entry (type=oauth, access token present).
 * This mirrors what `deveco auth list` shows — if there's no entry, the user has not logged in.
 * The refresh token may be empty (some login flows don't store it), so we only require access.
 */
export function hasDevecoOAuthEntry(): boolean {
  const deveco = loadDevecoAuthEntry()
  return deveco?.type === "oauth" && typeof deveco.access === "string" && deveco.access.length > 0
}

/**
 * Read the cached real-name verification flag from auth.json.
 * Returns true/false if the field exists, or null if not yet cached.
 */
export function loadIsRealNameFromDisk(): boolean | null {
  const deveco = loadDevecoAuthEntry()
  if (typeof deveco?.isRealName === "boolean") return deveco.isRealName
  return null
}
