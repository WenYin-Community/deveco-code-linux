import { expect, test } from "bun:test"
import { mountUsagePanel } from "../../fixture/usage-panel"

const todayMs = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())
const dayIso = (offset: number) => new Date(todayMs - offset * 86_400_000).toISOString().slice(0, 10)

const chartDaily = (offset: number) => ({
  date: dayIso(offset),
  tokens: offset === 0 ? 92_900 : offset === 2 ? 255_934 : 15_677,
})

const tokens = { input: 192_900, output: 3_300, reasoning: 0, cache: { read: 92_900, write: 0 } }

const statsFixture = {
  directory: undefined,
  total: { sessions: 3, messages: 42, cost: 0, longestDuration: 3_685_080_000, tokens },
  models: [
    {
      providerID: "deveco",
      modelID: "GLM-5.1",
      messages: 42,
      cost: 0,
      tokens,
      daily: [chartDaily(2), chartDaily(1), chartDaily(0)],
    },
    {
      providerID: "deveco",
      modelID: "GLM-4.6",
      messages: 7,
      cost: 0,
      tokens: { input: 50_000, output: 2_100, reasoning: 0, cache: { read: 0, write: 0 } },
      daily: [chartDaily(0)],
    },
  ],
  session: {
    sessionID: "ses_render_fixture",
    title: "Render fixture session",
    model: { providerID: "deveco", modelID: "GLM-5.1" },
    messages: 42,
    cost: 0,
    durationApi: 2_726_000,
    durationWall: 2_726_000,
    additions: 12,
    deletions: 3,
    tokens,
  },
  daily: [
    { date: dayIso(0), messages: 25, tokens: 100_000 },
    { date: dayIso(1), messages: 7, tokens: 50_000 },
    { date: dayIso(3), messages: 2, tokens: 1_000 },
  ],
}

test("dialog usage renders stats overview with heatmap and stat block", async () => {
  const panel = await mountUsagePanel({ initialTab: "stats", statsFixture })
  try {
    const frame = await panel.frameWith("Favorite model")
    expect(frame).toContain("Mon")
    expect(frame).toContain("Wed")
    expect(frame).toContain("Fri")
    expect(frame).toContain("Low ░ ▒ ▓ █ High")
    expect(frame).toContain("All time")
    expect(frame).toContain("Last 7 days")
    expect(frame).toContain("Last 30 days")
    expect(frame).toContain("Favorite model: deveco/GLM-5.1")
    expect(frame).toContain("Total tokens: 289.1k")
    
    expect(frame).toContain("Input 192.9k · Output 3.3k · Cache read 92.9k")
    const dotRows = frame.split("\n").filter((line) => (line.match(/·/g) ?? []).length > 20)
    expect(dotRows.length).toBeGreaterThanOrEqual(5)

    panel.setup.mockInput.pressKey("ARROW_RIGHT")
    const modelsFrame = await panel.frameWith("Tokens per Day")
    expect(modelsFrame).toContain("Tokens per Day")
    expect(modelsFrame).toContain("GLM-5.1")
    expect(modelsFrame).toContain("GLM-4.6")
    expect(modelsFrame).toContain("(84.7%)")
    expect(modelsFrame).toContain("(15.3%)")
    expect(modelsFrame).toContain("Cache Read:")
    
  } finally {
    panel.cleanup()
  }
})

test("cycling the date range refreshes overview values", async () => {
  const tokensAll = { input: 900_000, output: 40_000, reasoning: 0, cache: { read: 500_000, write: 0 } }
  const tokensWeek = { input: 5_000, output: 500, reasoning: 0, cache: { read: 1_000, write: 0 } }
  const byRange = (days: string) =>
    days === "7"
      ? {
          total: { sessions: 2, messages: 6, cost: 0, longestDuration: 3_600_000, tokens: tokensWeek },
          models: [
            { providerID: "deveco", modelID: "GLM-4.6", messages: 6, cost: 0, tokens: tokensWeek, daily: [{ date: dayIso(1), tokens: 5_500 }] },
          ],
          daily: [{ date: dayIso(30), messages: 60, tokens: 1_440_000 }, { date: dayIso(1), messages: 6, tokens: 5_500 }],
        }
      : {
          total: { sessions: 9, messages: 80, cost: 0, longestDuration: 86_400_000, tokens: tokensAll },
          models: [
            { providerID: "deveco", modelID: "GLM-5.1", messages: 80, cost: 0, tokens: tokensAll, daily: [{ date: dayIso(30), tokens: 1_440_000 }] },
          ],
          daily: [{ date: dayIso(30), messages: 60, tokens: 1_440_000 }],
        }
  const panel = await mountUsagePanel({ initialTab: "stats", statsFixture: byRange })
  try {
    const before = await panel.frameWith("Total tokens: 1.4m")
    expect(before).toContain("Sessions: 9")
    expect(before).toContain("Active days: 1/31")
    panel.setup.mockInput.pressKey("r")
    const after = await panel.frameWith("Total tokens: 6.5k")
    expect(after).toContain("Sessions: 2")
    expect(after).toContain("Active days: 1/7")
    
  } finally {
    panel.cleanup()
  }
})

test("dialog usage renders session block on usage tab", async () => {
  const panel = await mountUsagePanel({ initialTab: "usage", statsFixture })
  try {
    const frame = await panel.frameWith("Total cost")
    expect(frame).toContain("Session")
    
    
    expect(frame).toContain("45m 26s")
    
    expect(frame).toContain("cache read")
  } finally {
    panel.cleanup()
  }
})
