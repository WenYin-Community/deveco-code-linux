import { useI18n } from "@opencode-ai/tui/i18n"
import { createEffect, createMemo, createResource, Show, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { useSync } from "@opencode-ai/tui/context/sync"
import { useSDK } from "@opencode-ai/tui/context/sdk"
import { useTheme } from "@opencode-ai/tui/context/theme"
import { useBindings } from "@opencode-ai/tui/keymap"
import { Link } from "@opencode-ai/tui/ui/link"
import { DialogSelect } from "@opencode-ai/tui/ui/dialog-select"
import open from "open"

export function AgreementPanel(props: { onComplete?: () => void; maxHeight?: number; review?: boolean }) {
  const { t } = useI18n()
  const sdk = useSDK()
  const { theme } = useTheme()
  const [state, setState] = createStore({ checked: false, busy: false, error: "" })
  const [agreement, { refetch }] = createResource(async () => {
    const result = await sdk.client.global.productAgreement({ throwOnError: true })
    if (!result.data?.upload) throw new Error(t("account.server_update"))
    setState("checked", false)
    return result.data
  })
  const needsConsent = () =>
    !agreement.error && (!agreement()?.accepted || agreement()?.upload.state === "review_required")
  const act = async () => {
    if (state.busy) return
    if (agreement.error) {
      await Promise.resolve(refetch()).catch(() => {})
      return
    }
    const current = agreement()
    if (!current || (needsConsent() && !state.checked)) return
    setState({ busy: true, error: "" })
    try {
      if (needsConsent()) {
        await sdk.client.global.acceptProductAgreement(
          {
            version: current.version,
            accepted: true,
            serviceRevision: current.upload.revision,
          },
          { throwOnError: true },
        )
        await refetch()
        props.onComplete?.()
        return
      }
      props.onComplete?.()
    } catch (error) {
      setState("error", error instanceof Error ? error.message : t("account.update_failed"))
      await Promise.resolve(refetch()).catch(() => {})
    } finally {
      setState("busy", false)
    }
  }
  useBindings(() => ({
    bindings: [
      {
        key: "space",
        desc: t("account.agree_action"),
        group: t("account.agreements"),
        cmd: () => {
          if (needsConsent()) setState("checked", !state.checked)
        },
      },
      { key: "return", desc: t("account.continue"), group: t("account.agreements"), cmd: () => void act() },
    ],
  }))
  return (
    <box flexDirection="column" width="100%" padding={1} gap={1}>
      <text fg={theme.text}>
        <b>{props.review ? t("account.review_title") : t("account.agreements_privacy")}</b>
      </text>
      <Show when={props.review}>
        <text fg={theme.textMuted}>{t("account.review_message")}</text>
      </Show>
      <Show when={agreement.error}>
        <text fg={theme.error}>{t("account.load_failed")}</text>
      </Show>
      <Show when={agreement.loading}>
        <text fg={theme.textMuted}>{t("account.loading_agreements")}</text>
      </Show>
      <Show when={!agreement.error && agreement()}>
        {(current) => (
          <>
            <box flexDirection="column" gap={1}>
              <Link href={current().termsUrl}>{t("account.terms")}</Link>
              <Link href={current().privacyUrl}>{t("account.privacy_notice")}</Link>
            </box>
            <Show when={needsConsent()}>
              <text fg={theme.text} onMouseUp={() => setState("checked", !state.checked)}>
                {state.checked ? "[✓]" : "[ ]"} {t("account.consent")}
              </text>
            </Show>
            <text fg={theme.primary} onMouseUp={() => void act()}>
              {state.busy ? t("account.wait") : needsConsent() ? t("account.agree_hint") : t("account.continue")}
            </text>
          </>
        )}
      </Show>
      <Show when={state.error}>
        <text fg={theme.error}>{state.error}</text>
      </Show>
    </box>
  )
}

export function AgreementReviewDialog(props: { onComplete: () => void }) {
  const { t } = useI18n()
  const { theme } = useTheme()
  const sdk = useSDK()
  const [state, setState] = createStore({ checked: false, busy: false, error: "" })
  const [agreement, { refetch }] = createResource(async () => {
    const result = await sdk.client.global.productAgreement({ throwOnError: true })
    if (!result.data?.upload) throw new Error(t("account.server_update"))
    return result.data
  })
  const accept = async () => {
    const current = agreement()
    if (!current || state.busy) return
    setState("checked", true)
    setState({ busy: true, error: "" })
    try {
      await sdk.client.global.acceptProductAgreement(
        { version: current.version, accepted: true, serviceRevision: current.upload.revision },
        { throwOnError: true },
      )
      props.onComplete()
    } catch (error) {
      setState("error", error instanceof Error ? error.message : t("account.update_failed"))
      await Promise.resolve(refetch()).catch(() => {})
    } finally {
      setState("busy", false)
    }
  }
  const options = createMemo(() => {
    const current = agreement()
    if (!current) {
      return [
        {
          title: agreement.error ? t("account.load_failed") : t("account.loading_agreements"),
          description: agreement.error ? t("account.retry_description") : undefined,
          value: "retry",
          onSelect: (): void => void Promise.resolve(refetch()).catch(() => {}),
        },
      ]
    }
    return [
      {
        title: t("account.terms"),
        description: t("account.terms_description"),
        value: "terms",
        category: t("account.review_reading"),
        onSelect: (): void => void open(current.termsUrl).catch(() => {}),
      },
      {
        title: t("account.privacy_notice"),
        description: t("account.privacy_description"),
        value: "privacy",
        category: t("account.review_reading"),
        onSelect: (): void => void open(current.privacyUrl).catch(() => {}),
      },
      {
        title: `${state.checked ? "[✓]" : "[ ]"} ${t("account.review_consent")}`,
        value: "consent",
        category: t("account.review_actions"),
        onSelect: (): void => setState("checked", !state.checked),
      },
      {
        title: state.busy ? t("account.wait") : t("account.review_confirm"),
        description: state.error || undefined,
        value: "confirm",
        category: t("account.review_actions"),
        onSelect: (): void => void accept(),
      },
    ]
  })
  return (
    <DialogSelect
      title={t("account.review_title")}
      notice={
        <text fg={theme.textMuted} wrapMode="word">
          {t("account.review_message")}
        </text>
      }
      options={options()}
      renderFilter={false}
      skipFilter={true}
      locked={state.busy}
      bindings={[
        {
          key: "space",
          desc: t("account.agree_action"),
          group: t("account.agreements"),
          cmd: () => setState("checked", !state.checked),
        },
      ]}
      footerHints={[
        { title: "Space", label: t("dialog.action_toggle") },
        { title: "Enter", label: t("account.select") },
      ]}
    />
  )
}

export function ProductAgreementGate(props: ParentProps<{ home: boolean; onConsentRequired: () => void }>) {
  const sync = useSync()
  const { t } = useI18n()
  const { theme } = useTheme()
  const sdk = useSDK()
  const [agreement, { refetch }] = createResource(
    () => (props.home ? undefined : true),
    async () => {
      const result = await sdk.client.global.productAgreement({ throwOnError: true })
      if (!result.data?.upload) throw new Error(t("account.server_update"))
      if (result.data.accepted) void sdk.client.global.retryAgreementUpload({ force: false }).catch(() => {})
      return result.data
    },
  )
  createEffect(() => {
    if (!props.home && agreement() && !agreement()?.accepted) props.onConsentRequired()
  })
  return (
    <Show
      when={props.home || (!agreement.error && agreement()?.accepted)}
      fallback={
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text
            fg={agreement.error ? theme.error : theme.textMuted}
            onMouseUp={() => agreement.error && void refetch()}
          >
            {agreement.error ? t("account.load_failed") : t("account.checking_setup")}
          </text>
        </box>
      }
    >
      <Show
        when={!sync.data.local_auth_error}
        fallback={
          <box padding={2}>
            <text>
              {sync.data.local_auth_error} {t("account.reset_help")}
            </text>
          </box>
        }
      >
        {props.children}
      </Show>
    </Show>
  )
}
