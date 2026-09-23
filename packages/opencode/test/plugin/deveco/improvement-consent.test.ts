/**
 * Unit tests for plugin/deveco/improvement-consent.ts — per test-cases.md:
 *   §3.1 TC-FP-01~06 (account fingerprint)
 *   §3.2 TC-ST-01~08 (storage primitives + undefined-aware legacy key read)
 *   §3.3 TC-RS-01~08 (three-state resolve / cache / account isolation)
 *   §3.4 TC-CL-01~10 (one-time legacy claim)
 * plus direct cases for the §4.1 setter contract (I-4: unparseable userId → false, no write).
 *
 * Isolation (test-cases.md §1.2/§1.3):
 *   - state dir: injected via the `state?` seam with mkdtemp temp dirs
 *   - credentials: test/preload.ts redirects all XDG vars before any src import,
 *     so the tokenStorage singleton's token.enc lives in a per-process temp
 *     config dir — saveToken/clearToken never touch the developer's real login
 *   - no mocks: real Flock, real fs, real LocalCrypto encryption round-trips
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { createHash } from "crypto"
import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { Flock } from "@opencode-ai/core/util/flock"
import {
  accountFingerprint,
  getCurrentImprovementConsent,
  invalidateImprovementConsentCache,
  isImprovementConsentGranted,
  mutateConsentFile,
  readConsentFile,
  resolveImprovementConsent,
  setCurrentImprovementConsent,
  setImprovementConsent,
} from "@/plugin/deveco/improvement-consent"
import { readToolImprovementSetting } from "@/cli/deveco-privacy-settings"
import { tokenStorage } from "@/plugin/deveco/token-storage"

// Synthetic accounts only — never real identifiers (spec doc discipline, §2.2).
const USER_A = "example-user-0001"
const USER_B = "example-user-0002"
const USER_C = "example-user-0003"
const FP_A = accountFingerprint(USER_A)
const FP_B = accountFingerprint(USER_B)
const FP_C = accountFingerprint(USER_C)

const consentPath = (state: string) => path.join(state, "improvement-consent.json")

// Fresh temp state dir per test, removed in afterEach (lock dirs live inside it).
const dirs: string[] = []
async function consentDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "improvement-consent-"))
  dirs.push(dir)
  return dir
}

async function seedKv(state: string, value: boolean | undefined) {
  // undefined = kv.json exists but the key does not (C1 variant with a file present)
  const kv = value === undefined ? {} : { deveco_tool_improvement_enabled: value }
  await writeFile(path.join(state, "kv.json"), JSON.stringify(kv))
}

async function seedConsent(state: string, body: unknown) {
  await writeFile(consentPath(state), JSON.stringify(body))
}

async function readConsent(state: string) {
  return JSON.parse(await readFile(consentPath(state), "utf8"))
}

function makeJwt(userId: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  // parseJwtUserId only decodes the payload; the signature segment is never verified
  return `${encode({ alg: "none" })}.${encode({ userId })}.test-signature`
}

beforeEach(() => {
  // The module cache is process-global; keep tests order-independent
  invalidateImprovementConsentCache()
})

afterEach(async () => {
  invalidateImprovementConsentCache()
  // Never leave a saved token behind for other test files in this worker
  await tokenStorage.clearToken()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("accountFingerprint (TC-FP)", () => {
  test("TC-FP-01: deterministic across 1000 calls", () => {
    const expected = accountFingerprint(USER_A)
    const all = Array.from({ length: 1000 }, () => accountFingerprint(USER_A))
    expect(new Set(all).size).toBe(1)
    expect(all[0]).toBe(expected)
  })

  test("TC-FP-02: always 16 lowercase hex characters", () => {
    for (const userId of [USER_A, USER_B, "", "中文用户🚀"]) {
      expect(accountFingerprint(userId)).toMatch(/^[0-9a-f]{16}$/)
    }
  })

  test("TC-FP-03: 1000 incremental user ids produce no collisions", () => {
    const fps = Array.from({ length: 1000 }, (_, i) => accountFingerprint(`user-${i}`))
    expect(new Set(fps).size).toBe(1000)
  })

  test("TC-FP-04: edge-case inputs never throw and stay stable", () => {
    const inputs = ["", "x".repeat(2048), "用户-账号", "🚀🎉-emoji", " ", "\n\t"]
    for (const input of inputs) {
      const first = accountFingerprint(input)
      expect(accountFingerprint(input)).toBe(first)
      expect(first).toMatch(/^[0-9a-f]{16}$/)
    }
  })

  test("TC-FP-05: identical in a separate process", async () => {
    const modulePath = path.join(import.meta.dir, "../../../src/plugin/deveco/improvement-consent.ts")
    const childCode = `(async () => {
      const m = await import(${JSON.stringify(modulePath)})
      console.log(JSON.stringify({ fp: m.accountFingerprint(${JSON.stringify(USER_A)}) }))
    })()`
    const proc = Bun.spawn(["bun", "-e", childCode], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      Bun.readableStreamToText(proc.stdout),
      Bun.readableStreamToText(proc.stderr),
      proc.exited,
    ])
    expect(exitCode).toBe(0)
    const lines = stdout.trim().split("\n")
    expect(JSON.parse(lines[lines.length - 1] ?? "{}").fp).toBe(accountFingerprint(USER_A))
    expect(stderr).toBe("")
  }, 20_000)

  test("TC-FP-06: matches the sha256 hex prefix (deveco-agreement-sync algorithm)", () => {
    for (const userId of [USER_A, USER_B, "中文用户🚀"]) {
      expect(accountFingerprint(userId)).toBe(createHash("sha256").update(userId).digest("hex").slice(0, 16))
    }
  })
})

describe("consent storage primitives (TC-ST)", () => {
  test("TC-ST-01: first write creates a valid 0600 file with no plaintext ids", async () => {
    const state = await consentDir()
    const after = await mutateConsentFile(state, (draft) => {
      draft.accounts[FP_A] = { granted: true, at: 1 }
    })
    expect(after.schemaVersion).toBe(1)
    const raw = await readFile(consentPath(state), "utf8")
    const onDisk = JSON.parse(raw)
    expect(onDisk.accounts[FP_A]).toEqual({ granted: true, at: 1 })
    expect(Object.keys(onDisk.accounts)[0]).toHaveLength(16)
    expect(raw).not.toContain(USER_A) // AC-11: no plaintext account id on disk
    expect((await stat(consentPath(state))).mode & 0o777).toBe(0o600)
  })

  test("TC-ST-02: an interrupted write (tmp without rename) never leaves a half-written target", async () => {
    const state = await consentDir()
    await seedConsent(state, { schemaVersion: 1, accounts: { oldkey: { granted: false, at: 1 } } })
    // Simulate a killed writer: its tmp exists (even as broken JSON), rename never ran
    await writeFile(`${consentPath(state)}.12345.abcdef.tmp`, `{"schemaVersion":1,"acco`)
    const read = await readConsentFile(state)
    expect(read.accounts.oldkey).toEqual({ granted: false, at: 1 }) // target still holds the old content
    await mutateConsentFile(state, (draft) => {
      draft.accounts[FP_A] = { granted: true, at: 2 }
    })
    const onDisk = await readConsent(state)
    expect(onDisk.accounts.oldkey).toBeDefined() // read-modify-write keeps prior keys
    expect(onDisk.accounts[FP_A]).toEqual({ granted: true, at: 2 })
  })

  test("TC-ST-03: reading a missing file yields the empty structure without throwing", async () => {
    const state = await consentDir()
    expect(await readConsentFile(state)).toEqual({ schemaVersion: 1, accounts: {} })
  })

  test("TC-ST-04: 20 concurrent writes lose no updates", async () => {
    const state = await consentDir()
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        mutateConsentFile(state, (draft) => {
          draft.accounts[accountFingerprint(`concurrent-${i}`)] = { granted: i % 2 === 0, at: i }
        }),
      ),
    )
    const onDisk = await readConsentFile(state)
    expect(Object.keys(onDisk.accounts)).toHaveLength(20)
  }, 10_000)

  test("TC-ST-05: readToolImprovementSetting is three-state", async () => {
    const noKey = await consentDir()
    await seedKv(noKey, undefined)
    expect(await readToolImprovementSetting(noKey)).toBeUndefined()
    const noFile = await consentDir()
    expect(await readToolImprovementSetting(noFile)).toBeUndefined()
    const on = await consentDir()
    await seedKv(on, true)
    expect(await readToolImprovementSetting(on)).toBe(true)
    const off = await consentDir()
    await seedKv(off, false)
    expect(await readToolImprovementSetting(off)).toBe(false)
    const corrupt = await consentDir()
    await writeFile(path.join(corrupt, "kv.json"), JSON.stringify({ deveco_tool_improvement_enabled: "yes" }))
    expect(await readToolImprovementSetting(corrupt)).toBeUndefined() // non-boolean = no legacy record
  })

  test("TC-ST-06: a corrupted consent file recovers to empty and the next write overwrites", async () => {
    const state = await consentDir()
    await writeFile(consentPath(state), "{ not json")
    expect(await readConsentFile(state)).toEqual({ schemaVersion: 1, accounts: {} })
    await mutateConsentFile(state, (draft) => {
      draft.accounts[FP_A] = { granted: true, at: 5 }
    })
    expect((await readConsent(state)).accounts[FP_A]).toEqual({ granted: true, at: 5 })
  })

  test("TC-ST-07: a write preserves account records it knows nothing about", async () => {
    const state = await consentDir()
    const strangerKey = "0123456789abcdef" // fingerprint-shaped key from another writer
    await seedConsent(state, {
      schemaVersion: 1,
      accounts: {
        [FP_B]: { granted: true, at: 1 },
        [strangerKey]: { granted: false, at: 2 },
      },
    })
    await mutateConsentFile(state, (draft) => {
      draft.accounts[FP_A] = { granted: true, at: 3 }
    })
    const onDisk = await readConsentFile(state)
    expect(Object.keys(onDisk.accounts).sort()).toEqual([FP_A, FP_B, strangerKey].sort())
  })

  test("TC-ST-08: the read path queues on the consent lock instead of bypassing it", async () => {
    const state = await consentDir()
    await seedConsent(state, { schemaVersion: 1, accounts: {} })
    // Hold the exact same lock (same key + same dir) the module uses
    const lock = await Flock.acquire(`improvement-consent:${consentPath(state)}`, { dir: path.join(state, "locks") })
    const read = readConsentFile(state)
    const outcome = await Promise.race([
      read.then(() => "completed" as const),
      Bun.sleep(500).then(() => "timeout" as const),
    ])
    expect(outcome).toBe("timeout")
    await lock.release()
    expect((await read).accounts).toEqual({}) // completes once the lock is released
  })
})

describe("resolve and cache (TC-RS)", () => {
  test("TC-RS-01: three-state return for granted / declined / undecided", async () => {
    const granted = await consentDir()
    await seedConsent(granted, { schemaVersion: 1, accounts: { [FP_A]: { granted: true, at: 1 } } })
    expect(await resolveImprovementConsent(USER_A, granted)).toBe("granted")
    const declined = await consentDir()
    await seedConsent(declined, { schemaVersion: 1, accounts: { [FP_A]: { granted: false, at: 1 } } })
    expect(await resolveImprovementConsent(USER_A, declined)).toBe("declined")
    const undecided = await consentDir()
    expect(await resolveImprovementConsent(USER_A, undecided)).toBeUndefined()
  })

  test("TC-RS-02: not logged in — current consent is undefined and never granted", async () => {
    await tokenStorage.clearToken()
    // production form (state defaults to the preload-redirected Global.Path.state)
    expect(await getCurrentImprovementConsent()).toBeUndefined()
    expect(await isImprovementConsentGranted()).toBe(false)
    // injected form — and no record may be written when no account can be identified
    const state = await consentDir()
    expect(await getCurrentImprovementConsent(state)).toBeUndefined()
    expect(await isImprovementConsentGranted(state)).toBe(false)
    expect(await Bun.file(consentPath(state)).exists()).toBe(false)
  })

  test("TC-RS-03: repeated resolves are served from cache (single file read)", async () => {
    const state = await consentDir()
    await seedConsent(state, { schemaVersion: 1, accounts: { [FP_A]: { granted: true, at: 1 } } })
    expect(await resolveImprovementConsent(USER_A, state)).toBe("granted")
    // Flip the file to declined: within the TTL the cache keeps serving the old
    // value — a re-read of the file would observe the new one instead.
    await seedConsent(state, { schemaVersion: 1, accounts: { [FP_A]: { granted: false, at: 2 } } })
    for (let i = 0; i < 9; i++) {
      expect(await resolveImprovementConsent(USER_A, state)).toBe("granted")
    }
  })

  test("TC-RS-04: after the TTL the cache expires and the file is re-read", async () => {
    const state = await consentDir()
    await seedConsent(state, { schemaVersion: 1, accounts: { [FP_A]: { granted: true, at: 1 } } })
    expect(await resolveImprovementConsent(USER_A, state)).toBe("granted")
    await seedConsent(state, { schemaVersion: 1, accounts: { [FP_A]: { granted: false, at: 2 } } })
    // Advance past the 30s TTL (only Date is mocked; Flock timing uses performance.now)
    setSystemTime(Date.now() + 31_000)
    try {
      expect(await resolveImprovementConsent(USER_A, state)).toBe("declined")
    } finally {
      setSystemTime() // restore the real clock for the rest of the worker
    }
  })

  test("TC-RS-05: a successful write invalidates the cached value immediately", async () => {
    const state = await consentDir()
    await seedConsent(state, { schemaVersion: 1, accounts: { [FP_A]: { granted: true, at: 1 } } })
    expect(await resolveImprovementConsent(USER_A, state)).toBe("granted") // cached
    expect(await setImprovementConsent(USER_A, false, state)).toBe(true)
    expect(await resolveImprovementConsent(USER_A, state)).toBe("declined") // no TTL wait
  })

  test("TC-RS-06: cache keys are per state directory — no cross-hit", async () => {
    const dirA = await consentDir()
    const dirB = await consentDir()
    await seedConsent(dirA, { schemaVersion: 1, accounts: { [FP_A]: { granted: true, at: 1 } } })
    await seedConsent(dirB, { schemaVersion: 1, accounts: { [FP_A]: { granted: false, at: 1 } } })
    expect(await resolveImprovementConsent(USER_A, dirA)).toBe("granted")
    expect(await resolveImprovementConsent(USER_A, dirB)).toBe("declined")
    expect(await resolveImprovementConsent(USER_A, dirA)).toBe("granted") // alternating must not cross-hit
  })

  test("TC-RS-07: account A's decision never leaks to account B", async () => {
    const state = await consentDir()
    await seedConsent(state, { schemaVersion: 1, accounts: { [FP_A]: { granted: true, at: 1 } } })
    expect(await resolveImprovementConsent(USER_B, state)).toBeUndefined()
  })

  test("TC-RS-08: a recorded decision is readable without credentials", async () => {
    await tokenStorage.clearToken() // simulate deleted/reset credentials
    const state = await consentDir()
    await seedConsent(state, { schemaVersion: 1, accounts: { [FP_A]: { granted: true, at: 1 } } })
    expect(await resolveImprovementConsent(USER_A, state)).toBe("granted") // record survives, direct lookup works
    expect(await getCurrentImprovementConsent(state)).toBeUndefined() // but no current account can be identified
  })

  test("I-4 contract: setters refuse an empty userId without writing or throwing", async () => {
    const state = await consentDir()
    expect(await setImprovementConsent("", true, state)).toBe(false)
    expect(await Bun.file(consentPath(state)).exists()).toBe(false)
  })

  test("I-4 contract: setCurrent returns false when the token yields no userId", async () => {
    await tokenStorage.saveToken("not-a-jwt") // valid encryption, unparseable JWT
    const state = await consentDir()
    expect(await getCurrentImprovementConsent(state)).toBeUndefined()
    expect(await setCurrentImprovementConsent(true, state)).toBe(false)
    expect(await Bun.file(consentPath(state)).exists()).toBe(false)
  })

  test("current-account roundtrip through a real (redirected) token.enc", async () => {
    await tokenStorage.saveToken(makeJwt(USER_A))
    const state = await consentDir()
    expect(await getCurrentImprovementConsent(state)).toBeUndefined() // logged in, undecided
    expect(await setCurrentImprovementConsent(true, state)).toBe(true)
    expect(await isImprovementConsentGranted(state)).toBe(true)
    const onDisk = await readConsent(state)
    expect(onDisk.accounts[FP_A].granted).toBe(true)
    expect(typeof onDisk.accounts[FP_A].at).toBe("number")
    expect(await setImprovementConsent(USER_A, false, state)).toBe(true) // FR-4: both values persist
    expect(await resolveImprovementConsent(USER_A, state)).toBe("declined")
  })
})

describe("legacy claim (TC-CL)", () => {
  test("TC-CL-01: no legacy key — nothing is claimed and nothing is written", async () => {
    const withEmptyKv = await consentDir()
    await seedKv(withEmptyKv, undefined) // kv.json present, key absent
    expect(await resolveImprovementConsent(USER_A, withEmptyKv)).toBeUndefined()
    expect(await Bun.file(consentPath(withEmptyKv)).exists()).toBe(false)
    const withoutKv = await consentDir() // no kv.json at all
    expect(await resolveImprovementConsent(USER_A, withoutKv)).toBeUndefined()
    expect(await Bun.file(consentPath(withoutKv)).exists()).toBe(false)
  })

  test("TC-CL-02: legacy true is claimed as granted by the first account", async () => {
    const state = await consentDir()
    await seedKv(state, true)
    expect(await resolveImprovementConsent(USER_A, state)).toBe("granted")
    const onDisk = await readConsent(state)
    expect(onDisk.accounts[FP_A].granted).toBe(true)
    expect(typeof onDisk.accounts[FP_A].at).toBe("number")
    expect(onDisk.legacyClaimed).toBe(true)
  })

  test("TC-CL-03: legacy false is claimed as declined (symmetric with D2)", async () => {
    const state = await consentDir()
    await seedKv(state, false)
    expect(await resolveImprovementConsent(USER_A, state)).toBe("declined")
    const onDisk = await readConsent(state)
    expect(onDisk.accounts[FP_A].granted).toBe(false)
    expect(onDisk.legacyClaimed).toBe(true)
  })

  test("TC-CL-04: the claim is not inherited by a second account", async () => {
    const state = await consentDir()
    await seedKv(state, true)
    expect(await resolveImprovementConsent(USER_A, state)).toBe("granted")
    expect(await resolveImprovementConsent(USER_B, state)).toBeUndefined()
    const onDisk = await readConsent(state)
    expect(onDisk.accounts[FP_B]).toBeUndefined()
    expect(Object.keys(onDisk.accounts)).toHaveLength(1)
  })

  test("TC-CL-05: 20 concurrent resolves of one account claim exactly once", async () => {
    const state = await consentDir()
    await seedKv(state, true)
    const results = await Promise.all(Array.from({ length: 20 }, () => resolveImprovementConsent(USER_A, state)))
    expect(results).toEqual(Array.from({ length: 20 }, () => "granted"))
    const onDisk = await readConsent(state)
    expect(Object.keys(onDisk.accounts)).toHaveLength(1)
    expect(onDisk.accounts[FP_A].granted).toBe(true)
    expect(onDisk.legacyClaimed).toBe(true)
  }, 10_000)

  test("TC-CL-06: concurrent first resolves of two accounts — exactly one claims", async () => {
    const state = await consentDir()
    await seedKv(state, true)
    const [a, b] = await Promise.all([
      resolveImprovementConsent(USER_A, state),
      resolveImprovementConsent(USER_B, state),
    ])
    expect([a, b].filter((r) => r === "granted")).toHaveLength(1)
    expect([a, b].filter((r) => r === undefined)).toHaveLength(1)
    const onDisk = await readConsent(state)
    expect(Object.keys(onDisk.accounts)).toHaveLength(1)
    expect(onDisk.legacyClaimed).toBe(true)
  }, 10_000)

  test("TC-CL-07: a claim interrupted before rename is retried cleanly", async () => {
    const state = await consentDir()
    await seedKv(state, true)
    // Simulate a killed claimer: its tmp holds a *different* account's claimed
    // state, rename never ran. The retry must re-claim from kv, never adopt the tmp.
    const staleTmp = `${consentPath(state)}.99999.deadbeef-0000-4000-8000-000000000000.tmp`
    await writeFile(staleTmp, JSON.stringify({
      schemaVersion: 1,
      accounts: { [FP_C]: { granted: true, at: 1 } },
      legacyClaimed: true,
    }))
    expect(await resolveImprovementConsent(USER_A, state)).toBe("granted")
    const onDisk = await readConsent(state)
    expect(Object.keys(onDisk.accounts)).toHaveLength(1) // no duplicates, no adopted tmp content
    expect(onDisk.accounts[FP_A].granted).toBe(true)
    expect(onDisk.legacyClaimed).toBe(true)
  })

  test("TC-CL-08: claiming never touches kv.json (frozen, not deleted)", async () => {
    const state = await consentDir()
    await seedKv(state, true)
    const before = await readFile(path.join(state, "kv.json"), "utf8")
    await resolveImprovementConsent(USER_A, state)
    expect(await readFile(path.join(state, "kv.json"), "utf8")).toBe(before)
  })

  test("TC-CL-09: once claimed, the legacy record no longer participates", async () => {
    const state = await consentDir()
    await seedKv(state, true)
    await resolveImprovementConsent(USER_A, state) // claim happens
    expect(await resolveImprovementConsent(USER_C, state)).toBeUndefined()
    const onDisk = await readConsent(state)
    expect(onDisk.accounts[FP_C]).toBeUndefined()
  })

  test("TC-CL-10: the claimed value comes from the legacy key, not a default", async () => {
    const state = await consentDir()
    await seedKv(state, false) // a wrong default of true would yield "granted" here
    expect(await resolveImprovementConsent(USER_A, state)).toBe("declined")
  })
})
