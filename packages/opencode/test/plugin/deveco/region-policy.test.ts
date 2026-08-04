import { describe, expect, test } from "bun:test"
import { RegionPolicy } from "@/plugin/deveco/region-policy"

describe("RegionPolicy", () => {
  test("rejects Europe timezones", async () => {
    for (const timezone of [
      "Europe/Berlin",
      "Europe/London",
      "Europe/Paris",
      "Europe/Moscow",
      "Europe/Istanbul",
      "Europe/Kyiv",
      "Europe/Kiev",
    ]) {
      expect(await new RegionPolicy({ timezone: () => timezone }).checkAccess()).toEqual({
        allowed: false,
        reason: "timezone",
      })
    }
  })

  test("rejects European Atlantic and legacy timezones", async () => {
    for (const timezone of [
      "Atlantic/Azores",
      "Atlantic/Canary",
      "Atlantic/Madeira",
      "Atlantic/Faroe",
      "Atlantic/Faeroe",
      "Atlantic/Reykjavik",
      "Arctic/Longyearbyen",
      "Atlantic/Jan_Mayen",
      "CET",
      "EET",
      "WET",
      "MET",
      "GB",
      "GB-Eire",
      "Eire",
      "Iceland",
      "Poland",
      "Portugal",
      "Turkey",
      "Asia/Istanbul",
    ]) {
      expect(await new RegionPolicy({ timezone: () => timezone }).checkAccess()).toEqual({
        allowed: false,
        reason: "timezone",
      })
    }
  })

  test("rejects EU member-state territory and jurisdictions", async () => {
    for (const timezone of [
      "Africa/Ceuta",
      "Asia/Nicosia",
      "Asia/Famagusta",
      "America/Cayenne",
      "America/Guadeloupe",
      "America/Marigot",
      "America/Martinique",
      "America/Miquelon",
      "America/St_Barthelemy",
      "Indian/Kerguelen",
      "Indian/Mayotte",
      "Indian/Reunion",
      "Pacific/Gambier",
      "Pacific/Marquesas",
      "Pacific/Noumea",
      "Pacific/Tahiti",
      "Pacific/Wallis",
      "Antarctica/DumontDUrville",
      "America/Danmarkshavn",
      "America/Nuuk",
      "America/Godthab",
      "America/Scoresbysund",
      "America/Thule",
      "America/Aruba",
      "America/Curacao",
      "America/Kralendijk",
      "America/Lower_Princes",
    ]) {
      expect(await new RegionPolicy({ timezone: () => timezone }).checkAccess()).toEqual({
        allowed: false,
        reason: "timezone",
      })
    }
  })

  test("rejects other European-country territory and jurisdictions", async () => {
    for (const timezone of [
      "America/Anguilla",
      "America/Cayman",
      "America/Grand_Turk",
      "America/Montserrat",
      "America/Tortola",
      "Atlantic/Bermuda",
      "Atlantic/South_Georgia",
      "Atlantic/Stanley",
      "Atlantic/St_Helena",
      "Indian/Chagos",
      "Pacific/Pitcairn",
      "Antarctica/Rothera",
      "Antarctica/Troll",
      "Asia/Yerevan",
      "Asia/Baku",
      "Asia/Tbilisi",
      "Asia/Almaty",
      "Asia/Aqtau",
      "Asia/Aqtobe",
      "Asia/Atyrau",
      "Asia/Oral",
      "Asia/Qostanay",
      "Asia/Qyzylorda",
      "Asia/Anadyr",
      "Asia/Barnaul",
      "Asia/Chita",
      "Asia/Irkutsk",
      "Asia/Kamchatka",
      "Asia/Khandyga",
      "Asia/Krasnoyarsk",
      "Asia/Magadan",
      "Asia/Novokuznetsk",
      "Asia/Novosibirsk",
      "Asia/Omsk",
      "Asia/Sakhalin",
      "Asia/Srednekolymsk",
      "Asia/Tomsk",
      "Asia/Ust-Nera",
      "Asia/Vladivostok",
      "Asia/Yakutsk",
      "Asia/Yekaterinburg",
      "W-SU",
    ]) {
      expect(await new RegionPolicy({ timezone: () => timezone }).checkAccess()).toEqual({
        allowed: false,
        reason: "timezone",
      })
    }
  })

  test("allows non-European timezones", async () => {
    for (const timezone of [
      "Asia/Shanghai",
      "Asia/Urumqi",
      "Asia/Hong_Kong",
      "Asia/Macau",
      "Asia/Taipei",
      "Asia/Singapore",
      "Etc/GMT-8",
      "America/New_York",
      "America/Los_Angeles",
      "Africa/Cairo",
      "Australia/Perth",
    ]) {
      expect(await new RegionPolicy({ timezone: () => timezone }).checkAccess()).toEqual({ allowed: true })
    }
  })

  test("allows access when timezone cannot be read", async () => {
    const policy = new RegionPolicy({
      timezone: () => {
        throw new Error("timezone unavailable")
      },
    })

    expect(await policy.checkAccess()).toEqual({ allowed: true })
  })

  test("does not reject non-Europe prefixes", async () => {
    for (const timezone of ["Etc/Europe", "EuropeFake/Berlin", "America/Europe_City"]) {
      expect(await new RegionPolicy({ timezone: () => timezone }).checkAccess()).toEqual({ allowed: true })
    }
  })
})
