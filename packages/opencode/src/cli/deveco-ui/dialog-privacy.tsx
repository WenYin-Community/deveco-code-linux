import { useI18n } from "@opencode-ai/tui/i18n"
import { createMemo, createResource, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { DialogSelect } from "@opencode-ai/tui/ui/dialog-select"
import { useDialog } from "@opencode-ai/tui/ui/dialog"
import { useSDK } from "@opencode-ai/tui/context/sdk"
import { useTheme } from "@opencode-ai/tui/context/theme"
import open from "open"
import { useKV } from "@opencode-ai/tui/context/kv"
import { AGREEMENT_DEFAULTS } from "@/cli/deveco-legal"
import { ANALYTICS_ENABLED_KEY } from "@/cli/deveco-privacy-settings"
import { hasDevecoOAuthEntry } from "@/plugin/deveco"
import { logWarn } from "@/plugin/deveco/log"
import {
  getCurrentImprovementConsent,
  loadUserIdFromDisk,
  setCurrentImprovementConsent,
} from "@/plugin/deveco/improvement-consent"
import { AgreementReviewDialog } from "./agreement-panel"

/**
 * @deprecated No production caller left: the Improvement row is account-scoped
 * and writes through `improvement-consent.ts` (T3.4). This helper toggles a
 * caller-supplied device-level flag and is kept only because it is a public
 * export; **do not add new callers** — account-scoped consent must go through
 * `setCurrentImprovementConsent`, otherwise a per-device value can disagree
 * with the account the telemetry is attributed to.
 */
export function toggleToolImprovementEnabled(input: {
  current: boolean
  set(enabled: boolean): void
  onChange?: (enabled: boolean) => void | Promise<void>
}): boolean {
  const enabled = !input.current
  input.set(enabled)
  try {
    void Promise.resolve(input.onChange?.(enabled)).catch(() => {})
  } catch {
    // Collection settings remain local-first when the worker is unavailable.
  }
  return enabled
}

export function DialogPrivacy(
  props: {
    onToolImprovementEnabledChange?: (enabled: boolean) => void | Promise<void>
    openUrl?: (url: string) => Promise<unknown>
    loadAgreement?: () => Promise<{ upload: { state: string } } | undefined>
  } = {},
) {
  const { t } = useI18n()
  const { theme } = useTheme()
  const kv = useKV()
  const dialog = useDialog()
  const [agreement] = createResource(() => props.loadAgreement?.())

  const analyticsEnabled = () => kv.get("analytics_enabled", true)
  const crashUploadEnabled = () => kv.get("crash_upload_enabled", true)

  // Improvement row (design §6.5 / D8): account-scoped read/write. Locked
  // (greyed, "sign in to configure") when no account can be identified —
  // either no OAuth entry, or the two login signals diverge (auth.json has an
  // entry but token.enc yields no userId — S7); there must be no writable
  // path that could attach a record to no account (ST-3).
  const [imp, setImp] = createStore({ granted: false, locked: true, error: "", busy: false })
  onMount(async () => {
    if (!hasDevecoOAuthEntry()) return
    // S7 boundary (design §6.5): auth.json still has an oauth entry while
    // token.enc yields no userId (token-storage deletes it when decryption
    // fails). The row is locked (D8) like the signed-out case — and the
    // divergence gets a log line, otherwise this state is undiagnosable.
    if (!(await loadUserIdFromDisk())) {
      logWarn("improvement consent row locked: oauth entry present but userId unresolvable", { service: "deveco" })
      return
    }
    const consent = await getCurrentImprovementConsent()
    setImp({ granted: consent === "granted", locked: false })
  })

  const toggleImprovement = async () => {
    if (imp.locked) return
    // P3 fix (2026-09-23): guard against overlapping writes. Space repeats (or a
    // fast double press) would otherwise start two writes whose completion order
    // is not guaranteed, leaving the row and the disk disagreeing. Mirrors the
    // consent dialog's `state.busy` guard.
    if (imp.busy) return
    const next = !imp.granted
    setImp({ granted: next, busy: true }) // optimistic
    try {
      // I-4: false = not written (userId unresolvable / write failure) → roll
      // the row back and surface the error; never fail silently (S7)
      if (!(await setCurrentImprovementConsent(next))) {
        setImp({ granted: !next, error: t("account.improvement_update_failed") })
        return
      }
      setImp("error", "")
      try {
        await props.onToolImprovementEnabledChange?.(next)
      } catch {
        // Collection settings remain local-first when the worker is unavailable.
      }
    } finally {
      setImp("busy", false)
    }
  }

  const toggle = (value: string) => {
    if (value === "toggle-analytics") {
      kv.set(ANALYTICS_ENABLED_KEY, !analyticsEnabled())
      return
    }
    if (value === "toggle-tool-improvement") {
      void toggleImprovement()
      return
    }
    if (value === "toggle-crash-upload") kv.set("crash_upload_enabled", !crashUploadEnabled())
  }

  let selected = "policy"

  /**
   * 行标题与旁边两行（Analytics / Crash）保持同一约定：**动词标题 + 动作描述**。
   * 未登录时读不到存储的决定，动词会误导，故用中性名称；标题更短也让提示不被挤掉
   * （本对话框宽 60 列，标题与描述并排）。
   */
  const improvementLabel = () =>
    imp.locked
      ? t("account.improvement_title")
      : imp.granted
        ? t("account.disable_improvement")
        : t("account.enable_improvement")
  const options = createMemo(() => [
    ...(agreement()?.upload.state === "review_required"
      ? [{
          title: t("account.review_option"),
          description: t("account.review_option_description"),
          value: "review",
          category: t("account.agreements"),
          onSelect: () => dialog.replace(() => <AgreementReviewDialog onComplete={() => dialog.clear()} />),
        }]
      : []),
    {
      title: t("account.privacy_policy"),
      description: t("account.privacy_description"),
      value: "policy",
      category: t("account.agreements"),
      onSelect: () => {
        void (props.openUrl ?? open)(AGREEMENT_DEFAULTS.privacy_url).catch(() => {})
      },
    },
    {
      title: t("account.terms"),
      description: t("account.terms_description"),
      value: "terms",
      category: t("account.agreements"),
      onSelect: () => {
        void (props.openUrl ?? open)(AGREEMENT_DEFAULTS.terms_url).catch(() => {})
      },
    },
    {
      title: analyticsEnabled() ? t("account.disable_analytics") : t("account.enable_analytics"),
      description: analyticsEnabled() ? t("account.disable_usage") : t("account.enable_usage"),
      value: "toggle-analytics",
      category: t("account.sharing"),
      onSelect: () => toggle("toggle-analytics"),
    },
    {
      // Account-scoped improvement row (T3.4). DialogSelect drops `disabled`
      // options from the list entirely, so the D8 locked state is expressed by
      // muting the title — the row must stay visible with the "sign in to
      // configure" hint (UI-7) while `toggleImprovement` refuses to write (S7).
      title: improvementLabel(),
      titleView: <span style={{ fg: imp.locked ? theme.textMuted : theme.text }}>{improvementLabel()}</span>,
      description: imp.locked
        ? t("account.improvement_login_required")
        : imp.error || (imp.granted ? t("account.stop_prompts") : t("account.share_prompts")),
      value: "toggle-tool-improvement",
      category: t("account.sharing"),
      onSelect: () => toggle("toggle-tool-improvement"),
    },
    {
      title: crashUploadEnabled() ? t("account.disable_crash") : t("account.enable_crash"),
      description: crashUploadEnabled() ? t("account.stop_logs") : t("account.share_logs"),
      value: "toggle-crash-upload",
      category: t("account.sharing"),
      onSelect: () => toggle("toggle-crash-upload"),
    },
  ])

  return (
    <DialogSelect
      title={t("account.privacy")}
      options={options()}
      renderFilter={false}
      skipFilter={true}
      onMove={(option) => {
        selected = option.value
      }}
      bindings={[
        {
          key: "space",
          desc: t("dialog.action_toggle"),
          group: t("account.privacy"),
          cmd: () => toggle(selected),
        },
      ]}
      footerHints={[
        { title: "Space", label: t("dialog.action_toggle") },
        { title: "Enter", label: t("account.select") },
      ]}
    />
  )
}

export function DialogPrivacyConnected(props: {
  onToolImprovementEnabledChange?: (enabled: boolean) => void | Promise<void>
}) {
  const sdk = useSDK()
  return (
    <DialogPrivacy
      {...props}
      loadAgreement={async () => (await sdk.client.global.productAgreement()).data}
    />
  )
}
