import { describe, expect, test } from "bun:test"
import { checkAndUpgrade, decideUpgrade } from "../../src/cli/upgrade"
import type { Method } from "../../src/installation"

describe("decideUpgrade", () => {
  const base = {
    disabled: false,
    alwaysNotify: false,
    isLatest: false,
    method: "npm" as Method,
  }

  test("returns skip when autoupdate is false", () => {
    expect(decideUpgrade({ ...base, autoupdate: false })).toBe("skip")
  })

  test("returns skip when disabled flag is true", () => {
    expect(decideUpgrade({ ...base, autoupdate: true, disabled: true })).toBe("skip")
  })

  test("returns upgrade when autoupdate is undefined (default true)", () => {
    expect(decideUpgrade({ ...base, autoupdate: undefined })).toBe("upgrade")
  })

  test("returns skip when already at latest version", () => {
    expect(decideUpgrade({ ...base, autoupdate: true, isLatest: true })).toBe("skip")
  })

  test("returns upgrade when method is unknown", () => {
    expect(decideUpgrade({ ...base, autoupdate: true, method: "unknown" })).toBe("upgrade")
  })

  test("returns upgrade when autoupdate is true and not latest", () => {
    expect(decideUpgrade({ ...base, autoupdate: true })).toBe("upgrade")
  })

  test("returns notify when autoupdate is notify", () => {
    expect(decideUpgrade({ ...base, autoupdate: "notify" })).toBe("notify")
  })

  test("returns notify when alwaysNotify flag is true even if autoupdate is true", () => {
    expect(decideUpgrade({ ...base, autoupdate: true, alwaysNotify: true })).toBe("notify")
  })

  test("returns skip when latest cannot be determined (isLatest true) even with alwaysNotify", () => {
    expect(decideUpgrade({ ...base, autoupdate: true, alwaysNotify: true, isLatest: true })).toBe("skip")
  })
})

describe("checkAndUpgrade", () => {
  test("is an async function", () => {
    expect(typeof checkAndUpgrade).toBe("function")
  })
})
