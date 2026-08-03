import { readSystemRegion } from "./system-region"

export const MAINLAND_CHINA_ONLY_MESSAGE = "DevEco Code is currently only available in Mainland China."
export const CHINA_ACCOUNT_ONLY_MESSAGE = "DevEco Code currently only supports China-region accounts."
export const ACCOUNT_REGION_UNVERIFIED_MESSAGE =
  "Unable to verify whether this is a China-region account. Please check your network and try again."

export type RegionAccessResult = { allowed: true } | { allowed: false; reason: "timezone" }

type RegionPolicyConfig = {
  timezone?: () => string
  timezoneOffset?: () => number
  systemRegion?: () => string | Promise<string>
}

const UTC_PLUS_EIGHT_OFFSET_MINUTES = -8 * 60

const CHINA_TIMEZONES = new Set([
  "Asia/Shanghai",
  "Asia/Urumqi",
  "Asia/Chongqing",
  "Asia/Chungking",
  "Asia/Harbin",
  "Asia/Kashgar",
  "Asia/Hong_Kong",
  "Asia/Macau",
  "Asia/Taipei",
  "Etc/GMT-8",
  "PRC",
])

export class RegionPolicy {
  constructor(private config: RegionPolicyConfig = {}) {}

  public async checkAccess(): Promise<RegionAccessResult> {
    const timezone = this.getTimezone()
    if (CHINA_TIMEZONES.has(timezone)) return { allowed: true }
    if (this.getTimezoneOffset() === UTC_PLUS_EIGHT_OFFSET_MINUTES) return { allowed: true }
    if ((await this.getSystemRegion()) === "CN") return { allowed: true }
    return { allowed: false, reason: "timezone" }
  }

  private getTimezone(): string {
    try {
      return (this.config.timezone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone))()
    } catch {
      return ""
    }
  }

  private getTimezoneOffset(): number | undefined {
    try {
      return (this.config.timezoneOffset ?? (() => new Date().getTimezoneOffset()))()
    } catch {
      return undefined
    }
  }

  private systemRegionPromise?: Promise<string>

  private getSystemRegion(): Promise<string> {
    if (!this.systemRegionPromise) {
      this.systemRegionPromise = Promise.resolve()
        .then(() => (this.config.systemRegion ? this.config.systemRegion() : readSystemRegion()))
        .then((region) => region.trim().toUpperCase())
        .catch(() => "")
    }
    return this.systemRegionPromise
  }
}

export const regionPolicy = new RegionPolicy()
