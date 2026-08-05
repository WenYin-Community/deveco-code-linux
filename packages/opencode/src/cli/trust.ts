import os from "os"
import path from "path"
import * as prompts from "@clack/prompts"
import { isTrusted, saveTrust } from "./trust/cache"
import { t } from "./i18n"

const WARNING = "\x1b[38;2;150;108;30m"
const RESET = "\x1b[0m"

// ── Trust prompt ─────────────────────────────────────────────

/**
 * Show a workspace trust prompt before the app starts.
 *
 * Uses @clack/prompts for the interactive chrome, matching Claude Code's
 * PermissionDialog flow:
 *
 *   ╭─ Accessing workspace ─────────────────────────────────╮
 *   │ /Users/test/my-project                                 │
 *   │ Is this a project you trust? (Your own code, a ...)   │
 *   │ Once trusted, DevEco Code can read, edit, ...          │
 *   │                                                        │
 *   │ ◯ Yes, I trust this folder                             │
 *   │ ◯ No, exit                                             │
 *
 * Visual differs from Claude Code's exact layout (clack puts the title
 * on the top border and uses ◯/◆ markers instead of ❯/✔ + numeric index).
 * The structural shape — frame header + body + select — is preserved.
 *
 * The prompt is skipped in non-interactive environments (no TTY) or when
 * the `DEVECO_TRUST` environment variable is set to `1`.
 *
 * For non-HOME directories, trust is persisted per-project in
 * ~/.config/deveco/trusted-paths.json and the prompt is skipped on
 * subsequent runs (with parent-directory inheritance: if an ancestor
 * was trusted, the directory is automatically trusted as well).
 *
 * For the user's home directory, the prompt is ALWAYS shown on entry
 * (no session-level skipping), but the trust decision is session-only
 * — saveTrust() does not write to disk for HOME.
 *
 * For the user's home directory, the prompt shows a "(Home directory)" badge
 * after the path, swaps the option order (No first, Yes second), appends
 * "(Recommended)" to the No label and "(session only)" to the Yes label
 * (always visible, not just on hover), and defaults to the No option —
 * reflecting the higher risk of trusting the entire home directory.
 */
export async function trustPrompt(directory: string): Promise<boolean> {
  // Auto-trust in non-interactive / CI environments
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return true
  }

  // Allow env var override for automation (CI, scripts, etc.)
  if (process.env.DEVECO_TRUST === "1") {
    return true
  }

  // HOME: always show the prompt — do NOT skip based on sessionHomeTrusted.
  // The user wants to be reminded every time they enter the home directory.
  // (The trust decision itself is still session-only — saveTrust() skips
  // disk writes for HOME; see cache.ts.)
  // For other directories: skip the prompt if previously trusted (with
  // parent-directory inheritance via the on-disk cache).
  const isHome = path.resolve(directory) === os.homedir()
  if (!isHome && await isTrusted(directory)) {
    return true
  }

  prompts.intro(`${WARNING}${t("trust.intro")}${RESET}`)
  const homeBadge = isHome ? ` ${t("trust.home_badge")}` : ""
  prompts.log.message(`\x1b[1m${directory}\x1b[22m${homeBadge}`)
  prompts.log.message(t("trust.question"))
  prompts.log.message(t("trust.explanation"))

  const result = await prompts.select({
    message: "",
    options: isHome
      ? [
          { value: "no", label: t("trust.option_no_home") },
          { value: "yes", label: t("trust.option_yes_home") },
        ]
      : [
          { value: "yes", label: t("trust.option_yes") },
          { value: "no", label: t("trust.option_no") },
        ],
    initialValue: isHome ? "no" : "yes",
  })

  if (prompts.isCancel(result) || result !== "yes") {
    prompts.log.warn(t("trust.declined"))
    return false
  }

  await saveTrust(directory)
  prompts.log.success(t("trust.trusted"))
  return true
}
