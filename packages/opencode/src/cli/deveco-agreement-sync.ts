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
  const owner = await readAccount()
  if (!owner) {
    entry = undefined
    return
  }
  const current = entry?.owner
  if (matchesAccount(current, owner)) return current
  entry = { owner }
  return owner
}

function matchesAccount(current: Account | undefined, owner: Account): current is Account {
  if (!current) return false
  return current.jwtHash === owner.jwtHash && current.file === owner.file
}

async function readAccount() {
  const jwt = await tokenStorage.loadToken()
  if (!jwt) return
  const userId = await devecoAuth.getUserId()
  if (!userId) return
  if (!(await hasCredentials(jwt))) return
  const state = Global.Path.state
  const file = path.join(state, "agreement-reports", `${createHash("sha256").update(userId).digest("hex")}.json`)
  const jwtHash = createHash("sha256").update(jwt).digest("hex")
  return { jwtHash, state, file }
}

async function hasCredentials(jwt: string) {
  return (await tokenStorage.loadToken()) === jwt && !!loadAccessTokenFromDisk()
}

function ownsAccount(owner: Account) {
  if (!entry) return false
  return entry.owner === owner && owner.state === Global.Path.state
}

async function isCurrent(owner: Account) {
  if (!ownsAccount(owner)) return false
  if (!(await matchesToken(owner))) return false
  return !!loadAccessTokenFromDisk() && ownsAccount(owner)
}

async function matchesToken(owner: Account) {
  const jwt = await tokenStorage.loadToken()
  if (!jwt) return false
  return createHash("sha256").update(jwt).digest("hex") === owner.jwtHash
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
  return cachedUpload(owner) ?? (await readUploadStatus(owner, product.version))
}

function cachedUpload(owner: Account) {
  if (!entry) return
  if (entry.owner === owner) return entry.upload
}

async function readUploadStatus(owner: Account, version: string): Promise<typeof AgreementUpload.Type> {
  const stored = await read(owner)
  if (!matchesReport(stored, version)) return { state: "pending" }
  return uploadStatus(stored)
}

function matchesReport(report: Report | undefined, version: string): report is Report {
  if (!report) return false
  return report.version === version && report.manifest === AGREEMENT_MANIFEST
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

/** Online queries are owned exclusively by startup and explicit account login. */
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
  return attempts.get(owner) ?? startAttempt(owner, check)
}

function startAttempt(owner: Account, check: boolean) {
  if (skipAttempt(owner, check)) return
  const attempt = lock(owner, () => syncReport(owner, check))
    .catch(logSyncFailure)
    .finally(() => attempts.delete(owner))
  attempts.set(owner, attempt)
  return attempt
}

function skipAttempt(owner: Account, check: boolean) {
  const upload = cachedUpload(owner)
  if (!upload) return false
  if (check) return true
  return upload.state !== "pending"
}

async function syncReport(owner: Account, check: boolean) {
  const product = await currentProduct(owner)
  if (!product) return
  const report = await reportFor(owner, product.version)
  if (skipUpload(report, check)) return
  // Legacy reports retain nextAttemptAt for compatibility; there is no timer.
  const pending = { ...report, lastAttemptAt: Date.now(), attempts: report.attempts + 1 }
  await write(owner, pending)
  const service = new AgreementService()
  if (await checkReport(owner, pending, service, check)) return
  await signReport(owner, pending, service)
}

async function currentProduct(owner: Account) {
  if (!(await isCurrent(owner))) return
  const product = await productAgreement()
  if (product.accepted) return product
}

async function reportFor(owner: Account, version: string): Promise<Report> {
  const saved = await read(owner)
  if (matchesReport(saved, version)) return saved
  return { version, manifest: AGREEMENT_MANIFEST, attempts: 0, nextAttemptAt: 0 }
}

function requiresReview(report: Report) {
  return !!report.requiredRevision && report.requiredRevision !== report.acceptedRevision
}

function skipUpload(report: Report, check: boolean) {
  if (check) return false
  return !!report.uploadedAt || requiresReview(report)
}

async function checkReport(owner: Account, report: Report, service: AgreementService, check: boolean) {
  if (!check) return false
  const query = await service.queryAgreement(loadAccessTokenFromDisk())
  if (!(await isCurrent(owner))) return true
  return settleQuery(owner, report, query)
}

type AgreementQuery = Awaited<ReturnType<AgreementService["queryAgreement"]>>

async function settleQuery(owner: Account, report: Report, query: AgreementQuery) {
  const revision = serviceRevision(query)
  if (requiresReview({ ...report, requiredRevision: revision })) {
    await write(owner, { ...report, requiredRevision: revision, uploadedAt: undefined })
    return true
  }
  if (query.status === AgreementStatus.SESSION_EXPIRED) {
    await write(owner, { ...report, error: "Sign in again to upload your agreement record.", nextAttemptAt: 0 })
    return true
  }
  // A server record proves upload; a missing record never revokes local consent.
  if (query.status === AgreementStatus.COMPLIANT) {
    await write(owner, uploadedReport({ ...report, requiredRevision: undefined }))
    return true
  }
  return false
}

function serviceRevision(query: AgreementQuery) {
  if (query.status !== AgreementStatus.NEED_RE_SIGN) return
  return JSON.stringify(
    (query.signInfos ?? (query.signInfo ? [query.signInfo] : []))
      .map((info) => [String(info.agrType), info.newestVersion, info.newestSubVersion])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  )
}

async function signReport(owner: Account, report: Report, service: AgreementService) {
  if (requiresReview(report)) return
  const signed = await service.signAgreement(loadAccessTokenFromDisk(), false)
  if (!(await isCurrent(owner))) return
  if (!signed.isUpload) return writeUploadFailure(owner, report, signed.error)
  await write(owner, uploadedReport(report))
}

function writeUploadFailure(owner: Account, report: Report, error?: string) {
  return write(owner, {
    ...report,
    uploadedAt: undefined,
    error: error ?? "Agreement upload failed",
    nextAttemptAt: 0,
  })
}

function uploadedReport(report: Report): Report {
  return { ...report, uploadedAt: Date.now(), error: undefined, attempts: 0, nextAttemptAt: 0 }
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
