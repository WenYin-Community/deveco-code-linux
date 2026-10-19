import path from "path"
import { createHash, randomUUID } from "crypto"
import { rename } from "fs/promises"
import { Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { AgreementService, AgreementStatus } from "./deveco-agreement"
import { AGREEMENT_DEFAULTS } from "./deveco-legal"
import { productAgreement, ProductAgreementVersionError } from "./deveco-product-agreement"
import { devecoAuth } from "@/plugin/deveco/auth"
import { loadAccessTokenFromDisk } from "@/plugin/deveco/storage"
import { tokenStorage } from "@/plugin/deveco/token-storage"
import { logWarn } from "@/plugin/deveco/log"

// This manifest binds the product consent to the two displayed DevEco agreements.
// A product revision must change when its bundled agreement identity changes.
export const AGREEMENT_MANIFEST = [AGREEMENT_DEFAULTS.privacy_id, AGREEMENT_DEFAULTS.terms_id].join(":")

export const AgreementUpload = Schema.Struct({
  state: Schema.Literals(["not_signed", "local", "pending", "uploaded", "review_required"]),
  revision: Schema.optional(Schema.String),
  lastAttemptAt: Schema.optional(Schema.Number),
  uploadedAt: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
})

const RecordSchema = Schema.Struct({
  version: Schema.String,
  manifest: Schema.String,
  acceptedRevision: Schema.optional(Schema.String),
  requiredRevision: Schema.optional(Schema.String),
  lastAttemptAt: Schema.optional(Schema.Number),
  uploadedAt: Schema.optional(Schema.Number),
  attempts: Schema.Number,
  nextAttemptAt: Schema.Number,
  error: Schema.optional(Schema.String),
})
type Report = typeof RecordSchema.Type

type Account = { jwtHash: string; state: string; file: string }

// Only the active login owns this process-local snapshot. Disk reports remain
// durable, but another process cannot revoke a decision already made here.
let entry: { owner: Account; upload?: typeof AgreementUpload.Type } | undefined
let checking: Promise<void> | undefined
const attempts = new WeakMap<Account, Promise<void>>()

async function account() {
  const jwt = await tokenStorage.loadToken()
  if (!jwt) {
    entry = undefined
    return
  }
  const userId = await devecoAuth.getUserId()
  if (!userId || (await tokenStorage.loadToken()) !== jwt || !loadAccessTokenFromDisk()) {
    entry = undefined
    return
  }
  const state = Global.Path.state
  const file = path.join(state, "agreement-reports", `${createHash("sha256").update(userId).digest("hex")}.json`)
  const jwtHash = createHash("sha256").update(jwt).digest("hex")
  if (entry?.owner.jwtHash === jwtHash && entry.owner.file === file) return entry.owner
  const owner = { jwtHash, state, file }
  entry = { owner }
  return owner
}

async function isCurrent(owner: Account) {
  if (entry?.owner !== owner || owner.state !== Global.Path.state) return false
  const jwt = await tokenStorage.loadToken()
  return (
    !!jwt &&
    createHash("sha256").update(jwt).digest("hex") === owner.jwtHash &&
    !!loadAccessTokenFromDisk() &&
    entry?.owner === owner
  )
}

async function read(owner: Account): Promise<Report | undefined> {
  const stored = await Bun.file(owner.file)
    .json()
    .catch(() => undefined)
  const decoded = Schema.decodeUnknownOption(RecordSchema)(stored)
  if (decoded._tag === "Some") return decoded.value
}

async function write(owner: Account, report: Report) {
  const temporary = `${owner.file}.${randomUUID()}.tmp`
  await Bun.write(temporary, JSON.stringify(report), { mode: 0o600 })
  await rename(temporary, owner.file)
  // Cache commits share the report lock with acceptance; no stale read can
  // restore a review requirement after the user has accepted it.
  if (entry?.owner === owner) entry.upload = uploadStatus(report)
}

function lock<T>(owner: Account, run: () => Promise<T>) {
  return Flock.withLock(owner.file, run, { dir: path.join(owner.state, "locks"), timeoutMs: 60_000 })
}

export async function agreementUploadStatus(): Promise<typeof AgreementUpload.Type> {
  const product = await productAgreement()
  if (!product.accepted) return { state: "not_signed" }
  const owner = await account()
  if (!owner) return { state: "local" }
  if (entry?.owner === owner && entry.upload) return entry.upload
  const stored = await read(owner)
  if (!stored || stored.version !== product.version || stored.manifest !== AGREEMENT_MANIFEST)
    return { state: "pending" }
  return uploadStatus(stored)
}

function uploadStatus(stored: Report): typeof AgreementUpload.Type {
  return {
    state:
      stored.requiredRevision && stored.requiredRevision !== stored.acceptedRevision
        ? "review_required"
        : stored.uploadedAt
          ? "uploaded"
          : "pending",
    revision: stored.requiredRevision,
    lastAttemptAt: stored.lastAttemptAt,
    uploadedAt: stored.uploadedAt,
    error: stored.error,
  }
}

/** Status and admission may join startup/login work, but never start a query. */
export async function waitForAgreementSync() {
  // Startup registers its promise before resolving credentials or reading disk.
  while (checking) await checking
  const owner = await account()
  if (owner) await attempts.get(owner)
}

/** Explicit acceptance of an observed service revision, never implicit acceptance on retry. */
export async function acceptServiceRevision(revision: string) {
  await waitForAgreementSync()
  const owner = await account()
  if (!owner) throw new ProductAgreementVersionError("Sign in again before accepting updated service agreements.")
  await lock(owner, async () => {
    const stored = await read(owner)
    if (!stored || stored.requiredRevision !== revision || !(await isCurrent(owner)))
      throw new ProductAgreementVersionError("The service agreements or account changed. Review them again.")
    await write(owner, { ...stored, acceptedRevision: revision, uploadedAt: undefined, nextAttemptAt: 0, attempts: 0 })
  })
}

/** Online queries are owned exclusively by startup and explicit HUAWEI login. */
export function syncAgreement() {
  const attempt = runAgreementSync(true).finally(() => {
    if (checking === attempt) checking = undefined
  })
  checking = attempt
  return attempt
}

/** Acceptance and upload retries reuse the observed revision without querying TMS. */
export async function uploadAgreement() {
  await waitForAgreementSync()
  return runAgreementSync(false)
}

async function runAgreementSync(check: boolean) {
  const owner = await account()
  if (!owner || !(await productAgreement()).accepted) return
  const active = attempts.get(owner)
  if (active) return active
  if (entry?.owner === owner && entry.upload && (check || entry.upload.state !== "pending")) return
  const attempt = lock(owner, async () => {
    if (!(await isCurrent(owner))) return
    const product = await productAgreement()
    if (!product.accepted) return
    const saved = await read(owner)
    const report: Report =
      saved?.version === product.version && saved.manifest === AGREEMENT_MANIFEST
        ? saved
        : { version: product.version, manifest: AGREEMENT_MANIFEST, attempts: 0, nextAttemptAt: 0 }
    if (
      !check &&
      (report.uploadedAt || (report.requiredRevision && report.requiredRevision !== report.acceptedRevision))
    )
      return
    // Legacy reports retain nextAttemptAt for compatibility; there is no timer.
    const pending = { ...report, lastAttemptAt: Date.now(), attempts: report.attempts + 1 }
    await write(owner, pending)
    const service = new AgreementService()
    if (check) {
      const query = await service.queryAgreement(loadAccessTokenFromDisk())
      if (!(await isCurrent(owner))) return
      const revision =
        query.status === AgreementStatus.NEED_RE_SIGN
          ? JSON.stringify(
              (query.signInfos ?? (query.signInfo ? [query.signInfo] : []))
                .map((info) => [String(info.agrType), info.newestVersion, info.newestSubVersion])
                .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
            )
          : undefined
      if (revision && revision !== report.acceptedRevision) {
        await write(owner, { ...pending, requiredRevision: revision, uploadedAt: undefined })
        return
      }
      if (query.status === AgreementStatus.SESSION_EXPIRED) {
        await write(owner, { ...pending, error: "Sign in again to upload your agreement record.", nextAttemptAt: 0 })
        return
      }
      // A server record is sufficient evidence of upload; a missing record never revokes local consent.
      if (query.status === AgreementStatus.COMPLIANT) {
        await write(owner, {
          ...pending,
          requiredRevision: undefined,
          uploadedAt: Date.now(),
          error: undefined,
          attempts: 0,
          nextAttemptAt: 0,
        })
        return
      }
    }
    if (report.requiredRevision && report.requiredRevision !== report.acceptedRevision) return
    const signed = await service.signAgreement(loadAccessTokenFromDisk(), false)
    if (!(await isCurrent(owner))) return
    if (!signed.isUpload) {
      await write(owner, {
        ...pending,
        uploadedAt: undefined,
        error: signed.error ?? "Agreement upload failed",
        nextAttemptAt: 0,
      })
      return
    }
    await write(owner, {
      ...pending,
      uploadedAt: Date.now(),
      error: undefined,
      attempts: 0,
      nextAttemptAt: 0,
    })
  })
    .catch(logSyncFailure)
    .finally(() => attempts.delete(owner))
  attempts.set(owner, attempt)
  return attempt
}

function logSyncFailure(error: unknown) {
  logWarn("agreement sync deferred", {
    service: "deveco",
    error: error instanceof Error ? error.message : String(error),
  })
}

export function trySyncAgreement() {
  return syncAgreement().catch(logSyncFailure)
}

export function startAgreementSync() {
  void trySyncAgreement()
}

/** Reset the login snapshot; in-flight requests continue, but their results are discarded. */
export function resetAgreementCheck() {
  entry = undefined
  checking = undefined
}
