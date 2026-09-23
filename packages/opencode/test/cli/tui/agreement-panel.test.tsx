/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { createSignal, onCleanup, Show } from "solid-js"
import fs from "fs/promises"
import path from "path"
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
import { saveAuthToDisk } from "@/plugin/deveco"
import { tokenStorage } from "@/plugin/deveco/token-storage"
import { invalidateImprovementConsentCache, resolveImprovementConsent } from "@/plugin/deveco/improvement-consent"

/**
 * Reset the account-scoped state the panel reads. test/preload.ts redirects
 * XDG_* to one directory per bun worker, and the worker is reused across test
 * files, so token.enc / auth.json / improvement-consent.json are shared by
 * every test in this worker unless each test starts from a known state.
 * The module-level 30s consent cache must be invalidated too — otherwise a
 * decision written by an earlier test is still returned after the file is gone
 * (which would silently hide the improvement row and mask regressions).
 */
async function resetAccountState() {
  await tokenStorage.clearToken()
  await saveAuthToDisk("deveco", null)
  invalidateImprovementConsentCache()
  await fs.rm(path.join(process.env.XDG_STATE_HOME!, "deveco", "improvement-consent.json"), { force: true })
}

beforeEach(resetAccountState)
afterEach(resetAccountState)

async function mount(
  height = 30,
  unavailable = false,
  language = "en",
  mode: "panel" | "review" | "home-gate" | "session-gate" = "panel",
  // improvementAccount seeds real credentials (preload-redirected config dir)
  // so the panel's improvement row has an account to ask about (T3.1);
  // without it the row stays hidden (no account → "skip")
  improvementAccount = false,
  width = 100,
) {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify({ language }))
  if (improvementAccount) {
    // Synthetic JWT whose payload carries a userId (only the payload is decoded)
    const jwt = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(
      JSON.stringify({ userId: "agreement-panel-user" }),
    ).toString("base64url")}.sig`
    await tokenStorage.saveToken(jwt)
    await saveAuthToDisk("deveco", { type: "oauth", access: "access-token", refresh: "", expires: 0 })
  }
  let accepted = mode === "review"
  let reviewed = false
  let posts = 0
  let gets = 0
  let improvementChanges = 0
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
                            <Show when={complete()} fallback={
                              <AgreementPanel
                                onComplete={() => setComplete(true)}
                                onImprovementChange={() => {
                                  improvementChanges++
                                }}
                              />
                            }>
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
  const setup = await testRender(() => <Harness />, { width, height, kittyKeyboard: true })
  return {
    setup,
    posts: () => posts,
    gets: () => gets,
    improvementChanges: () => improvementChanges,
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

test("the opt-in row is a bounded column beside the prefix: continuation lines hang", async () => {
  // Guards the structural regression risk: if the row goes back to a single plain
  // <text> (or the column loses its constraint), wrapped continuation lines start at
  // column 0 and the row can reach past the panel's content box.
  //
  // NOT covered here (see source-code-changes §1.6): the `labelWrap` char/word choice
  // and `flexBasis={0}` are width- and copy-dependent — mutation testing showed no
  // assertion discriminates them at 80 columns (removing flexBasis renders identically),
  // so they stay visually verified (dump evidence in §1.5) rather than pinned by a test
  // that would only look like coverage.
  await using panel = await mount(30, false, "zh", "panel", true, 80)
  const frame = await panel.frame("加入体验改进计划")
  const lines = frame.split("\n")
  const row = lines.findIndex((line) => line.includes("加入体验改进计划"))
  // the continuation hangs under the label (6 columns), not at column 0
  expect(lines[row + 1].startsWith("      ")).toBe(true)
  expect(lines[row + 1].trim().length).toBeGreaterThan(0)
  // nothing may reach past the panel's content box (80 columns - 2 padding)
  for (const line of lines) expect(line.replace(/\s+$/, "").length).toBeLessThanOrEqual(78)
})

test("at 80 columns the English agreement label still fits on one rendered line", async () => {
  // The option rows sit in a full-width container on purpose: at 80 columns (the common
  // terminal default) the content box is 78 columns while the English label needs 77, so any
  // inset wraps it — an earlier width="90%" container did exactly that.
  await using panel = await mount(30, false, "en", "panel", true, 80)
  const lines = (await panel.frame("Join the improvement program")).split("\n")
  const agreement = lines.find((line) => line.includes("I have read and agree"))!
  expect(agreement).toContain("Privacy Notice")
})

test("the two option rows share one checkbox column even though the panel is centered", async () => {
  // Deliberately Chinese: centering only shifts a row that has slack, and at 80 columns the
  // English label fills the content box exactly — so an English probe renders identically
  // with or without the shared container and cannot see the misalignment it prevents. The
  // Chinese label leaves ~16 columns of slack, which is what this asserts on.
  await using panel = await mount(30, false, "zh", "panel", true, 80)
  const lines = (await panel.frame("加入体验改进计划")).split("\n")
  const agreement = lines.find((line) => line.includes("我已阅读并同意"))!
  const improvement = lines.find((line) => line.includes("加入体验改进计划"))!
  expect(agreement.indexOf("[")).toBeGreaterThan(-1)
  expect(improvement.indexOf("[")).toBe(agreement.indexOf("["))
})

test("markers say which box is required, and Enter without it warns in red", async () => {
  // improvementAccount seeds credentials so BOTH rows render (the opt-in row is
  // hidden without an account).
  await using panel = await mount(30, false, "en", "panel", true)
  // Wait for the opt-in row: its visibility comes from an async account read, so
  // waiting on the agreement row alone would race it.
  const frame = await panel.frame("(Optional) Join the improvement program")
  // (Required) on the agreement, (Optional) on the improvement opt-in
  expect(frame).toContain("(Required) I have read and agree")
  // Enter with the agreement unchecked must not advance and must say why
  panel.setup.mockInput.pressEnter()
  const warned = await panel.frame("Please accept the required agreement above")
  expect(warned).toContain("I have read and agree")
  expect(panel.posts()).toBe(0)
  // Checking the box clears the hint
  panel.setup.mockInput.typeText(" ")
  const cleared = await panel.frame("[✓] (Required) I have read and agree")
  expect(cleared).not.toContain("Please accept the required agreement above")
})

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
  const frame = await panel.frame("Enter: confirm")
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
  const frame = await panel.frame("Enter：确认")
  expect(frame).toContain("我已阅读并同意使用条款和隐私声明")
  expect(frame).not.toContain("Resumed session content")
  panel.setup.mockInput.pressEnter()
  await panel.frame("Enter：确认")
  expect(panel.posts()).toBe(0)
  await changeLanguage("en")
  await panel.frame("Space: check")
  await changeLanguage("zh")
  await panel.frame("Enter：确认")
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

test("improvement row stays hidden without an account", async () => {
  // A2 / D8: no account to attach a decision to → the row must not render,
  // and confirming the panel must not write any consent record
  await using panel = await mount()
  const frame = await panel.frame("I have read and agree")
  expect(frame).not.toContain("Join the improvement program")
  panel.setup.mockInput.typeText(" ")
  await panel.frame("[✓]")
  panel.setup.mockInput.pressEnter()
  await panel.frame("Resumed session content")
  const stateDir = path.join(process.env.XDG_STATE_HOME!, "deveco")
  expect(await Bun.file(path.join(stateDir, "improvement-consent.json")).exists()).toBe(false)
})

test("improvement row is unchecked by default, i-toggles, and confirms declined", async () => {
  await using panel = await mount(30, false, "en", "panel", true)
  const frame = await panel.frame("Join the improvement program")
  // UI-2: default unchecked; the honest-disclosure hint renders alongside
  expect(frame).toContain("[ ] (Optional) Join the improvement program")
  // 2026-09-23: the standalone hint line was removed (it sat under the agreement
  // checkbox and read as if it applied to the agreements); the changeability note
  // now hangs off the option itself.
  // The note is part of the option's flowing paragraph, so it can be split across
  // rendered lines; flatten whitespace before matching the phrase.
  expect(frame.replace(/\s+/g, " ")).toContain("Change anytime in privacy settings")
  expect(frame).not.toContain("works fully without")
  // i toggles (keyboard), i again toggles back — both rows coexist
  panel.setup.mockInput.typeText("i")
  expect(await panel.frame("[✓] (Optional) Join the improvement program")).toContain("[ ] (Required) I have read and agree")
  panel.setup.mockInput.typeText("i")
  expect(await panel.frame("[ ] (Optional) Join the improvement program")).toContain("[ ] (Required) I have read and agree")
  // Accept the agreement without checking improvement → declined persists (FR-4)
  panel.setup.mockInput.typeText(" ")
  await panel.frame("[✓] (Required) I have read and agree")
  panel.setup.mockInput.pressEnter()
  await panel.frame("Resumed session content")
  expect(await resolveImprovementConsent("agreement-panel-user")).toBe("declined")
  expect(panel.improvementChanges()).toBe(1)
  await tokenStorage.clearToken()
})

test("arrow keys move the highlight and space toggles the highlighted checkbox", async () => {
  // Regression: space used to be hard-wired to the agreement row, so the
  // improvement row could only be toggled with the mouse (or the undiscoverable
  // `i` key). Space must act on the highlighted row instead.
  await using panel = await mount(30, false, "en", "panel", true)
  await panel.frame("Join the improvement program")
  // ↓ highlights the improvement row; space checks *that* row (no mouse needed)
  panel.setup.mockInput.pressArrow("down")
  await panel.setup.renderOnce()
  panel.setup.mockInput.typeText(" ")
  await panel.frame("[✓] (Optional) Join the improvement program")
  // ↑ highlights the agreement row; space checks it
  panel.setup.mockInput.pressArrow("up")
  await panel.setup.renderOnce()
  panel.setup.mockInput.typeText(" ")
  await panel.frame("[✓] (Required) I have read and agree")
  // wrap-around: ↑ from the first row lands on the last row
  panel.setup.mockInput.pressArrow("up")
  await panel.setup.renderOnce()
  panel.setup.mockInput.typeText(" ")
  await panel.frame("[ ] (Optional) Join the improvement program")
  // re-check it so the confirmed decision is "granted"
  panel.setup.mockInput.typeText(" ")
  await panel.frame("[✓] (Optional) Join the improvement program")
  panel.setup.mockInput.pressEnter()
  await panel.frame("Resumed session content")
  expect(await resolveImprovementConsent("agreement-panel-user")).toBe("granted")
  await tokenStorage.clearToken()
})

test("checking the improvement row confirms granted alongside the agreement", async () => {
  await using panel = await mount(30, false, "en", "panel", true)
  await panel.frame("Join the improvement program")
  panel.setup.mockInput.typeText(" ")
  await panel.frame("[✓] (Required) I have read and agree")
  panel.setup.mockInput.typeText("i")
  await panel.frame("[✓] (Optional) Join the improvement program")
  panel.setup.mockInput.pressEnter()
  await panel.frame("Resumed session content")
  expect(await resolveImprovementConsent("agreement-panel-user")).toBe("granted")
  expect(panel.improvementChanges()).toBe(1)
  await tokenStorage.clearToken()
})

test("a decided account sees the row mirroring its decision, and accepting the agreement keeps it", async () => {
  // 2026-09-23: the panel now MIRRORS an existing decision instead of hiding the
  // row (the user must be able to see what they already agreed to). Mirroring is
  // not a re-ask: accepting the agreement alone must not rewrite the decision.
  const { setImprovementConsent } = await import("@/plugin/deveco/improvement-consent")
  expect(await setImprovementConsent("agreement-panel-user", true)).toBe(true)
  await using panel = await mount(30, false, "en", "panel", true)
  const frame = await panel.frame("[✓] (Optional) Join the improvement program")
  expect(frame).toContain("[ ] (Required) I have read and agree")
  // Accept the agreement without touching the improvement row
  panel.setup.mockInput.typeText(" ")
  await panel.frame("[✓] (Required) I have read and agree")
  panel.setup.mockInput.pressEnter()
  await panel.frame("Resumed session content")
  // Still granted — the row was not touched, so nothing was rewritten
  expect(await resolveImprovementConsent("agreement-panel-user")).toBe("granted")
  expect(panel.improvementChanges()).toBe(0)
  await tokenStorage.clearToken()
})

test("a decided account can still revoke the decision from the panel", async () => {
  // An explicit toggle IS a change and must persist (revocation path).
  const { setImprovementConsent } = await import("@/plugin/deveco/improvement-consent")
  expect(await setImprovementConsent("agreement-panel-user", true)).toBe(true)
  await using panel = await mount(30, false, "en", "panel", true)
  await panel.frame("[✓] (Optional) Join the improvement program")
  panel.setup.mockInput.pressArrow("down")
  await panel.setup.renderOnce()
  panel.setup.mockInput.typeText(" ")
  await panel.frame("[ ] (Optional) Join the improvement program")
  panel.setup.mockInput.pressArrow("up")
  await panel.setup.renderOnce()
  panel.setup.mockInput.typeText(" ")
  await panel.frame("[✓] (Required) I have read and agree")
  panel.setup.mockInput.pressEnter()
  await panel.frame("Resumed session content")
  expect(await resolveImprovementConsent("agreement-panel-user")).toBe("declined")
  expect(panel.improvementChanges()).toBe(1)
  await tokenStorage.clearToken()
})
