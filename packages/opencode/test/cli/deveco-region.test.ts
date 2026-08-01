import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { ensureMainlandChinaCliAccess } from "@/cli/deveco-region"
import { UI } from "@/cli/ui"
import { regionPolicy } from "@/plugin/deveco/region-policy"

const regionCheckSpy = spyOn(regionPolicy, "checkAccess")
const uiErrorSpy = spyOn(UI, "error")
const originalExitCode = process.exitCode

beforeEach(() => {
  regionCheckSpy.mockReset().mockResolvedValue({ allowed: true })
  uiErrorSpy.mockReset()
  process.exitCode = originalExitCode
})

afterAll(() => {
  regionCheckSpy.mockRestore()
  uiErrorSpy.mockRestore()
  process.exitCode = originalExitCode
})

describe("ensureMainlandChinaCliAccess", () => {
  test("allows TUI startup in a Mainland China timezone", async () => {
    expect(await ensureMainlandChinaCliAccess()).toBe(true)
    expect(uiErrorSpy).not.toHaveBeenCalled()
  })

  test("blocks startup and prints the Mainland China restriction", async () => {
    regionCheckSpy.mockResolvedValue({ allowed: false, reason: "timezone" })

    expect(await ensureMainlandChinaCliAccess()).toBe(false)
    expect(uiErrorSpy).toHaveBeenCalledWith("DevEco Code is currently only available in Mainland China.")
    expect(process.exitCode).toBe(1)
  })
})
