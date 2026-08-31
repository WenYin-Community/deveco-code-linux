/**
 * Renders the usage panel with synthetic rich fixtures and dumps COLOR frames
 * (ANSI) for eyeballing. Not part of the regular suite:
 *
 *   XDG_STATE_HOME=$(pwd)/.tmp-xdg USAGE_PREVIEW=1 bun test test/cli/tui/dialog-usage-preview.test.tsx
 *   cat .usage-preview/rich-models.ansi
 */
import { test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { mountUsagePanel } from "../../fixture/usage-panel"

const active = !!process.env.USAGE_PREVIEW
const maybe = active ? test : test.skip

const todayMs = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())
const dayIso = (offset: number) => new Date(todayMs - offset * 86_400_000).toISOString().slice(0, 10)

type Scenario = { name: string; days: number; models: Array<{ id: string; weight: number; scale: number }> }

const scenarios: Scenario[] = [
  {
    name: "rich",
    days: 60,
    models: [
      { id: "GLM-5.1", weight: 0.55, scale: 1 },
      { id: "GLM-4.6", weight: 0.3, scale: 0.4 },
      { id: "deepseek-chat", weight: 0.15, scale: 2.5 },
    ],
  },
  { name: "sparse", days: 5, models: [{ id: "GLM-5.1", weight: 1, scale: 1 }] },
  {
    name: "huge",
    days: 12,
    models: [
      { id: "GLM-5.1", weight: 0.7, scale: 30 },
      { id: "deepseek-chat", weight: 0.3, scale: 12 },
    ],
  },
]

// Deterministic pseudo-random so dumps are reproducible.
let seed = 42
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}

function buildFixture(scenario: Scenario) {
  const modelTokens = initModelTokens(scenario.models)
  const { daily, sessions, messages } = buildDaily(scenario, modelTokens)
  return assembleFixture(scenario, modelTokens, daily, sessions, messages)
}

function initModelTokens(models: Scenario["models"]) {
  const map = new Map<string, { input: number; output: number; reasoning: number; cache: { read: number; write: number }; messages: number; daily: Map<string, number> }>()
  for (const model of models) {
    map.set(model.id, { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, messages: 0, daily: new Map() })
  }
  return map
}

function buildDaily(scenario: Scenario, modelTokens: ReturnType<typeof initModelTokens>) {
  const daily: Array<{ date: string; messages: number; tokens: number }> = []
  let sessions = 0
  let messages = 0
  for (let offset = scenario.days - 1; offset >= 0; offset--) {
    const result = buildDay(scenario, modelTokens, offset)
    if (!result) continue
    daily.push(result.entry)
    sessions += 1
    messages += result.count
  }
  return { daily, sessions, messages }
}

function buildDay(scenario: Scenario, modelTokens: ReturnType<typeof initModelTokens>, offset: number) {
  const tier = rand()
  const count = offset % 9 === 0 ? 24 + Math.floor(rand() * 16) : offset % 5 === 0 ? 11 : tier > 0.55 ? 2 + Math.floor(rand() * 3) : 0
  const inPhase = scenario.models.filter((_, index) =>
    index === 0 || (index % 2 === 1 ? offset > scenario.days / 2 : offset <= scenario.days / 2),
  )
  if (inPhase.length === 0) return undefined
  const dayCount = Math.max(count, inPhase.length)
  let dayTokens = 0
  for (let i = 0; i < dayCount; i++) {
    const model = pickModel(inPhase, i)
    dayTokens += addUsage(modelTokens, model, offset, dayCount)
  }
  return { entry: { date: dayIso(offset), messages: dayCount, tokens: dayTokens }, count: dayCount }
}

function pickModel(inPhase: Scenario["models"], i: number) {
  if (i < inPhase.length) return inPhase[i]!
  const roll = rand()
  let acc = 0
  for (const candidate of inPhase) {
    acc += candidate.weight
    if (roll <= acc) return candidate
  }
  return inPhase[0]!
}

function addUsage(modelTokens: ReturnType<typeof initModelTokens>, model: Scenario["models"][number], offset: number, dayCount: number) {
  const wave = 0.55 + 0.45 * Math.abs(Math.sin(offset * 0.6 + 0.4))
  const scale = model.scale / dayCount
  const entry = modelTokens.get(model.id)!
  const input = Math.round((12_000 + 150_000 * wave) * scale)
  const output = Math.round((800 + 12_000 * wave) * scale)
  const cacheRead = Math.round((3_000 + 120_000 * wave) * scale)
  const cacheWrite = Math.round(rand() * 20_000)
  const total = input + output + cacheRead + cacheWrite
  entry.input += input
  entry.output += output
  entry.cache.read += cacheRead
  entry.cache.write += cacheWrite
  entry.messages += 1
  entry.daily.set(dayIso(offset), (entry.daily.get(dayIso(offset)) ?? 0) + total)
  return total
}

function assembleFixture(scenario: Scenario, modelTokens: ReturnType<typeof initModelTokens>, daily: Array<{ date: string; messages: number; tokens: number }>, sessions: number, messages: number) {
  const models = [...modelTokens.entries()]
    .map(([id, entry]) => ({
      providerID: "deveco",
      modelID: id,
      messages: entry.messages,
      cost: Math.round(entry.input / 1e6 * 0.4 * 1e6) / 1e6,
      tokens: { input: entry.input, output: entry.output, reasoning: entry.reasoning, cache: entry.cache },
      daily: [...entry.daily.entries()].map(([date, tokens]) => ({ date, tokens })).sort((a, b) => a.date.localeCompare(b.date)),
    }))
    .sort((a, b) => b.tokens.input + b.tokens.output - (a.tokens.input + a.tokens.output))
  const total = models.reduce(
    (acc, model) => ({
      input: acc.input + model.tokens.input,
      output: acc.output + model.tokens.output,
      reasoning: acc.reasoning + model.tokens.reasoning,
      cache: { read: acc.cache.read + model.tokens.cache.read, write: acc.cache.write + model.tokens.cache.write },
    }),
    { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  )
  return {
    directory: undefined,
    total: { sessions, messages, cost: 3.1415, longestDuration: 3_685_080_000, tokens: total },
    models,
    session: {
      sessionID: "ses_preview",
      title: "Preview session",
      model: { providerID: "deveco", modelID: models[0]?.modelID ?? "GLM-5.1" },
      messages: 12,
      cost: 0.0213,
      timeCreated: Date.now() - 3_600_000,
      durationApi: 205_000,
      durationWall: 3_600_000,
      additions: 128,
      deletions: 24,
      tokens: { input: 402_119, output: 5_812, reasoning: 0, cache: { read: 111_359, write: 0 } },
    },
    daily,
  }
}

function spansToAnsi(frame: ReturnType<typeof captureFrameRef>) {
  return frame.lines
    .map((line) =>
      line.spans
        .map((span) => {
          if (span.text.trim().length === 0) return span.text
          const [r, g, b] = span.fg.toInts()
          return `\x1b[38;2;${r};${g};${b}m${span.text}\x1b[0m`
        })
        .join(""),
    )
    .join("\n")
}

function captureFrameRef(setup: { captureSpans: () => unknown }) {
  return setup.captureSpans() as {
    lines: Array<{ spans: Array<{ text: string; fg: { toInts: () => [number, number, number, number] } }> }>
  }
}

maybe("usage preview dumps ansi frames", async () => {
  const outDir = path.join(import.meta.dir, "../../../.usage-preview")
  await mkdir(outDir, { recursive: true })
  for (const scenario of scenarios) {
    const panel = await mountUsagePanel({ initialTab: "stats", statsFixture: buildFixture(scenario), width: 100, height: 64 })
    try {
      await panel.frameWith("Favorite model")
      await Bun.write(path.join(outDir, `${scenario.name}-overview.ansi`), spansToAnsi(captureFrameRef(panel.setup)))
      panel.setup.mockInput.pressKey("ARROW_RIGHT")
      await panel.frameWith("Tokens per Day")
      await Bun.write(path.join(outDir, `${scenario.name}-models.ansi`), spansToAnsi(captureFrameRef(panel.setup)))
      console.log(`[usage-preview] ${scenario.name}: overview + models written`)
    } finally {
      panel.cleanup()
    }
  }
  console.log(`[usage-preview] view with: cat ${outDir}/<scenario>-<tab>.ansi`)
})
