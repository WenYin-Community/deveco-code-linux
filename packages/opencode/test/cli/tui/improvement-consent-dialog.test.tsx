/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { onCleanup, onMount, type ParentProps } from "solid-js"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../../../tui/test/fixture/tui-runtime"
import en from "../../../../tui/src/i18n/en.json" with { type: "json" }
import { ThemeProvider } from "@opencode-ai/tui/context/theme"
import { TuiConfigProvider } from "@opencode-ai/tui/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "@opencode-ai/tui/keymap"
import { KVProvider } from "@opencode-ai/tui/context/kv"
import { I18nProvider } from "@opencode-ai/tui/i18n"
import { DialogProvider, useDialog } from "@opencode-ai/tui/ui/dialog"
import { Toast, ToastProvider } from "@opencode-ai/tui/ui/toast"
import { ImprovementConsentDialog } from "@/cli/deveco-ui/improvement-consent-dialog"
import { saveAuthToDisk } from "@/plugin/deveco"
import { tokenStorage } from "@/plugin/deveco/token-storage"
import {
  accountFingerprint,
  invalidateImprovementConsentCache,
  resolveImprovementConsent,
} from "@/plugin/deveco/improvement-consent"

/**
 * The dialog asks a question with three explicit answers (2026-09-23):
 *   同意 → granted:true · 拒绝 → granted:false · 取消 → 不落盘，下次再问
 * These tests pin that contract, including the "cancel writes nothing" case —
 * which is what makes the account stay undecided and be asked again later.
 */
const ACCOUNT = "consent-dialog-user"

function consentFilePath() {
  return path.join(process.env.XDG_STATE_HOME!, "deveco", "improvement-consent.json")
}

/**
 * test/preload.ts redirects XDG_* to one directory per bun worker and the worker
 * is reused across test files, so token.enc / auth.json / improvement-consent.json
 * are shared unless each test starts from a known state. The module-level 30s
 * cache must be invalidated too.
 */
async function resetAccountState() {
  await tokenStorage.clearToken()
  await saveAuthToDisk("deveco", null)
  invalidateImprovementConsentCache()
  await fs.rm(consentFilePath(), { force: true })
}

beforeEach(resetAccountState)
afterEach(resetAccountState)

/** Render `children` inside the providers the dialog needs. Extracted from the
 *  mount helper so that helper stays small (style gate: function body <= 50 lines). */
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

async function mountDialog(language = "en") {
  const tmp = await tmpdir()
  // The I18nProvider reads the saved language from kv on mount.
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify({ language }))
  await seedAccount(ACCOUNT)

  const completed: number[] = []
  const changes: boolean[] = []

  function Open() {
    const dialog = useDialog()
    onMount(() =>
      dialog.replace(() => (
        <ImprovementConsentDialog
          onComplete={() => completed.push(1)}
          onImprovementChange={(enabled) => {
            changes.push(enabled)
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
  await frame(language === "zh" ? "体验改进计划" : "Improvement Program")
  return {
    setup,
    frame,
    completed,
    changes,
    async [Symbol.asyncDispose]() {
      setup.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

/** Move the selection down `times` rows and confirm. */
async function select(setup: Awaited<ReturnType<typeof mountDialog>>["setup"], times: number) {
  for (let i = 0; i < times; i++) {
    setup.mockInput.pressArrow("down")
    await setup.renderOnce()
  }
  setup.mockInput.pressEnter()
}

/**
 * `onSelect` runs an async write, so asserting immediately after `pressEnter`
 * races it (and a leaked in-flight write would pollute the *next* test, since
 * the worker's state dir is shared). Always wait for the observable outcome.
 */
async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, message: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await check()
    if (value !== undefined) return value
    await Bun.sleep(10)
  }
  throw new Error(message)
}

test("the ask offers agree / decline / cancel", async () => {
  await using harness = await mountDialog()
  const view = await harness.frame("Agree")
  // Flatten whitespace: the notice wraps, so phrases can straddle two lines.
  const flat = view.replace(/\s+/g, " ")
  expect(flat).toContain("Decline")
  expect(flat).toContain("Ask me later")
  // UI-4: the honest disclosure (what is shared + the model scope) stays visible. Read the
  // sentence from the locale file (a module-relative import, not a cwd-relative path) so copy
  // tweaks don't break this; the extra substring pins the half that carries the disclosure.
  expect(flat).toContain(en.account.improvement_consent)
  expect(flat).toContain("built-in models")
})

test("the check mark follows the highlighted option", async () => {
  await using harness = await mountDialog()
  // Initial selection is the first option (radio semantics: one mark at a time)
  const first = (await harness.frame("[✓] Agree")).replace(/\s+/g, " ")
  expect(first).toContain("[ ] Decline")
  expect(first).toContain("[ ] Ask me later")
  harness.setup.mockInput.pressArrow("down")
  await harness.setup.renderOnce()
  const second = (await harness.frame("[✓] Decline")).replace(/\s+/g, " ")
  expect(second).toContain("[ ] Agree")
  expect(second).toContain("[ ] Ask me later")
  harness.setup.mockInput.pressArrow("up")
  await harness.setup.renderOnce()
  const back = (await harness.frame("[✓] Agree")).replace(/\s+/g, " ")
  expect(back).toContain("[ ] Decline")
})

test("the CJK notice flows continuously instead of breaking after a punctuation mark", async () => {
  // Regression (2026-09-23): with wrapMode="word" the native wrapper treats a CJK
  // comma as a word boundary and the following long CJK run as one unbreakable
  // "word", so the zh notice broke right after "加入体验改进计划，" and left the rest
  // of the first line empty. The disclosure line now wraps per character for CJK.
  await using harness = await mountDialog("zh")
  const view = await harness.frame("加入体验改进计划")
  const line = view.split("\n").find((l) => l.includes("加入体验改进计划"))
  expect(line).toBeDefined()
  // Assert the line keeps flowing PAST the comma instead of naming the words that follow:
  // the earlier failure mode was exactly "first line ends at ，", and hard-coding the rest
  // of the copy breaks this test on every copy tweak.
  expect(line!.trimEnd().endsWith("加入体验改进计划，")).toBe(false)
})

test("agree records granted and notifies the worker", async () => {
  await using harness = await mountDialog()
  await select(harness.setup, 0) // first option = Agree
  expect(
    await waitFor(async () => {
      const value = await resolveImprovementConsent(ACCOUNT)
      return value === "granted" ? value : undefined
    }, "granted was never recorded"),
  ).toBe("granted")
  await waitFor(() => (harness.completed.length ? true : undefined), "onComplete never fired")
  expect(harness.changes).toEqual([true])
})

test("decline records declined", async () => {
  await using harness = await mountDialog()
  await select(harness.setup, 1) // second option = Decline
  expect(
    await waitFor(async () => {
      const value = await resolveImprovementConsent(ACCOUNT)
      return value === "declined" ? value : undefined
    }, "declined was never recorded"),
  ).toBe("declined")
  await waitFor(() => (harness.completed.length ? true : undefined), "onComplete never fired")
  expect(harness.changes).toEqual([false])
})

test("cancel writes nothing so the account stays undecided", async () => {
  await using harness = await mountDialog()
  await select(harness.setup, 2) // third option = Cancel
  await waitFor(() => (harness.completed.length ? true : undefined), "onComplete never fired")
  expect(harness.changes).toHaveLength(0)
  // The dialog closes without a decision → the next launch must ask again (F4).
  expect(await resolveImprovementConsent(ACCOUNT)).toBeUndefined()
  // Give a wrong write a chance to land before asserting the file is absent.
  await Bun.sleep(100)
  expect(await Bun.file(consentFilePath()).exists()).toBe(false)
  expect(accountFingerprint(ACCOUNT)).toMatch(/^[0-9a-f]{16}$/)
})
