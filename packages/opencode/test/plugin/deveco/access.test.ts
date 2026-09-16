import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { requireDevEcoAccess, clearDevEcoAccess } from "@/plugin/deveco/access"
import { saveAuthToDisk, loadAccessTokenFromDisk } from "@/plugin/deveco/storage"
import { tokenStorage } from "@/plugin/deveco/token-storage"
import { AgreementService, AgreementStatus } from "@/cli/deveco-agreement"
import { acceptProductAgreement, PRODUCT_AGREEMENT_VERSION } from "@/cli/deveco-product-agreement"
import { syncAgreement, stopAgreementSync } from "@/cli/deveco-agreement-sync"
import { regionPolicy } from "@/plugin/deveco/region-policy"
import { tmpdir } from "../../fixture/fixture"

import { devecoAuth } from "@/plugin/deveco/auth"

const realName = spyOn(devecoAuth, "checkRealName")
const data = Global.Path.data
const state = Global.Path.state
const region = spyOn(regionPolicy, "checkAccess")
const agreement = spyOn(AgreementService.prototype, "queryAgreement")
const sign = spyOn(AgreementService.prototype, "signAgreement")
const jwt = (userId: string) => `e30.${Buffer.from(JSON.stringify({ userId })).toString("base64url")}.test`

beforeEach(() => {
  clearDevEcoAccess()
  realName.mockReset().mockResolvedValue(false)
  region.mockReset().mockResolvedValue({ allowed: true })
  sign.mockReset().mockResolvedValue({ success: true, isUpload: true })
  agreement.mockReset().mockResolvedValue({ status: AgreementStatus.COMPLIANT, signInfo: null, versionInfo: null })
})

afterEach(async () => {
  stopAgreementSync()
  Global.Path.data = data
  Global.Path.state = state
  await tokenStorage.clearToken()
  clearDevEcoAccess()
})

afterAll(() => {
  realName.mockRestore()
  region.mockRestore()
  agreement.mockRestore()
  sign.mockRestore()
})

async function signIn(verified = true) {
  await tokenStorage.clearToken()
  await acceptProductAgreement(PRODUCT_AGREEMENT_VERSION)
  await syncAgreement()
  await tokenStorage.saveToken(jwt("test-user"))
  await saveAuthToDisk("deveco", {
    type: "oauth",
    access: "test-access",
    refresh: "test-refresh",
    expires: Date.now() + 60000,
    isRealName: verified,
  })
}

describe("built-in provider access", () => {
  test("requires an account without contacting the agreement service", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    await expect(requireDevEcoAccess()).rejects.toThrow("Sign in")
    expect(agreement).not.toHaveBeenCalled()
  })

  test("requires real-name verification even with a valid access token", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    await signIn(false)
    await expect(requireDevEcoAccess()).rejects.toThrow("real-name")
    expect(agreement).not.toHaveBeenCalled()
  })

  test("rechecks a previously unverified account and uses the rotated token for agreements", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    Global.Path.state = tmp.path
    await signIn(false)
    realName.mockImplementation(async () => {
      await saveAuthToDisk("deveco", {
        type: "oauth",
        access: "verified-access",
        refresh: "refresh",
        expires: Date.now() + 60000,
        isRealName: true,
      })
      return true
    })
    expect(await requireDevEcoAccess()).toBe("verified-access")
    expect(agreement.mock.calls[0]?.[0]).toBe("verified-access")
    expect(await requireDevEcoAccess()).toBe("verified-access")
    expect(realName).toHaveBeenCalledTimes(1)
  })

  test("shares an in-flight real-name check between concurrent requests", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    Global.Path.state = tmp.path
    await signIn(false)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    realName.mockImplementation(async () => {
      entered.resolve()
      await release.promise
      await saveAuthToDisk("deveco", {
        type: "oauth",
        access: "verified-access",
        refresh: "refresh",
        expires: Date.now() + 60000,
        isRealName: true,
      })
      return true
    })
    const first = requireDevEcoAccess()
    await entered.promise
    const second = requireDevEcoAccess()
    release.resolve()
    expect(await Promise.all([first, second])).toEqual(["verified-access", "verified-access"])
    expect(realName).toHaveBeenCalledTimes(1)
  })

  test("throttles failed real-name checks and clears the throttle on logout", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    await signIn(false)
    await expect(requireDevEcoAccess()).rejects.toThrow("real-name")
    await expect(requireDevEcoAccess()).rejects.toThrow("30 seconds")
    expect(realName).toHaveBeenCalledTimes(1)
    expect(agreement).not.toHaveBeenCalled()
    clearDevEcoAccess()
    await expect(requireDevEcoAccess()).rejects.toThrow("real-name")
    expect(realName).toHaveBeenCalledTimes(2)
  })

  test("keeps network failure guidance during the real-name retry interval", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    await signIn(false)
    realName.mockResolvedValue(null)
    await expect(requireDevEcoAccess()).rejects.toThrow("Check your network")
    await expect(requireDevEcoAccess()).rejects.toThrow("Check your network")
    expect(realName).toHaveBeenCalledTimes(1)
    expect(agreement).not.toHaveBeenCalled()
  })

  test("allows real-name rechecking after the retry interval", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    await signIn(false)
    await expect(requireDevEcoAccess()).rejects.toThrow("real-name")
    const now = spyOn(Date, "now").mockReturnValue(Date.now() + 30_001)
    try {
      await expect(requireDevEcoAccess()).rejects.toThrow("real-name")
      expect(realName).toHaveBeenCalledTimes(2)
    } finally {
      now.mockRestore()
    }
  })

  test("does not apply a failed real-name check to a different account", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    await signIn(false)
    await expect(requireDevEcoAccess()).rejects.toThrow("real-name")
    await tokenStorage.saveToken(jwt("another-user"))
    await expect(requireDevEcoAccess()).rejects.toThrow("real-name")
    expect(realName).toHaveBeenCalledTimes(2)
  })

  test("rejects service revisions that need renewed consent", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    Global.Path.state = tmp.path
    await signIn()
    agreement.mockResolvedValue({ status: AgreementStatus.NEED_RE_SIGN, signInfo: null, versionInfo: null })
    await expect(requireDevEcoAccess()).rejects.toThrow("agreements")
  })

  test("allows a locally accepted account when TMS upload fails", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    Global.Path.state = tmp.path
    await signIn()
    agreement.mockResolvedValue({ status: AgreementStatus.NEED_SIGN, signInfo: null, versionInfo: null })
    sign.mockResolvedValue({ success: false, isUpload: false, error: "offline" })
    expect(await requireDevEcoAccess()).toBe("test-access")
    expect(sign).toHaveBeenCalledTimes(1)
  })

  test("rechecks real-name status after agreement token refresh", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    Global.Path.state = tmp.path
    await signIn()
    agreement.mockImplementation(async () => {
      await saveAuthToDisk("deveco", { isRealName: false })
      return { status: AgreementStatus.COMPLIANT, signInfo: null, versionInfo: null }
    })
    await expect(requireDevEcoAccess()).rejects.toThrow("real-name")
  })

  test("cached agreement approval does not survive credential removal", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    Global.Path.state = tmp.path
    await signIn()
    expect(await requireDevEcoAccess()).toBe("test-access")
    expect(await requireDevEcoAccess()).toBe("test-access")
    expect(agreement).toHaveBeenCalledTimes(1)
    await saveAuthToDisk("deveco", null)
    await expect(requireDevEcoAccess()).rejects.toThrow("Sign in")
  })

  test("discarded refresh cannot restore a removed account or overwrite a third-party key", async () => {
    await using tmp = await tmpdir()
    Global.Path.data = tmp.path
    await signIn()
    await saveAuthToDisk("other", { type: "api", key: "third-party-key" })
    await saveAuthToDisk("deveco", null)
    await expect(saveAuthToDisk("deveco", { type: "oauth", access: "late-refresh" }, "test-access")).rejects.toThrow(
      "changed",
    )
    expect(loadAccessTokenFromDisk()).toBe("")
    const { LocalCrypto } = await import("@/security/local-crypto")
    const saved = LocalCrypto.decryptAuthData(await Bun.file(`${tmp.path}/auth.json`).json())
    expect(saved.other).toEqual({ type: "api", key: "third-party-key" })
  })
})
