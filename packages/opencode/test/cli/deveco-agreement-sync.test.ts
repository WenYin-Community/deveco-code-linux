import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { AgreementService, AgreementStatus } from "@/cli/deveco-agreement"
import {
  agreementUploadStatus,
  syncAgreement,
  stopAgreementSync,
  acceptServiceRevision,
} from "@/cli/deveco-agreement-sync"
import { acceptProductAgreement, PRODUCT_AGREEMENT_VERSION } from "@/cli/deveco-product-agreement"
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
  stopAgreementSync()
  await tokenStorage.clearToken()
  Global.Path.state = original.state
  Global.Path.data = original.data
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

describe("durable agreement upload", () => {
  test("keeps anonymous consent local and uploads it after login", async () => {
    await using tmp = await setup()
    expect((await agreementUploadStatus()).state).toBe("local")
    expect(sign).not.toHaveBeenCalled()
    await login()
    await syncAgreement()
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
    stopAgreementSync()
    sign.mockResolvedValue({ success: true, isUpload: true })
    await syncAgreement(true)
    expect((await agreementUploadStatus()).state).toBe("uploaded")
    expect(sign).toHaveBeenCalledTimes(2)
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
    await syncAgreement(true)
    expect(sign).toHaveBeenCalledTimes(1)
    expect((await agreementUploadStatus()).state).toBe("uploaded")
  })

  test("never uploads without local product consent", async () => {
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    Global.Path.data = tmp.path
    await login()
    await syncAgreement(true)
    expect((await agreementUploadStatus()).state).toBe("not_signed")
    expect(query).not.toHaveBeenCalled()
    expect(sign).not.toHaveBeenCalled()
  })
})
