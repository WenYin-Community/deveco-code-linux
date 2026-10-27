/**
 * Token accounting for the magpie (`DevEcoCodeSession-Magpie`) event.
 *
 * The event used to report `inputTokenCount`/`outputTokenCount` taken straight
 * from the message snapshot. On the deveco MaaS path the whole prompt is a
 * prefix-cache hit, so that `input` counter is the *non-cached remainder* and
 * reads 0 for a turn with a 15k-token context — the same trap the classic
 * ai-session event had. Both streams now use `inputTokens` / `outputTokens` /
 * `cacheTokens`, where `inputTokens + cacheTokens` is the prompt size.
 */
import { expect, test } from "bun:test"
import type { Hooks, Plugin } from "@opencode-ai/plugin"
import {
  createAnalyticsMagpiePlugin,
  type AnalyticsMagpiePluginDependencies,
} from "@/plugin/analytics-magpie/analytics-plugin"
import { SessionCollector } from "@/plugin/analytics-magpie/collector"
import { isMagpieAnalyticsEvent } from "@/plugin/analytics-magpie/storage"
import type { AnalyticsEvent } from "@/plugin/analytics-magpie/types"

const PROJECT_ID = "550e8400-e29b-41d4-a716-446655440000"

function createRealCollector(): SessionCollector {
  const collector = new SessionCollector({
    analyticsEnabledFor: async () => true,
    getPathRedactionSalt: async () => "test-salt",
    getOsArch: () => "arm64",
    getOsName: () => process.platform,
    getOsVersion: () => "test-os",
  })
  collector.setLoggedIn(true)
  return collector
}

function createPlugin(collector: SessionCollector, uploaded: AnalyticsEvent[]): Plugin {
  const state = { enabled: true }
  const dependencies: AnalyticsMagpiePluginDependencies = {
    collector,
    collectionEnabled: async () => true,
    consentDecision: async () => "granted",
    currentAccount: async () => "account-a",
    runtimeEnabled: () => state.enabled,
    runtimeEpoch: () => 1,
    setCollectionEnabled: async (enabled) => {
      state.enabled = enabled
    },
    shutdownCollection: async () => {},
    upload: async (event) => {
      uploaded.push(event)
      return true
    },
    isLoggedIn: async () => true,
    isJwtExpired: async () => false,
    diagnostic: async () => {},
    projectId: async () => PROJECT_ID,
    version: () => "1.0.0",
  }
  return createAnalyticsMagpiePlugin(dependencies)
}

/** message.updated carries the whole assistant snapshot under `properties`. */
function assistantSnapshot(tokens: Record<string, unknown>, id = "assistant-1") {
  return {
    sessionID: "session-1",
    info: {
      id,
      parentID: "message-1",
      sessionID: "session-1",
      role: "assistant",
      time: { created: 1, completed: 2 },
      modelID: "GLM-5.1",
      providerID: "deveco",
      agent: "build",
      tokens,
    },
  }
}

/** chat.message enqueues work and resolves immediately; a later event drains it. */
async function settle(hooks: Hooks): Promise<void> {
  await hooks.event!({ event: { type: "test.settle" } as never })
}

async function openTurn(hooks: Hooks): Promise<void> {
  await hooks["chat.message"]!(
    { sessionID: "session-1", agent: "build", model: { providerID: "deveco", modelID: "GLM-5.1" } } as never,
    { message: { id: "message-1" }, parts: [] } as never,
  )
  await settle(hooks)
}

async function endTurn(hooks: Hooks): Promise<void> {
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "session-1" } } as never })
  await settle(hooks)
}

async function snapshot(hooks: Hooks, tokens: Record<string, unknown>, id = "assistant-1"): Promise<void> {
  await hooks.event!({ event: { type: "message.updated", properties: assistantSnapshot(tokens, id) } as never })
  await settle(hooks)
}

async function runTurn(hooks: Hooks, tokens: Record<string, unknown>): Promise<void> {
  await openTurn(hooks)
  await snapshot(hooks, tokens)
  await endTurn(hooks)
}

test("reports a prefix-cache hit as cacheTokens instead of losing it behind a zero input", async () => {
  const uploaded: AnalyticsEvent[] = []
  const hooks = await createPlugin(createRealCollector(), uploaded)({ directory: "/tmp/project" } as never)

  // Shape Session.getUsage produces on the MaaS path: the whole prompt was a
  // prefix-cache hit, so input is the uncached remainder (0) and the real
  // context size (14960) only lives in cache.read.
  await runTurn(hooks, { total: 14963, input: 0, output: 3, reasoning: 0, cache: { read: 14960, write: 0 } })

  expect(uploaded).toHaveLength(1)
  const event = uploaded[0]!
  expect(isMagpieAnalyticsEvent(event)).toBe(true)
  expect(event.inputTokens).toBe(0)
  expect(event.outputTokens).toBe(3)
  expect(event.cacheTokens).toBe(14960)
  expect(event.inputTokens + (event.cacheTokens ?? 0)).toBe(14960)
  expect(event.assistantExecutions[0]).toMatchObject({ inputTokens: 0, outputTokens: 3, cacheTokens: 14960 })
})

test("counts explicit cache writes as cache tokens too", async () => {
  const uploaded: AnalyticsEvent[] = []
  const hooks = await createPlugin(createRealCollector(), uploaded)({ directory: "/tmp/project" } as never)

  // Anthropic-family shape: input is the uncached remainder, the cache write is
  // billed input as well, so both halves of the prompt end up reported.
  await runTurn(hooks, { input: 9, output: 5, cache: { read: 0, write: 5752 } })

  expect(uploaded).toHaveLength(1)
  expect(isMagpieAnalyticsEvent(uploaded[0]!)).toBe(true)
  expect(uploaded[0]!.inputTokens).toBe(9)
  expect(uploaded[0]!.cacheTokens).toBe(5752)
})

test("adds up separate assistant messages of the same turn", async () => {
  const uploaded: AnalyticsEvent[] = []
  const hooks = await createPlugin(createRealCollector(), uploaded)({ directory: "/tmp/project" } as never)

  // One assistant message per step, so a turn with two steps has to sum both
  // messages instead of letting the second one overwrite the first.
  await openTurn(hooks)
  await snapshot(hooks, { total: 120, input: 20, output: 2, cache: { read: 100 } })
  await snapshot(hooks, { total: 80, input: 10, output: 5, cache: { read: 70 } }, "assistant-2")
  await endTurn(hooks)

  expect(uploaded).toHaveLength(1)
  const event = uploaded[0]!
  expect(isMagpieAnalyticsEvent(event)).toBe(true)
  expect(event.inputTokens).toBe(30)
  expect(event.outputTokens).toBe(7)
  expect(event.cacheTokens).toBe(170)
  expect(event.assistantExecutions).toHaveLength(2)
})

test("reports the last snapshot of a message once, through the plugin path", async () => {
  const uploaded: AnalyticsEvent[] = []
  const hooks = await createPlugin(createRealCollector(), uploaded)({ directory: "/tmp/project" } as never)

  await openTurn(hooks)
  await snapshot(hooks, { input: 10, output: 1, cache: { read: 100 } })
  await snapshot(hooks, { input: 10, output: 5, cache: { read: 100 } })
  await snapshot(hooks, { input: 12, output: 6, cache: { read: 150 } })
  await endTurn(hooks)

  expect(uploaded).toHaveLength(1)
  const event = uploaded[0]!
  expect(isMagpieAnalyticsEvent(event)).toBe(true)
  expect(event.inputTokens).toBe(12)
  expect(event.outputTokens).toBe(6)
  expect(event.cacheTokens).toBe(150)
})

test("accumulates a turn's executions and does not double count repeated snapshots", async () => {
  const collector = createRealCollector()
  collector.startTurn({
    sessionID: "session-1",
    messageID: "message-1",
    sourceVersion: "1.0.0",
    providerId: "deveco",
    modelId: "GLM-5.1",
    agentName: "build",
    query: "hello",
    startedAt: 1,
  })

  const execution = (tokens: { inputTokens: number; outputTokens: number; cacheTokens?: number }, startedAt: number) => ({
    sessionID: "session-1",
    messageID: "assistant-1",
    parentMessageID: "message-1",
    startedAt,
    modelId: "GLM-5.1",
    agentName: "build",
    ...tokens,
  })

  // message.updated fires repeatedly for the same assistant message; each call
  // replaces the snapshot, so only the delta may be accumulated.
  collector.recordAssistant(execution({ inputTokens: 10, outputTokens: 1, cacheTokens: 100 }, 1))
  collector.recordAssistant(execution({ inputTokens: 10, outputTokens: 5, cacheTokens: 100 }, 1))
  collector.recordAssistant(execution({ inputTokens: 12, outputTokens: 6, cacheTokens: 150 }, 1))

  const [event] = await collector.buildEventsForSession(PROJECT_ID, "/tmp/project", "session-1")
  expect(event!.inputTokens).toBe(12)
  expect(event!.outputTokens).toBe(6)
  expect(event!.cacheTokens).toBe(150)
  expect(event!.assistantExecutions[0]).toMatchObject({ inputTokens: 12, outputTokens: 6, cacheTokens: 150 })
})

test("omits cacheTokens when the provider reports no cache breakdown", async () => {
  const uploaded: AnalyticsEvent[] = []
  const hooks = await createPlugin(createRealCollector(), uploaded)({ directory: "/tmp/project" } as never)

  // A provider that says nothing about caching (no tokens.cache at all) is not a
  // measured zero hit: omitting the key keeps "unknown" out of the hit-rate math.
  await runTurn(hooks, { total: 161, input: 161, output: 1 })

  expect(uploaded).toHaveLength(1)
  const event = uploaded[0]!
  expect(isMagpieAnalyticsEvent(event)).toBe(true)
  expect(event.inputTokens).toBe(161)
  expect("cacheTokens" in event).toBe(false)
  expect("cacheTokens" in event.assistantExecutions[0]!).toBe(false)
})

test("reports a measured zero when the provider says the prompt was not cached", async () => {
  const uploaded: AnalyticsEvent[] = []
  const hooks = await createPlugin(createRealCollector(), uploaded)({ directory: "/tmp/project" } as never)

  // An explicit zero is a real measurement and must survive as 0 rather than become absent.
  await runTurn(hooks, { total: 161, input: 161, output: 1, cache: { read: 0 } })

  expect(uploaded).toHaveLength(1)
  expect(isMagpieAnalyticsEvent(uploaded[0]!)).toBe(true)
  expect(uploaded[0]!.cacheTokens).toBe(0)
})

test("keeps the accumulated cache total when a snapshot reports no breakdown", async () => {
  const collector = createRealCollector()
  collector.startTurn({
    sessionID: "session-1",
    messageID: "message-1",
    sourceVersion: "1.0.0",
    providerId: "deveco",
    modelId: "GLM-5.1",
    agentName: "build",
    query: "hello",
    startedAt: 1,
  })

  const execution = (tokens: { inputTokens: number; outputTokens: number; cacheTokens?: number }, startedAt: number) => ({
    sessionID: "session-1",
    messageID: "assistant-1",
    parentMessageID: "message-1",
    startedAt,
    modelId: "GLM-5.1",
    agentName: "build",
    ...tokens,
  })

  // A snapshot that loses the cache breakdown must not subtract the previous value from the
  // accumulator; the execution itself keeps the key absent.
  collector.recordAssistant(execution({ inputTokens: 10, outputTokens: 1, cacheTokens: 100 }, 1))
  collector.recordAssistant(execution({ inputTokens: 10, outputTokens: 2 }, 1))

  const [event] = await collector.buildEventsForSession(PROJECT_ID, "/tmp/project", "session-1")
  expect(event!.cacheTokens).toBe(100)
  expect("cacheTokens" in event!.assistantExecutions[0]!).toBe(false)
})
