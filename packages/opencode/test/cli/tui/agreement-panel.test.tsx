/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, onCleanup, Show } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../../../tui/test/fixture/tui-runtime"
import { ThemeProvider } from "@opencode-ai/tui/context/theme"
import { TuiConfigProvider } from "@opencode-ai/tui/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "@opencode-ai/tui/keymap"
import { SDKProvider } from "@opencode-ai/tui/context/sdk"
import { SyncContext, useSync } from "@opencode-ai/tui/context/sync"
import { KVProvider } from "@opencode-ai/tui/context/kv"
import { I18nProvider, changeLanguage } from "@opencode-ai/tui/i18n"
import { AgreementPanel, AgreementReviewDialog, ProductAgreementGate } from "@/cli/deveco-ui/agreement-panel"
import { DialogProvider } from "@opencode-ai/tui/ui/dialog"
import { ToastProvider } from "@opencode-ai/tui/ui/toast"

async function mount(
  height = 30,
  unavailable = false,
  language = "en",
  mode: "panel" | "review" | "home-gate" | "session-gate" = "panel",
) {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify({ language }))
  let accepted = mode === "review"
  let reviewed = false
  let posts = 0
  let gets = 0
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (unavailable) return new Response("Unsupported", { status: 404 })
    const request = input instanceof Request ? input : new Request(input, init)
    if (request.url.endsWith("/product-agreement") && request.method === "GET") gets++
    if (request.url.endsWith("/product-agreement") && request.method === "POST") {
      const body = await request.json()
      expect(body.accepted).toBe(true)
      accepted = true
      reviewed = true
      posts++
    }
    return Response.json({
      version: "1",
      termsUrl: "https://example.com/terms",
      privacyUrl: "https://example.com/privacy",
      accepted,
      upload: {
        state: mode === "review" && !reviewed ? "review_required" : accepted ? "local" : "not_signed",
        revision: mode === "review" ? "2" : undefined,
      },
    })
  }) as typeof fetch
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const [complete, setComplete] = createSignal(false)
    const [redirected, setRedirected] = createSignal(false)
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts cwd={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <I18nProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <DialogProvider>
                      <SDKProvider
                        url="http://127.0.0.1:9"
                        fetch={fetcher}
                        events={{ subscribe: async () => () => {} }}
                      >
                        <SyncContext.Provider value={{ data: {} } as ReturnType<typeof useSync>}>
                          {mode === "review" ? (
                            <AgreementReviewDialog onComplete={() => {}} />
                          ) : mode === "home-gate" ? (
                            <ProductAgreementGate home={true} onConsentRequired={() => {}}>
                              <text>Home onboarding content</text>
                            </ProductAgreementGate>
                          ) : mode === "session-gate" ? (
                            <Show
                              when={redirected()}
                              fallback={
                                <ProductAgreementGate home={false} onConsentRequired={() => setRedirected(true)}>
                                  <text>Resumed session content</text>
                                </ProductAgreementGate>
                              }
                            >
                              <text>Home onboarding content</text>
                            </Show>
                          ) : (
                            <Show when={complete()} fallback={<AgreementPanel onComplete={() => setComplete(true)} />}>
                              <text>Resumed session content</text>
                            </Show>
                          )}
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
  const setup = await testRender(() => <Harness />, { width: 100, height, kittyKeyboard: true })
  return {
    setup,
    posts: () => posts,
    gets: () => gets,
    async frame(text: string) {
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        await setup.renderOnce()
        const frame = setup.captureCharFrame()
        if (frame.includes(text)) return frame
        await Bun.sleep(10)
      }
      throw new Error(setup.captureCharFrame())
    },
    async [Symbol.asyncDispose]() {
      setup.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

test("resuming a session stays behind consent until the user checks and accepts", async () => {
  await using panel = await mount()
  const first = await panel.frame("I have read and agree")
  expect(first).not.toContain("Resumed session content")
  panel.setup.mockInput.pressEnter()
  await panel.frame("I have read and agree")
  expect(panel.posts()).toBe(0)
  panel.setup.mockInput.typeText(" ")
  await panel.frame("[✓]")
  panel.setup.mockInput.pressEnter()
  expect(await panel.frame("Resumed session content")).not.toContain("I have read and agree")
  expect(panel.posts()).toBe(1)
})

test("agreement confirmation stays visible in a short terminal", async () => {
  await using panel = await mount(16)
  const frame = await panel.frame("Enter: agree and continue")
  expect(frame).toContain("I have read and agree")
  expect(frame).not.toContain("Resumed session content")
})

test("unsupported servers keep a retry screen instead of exposing the session", async () => {
  await using panel = await mount(30, true)
  const frame = await panel.frame("Unable to load agreements")
  expect(frame).not.toContain("Resumed session content")
  panel.setup.mockInput.pressEnter()
  expect(await panel.frame("Unable to load agreements")).not.toContain("Resumed session content")
})

test("Chinese consent remains explicit and updates when the language changes", async () => {
  await using panel = await mount(16, false, "zh")
  const frame = await panel.frame("同意并继续")
  expect(frame).toContain("我已阅读并同意使用条款和隐私声明")
  expect(frame).not.toContain("Resumed session content")
  panel.setup.mockInput.pressEnter()
  await panel.frame("同意并继续")
  expect(panel.posts()).toBe(0)
  await changeLanguage("en")
  await panel.frame("Space: check")
  await changeLanguage("zh")
  await panel.frame("同意并继续")
  panel.setup.mockInput.typeText(" ")
  await panel.frame("[✓]")
  panel.setup.mockInput.pressEnter()
  await panel.frame("Resumed session content")
  expect(panel.posts()).toBe(1)
  await changeLanguage("en")
})

test("updated agreements explain why the model request stopped and can be accepted", async () => {
  await using panel = await mount(20, false, "zh", "review")
  const first = await panel.frame("请阅读并接受")
  expect(first).toContain("重新发送刚才的请求")
  panel.setup.mockInput.pressArrow("down")
  await panel.setup.renderOnce()
  panel.setup.mockInput.pressArrow("down")
  await panel.setup.renderOnce()
  panel.setup.mockInput.pressArrow("down")
  await panel.setup.renderOnce()
  panel.setup.mockInput.pressEnter()
  await panel.frame("[✓]")
  expect(panel.posts()).toBe(1)
})

test("home startup renders onboarding without mounting the global agreement panel", async () => {
  await using panel = await mount(30, false, "en", "home-gate")
  expect(await panel.frame("Home onboarding content")).not.toContain("Agreements and privacy")
  expect(panel.gets()).toBe(0)
})

test("an unsigned restored session is routed back to home onboarding", async () => {
  await using panel = await mount(30, false, "en", "session-gate")
  const frame = await panel.frame("Home onboarding content")
  expect(frame).not.toContain("Resumed session content")
  expect(frame).not.toContain("Agreements and privacy")
  expect(panel.gets()).toBe(1)
})
