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

  // Composite key describing the gate's current decision.
  // Used with <Show keyed> to force-remount DevEcoOnboarding when the gate
  // re-runs and decides a different destination step. Without this, the second
  // gate run writes new initialStep/sessionExpired/initialRealName values that
  // the already-mounted onboarding component never consumes, causing a deadlock
  // where Continue loops back to the same panel forever.
  // Every part of the key is written by `applyGate` on every run, so the key
  // always describes the latest decision and never a leftover flag from an
  // earlier one.
  const devecoGateKey = createMemo(() =>
    `${devecoInitialStep()}:${devecoRealName()}:${devecoSessionExpired()}:${devecoInitialAuthError() ?? ""}`,
  )

  /**
   * Where the onboarding slot should go once the gate has run. Every exit of
   * `runDevecoCheck` produces exactly one of these.
   */
  type GateDestination = {
    step: "ready" | "realname" | "entry" | "deveco-home" | "privacy" | "product-privacy"
    sessionExpired?: boolean
    authError?: string
  }

  /**
   * Apply one gate decision. Every derived signal is written in a single
   * synchronous block, including clearing the transient ones, so that:
   *   - a re-run gate cannot leave a stale real-name / session-expired /
   *     auth-error flag behind to shadow the new destination, and
   *   - `devecoGateKey` changes exactly once per run, i.e. at most one remount.
   */
  const applyGate = (destination: GateDestination) => {
    setDevecoInitialStep(destination.step === "ready" || destination.step === "realname" ? "entry" : destination.step)
    setDevecoRealName(destination.step === "realname")
    setDevecoSessionExpired(destination.step === "entry" && destination.sessionExpired === true)
    setDevecoInitialAuthError(destination.step === "entry" ? destination.authError : undefined)
    setAuthCanEnter(destination.step === "ready")
    setAuthCheckDone(true)
    setDevecoReady(destination.step === "ready")
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
      if (!product.data?.accepted) return applyGate({ step: "product-privacy" })
      return applyGate({ step: "ready" })
    }

    if (hasDevecoOAuthEntry() && !product.data?.accepted) {
      return applyGate({ step: "product-privacy" })
    }

    if (!hasDevecoOAuthEntry()) {
      return applyGate({ step: "entry" })
    }

    const session = await devecoAuth.getSession()

    if (!session) {
      return applyGate({ step: "entry", sessionExpired: await devecoAuth.isJwtExpired() === true })
    }

    let accessToken = session.accessToken

    // Ensure token is valid — use cached token if not expired, refresh if needed.
    const validToken = await ensureValidToken()
    if (validToken) {
      accessToken = validToken
    } else if (!accessToken) {
      return applyGate({ step: "entry", sessionExpired: await devecoAuth.isJwtExpired() === true })
    } else {
      // ensureValidToken() returned null but we have a cached access token.
      // This means a refresh was attempted and the server rejected the jwtToken.
      // Regardless of local exp, treat as session expired — the server no longer
      // trusts this token. Continuing would fall through to the real-name check
      // which also uses the same invalid jwtToken, creating a dead-end loop.
      return applyGate({
        step: "entry",
        sessionExpired: await devecoAuth.isJwtExpired() === true,
        authError: t("account.refresh_session_failed"),
      })
    }

    // Check real-name status from disk cache first; only call API if uncertain.
    let isRealName = loadIsRealNameFromDisk()
    if (isRealName !== true) {
      isRealName = await devecoAuth.checkRealName() ?? false
    }
    if (!isRealName) {
      logWarn("real-name verification failed, blocking entry", { service: "deveco" })
      return applyGate({ step: "realname" })
    }

    const userId = session.userId || (await devecoAuth.getUserId()) || ""

    // Check if DEVECO_HOME is configured — only on initial startup, skip on /new
    if (!devecoHomeChecked) {
      devecoHomeChecked = true
      if (!(await hasConfiguredDevEcoHome())) {
        return applyGate({ step: "deveco-home" })
      }
    }

    const result = await sdk.client.global.retryAgreementUpload({ force: false })
    if (result.data?.upload.state === "review_required") return applyGate({ step: "privacy" })
    if (result.error) {
      logWarn("agreement upload remains pending; continuing with local acceptance", { service: "deveco" })
    }
    applyGate({ step: "ready" })

    } catch (err) {
      if (err instanceof UnsupportedRegionError) {
        logError("runDevecoCheck blocked: unsupported account region", { service: "deveco" })
        return applyGate({ step: "entry", authError: CHINA_ACCOUNT_ONLY_MESSAGE })
      }
      // Any unhandled error must not
      // leave the UI stuck on "Checking login status…".  Fall back to the entry
      // screen so the user can at least re-login or exit.
      logError("runDevecoCheck failed", { service: "deveco", error: err instanceof Error ? err.message : String(err) })
      // Even if an error occurred, check if JWT is expired so we can show the
      // appropriate "session expired" message instead of the generic login prompt.
      applyGate({ step: "entry", sessionExpired: await devecoAuth.isJwtExpired() === true })
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
              <Show when={devecoReady() === false ? devecoGateKey() : undefined} keyed>
                {(_) => (
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
                )}
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
