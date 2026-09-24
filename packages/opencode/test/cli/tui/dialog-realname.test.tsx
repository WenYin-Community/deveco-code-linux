/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { afterEach, afterAll, beforeAll, expect, test } from "bun:test"
import { createSignal, onCleanup, onMount } from "solid-js"
import { Global } from "@opencode-ai/core/global"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../../../tui/test/fixture/tui-runtime"
import { ThemeProvider } from "@opencode-ai/tui/context/theme"
import { TuiConfigProvider } from "@opencode-ai/tui/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "@opencode-ai/tui/keymap"
import { SDKProvider } from "@opencode-ai/tui/context/sdk"
import { SyncContext, useSync } from "@opencode-ai/tui/context/sync"
import { KVProvider } from "@opencode-ai/tui/context/kv"
import { I18nProvider } from "@opencode-ai/tui/i18n"
import { DialogProvider, useDialog } from "@opencode-ai/tui/ui/dialog"
import { Toast, ToastProvider } from "@opencode-ai/tui/ui/toast"
import { DialogRealName } from "@/cli/deveco-ui/dialog-realname"

const savedData = Global.Path.data
const originalFetch = globalThis.fetch

beforeAll(() => {
  globalThis.fetch = (() => Promise.resolve(new Response("{}", { status: 404 }))) as unknown as typeof fetch
})

afterEach(() => {
  Global.Path.data = savedData
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

type FetcherOptions = {
  authorizeStatus?: number
  callbackStatus?: number
  callbackBody?: unknown
  disposeStatus?: number
  pendingCallback?: Promise<Response>
  bootstrap?: () => Promise<void>
  isRealName?: boolean
}

async function mount(options?: FetcherOptions) {
  const tmp = await tmpdir()
  Global.Path.data = tmp.path
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify({ language: "en" }))
  const sync = {
    data: {},
    bootstrap: options?.bootstrap ?? (async () => {}),
  } as unknown as ReturnType<typeof useSync>
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/auth" || url.pathname.endsWith("/auth")) {
      return Response.json([
        { providerID: "deveco", type: "oauth", removable: false, isRealName: options?.isRealName ?? true },
      ])
    }
    if (url.pathname.endsWith("/oauth/authorize")) {
      return Response.json({ method: "auto", instructions: "Opening browser for login...", url: "" })
    }
    if (url.pathname.endsWith("/oauth/callback")) {
      if (options?.pendingCallback) return options.pendingCallback
      const status = options?.callbackStatus ?? 200
      if (status >= 400)
        return Response.json(
          options?.callbackBody ?? { _tag: "ProviderAuthError", name: "ProviderAuthOauthCallbackFailed", data: {} },
          { status },
        )
      return Response.json(true)
    }
    if (url.pathname.endsWith("/oauth/cancel")) {
      return Response.json(true)
    }
    if (url.pathname.endsWith("/instance/dispose"))
      return new Response(null, { status: options?.disposeStatus ?? 200 })
    return Response.json({})
  }) as typeof fetch
  const [completed, setCompleted] = createSignal(false)
  function Open() {
    const dialog = useDialog()
    onMount(() =>
      dialog.replace(() => (
        <DialogRealName
          onComplete={() => {
            setCompleted(true)
            dialog.clear()
          }}
        />
      )),
    )
    return null
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts cwd={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <I18nProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <SDKProvider url="http://127.0.0.1:9" fetch={fetcher} events={{ subscribe: async () => () => {} }}>
                      <SyncContext.Provider value={sync}>
                        <DialogProvider>
                          <Open />
                          <Toast />
                        </DialogProvider>
                      </SyncContext.Provider>
                    </SDKProvider>
                  </ToastProvider>
                </ThemeProvider>
              </I18nProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const setup = await testRender(() => <Harness />, { width: 100, height: 30, kittyKeyboard: true })
  return {
    setup,
    completed,
    async frame(text: string, timeout = 3000) {
      for (let i = 0; i < timeout / 10; i++) {
        await Bun.sleep(10)
        await setup.renderOnce()
        const frame = setup.captureCharFrame()
        if (frame.includes(text)) return frame
      }
      throw new Error(setup.captureCharFrame())
    },
    async waitFrameGone(text: string, timeout = 3000) {
      for (let i = 0; i < timeout / 10; i++) {
        await Bun.sleep(10)
        await setup.renderOnce()
        if (!setup.captureCharFrame().includes(text)) return true
      }
      return false
    },
    async waitCompleted(timeout = 5000) {
      for (let i = 0; i < timeout / 10; i++) {
        await Bun.sleep(10)
        await setup.renderOnce()
        if (completed()) return true
      }
      return false
    },
    async [Symbol.asyncDispose]() {
      setup.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

async function selectRecheck(panel: Awaited<ReturnType<typeof mount>>) {
  await panel.frame("Re-check real-name")
  panel.setup.mockInput.pressArrow("down")
  await panel.setup.renderOnce()
  panel.setup.mockInput.pressEnter()
}

test("renders title, link, and three options", async () => {
  await using panel = await mount()
  try {
    const frame = await panel.frame("Real-name authentication")
    expect(frame).toContain("Complete Real-name Authentication")
    expect(frame).toContain("1. Authenticate")
    expect(frame).toContain("2. Re-check real-name")
    expect(frame).toContain("3. Back")
    expect(frame).toContain("esc")
  } finally {
    await panel[Symbol.asyncDispose]()
  }
})

test("re-check with successful OAuth callback closes the dialog", async () => {
  await using panel = await mount()
  try {
    await selectRecheck(panel)
    expect(await panel.waitCompleted()).toBe(true)
  } finally {
    await panel[Symbol.asyncDispose]()
  }
})

test("re-check with still-unverified account keeps the dialog and warns", async () => {
  await using panel = await mount({ isRealName: false })
  try {
    await selectRecheck(panel)
    expect(await panel.frame("Real-name authentication not yet completed")).toBeTruthy()
    expect(panel.completed()).toBe(false)
    expect(await panel.frame("Re-check real-name")).toBeTruthy()
  } finally {
    await panel[Symbol.asyncDispose]()
  }
})

test("re-check with callback failure shows error and keeps the dialog", async () => {
  await using panel = await mount({ callbackStatus: 400 })
  try {
    await selectRecheck(panel)
    expect(await panel.frame("Login failed")).toBeTruthy()
    expect(panel.completed()).toBe(false)
    expect(await panel.frame("Re-check real-name")).toBeTruthy()
  } finally {
    await panel[Symbol.asyncDispose]()
  }
})

test("re-check with dispose failure still closes the dialog", async () => {
  await using panel = await mount({ disposeStatus: 500 })
  try {
    await selectRecheck(panel)
    expect(await panel.waitCompleted()).toBe(true)
  } finally {
    await panel[Symbol.asyncDispose]()
  }
})

test("re-check with bootstrap failure still closes the dialog", async () => {
  await using panel = await mount({
    bootstrap: async () => { throw new Error("sync failed") },
  })
  try {
    await selectRecheck(panel)
    expect(await panel.waitCompleted()).toBe(true)
  } finally {
    await panel[Symbol.asyncDispose]()
  }
})

test("back option closes the dialog without calling OAuth", async () => {
  await using panel = await mount()
  try {
    await panel.frame("3. Back")
    panel.setup.mockInput.pressArrow("down")
    await panel.setup.renderOnce()
    panel.setup.mockInput.pressArrow("down")
    await panel.setup.renderOnce()
    panel.setup.mockInput.pressEnter()
    expect(await panel.waitFrameGone("3. Back")).toBe(true)
    expect(panel.completed()).toBe(true)
  } finally {
    await panel[Symbol.asyncDispose]()
  }
})

test("escape during pending callback does not call onComplete", async () => {
  let resolveCallback!: (r: Response) => void
  const pending = new Promise<Response>(r => { resolveCallback = r })
  await using panel = await mount({ pendingCallback: pending })
  try {
    await selectRecheck(panel)
    expect(await panel.frame("Waiting for browser")).toBeTruthy()
    panel.setup.mockInput.pressKey("ESCAPE")
    await panel.setup.renderOnce()
    await Bun.sleep(50)
    expect(panel.completed()).toBe(false)
    resolveCallback(Response.json(true))
    await Bun.sleep(50)
    expect(panel.completed()).toBe(false)
  } finally {
    resolveCallback(Response.json(true))
    await panel[Symbol.asyncDispose]()
  }
})
