import { useI18n } from "@opencode-ai/tui/i18n"
import { createMemo, createResource } from "solid-js"
import { DialogSelect } from "@opencode-ai/tui/ui/dialog-select"
import { useDialog } from "@opencode-ai/tui/ui/dialog"
import { useSDK } from "@opencode-ai/tui/context/sdk"
import open from "open"
import { useKV } from "@opencode-ai/tui/context/kv"
import { AGREEMENT_DEFAULTS } from "@/cli/deveco-legal"
import { ANALYTICS_ENABLED_KEY, TOOL_IMPROVEMENT_ENABLED_KEY } from "@/cli/deveco-privacy-settings"
import { AgreementReviewDialog } from "./agreement-panel"

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
  const kv = useKV()
  const dialog = useDialog()
  const [agreement] = createResource(() => props.loadAgreement?.())

  const analyticsEnabled = () => kv.get("analytics_enabled", true)
  const crashUploadEnabled = () => kv.get("crash_upload_enabled", true)
  const toolImprovementEnabled = () => kv.get(TOOL_IMPROVEMENT_ENABLED_KEY, true)

  const toggle = (value: string) => {
    if (value === "toggle-analytics") {
      kv.set(ANALYTICS_ENABLED_KEY, !analyticsEnabled())
      return
    }
    if (value === "toggle-tool-improvement") {
      toggleToolImprovementEnabled({
        current: toolImprovementEnabled(),
        set: (enabled) => kv.set(TOOL_IMPROVEMENT_ENABLED_KEY, enabled),
        onChange: props.onToolImprovementEnabledChange,
      })
      return
    }
    if (value === "toggle-crash-upload") kv.set("crash_upload_enabled", !crashUploadEnabled())
  }

  let selected = "policy"

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
      title: toolImprovementEnabled() ? t("account.disable_improvement") : t("account.enable_improvement"),
      description: toolImprovementEnabled() ? t("account.stop_prompts") : t("account.share_prompts"),
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
