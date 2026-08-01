export const MAINLAND_CHINA_ONLY_MESSAGE = "DevEco Code is currently only available in Mainland China."
export const CHINA_ACCOUNT_ONLY_MESSAGE = "DevEco Code currently only supports China-region accounts."
export const ACCOUNT_REGION_UNVERIFIED_MESSAGE =
  "Unable to verify whether this is a China-region account. Please check your network and try again."

export type RegionAccessResult = { allowed: true } | { allowed: false; reason: "timezone" }

type RegionPolicyConfig = {
  timezone?: () => string
}

const CHINA_TIMEZONES = new Set([
  "Asia/Shanghai",
  "Asia/Urumqi",
  "Asia/Chongqing",
  "Asia/Chungking",
  "Asia/Harbin",
  "Asia/Kashgar",
  "PRC",
])

export class RegionPolicy {
  constructor(private config: RegionPolicyConfig = {}) {}

  public async checkAccess(): Promise<RegionAccessResult> {
    const timezone = this.getTimezone()
    if (!CHINA_TIMEZONES.has(timezone)) return { allowed: false, reason: "timezone" }
    return { allowed: true }
  }

  private getTimezone(): string {
    try {
      return (this.config.timezone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone))()
    } catch {
      return ""
    }
  }
}

export const regionPolicy = new RegionPolicy()
