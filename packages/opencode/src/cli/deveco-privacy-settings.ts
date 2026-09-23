import path from "path"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"

export const ANALYTICS_ENABLED_KEY = "analytics_enabled"
export const TOOL_IMPROVEMENT_ENABLED_KEY = "deveco_tool_improvement_enabled"
export const TOOL_IMPROVEMENT_HEADER = "X-DevEco-Improvement-Enabled"

/**
 * P9 fix (2026-09-23): derive the lock directory from the injected `state`
 * instead of relying on Flock's global default (`Global.Path.state/locks`).
 * Production behaviour is unchanged (the default state IS Global.Path.state),
 * but tests that inject a temp state dir now keep their lock files inside it —
 * matching what `plugin/deveco/improvement-consent.ts` does deliberately.
 */
const privacyLockDir = (state: string) => path.join(state, "locks")

export async function readPrivacyBoolean(key: string, fallback: boolean, state = Global.Path.state) {
  const file = path.join(state, "kv.json")
  try {
    // Reads are protected from concurrent privacy readers without contending
    // with the TUI's long-lived writer lock; its writes use atomic rename.
    const kv = await Flock.withLock(
      `privacy-kv:${file}`,
      () => Filesystem.readJson<Record<string, unknown>>(file),
      { dir: privacyLockDir(state) },
    )
    return typeof kv[key] === "boolean" ? kv[key] : fallback
  } catch {
    return fallback
  }
}

/**
 * Undefined-aware read of the device-level improvement key (D7 legacy claim).
 *
 * readPrivacyBoolean cannot distinguish "key absent" from "key is false" — both
 * yield the fallback — while the one-time legacy claim must only adopt an
 * explicit historical toggle. Key absent or store unreadable → undefined
 * (treated as "never toggled", the safe direction); present → its boolean.
 */
export async function readToolImprovementSetting(state = Global.Path.state): Promise<boolean | undefined> {
  const file = path.join(state, "kv.json")
  try {
    // Same reader-side lock as readPrivacyBoolean: never contends with the
    // TUI's long-lived tui-kv writer lock; kv writes use atomic rename.
    const kv = await Flock.withLock(
      `privacy-kv:${file}`,
      () => Filesystem.readJson<Record<string, unknown>>(file),
      { dir: privacyLockDir(state) },
    )
    const value = kv[TOOL_IMPROVEMENT_ENABLED_KEY]
    return typeof value === "boolean" ? value : undefined
  } catch {
    return undefined
  }
}

export const readAnalyticsEnabled = () => readPrivacyBoolean(ANALYTICS_ENABLED_KEY, true)

/**
 * @deprecated No production caller left — the account-scoped decision lives in
 * `@/plugin/deveco/improvement-consent`; gate on `isImprovementConsentGranted()`
 * instead. This reader still falls back to the device-level `true`, which is
 * exactly the "switched off but still reporting" hazard fixed for the request
 * header (B3): any new caller would silently bypass the account-scoped,
 * default-off contract. Do not add callers. The legacy key's only remaining
 * consumer is `readToolImprovementSetting` (undefined-aware), used once by the
 * D7 legacy claim.
 */
export const readToolImprovementEnabled = () => readPrivacyBoolean(TOOL_IMPROVEMENT_ENABLED_KEY, true)
