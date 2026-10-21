import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { logWarn } from "./log"

/**
 * File name of the country/region setting shared with DevEco Studio.
 *
 * The content is an IntelliJ-style application component document:
 *
 * ```xml
 * <application>
 *   <component name="CountryRegionSetting">
 *     <countryregion name="CN"/>
 *   </component>
 * </application>
 * ```
 *
 * The directory and the element layout are fixed by product requirement: the file is meant
 * to be shared with DevEco Studio, which keeps the same setting per user. Neither may be
 * derived from our own config layout.
 */
export const COUNTRY_REGION_FILE = "country.region.xml"

/**
 * The only shape accepted for the country element's `name` attribute.
 *
 * The value is interpolated into an XML attribute, so it is restricted to two ASCII letters
 * before it reaches the document. Anything else (empty string, longer codes, markup
 * characters) is rejected instead of escaped.
 *
 * This is a shape check, not a registry check: the product stores codes such as "UK" that
 * are not assigned in ISO 3166-1, so membership is deliberately not validated here.
 */
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/

/**
 * Shape accepted before case folding.
 *
 * Checked on the raw value because `String.prototype.toUpperCase` folds non-ASCII letters
 * ("ß" becomes "SS"), which would otherwise manufacture an uppercase code out of an input
 * that is not a country code at all.
 */
const COUNTRY_CODE_INPUT_PATTERN = /^[A-Za-z]{2}$/

/**
 * Renames `from` over `to`. Injected so the retry policy below can be exercised on any
 * platform; production callers pass Node's own `fs.rename`.
 */
export type RenameFn = (from: string, to: string) => Promise<void>

/**
 * Errors a rename may report while another process still holds the target open.
 *
 * Windows cannot replace a file that another process opened without `FILE_SHARE_DELETE`:
 * the call fails instead of waiting, reporting `EPERM` or `EACCES` depending on the API
 * path, occasionally `EBUSY`. All three are transient in practice — a reader (DevEco Studio
 * opening the document), an antivirus scanner or a backup agent — so the rename is retried
 * a few times before the failure is reported.
 */
const RETRYABLE_RENAME_ERRORS: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"])

/**
 * Backoff between rename attempts: 10 + 20 + 40 + 80 + 160 ms, about 310 ms in total.
 *
 * Sized for the Windows case rather than for fast failure: an antivirus scanner or DevEco
 * Studio holding the document open keeps it for hundreds of milliseconds, so a budget in the
 * tens of milliseconds would give up while the file was about to become writable. The delay
 * costs nothing in the normal path, where the first rename succeeds.
 */
export const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160] as const

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined
  const code = (err as { code: unknown }).code
  return typeof code === "string" ? code : undefined
}

/**
 * Rename `tmpPath` over `targetPath`, retrying the sharing-violation errors above.
 *
 * Every other error is rethrown on the first attempt. Exported, together with
 * {@link RENAME_RETRY_DELAYS_MS}, so the Windows behaviour is testable without a Windows
 * host.
 */
export async function renameWithRetry(
  tmpPath: string,
  targetPath: string,
  rename: RenameFn = fs.rename,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmpPath, targetPath)
      return
    } catch (err) {
      const delay = RENAME_RETRY_DELAYS_MS[attempt]
      if (delay === undefined || !RETRYABLE_RENAME_ERRORS.has(errorCode(err) ?? "")) throw err
      await Bun.sleep(delay)
    }
  }
}

/**
 * Directory that holds the country/region file.
 *
 * Kept literal on purpose: `<home>/.config/deveco` on every platform (`%USERPROFILE%`
 * resolves as home on Windows), the location named by the requirement. It is intentionally
 * not `Global.Path.config`, because the XDG overrides that relocate our own config must
 * not relocate a file another product reads from a fixed location.
 *
 * `Global.Path.home` honours `DEVECO_TEST_HOME`, which keeps tests out of the real home
 * directory.
 */
export function countryRegionDir(): string {
  return path.join(Global.Path.home, ".config", "deveco")
}

export function countryRegionFilePath(dir: string = countryRegionDir()): string {
  return path.join(dir, COUNTRY_REGION_FILE)
}

/**
 * Whether the country/region file is present and usable.
 *
 * Used by the startup backfill: a usable file is never touched, so a user who signed in
 * before the file existed — or deleted it afterwards — is the only one who pays for a
 * request. "Usable" means a regular file with content, because a bare existence check would
 * also accept a directory squatting on the path, a zero-byte document left by a power loss or
 * restored from a backup, or a symlink with no target: all of them look present, none of them
 * can be read as a region, and the backfill would then never repair the user.
 *
 * Anything with content is left untouched, because DevEco Studio may have written it.
 */
export async function countryRegionFileIsUsable(dir: string = countryRegionDir()): Promise<boolean> {
  try {
    const stats = await fs.stat(countryRegionFilePath(dir))
    return stats.isFile() && stats.size > 0
  } catch {
    return false
  }
}

/**
 * Render the country/region document for `countryCode`.
 *
 * Accepts lower case and surrounding whitespace and normalises both. Returns `null` when the
 * value is not a two-letter country/region code, so callers can distinguish "nothing to write"
 * from an I/O failure.
 */
export function renderCountryRegionXml(countryCode: string): string | null {
  const trimmed = countryCode.trim()
  if (!COUNTRY_CODE_INPUT_PATTERN.test(trimmed)) return null
  const code = trimmed.toUpperCase()
  // Defensive assertion: only ASCII letters reach here, so folding cannot leave a non-letter.
  // Kept so a future widening of the input pattern cannot silently reach the XML attribute.
  if (!COUNTRY_CODE_PATTERN.test(code)) return null
  return [
    "<application>",
    '  <component name="CountryRegionSetting">',
    `    <countryregion name="${code}"/>`,
    "  </component>",
    "</application>",
    "",
  ].join("\n")
}

/**
 * Persist `countryCode` to the country/region file.
 *
 * Writes to a temporary sibling first and then renames it over the target: rename is
 * atomic within one filesystem, so a reader (DevEco Studio, another process) never sees
 * a half-written document and an earlier file is never left truncated. The rename goes
 * through {@link renameWithRetry}, because Windows refuses to replace a file another
 * process holds open.
 *
 * `rename` replaces the raw rename step for tests; production callers use the default,
 * which retries via {@link renameWithRetry}.
 *
 * Returns `false` when the code was rejected before any I/O; throws when the write
 * itself fails so the caller can decide whether that is fatal.
 */
export async function saveCountryRegion(
  countryCode: string,
  dir: string = countryRegionDir(),
  rename: RenameFn = fs.rename,
): Promise<boolean> {
  const xml = renderCountryRegionXml(countryCode)
  if (xml === null) {
    logWarn("country code is not a two-letter country code; country region file not written", {
      service: "deveco",
      countryCode,
    })
    return false
  }

  const target = countryRegionFilePath(dir)
  // The pid keeps two processes apart, the random suffix keeps two writes in one process apart.
  // A process killed between the write and the rename leaves this file behind; the next write
  // does not remove it, because a concurrent writer's live temp file must not be deleted.
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`

  try {
    await fs.mkdir(dir, { recursive: true })
    // 0o644 on purpose: DevEco Studio reads this file, so it must be readable within the user's
    // own home; the content is a two-letter code, not a secret. Declared explicitly so the next
    // review does not have to re-derive it from the umask.
    await fs.writeFile(temp, xml, { encoding: "utf8", mode: 0o644 })
    await renameWithRetry(temp, target, rename)
    return true
  } catch (err) {
    // Do not leave a partial temp file behind when the rename never happened.
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw err
  }
}
