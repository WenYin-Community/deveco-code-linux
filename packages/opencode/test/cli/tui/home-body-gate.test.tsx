/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, mock, test } from "bun:test"
import { onCleanup } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { json } from "../../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../../../../tui/test/fixture/tui-runtime"
import { ThemeProvider } from "@opencode-ai/tui/context/theme"
import { TuiConfigProvider } from "@opencode-ai/tui/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "@opencode-ai/tui/keymap"
import { SDKProvider } from "@opencode-ai/tui/context/sdk"
import { SyncContext, useSync } from "@opencode-ai/tui/context/sync"
import { KVProvider } from "@opencode-ai/tui/context/kv"
import { I18nProvider } from "@opencode-ai/tui/i18n"
import { ExitProvider } from "@opencode-ai/tui/context/exit"
import { ArgsProvider } from "@opencode-ai/tui/context/args"
import { PromptRefProvider } from "@opencode-ai/tui/context/prompt"
import { RouteProvider } from "@opencode-ai/tui/context/route"
import { DialogProvider } from "@opencode-ai/tui/ui/dialog"
import { ToastProvider } from "@opencode-ai/tui/ui/toast"
import { DevEcoHomeBody } from "@/cli/deveco-ui/home-body"

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

type MountOptions = { uploadState: UploadState; revision?: string; thirdParty?: boolean; accepted?: boolean }

// Server-side agreement state. `accepted` flips on POST, mirroring the local
// acceptance the panel performs through the real endpoint.
function createAgreementFetcher(options: MountOptions) {
  const server = { accepted: options.accepted ?? false, retries: 0 }
  const details = () => ({
    version: "1",
    termsUrl: "https://example.com/terms",
    privacyUrl: "https://example.com/privacy",
    acceptedAt: server.accepted ? 1 : undefined,
    accepted: server.accepted,
    upload: {
      state: server.accepted ? options.uploadState : ("not_signed" as UploadState),
      revision: options.revision,
    },
  })
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const path = new URL(request.url).pathname
    if (path === "/global/product-agreement" && request.method === "GET") return json(details())
    if (path === "/global/product-agreement" && request.method === "POST") {
      server.accepted = true
      return json(details())
    }
    if (path === "/global/product-agreement/retry") {
      server.retries++
      return json({ accepted: server.accepted, upload: { state: options.uploadState, revision: options.revision } })
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

function makeHarness(tmpPath: string, fetcher: typeof fetch, sync: ReturnType<typeof useSync>) {
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
                        <SyncContext.Provider value={sync}>
                          <RouteProvider initialRoute={{ type: "home" }}>
                            <ArgsProvider>
                              <PromptRefProvider>
                                <ExitProvider exit={() => {}}>
                                  <DevEcoHomeBody sync={sync} bodySlotHeight={18} />
                                </ExitProvider>
                              </PromptRefProvider>
                            </ArgsProvider>
                          </RouteProvider>
                        </SyncContext.Provider>
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
  server: { retries: number },
  tmp: Awaited<ReturnType<typeof tmpdir>>,
) {
  return {
    setup,
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
  env.session = true
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify({ language: "en" }))
  const { fetcher, server } = createAgreementFetcher(options)
  const sync = createSyncData(options, tmp.path)
  const Harness = makeHarness(tmp.path, fetcher, sync)
  const setup = await testRender(() => <Harness />, { width: 100, height: 40, kittyKeyboard: true })
  return makePanelHelpers(setup, server, tmp)
}

test("accepting the product agreement advances to the DevEco Studio step instead of looping on the panel", async () => {
  env.studioConfigured = false
  await using panel = await mount({ uploadState: "local" })

  // First gate run: the agreement is not accepted yet, so the panel offers consent.
  const first = await panel.frame("Agreements and privacy")
  expect(first).toContain("I have read and agree")
  expect(first).toContain("Space: check · Enter: agree and continue")

  await panel.setup.mockInput.typeText(" ")
  await panel.frame("[✓]")
  panel.setup.mockInput.pressEnter()

  // Second gate run decides the DevEco Studio step; the decision must reach the
  // already-mounted onboarding component rather than re-rendering the panel.
  const next = await panel.frame("Configure DevEco Studio Path")
  expect(next).toContain("Skip (DevEco Studio Tools will be unavailable)")
  expect(next).not.toContain("Agreements and privacy")
})

test("a re-run gate that needs a new revision keeps consent reachable", async () => {
  env.studioConfigured = true
  await using panel = await mount({ uploadState: "review_required", revision: "2" })

  const first = await panel.frame("Agreements and privacy")
  expect(first).toContain("I have read and agree")

  await panel.setup.mockInput.typeText(" ")
  await panel.frame("[✓]")
  panel.setup.mockInput.pressEnter()

  // The re-run gate lands on the privacy step with a pending service revision.
  // A fresh panel starts unchecked, so "[ ]" can only appear after the remount —
  // waiting on the checkbox copy would match the panel that is still on screen.
  const next = await panel.frame("[ ]")
  expect(next).toContain("I have read and agree")
  expect(next).toContain("Space: check · Enter: agree and continue")
  expect(next).not.toContain("Continue")
  expect(panel.retries()).toBeGreaterThan(0)
})

test("a re-run gate that blocks on real-name verification shows the real-name step", async () => {
  env.studioConfigured = false
  env.realName = false
  await using panel = await mount({ uploadState: "local" })

  const first = await panel.frame("Agreements and privacy")
  expect(first).toContain("I have read and agree")

  await panel.setup.mockInput.typeText(" ")
  await panel.frame("[✓]")
  panel.setup.mockInput.pressEnter()

  // `initialRealName` is only read when the onboarding mounts, so the gate's
  // real-name decision has to arrive with a fresh instance.
  const next = await panel.frame("Real-name authentication required")
  expect(next).not.toContain("Agreements and privacy")
  env.realName = true
})

test("third-party provider users still reach the ready state without an onboarding detour", async () => {
  env.studioConfigured = false
  await using panel = await mount({ uploadState: "local", thirdParty: true })

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

test("a later gate decision is not shadowed by the real-name flag of an earlier one", async () => {
  // Run 1 blocks on real-name, and `initialRealName` is a one-shot hint the
  // onboarding only reads while mounting. Once the user completes real-name in
  // the browser and the gate re-runs, the spent flag must not drag the UI back
  // to the real-name page — that would be the same deadlock in a new costume.
  env.realName = false
  env.studioConfigured = true
  await using panel = await mount({ uploadState: "local", accepted: true })

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
  // The entry screen is only reachable after the re-login flow ran the
  // agreement check, so a login that failed early cannot pass this test.
  expect(panel.retries()).toBeGreaterThan(0)
})
