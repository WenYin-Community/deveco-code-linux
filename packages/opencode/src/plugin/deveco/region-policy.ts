export const MAINLAND_CHINA_ONLY_MESSAGE = "DevEco Code is currently only available in Mainland China."
export const CHINA_ACCOUNT_ONLY_MESSAGE = "DevEco Code currently only supports China-region accounts."
export const ACCOUNT_REGION_UNVERIFIED_MESSAGE =
  "Unable to verify whether this is a China-region account. Please check your network and try again."

export type RegionAccessResult = { allowed: true } | { allowed: false; reason: "timezone" }

type RegionPolicyConfig = {
  timezone?: () => string
}

const EUROPEAN_TIMEZONE_PREFIX = "Europe/"

const EUROPEAN_TIMEZONES = new Set([
  // European regions outside the Europe/ namespace
  "Atlantic/Azores",
  "Atlantic/Canary",
  "Atlantic/Faroe",
  "Atlantic/Faeroe",
  "Atlantic/Madeira",
  "Atlantic/Reykjavik",
  "Arctic/Longyearbyen",
  "Atlantic/Jan_Mayen",

  // EU member-state territory and jurisdictions
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

  // Other European-country territory and jurisdictions
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

  // Historical or compatibility aliases
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
  "W-SU",
])

function isEuropeanTimezone(timezone: string): boolean {
  return timezone.startsWith(EUROPEAN_TIMEZONE_PREFIX) || EUROPEAN_TIMEZONES.has(timezone)
}

export class RegionPolicy {
  constructor(private config: RegionPolicyConfig = {}) {}

  public async checkAccess(): Promise<RegionAccessResult> {
    const timezone = this.getTimezone()

    if (timezone && isEuropeanTimezone(timezone)) return { allowed: false, reason: "timezone" }

    return { allowed: true }
  }

  private getTimezone(): string | undefined {
    try {
      return (this.config.timezone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone))()
    } catch {
      return undefined
    }
  }
}

export const regionPolicy = new RegionPolicy()
