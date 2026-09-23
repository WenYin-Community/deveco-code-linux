/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { afterEach, beforeEach, expect, test } from "bun:test"
import {onCleanup, onMount, type ParentProps} from "solid-js"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../../../tui/test/fixture/tui-runtime"
import { ThemeProvider } from "@opencode-ai/tui/context/theme"
import { TuiConfigProvider } from "@opencode-ai/tui/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "@opencode-ai/tui/keymap"
import { KVProvider } from "@opencode-ai/tui/context/kv"
import { I18nProvider } from "@opencode-ai/tui/i18n"
import { DialogProvider, useDialog } from "@opencode-ai/tui/ui/dialog"
import { Toast, ToastProvider } from "@opencode-ai/tui/ui/toast"
import { DialogPrivacy } from "@/cli/deveco-ui/dialog-privacy"
import { saveAuthToDisk } from "@/plugin/deveco"
import { tokenStorage } from "@/plugin/deveco/token-storage"
import { invalidateImprovementConsentCache } from "@/plugin/deveco/improvement-consent"

/**
 * Reset the account-scoped state this dialog reads. test/preload.ts redirects
 * XDG_* to one directory per bun worker, and the worker is reused across test
 * files, so token.enc / auth.json / improvement-consent.json are shared by
 * every test in this worker unless each test starts from a known state.
 * The module-level 30s consent cache must be invalidated too — otherwise a
 * decision written by an earlier test is still returned after the file is gone.
 */
async function resetAccountState() {
  await tokenStorage.clearToken()
  await saveAuthToDisk("deveco", null)
  invalidateImprovementConsentCache()
  await fs.rm(consentFilePath(), { force: true })
}

/** Account-scoped consent record (see improvement-consent.ts storage primitives). */
function consentFilePath() {
  return path.join(process.env.XDG_STATE_HOME!, "deveco", "improvement-consent.json")
}

/** Poll for the record: the row updates optimistically, the write lands after. */
async function readConsentFile(): Promise<{ accounts: Record<string, unknown> }> {
  const file = consentFilePath()
  for (let i = 0; i < 200; i++) {
    if (await Bun.file(file).exists()) return (await Bun.file(file).json()) as { accounts: Record<string, unknown> }
    await Bun.sleep(10)
  }
  throw new Error(`improvement consent record was never written: ${file}`)
}

beforeEach(resetAccountState)
afterEach(resetAccountState)

/**
 * Mount the privacy dialog under an isolated state dir. When withAccount is
 * set, a real (preload-redirected config dir) token.enc + auth.json pair is
 * created for the synthetic account first — the improvement row is
 * account-scoped now (T3.4), so without an account it renders locked.
 */
async function mountPrivacy(withAccount = false) {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  if (withAccount) await seedAccount("privacy-row-user")
  const opened: string[] = []

  function Open() {
    const dialog = useDialog()
    onMount(() =>
      dialog.replace(() => (
        <DialogPrivacy
          openUrl={async (url) => {
            opened.push(url)
          }}
        />
      )),
    )
    return null
  }

  const setup = await testRender(
    () => (
      <DialogProviders tmp={tmp}>
        <Open />
      </DialogProviders>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  const frame = (text: string) => waitForFrame(setup, text)
  return {
    setup,
    frame,
    opened,
    async [Symbol.asyncDispose]() {
      setup.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

/** Render `children` inside the providers the privacy dialog needs. */
function DialogProviders(props: ParentProps<{ tmp: { path: string } }>) {
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts
        cwd={props.tmp.path}
        paths={{ home: props.tmp.path, state: props.tmp.path, worktree: props.tmp.path }}
      >
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <I18nProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <DialogProvider>
                      {props.children}
                      <Toast />
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
  return <Harness />
}

/** Forge the on-disk login state in the (preload-redirected) config dir. */
async function seedAccount(userId: string) {
  // Synthetic JWT whose payload carries a userId (only the payload is decoded)
  const jwt = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(
    JSON.stringify({ userId }),
  ).toString("base64url")}.sig`
  await tokenStorage.saveToken(jwt)
  await saveAuthToDisk("deveco", { type: "oauth", access: "access-token", refresh: "", expires: 0 })
}

/** Poll rendered frames until `text` appears. UI work is async, so never sleep-and-hope. */
async function waitForFrame(
  setup: { renderOnce: () => Promise<void>; captureCharFrame: () => string },
  text: string,
) {
  for (let i = 0; i < 200; i++) {
    await setup.renderOnce()
    const value = setup.captureCharFrame()
    if (value.includes(text)) return value
    await Bun.sleep(10)
  }
  throw new Error(setup.captureCharFrame())
}

test("privacy toggles stay open for Enter and Space", async () => {
  await using harness = await mountPrivacy()
  const setup = harness.setup
  try {
    await harness.frame("Disable Analytics")
    setup.mockInput.pressEnter()
    expect(await harness.frame("Privacy Policy")).toContain("Privacy")
    expect(harness.opened).toHaveLength(1)

    setup.mockInput.pressArrow("down")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
    expect(await harness.frame("Enable Analytics")).toContain("Privacy")

    setup.mockInput.typeText(" ")
    expect(await harness.frame("Disable Analytics")).toContain("Space toggle")
  } finally {
    setup.renderer.destroy()
  }
})

test("improvement row is locked with a sign-in hint when no account is present", async () => {
  // T3.4 / D8: not signed in → the account-scoped row greys out with the
  // "sign in to configure" hint and cannot be toggled
  await using harness = await mountPrivacy(false)
  const frame = await harness.frame("Improvement Program")
  // Shorter neutral title while locked → the hint is no longer clipped.
  expect(frame).toContain("Sign in to configure")
  expect(frame).not.toContain("Share prompts")
})

test("improvement row toggles per account and persists the decision", async () => {
  await using harness = await mountPrivacy(true)
  // Wait for the unlocked description: the row renders locked first and the
  // account-scoped read in onMount settles asynchronously. The description is
  // column-truncated, so match its stable prefix.
  // The dialog is ~52 content columns wide, so the description is truncated
  // (like the analytics/crash rows). Assert a stable prefix plus the title —
  // the title is what the earlier "long noun title" bug squeezed out.
  const frame = await harness.frame("Share prompts")
  expect(frame).toContain("Enable Improvement")
  // Move down to the improvement row (policy, terms, analytics, improvement)
  harness.setup.mockInput.pressArrow("down")
  harness.setup.mockInput.pressArrow("down")
  harness.setup.mockInput.pressArrow("down")
  harness.setup.mockInput.pressEnter()
  expect(await harness.frame("Stop sharing prompts")).toContain("Disable Improvement")
  // The account-scoped record was written (not the device kv key). The row
  // updates optimistically, so poll for the write to land instead of racing it.
  const fingerprints = Object.keys((await readConsentFile()).accounts)
  expect(fingerprints).toHaveLength(1)
  expect(fingerprints[0]).toMatch(/^[0-9a-f]{16}$/)
})
