import { afterEach, expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { productAgreement, acceptProductAgreement, PRODUCT_AGREEMENT_VERSION } from "@/cli/deveco-product-agreement"
import { tmpdir } from "../fixture/fixture"

const originalState = Global.Path.state
afterEach(() => {
  Global.Path.state = originalState
})

test("product acceptance is local and does not require a HUAWEI credential", async () => {
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  expect((await productAgreement()).accepted).toBe(false)
  expect((await acceptProductAgreement(PRODUCT_AGREEMENT_VERSION)).accepted).toBe(true)
  expect((await productAgreement()).accepted).toBe(true)
})

test("a stale version or corrupt acceptance does not complete setup", async () => {
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  await expect(acceptProductAgreement("outdated")).rejects.toThrow("changed")
  expect((await productAgreement()).accepted).toBe(false)
  await Bun.write(`${tmp.path}/product-agreement.json`, "invalid")
  expect((await productAgreement()).accepted).toBe(false)
})

test("runtime skip environment cannot bypass product consent", async () => {
  const { spyOn } = await import("bun:test")
  const { regionPolicy } = await import("@/plugin/deveco/region-policy")
  const { requireProductAccess } = await import("@/cli/deveco-product-agreement")
  const region = spyOn(regionPolicy, "checkAccess").mockResolvedValue({ allowed: true })
  const original = process.env.DEVECO_SKIP_AGREEMENT
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  process.env.DEVECO_SKIP_AGREEMENT = "1"
  try {
    await expect(requireProductAccess()).rejects.toThrow("Review the product agreements")
    await acceptProductAgreement(PRODUCT_AGREEMENT_VERSION)
    await requireProductAccess()
  } finally {
    region.mockRestore()
    if (original === undefined) delete process.env.DEVECO_SKIP_AGREEMENT
    if (original !== undefined) process.env.DEVECO_SKIP_AGREEMENT = original
  }
})
