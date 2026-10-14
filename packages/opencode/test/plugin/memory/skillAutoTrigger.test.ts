import { expect, describe, it, afterAll } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import {
  checkSkillThreshold,
  DEFAULT_SKILL_TRIGGER_STATE,
  incrementSkillCounter,
} from "../../../src/plugin/memory/skills/trigger"
import {
  shouldTriggerExtraction,
  DEFAULT_EXTRACTION_THRESHOLD_STATE,
  updateThresholdState,
  resetExtractionThresholdState,
} from "../../../src/plugin/memory/memory/extractionThreshold"
import {
  determineReviewMode,
  executeExtraction,
  initAutoMemoryExtraction,
} from "../../../src/plugin/memory/memory/extractionRunner"
import { MemoryStorage } from "../../../src/plugin/memory/memory/storage"
import { SkillStorage } from "../../../src/plugin/memory/skills/storage"
import { MemoryPlugin } from "../../../src/plugin/memory/index"
import {
  DEFAULT_SKILL_CONFIG,
  DEFAULT_EXTRACTION_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  type SkillConfig,
} from "../../../src/plugin/memory/memory/types"

const tmpDirs: string[] = []

afterAll(async () => {
  resetExtractionThresholdState()
  await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeTmpDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

// Minimal client: session.messages feeds the threshold check, session.get fails
// fast so createForkedChildSession bails without any real fork/prompt traffic.
function stubClient(): OpencodeClient {
  return {
    session: {
      messages: async () => ({ data: [{ info: { id: "msg-1" } }] }),
      get: async () => ({ error: { name: "stub-session-not-found" } }),
    },
    tui: { showToast: async () => {} },
  } as unknown as OpencodeClient
}

function stateWithIters(n: number) {
  let state = DEFAULT_SKILL_TRIGGER_STATE
  for (let i = 0; i < n; i++) state = incrementSkillCounter(state)
  return state
}

describe("skills.autoTrigger — path A (checkSkillThreshold)", () => {
  it("autoTrigger=false suppresses the trigger even when the counter exceeds the interval", () => {
    const config = { ...DEFAULT_SKILL_CONFIG, enabled: true, autoTrigger: false, skillReviewInterval: 10 }
    const result = checkSkillThreshold(stateWithIters(25), config)
    expect(result.shouldTrigger).toBe(false)
    // Counter must be preserved untouched — suppression is not a trigger event
    expect(result.newState.itersSinceSkill).toBe(25)
    expect(result.newState.lastReviewTime).toBeNull()
  })

  it("autoTrigger=true fires at the interval and resets the counter", () => {
    const config = { ...DEFAULT_SKILL_CONFIG, enabled: true, autoTrigger: true, skillReviewInterval: 10 }
    const below = checkSkillThreshold(stateWithIters(9), config)
    expect(below.shouldTrigger).toBe(false)
    expect(below.newState.itersSinceSkill).toBe(9)

    const at = checkSkillThreshold(stateWithIters(10), config)
    expect(at.shouldTrigger).toBe(true)
    expect(at.newState.itersSinceSkill).toBe(0)
    expect(typeof at.newState.lastReviewTime).toBe("number")
  })

  it("enabled=false suppresses regardless of autoTrigger", () => {
    const config = { ...DEFAULT_SKILL_CONFIG, enabled: false, autoTrigger: true, skillReviewInterval: 10 }
    expect(checkSkillThreshold(stateWithIters(10), config).shouldTrigger).toBe(false)
  })

  it("default config enables skills but keeps background auto-triggering off", () => {
    // DEFAULT_SKILL_CONFIG: enabled=true, autoTrigger=false — skills are
    // available on demand, but the count-based trigger stays silent by default
    expect(DEFAULT_SKILL_CONFIG.enabled).toBe(true)
    expect(DEFAULT_SKILL_CONFIG.autoTrigger).toBe(false)
    expect(checkSkillThreshold(stateWithIters(10)).shouldTrigger).toBe(false)
  })
})

// Field-level checks on the reported threshold result. Note: the value that
// production actually consumes for the piggyback is recomputed inside
// extractionRunner.executeExtraction — that live gate is exercised by the
// executeExtraction integration tests further below.
describe("skills.autoTrigger — path B (threshold result fields)", () => {
  const extractionConfig = { ...DEFAULT_EXTRACTION_CONFIG, enabled: true, minMessages: 1, throttle: 0 }
  const thresholdState = { ...DEFAULT_EXTRACTION_THRESHOLD_STATE, skill_iters_since_review: 25 }

  it("autoTrigger=false reports skillThresholdMet=false and leaves memory triggering intact", () => {
    const skillConfig = { ...DEFAULT_SKILL_CONFIG, enabled: true, autoTrigger: false, skillReviewInterval: 10 }
    const result = shouldTriggerExtraction(thresholdState, extractionConfig, 5, skillConfig)
    expect(result.skillThresholdMet).toBe(false)
    // The switch must not leak into memory extraction: with thresholds met,
    // shouldTrigger stays true regardless of autoTrigger
    expect(result.shouldTrigger).toBe(true)
  })

  it("autoTrigger=true reports skillThresholdMet=true at or above the interval", () => {
    const skillConfig = { ...DEFAULT_SKILL_CONFIG, enabled: true, autoTrigger: true, skillReviewInterval: 10 }
    const result = shouldTriggerExtraction(thresholdState, extractionConfig, 5, skillConfig)
    expect(result.skillThresholdMet).toBe(true)
    expect(result.shouldTrigger).toBe(true)
  })

  it("determineReviewMode matrix is unchanged by the switch (literal-boolean baseline pin)", () => {
    // Pure matrix over literal booleans — pins that the switch did not alter
    // determineReviewMode itself. The composed chain (config + threshold state
    // → reviewMode) is exercised by the executeExtraction tests below, not here.
    expect(determineReviewMode(true, false, true, true)).toBe("memory-only")
    expect(determineReviewMode(false, false, true, true)).toBeNull()
    expect(determineReviewMode(true, true, true, true)).toBe("combined")
    expect(determineReviewMode(false, true, true, true)).toBe("skill-only")
  })
})

describe("skills.autoTrigger — path B live gate (executeExtraction)", () => {
  async function runExtraction(skillConfig: SkillConfig) {
    const memoryRoot = await makeTmpDir("autotrigger-runner-")
    const storage = new MemoryStorage("p-autotrigger", memoryRoot, {
      ...DEFAULT_MEMORY_CONFIG,
      customMemoryDir: memoryRoot,
    })
    await storage.init()
    const skillStorage = new SkillStorage(join(memoryRoot, "skills"))
    await skillStorage.init()
    initAutoMemoryExtraction(
      stubClient(),
      storage,
      { ...DEFAULT_EXTRACTION_CONFIG, enabled: true, minMessages: 1, throttle: 0 },
      undefined,
      skillStorage,
      skillConfig,
    )
    updateThresholdState({ ...DEFAULT_EXTRACTION_THRESHOLD_STATE, skill_iters_since_review: 25 })
    return executeExtraction({
      sessionID: "s-autotrigger",
      projectID: "p-autotrigger",
      memoryRoot,
      projectDirectory: memoryRoot,
      storage,
    })
  }

  it("autoTrigger=false keeps a due extraction memory-only despite skill counter 25 ≥ interval 10", async () => {
    const result = await runExtraction({ ...DEFAULT_SKILL_CONFIG, enabled: true, autoTrigger: false, skillReviewInterval: 10 })
    expect(result.skipReason).toBeUndefined()
    expect(result.reviewMode).toBe("memory-only")
  }, 15000)

  it("autoTrigger=true (control) piggybacks the skill review as combined under identical state", async () => {
    // Positive control: proves the seeded counter really reaches the live gate,
    // so the memory-only assertion above cannot pass vacuously.
    const result = await runExtraction({ ...DEFAULT_SKILL_CONFIG, enabled: true, autoTrigger: true, skillReviewInterval: 10 })
    expect(result.skipReason).toBeUndefined()
    expect(result.reviewMode).toBe("combined")
  }, 15000)
})

describe("skills.autoTrigger — manual path stays open (skill-review-trigger tool)", () => {
  async function executeTriggerTool(skills: Record<string, unknown>) {
    const dir = await makeTmpDir("autotrigger-plugin-")
    const hooks = await MemoryPlugin(
      { client: stubClient(), directory: dir } as unknown as PluginInput,
      {
        autoMemory: { enabled: false, customMemoryDir: join(dir, "memory") },
        extraction: { enabled: false },
        skills,
        slashCommands: { enabled: false },
        logLevel: "off",
      },
    )
    try {
      const tool = hooks.tool!["skill-review-trigger"]!
      return await (tool.execute as (args: unknown, ctx: unknown) => Promise<string>)({}, { sessionID: "s-manual" })
    } finally {
      await hooks.dispose?.()
    }
  }

  it("autoTrigger=false does not gate the tool — review reaches spawn (fork fails only on the stub client)", async () => {
    const out = await executeTriggerTool({ enabled: true, autoTrigger: false, skillReviewInterval: 10 })
    expect(out).not.toContain("Skills feature is disabled")
    expect(out).toContain("Skill Review Not Started")
  }, 15000)

  it("enabled=false still closes the tool (the enabled gate itself is intact)", async () => {
    const out = await executeTriggerTool({ enabled: false, autoTrigger: true })
    expect(out).toContain("Skills feature is disabled")
  })
})
