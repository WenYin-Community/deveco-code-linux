import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useSync } from "../context/sync"
import { map, pipe, sortBy } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Link } from "../ui/link"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@opencode-ai/sdk/v2"
import { DialogModel } from "./dialog-model"
import { DialogProviderProgress } from "./dialog-provider-progress"
import { createProviderRefresh } from "./provider-refresh"
import { useToast } from "../ui/toast"
import { isConsoleManagedProvider } from "../util/provider-origin"
import { useConnected } from "./use-connected"
import { useBindings } from "../keymap"
import { useClipboard } from "../context/clipboard"
import { useI18n } from "../i18n"

const PROVIDER_PRIORITY: Record<string, number> = {
  zhipuai: 0,
  deepseek: 1,
  "alibaba-cn": 2,
  "moonshotai-cn": 3,
  "minimax-cn": 4,
}

const CUSTOM_PROVIDER_OPTION_VALUE = "__opencode_custom_provider__"
const CUSTOM_PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/

type ProviderOptionBase = {
  title: string
  value: string
  description?: string
  category: string
}

type ProviderOption =
  | (ProviderOptionBase & {
      type: "provider"
      providerID: string
    })
  | (ProviderOptionBase & {
      type: "custom"
    })

export function providerOptions(list: { id: string; name: string }[], t?: (key: string) => string): ProviderOption[] {
  return [
    ...pipe(
      list,
      sortBy(
        (x) => PROVIDER_PRIORITY[x.id] ?? 99,
        (x) => x.name.toLowerCase(),
        (x) => x.id,
      ),
      map((provider) => ({
        type: "provider" as const,
        title: provider.name,
        value: provider.id,
        providerID: provider.id,
        description: {
          deepseek: t ? t("dialog.provider_api_key") : "(API key)",
          zhipuai: t ? t("dialog.provider_api_key") : "(API key)",
          "moonshotai-cn": t ? t("dialog.provider_api_key") : "(API key)",
          "minimax-cn": t ? t("dialog.provider_api_key") : "(API key)",
          anthropic: t ? t("dialog.provider_api_key") : "(API key)",
          openai: t ? t("dialog.provider_openai") : "(ChatGPT Plus/Pro or API key)",
          google: t ? t("dialog.provider_api_key") : "(API key)",
        }[provider.id],
        category:
          provider.id in PROVIDER_PRIORITY
            ? t
              ? t("category.popular")
              : "Popular"
            : t
              ? t("category.providers")
              : "Providers",
      })),
    ),
    {
      type: "custom",
      title: t ? t("dialog.other") : "Other",
      value: CUSTOM_PROVIDER_OPTION_VALUE,
      description: t ? t("dialog.custom_provider") : "Custom provider",
      category: t ? t("category.providers") : "Providers",
    },
  ]
}

export function normalizeCustomProviderID(value: string) {
  const providerID = value.trim().replace(/^@ai-sdk\//, "")
  if (!CUSTOM_PROVIDER_ID.test(providerID)) return
  return providerID
}

export function createDialogProviderOptions(input?: { onConnected?: () => void }) {
  const { t } = useI18n()
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const onboarded = useConnected()

  async function promptCustomProviderID(): Promise<string | undefined> {
    const value = await DialogPrompt.show(dialog, t("dialog.other"), {
      placeholder: t("dialog.placeholder_provider_id"),
      description: () => <text fg={theme.textMuted}>{t("dialog.custom_provider_desc")}</text>,
    })
    if (value === null) return

    const providerID = normalizeCustomProviderID(value)
    if (providerID) return providerID

    toast.show({
      variant: "error",
      message: t("toast.provider_id_invalid"),
    })
    return promptCustomProviderID()
  }

  const options = createMemo(() => {
    return pipe(
      providerOptions(sync.data.provider_next.all, t),
      map((provider) => {
        if (provider.type === "custom") {
          return {
            title: t("dialog.other"),
            value: provider.value,
            description: provider.description,
            category: provider.category,
            async onSelect() {
              const providerID = await promptCustomProviderID()
              if (!providerID) return
              return dialog.replace(() => (
                <ApiMethod
                  providerID={providerID}
                  title={t("dialog.api_key")}
                  custom
                  onConnected={input?.onConnected}
                />
              ))
            },
          }
        }

        const providerID = provider.providerID
        const consoleManaged = isConsoleManagedProvider(sync.data.console_state.consoleManagedProviders, providerID)
        const connected = sync.data.provider_next.connected.includes(providerID)

        return {
          title: provider.title,
          value: provider.value,
          description: provider.description,
          footer: consoleManaged ? sync.data.console_state.activeOrgName : undefined,
          category: provider.category,
          gutter: connected && onboarded() ? () => <text fg={theme.success}>✓</text> : undefined,
          async onSelect() {
            if (consoleManaged) return

            const methods = sync.data.provider_auth[providerID] ?? [
              {
                type: "api",
                label: t("dialog.api_key"),
              },
            ]
            let index: number | null = 0
            if (methods.length > 1) {
              index = await new Promise<number | null>((resolve) => {
                dialog.replace(
                  () => (
                    <DialogSelect
                      title={t("dialog.select_auth_method")}
                      options={methods.map((x, index) => ({
                        title: x.label,
                        value: index,
                      }))}
                      onSelect={(option) => resolve(option.value)}
                    />
                  ),
                  () => resolve(null),
                )
              })
            }
            if (index == null) return
            const method = methods[index]
            if (method.type === "oauth") {
              let inputs: Record<string, string> | undefined
              if (method.prompts?.length) {
                const value = await PromptsMethod({
                  dialog,
                  prompts: method.prompts,
                })
                if (!value) return
                inputs = value
              }

              const result = await sdk.client.provider.oauth.authorize({
                providerID,
                method: index,
                inputs,
              })
              if (result.error) {
                toast.show({
                  variant: "error",
                  message: JSON.stringify(result.error),
                })
                dialog.clear()
                return
              }
              if (result.data?.method === "code") {
                dialog.replace(() => (
                  <CodeMethod
                    onConnected={input?.onConnected}
                    providerID={providerID}
                    title={method.label}
                    index={index}
                    authorization={result.data!}
                  />
                ))
              }
              if (result.data?.method === "auto") {
                dialog.replace(() => (
                  <AutoMethod
                    onConnected={input?.onConnected}
                    providerID={providerID}
                    title={method.label}
                    index={index}
                    authorization={result.data!}
                  />
                ))
              }
            }
            if (method.type === "api") {
              let metadata: Record<string, string> | undefined
              if (method.prompts?.length) {
                const value = await PromptsMethod({ dialog, prompts: method.prompts })
                if (!value) return
                metadata = value
              }
              return dialog.replace(() => (
                <ApiMethod
                  onConnected={input?.onConnected}
                  providerID={providerID}
                  title={method.label}
                  metadata={metadata}
                />
              ))
            }
          },
        }
      }),
    )
  })
  return options
}

export function DialogProvider() {
  const { t } = useI18n()
  const options = createDialogProviderOptions()
  return <DialogSelect title={t("dialog.connect_provider_title")} options={options()} />
}

function createProviderCompletion(props: { providerID: string; onConnected?: () => void; custom?: boolean }) {
  const refresh = createProviderRefresh()
  const dialog = useDialog()
  const sync = useSync()
  const toast = useToast()
  const { t } = useI18n()
  return () =>
    refresh(() => {
      if (props.onConnected) return props.onConnected()
      if (props.custom && !sync.data.provider_next.all.some((provider) => provider.id === props.providerID)) {
        toast.show({ variant: "info", message: t("toast.saved_credential", { providerID: props.providerID }) })
        return dialog.clear()
      }
      dialog.replace(() => <DialogModel providerID={props.providerID} />)
    })
}

interface AutoMethodProps {
  onConnected?: () => void
  index: number
  providerID: string
  title: string
  authorization: ProviderAuthAuthorization
}
function AutoMethod(props: AutoMethodProps) {
  const { t } = useI18n()
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const complete = createProviderCompletion(props)
  const toast = useToast()
  const clipboard = useClipboard()
  const [connecting, setConnecting] = createSignal(false)
  const active = { value: true }
  onCleanup(() => {
    active.value = false
    // Notify the server to tear down the in-flight OAuth flow so the local
    // callback server stops and pending state is cleared. Fire-and-forget:
    // the dialog is already gone, a failure here is harmless.
    void sdk.client.provider.oauth.cancel({ providerID: props.providerID }).catch(() => {})
  })
  const copyValue = () =>
    props.authorization.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0] ?? props.authorization.url

  useBindings(() => ({
    bindings: copyValue()
      ? [
          {
            key: "c",
            desc: t("dialog.keybind_copy_provider_code"),
            group: t("category.dialog"),
            cmd: () => {
              const code = copyValue()
              clipboard
                .write?.(code)
                .then(() => toast.show({ message: t("toast.copied_to_clipboard"), variant: "info" }))
                .catch(toast.error)
            },
          },
        ]
      : [],
  }))

  onMount(() => {
    void (async () => {
      const result = await sdk.client.provider.oauth.callback({
        providerID: props.providerID,
        method: props.index,
      })
      if (!active.value) return
      if (result.error) {
        toast.show({
          variant: "error",
          message:
            "name" in result.error && result.error.name === "ProviderAuthOauthCallbackFailed"
              ? t("toast.oauth_failed")
              : JSON.stringify(result.error),
        })
        dialog.clear()
        return
      }
      setConnecting(true)
      await complete()
    })().catch((error) => {
      if (!active.value) return
      toast.error(error)
      dialog.clear()
    })
  })

  return (
    <Show
      when={props.providerID === "deveco"}
      fallback={
        <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
          <box flexDirection="row" justifyContent="space-between" paddingLeft={props.providerID === "deveco" ? 2 : 0}>
            <text attributes={TextAttributes.BOLD} fg={theme.text}>
              {props.title}
            </text>
            <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
              {t("dialog.esc")}
            </text>
          </box>
          <box gap={1}>
            <Show when={props.authorization.url}>
              <Link href={props.authorization.url} fg={theme.primary} />
            </Show>
            <text fg={theme.textMuted}>{props.authorization.instructions}</text>
          </box>
          <text fg={theme.textMuted}>{t("dialog.waiting_for_authorization")}</text>
          <Show when={copyValue()}>
            <text fg={theme.text}>
              c <span style={{ fg: theme.textMuted }}>{t("dialog.action_copy_short")}</span>
            </text>
          </Show>
        </box>
      }
    >
      <DialogProviderProgress
        title={props.title}
        status={connecting() ? t("account.loading_models") : t("account.waiting_browser")}
        description={connecting() ? undefined : t("account.continue_browser")}
      >
        <Show when={copyValue()}>
          <text fg={theme.text}>
            c <span style={{ fg: theme.textMuted }}>{t("dialog.action_copy_short")}</span>
          </text>
        </Show>
      </DialogProviderProgress>
    </Show>
  )
}

interface CodeMethodProps {
  onConnected?: () => void
  index: number
  title: string
  providerID: string
  authorization: ProviderAuthAuthorization
}
function CodeMethod(props: CodeMethodProps) {
  const { t } = useI18n()
  const { theme } = useTheme()
  const sdk = useSDK()
  const complete = createProviderCompletion(props)
  const toast = useToast()
  const [error, setError] = createSignal(false)

  return (
    <DialogPrompt
      title={props.title}
      placeholder={t("dialog.placeholder_authorization_code")}
      onConfirm={async (value) => {
        const { error } = await sdk.client.provider.oauth.callback({
          providerID: props.providerID,
          method: props.index,
          code: value,
        })
        if (!error) {
          await complete().catch(toast.error)
          return
        }
        setError(true)
      }}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>{props.authorization.instructions}</text>
          <Link href={props.authorization.url} fg={theme.primary} />
          <Show when={error()}>
            <text fg={theme.error}>{t("dialog.invalid_code")}</text>
          </Show>
        </box>
      )}
    />
  )
}

interface ApiMethodProps {
  onConnected?: () => void
  providerID: string
  title: string
  metadata?: Record<string, string>
  custom?: boolean
}
function ApiMethod(props: ApiMethodProps) {
  const { t } = useI18n()
  const sdk = useSDK()
  const complete = createProviderCompletion(props)
  const toast = useToast()
  const { theme } = useTheme()
  const [busy, setBusy] = createSignal(false)
  const [saved, setSaved] = createSignal(false)
  const active = { value: true }
  onCleanup(() => {
    active.value = false
  })

  return (
    <DialogPrompt
      title={props.title}
      busy={busy()}
      busyText={saved() ? t("account.loading_models") : t("account.saving_key")}
      placeholder={t("dialog.placeholder_api_key")}
      description={
        {
          opencode: (
            <box gap={1}>
              <text fg={theme.textMuted}>{t("dialog.provider_opencode_zen_desc")}</text>
              <text fg={theme.text}>
                {t("dialog.go_to_url")}
                <span style={{ fg: theme.primary }}>https://opencode.ai/zen</span> to get a key
              </text>
            </box>
          ),
          "opencode-go": (
            <box gap={1}>
              <text fg={theme.textMuted}>{t("dialog.provider_opencode_go_desc")}</text>
              <text fg={theme.text}>
                {t("dialog.go_to_url")}
                <span style={{ fg: theme.primary }}>https://opencode.ai/go</span>
                {t("dialog.enable_opencode_go")}
              </text>
            </box>
          ),
        }[props.providerID] ?? undefined
      }
      onConfirm={async (value) => {
        if (!value.trim() || busy()) return
        setBusy(true)
        setSaved(false)
        try {
          await sdk.client.auth.set(
            {
              providerID: props.providerID,
              auth: {
                type: "api",
                key: value.trim(),
                ...(props.metadata ? { metadata: props.metadata } : {}),
              },
            },
            { throwOnError: true },
          )
          setSaved(true)
          await complete()
        } catch {
          if (active.value)
            toast.show({
              variant: "error",
              message: saved() ? t("account.key_loading_failed") : t("account.save_failed"),
            })
        } finally {
          if (active.value) setBusy(false)
        }
      }}
    />
  )
}

interface PromptsMethodProps {
  dialog: ReturnType<typeof useDialog>
  prompts: NonNullable<ProviderAuthMethod["prompts"]>[number][]
}
async function PromptsMethod(props: PromptsMethodProps) {
  const inputs: Record<string, string> = {}
  for (const prompt of props.prompts) {
    if (prompt.when) {
      const value = inputs[prompt.when.key]
      if (value === undefined) continue
      const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
      if (!matches) continue
    }

    if (prompt.type === "select") {
      const value = await new Promise<string | null>((resolve) => {
        props.dialog.replace(
          () => (
            <DialogSelect
              title={prompt.message}
              options={prompt.options.map((x) => ({
                title: x.label,
                value: x.value,
                description: x.hint,
              }))}
              onSelect={(option) => resolve(option.value)}
            />
          ),
          () => resolve(null),
        )
      })
      if (value === null) return null
      inputs[prompt.key] = value
      continue
    }

    const value = await new Promise<string | null>((resolve) => {
      props.dialog.replace(
        () => (
          <DialogPrompt title={prompt.message} placeholder={prompt.placeholder} onConfirm={(value) => resolve(value)} />
        ),
        () => resolve(null),
      )
    })
    if (value === null) return null
    inputs[prompt.key] = value
  }
  return inputs
}
