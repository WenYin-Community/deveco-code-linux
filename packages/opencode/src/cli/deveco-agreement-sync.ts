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

const attempts = new Map<string, Promise<void>>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

async function account() {
  const jwt = await tokenStorage.loadToken()
  if (!jwt) return
  const userId = await devecoAuth.getUserId()
  if (!userId || (await tokenStorage.loadToken()) !== jwt || !loadAccessTokenFromDisk()) return
  const state = Global.Path.state
  const key = createHash("sha256").update(userId).digest("hex")
  return { jwt, state, file: path.join(state, "agreement-reports", `${key}.json`) }
}

type Account = NonNullable<Awaited<ReturnType<typeof account>>>

async function isCurrent(owner: Account) {
  return (
    owner.state === Global.Path.state && (await tokenStorage.loadToken()) === owner.jwt && !!loadAccessTokenFromDisk()
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
}

function lock<T>(owner: Account, run: () => Promise<T>) {
  return Flock.withLock(owner.file, run, { dir: path.join(owner.state, "locks"), timeoutMs: 60_000 })
}

export async function agreementUploadStatus(): Promise<typeof AgreementUpload.Type> {
  const product = await productAgreement()
  if (!product.accepted) return { state: "not_signed" }
  const owner = await account()
  if (!owner) return { state: "local" }
  const stored = await read(owner)
  if (!stored || stored.version !== product.version || stored.manifest !== AGREEMENT_MANIFEST)
    return { state: "pending" }
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

/** Explicit acceptance of an observed service revision, never implicit acceptance on retry. */
export async function acceptServiceRevision(revision: string) {
  const owner = await account()
  if (!owner) throw new ProductAgreementVersionError("Sign in again before accepting updated service agreements.")
  await lock(owner, async () => {
    const stored = await read(owner)
    if (!stored || stored.requiredRevision !== revision || !(await isCurrent(owner)))
      throw new ProductAgreementVersionError("The service agreements or account changed. Review them again.")
    await write(owner, { ...stored, acceptedRevision: revision, uploadedAt: undefined, nextAttemptAt: 0, attempts: 0 })
  })
}

/** All callers share one upload attempt; the file lock also serializes multiple processes. */
export async function syncAgreement(force = false) {
  const owner = await account()
  if (!owner || !(await productAgreement()).accepted) return
  const key = `${owner.file}:${createHash("sha256").update(owner.jwt).digest("hex")}`
  const active = attempts.get(key)
  if (active) return active
  const attempt = lock(owner, async () => {
    if (!(await isCurrent(owner))) return
    const product = await productAgreement()
    if (!product.accepted) return
    const saved = await read(owner)
    const report: Report =
      saved?.version === product.version && saved.manifest === AGREEMENT_MANIFEST
        ? saved
        : { version: product.version, manifest: AGREEMENT_MANIFEST, attempts: 0, nextAttemptAt: 0 }
    if (!force && report.nextAttemptAt > Date.now()) {
      schedule(owner, report.nextAttemptAt)
      return
    }
    if (report.requiredRevision && report.requiredRevision !== report.acceptedRevision) return

    // Persist pending before touching the network, so an interrupted upload is retried.
    const pending = { ...report, lastAttemptAt: Date.now(), attempts: report.attempts + 1 }
    await write(owner, pending)
    const service = new AgreementService()
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
      await failed(owner, pending, "Sign in again to upload your agreement record.")
      return
    }
    // A server record is sufficient evidence of upload; a missing record never revokes local consent.
    if (query.status === AgreementStatus.COMPLIANT) {
      await write(owner, {
        ...pending,
        uploadedAt: Date.now(),
        error: undefined,
        attempts: 0,
        nextAttemptAt: Date.now() + 30 * 60_000,
      })
      return
    }
    const signed = await service.signAgreement(loadAccessTokenFromDisk(), false)
    if (!(await isCurrent(owner))) return
    if (!signed.isUpload) {
      await failed(owner, { ...pending, uploadedAt: undefined }, signed.error ?? "Agreement upload failed")
      return
    }
    await write(owner, {
      ...pending,
      uploadedAt: Date.now(),
      error: undefined,
      attempts: 0,
      nextAttemptAt: Date.now() + 30 * 60_000,
    })
  }).finally(() => attempts.delete(key))
  attempts.set(key, attempt)
  return attempt
}

async function failed(owner: Account, report: Report, error: string) {
  const nextAttemptAt = Date.now() + Math.min(30 * 60_000, 30_000 * 2 ** Math.min(report.attempts - 1, 6))
  await write(owner, { ...report, error, nextAttemptAt })
  schedule(owner, nextAttemptAt)
}

function schedule(owner: Account, at: number) {
  const previous = timers.get(owner.file)
  if (previous) clearTimeout(previous)
  const timer = setTimeout(
    () => {
      timers.delete(owner.file)
      void isCurrent(owner)
        .then((current) => {
          if (current) startAgreementSync()
        })
        .catch(logSyncFailure)
    },
    Math.max(1, at - Date.now()),
  )
  timer.unref()
  timers.set(owner.file, timer)
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

export function stopAgreementSync() {
  timers.forEach(clearTimeout)
  timers.clear()
}
