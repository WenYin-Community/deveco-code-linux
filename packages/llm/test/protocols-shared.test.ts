import { describe, expect, test } from "bun:test"
import { ProviderShared } from "../src/protocols/shared"

describe("ProviderShared.errorText", () => {
  test("uses the Error message when present", () => {
    expect(ProviderShared.errorText(new Error("boom"))).toBe("boom")
  })

  test("passes strings through unchanged", () => {
    expect(ProviderShared.errorText("text")).toBe("text")
  })

  test("stringifies number, boolean, and bigint errors", () => {
    expect(ProviderShared.errorText(42)).toBe("42")
    expect(ProviderShared.errorText(true)).toBe("true")
    expect(ProviderShared.errorText(10n)).toBe("10")
  })

  test("renders null and undefined literally", () => {
    expect(ProviderShared.errorText(null)).toBe("null")
    expect(ProviderShared.errorText(undefined)).toBe("undefined")
  })

  test("falls back to a stable message for unrecognized error shapes", () => {
    expect(ProviderShared.errorText({ toString: () => "x" })).toBe("Unknown stream error")
  })
})
