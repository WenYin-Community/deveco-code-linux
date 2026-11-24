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
import { createEffect, createMemo, createRenderEffect, createSignal, Match, on, onCleanup, onMount, Show, Switch } from "solid-js"
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
import { useArgs } from "@opencode-ai/tui/context/args"
import { useRouteData } from "@opencode-ai/tui/context/route"
import { usePromptRef } from "@opencode-ai/tui/context/prompt"
import { useLocal } from "@opencode-ai/tui/context/local"
import { useSDK } from "@opencode-ai/tui/context/sdk"
import { useAnnouncements } from "@opencode-ai/tui/context/announcements"
import { providerRevision } from "@opencode-ai/tui/context/sync"
import { Prompt, type PromptRef } from "@opencode-ai/tui/component/prompt"
import { usePluginRuntime } from "@opencode-ai/tui/plugin/runtime"
import { HomeSessionDestinationProvider } from "@opencode-ai/tui/routes/home/session-destination"
import { Toast } from "@opencode-ai/tui/ui/toast"
import { DialogAlert } from "@opencode-ai/tui/ui/dialog-alert"
import {
  markReservedProviderNoticeShown,
  reservedProviderConfigFileName,
  reservedProviderNoticePending,
  wrapNoticeMessage,
} from "./reserved-provider-notice"
import { useDialog } from "@opencode-ai/tui/ui/dialog"
import { getDevEcoExtensions, type SyncObject } from "@opencode-ai/tui/deveco-extensions"
import {
  devecoAuth,
  hasDevecoOAuthEntry,
  ensureValidToken,
  loadIsRealNameFromDisk,
  UnsupportedRegionError,
  CHINA_ACCOUNT_ONLY_MESSAGE,
} from "@/plugin/deveco"
import { getCurrentImprovementConsent } from "@/plugin/deveco/improvement-consent"
import { hasConfiguredDevEcoHome } from "@/tool/lib/env"
import { DevEcoOnboarding } from "./onboarding"
import { logWarn, logError } from "@/plugin/deveco/log"

// These flags outlive Home remounts.
let once = false
let devecoHomeChecked = false

export function resetDevecoHomeCheck() {
  devecoHomeChecked = false
}

const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

type HomeProps = {
  sync: SyncObject
  bodySlotHeight: number
  onImprovementChange?: (enabled: boolean) => void | Promise<void>
}

type GateDestination = {
  step: "ready" | "realname" | "entry" | "deveco-home" | "privacy" | "product-privacy"
  sessionExpired?: boolean
  authError?: string
  reviewRevision?: string
}

type ProductState = Awaited<ReturnType<ReturnType<typeof useSDK>["client"]["global"]["productAgreement"]>>["data"]
type HomeGate = ReturnType<typeof createHomeGate>

export function DevEcoHomeBody(props: HomeProps) {
  const dimensions = useTerminalDimensions()
  const dialog = useDialog()
  const gate = createHomeGate(props.sync)
  createRenderEffect(() => {
    if (!gate.ready()) onCleanup(dialog.blockAutomatic())
  })
  const prompt = createHomePrompt(props.sync)
  createImprovementPrompt(props.sync, gate.ready)
  createReservedProviderWarning(props.sync, gate.ready)
  return (
    <HomeSessionDestinationProvider>
      <HomeLayout {...props} gate={gate} prompt={prompt} bodySlotHeight={homeBodySlotRows(dimensions().height)} />
    </HomeSessionDestinationProvider>
  )
}

function createHomeGate(sync: SyncObject) {
  const [destination, setDestination] = createSignal<GateDestination>()
  const check = createGateCheck(sync, setDestination)
  onMount(() => void check.run())
  createEffect(() => {
    void sync.status
    void check.run()
  })
  createEffect(on(() => providerRevision(sync.data), check.retry, { defer: true }))
  return {
    destination,
    ready: () => destination()?.step === "ready",
    checked: () => destination() !== undefined,
    // One decision replaces all transient flags atomically. Its key also
    // remounts onboarding when a new review revision keeps the same step.
    key: () => JSON.stringify(destination()),
    retry: check.retry,
  }
}

function createGateCheck(sync: SyncObject, apply: (destination: GateDestination) => void) {
  const sdk = useSDK()
  const announcements = useAnnouncements()
  const { t } = useI18n()
  let checked = false
  let revision = 0
  onCleanup(() => revision++)
  const run = async () => {
    if (!canCheckHome(sync)) return
    if (checked) return
    checked = true
    const current = ++revision
    const destination = await resolveHomeDestination(sync, sdk, t, (agreement) => {
      if (current === revision) announcements.setAgreement(agreement)
    }).catch(homeCheckFailure)
    if (current === revision) apply(destination)
  }
  return {
    run,
    retry: () => {
      checked = false
      void run()
    },
  }
}

function canCheckHome(sync: SyncObject) {
  return sync.status !== "loading" && !sync.data.local_auth_error
}

async function resolveHomeDestination(
  sync: SyncObject,
  sdk: ReturnType<typeof useSDK>,
  t: ReturnType<typeof useI18n>["t"],
  onAgreement: (agreement: ProductState) => void,
): Promise<GateDestination> {
  const product = await sdk.client.global.productAgreement({ throwOnError: true })
  onAgreement(product.data)
  const review = reviewDestination(product.data)
  if (review) return review
  if (hasThirdPartyProvider(sync)) return thirdPartyDestination(product.data)
  return builtInDestination(product.data, t)
}

function reviewDestination(product: ProductState): GateDestination | undefined {
  if (!product?.accepted) return
  if (product.upload.state === "review_required") return { step: "privacy", reviewRevision: product.upload.revision }
}

function hasThirdPartyProvider(sync: SyncObject) {
  return sync.data.provider.some((provider) => {
    if (provider.id === "deveco") return false
    if (provider.id === "opencode") return Object.values(provider.models).some((model) => model.cost?.input)
    return Object.keys(provider.models).length > 0
  })
}

async function thirdPartyDestination(product: ProductState): Promise<GateDestination> {
  if (!product?.accepted) return { step: "product-privacy" }
  return configuredHomeDestination()
}

async function builtInDestination(product: ProductState, t: ReturnType<typeof useI18n>["t"]): Promise<GateDestination> {
  if (!hasDevecoOAuthEntry()) return { step: "entry" }
  if (!product?.accepted) return { step: "product-privacy" }
  return authenticatedDestination(t)
}

async function authenticatedDestination(t: ReturnType<typeof useI18n>["t"]): Promise<GateDestination> {
  const session = await devecoAuth.getSession()
  if (!session) return expiredEntry()
  const expired = await verifyHomeSession(session.accessToken, t)
  if (expired) return expired
  if (!(await realNameVerified())) {
    logWarn("real-name verification failed, blocking entry", { service: "deveco" })
    return { step: "realname" }
  }
  return configuredHomeDestination()
}

async function verifyHomeSession(accessToken: string | undefined, t: ReturnType<typeof useI18n>["t"]) {
  if (await ensureValidToken()) return
  // A rejected refresh invalidates even a locally cached access token.
  return expiredEntry(accessToken ? t("account.refresh_session_failed") : undefined)
}

async function expiredEntry(authError?: string): Promise<GateDestination> {
  return { step: "entry", sessionExpired: (await devecoAuth.isJwtExpired()) === true, authError }
}

async function realNameVerified() {
  if (loadIsRealNameFromDisk() === true) return true
  return (await devecoAuth.checkRealName()) ?? false
}

async function configuredHomeDestination(): Promise<GateDestination> {
  if (devecoHomeChecked) return { step: "ready" }
  devecoHomeChecked = true
  return { step: (await hasConfiguredDevEcoHome()) ? "ready" : "deveco-home" }
}

async function homeCheckFailure(error: unknown): Promise<GateDestination> {
  if (error instanceof UnsupportedRegionError) {
    logError("runDevecoCheck blocked: unsupported account region", { service: "deveco" })
    return { step: "entry", authError: CHINA_ACCOUNT_ONLY_MESSAGE }
  }
  logError("runDevecoCheck failed", {
    service: "deveco",
    error: error instanceof Error ? error.message : String(error),
  })
  return expiredEntry()
}

/**
 * The provider layer drops a user `provider.deveco` entry because that id belongs to the
 * built-in model catalog. Announce it on the home screen: a toast emitted from the server's
 * config hook races the TUI event subscription, so it never reaches the user at startup.
 */
function createReservedProviderWarning(sync: SyncObject, ready: () => boolean) {
  const dialog = useDialog()
  const { t } = useI18n()
  // The schema lets the user keep either extension, so name the file they actually have.
  const configFile = reservedProviderConfigFileName()
  createEffect(() => {
    if (!ready()) return
    if (!reservedProviderNoticePending(sync.data.config)) return
    markReservedProviderNoticeShown()
    // Rendered directly instead of DialogAlert.show so the short alert can drop its extra
    // vertical padding; the title/message follow the TUI locale like every other dialog.
    void new Promise<void>((resolve) => {
      dialog.replace(
        () => (
          <DialogAlert
            title={t("account.reserved_provider_title")}
            message={wrapNoticeMessage(t("account.reserved_provider_message", { file: configFile }), 48)}
            wrapMode="none"
            onConfirm={() => resolve()}
          />
        ),
        () => resolve(),
      )
      // replace() resets the panel to medium/top, so re-apply the layout we want for this short
      // one-paragraph notice: centered, and 80% of the default width.
      dialog.setAlign("center")
      dialog.setSize("narrow")
    })
  })
}

function createImprovementPrompt(sync: SyncObject, ready: () => boolean) {
  const dialog = useDialog()
  let prompted = false
  createEffect(() => {
    if (!canPromptImprovement(sync, ready())) return
    if (!hasDevecoOAuthEntry()) {
      prompted = false
      return
    }
    if (prompted) return
    prompted = true
    void showImprovementPrompt(dialog)
  })
}

function canPromptImprovement(sync: SyncObject, ready: boolean) {
  // Track provider refreshes even when readiness itself has not changed.
  void sync.data.provider_next.all.length
  return sync.status === "complete" && ready
}

async function showImprovementPrompt(dialog: ReturnType<typeof useDialog>) {
  if ((await getCurrentImprovementConsent()) !== undefined) return
  const ImprovementConsentDialog = getDevEcoExtensions().improvementConsentDialog
  if (ImprovementConsentDialog) dialog.replace(() => <ImprovementConsentDialog onComplete={() => dialog.clear()} />)
}

function createHomePrompt(sync: SyncObject) {
  let prompt: PromptRef | undefined
  const args = useArgs()
  const local = useLocal()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  onMount(() => {
    if (once) return
    if (!prompt) return
    const initial = initialHomePrompt(route.prompt, args.prompt)
    if (!initial) return
    prompt.set(initial)
    once = true
  })
  createEffect(
    on(
      () => sync.ready && local.model.ready && prompt,
      () => {
        if (!args.prompt) return
        if (!prompt) return
        if (prompt.current.input !== args.prompt) return
        prompt.submit()
      },
    ),
  )
  return (value: PromptRef | undefined) => {
    // The provider outlives Prompt; cleanup must clear its detached reference.
    prompt = value
    promptRef.set(value)
  }
}

function initialHomePrompt(prompt: ReturnType<typeof useRouteData<"home">>["prompt"], input?: string) {
  if (prompt) return prompt
  if (input) return { input, parts: [] }
}

type HomeViewProps = HomeProps & { gate: HomeGate; prompt: ReturnType<typeof createHomePrompt> }

function HomeLayout(props: HomeViewProps) {
  const pluginRuntime = usePluginRuntime()
  return (
    <>
      <box flexGrow={1} flexDirection="column" minHeight={0}>
        <box flexGrow={1} minHeight={0} flexDirection="column" justifyContent="center" alignItems="center">
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
            <HomeContent {...props} />
          </box>
        </box>
        <Toast />
      </box>
      <box width="100%" flexShrink={0}>
        <pluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </>
  )
}

function HomeContent(props: HomeViewProps) {
  return (
    <box
      zIndex={1}
      position="relative"
      width="100%"
      height={props.bodySlotHeight}
      maxHeight={HOME_BODY_MAX_ROWS}
      flexDirection="column"
      justifyContent={props.gate.ready() ? "center" : "flex-start"}
      alignItems="center"
      paddingTop={HOME_BODY_GAP_ROWS}
      flexShrink={0}
    >
      <HomeStatus sync={props.sync} gate={props.gate} />
      <Show when={props.gate.ready()}>
        <HomePrompt {...props} />
      </Show>
      <Show when={props.gate.checked() && !props.gate.ready() ? props.gate.key() : undefined} keyed>
        {(_) => <HomeOnboarding {...props} />}
      </Show>
    </box>
  )
}

function HomeStatus(props: { sync: SyncObject; gate: HomeGate }) {
  const { theme } = useTheme()
  const { t } = useI18n()
  return (
    <>
      <Show when={props.sync.data.local_auth_error}>
        <text fg={theme.error}>
          {props.sync.data.local_auth_error} Run `deveco auth reset` in a terminal, then reopen DevEco Code.
        </text>
      </Show>
      <Show when={!props.gate.checked() && !props.sync.data.local_auth_error}>
        <text fg={theme.textMuted} selectable={false}>
          {t("account.checking_setup")}
        </text>
      </Show>
    </>
  )
}

function onboardingStep(step: GateDestination["step"]) {
  if (step === "ready" || step === "realname") return "entry"
  return step
}

function HomeOnboarding(props: HomeViewProps) {
  const destination = props.gate.destination()!
  return (
    <DevEcoOnboarding
      onComplete={props.gate.retry}
      bodySlotHeight={props.bodySlotHeight}
      initialStep={onboardingStep(destination.step)}
      sessionExpired={destination.step === "entry" && destination.sessionExpired === true}
      initialRealName={destination.step === "realname"}
      initialAuthError={destination.step === "entry" ? destination.authError : undefined}
      reviewRequired={destination.reviewRevision !== undefined}
      onImprovementChange={props.onImprovementChange}
    />
  )
}

function HomePrompt(props: HomeViewProps) {
  const pluginRuntime = usePluginRuntime()
  return (
    <box width="100%" flexDirection="column" alignItems="center" flexShrink={0}>
      <box width="100%" flexShrink={0}>
        <pluginRuntime.Slot name="home_prompt" mode="replace">
          <Prompt
            ref={props.prompt}
            hint={<McpHint sync={props.sync} />}
            placeholders={placeholder}
            homeBodySlotHeight={props.bodySlotHeight}
          />
        </pluginRuntime.Slot>
      </box>
      <pluginRuntime.Slot name="home_bottom" />
    </box>
  )
}

function McpHint(props: { sync: SyncObject }) {
  const { theme } = useTheme()
  const mcpError = createMemo(() => Object.values(props.sync.data.mcp).some((x) => x.status === "failed"))
  const count = createMemo(() => Object.values(props.sync.data.mcp).filter((x) => x.status === "connected").length)
  return (
    <Show when={count() > 0}>
      <box flexShrink={0} flexDirection="row" gap={1}>
        <text fg={theme.text}>
          <Switch>
            <Match when={mcpError()}>
              <span style={{ fg: theme.error }}>•</span> mcp errors{" "}
              <span style={{ fg: theme.textMuted }}>ctrl+x s</span>
            </Match>
            <Match when={true}>
              <span style={{ fg: theme.success }}>•</span> {count() === 1 ? "1 mcp server" : `${count()} mcp servers`}
            </Match>
          </Switch>
        </text>
      </box>
    </Show>
  )
}
