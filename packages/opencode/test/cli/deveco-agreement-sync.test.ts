import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"

const runtimeState = { mode: "default" as string }
mock.module("@opencode-ai/core/runtime", () => ({
  Runtime: { current: runtimeState },
}))

import { Global } from "@opencode-ai/core/global"
import { createHash } from "crypto"
import { Effect } from "effect"
import { Auth } from "@/auth"
import { AgreementService, AgreementStatus } from "@/cli/deveco-agreement"
import {
  agreementUploadStatus,
  syncAgreement,
  resetAgreementCheck,
  acceptServiceRevision,
  uploadAgreement,
  observeAgreementRevision,
  waitForAgreementSync,
} from "@/cli/deveco-agreement-sync"
import {
  acceptProductAgreement,
  productAgreementDetails,
  PRODUCT_AGREEMENT_VERSION,
} from "@/cli/deveco-product-agreement"
import { tokenStorage } from "@/plugin/deveco/token-storage"
import { saveAuthToDisk } from "@/plugin/deveco/storage"
import { tmpdir } from "../fixture/fixture"

const original = { state: Global.Path.state, data: Global.Path.data }
const query = spyOn(AgreementService.prototype, "queryAgreement")
const sign = spyOn(AgreementService.prototype, "signAgreement")

beforeEach(() => {
  query.mockReset().mockResolvedValue({ status: AgreementStatus.NEED_SIGN, signInfo: null, versionInfo: null })
  sign.mockReset().mockResolvedValue({ success: true, isUpload: true })
})
afterEach(async () => {
  resetAgreementCheck()
  await tokenStorage.clearToken()
  Global.Path.state = original.state
  Global.Path.data = original.data
  runtimeState.mode = "default"
  delete process.env.DEVECO_ALWAYS_ACCEPT_AGREEMENT
})
afterAll(() => {
  query.mockRestore()
  sign.mockRestore()
})

async function login(userId = "account-a", nonce = 0) {
  await tokenStorage.saveToken(`e30.${Buffer.from(JSON.stringify({ userId, nonce })).toString("base64url")}.test`)
  await saveAuthToDisk("deveco", {
    type: "oauth",
    access: `${userId}-access`,
    expires: Date.now() + 60_000,
    isRealName: true,
  })
}

async function setup() {
  const tmp = await tmpdir()
  Global.Path.state = tmp.path
  Global.Path.data = tmp.path
  await tokenStorage.clearToken()
  await acceptProductAgreement(PRODUCT_AGREEMENT_VERSION)
  // Drain the acceptance-triggered attempt before changing accounts in the fixture.
  await syncAgreement()
  return tmp
}

test("status reads join an already-started check without creating another one", async () => {
  await using tmp = await setup()
  await login()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  query.mockImplementationOnce(async () => {
    entered.resolve()
    await release.promise
    return { status: AgreementStatus.COMPLIANT, signInfo: null, versionInfo: null }
  })
  const checking = syncAgreement()
  // Read immediately, before the check has resolved credentials or acquired its lock.
  const details = productAgreementDetails()
  await entered.promise
  release.resolve()
  await checking
  expect((await details).upload.state).toBe("uploaded")
  expect(query).toHaveBeenCalledTimes(1)
})

test("admission stops further queries, including upload retries and status reads", async () => {
  await using tmp = await setup()
  await login()
  query.mockResolvedValue({ status: AgreementStatus.COMPLIANT, signInfo: null, versionInfo: null })
  await syncAgreement()
  query.mockResolvedValue({ status: AgreementStatus.NEED_RE_SIGN, signInfo: null, versionInfo: null })
  await syncAgreement()
  await uploadAgreement()
  expect(await productAgreementDetails()).toMatchObject({ accepted: true, upload: { state: "uploaded" } })
  expect(query).toHaveBeenCalledTimes(1)
  expect(sign).not.toHaveBeenCalled()
})

test("access-token refresh preserves the current admission", async () => {
  await using tmp = await setup()
  await login()
  await syncAgreement()
  await saveAuthToDisk("deveco", { access: "refreshed-access", expires: Date.now() + 60_000 })
  await uploadAgreement()
  expect((await agreementUploadStatus()).state).toBe("uploaded")
  expect(query).toHaveBeenCalledTimes(1)
})

test("a new process or login checks again despite the previous admission", async () => {
  await using tmp = await setup()
  await login()
  await syncAgreement()
  resetAgreementCheck()
  query.mockResolvedValue({ status: AgreementStatus.NEED_RE_SIGN, signInfo: null, versionInfo: null })
  await syncAgreement()
  expect(query).toHaveBeenCalledTimes(2)
  expect((await agreementUploadStatus()).state).toBe("review_required")
})

test.each(["startup", "login"] as const)("a compliant %s check clears an old review requirement", async (trigger) => {
  await using tmp = await setup()
  await login()
  query.mockResolvedValue({ status: AgreementStatus.NEED_RE_SIGN, signInfo: null, versionInfo: null })
  await syncAgreement()
  const previous = await productAgreementDetails()
  expect(previous.upload.state).toBe("review_required")

  query.mockResolvedValue({ status: AgreementStatus.COMPLIANT, signInfo: null, versionInfo: null })
  expect((await productAgreementDetails()).upload.state).toBe("review_required")
  expect(query).toHaveBeenCalledTimes(1)
  if (trigger === "startup") {
    resetAgreementCheck()
    await syncAgreement()
  }
  if (trigger === "login") {
    await Effect.runPromise(
      Auth.Service.use((auth) =>
        auth.set("deveco", {
          type: "oauth",
          access: "login-access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        }),
      ).pipe(Effect.provide(Auth.defaultLayer)),
    )
    await waitForAgreementSync()
  }

  expect(await productAgreementDetails()).toMatchObject({
    accepted: true,
    acceptedAt: previous.acceptedAt,
    upload: { state: "uploaded" },
  })
  const report = await Bun.file(
    `${tmp.path}/agreement-reports/${createHash("sha256").update("account-a").digest("hex")}.json`,
  ).json()
  expect(report.requiredRevision).toBeUndefined()
  expect(report.acceptedRevision).toBeUndefined()
  expect(report.uploadedAt).toBeNumber()
  await uploadAgreement()
  await productAgreementDetails()
  expect(query).toHaveBeenCalledTimes(2)
  expect(sign).not.toHaveBeenCalled()
})

test("explicit login resets admission even when the account and JWT stay the same", async () => {
  await using tmp = await setup()
  await login()
  await syncAgreement()
  query.mockResolvedValue({ status: AgreementStatus.NEED_RE_SIGN, signInfo: null, versionInfo: null })
  await Effect.runPromise(
    Auth.Service.use((auth) =>
      auth.set("deveco", {
        type: "oauth",
        access: "login-access",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      }),
    ).pipe(Effect.provide(Auth.defaultLayer)),
  )
  // Join the background upload started by the login before checking its result.
  await syncAgreement()
  expect(query).toHaveBeenCalledTimes(2)
  expect((await agreementUploadStatus()).state).toBe("review_required")
})

test("another process's report cannot revoke admission in this process", async () => {
  await using tmp = await setup()
  await login()
  await syncAgreement()
  const file = `${tmp.path}/agreement-reports/${createHash("sha256").update("account-a").digest("hex")}.json`
  const report = await Bun.file(file).json()
  await Bun.write(file, JSON.stringify({ ...report, requiredRevision: "external-update", uploadedAt: undefined }))
  expect((await agreementUploadStatus()).state).toBe("uploaded")
  await uploadAgreement()
  expect((await productAgreementDetails()).upload.state).toBe("uploaded")
  expect(query).toHaveBeenCalledTimes(1)
  expect((await Bun.file(file).json()).requiredRevision).toBe("external-update")
})

test("status reads never start a query, including after credentials appear", async () => {
  await using tmp = await setup()
  await productAgreementDetails()
  expect(query).not.toHaveBeenCalled()
  await login()
  await productAgreementDetails()
  expect(query).not.toHaveBeenCalled()
  await syncAgreement()
  expect(query).toHaveBeenCalledTimes(1)
  await tokenStorage.clearToken()
  expect((await productAgreementDetails()).upload.state).toBe("local")
  await login()
  await productAgreementDetails()
  expect(query).toHaveBeenCalledTimes(1)
  await syncAgreement()
  expect(query).toHaveBeenCalledTimes(2)
})

test("keeps anonymous consent local and uploads it after login", async () => {
  await using tmp = await setup()
  expect((await agreementUploadStatus()).state).toBe("local")
  expect(sign).not.toHaveBeenCalled()
  await login()
  await syncAgreement()
  expect(sign).toHaveBeenCalledTimes(1)
  await uploadAgreement()
  expect(query).toHaveBeenCalledTimes(1)
  expect(sign).toHaveBeenCalledTimes(1)
  expect((await agreementUploadStatus()).state).toBe("uploaded")
})

test("a failed upload remains pending even when the query successfully says unsigned", async () => {
  await using tmp = await setup()
  await login()
  sign.mockResolvedValue({ success: false, isUpload: false, error: "offline" })
  await syncAgreement()
  expect(await agreementUploadStatus()).toMatchObject({ state: "pending", error: "offline" })
  await syncAgreement()
  expect(sign).toHaveBeenCalledTimes(1)
  sign.mockResolvedValue({ success: true, isUpload: true })
  await uploadAgreement()
  expect((await agreementUploadStatus()).state).toBe("uploaded")
  expect(sign).toHaveBeenCalledTimes(2)
  expect(query).toHaveBeenCalledTimes(1)
})

test("query network errors do not prevent an upload attempt", async () => {
  await using tmp = await setup()
  await login()
  query.mockResolvedValue({ status: AgreementStatus.NETWORK_ERROR, signInfo: null, versionInfo: null })
  await syncAgreement()
  expect(sign).toHaveBeenCalledTimes(1)
  expect((await agreementUploadStatus()).state).toBe("uploaded")
})

test("does not reuse account A upload for account B", async () => {
  await using tmp = await setup()
  await login()
  await syncAgreement()
  await login("account-b")
  expect((await agreementUploadStatus()).state).toBe("pending")
  await syncAgreement()
  expect(sign.mock.calls.map((call) => call[0])).toEqual(["account-a-access", "account-b-access"])
})

test("joins concurrent upload requests", async () => {
  await using tmp = await setup()
  await login()
  await Promise.all([syncAgreement(), syncAgreement(), syncAgreement()])
  expect(sign).toHaveBeenCalledTimes(1)
})

test("does not upload or mark success after logout during the query", async () => {
  await using tmp = await setup()
  await login()
  query.mockImplementation(async () => {
    await tokenStorage.clearToken()
    return { status: AgreementStatus.NEED_SIGN, signInfo: null, versionInfo: null }
  })
  await syncAgreement()
  expect(sign).not.toHaveBeenCalled()
  expect((await agreementUploadStatus()).state).toBe("local")
})

test("a new login for the same account gets its own upload after an old attempt is discarded", async () => {
  await using tmp = await setup()
  await login()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  query.mockImplementationOnce(async () => {
    entered.resolve()
    await release.promise
    return { status: AgreementStatus.NEED_SIGN, signInfo: null, versionInfo: null }
  })
  const old = syncAgreement()
  await entered.promise
  await login("account-a", 1)
  const current = syncAgreement()
  release.resolve()
  await Promise.all([old, current])
  expect(sign).toHaveBeenCalledTimes(1)
  expect((await agreementUploadStatus()).state).toBe("uploaded")
})

test("resetting the login discards an old in-flight query even with the same JWT", async () => {
  await using tmp = await setup()
  await login()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  query.mockImplementationOnce(async () => {
    entered.resolve()
    await release.promise
    return { status: AgreementStatus.COMPLIANT, signInfo: null, versionInfo: null }
  })
  const old = syncAgreement()
  await entered.promise
  resetAgreementCheck()
  query.mockResolvedValue({ status: AgreementStatus.NEED_RE_SIGN, signInfo: null, versionInfo: null })
  const current = syncAgreement()
  release.resolve()
  await Promise.all([old, current])
  expect(query).toHaveBeenCalledTimes(2)
  expect(sign).not.toHaveBeenCalled()
  expect((await agreementUploadStatus()).state).toBe("review_required")
})

test("requires explicit acceptance of a changed service revision", async () => {
  await using tmp = await setup()
  await login()
  query.mockResolvedValue({ status: AgreementStatus.NEED_RE_SIGN, signInfo: null, versionInfo: null })
  await syncAgreement()
  const status = await agreementUploadStatus()
  expect(status.state).toBe("review_required")
  expect(sign).not.toHaveBeenCalled()
  await expect(acceptServiceRevision("stale")).rejects.toThrow("changed")
  await acceptServiceRevision(status.revision!)
  await uploadAgreement()
  expect(sign).toHaveBeenCalledTimes(1)
  expect((await agreementUploadStatus()).state).toBe("uploaded")
  expect(query).toHaveBeenCalledTimes(1)
})

test("acceptance waits for an in-flight login check and uploads without another query", async () => {
  await using tmp = await setup()
  await login()
  query.mockResolvedValue({ status: AgreementStatus.NEED_RE_SIGN, signInfo: null, versionInfo: null })
  await syncAgreement()
  const revision = (await agreementUploadStatus()).revision!
  resetAgreementCheck()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  query.mockImplementationOnce(async () => {
    entered.resolve()
    await release.promise
    return { status: AgreementStatus.NEED_RE_SIGN, signInfo: null, versionInfo: null }
  })
  const checking = syncAgreement()
  await entered.promise
  const acceptance = acceptProductAgreement(PRODUCT_AGREEMENT_VERSION, revision)
  release.resolve()
  await Promise.all([checking, acceptance])
  expect((await productAgreementDetails()).upload.state).toBe("uploaded")
  expect(query).toHaveBeenCalledTimes(2)
  expect(sign).toHaveBeenCalledTimes(1)
})

test("status names the expected revision before consent so one acceptance settles it", async () => {
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  Global.Path.data = tmp.path
  await login()
  query.mockResolvedValue({ status: AgreementStatus.NEED_RE_SIGN, signInfo: null, versionInfo: null })
  // A login cannot ask the service when no consent exists, so the panel would
  // otherwise accept with an empty revision and have to ask a second time.
  expect((await agreementUploadStatus()).state).toBe("not_signed")
  await observeAgreementRevision()
  const status = await agreementUploadStatus()
  expect(status.state).toBe("not_signed")
  expect(status.revision).toBeTruthy()
  expect(sign).not.toHaveBeenCalled()
  // The one acceptance the panel collects carries exactly what the service asks,
  // so it settles the requirement instead of starting a second round.
  await acceptProductAgreement(PRODUCT_AGREEMENT_VERSION, status.revision)
  await waitForAgreementSync()
  expect(sign).toHaveBeenCalledTimes(1)
  expect((await agreementUploadStatus()).state).toBe("uploaded")
})

test("the login observation leaves an accepted account alone", async () => {
  await using tmp = await setup()
  await login()
  query.mockClear()
  await observeAgreementRevision()
  // Consent already exists, so the login has nothing to observe and no query of
  // its own is issued; the regular sync stays the only one that may ask.
  expect(query).not.toHaveBeenCalled()
  expect((await productAgreementDetails()).accepted).toBe(true)
})

test("never uploads without local product consent", async () => {
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  Global.Path.data = tmp.path
  await login()
  await syncAgreement()
  expect((await agreementUploadStatus()).state).toBe("not_signed")
  expect(query).not.toHaveBeenCalled()
  expect(sign).not.toHaveBeenCalled()
})

test("plugin mode with flag skips TMS query and returns local status", async () => {
  await using tmp = await setup()
  await login()
  runtimeState.mode = "deveco-studio"
  process.env.DEVECO_ALWAYS_ACCEPT_AGREEMENT = "true"
  await syncAgreement()
  expect(query).not.toHaveBeenCalled()
  expect(sign).not.toHaveBeenCalled()
  expect((await agreementUploadStatus()).state).toBe("local")
  await syncAgreement()
  expect(query).not.toHaveBeenCalled()
})

test("plugin mode without flag behaves like CLI mode", async () => {
  await using tmp = await setup()
  await login()
  runtimeState.mode = "deveco-studio"
  query.mockResolvedValue({ status: AgreementStatus.NEED_RE_SIGN, signInfo: null, versionInfo: null })
  await syncAgreement()
  expect(query).toHaveBeenCalledTimes(1)
  expect((await agreementUploadStatus()).state).toBe("review_required")
})

test("plugin mode returns not_signed when product not accepted locally", async () => {
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  Global.Path.data = tmp.path
  runtimeState.mode = "deveco-studio"
  process.env.DEVECO_ALWAYS_ACCEPT_AGREEMENT = "true"
  await login()
  expect((await agreementUploadStatus()).state).toBe("not_signed")
  expect(query).not.toHaveBeenCalled()
})
