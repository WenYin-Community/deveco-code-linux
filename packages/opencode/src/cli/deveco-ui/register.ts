/**
 * Register DevEco-specific extensions into the generic TUI package.
 *
 * Must be called once before the TUI root renders. Call site:
 *   packages/opencode/src/plugin/tui/runtime.ts → createLegacyTuiPluginHost()
 *
 * This decouples the TUI package from `deveco` (breaks the cyclic dependency)
 * by injecting implementations rather than importing them directly.
 */
import { registerDevEcoExtensions } from "@opencode-ai/tui/deveco-extensions"
import { mergeProps } from "solid-js"
import { DevEcoHomeBody } from "./home-body"
import { AgreementReviewDialog, ProductAgreementGate } from "./agreement-panel"
import { DialogRealName } from "./dialog-realname"
import { ImprovementConsentDialog } from "./improvement-consent-dialog"
import { DialogPrivacyConnected } from "./dialog-privacy"
import { DialogCollect } from "./dialog-collect"
import { openComplainPage } from "./complain"
import { Auth } from "@/auth"
import { LOCAL_CREDENTIALS_CORRUPTED_MESSAGE } from "@/auth/messages"
import { Effect } from "effect"
import { detectCrashedFlag } from "@/cli/crash-detect"
import { AGREEMENT_REVIEW_REQUIRED_MESSAGE } from "@/cli/deveco-product-agreement"

async function readLocalAuthError(): Promise<string | undefined> {
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.all()
      }).pipe(Effect.provide(Auth.defaultLayer)) as Effect.Effect<void>,
    )
    return undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes(LOCAL_CREDENTIALS_CORRUPTED_MESSAGE)) return LOCAL_CREDENTIALS_CORRUPTED_MESSAGE
    throw error
  }
}

/**
 * Minimal pluralize — matches the signature of @opencode-ai/tui/util/locale's pluralize.
 * Duplicated here so the TUI can delegate to DevEco without re-importing its own locale util
 * (which would not close the cycle; this is a defensive copy).
 */
function pluralize(count: number, singular: string, plural: string): string {
  const template = count === 1 ? singular : plural
  return template.replace("{}", String(count))
}

export function registerDevEcoTuiExtensions(
  options: {
    onToolImprovementEnabledChange?: (enabled: boolean) => void | Promise<void>
  } = {},
): void {
  registerDevEcoExtensions({
    agreementGate: ProductAgreementGate,
    // homeBody wraps DevEcoHomeBody so the improvement-change callback threads
    // down register → home-body → onboarding → AgreementPanel (design §6.6 B5).
    // mergeProps (not `{...props}`) keeps the caller's getters reactive: Solid
    // compiles dynamic JSX attributes into getters, and a spread would evaluate
    // them once at construction.
    homeBody: (props) =>
      DevEcoHomeBody(mergeProps(props, { onImprovementChange: options.onToolImprovementEnabledChange })),
    readLocalAuthError,
    openComplainPage,
    pluralize,
    privacyDialog: () => DialogPrivacyConnected({ onToolImprovementEnabledChange: options.onToolImprovementEnabledChange }),
    agreementReviewDialog: AgreementReviewDialog,
    improvementConsentDialog: (props) =>
      ImprovementConsentDialog(mergeProps(props, { onImprovementChange: options.onToolImprovementEnabledChange })),
    isAgreementReviewError: (message) => message.includes(AGREEMENT_REVIEW_REQUIRED_MESSAGE),
    realNameDialog: DialogRealName,
    isRealNameError: (message) => /HUAWEI real-name|real-name verification/i.test(message),
    collectDialog: DialogCollect,
    consumeCrashInfo: detectCrashedFlag,
  })
}
