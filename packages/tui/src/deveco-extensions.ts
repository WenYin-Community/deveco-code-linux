/**
 * DevEco-specific extension points consumed by the generic TUI package.
 *
 * The TUI package must not import `deveco` (would create a workspace cycle with turbo).
 * Instead, the DevEco package registers its implementations here at startup, before
 * the TUI root renders. All extension members are optional so the TUI package can
 * also be used without DevEco features (e.g. generic/upstream mode).
 *
 * Registration site: packages/opencode/src/cli/deveco-ui/register.ts
 * called from: packages/opencode/src/cli/cmd/tui.ts (before TUI run())
 */
import type { JSX, ParentProps } from "solid-js"
import type { useSync } from "./context/sync"

/** Sync object type — inferred from TUI's own useSync hook. */
export type SyncObject = ReturnType<typeof useSync>

/**
 * DevEco Home body — replaces the entire center slot of the Home page when
 * registered. Encapsulates login check, agreement check, and onboarding UI
 * so the TUI Home route stays generic.
 *
 * - `sync`:          TUI's sync store, used for config.agreement + bootstrap status
 * - `bodySlotHeight`: row count reserved for the body (for onboarding scroll sizing)
 *
 * The component is responsible for all state management internally. When
 * authentication + agreement are complete, it renders the standard prompt UI.
 * When not, it renders the onboarding flow (privacy / entry / provider / key).
 */
export type DevEcoHomeBody = (props: {
  sync: SyncObject
  bodySlotHeight: number
  /**
   * Improvement opt-in threading (design §6.6 / B5): forwarded by home-body
   * through DevEcoOnboarding into the AgreementPanel's improvement checkbox,
   * so confirming the panel notifies the worker (same channel /privacy uses).
   */
  onImprovementChange?: (enabled: boolean) => void | Promise<void>
}) => JSX.Element

/**
 * Reads the local auth store and returns a sentinel error message if it is
 * corrupted (e.g. credentials cannot be decrypted). The TUI's sync bootstrap
 * uses this to set `local_auth_error` on the store so the UI can show the
 * message without aborting startup.
 *
 * Returns undefined when the local auth store is healthy.
 */
export type DevEcoLocalAuthErrorReader = () => Promise<string | undefined>

/**
 * Opens the DevEco complain/feedback page in Chrome with pre-filled context.
 * Returns { ok: true } on success, or { ok: false, message } describing why
 * it failed (e.g. Chrome not installed).
 */
export type DevEcoComplainOpener = (
  latestConversation?: string,
) => Promise<{ ok: true } | { ok: false; message: string }>

/** Pluralization helper: `pluralize(1, "{} item", "{} items")` → "1 item". */
export type DevEcoPluralize = (count: number, singular: string, plural: string) => string

/** Privacy settings dialog. Shown via the `/privacy` command. */
export type DevEcoPrivacyDialog = () => JSX.Element

/** Agreement review shown when a built-in model request discovers updated terms. */
export type DevEcoAgreementReviewDialog = (props: { onComplete: () => void }) => JSX.Element

/** Real-name dialog shown when a built-in model request hits a real-name verification failure. */
export type DevEcoRealNameDialog = (props: { onComplete: () => void }) => JSX.Element

/**
 * Improvement consent ask (design §6.4). Opened by the home-body fallback
 * effect after a login when the current account has no improvement decision
 * yet (covers in-app login, CLI-login-then-TUI, and upgraded installs).
 */
export type DevEcoImprovementConsentDialog = (props: { onComplete: () => void }) => JSX.Element

/** Log collection dialog. Shown automatically after crash detection on startup. */
export type DevEcoCollectDialog = (props: { triggerType?: string }) => JSX.Element

/**
 * Detect and consume crash info (if any). Returns truthy if a crash was
 * detected, undefined otherwise. Called once by the TUI after UI is loaded.
 */
export type DevEcoConsumeCrashInfo = () => boolean

/**
 * DevEco extensions. Registered once at startup. Members may be absent when
 * the host runs without DevEco features (generic upstream mode).
 */
export type DevEcoExtensions = {
  agreementGate?: (props: ParentProps<{ home: boolean; onConsentRequired: () => void }>) => JSX.Element
  homeBody?: DevEcoHomeBody
  readLocalAuthError?: DevEcoLocalAuthErrorReader
  openComplainPage?: DevEcoComplainOpener
  pluralize?: DevEcoPluralize
  privacyDialog?: DevEcoPrivacyDialog
  agreementReviewDialog?: DevEcoAgreementReviewDialog
  improvementConsentDialog?: DevEcoImprovementConsentDialog
  isAgreementReviewError?: (message: string) => boolean
  realNameDialog?: DevEcoRealNameDialog
  isRealNameError?: (message: string) => boolean
  collectDialog?: DevEcoCollectDialog
  consumeCrashInfo?: DevEcoConsumeCrashInfo
}

let registered: DevEcoExtensions = {}

/** Register DevEco extensions. Call once at TUI startup, before render. */
export function registerDevEcoExtensions(ext: DevEcoExtensions): void {
  registered = { ...registered, ...ext }
}

/** Read currently registered extensions. */
export function getDevEcoExtensions(): DevEcoExtensions {
  return registered
}

/** Reset registrations (used by tests). */
export function resetDevEcoExtensions(): void {
  registered = {}
}
