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
import { ProjectProvider } from "@opencode-ai/tui/context/project"
import { SyncContext, useSync } from "@opencode-ai/tui/context/sync"
import { KVProvider } from "@opencode-ai/tui/context/kv"
import { I18nProvider } from "@opencode-ai/tui/i18n"
import { ExitProvider } from "@opencode-ai/tui/context/exit"
import { ArgsProvider } from "@opencode-ai/tui/context/args"
import { PromptRefProvider } from "@opencode-ai/tui/context/prompt"
import { RouteProvider } from "@opencode-ai/tui/context/route"
import { DialogProvider } from "@opencode-ai/tui/ui/dialog"
import { ToastProvider } from "@opencode-ai/tui/ui/toast"
import { DevEcoHomeBody, resetDevecoHomeCheck } from "@/cli/deveco-ui/home-body"

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

type MountOptions = {
  uploadState: UploadState
  revision?: string
  thirdParty?: boolean
  accepted?: boolean
  env?: Partial<typeof env>
}

// Server-side agreement state. `accepted` flips on POST, mirroring the local
// acceptance the panel performs through the real endpoint.
//
// `uploadState`/`revision` model what a plain read reports. `retryState`/
// `retryRevision` model what the gate's upload retry discovers — the retry is the
// call that pushes a newly required revision into the local report, so it is
// allowed to disagree with the last read and it updates it.
function createAgreementFetcher(options: MountOptions) {
  const server = {
    accepted: options.accepted ?? false,
    uploadState: options.uploadState,
    revision: options.revision,
    retryState: options.uploadState,
    retryRevision: options.revision,
    retries: 0,
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
    const request = input instanceof Request ? input : new Request(input, init)
    const path = new URL(request.url).pathname
    if (path === "/global/product-agreement" && request.method === "GET") return json(details())
    if (path === "/global/product-agreement" && request.method === "POST") {
      server.accepted = true
      return json(details())
    }
    if (path === "/global/product-agreement/retry") {
      server.retries++
      server.uploadState = server.retryState
      server.revision = server.retryRevision
      return json({ accepted: server.accepted, upload: { state: server.retryState, revision: server.retryRevision } })
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
                        <ProjectProvider>
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
  const sync = createSyncData(options, tmp.path)
  const Harness = makeHarness(tmp.path, fetcher, sync)
  const setup = await testRender(() => <Harness />, { width: 100, height: 40, kittyKeyboard: true })
  return makePanelHelpers(setup, server, tmp)
}

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

test("a revision published while the panel is on screen still reaches it", async () => {
  // The panel is mounted and offering Continue, because its snapshot was taken when
  // revision 2 was accepted. The gate's own upload retry then discovers revision 3 and
  // re-decides `privacy` — the same step as before. Without the gate's consent revision
  // in the remount key the key is unchanged, nothing remounts, and the Continue click
  // leaves the panel showing exactly what it showed before.
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

  // Revision 2 is accepted locally, so a plain read no longer asks for consent. The
  // next upload retry is what discovers revision 3.
  panel.server.uploadState = "pending"
  panel.server.retryState = "review_required"
  panel.server.retryRevision = "3"

  await panel.setup.mockInput.typeText(" ")
  await panel.frame("[✓]")
  panel.setup.mockInput.pressEnter()

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
  // The entry screen is only reachable after the re-login flow ran the
  // agreement check, so a login that failed early cannot pass this test.
  expect(panel.retries()).toBeGreaterThan(0)
})
