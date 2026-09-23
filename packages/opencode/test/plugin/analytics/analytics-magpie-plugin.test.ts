/**
 * Plugin-level tests for the magpie session-account pinning (T2.6 / D13 /
 * design §9.5, AC-15 / TC-CS-07).
 *
 * `createAnalyticsMagpiePlugin` takes its whole dependency set as an
 * argument, so the session loop can be driven headlessly here with hand-written
 * fakes (a plain object implementing the seam — no mocking library, and the
 * unit under test is the real plugin).
 *
 * Pinning contract under test:
 *   - the account current at first admission is pinned to the sessionID and
 *     every later turn of that session judges eligibility by it;
 *   - a new sessionID judges by the account current at its own admission;
 *   - an idle signal releases the pin, so the same sessionID re-pins afterwards.
 *     Pin lifetime is therefore ONE RUN, not the whole session: production sets
 *     idle at the end of every run (see `idleStatus` below);
 *   - revocation of the *pinned* account is not protected by the pin: the next
 *     turn stops collecting immediately (design §9.5 撤回例外);
 *   - early-return branches never leave a pin behind (R3): an idle event that
 *     fails the eligibility gate, and tool calls for sessions never admitted.
 */
import { expect, test } from "bun:test"
import type { Hooks, Plugin } from "@opencode-ai/plugin"
import {
  createAnalyticsMagpiePlugin,
  type AnalyticsMagpiePluginDependencies,
} from "@/plugin/analytics-magpie/analytics-plugin"

const ACCOUNT_A = "account-a"
const ACCOUNT_B = "account-b"

type Harness = {
  plugin: Plugin
  /** Accounts passed to collector.shouldCollect, in call order. */
  judged: string[]
  /** Sessions whose turn was actually accepted for collection. */
  startedTurns: string[]
  /** Sessions cleared after a rejected turn. */
  clearedSessions: string[]
  setAccount(value: string | null): void
  setConsent(userId: string, granted: boolean): void
  /** The plugin's runtime switch, as the real `collectionEnabled` variable. */
  isRuntimeEnabled(): boolean
  /**
   * The account-level consent decision as the plugin reads it at init:
   * "granted" / "declined" / undefined (未表态). Also drives the boolean
   * `collectionEnabled()` dependency.
   */
  setAccountDecision(decision: "granted" | "declined" | undefined): void
}

/** Recording fake for the collector seam: asserts which accounts were judged. */
function createCollector(
  state: { consent: Map<string, boolean> },
  judged: string[],
  startedTurns: string[],
  clearedSessions: string[],
): AnalyticsMagpiePluginDependencies["collector"] {
  return {
    init: async () => {},
    setLoggedIn: () => {},
    shouldCollect: async (userId) => {
      judged.push(userId)
      return state.consent.get(userId) === true
    },
    startTurn: (input) => {
      startedTurns.push(input.sessionID)
    },
    recordSessionParent: () => {},
    recordAssistant: () => {},
    recordTextDelta: () => {},
    recordTextPart: () => {},
    recordToolPart: () => {},
    recordFileDiff: () => {},
    recordFileEdit: () => {},
    markFailure: () => {},
    buildEventsForSession: async () => [],
    clearTurn: () => {},
    clearSession: (sessionID) => {
      clearedSessions.push(sessionID)
    },
    clear: () => {},
  }
}

/** Production-shaped dependencies wired to the mutable harness state. */
function createDependencies(
  state: { account: string | null; runtimeEnabled: boolean; accountDecision: "granted" | "declined" | undefined },
  collector: AnalyticsMagpiePluginDependencies["collector"],
): AnalyticsMagpiePluginDependencies {
  return {
    collector,
    collectionEnabled: async () => state.accountDecision === "granted",
    consentDecision: async () => state.accountDecision,
    currentAccount: async () => state.account,
    runtimeEnabled: () => state.runtimeEnabled,
    runtimeEpoch: () => 1,
    setCollectionEnabled: async (enabled: boolean) => {
      state.runtimeEnabled = enabled
    },
    shutdownCollection: async () => {},
    upload: async () => true,
    isLoggedIn: async () => true,
    isJwtExpired: async () => false,
    diagnostic: async () => {},
    projectId: async () => "project-id",
    version: () => "1.0.0",
  }
}

function createHarness(): Harness {
  const state = {
    account: ACCOUNT_A as string | null,
    consent: new Map<string, boolean>([
      [ACCOUNT_A, true],
      [ACCOUNT_B, true],
    ]),
    // The plugin's runtime switch and the account-level decision it is seeded
    // from. Both are mutable so a test can reproduce "init ran while signed out,
    // then an already-granted account signs in" (P1).
    runtimeEnabled: true,
    accountDecision: "granted" as "granted" | "declined" | undefined,
  }
  const judged: string[] = []
  const startedTurns: string[] = []
  const clearedSessions: string[] = []
  const collector = createCollector(state, judged, startedTurns, clearedSessions)
  const plugin = createAnalyticsMagpiePlugin(createDependencies(state, collector))
  return {
    plugin,
    judged,
    startedTurns,
    clearedSessions,
    setAccount: (value) => {
      state.account = value
    },
    setConsent: (userId, granted) => {
      state.consent.set(userId, granted)
    },
    isRuntimeEnabled: () => state.runtimeEnabled,
    setAccountDecision: (decision) => {
      state.accountDecision = decision
    },
  }
}

/**
 * chat.message enqueues its work and resolves immediately, while event() returns
 * the serial queue's tail. Awaiting a harmless event therefore waits for every
 * task queued before it — no sleeps, no polling.
 */
async function settle(hooks: Hooks): Promise<void> {
  await hooks.event!({ event: { type: "test.settle" } as never })
}

async function turn(hooks: Hooks, sessionID: string, providerID = "deveco"): Promise<void> {
  await hooks["chat.message"]!(
    { sessionID, agent: "build", model: { providerID, modelID: "model-1" } } as never,
    { message: { id: `${sessionID}-message-1` }, parts: [] } as never,
  )
  await settle(hooks)
}

async function idle(hooks: Hooks, sessionID: string): Promise<void> {
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as never })
}

/**
 * The signal production actually emits per run: `SessionStatus.set({type:"idle"})`
 * publishes `session.status` *and* `session.idle` together (session/status.ts),
 * and the runner sets idle at the end of every run (session/run-state.ts). So the
 * pin covers one run, not the whole session — this helper exercises that trigger
 * explicitly, since the other cases only send `session.idle`.
 */
async function idleStatus(hooks: Hooks, sessionID: string): Promise<void> {
  await hooks.event!({
    event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } as never,
  })
}

test("pins the account current at first admission and keeps it for later turns of that session", async () => {
  const harness = createHarness()
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)

  await turn(hooks, "session-1")
  expect(harness.startedTurns).toEqual(["session-1"])
  expect(harness.judged).toEqual([ACCOUNT_A])

  // The account switches mid-session: the in-flight session keeps judging by A
  // (D13 — an account switch must not change an already-started session).
  harness.setAccount(ACCOUNT_B)
  await turn(hooks, "session-1")
  expect(harness.judged).toEqual([ACCOUNT_A, ACCOUNT_A])
  expect(harness.startedTurns).toEqual(["session-1", "session-1"])

  // A brand new sessionID is judged by the account that is current now.
  await turn(hooks, "session-2")
  expect(harness.judged).toEqual([ACCOUNT_A, ACCOUNT_A, ACCOUNT_B])
  expect(harness.startedTurns).toEqual(["session-1", "session-1", "session-2"])
})

test("session.idle releases the pin so the same session re-pins to the current account", async () => {
  const harness = createHarness()
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)

  await turn(hooks, "session-1")
  harness.setAccount(ACCOUNT_B)
  // The idle event itself is still judged by the pinned account (A)...
  await idle(hooks, "session-1")
  expect(harness.judged).toEqual([ACCOUNT_A, ACCOUNT_A])

  // ...but the session is finished, so the next turn re-pins B.
  await turn(hooks, "session-1")
  expect(harness.judged).toEqual([ACCOUNT_A, ACCOUNT_A, ACCOUNT_B])
  expect(harness.startedTurns).toEqual(["session-1", "session-1"])
})

test("init leaves collection open while no account is resolvable (P1)", async () => {
  // Regression: init used to latch `setCollectionEnabled(await collectionEnabled())`
  // unconditionally. Starting signed out makes that false, and the switch is only
  // flipped again by the consent-write RPC — so signing in to an account that
  // already has a grant (which writes nothing) would never collect again.
  const harness = createHarness()
  harness.setAccount(null)
  harness.setAccountDecision(undefined) // signed out → no account decision at all
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)

  // Must NOT be latched off…
  expect(harness.isRuntimeEnabled()).toBe(true)
  // …while the account gate still denies (no resolvable account).
  await turn(hooks, "session-1")
  expect(harness.startedTurns).toEqual([])

  // An already-granted account signs in: collection works with no RPC involved.
  harness.setAccount(ACCOUNT_A)
  harness.setAccountDecision("granted")
  await turn(hooks, "session-1")
  expect(harness.startedTurns).toEqual(["session-1"])
})

test("init latches collection off only for an explicit decline", async () => {
  const harness = createHarness()
  harness.setAccountDecision("declined")
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)
  expect(harness.isRuntimeEnabled()).toBe(false)
  await turn(hooks, "session-1")
  expect(harness.startedTurns).toEqual([])
})

test("an undecided account keeps collection open for a later sign-in (N6)", async () => {
  // Same class as P1, different trigger: a resolvable account with NO decision
  // must not latch the process switch off either — otherwise signing out and
  // signing in as an already-granted account (which writes nothing, so no RPC)
  // would never collect. The per-event account gate still denies meanwhile.
  const harness = createHarness()
  harness.setAccount(ACCOUNT_B)
  // Keep the two consent sources consistent: no record for B, so the per-event
  // account gate (collector.shouldCollect) denies while B is current.
  harness.setConsent(ACCOUNT_B, false)
  harness.setAccountDecision(undefined) // signed in, never asked/answered
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)
  expect(harness.isRuntimeEnabled()).toBe(true)
  await turn(hooks, "session-1")
  expect(harness.startedTurns).toEqual([])

  harness.setAccount(ACCOUNT_A)
  harness.setAccountDecision("granted")
  await turn(hooks, "session-1")
  expect(harness.startedTurns).toEqual(["session-1"])
})

test("the per-run idle status releases the pin as well (the production trigger)", async () => {
  const harness = createHarness()
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)

  await turn(hooks, "session-1")
  harness.setAccount(ACCOUNT_B)
  await idleStatus(hooks, "session-1")
  // Judged by the pinned account (A) on the way out, then re-pinned to B —
  // identical to the `session.idle` case, because production emits both.
  await turn(hooks, "session-1")
  expect(harness.judged).toEqual([ACCOUNT_A, ACCOUNT_A, ACCOUNT_B])
  expect(harness.startedTurns).toEqual(["session-1", "session-1"])
})

test("revoking the pinned account stops collection on the very next turn", async () => {
  const harness = createHarness()
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)

  await turn(hooks, "session-1")
  expect(harness.startedTurns).toEqual(["session-1"])

  // Same account withdraws consent (FR-8): the pin must not shield it.
  harness.setConsent(ACCOUNT_A, false)
  await turn(hooks, "session-1")

  expect(harness.judged).toEqual([ACCOUNT_A, ACCOUNT_A])
  expect(harness.startedTurns).toEqual(["session-1"])
  expect(harness.clearedSessions).toEqual(["session-1"])
})

test("releases the pin even when the idle event no longer passes the eligibility gate", async () => {
  // R3 regression: the release used to live *after* the eligibility check, so a
  // session revoked mid-flight kept its pin (and its Map entry) until dispose().
  const harness = createHarness()
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)

  await turn(hooks, "session-1")
  harness.setConsent(ACCOUNT_A, false)
  harness.setAccount(ACCOUNT_B)

  await idle(hooks, "session-1") // ineligible: must still release the pin
  await turn(hooks, "session-1")

  expect(harness.judged).toEqual([ACCOUNT_A, ACCOUNT_A, ACCOUNT_B])
  expect(harness.startedTurns).toEqual(["session-1", "session-1"])
})

test("a tool call for a session we never admitted does not leave a pin behind", async () => {
  // R3 regression: tool hooks fire for every session, so this hook could be the
  // only place pinning an account — and no idle event we own would release it.
  const harness = createHarness()
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)

  await hooks["tool.execute.after"]!(
    { tool: "edit", sessionID: "session-x", callID: "edit-1", args: { filePath: "/tmp/project/main.ts" } } as never,
    { title: "", output: "", metadata: { filediff: { file: "/tmp/project/main.ts", additions: 1, deletions: 0 } } } as never,
  )
  await settle(hooks)
  expect(harness.judged).toEqual([ACCOUNT_A])

  // The pin created above was released, so the first real turn judges by B.
  harness.setAccount(ACCOUNT_B)
  await turn(hooks, "session-x")
  expect(harness.judged).toEqual([ACCOUNT_A, ACCOUNT_B])
})

test("a rejected turn does not leave a pin behind either", async () => {
  const harness = createHarness()
  const hooks = await harness.plugin({ directory: "/tmp/project" } as never)

  // Non-deveco provider: admitted, then rejected before any turn is recorded.
  await turn(hooks, "session-y", "openai")
  expect(harness.startedTurns).toEqual([])

  harness.setAccount(ACCOUNT_B)
  await turn(hooks, "session-y")
  expect(harness.judged).toEqual([ACCOUNT_A, ACCOUNT_B])
})
