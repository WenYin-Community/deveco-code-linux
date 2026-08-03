import { describe, expect, test } from "bun:test"
import { RegionPolicy } from "@/plugin/deveco/region-policy"

describe("RegionPolicy", () => {
  test("allows the canonical Mainland China timezones", async () => {
    for (const timezone of ["Asia/Shanghai", "Asia/Urumqi"]) {
      expect(
        await new RegionPolicy({ timezone: () => timezone, timezoneOffset: () => 0 }).checkAccess(),
      ).toEqual({ allowed: true })
    }
  })

  test("allows supported legacy China timezone aliases", async () => {
    for (const timezone of ["Asia/Chongqing", "Asia/Chungking", "Asia/Harbin", "Asia/Kashgar", "PRC"]) {
      expect(
        await new RegionPolicy({ timezone: () => timezone, timezoneOffset: () => 0 }).checkAccess(),
      ).toEqual({ allowed: true })
    }
  })

  test("allows Hong Kong, Macau, and Taiwan timezones", async () => {
    for (const timezone of ["Asia/Hong_Kong", "Asia/Macau", "Asia/Taipei", "Etc/GMT-8"]) {
      expect(
        await new RegionPolicy({ timezone: () => timezone, timezoneOffset: () => 0 }).checkAccess(),
      ).toEqual({ allowed: true })
    }
  })

  test("allows non-whitelist timezones when offset is UTC+8", async () => {
    for (const timezone of ["Asia/Singapore", "Asia/Kuala_Lumpur", "Asia/Manila"]) {
      expect(
        await new RegionPolicy({ timezone: () => timezone, timezoneOffset: () => -480 }).checkAccess(),
      ).toEqual({ allowed: true })
    }
  })

  test("rejects non-whitelist timezones when offset is not UTC+8", async () => {
    for (const timezone of ["Asia/Singapore", "Asia/Kuala_Lumpur", "Asia/Manila"]) {
      expect(
        await new RegionPolicy({
          timezone: () => timezone,
          timezoneOffset: () => 0,
          systemRegion: () => "",
        }).checkAccess(),
      ).toEqual({ allowed: false, reason: "timezone" })
    }
  })

  test("rejects European and American timezones", async () => {
    for (const timezone of ["Europe/Berlin", "Europe/London", "Europe/Paris", "Europe/Moscow", "America/New_York"]) {
      expect(
        await new RegionPolicy({
          timezone: () => timezone,
          timezoneOffset: () => 0,
          systemRegion: () => "",
        }).checkAccess(),
      ).toEqual({ allowed: false, reason: "timezone" })
    }
  })

  test("allows CN system region when timezone and offset do not match", async () => {
    const policy = new RegionPolicy({
      timezone: () => "Europe/London",
      timezoneOffset: () => 0,
      systemRegion: () => "CN",
    })
    expect(await policy.checkAccess()).toEqual({ allowed: true })
  })

  test("normalizes the system region", async () => {
    const policy = new RegionPolicy({
      timezone: () => "Europe/London",
      timezoneOffset: () => 0,
      systemRegion: () => " cn ",
    })
    expect(await policy.checkAccess()).toEqual({ allowed: true })
  })

  test("does not allow non-CN system regions", async () => {
    for (const region of ["US", "GB", "HK", "MO", "TW"]) {
      const policy = new RegionPolicy({
        timezone: () => "Europe/London",
        timezoneOffset: () => 0,
        systemRegion: () => region,
      })
      expect(await policy.checkAccess()).toEqual({ allowed: false, reason: "timezone" })
    }
  })

  test("fails closed when the timezone cannot be read", async () => {
    const policy = new RegionPolicy({
      timezone: () => {
        throw new Error("timezone unavailable")
      },
      timezoneOffset: () => 0,
      systemRegion: () => "",
    })
    expect(await policy.checkAccess()).toEqual({ allowed: false, reason: "timezone" })
  })

  test("fails closed when all local signals are unavailable", async () => {
    const policy = new RegionPolicy({
      timezone: () => {
        throw new Error("timezone unavailable")
      },
      timezoneOffset: () => {
        throw new Error("offset unavailable")
      },
      systemRegion: () => {
        throw new Error("region unavailable")
      },
    })
    expect(await policy.checkAccess()).toEqual({ allowed: false, reason: "timezone" })
  })
})
