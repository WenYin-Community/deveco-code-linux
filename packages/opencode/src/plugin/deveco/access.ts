import { devecoAuth } from "./auth"
import { ensureValidToken } from "./token-refresh"
import { loadAccessTokenFromDisk, loadIsRealNameFromDisk } from "./storage"
import { regionPolicy, MAINLAND_CHINA_ONLY_MESSAGE } from "./region-policy"
import type { AgreementConfig } from "@/cli/deveco-legal"

declare const DEVECO_SKIP_AGREEMENT: boolean | undefined

let realNameAttempt: { key: string; expires: number; message: string; pending?: Promise<boolean | null> } | undefined

/** Built-in models additionally require HUAWEI authentication and real-name verification. */
export async function requireDevEcoAccess(_config?: AgreementConfig) {
  const region = await regionPolicy.checkAccess()
  if (!region.allowed) throw new Error(MAINLAND_CHINA_ONLY_MESSAGE)

  const token = await ensureValidToken()
  if (!token) throw new Error("Sign in with HUAWEI ID to use built-in models.")
  const userId = await devecoAuth.getUserId()
  if (!userId) throw new Error("Sign in with HUAWEI ID to use built-in models.")
  if (loadIsRealNameFromDisk() !== true) {
    const identity = JSON.stringify([userId, token])
    const recent = realNameAttempt?.key === identity && realNameAttempt.expires > Date.now() ? realNameAttempt : undefined
    if (recent && !recent.pending) throw new Error(recent.message)
    const pending = recent?.pending ?? devecoAuth.checkRealName()
    if (!recent) {
      realNameAttempt = {
        key: identity,
        expires: Date.now() + 30_000,
        message: "Real-name verification is in progress. Please retry shortly.",
        pending,
      }
    }
    const verified = await pending
    if (realNameAttempt?.key === identity) realNameAttempt.pending = undefined
    if (verified !== true) {
      const message =
        verified === false
          ? "Complete HUAWEI real-name authentication and retry in 30 seconds."
          : "Unable to verify HUAWEI real-name status. Check your network and retry in 30 seconds."
      if (realNameAttempt?.key === identity) realNameAttempt.message = message
      throw new Error(message)
    }
  }

  // Real-name verification can rotate the access token.
  const access = loadAccessTokenFromDisk()
  if (!access || (await devecoAuth.getUserId()) !== userId)
    throw new Error("HUAWEI account changed. Sign in again to use built-in models.")
  if (!(typeof DEVECO_SKIP_AGREEMENT !== "undefined" && DEVECO_SKIP_AGREEMENT)) {
    const { requireProductAccess } = await import("@/cli/deveco-product-agreement")
    await requireProductAccess()
  }

  // A concurrent logout must not release a credential captured before the check.
  const current = loadAccessTokenFromDisk()
  if (!current || (await devecoAuth.getUserId()) !== userId)
    throw new Error("HUAWEI account changed. Sign in again to use built-in models.")
  if (loadIsRealNameFromDisk() !== true)
    throw new Error("Complete HUAWEI real-name authentication before using built-in models.")
  return current
}

export function clearDevEcoAccess() {
  realNameAttempt = undefined
}
