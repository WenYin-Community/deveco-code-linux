/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, mock, test } from "bun:test"
import { createSignal, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { json } from "../../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../../../../tui/test/fixture/tui-runtime"
import { ThemeProvider } from "@opencode-ai/tui/context/theme"
import { TuiConfigProvider } from "@opencode-ai/tui/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "@opencode-ai/tui/keymap"
import { SDKProvider } from "@opencode-ai/tui/context/sdk"
import { ProjectProvider } from "@opencode-ai/tui/context/project"
import { SyncContext, useSync, bumpProviderRevision } from "@opencode-ai/tui/context/sync"
import { KVProvider } from "@opencode-ai/tui/context/kv"
import { I18nProvider } from "@opencode-ai/tui/i18n"
import { ExitProvider } from "@opencode-ai/tui/context/exit"
import { ArgsProvider } from "@opencode-ai/tui/context/args"
import { PromptRefProvider } from "@opencode-ai/tui/context/prompt"
import { RouteProvider } from "@opencode-ai/tui/context/route"
import { DialogProvider } from "@opencode-ai/tui/ui/dialog"
import { ToastProvider } from "@opencode-ai/tui/ui/toast"
import { DevEcoHomeBody, resetDevecoHomeCheck } from "@/cli/deveco-ui/home-body"
import { ProductAgreementGate } from "@/cli/deveco-ui/agreement-panel"

/**
 * Gate wiring under test (home-body ↔ onboarding):
 *
 * `DevEcoOnboarding.onComplete` re-runs `runDevecoCheck()`, which can decide a
 * different destination step while `devecoReady` stays `false`. Those decisions
 * only reach the child if the `<Show>` remounts it, so this suite pins the
 * user-visible outcome of a re-run gate instead of the mechanism.
 */

const env = {
  studioConfigured: false,
  realName: true,
  session: true,
}

mock.module("@/plugin/deveco", () => ({
  devecoAuth: {
    getSession: async () => (env.session ? { userId: "user-1", accessToken: "token" } : null),
    isJwtExpired: async () => false,
    checkRealName: async () => env.realName,
    getUserId: async () => "user-1",
    login: async () => ({
      success: true,
      userInfo: { accessToken: "token", refreshToken: "refresh", isRealName: true },
    }),
    cancel: () => {},
  },
  hasDevecoOAuthEntry: () => true,
  ensureValidToken: async () => "token",
  loadIsRealNameFromDisk: () => env.realName,
  saveAuthToDisk: async () => {},
  ACCESS_TOKEN_EXPIRES_MS: 60_000,
  UnsupportedRegionError: class UnsupportedRegionError extends Error {},
  CHINA_ACCOUNT_ONLY_MESSAGE: "Only accounts registered in mainland China are supported.",
}))

mock.module("@/tool/lib/env", () => ({
  hasConfiguredDevEcoHome: async () => env.studioConfigured,
  resolveDevEcoHome: async (value: string) => value,
  saveDevEcoHome: async () => undefined,
  findDevEcoHomes: async () => [],
}))

// Re-login from the onboarding reaches the model catalog and the upload sync.
mock.module("@/plugin/deveco-models", () => ({
  getDevecoProviderConfig: async () => ({}),
  clearDevecoModelCache: () => {},
}))

mock.module("@/cli/deveco-agreement-sync", () => ({
  trySyncAgreement: async () => {},
  resetAgreementCheck: () => {},
}))

mock.module("@/plugin/deveco/log", () => ({
  logInfo: () => {},
  logWarn: () => {},
  logError: () => {},
}))

// The ready state renders the prompt, which pulls in the whole editor stack.
// A marker component is enough to tell "onboarding" from "ready".
mock.module("@opencode-ai/tui/component/prompt", () => ({
  Prompt: () => <text>PROMPT_READY</text>,
}))

mock.module("@opencode-ai/tui/context/local", () => ({
  useLocal: () => ({ model: { ready: true, set: () => {} } }),
}))

mock.module("@opencode-ai/tui/plugin/runtime", () => ({
  PluginRuntimeProvider: (props: { children: unknown }) => props.children,
  usePluginRuntime: () => ({ Slot: (props: { children?: unknown }) => props.children ?? null }),
}))

type UploadState = "not_signed" | "local" | "pending" | "review_required" | "uploaded"

type MountOptions = {
  home?: boolean
  uploadState: UploadState
  revision?: string
  thirdParty?: boolean
  accepted?: boolean
  env?: Partial<typeof env>
}

// Server-side agreement state. `accepted` flips on POST, mirroring the local
// acceptance the panel performs through the real endpoint.
//
// Reads expose the result of startup/login checks; navigation never discovers
// another online revision or retries an upload.
function createAgreementFetcher(options: MountOptions) {
  const server = {
    accepted: options.accepted ?? false,
    uploadState: options.uploadState,
    revision: options.revision,
    retries: 0,
    read: undefined as Promise<void> | undefined,
    onRead: () => {},
  }
  const details = () => ({
    version: "1",
    termsUrl: "https://example.com/terms",
    privacyUrl: "https://example.com/privacy",
    acceptedAt: server.accepted ? 1 : undefined,
    accepted: server.accepted,
    upload: {
      state: server.accepted ? server.uploadState : ("not_signed" as UploadState),
      revision: server.revision,
    },
  })
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = agreementRequest(input, init)
    const path = new URL(request.url).pathname
    if (agreementRead(request)) {
      const data = details()
      server.onRead()
      await server.read
      return json(data)
    }
    if (path === "/global/product-agreement") {
      server.accepted = true
      return json(details())
    }
    if (path === "/global/product-agreement/retry") {
      server.retries++
      return json(details())
    }
    return json({})
  }) as typeof fetch
  return { fetcher, server }
}

function createSyncData(options: MountOptions, tmpPath: string) {
  return {
    status: "complete",
    ready: true,
    path: { directory: tmpPath },
    bootstrap: async () => {},
    provider: { refresh: async () => {} },
    data: {
      local_auth_error: undefined,
      mcp: {},
      provider: options.thirdParty
        ? [{ id: "openai", models: { "gpt-5": { cost: { input: 1 } } } }]
        : [{ id: "deveco", models: {} }],
      config: {},
      provider_auth: {},
      provider_default: {},
      provider_next: { all: [], connected: [], default: {} },
    },
  } as unknown as ReturnType<typeof useSync>
}

function makeHarness(
  tmpPath: string,
  fetcher: typeof fetch,
  sync: ReturnType<typeof useSync>,
  home: () => boolean,
  openHome: () => void,
  session: { mounted: number; disposed: number },
) {
  return function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts cwd={tmpPath} paths={{ home: tmpPath, state: tmpPath, worktree: tmpPath }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <I18nProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <DialogProvider>
                      <SDKProvider url="http://127.0.0.1:9" fetch={fetcher}>
                        <ProjectProvider>
                          <SyncContext.Provider value={sync}>
                            <RouteProvider initialRoute={{ type: "home" }}>
                              <ArgsProvider>
                                <PromptRefProvider>
                                  <ExitProvider exit={() => {}}>
                                    <ProductAgreementGate home={home()} onConsentRequired={openHome}>
                                      <Show when={home()} fallback={<Session lifetime={session} />}>
                                        <DevEcoHomeBody sync={sync} bodySlotHeight={18} />
                                      </Show>
                                    </ProductAgreementGate>
                                  </ExitProvider>
                                </PromptRefProvider>
                              </ArgsProvider>
                            </RouteProvider>
                          </SyncContext.Provider>
                        </ProjectProvider>
                      </SDKProvider>
                    </DialogProvider>
                  </ToastProvider>
                </ThemeProvider>
              </I18nProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
}

async function waitForFrame(setup: Awaited<ReturnType<typeof testRender>>, text: string) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    if (frame.includes(text)) return frame
    await Bun.sleep(10)
  }
  throw new Error(setup.captureCharFrame())
}

function makePanelHelpers(
  setup: Awaited<ReturnType<typeof testRender>>,
  server: ReturnType<typeof createAgreementFetcher>["server"],
  tmp: Awaited<ReturnType<typeof tmpdir>>,
) {
  return {
    setup,
    server,
    retries: () => server.retries,
    frame: (text: string) => waitForFrame(setup, text),
    async settle() {
      await Bun.sleep(30)
      await setup.renderOnce()
      return setup.captureCharFrame()
    },
    async [Symbol.asyncDispose]() {
      setup.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

async function mount(options: MountOptions) {
  // Reset every field, not just the one a case happens to touch: the harness shares
  // one module-level `env` across cases, so a leftover `realName = false` would fail
  // the next case for the wrong reason. Same for the sticky DEVECO_HOME flag.
  Object.assign(env, { studioConfigured: false, realName: true, session: true }, options.env)
  resetDevecoHomeCheck()
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify({ language: "en" }))
  const { fetcher, server } = createAgreementFetcher(options)
  const initial = createSyncData(options, tmp.path)
  const [data] = createStore(initial.data)
  const sync = { ...initial, data }
  const [home, setHome] = createSignal(options.home ?? true)
  const session = { mounted: 0, disposed: 0 }
  const Harness = makeHarness(tmp.path, fetcher, sync, home, () => setHome(true), session)
  const setup = await testRender(() => <Harness />, { width: 100, height: 40, kittyKeyboard: true })
  return {
    ...makePanelHelpers(setup, server, tmp),
    session,
    openSession: () => setHome(false),
    refreshProviders: () => bumpProviderRevision(sync.data),
  }
}

test("logged-in mixed-provider users review online agreements before entry", async () => {
  await using panel = await mount({ accepted: true, thirdParty: true, uploadState: "review_required", revision: "2" })
  expect(await panel.frame("Agreements updated")).not.toContain("PROMPT_READY")
})

test("restoring a session reviews online agreements before exposing it", async () => {
  await using panel = await mount({
    home: false,
    accepted: true,
    uploadState: "review_required",
    revision: "2",
    env: { studioConfigured: true },
  })
  expect(await panel.frame("Agreements updated")).not.toContain("SESSION_READY")
})

test("accepting an online update on restored startup clears the old gate decision", async () => {
  await using panel = await mount({
    home: false,
    accepted: true,
    uploadState: "review_required",
    revision: "2",
    env: { studioConfigured: true },
  })
  await panel.frame("I have read and agree")
  panel.server.uploadState = "uploaded"
  await panel.setup.mockInput.typeText(" ")
  await panel.frame("[✓]")
  panel.setup.mockInput.pressEnter()
  await panel.frame("PROMPT_READY")
  panel.openSession()
  expect(await panel.frame("SESSION_READY")).not.toContain("PROMPT_READY")
})

test("login during a session re-reads backend consent even when the provider list is unchanged", async () => {
  await using panel = await mount({
    home: false,
    accepted: true,
    thirdParty: true,
    uploadState: "local",
    env: { studioConfigured: true },
  })
  await panel.frame("SESSION_READY")
  panel.server.uploadState = "review_required"
  panel.server.revision = "2"
  panel.refreshProviders()
  expect(await panel.frame("Agreements updated")).not.toContain("SESSION_READY")
})

test("login on the home screen re-reads backend consent even when the provider list is unchanged", async () => {
  await using panel = await mount({
    accepted: true,
    thirdParty: true,
    uploadState: "local",
    env: { studioConfigured: true },
  })
  await panel.frame("PROMPT_READY")
  panel.server.uploadState = "review_required"
  panel.server.revision = "2"
  panel.refreshProviders()
  expect(await panel.frame("Agreements updated")).not.toContain("PROMPT_READY")
})

test("accepting the product agreement advances to the DevEco Studio step instead of looping on the panel", async () => {
  await using panel = await mount({ uploadState: "local" })

  // First gate run: the agreement is not accepted yet, so the panel offers consent.
  const first = await panel.frame("Agreements and privacy")
  expect(first).toContain("I have read and agree")
  expect(first).toContain("↑↓: select · Space: check · Enter: confirm")

  await panel.setup.mockInput.typeText(" ")
  await panel.frame("[✓]")
  panel.setup.mockInput.pressEnter()

  // Second gate run decides the DevEco Studio step; the decision must reach the
  // already-mounted onboarding component rather than re-rendering the panel.
  const next = await panel.frame("Configure DevEco Studio Path")
  expect(next).toContain("Skip (DevEco Studio Tools will be unavailable)")
  expect(next).not.toContain("Agreements and privacy")
})

test("accepting a revision the server has not cleared keeps the consent screen up", async () => {
  await using panel = await mount({
    uploadState: "review_required",
    revision: "2",
    env: { studioConfigured: true },
  })

  const first = await panel.frame("Agreements and privacy")
  expect(first).toContain("I have read and agree")

  await panel.setup.mockInput.typeText(" ")
  await panel.frame("[✓]")
  panel.setup.mockInput.pressEnter()

  // Accepting revision 2 does not clear the requirement — the server still asks for
  // a review. The panel re-reads after the POST and puts the consent screen back up
  // rather than forwarding a completion the gate would immediately have to undo. That
  // read starts unchecked, so "[ ]" can only appear after it happened.
  const next = await panel.frame("[ ]")
  expect(next).toContain("I have read and agree")
  expect(next).toContain("↑↓: select · Space: check · Enter: confirm")
  expect(next).not.toContain("Continue")
})

test("a newer login check resets consent while the panel is on screen", async () => {
  await using panel = await mount({
    uploadState: "review_required",
    revision: "2",
    accepted: true,
    env: { studioConfigured: true },
  })

  const first = await panel.frame("I have read and agree")
  expect(first).toContain("↑↓: select · Space: check · Enter: confirm")
  // The gate's verdict reaches the panel: it renders as a re-review, not a first signing.
  expect(first).toContain("Agreements updated")

  await panel.setup.mockInput.typeText(" ")
  await panel.frame("[✓]")
  panel.server.revision = "3"
  panel.refreshProviders()

  // A remounted panel starts unchecked, so "[ ]" can only come from a fresh instance.
  const next = await panel.frame("[ ]")
  expect(next).toContain("I have read and agree")
  expect(next).not.toContain("Continue")
})

test("a re-run gate that blocks on real-name verification shows the real-name step", async () => {
  await using panel = await mount({ uploadState: "local", env: { realName: false } })

  const first = await panel.frame("Agreements and privacy")
  expect(first).toContain("I have read and agree")

  await panel.setup.mockInput.typeText(" ")
  await panel.frame("[✓]")
  panel.setup.mockInput.pressEnter()

  // `initialRealName` is only read when the onboarding mounts, so the gate's
  // real-name decision has to arrive with a fresh instance.
  const next = await panel.frame("Real-name authentication required")
  expect(next).not.toContain("Agreements and privacy")
})

test("third-party provider users still reach the ready state without an onboarding detour", async () => {
  await using panel = await mount({ uploadState: "local", thirdParty: true, env: { studioConfigured: true } })

  const first = await panel.frame("Agreements and privacy")
  expect(first).toContain("I have read and agree")

  await panel.setup.mockInput.typeText(" ")
  await panel.frame("[✓]")
  panel.setup.mockInput.pressEnter()

  // Ready state replaces the onboarding slot with the prompt.
  const after = await panel.frame("PROMPT_READY")
  expect(after).not.toContain("Agreements and privacy")
  expect(after).not.toContain("Configure DevEco Studio Path")
})

test("third-party provider users configure DevEco Studio before entering", async () => {
  await using panel = await mount({ uploadState: "local", thirdParty: true })

  const first = await panel.frame("Agreements and privacy")
  expect(first).toContain("I have read and agree")

  await panel.setup.mockInput.typeText(" ")
  await panel.frame("[✓]")
  panel.setup.mockInput.pressEnter()

  const studio = await panel.frame("Configure DevEco Studio Path")
  expect(studio).toContain("Skip (DevEco Studio Tools will be unavailable)")
  expect(studio).not.toContain("Get started with DevEco Code")

  panel.setup.mockInput.pressArrow("down")
  panel.setup.mockInput.pressEnter()

  const after = await panel.frame("PROMPT_READY")
  expect(after).not.toContain("Configure DevEco Studio Path")
  expect(after).not.toContain("Real-name authentication required")
  expect(after).not.toContain("Agreements and privacy")
})

test("an all-clear first gate run for a deveco-only user lands on ready instead of hanging on the setup check", async () => {
  await using panel = await mount({
    uploadState: "uploaded",
    accepted: true,
    env: { studioConfigured: true },
  })

  const frame = await panel.frame("PROMPT_READY")
  expect(frame).not.toContain("Checking setup")
  expect(frame).not.toContain("Agreements and privacy")
  expect(frame).not.toContain("Configure DevEco Studio Path")
  expect(panel.retries()).toBe(0)
})

test("a later gate decision is not shadowed by the real-name flag of an earlier one", async () => {
  // Run 1 blocks on real-name, and `initialRealName` is a one-shot hint the
  // onboarding only reads while mounting. Once the user completes real-name in
  // the browser and the gate re-runs, the spent flag must not drag the UI back
  // to the real-name page — that would be the same deadlock in a new costume.
  await using panel = await mount({
    uploadState: "local",
    accepted: true,
    env: { realName: false, studioConfigured: true },
  })

  await panel.frame("Real-name authentication required")

  // The user verifies real-name and then re-checks it: that re-logs in and
  // hands control back to the gate. The session is gone by then, so the gate
  // has to route to the entry screen.
  env.realName = true
  env.session = false
  panel.setup.mockInput.pressArrow("down")
  panel.setup.mockInput.pressEnter()

  const next = await panel.frame("Get started with DevEco Code")
  expect(next).not.toContain("Real-name authentication required")
  expect(next).not.toContain("Agreements and privacy")
  expect(panel.retries()).toBe(0)
})

test("refreshing agreement status keeps the active session mounted", async () => {
  await using panel = await mount({ home: false, accepted: true, uploadState: "uploaded" })
  await panel.frame("SESSION_READY")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  panel.server.read = release.promise
  panel.server.onRead = entered.resolve
  try {
    panel.refreshProviders()
    await entered.promise
    expect(await panel.frame("SESSION_READY")).not.toContain("Checking setup")
    expect(panel.session).toEqual({ mounted: 1, disposed: 0 })
  } finally {
    release.resolve()
    await panel.settle()
  }
  expect(panel.session).toEqual({ mounted: 1, disposed: 0 })
})

test("an old home check cannot overwrite a newer login decision", async () => {
  await using panel = await mount({
    accepted: true,
    thirdParty: true,
    uploadState: "local",
    env: { studioConfigured: true },
  })
  await panel.frame("PROMPT_READY")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  panel.server.read = release.promise
  panel.server.onRead = entered.resolve
  panel.refreshProviders()
  await entered.promise
  panel.server.read = undefined
  panel.server.uploadState = "review_required"
  panel.server.revision = "2"
  try {
    panel.refreshProviders()
    await panel.frame("Agreements updated")
  } finally {
    release.resolve()
  }
  expect(await panel.settle()).not.toContain("PROMPT_READY")
  await panel.frame("Agreements updated")
})

function agreementRequest(input: RequestInfo | URL, init?: RequestInit) {
  return input instanceof Request ? input : new Request(input, init)
}

function agreementRead(request: Request) {
  return new URL(request.url).pathname === "/global/product-agreement" && request.method === "GET"
}

function Session(props: { lifetime: { mounted: number; disposed: number } }) {
  props.lifetime.mounted++
  onCleanup(() => props.lifetime.disposed++)
  return <text>SESSION_READY</text>
}
