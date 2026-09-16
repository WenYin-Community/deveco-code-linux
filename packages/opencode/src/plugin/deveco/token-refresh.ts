import fs from "fs"
import { LocalCrypto } from "@/security/local-crypto"
import { logInfo, logWarn } from "./log"
import { devecoAuth } from "./auth"
import { authFilePath, loadDevecoAuthEntry, saveAuthToDisk } from "./storage"
import { ACCESS_TOKEN_EXPIRES_MS } from "./types"
import { tokenStorage } from "./token-storage"

/** Module-level dedup: concurrent callers share a single in-flight refresh. */
let refreshAccess: string | undefined
let refreshPromise: Promise<string | null> | null = null
/** Timestamp of last refresh failure; cooldown prevents rapid retries when refresh token is invalid. */
let lastRefreshFailedAt = 0
const REFRESH_COOLDOWN_MS = 30_000

async function doRefreshToken(expectedAccess: string): Promise<string | null> {
  logInfo("ensureValidToken: token expired, refreshing", { service: "deveco" })
  const jwt = await tokenStorage.loadToken()
  const newTokens = await devecoAuth.refreshToken()
  if (!newTokens?.accessToken) {
    if (refreshAccess === expectedAccess) lastRefreshFailedAt = Date.now()
    logWarn("ensureValidToken: token refresh failed", { service: "deveco" })
    return null
  }
  lastRefreshFailedAt = 0

  try {
    await saveAuthToDisk("deveco", {
      type: "oauth",
      access: newTokens.accessToken,
      refresh: newTokens.refreshToken,
      expires: Date.now() + ACCESS_TOKEN_EXPIRES_MS,
      isRealName: newTokens.isRealName,
    }, expectedAccess)
  } catch (error) {
    const stored = loadDevecoAuthEntry()
    if (
      jwt &&
      (await tokenStorage.loadToken()) === jwt &&
      stored?.type === "oauth" &&
      typeof stored.access === "string" &&
      stored.access !== expectedAccess &&
      typeof stored.expires === "number" &&
      stored.expires > Date.now()
    ) {
      logInfo("ensureValidToken: reused token written by a concurrent refresh", { service: "deveco" })
      return stored.access
    }
    throw error
  }

  logInfo("ensureValidToken: token refreshed successfully", { service: "deveco" })

  if (!newTokens.isRealName) {
    logWarn("ensureValidToken: real-name verification not completed", { service: "deveco" })
  }

  return newTokens.accessToken
}

/**
 * Ensure the deveco access token is valid. If expired, refresh it and persist to disk.
 * Returns a valid access token string, or null if no auth is available or refresh fails.
 *
 * Concurrent callers share a single in-flight refresh (no duplicate API calls).
 * After a refresh failure, subsequent calls are short-circuited for REFRESH_COOLDOWN_MS.
 */
export async function ensureValidToken(): Promise<string | null> {
  try {
    if (!fs.existsSync(authFilePath())) return null
    const raw = JSON.parse(fs.readFileSync(authFilePath(), "utf-8")) as Record<string, unknown>
    const data = LocalCrypto.decryptAuthData(raw) as Record<string, unknown>
    const deveco = data.deveco as Record<string, unknown> | undefined
    if (!deveco || deveco.type !== "oauth" || typeof deveco.access !== "string") return null

    if (refreshAccess !== deveco.access) {
      refreshAccess = deveco.access
      refreshPromise = null
      lastRefreshFailedAt = 0
    }
    const expires = typeof deveco.expires === "number" ? deveco.expires : 0
    if (expires && Date.now() < expires) {
      return deveco.access
    }

    if (lastRefreshFailedAt && Date.now() - lastRefreshFailedAt < REFRESH_COOLDOWN_MS) {
      logWarn("ensureValidToken: refresh skipped, in cooldown after recent failure", { service: "deveco" })
      return null
    }

    if (!refreshPromise) {
      refreshPromise = doRefreshToken(deveco.access).catch((error) => {
        if (refreshAccess === deveco.access) lastRefreshFailedAt = Date.now()
        logWarn("Token refresh or persistence failed", { service: "deveco", error: error instanceof Error ? error.message : String(error) })
        return null
      }).finally(() => {
        if (refreshAccess === deveco.access) refreshPromise = null
      })
    }
    return refreshPromise
  } catch (err) {
    logWarn("ensureValidToken: unexpected error", { service: "deveco", error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/** Test-only: reset module-level refresh state so unit tests can isolate cooldown behavior. */
export function __resetTokenRefreshState() {
  refreshAccess = undefined
  refreshPromise = null
  lastRefreshFailedAt = 0
}
