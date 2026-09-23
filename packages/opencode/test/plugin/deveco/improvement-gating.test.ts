/**
 * Integration tests for the improvement-consent gating chain (T4.1 / TC-IG-01~04,
 * AC-5 / AC-6 / AC-15 account scoping) — the headless, network-free core.
 *
 * Why a subprocess (test-cases.md §1.2 / design §4.2):
 *   `Global.Path.*` is evaluated at module load, and `tokenStorage` is a
 *   module-level singleton whose token.enc path is fixed at load time. The four
 *   XDG vars can therefore only be redirected BEFORE the src imports happen, so
 *   every case here spawns `bun -e` with all four XDG vars pointed at a fresh
 *   mkdtemp sandbox (same approach as test/server/httpapi-exercise/environment.ts:9-12).
 *
 * No mocks: the child imports the real modules, the real LocalCrypto self-generates
 *   its KEK/DEK inside the redirected config dir, and the real tokenStorage /
 *   saveAuthToDisk write the forged login state before the judgment runs.
 *
 * Not automated here (needs a real signed-in account + network, see verification
 * report "manual" list): the full `deveco run` end-to-end upload (AC-5/AC-6 upload
 * half) and the TUI paths (AC-12/13/16/17). The session-pinning collection half
 * of AC-15 is covered headlessly by
 * test/plugin/analytics/analytics-magpie-plugin.test.ts (the plugin takes its
 * collector/currentAccount dependencies as arguments).
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { accountFingerprint } from "@/plugin/deveco/improvement-consent"

// Synthetic accounts only — never real identifiers (spec §2.2).
const USER_A = "example-user-0001"
const USER_B = "example-user-0002"

const SRC = path.join(import.meta.dir, "../../../src")
const MODULE_PATH = path.join(SRC, "plugin/deveco/improvement-consent.ts")
const STORAGE_PATH = path.join(SRC, "plugin/deveco/storage.ts")
const TOKEN_STORAGE_PATH = path.join(SRC, "plugin/deveco/token-storage.ts")
const MAGPIE_STORAGE_PATH = path.join(SRC, "plugin/analytics-magpie/storage.ts")

/**
 * Child program. Runs with cwd = this test dir so `@opencode-ai/core/*` and the
 * `@/` tsconfig paths resolve exactly as they do in production.
 *
 * CHILD_LOGIN=1 forges a logged-in state the same way the product does:
 *   auth.json gets an encrypted `deveco` oauth entry (real saveAuthToDisk →
 *   LocalCrypto.encryptAuthData) and token.enc gets a real LocalCrypto blob whose
 *   plaintext is a three-segment JWT carrying `{ userId }` (parseJwtUserId only
 *   decodes the payload segment; the signature is never verified).
 */
const CHILD_SCRIPT = String.raw`
const path = await import("path")
const mod = await import(process.env.CHILD_MODULE)
const storage = await import(process.env.CHILD_STORAGE)
const { tokenStorage } = await import(process.env.CHILD_TOKEN_STORAGE)
const magpie = await import(process.env.CHILD_MAGPIE)
const g = await import("@opencode-ai/core/global")

const userId = process.env.CHILD_USER
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")

if (process.env.CHILD_LOGIN === "1") {
  await storage.saveAuthToDisk("deveco", { type: "oauth", access: "fake-access-token", refresh: "fake-refresh-token" })
  await tokenStorage.saveToken(encode({ alg: "none" }) + "." + encode({ userId }) + ".test-signature")
}

const result = {
  paths: { state: g.Global.Path.state, config: g.Global.Path.config, data: g.Global.Path.data },
  hasOAuth: storage.hasDevecoOAuthEntry(),
  accessToken: storage.loadAccessTokenFromDisk(),
  tokenFileExists: await Bun.file(path.join(g.Global.Path.config, "token.enc")).exists(),
  consentFileExists: await Bun.file(path.join(g.Global.Path.state, "improvement-consent.json")).exists(),
  granted: await mod.isImprovementConsentGranted(),
  current: (await mod.getCurrentImprovementConsent()) ?? null,
  magpieEnabled: await magpie.getAnalyticsMagpieEnabled(),
  decoy: process.env.CHILD_DECOY ? ((await mod.resolveImprovementConsent(userId, process.env.CHILD_DECOY)) ?? null) : null,
}
console.log("__RESULT__" + JSON.stringify(result))
`

type ChildResult = {
  paths: { state: string; config: string; data: string }
  hasOAuth: boolean
  accessToken: string
  tokenFileExists: boolean
  consentFileExists: boolean
  granted: boolean
  current: string | null
  magpieEnabled: boolean
  decoy: string | null
}

type Sandbox = { root: string; state: string; data: string; config: string; cache: string }

const sandboxes: string[] = []

/** Fresh four-XDG sandbox per case; removed in afterAll. */
async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), "improvement-gating-"))
  sandboxes.push(root)
  const sb = {
    root,
    state: path.join(root, "state"),
    data: path.join(root, "data"),
    config: path.join(root, "config"),
    cache: path.join(root, "cache"),
  }
  await Promise.all([sb.state, sb.data, sb.config, sb.cache].map((dir) => mkdir(dir, { recursive: true })))
  return sb
}

/** Seed a decision record at the sandbox's real state location ($XDG_STATE_HOME/deveco). */
async function seedConsent(sb: Sandbox, userId: string, granted: boolean) {
  const stateDir = path.join(sb.state, "deveco")
  await mkdir(stateDir, { recursive: true })
  await writeFile(
    path.join(stateDir, "improvement-consent.json"),
    JSON.stringify({ schemaVersion: 1, accounts: { [accountFingerprint(userId)]: { granted, at: 1 } } }),
  )
}

/**
 * Isolation audit helper: the module derives its Flock dir as `<state>/locks`,
 * so after any consent read the sandbox must own that directory — a leak would
 * mean the lock was created in the developer's real state dir instead.
 */
async function expectSandboxLocalLockDir(sb: Sandbox) {
  const locks = path.join(sb.state, "deveco", "locks")
  expect((await stat(locks).catch(() => null))?.isDirectory()).toBe(true)
  expect(locks.startsWith(sb.root)).toBe(true)
}

/** Spawn the child with all four XDG vars redirected into the sandbox. */
async function runChild(
  sb: Sandbox,
  options: { userId?: string; login?: boolean; decoyState?: string } = {},
): Promise<ChildResult> {
  const proc = Bun.spawn(["bun", "-e", CHILD_SCRIPT], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      XDG_STATE_HOME: sb.state,
      XDG_DATA_HOME: sb.data,
      XDG_CONFIG_HOME: sb.config,
      XDG_CACHE_HOME: sb.cache,
      CHILD_MODULE: MODULE_PATH,
      CHILD_STORAGE: STORAGE_PATH,
      CHILD_TOKEN_STORAGE: TOKEN_STORAGE_PATH,
      CHILD_MAGPIE: MAGPIE_STORAGE_PATH,
      CHILD_USER: options.userId ?? USER_A,
      CHILD_LOGIN: options.login ? "1" : "0",
      ...(options.decoyState ? { CHILD_DECOY: options.decoyState } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
    proc.exited,
  ])
  expect({ stderr, exitCode }).toEqual({ stderr: "", exitCode: 0 })
  const line = stdout.trim().split("\n").findLast((entry) => entry.startsWith("__RESULT__"))
  expect(line).toBeDefined()
  return JSON.parse(line!.slice("__RESULT__".length)) as ChildResult
}

afterAll(async () => {
  await Promise.all(sandboxes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("improvement gating integration (four XDG vars redirected)", () => {
  test("TC-IG-01a: reads the redirected state/config/data dirs, not the developer's real ones", async () => {
    const sb = await sandbox()
    const decoy = await sandbox()
    await seedConsent(sb, USER_A, true)
    await seedConsent(decoy, USER_A, false) // different value: a cross-hit would be visible

    const result = await runChild(sb, { login: true, decoyState: path.join(decoy.state, "deveco") })

    // The module must resolve its paths from the spawned env — never from $HOME.
    expect(result.paths).toEqual({
      state: path.join(sb.state, "deveco"),
      config: path.join(sb.config, "deveco"),
      data: path.join(sb.data, "deveco"),
    })
    for (const dir of Object.values(result.paths)) expect(dir.startsWith(sb.root)).toBe(true)
    // Granted came from the sandbox record; the explicit state seam still reads elsewhere.
    expect(result.granted).toBe(true)
    expect(result.current).toBe("granted")
    expect(result.decoy).toBe("declined")
    expect(result.consentFileExists).toBe(true)
    // Lock artifacts are sandbox-local too (isolation audit).
    await expectSandboxLocalLockDir(sb)
  }, 20_000)

  test("TC-IG-02b: no credentials → false, even with a granted record present", async () => {
    const sb = await sandbox()
    await seedConsent(sb, USER_A, true) // the record alone must not be enough

    const result = await runChild(sb, { login: false })

    expect(result.hasOAuth).toBe(false)
    expect(result.tokenFileExists).toBe(false)
    expect(result.accessToken).toBe("")
    expect(result.granted).toBe(false)
    expect(result.current).toBeNull()
    expect(result.magpieEnabled).toBe(false)
  }, 20_000)

  test("TC-IG-01c: forged login (real LocalCrypto keys in the redirected config dir) + granted → true", async () => {
    const sb = await sandbox()
    await seedConsent(sb, USER_A, true)

    const result = await runChild(sb, { login: true })

    // The forged login is a real, decryptable credential — not a hand-written stub.
    expect(result.hasOAuth).toBe(true)
    expect(result.accessToken).toBe("fake-access-token")
    expect(result.tokenFileExists).toBe(true)
    expect(result.granted).toBe(true)
    expect(result.current).toBe("granted")
    // The consumer seam (magpie eligibility, AC-5/AC-6 judgment half) agrees.
    expect(result.magpieEnabled).toBe(true)
    await expectSandboxLocalLockDir(sb)
  }, 20_000)

  test("TC-IG-02d: logged in with no record → false, and the read path writes nothing", async () => {
    const sb = await sandbox()

    const result = await runChild(sb, { login: true })

    expect(result.hasOAuth).toBe(true)
    expect(result.granted).toBe(false)
    expect(result.current).toBeNull()
    expect(result.magpieEnabled).toBe(false)
    expect(result.consentFileExists).toBe(false)
  }, 20_000)

  test("TC-IG-02d2: logged in with a declined record → false", async () => {
    const sb = await sandbox()
    await seedConsent(sb, USER_A, false)

    const result = await runChild(sb, { login: true })

    expect(result.granted).toBe(false)
    expect(result.current).toBe("declined")
    expect(result.magpieEnabled).toBe(false)
  }, 20_000)

  test("TC-IG-04: account scoping survives across processes sharing one state dir", async () => {
    const sb = await sandbox()
    await seedConsent(sb, USER_A, true)

    const a = await runChild(sb, { userId: USER_A, login: true })
    const b = await runChild(sb, { userId: USER_B, login: true })

    expect(a.granted).toBe(true) // A's own record
    expect(b.granted).toBe(false) // A's decision never leaks to B (AC-4)
    expect(b.magpieEnabled).toBe(false)
  }, 20_000)
})
