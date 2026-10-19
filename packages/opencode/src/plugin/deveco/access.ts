import { devecoAuth } from "./auth"
import { ensureValidToken } from "./token-refresh"
import { loadAccessTokenFromDisk, loadIsRealNameFromDisk } from "./storage"
import { regionPolicy, MAINLAND_CHINA_ONLY_MESSAGE } from "./region-policy"
import type { AgreementConfig } from "@/cli/deveco-legal"

declare const DEVECO_SKIP_AGREEMENT: boolean | undefined

let realNameAttempt: { key: string; expires: number; message: string; pending?: Promise<boolean | null> } | undefined

/** Built-in models additionally require account authentication and real-name verification. */
export async function requireDevEcoAccess(_config?: AgreementConfig) {
  const region = await regionPolicy.checkAccess()
  if (!region.allowed) throw new Error(MAINLAND_CHINA_ONLY_MESSAGE)
  const identity = await requireIdentity()
  await requireRealName(JSON.stringify([identity.userId, identity.token]))
  // Real-name verification can rotate the access token.
  await requireCurrentAccount(identity.userId)
  await requireAgreements()
  // A concurrent logout must not release a credential captured before the check.
  const current = await requireCurrentAccount(identity.userId)
  if (loadIsRealNameFromDisk() !== true)
    throw new Error("Complete HUAWEI real-name authentication before using built-in models.")
  return current
}

async function requireIdentity() {
  const token = await ensureValidToken()
  if (!token) throw new Error("Sign in with HUAWEI ID to use built-in models.")
  const userId = await devecoAuth.getUserId()
  if (!userId) throw new Error("Sign in with HUAWEI ID to use built-in models.")
  return { token, userId }
}

function recentRealNameAttempt(identity: string) {
  if (!realNameAttempt) return
  if (realNameAttempt.key !== identity) return
  if (realNameAttempt.expires > Date.now()) return realNameAttempt
}

function beginRealNameCheck(identity: string) {
  const recent = recentRealNameAttempt(identity)
  if (recent) {
    if (!recent.pending) throw new Error(recent.message)
    return recent.pending
  }
  const pending = devecoAuth.checkRealName()
  realNameAttempt = {
    key: identity,
    expires: Date.now() + 30_000,
    message: "Real-name verification is in progress. Please retry shortly.",
    pending,
  }
  return pending
}

async function requireRealName(identity: string) {
  if (loadIsRealNameFromDisk() === true) return
  const verified = await beginRealNameCheck(identity)
  const attempt = currentRealNameAttempt(identity)
  if (attempt) attempt.pending = undefined
  if (verified === true) return
  throw realNameFailure(verified, attempt)
}

function currentRealNameAttempt(identity: string) {
  if (!realNameAttempt) return
  if (realNameAttempt.key === identity) return realNameAttempt
}

function realNameFailure(verified: boolean | null, attempt: typeof realNameAttempt) {
  const message =
    verified === false
      ? "Complete HUAWEI real-name authentication and retry in 30 seconds."
      : "Unable to verify HUAWEI real-name status. Check your network and retry in 30 seconds."
  if (attempt) attempt.message = message
  return new Error(message)
}

async function requireCurrentAccount(userId: string) {
  const access = loadAccessTokenFromDisk()
  if (!access || (await devecoAuth.getUserId()) !== userId)
    throw new Error("HUAWEI account changed. Sign in again to use built-in models.")
  return access
}

async function requireAgreements() {
  if (typeof DEVECO_SKIP_AGREEMENT !== "undefined" && DEVECO_SKIP_AGREEMENT) return
  const { requireProductAccess } = await import("@/cli/deveco-product-agreement")
  await requireProductAccess()
}

export function clearDevEcoAccess() {
  realNameAttempt = undefined
}
