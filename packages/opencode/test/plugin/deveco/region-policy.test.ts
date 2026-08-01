import { describe, expect, test } from "bun:test"
import { RegionPolicy } from "@/plugin/deveco/region-policy"

describe("RegionPolicy", () => {
  test("allows the canonical Mainland China timezones", async () => {
    for (const timezone of ["Asia/Shanghai", "Asia/Urumqi"]) {
      expect(await new RegionPolicy({ timezone: () => timezone }).checkAccess()).toEqual({ allowed: true })
    }
  })

  test("allows supported legacy China timezone aliases", async () => {
    for (const timezone of ["Asia/Chongqing", "Asia/Chungking", "Asia/Harbin", "Asia/Kashgar", "PRC"]) {
      expect(await new RegionPolicy({ timezone: () => timezone }).checkAccess()).toEqual({ allowed: true })
    }
  })

  test("rejects European timezones", async () => {
    for (const timezone of ["Europe/Berlin", "Europe/London", "Europe/Paris", "Europe/Moscow"]) {
      expect(await new RegionPolicy({ timezone: () => timezone }).checkAccess()).toEqual({
        allowed: false,
        reason: "timezone",
      })
    }
  })

  test("rejects non-Mainland-China UTC+8 timezones", async () => {
    for (const timezone of ["Asia/Hong_Kong", "Asia/Macau", "Asia/Taipei", "Asia/Singapore", "Etc/GMT-8"]) {
      expect(await new RegionPolicy({ timezone: () => timezone }).checkAccess()).toEqual({
        allowed: false,
        reason: "timezone",
      })
    }
  })

  test("fails closed when the timezone cannot be read", async () => {
    const policy = new RegionPolicy({
      timezone: () => {
        throw new Error("timezone unavailable")
      },
    })
    expect(await policy.checkAccess()).toEqual({ allowed: false, reason: "timezone" })
  })
})
