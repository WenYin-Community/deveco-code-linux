import { useI18n } from "../i18n"
import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type { AuthListResponse } from "@opencode-ai/sdk/v2"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useToast } from "../ui/toast"
import { createDialogProviderOptions } from "./dialog-provider"
import { DialogProviderProgress } from "./dialog-provider-progress"
import { createProviderRefresh } from "./provider-refresh"

export function DialogAuth() {
  const { t } = useI18n()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const connections = createDialogProviderOptions({ onConnected: () => dialog.replace(() => <DialogAuth />) })
  const [state, setState] = createStore({ loading: true, error: "", credentials: [] as AuthListResponse })
  const controller = new AbortController()
  onCleanup(() => controller.abort())

  const load = async () => {
    setState({ loading: true, error: "" })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // The worker RPC transport does not propagate AbortSignal. Bound the UI wait too.
      const result = await Promise.race([
        sdk.client.auth.list({ throwOnError: true, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), 10_000)
        }),
      ])
      if (controller.signal.aborted) return
      if (!Array.isArray(result.data)) throw new Error("Invalid credential response")
      setState("credentials", result.data)
    } catch {
      if (!controller.signal.aborted) setState("error", t("account.unavailable"))
    } finally {
      clearTimeout(timer)
      if (!controller.signal.aborted) setState("loading", false)
    }
  }
  onMount(() => {
    void load()
  })

  const options = createMemo(() => {
    const ids = [
      ...new Set([
        ...connections().map((option) => option.value),
        ...state.credentials.map((credential) => credential.providerID),
      ]),
    ]
    const configured = new Set([
      ...Object.keys(sync.data.config?.provider ?? {}),
      ...sync.data.provider_next.connected,
      ...state.credentials.map((credential) => credential.providerID),
    ])
    const rank = (id: string) => (id === "deveco" ? 0 : configured.has(id) ? 1 : 2)
    return ids
      .sort((a, b) => rank(a) - rank(b))
      .map((id) => {
        const connection = connections().find((option) => option.value === id)
        const credential = state.credentials.find((item) => item.providerID === id)
        const name = id === "deveco" ? t("account.huawei_name") : (connection?.title ?? id)
        const connected = sync.data.provider_next.connected.includes(id)
        const status = credential
          ? !credential.removable
            ? t("account.environment")
            : credential.type === "oauth"
              ? t("account.saved_account")
              : t("account.saved_key")
          : state.loading
            ? t("account.checking")
            : state.error
              ? t("account.unknown")
              : connected
                ? t("account.configured_access")
                : t("account.disconnected")
        return {
          title: name,
          value: id,
          description: status,
          category:
            id === "deveco" ? t("account.huawei") : configured.has(id) ? t("account.configured") : t("account.others"),
          onSelect() {
            dialog.replace(() => (
              <AuthActions
                title={name}
                providerID={id}
                credential={credential}
                connect={connection ? () => connection.onSelect() : undefined}
              />
            ))
          },
        }
      })
  })

  return (
    <DialogSelect
      title={t("account.title")}
      options={[
        ...options(),
        {
          title: state.loading
            ? t("account.loading_credentials")
            : state.error
              ? t("account.retry_credentials")
              : t("account.refresh_credentials"),
          description: state.error,
          value: "refresh",
          category: t("account.status"),
          disabled: state.loading,
          onSelect: () => {
            void load()
          },
        },
      ]}
    />
  )
}

function AuthActions(props: {
  title: string
  providerID: string
  credential?: AuthListResponse[number]
  connect?: () => unknown
}) {
  const { t } = useI18n()
  const dialog = useDialog()
  const toast = useToast()
  const options = createMemo(() => {
    const result: DialogSelectOption<string>[] = []
    if (props.connect)
      result.push({
        title:
          props.providerID === "deveco"
            ? t("account.signin")
            : props.credential
              ? t("account.update")
              : t("account.connect"),
        value: "connect",
        onSelect: () => {
          Promise.resolve()
            .then(() => props.connect?.())
            .catch(toast.error)
        },
      })
    if (props.credential?.removable)
      result.push({
        title: props.providerID === "deveco" ? t("account.signout") : t("account.remove_saved"),
        value: "remove",
        async onSelect() {
          const confirmed = await DialogConfirm.show(
            dialog,
            t("account.remove_title", { name: props.title }),
            props.providerID === "deveco" ? t("account.signout_description") : t("account.remove_description"),
            { confirmLabel: t("account.remove"), cancelLabel: t("account.cancel"), initialActive: "cancel" },
          )
          if (confirmed === undefined) return
          if (!confirmed) return dialog.replace(() => <DialogAuth />)
          dialog.replace(() => <RemoveCredential providerID={props.providerID} />)
        },
      })
    return result
  })
  return (
    <DialogSelect
      title={props.title}
      options={options()}
      renderFilter={false}
      skipFilter={true}
      bindings={[
        {
          key: "left",
          desc: t("account.back"),
          group: t("account.dialog"),
          cmd: () => dialog.replace(() => <DialogAuth />),
        },
      ]}
      footerHints={[
        { title: "←", label: t("account.back") },
        { title: "Enter", label: t("account.select") },
      ]}
    />
  )
}

function RemoveCredential(props: { providerID: string }) {
  const { t } = useI18n()
  const sdk = useSDK()
  const refresh = createProviderRefresh()
  const dialog = useDialog()
  const toast = useToast()
  const [removed, setRemoved] = createSignal(false)
  const active = { value: true }
  onCleanup(() => {
    active.value = false
  })
  onMount(() => {
    void (async () => {
      await sdk.client.auth.remove({ providerID: props.providerID }, { throwOnError: true })
      setRemoved(true)
      await refresh(() => {
        toast.show({ variant: "success", message: t("account.removed") })
        dialog.replace(() => <DialogAuth />)
      })
    })().catch(() => {
      if (!active.value) return
      toast.show({
        variant: "error",
        message: removed() ? t("account.removed_refresh_failed") : t("account.remove_failed"),
      })
      dialog.replace(() => <DialogAuth />)
    })
  })
  return (
    <DialogProviderProgress
      title={props.providerID === "deveco" ? t("account.signout") : t("account.remove_provider")}
      status={
        removed()
          ? t("account.refreshing")
          : props.providerID === "deveco"
            ? t("account.signing_out")
            : t("account.removing")
      }
    />
  )
}
