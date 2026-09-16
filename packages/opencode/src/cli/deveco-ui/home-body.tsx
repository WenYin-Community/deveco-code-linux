import { useI18n } from "@opencode-ai/tui/i18n"
/**
 * DevEco Home body — owns the entire center slot of the TUI Home page.
 *
 * Encapsulates:
 *  1. Login check (auth.json + OAuth entry)
 *  2. Agreement check (TMS API + KV cache)
 *  3. Onboarding UI (privacy / entry / auth / provider / key)
 *  4. Prompt UI (banner + prompt) once authed + compliant
 *
 * The generic TUI Home route renders this component through
 * `getDevEcoExtensions().homeBody` — when absent, it falls back to the
 * upstream (generic) Home layout.
 */
import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  on,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@opencode-ai/tui/context/theme"
import {
  Banner,
  BANNER_HOME_CONTENT_INSET,
  HOME_BODY_GAP_ROWS,
  HOME_BODY_MAX_ROWS,
  HOME_CONTENT_MAX_WIDTH,
  homeBodySlotRows,
} from "@opencode-ai/tui/component/banner"
import { useKV } from "@opencode-ai/tui/context/kv"
import { useArgs } from "@opencode-ai/tui/context/args"
import { useRouteData } from "@opencode-ai/tui/context/route"
import { usePromptRef } from "@opencode-ai/tui/context/prompt"
import { useLocal } from "@opencode-ai/tui/context/local"
import { useSDK } from "@opencode-ai/tui/context/sdk"
import { Prompt, type PromptRef } from "@opencode-ai/tui/component/prompt"
import { usePluginRuntime } from "@opencode-ai/tui/plugin/runtime"
import { HomeSessionDestinationProvider } from "@opencode-ai/tui/routes/home/session-destination"
import { Toast, useToast } from "@opencode-ai/tui/ui/toast"
import type { SyncObject } from "@opencode-ai/tui/deveco-extensions"
import { devecoAuth, hasDevecoOAuthEntry, ensureValidToken, loadIsRealNameFromDisk, UnsupportedRegionError, CHINA_ACCOUNT_ONLY_MESSAGE } from "@/plugin/deveco"
import { hasConfiguredDevEcoHome } from "@/tool/lib/env"
import { DevEcoOnboarding } from "./onboarding"
import { logWarn, logError } from "@/plugin/deveco/log"


// TODO: what is the best way to do this?
let once = false

// Cache DEVECO_HOME check — only check on initial startup, skip on /new
let devecoHomeChecked = false

const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

export function DevEcoHomeBody(props: { sync: SyncObject; bodySlotHeight: number }) {
  const sync = props.sync
  const kv = useKV()
  const sdk = useSDK()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const { t } = useI18n()
  const toast = useToast()

  const [devecoReady, setDevecoReady] = createSignal<boolean | null>(null)
  const [devecoInitialStep, setDevecoInitialStep] = createSignal<"entry" | "privacy" | "product-privacy" | "deveco-home">("entry")
  const [devecoSessionExpired, setDevecoSessionExpired] = createSignal(false)
  const [authCanEnter, setAuthCanEnter] = createSignal(false)
  const [authCheckDone, setAuthCheckDone] = createSignal(false)
  let devecoChecked = false
  const [devecoRealName, setDevecoRealName] = createSignal(false)
  const [devecoInitialAuthError, setDevecoInitialAuthError] = createSignal<string | undefined>(undefined)

  const bodySlotHeight = createMemo(() => homeBodySlotRows(dimensions().height))

  /**
   * Finish the auth check: show entry screen (with optional session-expired flag)
   * or the privacy agreement screen.
   */
  const finishCheck = (sessionExpired: boolean, step: "entry" | "privacy" = "entry") => {
    if (sessionExpired) setDevecoSessionExpired(true)
    setDevecoInitialStep(step)
    setDevecoReady(false)
    setAuthCheckDone(true)
  }

  const runDevecoCheck = async () => {
    if (sync.status === "loading" || sync.data.local_auth_error) return
    if (devecoChecked) return
    devecoChecked = true

    try {

    const product = await sdk.client.global.productAgreement({ throwOnError: true })
    const hasThirdParty = sync.data.provider.some((provider) =>
      provider.id !== "deveco" &&
      (provider.id !== "opencode" || Object.values(provider.models).some((model) => model.cost?.input)) &&
      Object.keys(provider.models).length > 0,
    )
    if (hasThirdParty) {
      if (!product.data?.accepted) {
        setDevecoInitialStep("product-privacy")
        setDevecoReady(false)
        setAuthCheckDone(true)
        return
      }
      setAuthCanEnter(true)
      setAuthCheckDone(true)
      setDevecoReady(true)
      return
    }

    if (hasDevecoOAuthEntry() && !product.data?.accepted) {
      setDevecoInitialStep("product-privacy")
      setDevecoReady(false)
      setAuthCheckDone(true)
      return
    }

    if (!hasDevecoOAuthEntry()) {
      return finishCheck(false)
    }

    const session = await devecoAuth.getSession()

    if (!session) {
      return finishCheck(false)
    }

    let accessToken = session.accessToken

    // Ensure token is valid — use cached token if not expired, refresh if needed.
    const validToken = await ensureValidToken()
    if (validToken) {
      accessToken = validToken
    } else if (!accessToken) {
      return finishCheck(await devecoAuth.isJwtExpired() === true)
    } else {
      // ensureValidToken() returned null but we have a cached access token.
      // This means a refresh was attempted and the server rejected the jwtToken.
      // Regardless of local exp, treat as session expired — the server no longer
      // trusts this token. Continuing would fall through to the real-name check
      // which also uses the same invalid jwtToken, creating a dead-end loop.
      setDevecoInitialAuthError(t("account.refresh_session_failed"))
      return finishCheck(await devecoAuth.isJwtExpired() === true)
    }

    // Check real-name status from disk cache first; only call API if uncertain.
    let isRealName = loadIsRealNameFromDisk()
    if (isRealName !== true) {
      isRealName = await devecoAuth.checkRealName() ?? false
    }
    if (!isRealName) {
      logWarn("real-name verification failed, blocking entry", { service: "deveco" })
      setDevecoRealName(true)
      setDevecoReady(false)
      setAuthCheckDone(true)
      return
    }

    const userId = session.userId || (await devecoAuth.getUserId()) || ""

    // Check if DEVECO_HOME is configured — only on initial startup, skip on /new
    if (!devecoHomeChecked) {
      devecoHomeChecked = true
      if (!(await hasConfiguredDevEcoHome())) {
        setDevecoInitialStep("deveco-home")
        setDevecoReady(false)
        setAuthCheckDone(true)
        return
      }
    }

    const result = await sdk.client.global.retryAgreementUpload({ force: false })
    if (result.data?.upload.state === "review_required") return finishCheck(false, "privacy")
    if (result.error) {
      logWarn("agreement upload remains pending; continuing with local acceptance", { service: "deveco" })
    }
    setAuthCanEnter(true)
    setAuthCheckDone(true)
    setDevecoReady(true)

    } catch (err) {
      if (err instanceof UnsupportedRegionError) {
        logError("runDevecoCheck blocked: unsupported account region", { service: "deveco" })
        setDevecoInitialAuthError(CHINA_ACCOUNT_ONLY_MESSAGE)
        return finishCheck(false)
      }
      // Any unhandled error must not
      // leave the UI stuck on "Checking login status…".  Fall back to the entry
      // screen so the user can at least re-login or exit.
      logError("runDevecoCheck failed", { service: "deveco", error: err instanceof Error ? err.message : String(err) })
      // Even if an error occurred, check if JWT is expired so we can show the
      // appropriate "session expired" message instead of the generic login prompt.
      finishCheck(await devecoAuth.isJwtExpired() === true)
    }
  }

  onMount(() => {
    void runDevecoCheck()
  })

  createEffect(() => {
    if (sync.status !== "loading" && !devecoChecked) void runDevecoCheck()
    if (sync.status === "complete" && authCanEnter()) {
      setDevecoReady(true)
    }
  })

  const mcpError = createMemo(() => {
    return Object.values(sync.data.mcp).some((x) => x.status === "failed")
  })

  const connectedMcpCount = createMemo(() => {
    return Object.values(sync.data.mcp).filter((x) => x.status === "connected").length
  })

  const Hint = (
    <Show when={connectedMcpCount() > 0}>
      <box flexShrink={0} flexDirection="row" gap={1}>
        <text fg={theme.text}>
          <Switch>
            <Match when={mcpError()}>
              <span style={{ fg: theme.error }}>•</span> mcp errors{" "}
              <span style={{ fg: theme.textMuted }}>ctrl+x s</span>
            </Match>
            <Match when={true}>
              <span style={{ fg: theme.success }}>•</span>{" "}
              {connectedMcpCount() === 1 ? "1 mcp server" : `${connectedMcpCount()} mcp servers`}
            </Match>
          </Switch>
        </text>
      </box>
    </Show>
  )

  let prompt: PromptRef | undefined
  const args = useArgs()
  const local = useLocal()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const pluginRuntime = usePluginRuntime()

  onMount(() => {
    if (once) return
    if (!prompt) return
    if (route.prompt) {
      prompt.set(route.prompt)
      once = true
    } else if (args.prompt) {
      prompt.set({ input: args.prompt, parts: [] })
      once = true
    }
  })

  createEffect(
    on(
      () => sync.ready && local.model.ready && prompt,
      (ready) => {
        if (!ready) return
        if (!args.prompt) return
        if (!prompt) return
        if (prompt.current?.input !== args.prompt) return
        prompt.submit()
      },
    ),
  )

  return (
    <HomeSessionDestinationProvider>
      <box flexGrow={1} flexDirection="column" minHeight={0}>
        <box
          flexGrow={1}
          minHeight={0}
          flexDirection="column"
          justifyContent="center"
          alignItems="center"
        >
          <box
            flexDirection="column"
            alignItems="center"
            width="100%"
            maxWidth={HOME_CONTENT_MAX_WIDTH}
            flexShrink={0}
            position="relative"
          >
            <box zIndex={0} flexShrink={0} width="100%" alignItems="center">
              <pluginRuntime.Slot name="home_logo" mode="replace">
                <Banner contentInset={BANNER_HOME_CONTENT_INSET} />
              </pluginRuntime.Slot>
            </box>
            <box
              zIndex={1}
              position="relative"
              width="100%"
              height={bodySlotHeight()}
              maxHeight={HOME_BODY_MAX_ROWS}
              flexDirection="column"
              justifyContent={devecoReady() === true ? "center" : "flex-start"}
              alignItems="center"
              paddingTop={HOME_BODY_GAP_ROWS}
              flexShrink={0}
            >
              <Show when={sync.data.local_auth_error}>
                <text fg={theme.error}>{sync.data.local_auth_error} Run `deveco auth reset` in a terminal, then reopen DevEco Code.</text>
              </Show>
              <Show when={!authCheckDone() && !sync.data.local_auth_error}>
                <text fg={theme.textMuted} selectable={false}>
                  {t("account.checking_setup")}
                </text>
              </Show>
              <Show when={authCheckDone() && authCanEnter() && devecoReady() !== true}>
                <box flexDirection="column" alignItems="center">
                  <text fg={theme.textMuted} selectable={false}>
                    {t("account.loading_project")}
                  </text>
                  <text fg={theme.textMuted} selectable={false}>
                    providers, MCP servers, LSP, sessions...
                  </text>
                </box>
              </Show>
              <Show when={devecoReady()}>
                <box width="100%" flexDirection="column" alignItems="center" flexShrink={0}>
                  <box width="100%" flexShrink={0}>
                    <pluginRuntime.Slot name="home_prompt" mode="replace">
                      <Prompt
                        ref={(r) => {
                          if (r) {
                            prompt = r
                            promptRef.set(r)
                          }
                        }}
                        hint={Hint}
                        placeholders={placeholder}
                        homeBodySlotHeight={bodySlotHeight()}
                      />
                    </pluginRuntime.Slot>
                  </box>
                  <pluginRuntime.Slot name="home_bottom" />
                </box>
              </Show>
              <Show when={devecoReady() === false}>
                <DevEcoOnboarding
                  onComplete={() => {
                    devecoChecked = false
                    void runDevecoCheck()
                  }}
                  bodySlotHeight={bodySlotHeight()}
                  initialStep={devecoInitialStep()}
                  sessionExpired={devecoSessionExpired()}
                  initialRealName={devecoRealName()}
                  initialAuthError={devecoInitialAuthError()}
                />
              </Show>
            </box>
          </box>
        </box>
        <Toast />
      </box>
      <box width="100%" flexShrink={0}>
        <pluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </HomeSessionDestinationProvider>
  )
}
