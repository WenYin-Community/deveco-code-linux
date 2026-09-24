import { useI18n } from "@opencode-ai/tui/i18n"
import { useTheme } from "@opencode-ai/tui/context/theme"
import { useBindings } from "@opencode-ai/tui/keymap"
import { useSDK } from "@opencode-ai/tui/context/sdk"
import { useSync } from "@opencode-ai/tui/context/sync"
import { useToast } from "@opencode-ai/tui/ui/toast"
import { useDialog } from "@opencode-ai/tui/ui/dialog"
import { Link } from "@opencode-ai/tui/ui/link"
import { Show, createSignal, onCleanup } from "solid-js"
import open from "open"
import HuaweiEndpoints from "../../../huawei-endpoints.json"
import { logInfo, logError } from "@/plugin/deveco/log"

const DEVECO_PROVIDER_ID = "deveco"
const DEVECO_OAUTH_METHOD_INDEX = 0

export function DialogRealName(props: { onComplete: () => void }) {
  const { t } = useI18n()
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const dialog = useDialog()
  const [index, setIndex] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const active = { value: true }
  let callbackInFlight = false

  onCleanup(() => {
    active.value = false
    if (callbackInFlight) {
      void sdk.client.provider.oauth.cancel({ providerID: DEVECO_PROVIDER_ID }).catch(() => {})
    }
  })

  const authenticate = () => {
    logInfo("opening real-name authentication page in browser", { service: "deveco", url: HuaweiEndpoints.huaweiRealnameAuth })
    open(HuaweiEndpoints.huaweiRealnameAuth).catch((err) => {
      logError("failed to open real-name authentication page", { service: "deveco", error: err instanceof Error ? err.message : String(err) })
    })
  }

  const recheck = async () => {
    if (busy()) return
    setBusy(true)
    setError(null)
    try {
      const authorizeResult = await sdk.client.provider.oauth.authorize({
        providerID: DEVECO_PROVIDER_ID,
        method: DEVECO_OAUTH_METHOD_INDEX,
      })
      if (!active.value) return
      if (authorizeResult.error) {
        setError(JSON.stringify(authorizeResult.error))
        return
      }

      callbackInFlight = true
      const callbackResult = await sdk.client.provider.oauth.callback({
        providerID: DEVECO_PROVIDER_ID,
        method: DEVECO_OAUTH_METHOD_INDEX,
      })
      callbackInFlight = false
      if (!active.value) return
      if (callbackResult.error) {
        const msg = "name" in callbackResult.error && callbackResult.error.name === "ProviderAuthOauthCallbackFailed"
          ? t("account.login_failed")
          : JSON.stringify(callbackResult.error)
        setError(msg)
        return
      }

      const authList = await sdk.client.auth.list()
      if (!active.value) return
      const devecoEntry = authList.data?.find(a => a.providerID === DEVECO_PROVIDER_ID)
      if (devecoEntry?.isRealName !== true) {
        if (devecoEntry?.isRealName === false) {
          toast.show({ variant: "warning", message: t("account.realname_incomplete"), duration: 3000 })
        } else {
          setError(t("account.login_failed"))
        }
        return
      }

      try {
        await sync.bootstrap({ fatal: false })
        await new Promise(resolve => setTimeout(resolve, 0))
      } catch {
        // Credentials are already saved by auth.set on the server.
        // Sync refresh failure is non-fatal — the fetch hook reads new credentials from disk.
      }
      if (!active.value) return

      props.onComplete()
    } catch (err) {
      if (!active.value) return
      setError(err instanceof Error ? err.message : t("account.login_failed"))
    } finally {
      if (active.value) setBusy(false)
    }
  }

  useBindings(() => ({
    enabled: !busy(),
    bindings: [
      { key: "up", desc: t("account.realname_go"), group: t("category.dialog"), cmd: () => setIndex(Math.max(0, index() - 1)) },
      { key: "down", desc: t("account.realname_recheck"), group: t("category.dialog"), cmd: () => setIndex(Math.min(2, index() + 1)) },
      {
        key: "return",
        desc: t("dialog.action_dismiss"),
        group: t("category.dialog"),
        cmd: () => {
          if (index() === 0) authenticate()
          else if (index() === 1) void recheck()
          else props.onComplete()
        },
      },
    ],
  }))

  return (
    <box flexDirection="column" width="100%" paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <text fg={theme.warning}>
          <b>{t("account.realname_title")}</b>
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          {t("dialog.esc")}
        </text>
      </box>
      <text fg={theme.text} wrapMode="word">
        {t("account.realname_description")}
      </text>
      <Link href={HuaweiEndpoints.huaweiRealnameAuth} fg={theme.primary}>
        {t("account.realname_link")}
      </Link>
      <Show when={busy()}>
        <box flexDirection="column" marginTop={1} gap={1}>
          <text fg={theme.textMuted}>{t("account.waiting_browser")}</text>
          <text fg={theme.textMuted}>{t("account.continue_browser")}</text>
        </box>
      </Show>
      <Show when={!busy()}>
        <box flexDirection="column" marginTop={1} gap={0}>
          <text fg={index() === 0 ? theme.success : theme.text}>
            {index() === 0 ? "> " : "  "}
            {t("account.realname_go")}
          </text>
          <text fg={index() === 1 ? theme.success : theme.text}>
            {index() === 1 ? "> " : "  "}
            {t("account.realname_recheck")}
          </text>
          <text fg={index() === 2 ? theme.success : theme.text}>
            {index() === 2 ? "> " : "  "}
            {t("account.realname_back")}
          </text>
        </box>
        <text fg={theme.textMuted} marginTop={1}>
          {t("account.select_hint")}
        </text>
      </Show>
      <Show when={error() !== null}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}
